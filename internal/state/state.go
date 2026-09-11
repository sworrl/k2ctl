// Package state holds the merged, thread-safe view of the printer that the
// Moonraker poller and the Creality device socket both write into and that the
// HTTP/WebSocket API reads from.
package state

import (
	"sync"
	"time"
)

type Temp struct {
	Actual float64 `json:"actual"`
	Target float64 `json:"target"`
	Max    float64 `json:"max,omitempty"`
}

// Slot is one CFS bay (or the external spool holder when the box type is 1).
type Slot struct {
	ID     int    `json:"id"`
	Label  string `json:"label"` // T1A .. T4D, or EXT
	Vendor string `json:"vendor"`
	Type   string `json:"type"`
	Name   string `json:"name"`
	Color  string `json:"color"` // #RRGGBB
	// Colors is the full colour list for multi-colour spools (rainbow etc.),
	// filled in by the API layer from k2ctl's own bay overrides; otherwise [Color].
	Colors   []string `json:"colors"`
	RFID     string   `json:"rfid"`
	MinTemp  float64  `json:"min_temp"`
	MaxTemp  float64  `json:"max_temp"`
	Pressure float64  `json:"pressure"`
	Percent  int      `json:"percent"`
	Selected bool     `json:"selected"`
	State    int      `json:"state"`
	Editable bool     `json:"editable"`
}

type Box struct {
	ID       int     `json:"id"`
	Name     string  `json:"name"`
	Type     int     `json:"type"` // 0 = CFS unit, 1 = external spool holder
	State    int     `json:"state"`
	Temp     float64 `json:"temp"`
	Humidity float64 `json:"humidity"`
	Serial   string  `json:"serial,omitempty"`
	Slots    []Slot  `json:"slots"`
}

type CFS struct {
	Connected bool              `json:"connected"`
	Enabled   bool              `json:"enabled"`
	Boxes     []Box             `json:"boxes"`
	ToolMap   map[string]string `json:"tool_map,omitempty"` // gcode tool -> physical slot, current job
	Active    string            `json:"active,omitempty"`   // slot currently feeding the extruder
}

type Job struct {
	File        string  `json:"file"`
	State       string  `json:"state"`    // standby|printing|paused|complete|cancelled|error
	Progress    float64 `json:"progress"` // 0..100
	Layer       int     `json:"layer"`
	TotalLayers int     `json:"total_layers"`
	TimeLeft    int     `json:"time_left_s"`
	Elapsed     int     `json:"elapsed_s"`
	StartedAt   int64   `json:"started_at,omitempty"`
}

type Printer struct {
	Hostname  string `json:"hostname"`
	Name      string `json:"name"`
	Model     string `json:"model"`
	State     string `json:"state"`
	RawState  int    `json:"raw_state"`
	Connected bool   `json:"connected"`
	Klipper   string `json:"klipper,omitempty"`
	Firmware  string `json:"firmware,omitempty"`
}

// Fan is one controllable fan as the API exposes it.
type Fan struct {
	On  bool `json:"on"`
	Pct int  `json:"pct"`
}

// FanRec is the recommended fan setting for the filament currently feeding.
type FanRec struct {
	Part    int    `json:"part"`
	Aux     int    `json:"aux"`
	Chamber int    `json:"chamber"`
	Source  string `json:"source"`
}

// FanCtrl is the verbose fan view: part (model) fan, auxiliary (side) fan and
// the chamber/case fan, plus what the active filament profile recommends.
type FanCtrl struct {
	Part        Fan    `json:"part"`
	Aux         Fan    `json:"aux"`
	Chamber     Fan    `json:"chamber"`
	Recommended FanRec `json:"recommended"`
}

// Chamber is everything the printer knows about chamber climate. The stock K2 has a
// thermistor and an exhaust fan with a temperature threshold, no heater; Heater is
// filled in only when Klipper has a heater_generic for the chamber (the K2 Plus PTC or
// a user mod), so the UI can tell "cannot heat" from "heater is off".
type Chamber struct {
	Temp       float64 `json:"temp"`
	MinSeen    float64 `json:"min_seen"`
	MaxSeen    float64 `json:"max_seen"`
	FanOn      bool    `json:"fan_on"`      // exhaust/filter fan currently running
	FanSpeed   float64 `json:"fan_speed"`   // 0..1 as Klipper reports it
	FanTarget  float64 `json:"fan_target"`  // threshold: fan runs above this (M141 S)
	FanEnabled bool    `json:"fan_enabled"` // SET_TEMPERATURE_FAN_SWITCH state, when known
	Heater     *Heater `json:"heater,omitempty"`
}

// Heater is a Klipper heater_generic (present only when a chamber heater is fitted).
type Heater struct {
	Name   string  `json:"name"`
	Temp   float64 `json:"temp"`
	Target float64 `json:"target"`
	Power  float64 `json:"power"` // 0..1 duty
	Max    float64 `json:"max"`
}

type Status struct {
	Printer Printer         `json:"printer"`
	Temps   map[string]Temp `json:"temps"`
	Job     Job             `json:"job"`
	CFS     CFS             `json:"cfs"`
	Light   bool            `json:"light"`
	Chamber Chamber         `json:"chamber"`
	Fans    map[string]int  `json:"fans"` // part|case|aux -> percent (printer's own reading)
	FanOn   map[string]bool `json:"fan_on"`
	// FanCtrl is filled in by the API layer (needs the profile catalog).
	FanCtrl  FanCtrl         `json:"fan_ctrl"`
	SpeedPct int             `json:"speed_pct"`
	FlowPct  int             `json:"flow_pct"`
	Position string          `json:"position"`
	Errors   []string        `json:"errors"`
	Sources  map[string]bool `json:"sources"`
	// Sensors is the verbose view: every Klipper sensor-like object, raw.
	Sensors map[string]map[string]any `json:"sensors"`
	// Device is the last scalar state the Creality socket reported, raw.
	Device    map[string]any `json:"device"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// Sample is one point of temperature history: unix seconds plus, per key
// (nozzle, bed, chamber), [actual, target]; "cfs" carries [temp, humidity] of
// the first CFS unit. Kept in memory only, so it starts empty at every boot.
type Sample struct {
	T int64                 `json:"t"`
	V map[string][2]float64 `json:"v"`
}

const (
	historyStep = 2 * time.Second // at most one sample per step
	historyKeep = 1800            // 1 h at the step above
)

type Store struct {
	mu   sync.RWMutex
	st   Status
	subs map[chan struct{}]struct{}
	hist []Sample
	last time.Time
}

func New() *Store {
	return &Store{
		st: Status{
			Temps:   map[string]Temp{},
			Fans:    map[string]int{},
			FanOn:   map[string]bool{},
			Sources: map[string]bool{},
			Errors:  []string{},
			Sensors: map[string]map[string]any{},
			Device:  map[string]any{},
		},
		subs: map[chan struct{}]struct{}{},
	}
}

// Snapshot returns a copy safe to serialise while writers keep going.
func (s *Store) Snapshot() Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c := s.st
	c.Temps = make(map[string]Temp, len(s.st.Temps))
	for k, v := range s.st.Temps {
		c.Temps[k] = v
	}
	c.Fans = make(map[string]int, len(s.st.Fans))
	for k, v := range s.st.Fans {
		c.Fans[k] = v
	}
	c.FanOn = make(map[string]bool, len(s.st.FanOn))
	for k, v := range s.st.FanOn {
		c.FanOn[k] = v
	}
	c.Sources = make(map[string]bool, len(s.st.Sources))
	for k, v := range s.st.Sources {
		c.Sources[k] = v
	}
	c.Errors = append([]string{}, s.st.Errors...) // never nil: the UI does errors.length
	if s.st.Chamber.Heater != nil {
		h := *s.st.Chamber.Heater
		c.Chamber.Heater = &h
	}
	c.Sensors = make(map[string]map[string]any, len(s.st.Sensors))
	for k, v := range s.st.Sensors {
		c.Sensors[k] = v // values are replaced wholesale, never mutated in place
	}
	c.Device = make(map[string]any, len(s.st.Device))
	for k, v := range s.st.Device {
		c.Device[k] = v
	}
	c.CFS.Boxes = make([]Box, len(s.st.CFS.Boxes))
	for i, b := range s.st.CFS.Boxes {
		b.Slots = append([]Slot{}, b.Slots...) // never nil (JSON null would crash the UI)
		c.CFS.Boxes[i] = b
	}
	if s.st.CFS.ToolMap != nil {
		c.CFS.ToolMap = make(map[string]string, len(s.st.CFS.ToolMap))
		for k, v := range s.st.CFS.ToolMap {
			c.CFS.ToolMap[k] = v
		}
	}
	return c
}

// History returns the temperature samples of the last hour, oldest first.
func (s *Store) History() []Sample {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Sample(nil), s.hist...)
}

// sample appends a history point when the step has elapsed. Caller holds mu.
func (s *Store) sample(now time.Time) {
	if len(s.st.Temps) == 0 || now.Sub(s.last) < historyStep {
		return
	}
	v := make(map[string][2]float64, len(s.st.Temps)+1)
	for k, t := range s.st.Temps {
		v[k] = [2]float64{t.Actual, t.Target}
	}
	for _, b := range s.st.CFS.Boxes {
		if b.Type == 0 {
			v["cfs"] = [2]float64{b.Temp, b.Humidity}
			break
		}
	}
	s.hist = append(s.hist, Sample{T: now.Unix(), V: v})
	if len(s.hist) > historyKeep {
		s.hist = s.hist[len(s.hist)-historyKeep:]
	}
	s.last = now
}

// Update applies fn under the write lock and wakes subscribers.
func (s *Store) Update(fn func(*Status)) {
	s.mu.Lock()
	fn(&s.st)
	s.st.UpdatedAt = time.Now()
	s.sample(s.st.UpdatedAt)
	s.mu.Unlock()
	s.mu.RLock()
	for ch := range s.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	s.mu.RUnlock()
}

// Subscribe returns a channel that receives a tick after every Update.
func (s *Store) Subscribe() (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}
}
