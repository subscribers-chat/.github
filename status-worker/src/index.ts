/**
 * status-badges — a tiny Cloudflare Worker that exposes shields.io-compatible
 * JSON endpoints for the subscribers.chat infrastructure.
 *
 *   GET /mesh   → WARP Connector mesh: how many nodes are healthy
 *   GET /nats   → NATS servers: how many monitoring /healthz endpoints are up
 *   GET /        → list of routes
 *
 * Each badge route returns the shields "endpoint" schema, so the README uses:
 *   ![mesh](https://img.shields.io/endpoint?url=https://status.subscribers.chat/mesh)
 */

interface Env {
  /** Scoped Cloudflare API token. Set as a secret: `wrangler secret put CF_API_TOKEN` */
  CF_API_TOKEN: string;
  /** Cloudflare account ID that owns the WARP Connectors. */
  CF_ACCOUNT_ID: string;
  /** JSON array of NATS public WebSocket gateway hostnames, e.g. ["ph-starlink.subscribers.chat"]. */
  NATS_WS_HOSTS: string;
  /** Optional JSON array of tunnel names to count. Empty/unset = all tunnels. */
  MESH_TUNNELS?: string;
}

interface ShieldsBadge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  isError?: boolean;
}

function badge(body: ShieldsBadge): Response {
  return Response.json(body, {
    headers: {
      // shields caches on its side; this keeps us from hammering the CF API.
      "cache-control": "public, max-age=60, s-maxage=60",
      "access-control-allow-origin": "*",
    },
  });
}

function colorFor(up: number, total: number): string {
  if (total === 0) return "lightgrey";
  if (up === total) return "brightgreen";
  if (up === 0) return "red";
  return "orange";
}

/** Count WARP Connectors and how many are healthy. */
async function meshBadge(env: Env): Promise<Response> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    return badge({ schemaVersion: 1, label: "mesh", message: "not configured", color: "lightgrey", isError: true });
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=100`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } });

  if (!res.ok) {
    return badge({ schemaVersion: 1, label: "mesh", message: "api error", color: "red", isError: true });
  }

  const data = (await res.json()) as { result?: Array<{ name?: string; tun_type?: string; status?: string }> };

  // Optional allowlist of tunnel names (e.g. to exclude a dev laptop). Empty = all.
  let allow: string[] = [];
  try {
    allow = JSON.parse(env.MESH_TUNNELS || "[]");
  } catch {
    allow = [];
  }

  const tunnels = (data.result ?? [])
    .filter((t) => t.tun_type === "cfd_tunnel")
    .filter((t) => allow.length === 0 || allow.includes(t.name ?? ""));
  const total = tunnels.length;
  const up = tunnels.filter((t) => t.status === "healthy").length;

  return badge({ schemaVersion: 1, label: "mesh", message: `${up}/${total} online`, color: colorFor(up, total) });
}

/**
 * Probe a NATS WebSocket gateway. NATS sends an `INFO {...}` protocol frame the
 * instant a connection opens — before any auth — so receiving any frame proves
 * the server is alive. Returns true if we get one within the timeout.
 */
async function probeNats(host: string): Promise<boolean> {
  const url = `https://${host.replace(/^https?:\/\//, "").replace(/\/$/, "")}/`;
  try {
    const res = await fetch(url, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) return false;
    ws.accept();

    return await new Promise<boolean>((resolve) => {
      const done = (up: boolean) => {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve(up);
      };
      const timer = setTimeout(() => done(false), 5000);
      ws.addEventListener("message", () => {
        clearTimeout(timer);
        done(true); // any frame = server spoke (the NATS INFO line)
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve(false);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

/** Probe each NATS gateway over WebSocket and report how many are alive. */
async function natsBadge(env: Env): Promise<Response> {
  let hosts: string[] = [];
  try {
    hosts = JSON.parse(env.NATS_WS_HOSTS || "[]");
  } catch {
    return badge({ schemaVersion: 1, label: "nats", message: "bad config", color: "red", isError: true });
  }

  if (hosts.length === 0) {
    return badge({ schemaVersion: 1, label: "nats", message: "not configured", color: "lightgrey", isError: true });
  }

  const checks = await Promise.all(hosts.map(probeNats));
  const total = checks.length;
  const up = checks.filter(Boolean).length;

  return badge({ schemaVersion: 1, label: "nats", message: `${up}/${total} up`, color: colorFor(up, total) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    switch (pathname) {
      case "/mesh":
        return meshBadge(env);
      case "/nats":
        return natsBadge(env);
      case "/":
        return Response.json({ routes: ["/mesh", "/nats"] });
      default:
        return new Response("not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
