/**
 * atlas-blackbox :: fronting Worker.
 *
 * Thin by design: the Recorder Durable Object owns all state and logic;
 * this layer owns the public surface. Routes are read-only and open
 * (same posture as /_meta and /specular: the estate's observability IS
 * the portfolio), except the ground-test trigger, which is Bearer-gated.
 *
 * Caching is state-aware: the incident list moves, so 30s; a SEALED
 * incident is immutable by construction, so it earns an hour at the
 * edge. Same conditional philosophy as the estate's KV write rule,
 * applied to cache headers.
 */

import { handleMeta } from "./_meta.js";
import { Recorder } from "./recorder.js";

export { Recorder };

const META = {
  name: "atlas-blackbox",
  description:
    "Flight recorder for the estate: a rolling 10-minute buffer of telemetry and events, snapshotted permanently when a failure lands",
  version: "1.0.0",
  endpoints: [
    { method: "GET", path: "/blackbox/incidents", description: "Recorded incidents, newest first" },
    { method: "GET", path: "/blackbox/incidents/:id", description: "One incident: triggers plus the full frame window" },
    { method: "GET", path: "/blackbox/status", description: "Recorder heartbeat: buffer depth, last tick, alarm state" },
    { method: "GET", path: "/blackbox/health", description: "Liveness" },
    { method: "POST", path: "/blackbox/test-incident", description: "Ground test; Bearer BLACKBOX_TOKEN" },
  ],
  source: "https://github.com/AtlasReaper311/atlas-blackbox",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(data, { status = 200, cacheControl = "no-store" } = {}) {
  return Response.json(data, {
    status,
    headers: { ...CORS, "cache-control": cacheControl },
  });
}

function recorder(env) {
  /* One named instance: an estate has one black box, and idFromName
     makes "main" the same object from every colo. */
  return env.RECORDER.get(env.RECORDER.idFromName("main"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const meta = handleMeta(url, META);
    if (meta) return meta;

    /* The Worker answers both behind api.atlas-systems.uk/blackbox* and
       on a bare workers.dev hostname; normalising the prefix here keeps
       every route definition single-sourced. */
    let path = url.pathname;
    if (path.startsWith("/blackbox")) path = path.slice("/blackbox".length) || "/";

    if (path === "/health") {
      return json({ ok: true, name: META.name, version: META.version });
    }

    if (path === "/status" && request.method === "GET") {
      const res = await recorder(env).fetch("https://do/internal/status");
      return json(await res.json(), { cacheControl: "public, max-age=15" });
    }

    if (path === "/incidents" && request.method === "GET") {
      const res = await recorder(env).fetch("https://do/internal/incidents");
      return json(await res.json(), { cacheControl: "public, max-age=30" });
    }

    const detail = path.match(/^\/incidents\/([a-zA-Z0-9-]+)$/);
    if (detail && request.method === "GET") {
      const res = await recorder(env).fetch(`https://do/internal/incidents/${detail[1]}`);
      const body = await res.json();
      if (!body.ok) return json(body, { status: res.status });
      /* Sealed incidents never change again; unsealed ones grow their
         aftermath frames for another couple of minutes. */
      return json(body, {
        cacheControl: body.sealed ? "public, max-age=3600" : "public, max-age=15",
      });
    }

    if (path === "/test-incident" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (!env.BLACKBOX_TOKEN || auth !== `Bearer ${env.BLACKBOX_TOKEN}`) {
        return json({ ok: false, error: "unauthorised" }, { status: 401 });
      }
      const res = await recorder(env).fetch("https://do/internal/test-incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text(),
      });
      return json(await res.json(), { status: res.status });
    }

    return json({ ok: false, error: "no such route; see /blackbox/_meta" }, { status: 404 });
  },

  /* Watchdog. DO alarms are reliable, but "reliable" and "guaranteed
     armed after every possible deploy and migration" are different
     claims; a 5-minute cron that re-arms a dead alarm costs nothing and
     converts a rare stall into a 5-minute gap instead of a silent stop. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(recorder(env).fetch("https://do/internal/ensure-alarm", { method: "POST" }));
  },
};
