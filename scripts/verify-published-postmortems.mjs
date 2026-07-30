#!/usr/bin/env node
// Verify that every repository-published postmortem is present locally and,
// after a production deploy, exposed by the public Blackbox API.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST_PATH = resolve(ROOT, "postmortems", "manifest.json");
const BASE_URL = (process.env.BLACKBOX_PUBLIC_BASE_URL || "https://api.atlas-systems.uk/blackbox").replace(/\/$/, "");
const EXPECTED_VERSION = process.env.EXPECTED_BLACKBOX_VERSION || "1.0.1";
const ATTEMPTS = Number.parseInt(process.env.BLACKBOX_VERIFY_ATTEMPTS || "30", 10);
const DELAY_MS = Number.parseInt(process.env.BLACKBOX_VERIFY_DELAY_MS || "10000", 10);
const VALIDATE_ONLY = process.argv.includes("--validate-only");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validIncidentId(value) {
  return /^inc-[0-9]{8}-[0-9]{6}$/.test(value);
}

async function loadLocalContract() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  assert(manifest && typeof manifest === "object" && !Array.isArray(manifest), "manifest must be a JSON object");

  const entries = Object.entries(manifest);
  for (const [id, entry] of entries) {
    assert(validIncidentId(id), `manifest contains invalid incident id ${id}`);
    assert(entry && typeof entry === "object" && !Array.isArray(entry), `${id} manifest entry must be an object`);
    assert(typeof entry.title === "string" && entry.title.trim(), `${id} is missing a title`);
    assert(typeof entry.sealed === "string" && entry.sealed.trim(), `${id} is missing sealed time`);
    assert(typeof entry.publishedAt === "string" && Number.isFinite(Date.parse(entry.publishedAt)), `${id} has invalid publishedAt`);

    const html = await readFile(resolve(ROOT, "postmortems", `${id}.html`), "utf8");
    assert(html.trim().length > 0, `${id} HTML is empty`);
    assert(/<h2>[^<]+<\/h2>/.test(html), `${id} HTML has no section heading`);
    assert(!/<script\b/i.test(html), `${id} HTML contains a script element`);
    assert(!/\son[a-z]+\s*=/i.test(html), `${id} HTML contains an event-handler attribute`);
    assert(!/javascript:/i.test(html), `${id} HTML contains a javascript URL`);
  }

  return { manifest, entries };
}

async function fetchJson(path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    },
    signal: AbortSignal.timeout(15000)
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${body.error || text.slice(0, 160)}`);
  }
  return body;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function verifyProduction(_manifest, entries) {
  const health = await fetchJson("/health");
  assert(health.ok === true, "health response is not ok");
  assert(health.name === "atlas-blackbox", `unexpected health service ${health.name}`);
  assert(health.version === EXPECTED_VERSION, `expected version ${EXPECTED_VERSION}, received ${health.version}`);
  assert(health.postmortemAssetsAvailable === true, "postmortem asset binding is unavailable");
  assert(
    Number.isInteger(health.publishedPostmortemCount) && health.publishedPostmortemCount >= entries.length,
    `health reports ${health.publishedPostmortemCount} published postmortems, expected at least ${entries.length}`
  );

  for (const [id, entry] of entries) {
    const detail = await fetchJson(`/incidents/${encodeURIComponent(id)}`);
    assert(detail.ok === true, `${id} detail response is not ok`);
    assert(detail.id === id, `${id} detail returned incident ${detail.id}`);
    assert(detail.postmortemAssetsAvailable === true, `${id} detail reports unavailable postmortem assets`);
    assert(detail.hasPostmortem === true, `${id} detail reports hasPostmortem=false`);
    assert(detail.postmortemTitle === entry.title, `${id} detail title does not match manifest`);

    const published = await fetchJson(`/incidents/${encodeURIComponent(id)}/postmortem`);
    assert(published.ok === true, `${id} postmortem response is not ok`);
    assert(published.id === id, `${id} postmortem returned incident ${published.id}`);
    assert(published.title === entry.title, `${id} postmortem title does not match manifest`);
    assert(published.sealed === entry.sealed, `${id} postmortem sealed time does not match manifest`);
    assert(published.publishedAt === entry.publishedAt, `${id} postmortem publishedAt does not match manifest`);
    assert(typeof published.html === "string" && published.html.trim(), `${id} postmortem HTML is empty`);
  }
}

async function main() {
  assert(Number.isInteger(ATTEMPTS) && ATTEMPTS > 0, "BLACKBOX_VERIFY_ATTEMPTS must be a positive integer");
  assert(Number.isInteger(DELAY_MS) && DELAY_MS >= 0, "BLACKBOX_VERIFY_DELAY_MS must be a non-negative integer");

  const { manifest, entries } = await loadLocalContract();
  console.log(`validated ${entries.length} local published postmortem(s)`);

  if (VALIDATE_ONLY) return;
  if (!entries.length) {
    console.log("no published postmortems to verify in production");
    return;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await verifyProduction(manifest, entries);
      console.log(`verified ${entries.length} published postmortem(s) at ${BASE_URL}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`attempt ${attempt}/${ATTEMPTS}: ${error.message}`);
      if (attempt < ATTEMPTS) await delay(DELAY_MS);
    }
  }

  throw new Error(`production postmortem verification failed: ${lastError?.message || "unknown error"}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
