// Package api serves the JSON/WebSocket API and the built web UI.
package api

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"github.com/sworrl/k2ctl/internal/cxws"
	"github.com/sworrl/k2ctl/internal/moonraker"
	"github.com/sworrl/k2ctl/internal/profiles"
	"github.com/sworrl/k2ctl/internal/state"
)

//go:embed dist
var dist embed.FS

type Server struct {
	Store   *state.Store
	CX      *cxws.Client
	Moon    *moonraker.Client
	Catalog *profiles.Catalog
	Bays    *profiles.Bays // per-bay overrides (multi-color spools); may be nil
	WebDir  string
	Version string
	Log     *log.Logger
	up      websocket.Upgrader
}

func (s *Server) Handler() http.Handler {
	s.up = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", s.status)
	mux.HandleFunc("GET /api/ws", s.ws)
	mux.HandleFunc("GET /api/sensors", s.sensors)
	mux.HandleFunc("GET /api/profiles", s.listProfiles)
	mux.HandleFunc("POST /api/profiles/reload", s.reloadProfiles)
	mux.HandleFunc("POST /api/cfs/{box}/{slot}/material", s.setMaterial)
	mux.HandleFunc("POST /api/print/{action}", s.printAction)
	mux.HandleFunc("POST /api/light", s.light)
	mux.HandleFunc("POST /api/camera/offer", s.cameraOffer)
	mux.HandleFunc("GET /api/fans", s.getFans)
	mux.HandleFunc("POST /api/fans", s.setFans)
	mux.HandleFunc("POST /api/fans/recommended", s.fansRecommended)
	mux.HandleFunc("POST /api/gcode", s.gcode)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("POST /api/chamber", s.setChamber)
	mux.HandleFunc("GET /api/motion", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, map[string]any{"now": time.Now(), "samples": s.Moon.Motion()})
	})
	mux.HandleFunc("GET /api/files", s.files)
	mux.HandleFunc("GET /api/files/gcode", s.gcodeFile)
	mux.HandleFunc("GET /api/temps/history", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"step_s": 2, "samples": s.Store.History()})
	})
	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"version": s.Version})
	})
	mux.Handle("/", s.static())
	return cors(mux)
}

func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.snapshot())
}

// snapshot is the store snapshot with k2ctl's own knowledge applied: every
// slot gets a Colors list (the stored multi-color list, else [Color]) and the
// verbose fan view (with the active filament's recommendation) is filled in.
func (s *Server) snapshot() state.Status {
	snap := s.Store.Snapshot()
	snap.FanCtrl = s.fanCtrl(snap)
	for bi := range snap.CFS.Boxes {
		box := &snap.CFS.Boxes[bi]
		for si := range box.Slots {
			sl := &box.Slots[si]
			sl.Colors = nil
			if s.Bays != nil {
				if o, ok := s.Bays.Get(box.ID, sl.ID); ok && len(o.Colors) > 1 && sl.State != 0 {
					sl.Colors = append([]string(nil), o.Colors...)
				}
			}
			if sl.Colors == nil {
				if sl.Color != "" {
					sl.Colors = []string{sl.Color}
				} else {
					sl.Colors = []string{}
				}
			}
		}
	}
	return snap
}

func (s *Server) ws(w http.ResponseWriter, r *http.Request) {
	conn, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	ticks, cancel := s.Store.Subscribe()
	defer cancel()
	send := func() error {
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return conn.WriteJSON(s.snapshot())
	}
	if send() != nil {
		return
	}
	// Drain client frames so pings/pongs and closes are processed.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	limiter := time.NewTicker(500 * time.Millisecond)
	defer limiter.Stop()
	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	dirty := false
	for {
		select {
		case <-done:
			return
		case <-ticks:
			dirty = true
		case <-limiter.C:
			if dirty {
				dirty = false
				if send() != nil {
					return
				}
			}
		case <-keepalive.C:
			if send() != nil {
				return
			}
		}
	}
}

// sensors returns the verbose view only: raw Klipper sensor objects plus the
// raw scalar fields from the Creality device socket.
func (s *Server) sensors(w http.ResponseWriter, r *http.Request) {
	snap := s.Store.Snapshot()
	writeJSON(w, 200, map[string]any{"sensors": snap.Sensors, "device": snap.Device, "temps": snap.Temps, "fans": snap.Fans, "updated_at": snap.UpdatedAt})
}

func (s *Server) listProfiles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.Catalog.All())
}

func (s *Server) reloadProfiles(w http.ResponseWriter, r *http.Request) {
	if err := s.Catalog.Reload(); err != nil {
		fail(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]int{"count": len(s.Catalog.All())})
}

type materialReq struct {
	Profile  string   `json:"profile"`
	Vendor   string   `json:"vendor"`
	Type     string   `json:"type"`
	Name     string   `json:"name"`
	Color    string   `json:"color"`
	Colors   []string `json:"colors"` // multi-color spool; 2..8 entries, middle one goes to the printer
	MinTemp  *float64 `json:"min_temp"`
	MaxTemp  *float64 `json:"max_temp"`
	Pressure *float64 `json:"pressure"`
	RFID     *string  `json:"rfid"`
	// Force loads a profile the catalog marks as not CFS-compatible anyway.
	Force bool `json:"force"`
}

// setMaterial writes a material record into a CFS bay, from a catalog
// profile and/or explicit fields (explicit fields win).
func (s *Server) setMaterial(w http.ResponseWriter, r *http.Request) {
	boxID, err1 := strconv.Atoi(r.PathValue("box"))
	slotID, err2 := strconv.Atoi(r.PathValue("slot"))
	if err1 != nil || err2 != nil {
		fail(w, 400, fmt.Errorf("box and slot must be integers"))
		return
	}
	var req materialReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	snap := s.Store.Snapshot()
	var box *state.Box
	var slot *state.Slot
	for i := range snap.CFS.Boxes {
		if snap.CFS.Boxes[i].ID == boxID {
			box = &snap.CFS.Boxes[i]
			for j := range box.Slots {
				if box.Slots[j].ID == slotID {
					slot = &box.Slots[j]
				}
			}
		}
	}
	if box == nil || slot == nil {
		fail(w, 404, fmt.Errorf("box %d slot %d not reported by the printer", boxID, slotID))
		return
	}
	if snap.Job.State == "printing" && slot.Selected {
		fail(w, 409, fmt.Errorf("slot %s is feeding the running print", slot.Label))
		return
	}
	m := cxws.Material{
		Vendor: slot.Vendor, Type: slot.Type, Name: slot.Name, Color: slot.Color,
		MinTemp: slot.MinTemp, MaxTemp: slot.MaxTemp, Pressure: slot.Pressure, RFID: "",
	}
	if req.Profile != "" {
		p, ok := s.Catalog.Get(req.Profile)
		if !ok {
			fail(w, 404, fmt.Errorf("unknown profile %q", req.Profile))
			return
		}
		// CFS bays (box type 0) refuse materials the CFS cannot feed unless forced;
		// the external spool holder (type 1) takes anything.
		if ok, reason := p.CFSOK(); !ok && box.Type == 0 && !req.Force {
			writeJSON(w, 409, map[string]any{"error": fmt.Sprintf("%s %s is not CFS-compatible: %s", p.Vendor, p.Name, reason),
				"cfs_incompatible": true, "reason": reason, "slot": slot.Label})
			return
		}
		m.Vendor, m.Type, m.Name = p.Vendor, p.Type, p.Name
		m.MinTemp, m.MaxTemp, m.Pressure = float64(p.MinTemp), float64(p.MaxTemp), p.Pressure
		m.RFID = p.RFID
		if p.Color != "" {
			m.Color = p.Color
		}
	}
	// Multi-color spools: explicit list wins, else the profile's list. The
	// printer stores one color, so it gets the middle of the list; the full
	// list is kept in bays.json and surfaced as slot.colors.
	var colors []string
	if len(req.Colors) > 0 {
		cs, err := profiles.NormalizeColors(req.Colors)
		if err != nil {
			fail(w, 400, err)
			return
		}
		colors = cs
	} else if req.Profile != "" && req.Color == "" {
		if p, ok := s.Catalog.Get(req.Profile); ok && len(p.Colors) > 1 {
			if cs, err := profiles.NormalizeColors(p.Colors); err == nil {
				colors = cs
			}
		}
	}
	if len(colors) > 0 {
		m.Color = profiles.MiddleColor(colors)
	}
	if req.Vendor != "" {
		m.Vendor = req.Vendor
	}
	if req.Type != "" {
		m.Type = req.Type
	}
	if req.Name != "" {
		m.Name = req.Name
	}
	if req.Color != "" && len(colors) == 0 {
		m.Color = req.Color
	}
	if req.MinTemp != nil {
		m.MinTemp = *req.MinTemp
	}
	if req.MaxTemp != nil {
		m.MaxTemp = *req.MaxTemp
	}
	if req.Pressure != nil {
		m.Pressure = *req.Pressure
	}
	if req.RFID != nil {
		m.RFID = *req.RFID
	}
	if m.Type == "" || m.Name == "" {
		fail(w, 400, fmt.Errorf("type and name are required"))
		return
	}
	if err := s.CX.SetMaterial(boxID, box.Type, slotID, m); err != nil {
		fail(w, 502, err)
		return
	}
	if s.Bays != nil {
		// Remember the profile and color list for this bay; a plain single
		// color or a different profile clears any previous rainbow.
		if err := s.Bays.Set(boxID, slotID, profiles.BayOverride{Profile: req.Profile, Colors: colors}); err != nil {
			s.Log.Printf("bays: %v", err)
		}
	}
	s.Log.Printf("cfs: %s <- %s %s (%s) colors=%v", slot.Label, m.Vendor, m.Name, m.Type, colors)
	// Ask for the fresh inventory so the next status reflects the change.
	go func() {
		time.Sleep(700 * time.Millisecond)
		_ = s.CX.Get(map[string]any{"boxsInfo": 1})
	}()
	writeJSON(w, 200, map[string]any{"ok": true, "slot": slot.Label, "material": m, "colors": colors})
}

func (s *Server) printAction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm bool `json:"confirm"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	var err error
	switch r.PathValue("action") {
	case "pause":
		err = s.Moon.Pause()
	case "resume":
		err = s.Moon.Resume()
	case "cancel":
		if !body.Confirm {
			fail(w, 400, fmt.Errorf("cancel needs {\"confirm\":true}"))
			return
		}
		err = s.Moon.Cancel()
	default:
		fail(w, 404, fmt.Errorf("unknown action"))
		return
	}
	if err != nil {
		fail(w, 502, err)
		return
	}
	s.Log.Printf("print: %s", r.PathValue("action"))
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) light(w http.ResponseWriter, r *http.Request) {
	var body struct {
		On *bool `json:"on"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.On == nil {
		fail(w, 400, fmt.Errorf("body must be {\"on\":true|false}"))
		return
	}
	if err := s.CX.SetLight(*body.On); err != nil {
		fail(w, 502, err)
		return
	}
	s.Store.Update(func(st *state.Status) { st.Light = *body.On })
	writeJSON(w, 200, map[string]bool{"ok": true, "on": *body.On})
}

func (s *Server) gcode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Script string `json:"script"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Script) == "" {
		fail(w, 400, fmt.Errorf("body must be {\"script\":\"...\"}"))
		return
	}
	if err := s.Moon.GCode(body.Script); err != nil {
		fail(w, 502, err)
		return
	}
	s.Log.Printf("gcode: %s", body.Script)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// setChamber takes {"fan_threshold": n} (exhaust fan runs above n °C; 0 turns the loop
// off, Creality's M141) and/or {"heat": n} (heater_generic setpoint; 409 when no heater
// is fitted). Both go through Klipper gcode so the touchscreen and slicer stay in sync.
func (s *Server) setChamber(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FanThreshold *float64 `json:"fan_threshold"`
		Heat         *float64 `json:"heat"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(w, 400, err)
		return
	}
	snap := s.Store.Snapshot()
	var cmds []string
	if body.FanThreshold != nil {
		t := *body.FanThreshold
		if t < 0 || t > 80 {
			fail(w, 400, fmt.Errorf("fan_threshold must be 0..80"))
			return
		}
		cmds = append(cmds, fmt.Sprintf("M141 S%d", int(t)))
	}
	if body.Heat != nil {
		h := snap.Chamber.Heater
		if h == nil {
			writeJSON(w, 409, map[string]any{"error": "no chamber heater is fitted", "no_heater": true})
			return
		}
		t := *body.Heat
		max := h.Max
		if max <= 0 {
			max = 80
		}
		if t < 0 || t > max {
			fail(w, 400, fmt.Errorf("heat must be 0..%.0f", max))
			return
		}
		cmds = append(cmds, fmt.Sprintf("SET_HEATER_TEMPERATURE HEATER=%s TARGET=%d", h.Name, int(t)))
	}
	if len(cmds) == 0 {
		fail(w, 400, fmt.Errorf("nothing to set"))
		return
	}
	for _, c := range cmds {
		if err := s.Moon.GCode(c); err != nil {
			fail(w, 502, err)
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "sent": cmds})
}

// files lists the gcode files on the printer (newest first).
func (s *Server) files(w http.ResponseWriter, r *http.Request) {
	fl, err := s.Moon.Files()
	if err != nil {
		fail(w, 502, err)
		return
	}
	if fl == nil {
		fl = []moonraker.File{}
	}
	writeJSON(w, 200, fl)
}

// gcodeFile streams one gcode file from the printer so the dashboard's viewer can
// read it from the same origin (no CORS, no mixed content over HTTPS).
func (s *Server) gcodeFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		fail(w, 400, fmt.Errorf("path is required"))
		return
	}
	resp, err := s.Moon.Open(p, r.Header.Get("Range"))
	if err != nil {
		fail(w, 502, err)
		return
	}
	defer resp.Body.Close()
	for _, h := range []string{"Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 10
	}
	h, err := s.Moon.History(limit)
	if err != nil {
		fail(w, 502, err)
		return
	}
	writeJSON(w, 200, h)
}

// static serves the web UI from WebDir when set, otherwise the embedded build,
// with an SPA fallback to index.html.
func (s *Server) static() http.Handler {
	var root fs.FS
	if s.WebDir != "" {
		root = os.DirFS(s.WebDir)
	} else {
		sub, err := fs.Sub(dist, "dist")
		if err != nil {
			panic(err)
		}
		root = sub
	}
	files := http.FS(root)
	srv := http.FileServer(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := root.Open(p); err == nil {
			f.Close()
			if strings.HasPrefix(p, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			srv.ServeHTTP(w, r)
			return
		}
		r.URL.Path = "/"
		srv.ServeHTTP(w, r)
	})
}
