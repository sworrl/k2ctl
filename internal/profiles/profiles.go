// Package profiles is the filament catalog: the user's custom (third-party)
// filament profiles plus Creality's own, in the shape the CFS material record
// needs. It is a plain JSON file so it can be edited by hand or regenerated
// from the slicer preset generator.
package profiles

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
)

type Profile struct {
	ID       string  `json:"id"`
	Vendor   string  `json:"vendor"`
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	MinTemp  int     `json:"min_temp"`
	MaxTemp  int     `json:"max_temp"`
	Pressure float64 `json:"pressure"`
	RFID     string  `json:"rfid,omitempty"` // Creality material id when the printer knows one
	Color    string  `json:"color,omitempty"`
	// Colors is set for multi-color spools (rainbow, dual-color...): 2..8
	// hex colors ordered along the spool. The printer only stores one color
	// per bay, so the middle entry is what gets written there.
	Colors       []string `json:"colors,omitempty"`
	Density      float64  `json:"density,omitempty"`
	Notes        string   `json:"notes,omitempty"`
	SlicerPreset string   `json:"slicer_preset,omitempty"`
	// Fans carries the slicer preset's cooling numbers (percent) when known.
	Fans *FanRec `json:"fans,omitempty"`
	// CFS says whether the material may be fed from a CFS bay at all (flexible
	// filament, wet PVA/BVOH and the like must go on the external holder).
	CFS *CFSRule `json:"cfs,omitempty"`
	// Warnings are short user-facing cautions (abrasive, dry first, slow...).
	Warnings []string `json:"warnings,omitempty"`
	// Dry is the manufacturer's drying recommendation when published.
	Dry *DryRec `json:"dry,omitempty"`
}

// CFSRule is the CFS feed-compatibility verdict for a profile.
type CFSRule struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
}

// DryRec is a drying recommendation: temperature in °C and duration in hours.
type DryRec struct {
	TempC int `json:"temp_c"`
	Hours int `json:"hours"`
}

// CFSOK reports whether the profile may be loaded into a CFS bay. Profiles
// without an explicit rule are judged by material type: flexible filaments
// (TPU/TPE/flex) are refused, everything else is allowed.
func (p Profile) CFSOK() (bool, string) {
	if p.CFS != nil {
		return p.CFS.OK, p.CFS.Reason
	}
	t := strings.ToUpper(p.Type + " " + p.Name)
	if strings.Contains(t, "TPU") || strings.Contains(t, "TPE") || strings.Contains(t, "FLEX") {
		return false, "flexible filament bends in the CFS tubes and jams feeding/unloading; load it on the external spool holder"
	}
	return true, ""
}

// FanRec mirrors the Creality Print filament preset cooling keys:
// fan_min_speed/fan_max_speed (part fan), additional_cooling_fan_speed (aux)
// and during_print_exhaust_fan_speed (chamber/case fan).
type FanRec struct {
	PartMin int `json:"part_min"`
	PartMax int `json:"part_max"`
	Aux     int `json:"aux"`
	Exhaust int `json:"exhaust"`
}

// RecommendedFans returns the part/aux/chamber percentages to run for a
// material when a profile has no explicit numbers: the same defaults the
// Creality presets use for that material class.
func RecommendedFans(material string) (part, aux, chamber int) {
	m := strings.ToUpper(strings.TrimSpace(material))
	switch {
	case m == "":
		return 50, 0, 0
	case strings.HasPrefix(m, "PLA"):
		return 100, 70, 0
	case strings.HasPrefix(m, "PETG"), strings.HasPrefix(m, "PET"), strings.HasPrefix(m, "PCTG"):
		return 60, 40, 0
	case strings.HasPrefix(m, "ABS"), strings.HasPrefix(m, "ASA"), strings.HasPrefix(m, "HIPS"):
		return 20, 0, 0
	case strings.HasPrefix(m, "PC"), strings.HasPrefix(m, "PA"), strings.HasPrefix(m, "PPA"), strings.HasPrefix(m, "PPS"), strings.HasPrefix(m, "NYLON"):
		return 15, 0, 0
	case strings.HasPrefix(m, "TPU"), strings.HasPrefix(m, "TPE"):
		return 100, 50, 0
	}
	return 50, 0, 0
}

// Recommended resolves a profile's fan numbers, falling back by material type.
func (p Profile) Recommended() (part, aux, chamber int) {
	if p.Fans != nil && (p.Fans.PartMax > 0 || p.Fans.Aux > 0 || p.Fans.Exhaust > 0) {
		return clampPct(p.Fans.PartMax), clampPct(p.Fans.Aux), clampPct(p.Fans.Exhaust)
	}
	return RecommendedFans(p.Type)
}

func clampPct(v int) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// Find looks a profile up by vendor and name, case-insensitively.
func (c *Catalog) Find(vendor, name string) (Profile, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, p := range c.list {
		if strings.EqualFold(p.Vendor, vendor) && strings.EqualFold(p.Name, name) {
			return p, true
		}
	}
	return Profile{}, false
}

type Catalog struct {
	path string
	mu   sync.RWMutex
	list []Profile
}

func Load(path string) (*Catalog, error) {
	c := &Catalog{path: path}
	if err := c.Reload(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Catalog) Reload() error {
	data, err := os.ReadFile(c.path)
	if err != nil {
		return err
	}
	var list []Profile
	if err := json.Unmarshal(data, &list); err != nil {
		return fmt.Errorf("%s: %w", c.path, err)
	}
	for i := range list {
		if list[i].ID == "" {
			list[i].ID = Slug(list[i].Vendor + " " + list[i].Name)
		}
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Vendor != list[j].Vendor {
			return list[i].Vendor < list[j].Vendor
		}
		return list[i].Name < list[j].Name
	})
	c.mu.Lock()
	c.list = list
	c.mu.Unlock()
	return nil
}

func (c *Catalog) All() []Profile {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return append([]Profile(nil), c.list...)
}

func (c *Catalog) Get(id string) (Profile, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	for _, p := range c.list {
		if p.ID == id {
			return p, true
		}
	}
	return Profile{}, false
}

func Slug(s string) string {
	var b strings.Builder
	last := '-'
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			last = r
		case r == '+':
			b.WriteString("plus")
			last = 's'
		default:
			if last != '-' {
				b.WriteRune('-')
				last = '-'
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
