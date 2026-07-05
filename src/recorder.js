/**
 * recorder.js :: the black box itself.
 *
 * One Durable Object instance ("main") is the flight recorder for the
 * estate. Every 60 seconds its alarm fires and it writes one frame: a
 * trimmed telemetry snapshot from specular-edge plus whatever appeared
 * in atlas-notify's ring buffer since the last tick. Frames older than
 * the window are pruned; the buffer is bounded by design.
 *
 * When a frame contains a failure-level event, the recorder copies the
 * entire current buffer into a permanent incident row BEFORE the buffer
 * rotates it away; that is the "black box survives the crash" move. It
 * then keeps appending for two more frames (the aftermath) and seals.
 *
 * Storage is DO SQLite, not KV, on purpose: a once-per-minute
 * read-modify-write is exactly the workload the estate's conditional-
 * KV-write rule exists to keep out of KV. Here the append is a local
 * transactional write, incidents are queryable rows, and the alarm API
 * gives the 60s tick without a per-minute cron.
 *
 * Bounded, cheap, not a SIEM: ~12 live frames of a few KB each, at most
 * 50 incidents of a few tens of KB. The point is the ten minutes before
 * a failure, not log aggregation.
 */

import { notify } from "./notify.js";

/* ── Tunables ─────────────────────────────────────────────────────── */
export const TICK_MS = 60_000;
export const BUFFER_MS = 10 * 60_000 + 90_000; /* 10 min window + slack so
  the frame that carries the trigger still has a full tail behind it */
export const AFTERMATH_FRAMES = 2;   /* kill-cams show the hit AND the fall */
export const INCIDENT_DEDUPE_MS = 5 * 60_000; /* a failure storm is one
  incident with many triggers, not thirty incidents */
export const MAX_INCIDENTS = 50;
export const FETCH_TIMEOUT_MS = 6_000;

const TELEMETRY_URL = "https://api.atlas-systems.uk/specular";
const NOTIFY_RECENT_URL = "https://api.atlas-systems.uk/notify/recent";
const INCIDENT_BASE_URL = "https://api.atlas-systems.uk/blackbox/incidents";

/* ── Pure helpers (exported so the smoke test exercises real logic) ── */

/**
 * Trim the specular payload to the fields the timeline actually renders.
 * The upstream shape is owned by specular-telemetry; everything here is
 * optional-chained so a collector being added or dropped upstream can
 * never break a tick.
 */
export function trimTelemetry(raw) {
  if (!raw || typeof raw !== "object") return { fetched_ok: false };
  const source = raw.telemetry && typeof raw.telemetry === "object" ? raw.telemetry : raw;
  const gpu = source.gpu || {};
  const cpu = source.cpu || {};
  const ram = source.ram || {};
  const ollama = source.ollama || {};
  return {
    fetched_ok: true,
    online: raw.online !== false,
    sampled_at: typeof source.sampled_at === "string" ? source.sampled_at : null,
    last_seen: typeof raw.last_seen === "string" ? raw.last_seen : null,
    gpu: {
      name: typeof gpu.name === "string" ? gpu.name : "",
      utilisation_pct: numOrNull(gpu.utilisation_pct),
      temperature_c: numOrNull(gpu.temperature_c),
      vram_used_mb: numOrNull(gpu.vram_used_mb),
      vram_total_mb: numOrNull(gpu.vram_total_mb),
    },
    cpu_pct: numOrNull(cpu.overall_pct),
    ram: {
      pct: numOrNull(ram.pct),
      used_gb: numOrNull(ram.used_gb),
      total_gb: numOrNull(ram.total_gb),
    },
    ollama: {
      reachable: ollama.reachable === true,
      loaded: Array.isArray(ollama.loaded)
        ? ollama.loaded
          .map((m) => (typeof m === "string" ? m : m && m.name))
          .filter(Boolean)
          .slice(0, 6)
        : [],
    },
  };
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Split the ring buffer feed into events newer than the watermark.
 * The feed arrives newest-first with ISO timestamps; the watermark is
 * epoch ms so comparison never depends on string format quirks.
 */
export function pickNewEvents(events, watermarkMs) {
  const fresh = [];
  let next = watermarkMs;
  for (const e of Array.isArray(events) ? events : []) {
    const t = Date.parse(e && e.ts);
    if (!Number.isFinite(t)) continue;
    if (t > watermarkMs) {
      fresh.push({
        ts: e.ts,
        level: e.level || "info",
        dialect: e.dialect || "",
        event: e.event || "",
        title: e.title || "",
        message: e.message || "",
      });
    }
    if (t > next) next = t;
  }
  /* Oldest-first inside the frame so the timeline replays in order. */
  fresh.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { fresh, nextWatermarkMs: next };
}

/**
 * The trigger rule, in one place. The estate's level vocabulary is
 * closed at success|info|warning|failure; "failure" is the estate's
 * word for what the brief calls error-severity. The recorder's own
 * capture notifications go out at info level precisely so they can
 * never re-trigger a snapshot: no feedback loop by construction.
 */
export function findTrigger(freshEvents) {
  for (const e of freshEvents) {
    if (e.level === "failure") return e;
  }
  return null;
}

export function incidentId(now) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    "inc-" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    "-" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds())
  );
}

/* ── The Durable Object ───────────────────────────────────────────── */

export class Recorder {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS frames (
          ts INTEGER PRIMARY KEY,
          telemetry TEXT NOT NULL,
          events TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS incidents (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          sealed INTEGER NOT NULL DEFAULT 0,
          triggers TEXT NOT NULL,
          window_json TEXT NOT NULL,
          frame_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }

  /* meta helpers: tiny key/value beside the tables */
  getMeta(key, fallback = null) {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? row.value : fallback;
  }
  setMeta(key, value) {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key, String(value),
    );
  }

  async ensureAlarm() {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      /* First tick soon rather than in a minute: a freshly deployed or
         watchdog-revived recorder should not sit dark for 60s. */
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      return { armed: true, was: null };
    }
    return { armed: false, was: current };
  }

  async alarm() {
    /* Re-arm BEFORE the work. If a tick throws, the loop survives; the
       error is recorded, not fatal. A black box that stops recording on
       the first anomaly is a contradiction in terms. */
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    const now = Date.now();
    try {
      await this.tick(now);
      this.setMeta("last_tick", now);
      this.setMeta("last_error", "");
    } catch (err) {
      this.setMeta("last_error", `${new Date(now).toISOString()} ${String(err && err.message ? err.message : err)}`);
    }
  }

  async fetchJson(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  insertFrame(frame) {
    this.sql.exec(
      "INSERT INTO frames (ts, telemetry, events) VALUES (?, ?, ?) ON CONFLICT(ts) DO NOTHING",
      frame.ts, JSON.stringify(frame.telemetry), JSON.stringify(frame.events || []),
    );
    this.sql.exec("DELETE FROM frames WHERE ts < ?", frame.ts - BUFFER_MS);
  }

  async sampleTelemetryFrame(now) {
    const rawTelemetry = await this.fetchJson(TELEMETRY_URL);
    const frame = {
      ts: now,
      telemetry: trimTelemetry(rawTelemetry),
      events: [],
    };
    this.insertFrame(frame);
    return frame;
  }

  async tick(now) {
    /* 1 :: telemetry, via the edge Worker. Its last-known-good KV cache
       is a feature here: when the box is off, the recorder still gets an
       honest online:false snapshot instead of a hole in the record. */
    const rawTelemetry = await this.fetchJson(TELEMETRY_URL);
    const telemetry = trimTelemetry(rawTelemetry);

    /* 2 :: ring buffer, cache-busted. The endpoint carries max-age=60,
       which is right for browsers and wrong for a recorder on the same
       rhythm; ?t= opts out, as the endpoint itself documents. */
    const recent = await this.fetchJson(`${NOTIFY_RECENT_URL}?limit=50&t=${now}`);
    const watermark = Number(this.getMeta("watermark_ms", "0"));
    const { fresh, nextWatermarkMs } = pickNewEvents(recent && recent.events, watermark);
    this.setMeta("watermark_ms", nextWatermarkMs);

    /* 3 :: the frame, then the prune that makes the buffer a buffer. */
    const frame = { ts: now, telemetry, events: fresh };
    this.insertFrame(frame);

    /* 4 :: aftermath. An open incident absorbs this frame; the replay
       shows the fall as well as the hit. */
    const openId = this.getMeta("open_incident_id", "");
    if (openId) {
      const remaining = Number(this.getMeta("open_remaining", "0")) - 1;
      this.appendFrameToIncident(openId, frame, remaining <= 0);
      if (remaining <= 0) {
        this.setMeta("open_incident_id", "");
        this.setMeta("open_remaining", "0");
      } else {
        this.setMeta("open_remaining", remaining);
      }
    }

    /* 5 :: the trigger. */
    const trigger = findTrigger(fresh);
    if (!trigger) return;

    const lastIncident = this.sql
      .exec("SELECT id, ts FROM incidents ORDER BY ts DESC LIMIT 1")
      .toArray()[0];

    if (lastIncident && now - lastIncident.ts < INCIDENT_DEDUPE_MS) {
      /* Same storm, same incident: fold the trigger in. */
      const row = this.sql
        .exec("SELECT triggers FROM incidents WHERE id = ?", lastIncident.id)
        .toArray()[0];
      const triggers = JSON.parse(row.triggers);
      triggers.push(trigger);
      this.sql.exec(
        "UPDATE incidents SET triggers = ? WHERE id = ?",
        JSON.stringify(triggers), lastIncident.id,
      );
      return;
    }

    this.captureIncident(now, trigger);
  }

  captureIncident(now, trigger) {
    const id = incidentId(now);
    /* Copy the buffer NOW, before rotation can eat the tail. This copy
       is the entire reason the recorder exists. */
    const frames = this.sql
      .exec("SELECT ts, telemetry, events FROM frames ORDER BY ts ASC")
      .toArray()
      .map((r) => ({
        ts: r.ts,
        telemetry: JSON.parse(r.telemetry),
        events: JSON.parse(r.events),
      }));

    this.sql.exec(
      "INSERT INTO incidents (id, ts, sealed, triggers, window_json, frame_count) VALUES (?, ?, 0, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      id, now, JSON.stringify([trigger]), JSON.stringify(frames), frames.length,
    );
    this.setMeta("open_incident_id", id);
    this.setMeta("open_remaining", AFTERMATH_FRAMES);

    /* Keep the incident shelf bounded. "Permanent" means it survives the
       buffer, not that it outlives the heat death of the estate. */
    this.sql.exec(
      "DELETE FROM incidents WHERE id NOT IN (SELECT id FROM incidents ORDER BY ts DESC LIMIT ?)",
      MAX_INCIDENTS,
    );

    /* Tell the estate, at info level (loop-safe by the trigger rule). */
    this.ctx.waitUntil(
      notify(this.env, {
        level: "info",
        title: `blackbox :: incident captured :: ${id}`,
        message: `Trigger: ${trigger.title || trigger.event || "failure event"}. ${frames.length} frames preserved; aftermath recording.`,
        fields: { incident: `${INCIDENT_BASE_URL}/${id}` },
      }),
    );
  }

  appendFrameToIncident(id, frame, seal) {
    const row = this.sql
      .exec("SELECT window_json, frame_count FROM incidents WHERE id = ?", id)
      .toArray()[0];
    if (!row) return;
    const frames = JSON.parse(row.window_json);
    frames.push(frame);
    this.sql.exec(
      "UPDATE incidents SET window_json = ?, frame_count = ?, sealed = ? WHERE id = ?",
      JSON.stringify(frames), frames.length, seal ? 1 : 0, id,
    );
  }

  /* ── Internal API for the fronting Worker ─────────────────────── */

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/internal/ensure-alarm") {
      return Response.json(await this.ensureAlarm());
    }

    if (path === "/internal/status") {
      const frames = this.sql.exec("SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM frames").toArray()[0];
      const incidents = this.sql.exec("SELECT COUNT(*) AS n FROM incidents").toArray()[0];
      return Response.json({
        ok: true,
        recording: (await this.ctx.storage.getAlarm()) !== null,
        last_tick: Number(this.getMeta("last_tick", "0")) || null,
        last_error: this.getMeta("last_error", "") || null,
        buffer: { frames: frames.n, oldest: frames.oldest, newest: frames.newest, window_ms: BUFFER_MS },
        incidents: incidents.n,
        open_incident: this.getMeta("open_incident_id", "") || null,
      });
    }

    if (path === "/internal/incidents") {
      const rows = this.sql
        .exec("SELECT id, ts, sealed, triggers, frame_count FROM incidents ORDER BY ts DESC")
        .toArray()
        .map((r) => {
          const triggers = JSON.parse(r.triggers);
          return {
            id: r.id,
            ts: r.ts,
            sealed: r.sealed === 1,
            frame_count: r.frame_count,
            trigger_count: triggers.length,
            trigger: triggers[0] || null,
          };
        });
      return Response.json({ ok: true, count: rows.length, incidents: rows });
    }

    const detail = path.match(/^\/internal\/incidents\/([a-zA-Z0-9-]+)$/);
    if (detail) {
      const row = this.sql
        .exec("SELECT id, ts, sealed, triggers, window_json, frame_count FROM incidents WHERE id = ?", detail[1])
        .toArray()[0];
      if (!row) return Response.json({ ok: false, error: "no such incident" }, { status: 404 });
      return Response.json({
        ok: true,
        id: row.id,
        ts: row.ts,
        sealed: row.sealed === 1,
        triggers: JSON.parse(row.triggers),
        frame_count: row.frame_count,
        frames: JSON.parse(row.window_json),
      });
    }

    if (path === "/internal/test-incident" && request.method === "POST") {
      /* Ground test: flight recorders get certified by drills, not by
         waiting for a crash. Runs the REAL capture path with a synthetic
         trigger; the incident is labelled as a drill in its title. */
      let body = {};
      try { body = await request.json(); } catch { /* optional */ }
      const now = Date.now();
      await this.sampleTelemetryFrame(now - 1);
      this.captureIncident(now, {
        ts: new Date(now).toISOString(),
        level: "failure",
        dialect: "drill",
        event: "test-incident",
        title: body.title || "blackbox ground test",
        message: "Synthetic trigger via POST /blackbox/test-incident.",
      });
      return Response.json({ ok: true, id: incidentId(now) });
    }

    return Response.json({ ok: false, error: "unknown internal route" }, { status: 404 });
  }
}
