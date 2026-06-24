# node-agent

The subscribers.chat **host agent** — one long-running process per box that
represents that box on NATS. Its eventual job is everything a box needs a local
brain for: health, automatic updates, cache, intrusion alerting, log
forwarding. This is **slice 1**, which is deliberately just the heartbeat so the
identity + JetStream KV + pub/sub plumbing is proven end-to-end before anything
is layered on.

## What it does today

1. Connects to NATS with a **per-node credential** (`NATS_CREDS`).
2. Writes a heartbeat document to the `nodes` JetStream **KV bucket**, key =
   node id, every `HEARTBEAT_INTERVAL` (default 15s).
3. Answers `node.<id>.ping` request/reply with a small pong.

The bucket is created with a TTL of **3× the interval**. A box that stops
heartbeating (crash, partition, gone) has its key expire on its own — so
*"what went down"* is simply *"which keys are missing"*, and a recovered box
re-appears the moment its agent reconnects.

### Heartbeat document

```json
{
  "node_id": "jp1",
  "region": "japan",
  "hostname": "contabo-jp-1",
  "status": "up",
  "agent_version": "0.1.0",
  "os": "linux",
  "arch": "amd64",
  "started_at": "2026-06-25T01:00:00Z",
  "timestamp": "2026-06-25T01:03:15Z",
  "uptime_sec": 195
}
```

## Identity model

Each box gets its **own** credential, scoped to only its own node subjects
(`node.<id>.>`) plus write access to the `nodes` KV. This is intentional: the
agent's job includes *"alert me if someone is inside this server"*, so it is a
distinct security principal per box — a leaked credential compromises one box,
not the fleet. **Never share one credential across boxes.**

Email/alerting is **not** handled by the agent and never will be: agents
publish alert events; a single central `notify-service` owns the SMTP
credential and sends. A box you're trying to defend should not also hold the
org's email password.

## Configuration

All via environment (see `deploy/node-agent.env.example`):

| Var | Default | Notes |
|-----|---------|-------|
| `NATS_URL` | `nats://127.0.0.1:4222` | region-local server; `tls://` or `wss://` |
| `NATS_CREDS` | — | per-node `.creds` file; warns if unset |
| `NODE_ID` | hostname | stable slug, `[A-Za-z0-9_-]` (`jp1`, `au2`) |
| `NODE_REGION` | — | label only |
| `NODES_KV_BUCKET` | `nodes` | KV bucket name |
| `HEARTBEAT_INTERVAL` | `15s` | any Go duration ≥ `1s` |

## Build & run

```bash
make build                 # -> bin/node-agent (host)
make linux                 # -> dist/node-agent-linux-{amd64,arm64}, static
NATS_URL=tls://… NATS_CREDS=./node.creds NODE_ID=jp1 make run
```

## Deploy (systemd)

```bash
install -m755 dist/node-agent-linux-amd64 /usr/local/bin/node-agent
mkdir -p /etc/node-agent
cp deploy/node-agent.env.example /etc/node-agent/node-agent.env   # then edit
# drop this node's credential at /etc/node-agent/node.creds
cp deploy/node-agent.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now node-agent
```

## Verify

```bash
# watch heartbeats land
nats --server "$NATS_URL" --creds admin.creds kv watch nodes

# ping a specific box
nats --server "$NATS_URL" --creds admin.creds req node.jp1.ping ''
```

## Roadmap

- [x] **Slice 1** — heartbeat to `nodes` KV + `node.<id>.ping`
- [ ] Intrusion events → central `notify-service` → email
- [ ] `system` KV bucket (desktop/sidecar/agent versions)
- [ ] Control plane: `node.<id>.cmd.update`, cache flush
- [ ] Log forwarding
- [ ] Issue per-node credentials via auth-callout instead of static `.creds`
