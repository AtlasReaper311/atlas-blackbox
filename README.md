<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# atlas-blackbox

```
┌───────────────────────────────────────────────┐
│  ATLAS SYSTEMS // atlas-blackbox              │
│  flight recorder for the estate: the ten      │
│  minutes before every failure, kept           │
└───────────────────────────────────────────────┘
```

![Runtime](https://img.shields.io/badge/runtime-cloudflare_workers-f5a623?style=flat-square&labelColor=0a0a0f)
![Storage](https://img.shields.io/badge/storage-durable_object_sqlite-4ade80?style=flat-square&labelColor=0a0a0f)
![Buffer](https://img.shields.io/badge/buffer-10min_rolling-aaa9a0?style=flat-square&labelColor=0a0a0f)
![Plan](https://img.shields.io/badge/plan-workers_plus-aaa9a0?style=flat-square&labelColor=0a0a0f)

A rolling black-box recorder for Atlas Systems. Once a minute it writes one frame: a trimmed hardware snapshot from [`specular-telemetry`](https://github.com/AtlasReaper311/specular-telemetry) plus everything that landed in [`atlas-notify`](https://github.com/AtlasReaper311/atlas-notify)'s ring buffer since the last tick, deploys included. When a `failure`-level event arrives, the recorder copies the entire buffer into a permanent incident before rotation can eat it, records two more frames of aftermath, and seals. The question it exists to answer is not "did something fail" (Discord already says so) but "what was the estate doing for the ten minutes before it did". The framing is borrowed deliberately from flight recorders and game replay systems; [`why-this-exists.md`](./why-this-exists.md) makes that connection explicit.

## What a frame holds

Per tick (60s, Durable Object alarm): `{ts, telemetry, events[]}`. Telemetry is trimmed to the gauges a replay renders (GPU load, GPU temperature, VRAM, CPU, RAM, Ollama reachability); events are the ring-buffer entries new since the last tick, each with its own precise timestamp and dialect (`github` entries are CI/deploy activity, `alert` entries are Worker runtime envelopes). Bounded on purpose: ~12 live frames of a few KB, at most 50 incidents. It is a black box, not a SIEM.

## API

All under `api.atlas-systems.uk/blackbox`, read-only routes open (the estate's observability is the portfolio):

| Route | What it returns |
|---|---|
| `GET /blackbox/incidents` | Recorded incidents, newest first: id, trigger, frame count, sealed |
| `GET /blackbox/incidents/:id` | One incident: triggers plus the full frame window |
| `GET /blackbox/status` | Recorder heartbeat: buffer depth, last tick, alarm state |
| `GET /blackbox/health` | Liveness |
| `GET /blackbox/_meta` | The estate self-description contract |
| `POST /blackbox/test-incident` | Ground test; `Bearer BLACKBOX_TOKEN` |

Sealed incidents are immutable by construction, so the Worker serves them with an hour of edge cache; the list gets 30s. Same conditional philosophy as the estate's KV write rule, applied to cache headers.

## Why a Durable Object with SQLite, not KV

A rolling buffer is a once-per-minute read-modify-write. That is precisely the workload the estate's conditional-KV-write rule exists to keep out of KV: 1,440 unconditional writes a day to rewrite one growing key, with eventual consistency underneath a read-modify-write cycle. In a SQLite-backed Durable Object the append is a local transactional insert, the prune is one `DELETE`, incidents are queryable rows rather than parsed blobs, and the alarm API provides the 60s heartbeat without a per-minute cron. A 5-minute cron survives as a watchdog only, re-arming the alarm if a deploy ever leaves it dark; the alarm re-arms itself before doing any work, so a failing tick can never kill the loop. A recorder that stops recording on the first anomaly is a contradiction in terms.

The trigger vocabulary is the estate's, not invented: levels are closed at `success | info | warning | failure`, and `failure` is what trips a capture. The recorder's own capture notifications go out at `info`, which makes a feedback loop impossible by construction rather than by configuration.

## Deploy

```
wrangler secret put NOTIFY_TOKEN
wrangler secret put BLACKBOX_TOKEN
wrangler deploy
```

The route claims `api.atlas-systems.uk/blackbox*` with a literal `zone_id` (scoped CI tokens cannot resolve `zone_name`). First tick fires within seconds of the watchdog cron; `GET /blackbox/status` confirms `recording: true`.

## Ground test

Flight recorders are certified by drills, not by waiting for a crash:

```
curl -X POST https://api.atlas-systems.uk/blackbox/test-incident \
  -H "Authorization: Bearer $BLACKBOX_TOKEN" \
  -d '{"title":"ground test"}'
```

Runs the real capture path with a synthetic trigger, labelled as a drill in the record.

## The replay deck

`ui/blackbox-timeline.js` and its stylesheet render any incident as a scrubbable timeline on the Lab page: the cursor opens on the moment of failure, telemetry gauges interpolate between the per-minute samples (and say so), events sit on the track at their exact second, deploys get their own marker, and a replay button plays the window at 30x. Everything remote is escaped; every failure state is a sentence, not a broken widget.

## How it fits into Atlas Systems

Downstream of everything and load-bearing for nothing: it reads [`specular-edge`](https://github.com/AtlasReaper311/specular-telemetry)'s cached telemetry (whose last-known-good behaviour means an offline machine yields an honest `online:false` frame instead of a hole), consumes [`atlas-notify`](https://github.com/AtlasReaper311/atlas-notify)'s ring buffer as its event source, speaks the estate envelope back through the same router when it captures, answers [`/_meta`](https://github.com/AtlasReaper311/worker-meta-kit) so [`atlas-api-index`](https://github.com/AtlasReaper311/atlas-api-index) lists it, and feeds the Lab page one more live panel.

The transferable principle: incident tooling should spend its budget on the minutes before a failure, because "that it failed" is cheap to know and "what led up to it" is the part you cannot reconstruct after the buffer rotates.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
