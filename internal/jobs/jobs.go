// Package jobs is the print ledger: one record per Moonraker history job with
// what it used (filament grams per material, electricity) and what that cost.
//
// Filament comes from Klipper's own extruded length (filament_used, so purges,
// flushes and cancelled prints count as they happened), split between
// materials by the slicer's per-extruder lengths and weighed with the density
// from the gcode footer. Electricity is metered live while k2ctl runs: heater
// duty (Klipper's PWM power) times the heater wattage, plus a fixed base load.
// Seconds of a job that k2ctl did not see (older jobs, k2ctl restarts) are
// estimated from the bed and nozzle temperatures with holding-duty rates
// learned from the metered jobs.
//
// Raw inputs are stored, costs are derived, so changing a price or a wattage
// reprices every job. The ledger lives in jobs.json next to profiles.json.
package jobs

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sworrl/k2ctl/internal/moonraker"
	"github.com/sworrl/k2ctl/internal/profiles"
)

// Settings are the prices and power figures the costs are computed from.
type Settings struct {
	Currency  string  `json:"currency"`
	KWhPrice  float64 `json:"kwh_price"`
	HotendW   float64 `json:"hotend_w"`   // hotend heater at 100 % PWM (Creality spec: 70 W)
	BedW      float64 `json:"bed_w"`      // bed heater at 100 % PWM (Klipper caps the K2 bed at 50 %)
	BaseW     float64 `json:"base_w"`     // board, screen, steppers, fans, camera, CFS while a job runs
	AmbientC  float64 `json:"ambient_c"`  // room temperature for the holding-power estimate
	DefaultKg float64 `json:"default_kg"` // spool price per kg when neither the table nor the gcode has one
	// PricePerKg is the spool price per kg by filament type (PLA, PETG...). It
	// wins over the gcode's filament_cost, which is usually the slicer default.
	PricePerKg map[string]float64 `json:"price_per_kg"`
}

// DefaultSettings: US prices in 2026 dollars; wattages are estimates until
// someone measures the printer at the wall.
func DefaultSettings() Settings {
	return Settings{
		Currency: "$", KWhPrice: 0.17, HotendW: 70, BedW: 700, BaseW: 40, AmbientC: 22, DefaultKg: 20,
		PricePerKg: map[string]float64{"PLA": 18, "PLA+": 20, "PETG": 18, "ABS": 18, "ASA": 24, "TPU": 30, "PA": 45, "PC": 35},
	}
}

// Material is one filament used by a job.
type Material struct {
	Type    string  `json:"type"`
	Name    string  `json:"name,omitempty"`  // slicer preset, when the gcode had one
	Color   string  `json:"color,omitempty"` // #RRGGBB
	Density float64 `json:"density"`
	MM      float64 `json:"mm"`
	Grams   float64 `json:"g"`
	GcodeKg float64 `json:"gcode_price_kg,omitempty"` // filament_cost from the slicer
	PriceKg float64 `json:"price_kg"`                 // the price actually applied
	Cost    float64 `json:"cost"`
	Source  string  `json:"source"` // gcode | filename | default
}

// Meter is what k2ctl measured itself: seconds observed and heater
// duty-seconds (sum of PWM power x seconds) over those seconds.
type Meter struct {
	Secs     float64 `json:"secs"`
	BedDutyS float64 `json:"bed_duty_s"`
	HotDutyS float64 `json:"hot_duty_s"`
}

// Job is one ledger record.
type Job struct {
	ID       string  `json:"id"`
	File     string  `json:"file"`
	Title    string  `json:"title"`
	Status   string  `json:"status"` // in_progress | completed | cancelled | error | klippy_shutdown ...
	Start    float64 `json:"start"`
	End      float64 `json:"end,omitempty"`
	TotalS   float64 `json:"total_s"`
	PrintS   float64 `json:"print_s"`
	FilMM    float64 `json:"filament_mm"`
	BedC     float64 `json:"bed_c"`
	NozzleC  float64 `json:"nozzle_c"`
	EstS     float64 `json:"slicer_s,omitempty"` // slicer time estimate
	HeightMM float64 `json:"height_mm,omitempty"`
	HasThumb bool    `json:"thumb"`
	Exists   bool    `json:"exists"`

	Materials []Material `json:"materials"`
	Meter     Meter      `json:"meter"`

	// Derived by price().
	Grams      float64 `json:"g"`
	KWh        float64 `json:"kwh"`
	FilCost    float64 `json:"filament_cost"`
	EnergyCost float64 `json:"energy_cost"`
	Cost       float64 `json:"cost"`
	Measured   float64 `json:"measured_pct"` // share of the job's seconds k2ctl metered, 0..100

	Scanned int `json:"scanned"` // scanVersion when the gcode was read (or known to be gone); 0 = not yet
}

// scanVersion goes up when the gcode reading changes, so old records are read again.
const scanVersion = 4

// Ledger keeps the records and their settings on disk.
type Ledger struct {
	mu       sync.Mutex
	path     string
	thumbDir string
	moon     *moonraker.Client
	cat      *profiles.Catalog
	log      *log.Logger
	set      Settings
	jobs     map[string]*Job
	live     *liveMeter
}

type liveMeter struct {
	id   string
	last time.Time
}

type disk struct {
	Settings Settings        `json:"settings"`
	Jobs     map[string]*Job `json:"jobs"`
}

// Open loads (or starts) the ledger at path. Thumbnails go to thumbs/ beside it.
func Open(path string, moon *moonraker.Client, cat *profiles.Catalog, l *log.Logger) *Ledger {
	lg := &Ledger{path: path, thumbDir: filepath.Join(filepath.Dir(path), "thumbs"), moon: moon, cat: cat, log: l,
		set: DefaultSettings(), jobs: map[string]*Job{}}
	if b, err := os.ReadFile(path); err == nil {
		var d disk
		if err := json.Unmarshal(b, &d); err != nil {
			l.Printf("jobs: %s unreadable, starting over: %v", path, err)
		} else {
			if d.Jobs != nil {
				lg.jobs = d.Jobs
			}
			lg.set = mergeSettings(DefaultSettings(), d.Settings)
		}
	}
	return lg
}

// mergeSettings fills zero fields of s from def so an older file gains new keys.
func mergeSettings(def, s Settings) Settings {
	if s.Currency == "" {
		s.Currency = def.Currency
	}
	for _, p := range []struct{ v, d *float64 }{{&s.KWhPrice, &def.KWhPrice}, {&s.HotendW, &def.HotendW}, {&s.BedW, &def.BedW},
		{&s.BaseW, &def.BaseW}, {&s.AmbientC, &def.AmbientC}, {&s.DefaultKg, &def.DefaultKg}} {
		if *p.v <= 0 {
			*p.v = *p.d
		}
	}
	if s.PricePerKg == nil {
		s.PricePerKg = def.PricePerKg
	}
	return s
}

func (lg *Ledger) saveLocked() {
	b, err := json.MarshalIndent(disk{Settings: lg.set, Jobs: lg.jobs}, "", " ")
	if err != nil {
		return
	}
	tmp := lg.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		lg.log.Printf("jobs: save: %v", err)
		return
	}
	if err := os.Rename(tmp, lg.path); err != nil {
		lg.log.Printf("jobs: save: %v", err)
	}
}

// Settings returns the current prices and wattages.
func (lg *Ledger) Settings() Settings {
	lg.mu.Lock()
	defer lg.mu.Unlock()
	return lg.set
}

// SetSettings updates the settings (zero fields keep their current value) and reprices every job.
func (lg *Ledger) SetSettings(s Settings) Settings {
	lg.mu.Lock()
	defer lg.mu.Unlock()
	// Price table: the types sent are set, a price of 0 removes a type, the rest stay.
	table := map[string]float64{}
	for k, v := range lg.set.PricePerKg {
		table[k] = v
	}
	for k, v := range s.PricePerKg {
		if k = strings.ToUpper(strings.TrimSpace(k)); k == "" {
			continue
		} else if v > 0 {
			table[k] = v
		} else {
			delete(table, k)
		}
	}
	s.PricePerKg = table
	lg.set = mergeSettings(lg.set, s)
	lg.priceAllLocked()
	lg.saveLocked()
	return lg.set
}

// Totals sums the ledger.
type Totals struct {
	Jobs       int     `json:"jobs"`
	Grams      float64 `json:"g"`
	KWh        float64 `json:"kwh"`
	FilCost    float64 `json:"filament_cost"`
	EnergyCost float64 `json:"energy_cost"`
	Cost       float64 `json:"cost"`
	Hours      float64 `json:"hours"`
}

// List returns the jobs newest first with totals.
func (lg *Ledger) List() ([]Job, Totals) {
	lg.mu.Lock()
	defer lg.mu.Unlock()
	out := make([]Job, 0, len(lg.jobs))
	var t Totals
	for _, j := range lg.jobs {
		out = append(out, *j)
		t.Jobs++
		t.Grams += j.Grams
		t.KWh += j.KWh
		t.FilCost += j.FilCost
		t.EnergyCost += j.EnergyCost
		t.Cost += j.Cost
		t.Hours += j.TotalS / 3600
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Start > out[b].Start })
	return out, t
}

// ThumbPath returns the cached PNG for a job, or "".
func (lg *Ledger) ThumbPath(id string) string {
	lg.mu.Lock()
	j := lg.jobs[id]
	lg.mu.Unlock()
	if j == nil || !j.HasThumb {
		return ""
	}
	return filepath.Join(lg.thumbDir, safeID(id)+".png")
}

func safeID(id string) string { return regexp.MustCompile(`[^A-Za-z0-9_-]`).ReplaceAllString(id, "_") }

// Run keeps the ledger in step with Moonraker: the heater meter every few
// seconds, the history sync (and backfill) every minute.
func (lg *Ledger) Run(stop <-chan struct{}) {
	meter := time.NewTicker(4 * time.Second)
	defer meter.Stop()
	sync := time.NewTicker(time.Minute)
	defer sync.Stop()
	lg.syncHistory()
	lastSave := time.Now()
	for {
		select {
		case <-stop:
			lg.mu.Lock()
			lg.saveLocked()
			lg.mu.Unlock()
			return
		case <-meter.C:
			if lg.tick() && time.Since(lastSave) > time.Minute {
				lg.mu.Lock()
				lg.saveLocked()
				lg.mu.Unlock()
				lastSave = time.Now()
			}
		case <-sync.C:
			lg.syncHistory()
			lastSave = time.Now()
		}
	}
}

// tick meters the heaters for the running job. It returns true when it added a sample.
func (lg *Ledger) tick() bool {
	st, err := lg.moon.Query([]string{"heater_bed", "extruder", "print_stats"})
	if err != nil {
		return false
	}
	ps := st["print_stats"]
	state, _ := ps["state"].(string)
	now := time.Now()
	if state != "printing" && state != "paused" {
		lg.mu.Lock()
		lg.live = nil
		lg.mu.Unlock()
		return false
	}
	lg.mu.Lock()
	defer lg.mu.Unlock()
	if lg.live == nil {
		// A new job (or k2ctl just started mid-job): find its history id first.
		lg.mu.Unlock()
		id := lg.currentJobID()
		lg.mu.Lock()
		if id == "" {
			return false
		}
		lg.live = &liveMeter{id: id, last: now}
		if lg.jobs[id] == nil {
			lg.mu.Unlock()
			lg.syncHistory()
			lg.mu.Lock()
		}
		return false
	}
	j := lg.jobs[lg.live.id]
	if j == nil || j.Status != "in_progress" {
		lg.live = nil
		return false
	}
	dt := now.Sub(lg.live.last).Seconds()
	lg.live.last = now
	if dt <= 0 || dt > 30 { // a stall or a clock jump: skip rather than guess
		return false
	}
	j.Meter.Secs += dt
	j.Meter.BedDutyS += num(st["heater_bed"]["power"]) * dt
	j.Meter.HotDutyS += num(st["extruder"]["power"]) * dt
	j.TotalS = num(ps["total_duration"])
	j.PrintS = num(ps["print_duration"])
	j.FilMM = num(ps["filament_used"])
	if t := num(st["heater_bed"]["target"]); t > 0 {
		j.BedC = t
	}
	if t := num(st["extruder"]["target"]); t > 0 {
		j.NozzleC = t
	}
	lg.priceLocked(j, lg.ratesLocked())
	return true
}

func (lg *Ledger) currentJobID() string {
	h, err := lg.moon.HistoryPage(0, 5)
	if err != nil {
		return ""
	}
	for _, j := range h {
		if j.Status == "in_progress" {
			return j.JobID
		}
	}
	return ""
}

// syncHistory pulls the whole Moonraker history and adds or refreshes records.
func (lg *Ledger) syncHistory() {
	var all []moonraker.HistJob
	for start := 0; ; start += 100 {
		page, err := lg.moon.HistoryPage(start, 100)
		if err != nil {
			lg.log.Printf("jobs: history: %v", err)
			return
		}
		all = append(all, page...)
		if len(page) < 100 {
			break
		}
	}
	for _, h := range all {
		lg.mu.Lock()
		j := lg.jobs[h.JobID]
		fresh := j == nil
		if fresh {
			j = &Job{ID: h.JobID}
			lg.jobs[h.JobID] = j
		}
		j.File, j.Title, j.Status, j.Start, j.Exists = h.Filename, title(h.Filename), h.Status, h.StartTime, h.Exists
		if h.EndTime != nil {
			j.End = *h.EndTime
		}
		if h.Status != "in_progress" || j.TotalS == 0 {
			j.TotalS, j.PrintS = h.TotalDuration, h.PrintDuration
			if h.FilamentUsed > 0 || h.Status != "in_progress" {
				j.FilMM = h.FilamentUsed
			}
		}
		if v := num(h.Metadata["first_layer_bed_temp"]); v > 0 && j.BedC == 0 {
			j.BedC = v
		}
		if v := num(h.Metadata["object_height"]); v > 0 {
			j.HeightMM = v
		}
		if v := num(h.Metadata["estimated_time"]); v > 0 {
			j.EstS = v
		}
		scanned := j.Scanned >= scanVersion
		file, exists := j.File, j.Exists
		lg.mu.Unlock()

		if !scanned {
			var g *gcodeInfo
			if exists {
				var err error
				if g, err = lg.readGcode(h.JobID, file); err != nil {
					lg.log.Printf("jobs: %s: %v", file, err)
				}
			}
			lg.mu.Lock()
			lg.applyGcode(j, g)
			if exists == (g != nil) { // a failed read on a file that exists is retried next sync
				j.Scanned = scanVersion
			}
			lg.mu.Unlock()
		}
	}
	lg.mu.Lock()
	lg.priceAllLocked()
	lg.saveLocked()
	lg.mu.Unlock()
}

// title turns "base_PLA_6h41m7s.gcode" or ".Dragon_09241750.3mf/plate_1.gcode" into a readable name.
func title(file string) string {
	s := strings.TrimPrefix(file, ".")
	if i := strings.Index(s, ".3mf/"); i >= 0 {
		s = s[:i]
	}
	s = strings.TrimSuffix(s, ".gcode")
	s = regexp.MustCompile(`_\d+h\d+m\d+s$`).ReplaceAllString(s, "")
	s = regexp.MustCompile(`_\d{8}$`).ReplaceAllString(s, "") // Creality cloud upload stamp
	s = regexp.MustCompile(`(?i)[_ ](PLA\+?|PETG|ABS|ASA|TPU)$`).ReplaceAllString(s, "")
	s = strings.NewReplacer("_", " ", ".stl", "").Replace(s)
	return strings.TrimSpace(s)
}

// presetSuffix is the "(project.3mf)" Creality Print appends to a preset edited inside a project.
var presetSuffix = regexp.MustCompile(`\s*\([^()]*\.3mf\)\s*$`)

var typeInName = regexp.MustCompile(`(?i)(?:^|[_ .-])(PLA\+?|PETG|ABS|ASA|TPU|PA|PC)(?:[_ .-]|$)`)

// gcodeInfo is what the slicer footer and header say about a file.
type gcodeInfo struct {
	types, names, colors []string
	density, costKg, mm  []float64
	bedC, nozzleC, estS  float64
	thumb                bool
}

// readGcode reads the thumbnail from the head and the settings from the tail of a gcode file.
func (lg *Ledger) readGcode(id, file string) (*gcodeInfo, error) {
	resp, err := lg.moon.Open(file, "bytes=0-600000")
	if err != nil {
		return nil, err
	}
	head, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("head: %s", resp.Status)
	}
	resp, err = lg.moon.Open(file, "bytes=-80000")
	if err != nil {
		return nil, err
	}
	tail, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	g, png := parseGcode(head, tail)
	if png != nil {
		if err := os.MkdirAll(lg.thumbDir, 0o755); err == nil {
			if os.WriteFile(filepath.Join(lg.thumbDir, safeID(id)+".png"), png, 0o644) == nil {
				g.thumb = true
			}
		}
	}
	return g, nil
}

// plateKey maps Creality Print's curr_bed_type to the key holding that plate's bed temperature.
var plateKey = map[string]string{"Textured PEI Plate": "textured_plate_temp", "High Temp Plate": "hot_plate_temp",
	"Cool Plate": "cool_plate_temp", "Engineering Plate": "eng_plate_temp", "Smooth PEI Plate": "hot_plate_temp"}

// parseGcode reads the slicer's settings from the first and last few hundred kB of a
// gcode file and returns them with the largest PNG thumbnail (nil when there is none).
func parseGcode(head, tail []byte) (*gcodeInfo, []byte) {
	g := &gcodeInfo{}
	kv := map[string]string{}
	for _, blob := range [][]byte{head, tail} {
		sc := bufio.NewScanner(strings.NewReader(string(blob)))
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "; ") {
				continue
			}
			k, v, ok := strings.Cut(line[2:], " = ")
			if !ok {
				k, v, ok = strings.Cut(line[2:], ": ")
			}
			if ok {
				kv[k] = strings.TrimSpace(v) // the tail is read last, so its values win
			}
		}
	}
	g.types = list(kv["filament_type"])
	g.names = list(strings.ReplaceAll(kv["filament_settings_id"], `"`, ""))
	g.colors = list(kv["filament_colour"])
	g.density = nums(kv["filament_density"])
	g.costKg = nums(kv["filament_cost"])
	g.mm = nums(kv["filament used [mm]"])
	keys := []string{"hot_plate_temp"}
	if k, ok := plateKey[strings.Trim(kv["curr_bed_type"], `"`)]; ok {
		keys = []string{k, "hot_plate_temp"}
	}
	for _, k := range keys {
		if b := nums(kv[k+"_initial_layer"]); len(b) > 0 && b[0] > 0 {
			g.bedC = b[0]
		} else if b := nums(kv[k]); len(b) > 0 && b[0] > 0 {
			g.bedC = b[0]
		}
		if g.bedC > 0 {
			break
		}
	}
	if n := nums(kv["nozzle_temperature"]); len(n) > 0 {
		g.nozzleC = n[0]
	}
	g.estS = parseDuration(kv["estimated printing time (normal mode)"])
	return g, largestThumb(head)
}

var durRe = regexp.MustCompile(`(\d+)\s*([dhms])`)

// parseDuration reads the slicer's "1d 6h 41m 7s" form.
func parseDuration(v string) float64 {
	var s float64
	for _, m := range durRe.FindAllStringSubmatch(v, -1) {
		n, _ := strconv.ParseFloat(m[1], 64)
		s += n * map[string]float64{"d": 86400, "h": 3600, "m": 60, "s": 1}[m[2]]
	}
	return s
}

var thumbRe = regexp.MustCompile(`(?m)^; thumbnail begin (\d+)x(\d+) \d+\s*$`)

func largestThumb(head []byte) []byte {
	s := string(head)
	best, bestPx := []byte(nil), 0
	for _, m := range thumbRe.FindAllStringSubmatchIndex(s, -1) {
		w, _ := strconv.Atoi(s[m[2]:m[3]])
		h, _ := strconv.Atoi(s[m[4]:m[5]])
		end := strings.Index(s[m[1]:], "; thumbnail end")
		if end < 0 || w*h <= bestPx {
			continue
		}
		var b strings.Builder
		for _, l := range strings.Split(s[m[1]:m[1]+end], "\n") {
			b.WriteString(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), ";")))
		}
		if png, err := base64.StdEncoding.DecodeString(b.String()); err == nil && len(png) > 8 && string(png[1:4]) == "PNG" {
			best, bestPx = png, w*h
		}
	}
	return best
}

func list(v string) []string {
	if v == "" {
		return nil
	}
	sep := ";"
	if !strings.Contains(v, ";") {
		sep = ","
	}
	var out []string
	for _, p := range strings.Split(v, sep) {
		out = append(out, strings.TrimSpace(p))
	}
	return out
}

func nums(v string) []float64 {
	var out []float64
	for _, p := range list(v) {
		f, err := strconv.ParseFloat(p, 64)
		if err != nil {
			f = 0
		}
		out = append(out, f)
	}
	return out
}

// applyGcode sets the job's materials from the gcode footer, else from the filename.
func (lg *Ledger) applyGcode(j *Job, g *gcodeInfo) {
	j.Materials = nil
	if g != nil {
		j.HasThumb = g.thumb
		if g.bedC > 0 && j.BedC == 0 { // Moonraker's first_layer_bed_temp is read from the M140 itself
			j.BedC = g.bedC
		}
		if g.nozzleC > 0 && j.NozzleC == 0 {
			j.NozzleC = g.nozzleC
		}
		if g.estS > 0 {
			j.EstS = g.estS
		}
		// Only the extruders the slicer actually used (mm > 0).
		for i, mm := range g.mm {
			if mm <= 0 {
				continue
			}
			m := Material{Type: at(g.types, i), Name: at(g.names, i), Color: at(g.colors, i), MM: mm, Source: "gcode"}
			if i < len(g.density) {
				m.Density = g.density[i]
			}
			if i < len(g.costKg) {
				m.GcodeKg = g.costKg[i]
			}
			j.Materials = append(j.Materials, m)
		}
		if len(j.Materials) == 0 && len(g.types) > 0 {
			m := Material{Type: g.types[0], Name: at(g.names, 0), Color: at(g.colors, 0), Source: "gcode"}
			if len(g.density) > 0 {
				m.Density = g.density[0]
			}
			if len(g.costKg) > 0 {
				m.GcodeKg = g.costKg[0]
			}
			j.Materials = []Material{m}
		}
	}
	if len(j.Materials) == 0 {
		m := Material{Type: "PLA", Source: "default"}
		if t := typeInName.FindStringSubmatch(j.File); t != nil {
			m.Type, m.Source = strings.ToUpper(t[1]), "filename"
		}
		j.Materials = []Material{m}
	}
	for i := range j.Materials {
		m := &j.Materials[i]
		m.Name = presetSuffix.ReplaceAllString(m.Name, "")
		m.Type = strings.ToUpper(strings.TrimSpace(m.Type))
		if m.Type == "" { // older footers carry only the preset name
			for _, src := range []string{m.Name, j.File} {
				if t := typeInName.FindStringSubmatch(src); t != nil {
					m.Type = strings.ToUpper(t[1])
					break
				}
			}
			if m.Type == "" {
				m.Type = "PLA"
			}
		}
		if m.Type == "PLA" && strings.Contains(strings.ToUpper(m.Name), "PLA+") {
			m.Type = "PLA+" // Creality Print writes PLA+ presets as type PLA; they are priced apart
		}
		if m.Density <= 0 {
			m.Density = lg.density(m.Type)
		}
	}
	if j.NozzleC == 0 {
		j.NozzleC = defaultNozzle(j.Materials[0].Type)
	}
	if j.BedC == 0 {
		j.BedC = defaultBed(j.Materials[0].Type)
	}
}

func at(s []string, i int) string {
	if i < len(s) {
		return s[i]
	}
	return ""
}

// density: the catalog's figure for the type, else a textbook value.
func (lg *Ledger) density(t string) float64 {
	if lg.cat != nil {
		for _, p := range lg.cat.All() {
			if strings.EqualFold(p.Type, t) && p.Density > 0 {
				return p.Density
			}
		}
	}
	switch {
	case strings.HasPrefix(t, "PETG"):
		return 1.27
	case strings.HasPrefix(t, "ABS"):
		return 1.04
	case strings.HasPrefix(t, "ASA"):
		return 1.07
	case strings.HasPrefix(t, "TPU"):
		return 1.21
	case strings.HasPrefix(t, "PC"):
		return 1.20
	case strings.HasPrefix(t, "PA"):
		return 1.14
	}
	return 1.24 // PLA
}

func defaultNozzle(t string) float64 {
	switch {
	case strings.HasPrefix(t, "PETG"):
		return 250
	case strings.HasPrefix(t, "ABS"), strings.HasPrefix(t, "ASA"):
		return 260
	case strings.HasPrefix(t, "TPU"):
		return 230
	}
	return 220
}

func defaultBed(t string) float64 {
	switch {
	case strings.HasPrefix(t, "PETG"):
		return 75
	case strings.HasPrefix(t, "ABS"), strings.HasPrefix(t, "ASA"):
		return 100
	case strings.HasPrefix(t, "TPU"):
		return 40
	}
	return 60
}

// rates are mean heater duty per degree above ambient while holding
// temperature, learned from metered time (falling back to what this K2
// showed on 2026-09-27: bed 20 % at 60 °C, hotend 63 % at 220 °C with the
// part fan on).
type rates struct{ bed, hot float64 }

func (lg *Ledger) ratesLocked() rates {
	r := rates{bed: 0.20 / (60 - 22), hot: 0.63 / (220 - 22)}
	var bs, bw, hs, hw float64
	for _, j := range lg.jobs {
		if j.Meter.Secs < 600 {
			continue
		}
		if d := j.BedC - lg.set.AmbientC; d > 5 {
			bs += j.Meter.BedDutyS / d
			bw += j.Meter.Secs
		}
		if d := j.NozzleC - lg.set.AmbientC; d > 5 {
			hs += j.Meter.HotDutyS / d
			hw += j.Meter.Secs
		}
	}
	if bw >= 3600 {
		r.bed = bs / bw
	}
	if hw >= 3600 {
		r.hot = hs / hw
	}
	return r
}

func (lg *Ledger) priceAllLocked() {
	r := lg.ratesLocked()
	for _, j := range lg.jobs {
		lg.priceLocked(j, r)
	}
}

// priceLocked derives grams, kWh and costs from the stored inputs.
func (lg *Ledger) priceLocked(j *Job, r rates) {
	s := lg.set
	// Filament: Klipper's measured length, split by the slicer's shares.
	var slicerMM float64
	for _, m := range j.Materials {
		slicerMM += m.MM
	}
	area := math.Pi * 0.875 * 0.875 // mm2, 1.75 mm filament
	j.Grams, j.FilCost = 0, 0
	for i := range j.Materials {
		m := &j.Materials[i]
		share := 1.0 / float64(len(j.Materials))
		if slicerMM > 0 {
			share = m.MM / slicerMM
		}
		m.Grams = j.FilMM * share * area * m.Density / 1000
		m.PriceKg = s.DefaultKg
		if p, ok := s.PricePerKg[m.Type]; ok {
			m.PriceKg = p
		} else if m.GcodeKg > 0 {
			m.PriceKg = m.GcodeKg
		}
		m.Cost = m.Grams / 1000 * m.PriceKg
		j.Grams += m.Grams
		j.FilCost += m.Cost
	}
	// Electricity: metered seconds as measured, the rest estimated.
	total := math.Max(j.TotalS, j.Meter.Secs)
	rest := total - j.Meter.Secs
	bedDutyS := j.Meter.BedDutyS + rest*r.bed*math.Max(0, j.BedC-s.AmbientC)
	hotDutyS := j.Meter.HotDutyS + rest*r.hot*math.Max(0, j.NozzleC-s.AmbientC)
	j.KWh = (bedDutyS*s.BedW + hotDutyS*s.HotendW + total*s.BaseW) / 3.6e6
	j.EnergyCost = j.KWh * s.KWhPrice
	j.Cost = j.FilCost + j.EnergyCost
	j.Measured = 0
	if total > 0 {
		j.Measured = math.Min(100, 100*j.Meter.Secs/total)
	}
}

func num(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case json.Number:
		f, _ := x.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	}
	return 0
}

// Estimate is the projected cost of a sliced file that has not been printed.
type Estimate struct {
	Name       string     `json:"name"`
	Title      string     `json:"title"`
	Materials  []Material `json:"materials"`
	Grams      float64    `json:"g"`
	FilCost    float64    `json:"filament_cost"`
	SlicerS    float64    `json:"slicer_s"`
	TotalS     float64    `json:"total_s"`    // slicer time scaled by TimeFactor
	TimeFactor float64    `json:"time_factor"` // median actual/slicer time of past completed jobs
	FactorJobs int        `json:"factor_jobs"` // how many jobs the factor came from
	KWh        float64    `json:"kwh"`
	EnergyCost float64    `json:"energy_cost"`
	Cost       float64    `json:"cost"`
	BedC       float64    `json:"bed_c"`
	NozzleC    float64    `json:"nozzle_c"`
	Thumb      string     `json:"thumb,omitempty"` // PNG, base64
	Currency   string     `json:"currency"`
	Warnings   []string   `json:"warnings,omitempty"`
}

// timeFactorLocked is how long jobs really take against the slicer's estimate
// (heat-up, soak, CFS swaps), as the median over completed jobs, else 1.08.
func (lg *Ledger) timeFactorLocked() (float64, int) {
	var rs []float64
	for _, j := range lg.jobs {
		if j.Status == "completed" && j.EstS > 300 && j.TotalS > 0 {
			if r := j.TotalS / j.EstS; r > 0.7 && r < 2.5 {
				rs = append(rs, r)
			}
		}
	}
	if len(rs) < 3 {
		return 1.08, len(rs)
	}
	sort.Float64s(rs)
	return rs[len(rs)/2], len(rs)
}

// Estimate prices a sliced gcode from its first and last few hundred kB, with the
// ledger's prices, the heater rates learned from metered jobs, and the printer's
// usual overrun of the slicer's time.
func (lg *Ledger) Estimate(name string, head, tail []byte) Estimate {
	g, png := parseGcode(head, tail)
	lg.mu.Lock()
	defer lg.mu.Unlock()
	j := &Job{File: name, Title: title(name)}
	lg.applyGcode(j, g)
	for _, m := range j.Materials {
		j.FilMM += m.MM
	}
	f, n := lg.timeFactorLocked()
	j.EstS = g.estS
	j.TotalS = g.estS * f
	lg.priceLocked(j, lg.ratesLocked())
	e := Estimate{Name: name, Title: j.Title, Materials: j.Materials, Grams: j.Grams, FilCost: j.FilCost, SlicerS: g.estS,
		TotalS: j.TotalS, TimeFactor: f, FactorJobs: n, KWh: j.KWh, EnergyCost: j.EnergyCost, Cost: j.Cost,
		BedC: j.BedC, NozzleC: j.NozzleC, Currency: lg.set.Currency}
	if png != nil {
		e.Thumb = base64.StdEncoding.EncodeToString(png)
	}
	if len(g.mm) == 0 {
		e.Warnings = append(e.Warnings, "no filament lengths in the file; is it sliced gcode?")
	}
	if g.estS == 0 {
		e.Warnings = append(e.Warnings, "no slicer time in the file, so no electricity estimate")
	}
	for _, m := range j.Materials {
		if m.Source != "gcode" {
			e.Warnings = append(e.Warnings, fmt.Sprintf("material type %s guessed from the %s", m.Type, m.Source))
		}
	}
	return e
}
