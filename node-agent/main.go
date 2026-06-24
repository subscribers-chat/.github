// Command node-agent is the subscribers.chat host agent: one long-running
// process per box that represents that box on NATS.
//
// First slice (this file) does three things and nothing more:
//
//  1. connects to NATS with a per-node credential,
//  2. writes a heartbeat document to the "nodes" JetStream KV bucket on a
//     fixed interval, and
//  3. answers a `node.<id>.ping` request/reply with a small pong.
//
// The bucket carries a TTL of 3× the heartbeat interval, so a node that stops
// heartbeating (crash, network partition, box gone) has its key disappear on
// its own — "what went down" is then just "which keys are missing". Later
// slices layer intrusion alerts, log forwarding, updates and cache on top of
// the same connection; none of that lives here yet.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// agentVersion is reported in every heartbeat so a deploy can watch the KV
// bucket and see which boxes are still on an old agent.
const agentVersion = "0.1.0"

type config struct {
	natsURL   string
	credsFile string
	nodeID    string
	region    string
	bucket    string
	interval  time.Duration
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() (config, error) {
	c := config{
		natsURL:   getenv("NATS_URL", nats.DefaultURL),
		credsFile: os.Getenv("NATS_CREDS"),
		nodeID:    os.Getenv("NODE_ID"),
		region:    os.Getenv("NODE_REGION"),
		bucket:    getenv("NODES_KV_BUCKET", "nodes"),
		interval:  15 * time.Second,
	}

	if c.nodeID == "" {
		h, err := os.Hostname()
		if err != nil {
			return c, fmt.Errorf("NODE_ID is unset and the hostname could not be read: %w", err)
		}
		c.nodeID = h
	}

	if v := os.Getenv("HEARTBEAT_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return c, fmt.Errorf("HEARTBEAT_INTERVAL %q is not a valid duration: %w", v, err)
		}
		if d < time.Second {
			return c, fmt.Errorf("HEARTBEAT_INTERVAL %s is too small; use >= 1s", d)
		}
		c.interval = d
	}

	return c, nil
}

// nodeKey turns a node id into a value safe for use as both a KV key and a
// single subject token: anything outside [A-Za-z0-9_-] becomes '-'. Two boxes
// whose ids only differ by punctuation would collide, so prefer simple slugs
// like "jp1" / "au2" for NODE_ID.
func nodeKey(id string) string {
	var b strings.Builder
	b.Grow(len(id))
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// heartbeat is the document written to nodes/<key> on every tick. Keep it
// small — it is rewritten constantly and read by dashboards.
type heartbeat struct {
	NodeID       string    `json:"node_id"`
	Region       string    `json:"region,omitempty"`
	Hostname     string    `json:"hostname"`
	Status       string    `json:"status"` // always "up" while the agent is alive
	AgentVersion string    `json:"agent_version"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	StartedAt    time.Time `json:"started_at"`
	Timestamp    time.Time `json:"timestamp"`
	UptimeSec    int64     `json:"uptime_sec"`
}

type pong struct {
	NodeID       string    `json:"node_id"`
	AgentVersion string    `json:"agent_version"`
	Timestamp    time.Time `json:"timestamp"`
}

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(logger); err != nil {
		logger.Error("node-agent exited with error", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	key := nodeKey(cfg.nodeID)
	hostname, _ := os.Hostname()
	startedAt := time.Now().UTC()

	logger = logger.With("node_id", cfg.nodeID, "key", key, "region", cfg.region)
	logger.Info("starting node-agent",
		"version", agentVersion, "nats", cfg.natsURL,
		"bucket", cfg.bucket, "interval", cfg.interval.String())

	// Stop on SIGINT/SIGTERM so systemd can restart us cleanly.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	opts := []nats.Option{
		nats.Name("node-agent/" + key),
		nats.MaxReconnects(-1), // never give up; a box should reconnect forever
		nats.ReconnectWait(2 * time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			logger.Warn("nats disconnected", "err", err)
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			logger.Info("nats reconnected", "url", nc.ConnectedUrl())
		}),
	}
	if cfg.credsFile != "" {
		opts = append(opts, nats.UserCredentials(cfg.credsFile))
	} else {
		logger.Warn("NATS_CREDS is unset — connecting without a per-node credential")
	}

	nc, err := nats.Connect(cfg.natsURL, opts...)
	if err != nil {
		return fmt.Errorf("connect to nats: %w", err)
	}
	defer nc.Drain()

	js, err := jetstream.New(nc)
	if err != nil {
		return fmt.Errorf("jetstream context: %w", err)
	}

	// A node that stops writing should fall out of the bucket on its own, so a
	// missing key == a down box. TTL is bucket-wide; living nodes refresh well
	// inside it.
	kv, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:      cfg.bucket,
		Description: "Per-node heartbeat / status for subscribers.chat host agents",
		History:     3,
		TTL:         3 * cfg.interval,
		Storage:     jetstream.FileStorage,
	})
	if err != nil {
		return fmt.Errorf("open kv bucket %q: %w", cfg.bucket, err)
	}

	// Answer health pings: `node.<key>.ping` -> small pong.
	pingSubject := fmt.Sprintf("node.%s.ping", key)
	sub, err := nc.Subscribe(pingSubject, func(m *nats.Msg) {
		body, _ := json.Marshal(pong{
			NodeID:       cfg.nodeID,
			AgentVersion: agentVersion,
			Timestamp:    time.Now().UTC(),
		})
		if err := m.Respond(body); err != nil {
			logger.Warn("failed to respond to ping", "err", err)
		}
	})
	if err != nil {
		return fmt.Errorf("subscribe %s: %w", pingSubject, err)
	}
	defer sub.Unsubscribe()
	logger.Info("listening for pings", "subject", pingSubject)

	emit := func() {
		hb := heartbeat{
			NodeID:       cfg.nodeID,
			Region:       cfg.region,
			Hostname:     hostname,
			Status:       "up",
			AgentVersion: agentVersion,
			OS:           runtime.GOOS,
			Arch:         runtime.GOARCH,
			StartedAt:    startedAt,
			Timestamp:    time.Now().UTC(),
			UptimeSec:    int64(time.Since(startedAt).Seconds()),
		}
		body, err := json.Marshal(hb)
		if err != nil {
			logger.Error("marshal heartbeat", "err", err)
			return
		}
		if _, err := kv.Put(ctx, key, body); err != nil {
			// Don't exit: a transient NATS blip shouldn't kill the agent.
			logger.Warn("heartbeat put failed", "err", err)
			return
		}
		logger.Debug("heartbeat written", "uptime_sec", hb.UptimeSec)
	}

	emit() // write one immediately so the box appears without waiting a full tick

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			logger.Info("shutdown requested, draining")
			// Best-effort: mark ourselves down so dashboards update instantly
			// instead of waiting for the TTL to expire.
			if err := markDown(kv, key, cfg, hostname, startedAt); err != nil &&
				!errors.Is(err, context.Canceled) {
				logger.Warn("could not write final down status", "err", err)
			}
			return nil
		case <-ticker.C:
			emit()
		}
	}
}

// markDown writes a final status="down" heartbeat on graceful shutdown using a
// fresh, short-lived context (the main ctx is already cancelled by then).
func markDown(kv jetstream.KeyValue, key string, cfg config, hostname string, startedAt time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	body, err := json.Marshal(heartbeat{
		NodeID:       cfg.nodeID,
		Region:       cfg.region,
		Hostname:     hostname,
		Status:       "down",
		AgentVersion: agentVersion,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		StartedAt:    startedAt,
		Timestamp:    time.Now().UTC(),
		UptimeSec:    int64(time.Since(startedAt).Seconds()),
	})
	if err != nil {
		return err
	}
	_, err = kv.Put(ctx, key, body)
	return err
}
