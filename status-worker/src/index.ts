/**
 * status-badges — a tiny Cloudflare Worker that exposes shields.io-compatible
 * JSON endpoints for the subscribers.chat infrastructure.
 *
 *   GET /mesh      → WARP Connector mesh: how many nodes are healthy
 *   GET /nats      → NATS servers: how many wss gateways are up
 *   GET /endpoints → the regional NATS endpoint registry (single source of truth)
 *   GET /          → list of routes
 *
 * Each badge route returns the shields "endpoint" schema, so the README uses:
 *   ![mesh](https://img.shields.io/endpoint?url=https://status.subscribers.chat/mesh)
 */

interface Env {
  /** Scoped Cloudflare API token. Set as a secret: `wrangler secret put CF_API_TOKEN` */
  CF_API_TOKEN: string;
  /** Cloudflare account ID that owns the WARP Connectors. */
  CF_ACCOUNT_ID: string;
  /** JSON array of NATS public WebSocket gateway hostnames, e.g. ["ph-starlink.subscribers.chat"]. Fallback only — NATS_REGIONS is preferred. */
  NATS_WS_HOSTS: string;
  /** Optional pin: JSON array of region names. Leave EMPTY to auto-discover from tunnels. */
  NATS_REGIONS?: string;
  /** The tunnel-origin port that identifies a NATS websocket route (default "8443"). */
  NATS_WS_PORT?: string;
  /** Optional JSON array of tunnel names to count. Empty/unset = all tunnels. */
  MESH_TUNNELS?: string;
  /** Jenkins base URL, e.g. https://jenkins.subscribers.chat */
  JENKINS_URL?: string;
  /** Nexus base URL, e.g. https://nexus.subscribers.chat */
  NEXUS_URL?: string;
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
  // Prefer the single source of truth (NATS_REGIONS → wss-<region>); fall back to NATS_WS_HOSTS.
  let hosts: string[] = [];
  const regions = await discoverRegions(env);
  if (regions.length) {
    hosts = regions.map((r) => `wss-${r}.subscribers.chat`);
  } else {
    try {
      hosts = JSON.parse(env.NATS_WS_HOSTS || "[]");
    } catch {
      return badge({ schemaVersion: 1, label: "nats", message: "bad config", color: "red", isError: true });
    }
  }

  if (hosts.length === 0) {
    return badge({ schemaVersion: 1, label: "nats", message: "not configured", color: "lightgrey", isError: true });
  }

  const checks = await Promise.all(hosts.map(probeNats));
  const total = checks.length;
  const up = checks.filter(Boolean).length;

  return badge({ schemaVersion: 1, label: "nats", message: `${up}/${total} up`, color: colorFor(up, total) });
}

/** GET an HTTP health path; "up" if it answers OK. */
async function httpBadge(label: string, base: string | undefined, path: string): Promise<Response> {
  if (!base) {
    return badge({ schemaVersion: 1, label, message: "not configured", color: "lightgrey", isError: true });
  }
  let ok = false;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(8000) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  return badge({ schemaVersion: 1, label, message: ok ? "up" : "down", color: ok ? "brightgreen" : "red" });
}

// ── Endpoint registry: the single source of truth for regional NATS endpoints ──
// Region list lives in NATS_REGIONS (one place). URLs are derived by convention:
//   nats     client / service-to-service   nats://nats-<region>.subscribers.chat:4222  (grey A → box IP)
//   wss      browser websocket             wss://wss-<region>.subscribers.chat          (tunnel, edge TLS)
//   gateway  region↔region backbone        nats-<region>.subscribers.chat:7222
//   leaf     leaf-node hub                 nats-<region>.subscribers.chat:7422
const PLANES = ["nats", "wss", "gateway", "leaf"] as const;
type Plane = (typeof PLANES)[number];

function regionsOf(env: Env): string[] {
  try {
    const r = JSON.parse(env.NATS_REGIONS || "[]");
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

const NATS_WS_PORT_DEFAULT = "8443";

async function cfGet<T>(env: Env, path: string): Promise<T | null> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/**
 * Discover NATS regions dynamically — no hardcoded list. Lists every Cloudflare
 * tunnel, scans each tunnel's ingress for routes pointing at the NATS websocket
 * port (NATS_WS_PORT, default 8443), and pulls the region out of the hostname.
 * Add a `wss-<region>` (or `nats-<region>`) → :8443 route and it just appears.
 * An explicit NATS_REGIONS pin, if set, overrides discovery.
 */
async function discoverRegions(env: Env): Promise<string[]> {
  const pinned = regionsOf(env);
  if (pinned.length) return pinned;

  const port = env.NATS_WS_PORT || NATS_WS_PORT_DEFAULT;
  const tun = await cfGet<{ result?: Array<{ id: string; tun_type?: string }> }>(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=100`,
  );
  const tunnels = (tun?.result ?? []).filter((t) => t.tun_type === "cfd_tunnel");

  const configs = await Promise.all(
    tunnels.map((t) =>
      cfGet<{ result?: { config?: { ingress?: Array<{ hostname?: string; service?: string }> } } }>(
        env,
        `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${t.id}/configurations`,
      ),
    ),
  );

  const regions = new Set<string>();
  for (const c of configs) {
    for (const rule of c?.result?.config?.ingress ?? []) {
      if (!rule.hostname || !rule.service?.includes(`:${port}`)) continue; // not the NATS port → skip
      const m = rule.hostname.match(/^(?:wss|nats)-(.+)\.subscribers\.chat$/);
      if (m) regions.add(m[1]);
    }
  }
  return [...regions].sort();
}

function docsBody(regions: string[], env: Env) {
  const wsPort = env.NATS_WS_PORT || NATS_WS_PORT_DEFAULT;
  return {
    service: "subscribers.chat NATS endpoint registry",
    source: regionsOf(env).length
      ? "pinned via NATS_REGIONS"
      : "discovered dynamically from Cloudflare tunnels (no hardcoded region list)",
    port_conventions: {
      "4222": "nats client / service-to-service — nats://nats-<region>.subscribers.chat:4222 (grey-cloud A → box IP)",
      "7222": "gateway backbone (region↔region)",
      "7422": "leaf-node hub",
      [wsPort]: "NATS websocket origin → wss://wss-<region>.subscribers.chat (this port identifies a NATS tunnel route)",
    },
    routes: [
      { path: "/endpoints", desc: "full registry — all regions × all planes" },
      { path: "/endpoints/nats", desc: "nats client URLs per region + joined seed string" },
      { path: "/endpoints/wss", desc: "browser wss URLs per region" },
      { path: "/endpoints/gateway", desc: "gateway host:port per region" },
      { path: "/endpoints/leaf", desc: "leaf host:port per region" },
      { path: "/endpoints/{plane}/{region}", desc: "a single value, e.g. /endpoints/nats/japan" },
      { path: "/endpoints/{region}", desc: "all planes for one region" },
      { path: "/endpoints/docs", desc: "this document" },
    ],
    regions_discovered: regions,
  };
}

/** Human-readable docs page (HTML) at /docs. */
async function docsHtml(env: Env): Promise<Response> {
  const regions = await discoverRegions(env);
  const wsPort = env.NATS_WS_PORT || NATS_WS_PORT_DEFAULT;
  const row = (a: string, b: string) => `<tr><td><code>${a}</code></td><td>${b}</td></tr>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>subscribers.chat — NATS endpoint registry</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;color:#222}
 h1{font-size:1.5rem} h2{font-size:1.05rem;margin-top:2rem;border-bottom:1px solid #eee;padding-bottom:.3rem}
 table{border-collapse:collapse;width:100%;margin:.5rem 0} td,th{border:1px solid #e3e3e3;padding:.4rem .6rem;text-align:left;vertical-align:top}
 code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px} a{color:#0857a6}
 .pill{display:inline-block;background:#eef;border-radius:999px;padding:.1rem .6rem;margin:.1rem}
</style></head><body>
<h1>NATS endpoint registry</h1>
<p>Single source of truth for subscribers.chat regional NATS endpoints. Regions are
<strong>discovered dynamically</strong> from Cloudflare tunnels (routes pointing at port
<code>${wsPort}</code>) — nothing hardcoded. Two hostname families per region:</p>
<ul>
 <li><code>nats-&lt;region&gt;.subscribers.chat</code> — native NATS, raw TCP: client <code>:4222</code>, gateway <code>:7222</code>, leaf <code>:7422</code> (grey-cloud A &rarr; box IP)</li>
 <li><code>wss-&lt;region&gt;.subscribers.chat</code> — browser WebSocket (<code>wss://</code> on 443, via tunnel)</li>
</ul>
<h2>Regions live now</h2>
<p>${regions.length ? regions.map((r) => `<span class="pill">${r}</span>`).join("") : "<em>none discovered</em>"}</p>
<h2>Routes</h2>
<table><tr><th>Path</th><th>Returns</th></tr>
${row("/endpoints", "full registry — all regions × all planes")}
${row("/endpoints/nats", "nats client URLs per region + <code>joined</code> seed string")}
${row("/endpoints/wss", "browser wss URLs per region")}
${row("/endpoints/gateway", "gateway host:port per region")}
${row("/endpoints/leaf", "leaf host:port per region")}
${row("/endpoints/{plane}/{region}", 'a single value, e.g. <a href="/endpoints/nats/japan">/endpoints/nats/japan</a>')}
${row("/endpoints/{region}", "all planes for one region")}
${row("/endpoints/docs", "machine-readable (JSON) version of this page")}
</table>
<h2>Port conventions</h2>
<table><tr><th>Port</th><th>Plane</th></tr>
${row("4222", "nats client / service-to-service")}
${row("7222", "gateway backbone (region↔region)")}
${row("7422", "leaf-node hub")}
${row(wsPort, "NATS websocket origin &rarr; wss://wss-&lt;region&gt; (identifies a NATS tunnel route)")}
</table>
<h2>Try it</h2>
<p><a href="/endpoints">/endpoints</a> &middot; <a href="/endpoints/nats">/endpoints/nats</a> &middot;
<a href="/endpoints/wss">/endpoints/wss</a> &middot; <a href="/endpoints/docs">/endpoints/docs</a></p>
</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

function planeValue(region: string, plane: Plane): string {
  const host = `nats-${region}.subscribers.chat`;
  switch (plane) {
    case "nats": return `nats://${host}:4222`;
    case "wss": return `wss://wss-${region}.subscribers.chat`;
    case "gateway": return `${host}:7222`;
    case "leaf": return `${host}:7422`;
  }
}

function regionEndpoints(region: string): Record<Plane, string> {
  return Object.fromEntries(PLANES.map((p) => [p, planeValue(region, p)])) as Record<Plane, string>;
}

function jsonRegistry(body: unknown): Response {
  return Response.json(body, {
    headers: { "cache-control": "public, max-age=60, s-maxage=60", "access-control-allow-origin": "*" },
  });
}

/** Routes under /endpoints — derived entirely from NATS_REGIONS. */
async function endpointsRouter(env: Env, rest: string): Promise<Response> {
  const regions = await discoverRegions(env);
  const [a, b] = rest.replace(/^\/+|\/+$/g, "").split("/");

  // /endpoints/docs — machine-readable (JSON) registry docs
  if (a === "docs") return jsonRegistry(docsBody(regions, env));

  // /endpoints — the whole registry
  if (!a) {
    const byRegion: Record<string, Record<Plane, string>> = {};
    for (const r of regions) byRegion[r] = regionEndpoints(r);
    return jsonRegistry({
      regions: byRegion,
      nats_url: regions.map((r) => planeValue(r, "nats")).join(","),
      wss_urls: regions.map((r) => planeValue(r, "wss")),
    });
  }

  // /endpoints/<plane>  (+ optional /<region>)
  if ((PLANES as readonly string[]).includes(a)) {
    const plane = a as Plane;
    if (b) {
      if (!regions.includes(b)) return new Response("unknown region", { status: 404 });
      return jsonRegistry({ region: b, plane, value: planeValue(b, plane) });
    }
    const byRegion: Record<string, string> = {};
    for (const r of regions) byRegion[r] = planeValue(r, plane);
    return jsonRegistry({
      plane,
      regions: byRegion,
      list: regions.map((r) => planeValue(r, plane)),
      joined: regions.map((r) => planeValue(r, plane)).join(","),
    });
  }

  // /endpoints/<region>  — all planes for one region
  if (regions.includes(a)) {
    return jsonRegistry({ region: a, ...regionEndpoints(a) });
  }

  return new Response("unknown endpoint group", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/endpoints" || pathname.startsWith("/endpoints/")) {
      return endpointsRouter(env, pathname.slice("/endpoints".length));
    }

    switch (pathname) {
      case "/mesh":
        return meshBadge(env);
      case "/nats":
        return natsBadge(env);
      case "/jenkins":
        return httpBadge("jenkins", env.JENKINS_URL, "/login");
      case "/nexus":
        return httpBadge("nexus", env.NEXUS_URL, "/service/rest/v1/status");
      case "/docs":
        return docsHtml(env);
      case "/":
        return Response.json({
          routes: [
            "/mesh", "/nats", "/jenkins", "/nexus", "/docs",
            "/endpoints", "/endpoints/docs", "/endpoints/{nats|wss|gateway|leaf}", "/endpoints/{nats|wss|gateway|leaf}/{region}", "/endpoints/{region}",
          ],
        });
      default:
        return new Response("not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
