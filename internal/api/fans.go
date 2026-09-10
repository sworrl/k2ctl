package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/sworrl/k2ctl/internal/profiles"
	"github.com/sworrl/k2ctl/internal/state"
)

// Fan keys as the API exposes them -> store keys (printer naming) and the M106
// P index on the K2: P0 = part/model fan (fan0), P1 = chassis/chamber fan
// (fan1), P2 = auxiliary fan (fan2). Percentages are set with M106 through
// Moonraker (the device socket only has on/off), which is what the stock UI
// ends up doing as well.
var fanKeys = []struct {
	api, store string
	index      int
	label      string
}{
	{"part", "part", 0, "part fan"},
	{"aux", "aux", 2, "auxiliary fan"},
	{"chamber", "case", 1, "chamber fan"},
}

func storeKey(api string) (string, int, bool) {
	for _, f := range fanKeys {
		if f.api == api {
			return f.store, f.index, true
		}
	}
	return "", 0, false
}

// fanCtrl builds the verbose fan view from a snapshot plus the catalog.
func (s *Server) fanCtrl(snap state.Status) state.FanCtrl {
	fan := func(store string) state.Fan {
		pct := snap.Fans[store]
		on, known := snap.FanOn[store]
		if !known {
			on = pct > 0
		}
		if !on && pct > 0 && known {
			// firmware reports the last requested percent even when the fan is off
			pct = 0
		}
		return state.Fan{On: on, Pct: pct}
	}
	return state.FanCtrl{
		Part:        fan("part"),
		Aux:         fan("aux"),
		Chamber:     fan("case"),
		Recommended: s.recommend(snap, ""),
	}
}

// recommend resolves the fan recommendation for the named profile, or for the
// filament currently feeding the extruder (the selected CFS bay, else the
// external spool), falling back to the material type.
func (s *Server) recommend(snap state.Status, profileID string) state.FanRec {
	if profileID != "" {
		if p, ok := s.Catalog.Get(profileID); ok {
			part, aux, ch := p.Recommended()
			return state.FanRec{Part: part, Aux: aux, Chamber: ch, Source: p.Vendor + " " + p.Name}
		}
	}
	var feeding *state.Slot
	var feedingBox *state.Box
	for bi := range snap.CFS.Boxes {
		b := &snap.CFS.Boxes[bi]
		for si := range b.Slots {
			if b.Slots[si].Selected && b.Slots[si].State != 0 {
				feeding, feedingBox = &b.Slots[si], b
			}
		}
	}
	if feeding == nil {
		// nothing selected: the external spool holder if it has a spool
		for bi := range snap.CFS.Boxes {
			b := &snap.CFS.Boxes[bi]
			if b.Type == 1 && len(b.Slots) > 0 && b.Slots[0].State != 0 && b.Slots[0].Type != "" {
				feeding, feedingBox = &b.Slots[0], b
			}
		}
	}
	if feeding == nil {
		part, aux, ch := profiles.RecommendedFans("PLA")
		return state.FanRec{Part: part, Aux: aux, Chamber: ch, Source: "no filament loaded (PLA defaults)"}
	}
	var prof profiles.Profile
	found := false
	if s.Bays != nil {
		if o, ok := s.Bays.Get(feedingBox.ID, feeding.ID); ok && o.Profile != "" {
			prof, found = s.Catalog.Get(o.Profile)
		}
	}
	if !found {
		prof, found = s.Catalog.Find(feeding.Vendor, feeding.Name)
	}
	if found {
		part, aux, ch := prof.Recommended()
		return state.FanRec{Part: part, Aux: aux, Chamber: ch, Source: fmt.Sprintf("%s %s in %s", prof.Vendor, prof.Name, feeding.Label)}
	}
	part, aux, ch := profiles.RecommendedFans(feeding.Type)
	return state.FanRec{Part: part, Aux: aux, Chamber: ch, Source: fmt.Sprintf("%s defaults for %s in %s", strings.ToUpper(feeding.Type), feeding.Name, feeding.Label)}
}

func (s *Server) getFans(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.fanCtrl(s.Store.Snapshot()))
}

type fansReq struct {
	Part      *int  `json:"part"`
	Aux       *int  `json:"aux"`
	Chamber   *int  `json:"chamber"`
	PartOn    *bool `json:"part_on"`
	AuxOn     *bool `json:"aux_on"`
	ChamberOn *bool `json:"chamber_on"`
}

// applyFan sets one fan to pct (0 = off, 100 = full) and records it.
func (s *Server) applyFan(api string, pct int) error {
	store, idx, ok := storeKey(api)
	if !ok {
		return fmt.Errorf("unknown fan %q", api)
	}
	if pct < 0 || pct > 100 {
		return fmt.Errorf("%s: percent must be 0..100", api)
	}
	var err error
	if pct == 0 {
		err = s.Moon.GCode(fmt.Sprintf("M107 P%d", idx))
	} else {
		err = s.Moon.GCode(fmt.Sprintf("M106 P%d S%d", idx, (pct*255+50)/100))
	}
	if err != nil {
		// Moonraker unreachable: the device socket can still switch it fully on/off.
		if e2 := s.CX.SetFanOn(store, pct > 0); e2 != nil {
			return fmt.Errorf("%s: %v (socket fallback: %v)", api, err, e2)
		}
		if pct > 0 {
			pct = 100
		}
	}
	s.Store.Update(func(st *state.Status) {
		st.Fans[store] = pct
		st.FanOn[store] = pct > 0
	})
	return nil
}

func (s *Server) setFans(w http.ResponseWriter, r *http.Request) {
	var req fansReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, err)
		return
	}
	snap := s.Store.Snapshot()
	type change struct {
		key string
		pct int
	}
	var changes []change
	want := func(api string, pct *int, on *bool) {
		if pct != nil {
			changes = append(changes, change{api, *pct})
			return
		}
		if on != nil {
			store, _, _ := storeKey(api)
			if *on {
				// "on" without a percentage restores the last non-zero request, else full
				p := snap.Fans[store]
				if p <= 0 {
					p = 100
				}
				changes = append(changes, change{api, p})
			} else {
				changes = append(changes, change{api, 0})
			}
		}
	}
	want("part", req.Part, req.PartOn)
	want("aux", req.Aux, req.AuxOn)
	want("chamber", req.Chamber, req.ChamberOn)
	if len(changes) == 0 {
		fail(w, 400, fmt.Errorf("body must set part/aux/chamber (percent) or part_on/aux_on/chamber_on"))
		return
	}
	for _, c := range changes {
		if err := s.applyFan(c.key, c.pct); err != nil {
			fail(w, 502, err)
			return
		}
		s.Log.Printf("fans: %s -> %d%%", c.key, c.pct)
	}
	writeJSON(w, 200, s.fanCtrl(s.Store.Snapshot()))
}

func (s *Server) fansRecommended(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Profile string `json:"profile"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	rec := s.recommend(s.Store.Snapshot(), body.Profile)
	if body.Profile != "" && !strings.Contains(rec.Source, " ") {
		fail(w, 404, fmt.Errorf("unknown profile %q", body.Profile))
		return
	}
	for _, c := range []struct {
		key string
		pct int
	}{{"part", rec.Part}, {"aux", rec.Aux}, {"chamber", rec.Chamber}} {
		if err := s.applyFan(c.key, c.pct); err != nil {
			fail(w, 502, err)
			return
		}
	}
	s.Log.Printf("fans: recommended part %d%% aux %d%% chamber %d%% (%s)", rec.Part, rec.Aux, rec.Chamber, rec.Source)
	writeJSON(w, 200, map[string]any{"ok": true, "applied": rec, "fans": s.fanCtrl(s.Store.Snapshot())})
}
