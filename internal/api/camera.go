package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// cameraSignalURL is the printer's WebRTC signaling endpoint (video service on :8000).
// It is derived from the Moonraker host so the same binary works on the printer
// (127.0.0.1) and on a desktop pointed at the printer.
func (s *Server) cameraSignalURL() string {
	host := "127.0.0.1"
	if s.Moon != nil {
		if u, err := url.Parse(s.Moon.Base()); err == nil && u.Hostname() != "" {
			host = u.Hostname()
		}
	}
	return "http://" + net.JoinHostPort(host, "8000") + "/call/webrtc_local"
}

// cameraOffer relays a complete (non-trickle) WebRTC offer to the printer and returns
// its answer. Wire format, as used by Creality Print's device page: the body is the
// base64 of a JSON {"type":"offer","sdp":...} sent as text/plain; the reply is the
// base64 of a JSON {"type":"answer","sdp":...}. The printer only offers H.264.
func (s *Server) cameraOffer(w http.ResponseWriter, r *http.Request) {
	var offer struct {
		Type string `json:"type"`
		SDP  string `json:"sdp"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 256<<10)).Decode(&offer); err != nil || offer.SDP == "" {
		fail(w, 400, fmt.Errorf("body must be a JSON offer with sdp"))
		return
	}
	if offer.Type == "" {
		offer.Type = "offer"
	}
	// Browsers hide host candidates behind mDNS names (xxxx.local) unless the page has
	// camera/mic permission. The printer's stack cannot resolve those, never learns a
	// usable remote candidate, and DTLS stalls. We know where the request came from, so
	// swap the mDNS names for the client's LAN address.
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && host != "" {
		offer.SDP = rewriteMDNSCandidates(offer.SDP, host)
	}
	raw, _ := json.Marshal(offer)
	body := base64.StdEncoding.EncodeToString(raw)
	hc := &http.Client{Timeout: 8 * time.Second}
	resp, err := hc.Post(s.cameraSignalURL(), "text/plain", bytes.NewBufferString(body))
	if err != nil {
		fail(w, 502, fmt.Errorf("camera signaling: %w", err))
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	dec, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(b)))
	if err != nil || len(dec) == 0 {
		fail(w, 502, fmt.Errorf("camera signaling: unexpected reply %q", truncate(string(b), 120)))
		return
	}
	var answer map[string]any
	if err := json.Unmarshal(dec, &answer); err != nil || answer["sdp"] == nil {
		fail(w, 502, fmt.Errorf("camera signaling: no answer in reply"))
		return
	}
	writeJSON(w, 200, answer)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// rewriteMDNSCandidates replaces ".local" candidate addresses in an SDP with ip.
func rewriteMDNSCandidates(sdp, ip string) string {
	lines := strings.Split(sdp, "\n")
	for i, l := range lines {
		if !strings.HasPrefix(l, "a=candidate:") {
			continue
		}
		f := strings.Fields(l)
		// a=candidate:<foundation> <component> <proto> <priority> <address> <port> typ ...
		if len(f) >= 6 && strings.HasSuffix(strings.ToLower(f[4]), ".local") {
			f[4] = ip
			lines[i] = strings.Join(f, " ")
			if strings.HasSuffix(l, "\r") {
				lines[i] += "\r"
			}
		}
	}
	return strings.Join(lines, "\n")
}
