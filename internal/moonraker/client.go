// Package moonraker polls the Moonraker REST API (port 7125) for the
// authoritative Klipper view: heaters, job state, toolhead, and the "box"
// object that Creality's Klipper fork exposes for the CFS.
package moonraker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sworrl/k2ctl/internal/state"
)

type Client struct {
	base    string
	hc      *http.Client
	store   *state.Store
	log     *log.Logger
	objs    []string
	sensors []string
	tick    int
}

// Base returns the Moonraker base URL (used to derive the printer host for other services).
func (c *Client) Base() string { return c.base }

func New(base string, st *state.Store, l *log.Logger) *Client {
	if l == nil {
		l = log.Default()
	}
	return &Client{
		base:  strings.TrimRight(base, "/"),
		hc:    &http.Client{Timeout: 8 * time.Second},
		store: st,
		log:   l,
	}
}

func (c *Client) get(path string, out any) error {
	resp, err := c.hc.Get(c.base + path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("GET %s: %s", path, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) post(path string, body any, out any) error {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return err
		}
	}
	resp, err := c.hc.Post(c.base+path, "application/json", &buf)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("POST %s: %s", path, resp.Status)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

type result[T any] struct {
	Result T `json:"result"`
}

func (c *Client) Info() (map[string]any, error) {
	var r result[map[string]any]
	err := c.get("/printer/info", &r)
	return r.Result, err
}

func (c *Client) Objects() ([]string, error) {
	var r result[struct {
		Objects []string `json:"objects"`
	}]
	err := c.get("/printer/objects/list", &r)
	return r.Result.Objects, err
}

// Query fetches the full status of the named printer objects.
func (c *Client) Query(objs []string) (map[string]map[string]any, error) {
	q := make([]string, 0, len(objs))
	for _, o := range objs {
		q = append(q, url.QueryEscape(o))
	}
	var r result[struct {
		Status map[string]map[string]any `json:"status"`
	}]
	err := c.get("/printer/objects/query?"+strings.Join(q, "&"), &r)
	return r.Result.Status, err
}

func (c *Client) GCode(script string) error {
	return c.post("/printer/gcode/script", map[string]string{"script": script}, nil)
}

func (c *Client) Pause() error  { return c.post("/printer/print/pause", nil, nil) }
func (c *Client) Resume() error { return c.post("/printer/print/resume", nil, nil) }
func (c *Client) Cancel() error { return c.post("/printer/print/cancel", nil, nil) }

func (c *Client) History(limit int) (any, error) {
	var r result[any]
	err := c.get(fmt.Sprintf("/server/history/list?limit=%d&order=desc", limit), &r)
	return r.Result, err
}

// Run polls until ctx is cancelled.
func (c *Client) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := c.poll(); err != nil {
			c.log.Printf("moonraker: %v", err)
			c.store.Update(func(s *state.Status) { s.Sources["moonraker"] = false; s.Printer.Connected = s.Sources["cxws"] })
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

var wanted = []string{"extruder", "heater_bed", "print_stats", "display_status", "virtual_sdcard", "toolhead", "fan", "gcode_move", "box",
	"output_pin fan0", "output_pin fan1", "output_pin fan2"}

// fanPins maps k2ctl fan keys to the K2's Klipper output pins (M106 P index):
// fan0 = part (model) fan, fan1 = chassis/chamber fan, fan2 = auxiliary fan.
var fanPins = map[string]string{"part": "output_pin fan0", "case": "output_pin fan1", "aux": "output_pin fan2"}

func (c *Client) poll() error {
	if c.objs == nil {
		all, err := c.Objects()
		if err != nil {
			return err
		}
		have := map[string]bool{}
		for _, o := range all {
			have[o] = true
		}
		for _, w := range wanted {
			if have[w] {
				c.objs = append(c.objs, w)
			}
		}
		for _, o := range all {
			if strings.Contains(o, "chamber") && (strings.HasPrefix(o, "heater_generic") || strings.HasPrefix(o, "temperature_sensor")) {
				c.objs = append(c.objs, o)
			}
			if isSensorObject(o) {
				c.sensors = append(c.sensors, o)
			}
		}
		if info, err := c.Info(); err == nil {
			c.store.Update(func(s *state.Status) {
				if v, ok := info["hostname"].(string); ok && s.Printer.Hostname == "" {
					s.Printer.Hostname = v
				}
				if v, ok := info["software_version"].(string); ok {
					s.Printer.Klipper = v
				}
			})
		}
	}
	st, err := c.Query(c.objs)
	if err != nil {
		c.objs = nil
		return err
	}
	// The verbose sensor set is polled at a third of the main rate.
	var sensors map[string]map[string]any
	if c.tick%3 == 0 && len(c.sensors) > 0 {
		if sv, err := c.Query(c.sensors); err == nil {
			sensors = sv
		}
	}
	c.tick++
	c.store.Update(func(s *state.Status) {
		s.Sources["moonraker"] = true
		s.Printer.Connected = true
		for k, v := range sensors {
			s.Sensors[k] = v
		}
		if ex, ok := st["extruder"]; ok {
			s.Temps["nozzle"] = mergeTemp(s.Temps["nozzle"], ex)
		}
		if hb, ok := st["heater_bed"]; ok {
			s.Temps["bed"] = mergeTemp(s.Temps["bed"], hb)
		}
		for name, obj := range st {
			if strings.Contains(name, "chamber") {
				s.Temps["chamber"] = mergeTemp(s.Temps["chamber"], obj)
			}
		}
		if ps, ok := st["print_stats"]; ok {
			if v, ok := ps["state"].(string); ok && v != "" {
				s.Job.State = v
				s.Printer.State = v
			}
			if v, ok := ps["filename"].(string); ok {
				s.Job.File = v
			}
			if v, ok := ps["print_duration"].(float64); ok && v > 0 {
				s.Job.Elapsed = int(v)
			}
			if info, ok := ps["info"].(map[string]any); ok {
				if v, ok := info["current_layer"].(float64); ok {
					s.Job.Layer = int(v)
				}
				if v, ok := info["total_layer"].(float64); ok {
					s.Job.TotalLayers = int(v)
				}
			}
		}
		if ds, ok := st["display_status"]; ok {
			if v, ok := ds["progress"].(float64); ok && (v > 0 || s.Job.State == "printing") {
				s.Job.Progress = v * 100
			}
		}
		if s.Job.State == "standby" || s.Job.State == "complete" || s.Job.State == "cancelled" {
			if s.Job.State != "complete" {
				s.Job.Progress = 0
			}
			s.Job.TimeLeft = 0
		}
		if th, ok := st["toolhead"]; ok {
			if pos, ok := th["position"].([]any); ok && len(pos) >= 3 {
				s.Position = fmt.Sprintf("X:%.2f Y:%.2f Z:%.2f", num(pos[0]), num(pos[1]), num(pos[2]))
			}
		}
		if f, ok := st["fan"]; ok {
			if v, ok := f["speed"].(float64); ok {
				s.Fans["part"] = int(v*100 + 0.5)
			}
		}
		for key, obj := range fanPins {
			if pin, ok := st[obj]; ok {
				if v, ok := pin["value"].(float64); ok {
					s.FanOn[key] = v > 0
					// The device socket reports the percentage the firmware was
					// asked for; the pin value is duty after the firmware's curve.
					// Only use it when the socket has nothing better.
					if !s.Sources["cxws"] {
						s.Fans[key] = int(v*100 + 0.5)
					}
					if v == 0 {
						s.Fans[key] = 0
					}
				}
			}
		}
		if gm, ok := st["gcode_move"]; ok {
			if v, ok := gm["speed_factor"].(float64); ok {
				s.SpeedPct = int(v*100 + 0.5)
			}
			if v, ok := gm["extrude_factor"].(float64); ok {
				s.FlowPct = int(v*100 + 0.5)
			}
		}
		if box, ok := st["box"]; ok {
			if v, ok := box["state"].(string); ok {
				s.CFS.Connected = v == "connect"
			}
			if m, ok := box["map"].(map[string]any); ok {
				if s.CFS.ToolMap == nil {
					s.CFS.ToolMap = map[string]string{}
				}
				for k, v := range m {
					if sv, ok := v.(string); ok {
						s.CFS.ToolMap[k] = sv
					}
				}
			}
			for i := range s.CFS.Boxes {
				b := &s.CFS.Boxes[i]
				if b.Type != 0 {
					continue
				}
				unit, ok := box[fmt.Sprintf("T%d", b.ID)].(map[string]any)
				if !ok {
					continue
				}
				if v := num(unit["temperature"]); v > 0 {
					b.Temp = v
				}
				if v := num(unit["dry_and_humidity"]); v > 0 {
					b.Humidity = v
				}
				if f, ok := unit["filament"].(string); ok && len(f) == 1 && f[0] >= 'A' && f[0] <= 'D' {
					s.CFS.Active = fmt.Sprintf("T%d%s", b.ID, f)
				}
			}
		}
	})
	return nil
}

func mergeTemp(t state.Temp, obj map[string]any) state.Temp {
	if v, ok := obj["temperature"].(float64); ok {
		t.Actual = v
	}
	if v, ok := obj["target"].(float64); ok {
		t.Target = v
	}
	return t
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		var f float64
		fmt.Sscanf(x, "%f", &f)
		return f
	}
	return 0
}

var sensorPrefixes = []string{"temperature_sensor", "temperature_fan", "heater_fan", "heater_generic", "controller_fan",
	"fan_generic", "output_pin", "filament_switch_sensor", "filament_motion_sensor", "tmc2208", "tmc2209", "tmc2240", "tmc5160"}
var sensorExact = map[string]bool{"box": true, "filament_rack": true, "system_stats": true, "mcu": true, "fan_feedback": true,
	"fan": true, "extruder": true, "heater_bed": true, "motion_report": true, "idle_timeout": true, "heaters": true, "bed_mesh": false}

// isSensorObject picks the Klipper objects worth showing in a verbose monitor.
func isSensorObject(name string) bool {
	if sensorExact[name] || strings.HasPrefix(name, "mcu ") {
		return true
	}
	for _, p := range sensorPrefixes {
		if strings.HasPrefix(name, p+" ") {
			return true
		}
	}
	return false
}
