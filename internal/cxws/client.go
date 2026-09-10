// Package cxws speaks the Creality device protocol on port 9999: a JSON
// WebSocket where the printer streams state objects and accepts
// {"method":"get"|"set","params":{...}} commands. This is the same channel the
// Creality Print device page and the Creality Cloud app use.
package cxws

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/sworrl/k2ctl/internal/state"
)

type Client struct {
	url   string
	store *state.Store
	log   *log.Logger

	mu   sync.Mutex
	conn *websocket.Conn
}

// Material is the record the printer keeps for one CFS bay.
type Material struct {
	Vendor   string
	Type     string
	Name     string
	Color    string // #RRGGBB
	RFID     string // Creality material id; the printer only keeps ids it knows
	MinTemp  float64
	MaxTemp  float64
	Pressure float64
}

func New(url string, st *state.Store, l *log.Logger) *Client {
	if l == nil {
		l = log.Default()
	}
	return &Client{url: url, store: st, log: l}
}

// Run keeps a connection open until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := c.session(ctx); err != nil && ctx.Err() == nil {
			c.log.Printf("cxws: %v (retry in %s)", err, backoff)
		}
		c.store.Update(func(s *state.Status) { s.Sources["cxws"] = false })
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (c *Client) session(ctx context.Context) error {
	d := websocket.Dialer{HandshakeTimeout: 8 * time.Second}
	conn, _, err := d.DialContext(ctx, c.url, nil)
	if err != nil {
		return fmt.Errorf("dial %s: %w", c.url, err)
	}
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		c.mu.Unlock()
		conn.Close()
	}()
	c.store.Update(func(s *state.Status) { s.Sources["cxws"] = true })
	_ = c.Get(map[string]any{"boxsInfo": 1, "boxConfig": 1})

	// Periodically re-request the CFS inventory; the printer pushes most other
	// state on its own.
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if c.Get(map[string]any{"boxsInfo": 1}) != nil {
					return
				}
			}
		}
	}()

	for {
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		c.apply(m)
	}
}

func (c *Client) send(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("device socket not connected")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.conn.WriteJSON(v)
}

func (c *Client) Get(params map[string]any) error {
	return c.send(map[string]any{"method": "get", "params": params})
}

func (c *Client) Set(params map[string]any) error {
	return c.send(map[string]any{"method": "set", "params": params})
}

// SetMaterial rewrites the material record of bay slotID in box boxID.
func (c *Client) SetMaterial(boxID, boxType, slotID int, m Material) error {
	rec := map[string]any{
		"boxId":    boxID,
		"boxType":  boxType,
		"id":       slotID,
		"rfid":     m.RFID,
		"type":     m.Type,
		"vendor":   m.Vendor,
		"name":     m.Name,
		"color":    toPrinterColor(m.Color),
		"minTemp":  m.MinTemp + 1e-8, // the stock UI adds this to force a float
		"maxTemp":  m.MaxTemp + 1e-8,
		"pressure": m.Pressure,
	}
	return c.Set(map[string]any{"modifyMaterial": rec})
}

func (c *Client) SetLight(on bool) error {
	v := 0
	if on {
		v = 1
	}
	return c.Set(map[string]any{"lightSw": v})
}

// SetFanOn switches one fan fully on or off through the device socket.
// key is part|case|aux (the printer keys are fan / fanCase / fanAuxiliary);
// the socket has no percentage control, that is done with M106 via Moonraker.
func (c *Client) SetFanOn(key string, on bool) error {
	k := map[string]string{"part": "fan", "case": "fanCase", "aux": "fanAuxiliary"}[key]
	if k == "" {
		return fmt.Errorf("unknown fan %q", key)
	}
	v := 0
	if on {
		v = 1
	}
	return c.Set(map[string]any{k: v})
}

// GCode runs a raw g-code line through the device socket.
func (c *Client) GCode(line string) error {
	return c.Set(map[string]any{"gcodeCmd": line})
}

// --- state mapping ---------------------------------------------------------

func (c *Client) apply(m map[string]any) {
	if bi, ok := m["boxsInfo"].(map[string]any); ok {
		cfs := parseBoxes(bi)
		c.store.Update(func(s *state.Status) {
			active := s.CFS.Active
			s.CFS = cfs
			s.CFS.Active = active
			s.CFS.Connected = s.CFS.Connected || cfs.Enabled
		})
		return
	}
	if _, only := m["connectionCount"]; only && len(m) == 1 {
		return
	}
	c.store.Update(func(s *state.Status) {
		for k, v := range m {
			switch v.(type) {
			case string, float64, bool:
				s.Device[k] = v
			}
		}
		if v, ok := m["hostname"].(string); ok && v != "" {
			s.Printer.Hostname = v
			s.Printer.Name = v
		}
		if v, ok := m["deviceName"].(string); ok && v != "" {
			s.Printer.Name = v
		}
		if v, ok := m["model"].(string); ok {
			s.Printer.Model = modelName(v)
		}
		if v, ok := m["modelVersion"].(string); ok {
			s.Printer.Firmware = v
		}
		if v, ok := fnum(m, "state"); ok {
			s.Printer.RawState = int(v)
			if s.Job.State == "" || !s.Sources["moonraker"] {
				s.Job.State = rawStateName(int(v))
			}
			s.Printer.State = s.Job.State
		}
		temp := func(key, actualK, targetK, maxK string) {
			t := s.Temps[key]
			changed := false
			if v, ok := fnum(m, actualK); ok {
				t.Actual, changed = v, true
			}
			if v, ok := fnum(m, targetK); ok {
				t.Target, changed = v, true
			}
			if v, ok := fnum(m, maxK); ok {
				t.Max, changed = v, true
			}
			if changed {
				s.Temps[key] = t
			}
		}
		temp("nozzle", "nozzleTemp", "targetNozzleTemp", "maxNozzleTemp")
		temp("bed", "bedTemp0", "targetBedTemp0", "maxBedTemp")
		temp("chamber", "boxTemp", "targetBoxTemp", "maxBoxTemp")

		if v, ok := m["printFileName"].(string); ok {
			s.Job.File = v
		}
		if v, ok := fnum(m, "printProgress"); ok {
			s.Job.Progress = v
		}
		if v, ok := fnum(m, "printLeftTime"); ok {
			s.Job.TimeLeft = int(v)
		}
		if v, ok := fnum(m, "printJobTime"); ok {
			s.Job.Elapsed = int(v)
		}
		if v, ok := fnum(m, "printStartTime"); ok {
			s.Job.StartedAt = int64(v)
		}
		if v, ok := fnum(m, "layer"); ok {
			s.Job.Layer = int(v)
		}
		if v, ok := fnum(m, "TotalLayer"); ok {
			s.Job.TotalLayers = int(v)
		}
		if v, ok := fnum(m, "lightSw"); ok {
			s.Light = v != 0
		}
		fan := func(key, k string) {
			if v, ok := fnum(m, k); ok {
				s.Fans[key] = int(v)
			}
		}
		fan("part", "modelFanPct")
		fan("case", "caseFanPct")
		fan("aux", "auxiliaryFanPct")
		fanOn := func(key, k string) {
			if v, ok := fnum(m, k); ok {
				s.FanOn[key] = v != 0
			}
		}
		fanOn("part", "fan")
		fanOn("case", "fanCase")
		fanOn("aux", "fanAuxiliary")
		if v, ok := fnum(m, "curFeedratePct"); ok {
			s.SpeedPct = int(v)
		}
		if v, ok := fnum(m, "curFlowratePct"); ok {
			s.FlowPct = int(v)
		}
		if v, ok := m["curPosition"].(string); ok {
			s.Position = v
		}
		if v, ok := fnum(m, "cfsConnect"); ok {
			s.CFS.Connected = v != 0
		}
		if e, ok := m["err"].(map[string]any); ok {
			code, _ := fnum(e, "errcode")
			if code != 0 {
				msg := fmt.Sprintf("device error %v", e)
				if len(s.Errors) == 0 || s.Errors[len(s.Errors)-1] != msg {
					s.Errors = append(s.Errors, msg)
					if len(s.Errors) > 20 {
						s.Errors = s.Errors[len(s.Errors)-20:]
					}
				}
			}
		}
	})
}

func parseBoxes(bi map[string]any) state.CFS {
	cfs := state.CFS{ToolMap: map[string]string{}}
	if v, ok := fnum(bi, "enable"); ok {
		cfs.Enabled = v != 0
	}
	boxes, _ := bi["materialBoxs"].([]any)
	for _, raw := range boxes {
		bm, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		b := state.Box{}
		if v, ok := fnum(bm, "id"); ok {
			b.ID = int(v)
		}
		if v, ok := fnum(bm, "type"); ok {
			b.Type = int(v)
		}
		if v, ok := fnum(bm, "state"); ok {
			b.State = int(v)
		}
		if v, ok := fnum(bm, "temp"); ok {
			b.Temp = v
		}
		if v, ok := fnum(bm, "humidity"); ok {
			b.Humidity = v
		}
		b.Name, _ = bm["materialBoxName"].(string)
		b.Serial, _ = bm["sn"].(string)
		if b.Name == "" {
			if b.Type == 1 {
				b.Name = "External spool"
			} else {
				b.Name = fmt.Sprintf("CFS %d", b.ID)
			}
		}
		mats, _ := bm["materials"].([]any)
		for _, rm := range mats {
			mm, ok := rm.(map[string]any)
			if !ok {
				continue
			}
			sl := state.Slot{}
			if v, ok := fnum(mm, "id"); ok {
				sl.ID = int(v)
			}
			sl.Vendor, _ = mm["vendor"].(string)
			sl.Type, _ = mm["type"].(string)
			sl.Name, _ = mm["name"].(string)
			sl.RFID, _ = mm["rfid"].(string)
			if col, ok := mm["color"].(string); ok {
				sl.Color = fromPrinterColor(col)
			}
			sl.MinTemp, _ = fnum(mm, "minTemp")
			sl.MaxTemp, _ = fnum(mm, "maxTemp")
			sl.Pressure, _ = fnum(mm, "pressure")
			if v, ok := fnum(mm, "percent"); ok {
				sl.Percent = int(v)
			}
			if v, ok := fnum(mm, "selected"); ok {
				sl.Selected = v != 0
			}
			if v, ok := fnum(mm, "state"); ok {
				sl.State = int(v)
			}
			if v, ok := fnum(mm, "editStatus"); ok {
				sl.Editable = v != 0
			}
			sl.Label = slotLabel(b, sl.ID)
			if sl.Selected {
				cfs.Active = sl.Label
			}
			b.Slots = append(b.Slots, sl)
		}
		cfs.Boxes = append(cfs.Boxes, b)
	}
	if cm, ok := bi["colorMatch"].([]any); ok {
		for _, raw := range cm {
			e, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			tool, _ := e["id"].(string)
			bid, _ := fnum(e, "boxId")
			mid, _ := fnum(e, "materialId")
			cfs.ToolMap[tool] = fmt.Sprintf("T%d%c", int(bid), 'A'+int(mid))
		}
	}
	return cfs
}

func slotLabel(b state.Box, id int) string {
	if b.Type == 1 {
		return "EXT"
	}
	return fmt.Sprintf("T%d%c", b.ID, 'A'+id)
}

// The printer stores colours as "#0RRGGBB" (a leading zero nibble).
func fromPrinterColor(c string) string {
	c = strings.TrimPrefix(strings.TrimSpace(c), "#")
	if len(c) == 7 && c[0] == '0' {
		c = c[1:]
	}
	if len(c) != 6 {
		return ""
	}
	return "#" + strings.ToUpper(c)
}

func toPrinterColor(c string) string {
	c = strings.TrimPrefix(strings.TrimSpace(c), "#")
	if len(c) == 3 {
		c = string([]byte{c[0], c[0], c[1], c[1], c[2], c[2]})
	}
	if len(c) != 6 {
		c = "ffffff"
	}
	return "#0" + strings.ToLower(c)
}

func fnum(m map[string]any, k string) (float64, bool) {
	switch v := m[k].(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil || math.IsNaN(f) {
			return 0, false
		}
		return f, true
	case bool:
		if v {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func modelName(code string) string {
	// Creality's printerIntName codes (from Creality Print's machineList.json).
	switch code {
	case "F021":
		return "Creality K2"
	case "F008":
		return "Creality K2"
	case "F012":
		return "Creality K2 Pro"
	case "F016":
		return "Creality K2 SE"
	case "F018":
		return "Creality Hi"
	}
	return code
}

// Observed values of the "state" field on the K2 device socket.
func rawStateName(v int) string {
	switch v {
	case 0:
		return "standby"
	case 1:
		return "printing"
	case 2:
		return "complete"
	case 3:
		return "error"
	case 4:
		return "cancelled"
	case 5:
		return "paused"
	}
	return fmt.Sprintf("state-%d", v)
}
