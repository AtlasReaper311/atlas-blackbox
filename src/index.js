import { handleMeta } from "./_meta.js";
import { Recorder } from "./recorder.js";
 
const META = {
  name: "atlas-blackbox",
  description: "Flight recorder for the estate: a rolling 10-minute buffer of telemetry and events, snapshotted permanently when a failure lands",
  version: "1.0.0",
  endpoints: [
    { method: "GET", path: "/blackbox/incidents", description: "Recorded incidents, newest first" },
    { method: "GET", path: "/blackbox/incidents/:id", description: "One incident: triggers plus the full frame window" },
    { method: "GET", path: "/blackbox/incidents/:id/postmortem", description: "Published postmortem for one incident, if reviewed and published" },
    { method: "GET", path: "/blackbox/status", description: "Recorder heartbeat: buffer depth, last tick, alarm state" },
    { method: "GET", path: "/blackbox/health", description: "Liveness" },
    { method: "POST", path: "/blackbox/test-incident", description: "Ground test; Bearer BLACKBOX_TOKEN" }
  ],
  source: "https://github.com/AtlasReaper311/atlas-blackbox"
};
 
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type"
};
 
function json(data, { status = 200, cacheControl = "no-store" } = {}) {
  return Response.json(data, {
    status,
    headers: { ...CORS, "cache-control": cacheControl }
  });
}
 
function recorder(env) {
  return env.RECORDER.get(env.RECORDER.idFromName("main"));
}
 
// Postmortems are published by committing a converted HTML fragment plus a
// manifest entry into ./postmortems (see scripts/publish-postmortem.mjs).
// The manifest is the only thing checked at request time, it carries the
// title too, so the Lab panel never needs a second round trip just to
// label the link.
async function loadPostmortemManifest(env) {
  try {
    const res = await env.POSTMORTEM_ASSETS.fetch("https://assets.local/manifest.json");
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}
 
function withPostmortemFlag(incidentSummary, manifest) {
  const entry = manifest[incidentSummary.id];
  return {
    ...incidentSummary,
    hasPostmortem: Boolean(entry),
    postmortemTitle: entry ? entry.title : null
  };
}
 
export { Recorder };
 
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const meta = handleMeta(url, META);
    if (meta) return meta;
 
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
      const body = await res.json();
      if (body.ok) {
        const manifest = await loadPostmortemManifest(env);
        body.incidents = body.incidents.map((inc) => withPostmortemFlag(inc, manifest));
      }
      return json(body, { cacheControl: "public, max-age=30" });
    }
 
    const detail = path.match(/^\/incidents\/([a-zA-Z0-9-]+)$/);
    if (detail && request.method === "GET") {
      const res = await recorder(env).fetch(`https://do/internal/incidents/${detail[1]}`);
      const body = await res.json();
      if (!body.ok) return json(body, { status: res.status });
      const manifest = await loadPostmortemManifest(env);
      const entry = manifest[body.id];
      body.hasPostmortem = Boolean(entry);
      body.postmortemTitle = entry ? entry.title : null;
      return json(body, {
        cacheControl: body.sealed ? "public, max-age=3600" : "public, max-age=15"
      });
    }
 
    const postmortem = path.match(/^\/incidents\/([a-zA-Z0-9-]+)\/postmortem$/);
    if (postmortem && request.method === "GET") {
      const id = postmortem[1];
      const manifest = await loadPostmortemManifest(env);
      const entry = manifest[id];
      if (!entry) {
        return json({ ok: false, error: "no postmortem published for this incident" }, { status: 404 });
      }
      const res = await env.POSTMORTEM_ASSETS.fetch(`https://assets.local/${id}.html`);
      if (!res.ok) {
        return json({ ok: false, error: "manifest references a postmortem file that is missing" }, { status: 500 });
      }
      const html = await res.text();
      return json(
        { ok: true, id, title: entry.title, sealed: entry.sealed, publishedAt: entry.publishedAt, html },
        { cacheControl: "public, max-age=3600" }
      );
    }
 
    if (path === "/test-incident" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (!env.BLACKBOX_TOKEN || auth !== `Bearer ${env.BLACKBOX_TOKEN}`) {
        return json({ ok: false, error: "unauthorised" }, { status: 401 });
      }
      const res = await recorder(env).fetch("https://do/internal/test-incident", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await request.text()
      });
      return json(await res.json(), { status: res.status });
    }
 
    return json({ ok: false, error: "no such route; see /blackbox/_meta" }, { status: 404 });
  },
 
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(recorder(env).fetch("https://do/internal/ensure-alarm", { method: "POST" }));
  }
};
