import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

// Obviously synthetic fixture values — never production incident IDs.
const INCIDENT_ID = "inc-20990101-000001";
const INCIDENT_TITLE = "Synthetic offline regression incident";
const POSTMORTEM_TITLE = "Synthetic offline postmortem title";
const POSTMORTEM_SEALED = "2099-01-01 00:00:01Z";
const POSTMORTEM_PUBLISHED_AT = "2099-01-02T03:04:05.678Z";
const POSTMORTEM_HTML = "<h2>Synthetic postmortem</h2><p>offline fixture only</p>";

const MUTABLE_METADATA_CACHE = "public, max-age=15, must-revalidate";
const PUBLISHED_POSTMORTEM_CACHE = "public, max-age=3600";

function incidentSummary() {
  return {
    id: INCIDENT_ID,
    title: INCIDENT_TITLE,
    sealedAt: POSTMORTEM_SEALED,
    triggerCount: 1
  };
}

function incidentDetail() {
  return {
    ok: true,
    id: INCIDENT_ID,
    title: INCIDENT_TITLE,
    sealedAt: POSTMORTEM_SEALED,
    triggers: [{ level: "error", title: "synthetic trigger" }],
    frames: [{ t: POSTMORTEM_SEALED, online: false }]
  };
}

function manifestEntries() {
  return {
    [INCIDENT_ID]: {
      title: POSTMORTEM_TITLE,
      sealed: POSTMORTEM_SEALED,
      publishedAt: POSTMORTEM_PUBLISHED_AT
    }
  };
}

function createRecorderBinding(handlers = {}) {
  const defaults = {
    "/internal/incidents": () => Response.json({ ok: true, incidents: [incidentSummary()] }),
    [`/internal/incidents/${INCIDENT_ID}`]: () => Response.json(incidentDetail())
  };
  const routes = { ...defaults, ...handlers };

  const stub = {
    async fetch(input) {
      const url = typeof input === "string" ? new URL(input) : new URL(input.url);
      const handler = routes[url.pathname];
      if (!handler) {
        return Response.json(
          { ok: false, error: `unexpected recorder path ${url.pathname}` },
          { status: 500 }
        );
      }
      return handler(url);
    }
  };

  return {
    idFromName(name) {
      assert.equal(name, "main");
      return "main";
    },
    get(id) {
      assert.equal(id, "main");
      return stub;
    }
  };
}

function createPostmortemAssetsBinding({
  available = true,
  missingHtml = false,
  manifest = manifestEntries()
} = {}) {
  if (!available) return undefined;

  return {
    async fetch(input) {
      const url = typeof input === "string" ? new URL(input) : new URL(input.url);
      if (url.pathname === "/manifest.json") {
        return Response.json(manifest);
      }
      if (url.pathname === `/${INCIDENT_ID}.html`) {
        if (missingHtml) {
          return new Response("missing", { status: 404 });
        }
        return new Response(POSTMORTEM_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      return new Response("not found", { status: 404 });
    }
  };
}

function createEnv(options = {}) {
  return {
    RECORDER: createRecorderBinding(options.recorderHandlers),
    POSTMORTEM_ASSETS: createPostmortemAssetsBinding(options)
  };
}

async function invoke(path, env = createEnv()) {
  const request = new Request(`https://api.atlas-systems.uk${path}`, {
    method: "GET",
    headers: { accept: "application/json" }
  });
  return worker.fetch(request, env);
}

async function readJson(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, received: ${text.slice(0, 160)}`);
  }
  return body;
}

function cacheControl(response) {
  return response.headers.get("cache-control");
}

test("/blackbox/health and /blackbox/health/ are equivalent", async () => {
  const env = createEnv();
  const canonical = await invoke("/blackbox/health", env);
  const trailing = await invoke("/blackbox/health/", env);

  assert.equal(canonical.status, 200);
  assert.equal(trailing.status, 200);

  const canonicalBody = await readJson(canonical);
  const trailingBody = await readJson(trailing);

  assert.deepEqual(trailingBody, canonicalBody);
  assert.equal(canonicalBody.ok, true);
  assert.equal(canonicalBody.name, "atlas-blackbox");
  assert.equal(canonicalBody.postmortemAssetsAvailable, true);
  assert.equal(canonicalBody.publishedPostmortemCount, 1);
});

test("canonical and trailing-slash incident detail routes are equivalent", async () => {
  const env = createEnv();
  const canonical = await invoke(`/blackbox/incidents/${INCIDENT_ID}`, env);
  const trailing = await invoke(`/blackbox/incidents/${INCIDENT_ID}/`, env);

  assert.equal(canonical.status, 200);
  assert.equal(trailing.status, 200);

  const canonicalBody = await readJson(canonical);
  const trailingBody = await readJson(trailing);
  assert.deepEqual(trailingBody, canonicalBody);
  assert.equal(canonicalBody.ok, true);
  assert.equal(canonicalBody.id, INCIDENT_ID);
});

test("canonical and trailing-slash postmortem routes are equivalent", async () => {
  const env = createEnv();
  const canonical = await invoke(`/blackbox/incidents/${INCIDENT_ID}/postmortem`, env);
  const trailing = await invoke(`/blackbox/incidents/${INCIDENT_ID}/postmortem/`, env);

  assert.equal(canonical.status, 200);
  assert.equal(trailing.status, 200);

  const canonicalBody = await readJson(canonical);
  const trailingBody = await readJson(trailing);
  assert.deepEqual(trailingBody, canonicalBody);
  assert.equal(canonicalBody.ok, true);
  assert.equal(canonicalBody.id, INCIDENT_ID);
  assert.equal(canonicalBody.html, POSTMORTEM_HTML);
});

test("manifest-backed incident detail exposes postmortem metadata exactly", async () => {
  const response = await invoke(`/blackbox/incidents/${INCIDENT_ID}`);
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.hasPostmortem, true);
  assert.equal(body.postmortemTitle, POSTMORTEM_TITLE);
  assert.equal(body.postmortemPublishedAt, POSTMORTEM_PUBLISHED_AT);
});

test("incident detail uses the short mutable-metadata cache contract", async () => {
  const response = await invoke(`/blackbox/incidents/${INCIDENT_ID}`);
  assert.equal(response.status, 200);
  assert.equal(cacheControl(response), MUTABLE_METADATA_CACHE);
});

test("incident list uses the short mutable-metadata cache contract", async () => {
  const response = await invoke("/blackbox/incidents");
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.incidents.length, 1);
  assert.equal(body.incidents[0].hasPostmortem, true);
  assert.equal(body.incidents[0].postmortemTitle, POSTMORTEM_TITLE);
  assert.equal(body.incidents[0].postmortemPublishedAt, POSTMORTEM_PUBLISHED_AT);
  assert.equal(cacheControl(response), MUTABLE_METADATA_CACHE);
});

test("published postmortem content retains the longer cache contract", async () => {
  const response = await invoke(`/blackbox/incidents/${INCIDENT_ID}/postmortem`);
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.title, POSTMORTEM_TITLE);
  assert.equal(body.publishedAt, POSTMORTEM_PUBLISHED_AT);
  assert.equal(body.html, POSTMORTEM_HTML);
  assert.equal(cacheControl(response), PUBLISHED_POSTMORTEM_CACHE);
});

test("missing postmortem assets remain an explicit unavailable/error state", async () => {
  const unavailableEnv = createEnv({ available: false });
  const unavailable = await invoke(`/blackbox/incidents/${INCIDENT_ID}/postmortem`, unavailableEnv);
  const unavailableBody = await readJson(unavailable);

  assert.equal(unavailable.status, 503);
  assert.equal(unavailableBody.ok, false);
  assert.match(unavailableBody.error, /postmortem assets unavailable/i);
  assert.equal(unavailableBody.html, undefined);

  const missingHtmlEnv = createEnv({ missingHtml: true });
  const missingHtml = await invoke(`/blackbox/incidents/${INCIDENT_ID}/postmortem`, missingHtmlEnv);
  const missingHtmlBody = await readJson(missingHtml);

  assert.equal(missingHtml.status, 500);
  assert.equal(missingHtmlBody.ok, false);
  assert.match(missingHtmlBody.error, /missing/i);
  assert.equal(missingHtmlBody.html, undefined);
});
