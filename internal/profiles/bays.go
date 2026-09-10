package profiles

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
)

// BayOverride is what k2ctl remembers about a CFS bay beyond the single
// vendor/name/colour record the printer itself keeps: the full colour list of
// a multi-colour spool and the catalog profile it was loaded from.
type BayOverride struct {
	Profile string   `json:"profile,omitempty"`
	Colors  []string `json:"colors,omitempty"`
}

// Bays persists per-bay overrides as a small JSON file next to profiles.json.
type Bays struct {
	path string
	mu   sync.RWMutex
	m    map[string]BayOverride // "box/slot"
}

func LoadBays(path string) *Bays {
	b := &Bays{path: path, m: map[string]BayOverride{}}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &b.m)
	}
	return b
}

func bayKey(box, slot int) string { return fmt.Sprintf("%d/%d", box, slot) }

func (b *Bays) Get(box, slot int) (BayOverride, bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	o, ok := b.m[bayKey(box, slot)]
	return o, ok
}

// Set stores (or, with an empty override, forgets) a bay and writes the file.
func (b *Bays) Set(box, slot int, o BayOverride) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if o.Profile == "" && len(o.Colors) == 0 {
		delete(b.m, bayKey(box, slot))
	} else {
		b.m[bayKey(box, slot)] = o
	}
	data, err := json.MarshalIndent(b.m, "", " ")
	if err != nil {
		return err
	}
	tmp := b.path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, b.path)
}

var hexRe = regexp.MustCompile(`^#?[0-9a-fA-F]{6}$`)

// NormalizeColors validates a multi-colour list: 2..8 entries, #RRGGBB.
func NormalizeColors(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, c := range in {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if !hexRe.MatchString(c) {
			return nil, fmt.Errorf("bad colour %q (want #RRGGBB)", c)
		}
		out = append(out, "#"+strings.ToUpper(strings.TrimPrefix(c, "#")))
	}
	if len(out) < 2 || len(out) > 8 {
		return nil, fmt.Errorf("colors needs 2..8 entries, got %d", len(out))
	}
	return out, nil
}

// MiddleColor is the single colour sent to the printer for a colour list.
func MiddleColor(cs []string) string {
	if len(cs) == 0 {
		return ""
	}
	return cs[len(cs)/2]
}
