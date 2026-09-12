package moonraker

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Motion is one live toolhead sample from Klipper's motion_report: the interpolated
// position at eventtime T (Klipper's clock, seconds) received at At (k2ctl's clock),
// plus the scalar feed speed in mm/s.
type Motion struct {
	T  float64   `json:"t"`
	At time.Time `json:"at"`
	X  float64   `json:"x"`
	Y  float64   `json:"y"`
	Z  float64   `json:"z"`
	V  float64   `json:"v"`
}

const motionKeep = 12

// motion holds the ring of recent samples; filled by RunMotion.
type motion struct {
	mu   sync.Mutex
	ring []Motion
}

// Motion returns the recent samples, oldest first.
func (c *Client) Motion() []Motion {
	c.motion.mu.Lock()
	defer c.motion.mu.Unlock()
	return append([]Motion(nil), c.motion.ring...)
}

func (c *Client) pushMotion(m Motion) {
	c.motion.mu.Lock()
	c.motion.ring = append(c.motion.ring, m)
	if len(c.motion.ring) > motionKeep {
		c.motion.ring = c.motion.ring[len(c.motion.ring)-motionKeep:]
	}
	c.motion.mu.Unlock()
}

// RunMotion keeps a Moonraker WebSocket subscription to motion_report open so the
// toolhead position arrives as Klipper pushes it (up to 4 Hz) instead of by polling,
// which costs a quarter second per request on the printer. Reconnects until ctx ends.
func (c *Client) RunMotion(ctx context.Context) {
	wsURL := strings.Replace(strings.Replace(c.base, "https://", "wss://", 1), "http://", "ws://", 1) + "/websocket"
	backoff := time.Second
	for ctx.Err() == nil {
		if err := c.motionSession(ctx, wsURL); err != nil && ctx.Err() == nil {
			c.log.Printf("moonraker motion: %v (retry in %s)", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 15*time.Second {
			backoff *= 2
		}
	}
}

func (c *Client) motionSession(ctx context.Context, wsURL string) error {
	d := websocket.Dialer{HandshakeTimeout: 8 * time.Second}
	conn, _, err := d.DialContext(ctx, wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() { <-ctx.Done(); conn.Close() }()
	sub := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "printer.objects.subscribe",
		"params": map[string]any{"objects": map[string]any{"motion_report": []string{"live_position", "live_velocity"}}}}
	if err := conn.WriteJSON(sub); err != nil {
		return err
	}
	for {
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		var msg struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if err := conn.ReadJSON(&msg); err != nil {
			return err
		}
		var status map[string]any
		var eventtime float64
		switch {
		case msg.Method == "notify_status_update":
			var p []json.RawMessage
			if json.Unmarshal(msg.Params, &p) != nil || len(p) < 2 {
				continue
			}
			_ = json.Unmarshal(p[0], &status)
			_ = json.Unmarshal(p[1], &eventtime)
		case msg.Result != nil:
			var r struct {
				Status    map[string]any `json:"status"`
				Eventtime float64        `json:"eventtime"`
			}
			_ = json.Unmarshal(msg.Result, &r)
			status, eventtime = r.Status, r.Eventtime
		default:
			continue
		}
		mr, ok := status["motion_report"].(map[string]any)
		if !ok {
			continue
		}
		c.motion.mu.Lock()
		var last *Motion
		if n := len(c.motion.ring); n > 0 {
			last = &c.motion.ring[n-1]
		}
		m := Motion{T: eventtime, At: time.Now()}
		if last != nil {
			m.X, m.Y, m.Z, m.V = last.X, last.Y, last.Z, last.V
		}
		c.motion.mu.Unlock()
		if lp, ok := mr["live_position"].([]any); ok && len(lp) >= 3 {
			m.X, m.Y, m.Z = num(lp[0]), num(lp[1]), num(lp[2])
		}
		if v, ok := mr["live_velocity"].(float64); ok {
			m.V = v
		}
		c.pushMotion(m)
	}
}
