# status-badges

A tiny Cloudflare Worker that serves live [shields.io](https://shields.io) badges for the
subscribers.chat infrastructure.

| Route   | Shows                                                        |
| ------- | ------------------------------------------------------------ |
| `/mesh` | WARP Connector mesh — how many nodes are `healthy` (`4/4 online`) |
| `/nats` | NATS servers — how many monitoring `/healthz` endpoints answer OK |

## Setup

```sh
cd status-worker
npm install        # or bun install

# 1. Cloudflare API token (read-only is enough — see permissions below)
npx wrangler secret put CF_API_TOKEN

# 2. Non-secret config — edit wrangler.jsonc:
#    CF_ACCOUNT_ID     = your account id
#    NATS_MONITOR_URLS = ["https://nats-mon.subscribers.chat"]

npx wrangler deploy
```

### Cloudflare API token permissions
Create a **scoped** token at https://dash.cloudflare.com/profile/api-tokens with only:
- **Account › Cloudflare Tunnel › Read**

That's all `/mesh` needs. The token lives as a Worker secret and is never exposed publicly —
the badge URL only hits this Worker, which returns a count.

### Exposing NATS health
The Worker fetches `{base}/healthz` for each URL in `NATS_MONITOR_URLS`. NATS serves this on its
monitoring port (default `8222`). Expose only `/healthz` publicly (e.g. via a Cloudflare Tunnel
hostname) — avoid exposing `/varz`/`/connz`, which leak server config. `/healthz` returns just
`{"status":"ok"}`.

## Use in the README

After deploy (assuming a `status.subscribers.chat` custom domain — see `wrangler.jsonc`):

```markdown
![mesh](https://img.shields.io/endpoint?url=https://status.subscribers.chat/mesh&style=flat-square)
![nats](https://img.shields.io/endpoint?url=https://status.subscribers.chat/nats&style=flat-square)
```

Without a custom domain, use the `*.workers.dev` URL that `wrangler deploy` prints.

## Local dev

```sh
echo 'CF_API_TOKEN="..."' > .dev.vars
npx wrangler dev
# then: curl http://localhost:8787/mesh
```
