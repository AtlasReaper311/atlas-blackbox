/**
 * blackbox-timeline.js
 * The replay deck for atlas-blackbox incidents.
 *
 * Given one recorded incident, a visitor scrubs through the window
 * second by second and watches the estate's state approach the failure:
 * telemetry gauges move, ring-buffer events land on the track at their
 * exact timestamps, and the trigger sits marked where it hit. Game
 * replay conventions on purpose: the scrubber OPENS at the moment of
 * failure (a kill-cam lands on the hit, you scrub back to see why),
 * and replay runs at 30x because twelve real minutes is a film, not a
 * diagnostic.
 *
 * Honesty rule: telemetry frames are sampled once a minute, so values
 * between samples are linear interpolation and the UI says so. Events
 * are NOT interpolated; each carries its own precise timestamp from the
 * ring buffer and appears at exactly that second.
 *
 * Zero dependencies, same host conventions as the system map. Every
 * remote string is escaped; every fetch failure is a sentence, not a
 * broken widget.
 */
(function () {
  "use strict";

  var host = document.getElementById("blackbox-host");
  if (!host) return;

  var statusline = document.getElementById("blackbox-statusline");
  var BASE = "https://api.atlas-systems.uk/blackbox";
  var REPLAY_RATE = 30;      /* window-seconds per real second */
  var REPLAY_TICK_MS = 100;
  var FEED_MAX = 12;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var state = {
    incidents: [],
    current: null,   /* { id, ts, sealed, triggers, frames, t0, t1, events } */
    cursor: 0,
    playing: false,
    playTimer: null
  };

  /* ── Utilities ───────────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function hhmmss(ms) {
    var d = new Date(ms);
    function p(n) { return String(n).padStart(2, "0"); }
    return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
  }
  function fetchJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  /* ── Interpolation (exported for the smoke test) ─────────────────── */
  function lerp(a, b, t) {
    if (typeof a !== "number" || typeof b !== "number") return null;
    return a + (b - a) * t;
  }
  /**
   * Telemetry at an arbitrary cursor: find the bracketing frames and
   * lerp the numeric gauges. An offline frame poisons interpolation on
   * its side honestly; a gauge shows a dash rather than a value invented
   * across a gap in the record.
   */
  function telemetryAt(frames, cursorMs) {
    if (!frames.length) return null;
    var f0 = frames[0], f1 = frames[frames.length - 1];
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].ts <= cursorMs) f0 = frames[i];
      if (frames[i].ts >= cursorMs) { f1 = frames[i]; break; }
    }
    var a = f0.telemetry || {}, b = f1.telemetry || {};
    if (a.online === false || b.online === false || a.fetched_ok === false || b.fetched_ok === false) {
      return { online: false };
    }
    var span = f1.ts - f0.ts;
    var t = span > 0 ? (cursorMs - f0.ts) / span : 0;
    var ag = a.gpu || {}, bg = b.gpu || {};
    var ar = a.ram || {}, br = b.ram || {};
    return {
      online: true,
      gpu_util: lerp(ag.utilisation_pct, bg.utilisation_pct, t),
      gpu_temp: lerp(ag.temperature_c, bg.temperature_c, t),
      vram_used: lerp(ag.vram_used_mb, bg.vram_used_mb, t),
      vram_total: bg.vram_total_mb != null ? bg.vram_total_mb : ag.vram_total_mb,
      cpu: lerp(a.cpu_pct, b.cpu_pct, t),
      ram: lerp(ar.pct, br.pct, t)
    };
  }

  function flattenEvents(incident) {
    var out = [];
    (incident.frames || []).forEach(function (f) {
      (f.events || []).forEach(function (e) {
        var t = Date.parse(e.ts);
        if (Number.isFinite(t)) out.push({ ms: t, level: e.level, dialect: e.dialect, title: e.title, event: e.event });
      });
    });
    out.sort(function (a, b) { return a.ms - b.ms; });
    return out;
  }

  /* ── DOM scaffold ────────────────────────────────────────────────── */
  var els = {};
  function build() {
    host.innerHTML =
      '<div class="bbx-top">' +
      '  <select class="bbx-picker" aria-label="Choose a recorded incident"></select>' +
      '  <div class="bbx-badges"></div>' +
      "</div>" +
      '<div class="bbx-deck" hidden>' +
      '  <div class="bbx-readout">' +
      '    <span class="bbx-time">--:--:--</span>' +
      '    <span class="bbx-time-note">UTC</span>' +
      '    <button type="button" class="bbx-replay">replay \u00D7' + REPLAY_RATE + "</button>" +
      "  </div>" +
      '  <div class="bbx-track">' +
      '    <div class="bbx-aftermath" aria-hidden="true"></div>' +
      '    <div class="bbx-markers" aria-hidden="true"></div>' +
      '    <input type="range" class="bbx-scrub" step="1000" aria-label="Scrub through the incident window, one second per step">' +
      "  </div>" +
      '  <div class="bbx-gauges"></div>' +
      '  <div class="bbx-feed" aria-label="Events up to the cursor"></div>' +
      '  <div class="bbx-foot">telemetry sampled once a minute; values between samples are interpolated \u00B7 events sit at their exact timestamps</div>' +
      "</div>" +
      '<div class="bbx-empty" hidden></div>';

    els.picker = host.querySelector(".bbx-picker");
    els.badges = host.querySelector(".bbx-badges");
    els.deck = host.querySelector(".bbx-deck");
    els.time = host.querySelector(".bbx-time");
    els.replay = host.querySelector(".bbx-replay");
    els.scrub = host.querySelector(".bbx-scrub");
    els.aftermath = host.querySelector(".bbx-aftermath");
    els.markers = host.querySelector(".bbx-markers");
    els.gauges = host.querySelector(".bbx-gauges");
    els.feed = host.querySelector(".bbx-feed");
    els.empty = host.querySelector(".bbx-empty");

    els.picker.addEventListener("change", function () { loadIncident(els.picker.value); });
    els.scrub.addEventListener("input", function () {
      stopReplay();
      setCursor(Number(els.scrub.value));
    });
    els.scrub.addEventListener("keydown", function (ev) {
      if (ev.shiftKey && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
        ev.preventDefault();
        stopReplay();
        setCursor(state.cursor + (ev.key === "ArrowRight" ? 10000 : -10000));
      }
    });
    els.replay.addEventListener("click", toggleReplay);
    if (reduceMotion) els.replay.hidden = true;
  }

  function setStatusline(html) { if (statusline) statusline.innerHTML = html; }

  /* ── Rendering ───────────────────────────────────────────────────── */
  function setCursor(ms) {
    var c = state.current;
    if (!c) return;
    state.cursor = Math.max(c.t0, Math.min(c.t1, ms));
    els.scrub.value = state.cursor;
    els.scrub.setAttribute("aria-valuetext", hhmmss(state.cursor) + " UTC");
    els.time.textContent = hhmmss(state.cursor);
    renderGauges();
    renderFeed();
  }

  function gaugeRow(label, value, max, unit, text) {
    var pct = value == null || max == null || max === 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
    var display = text != null ? text : (value == null ? "\u2013" : Math.round(value) + unit);
    return '<div class="bbx-gauge"><span class="bbx-gauge-label">' + esc(label) + "</span>" +
      '<span class="bbx-gauge-bar"><span class="bbx-gauge-fill" style="width:' + pct.toFixed(1) + '%"></span></span>' +
      '<span class="bbx-gauge-val">' + esc(display) + "</span></div>";
  }

  function renderGauges() {
    var t = telemetryAt(state.current.frames, state.cursor);
    if (!t || t.online === false) {
      els.gauges.innerHTML = '<div class="bbx-offline">SPECULAR-CORE offline or unsampled at this point in the record</div>';
      return;
    }
    els.gauges.innerHTML =
      gaugeRow("gpu", t.gpu_util, 100, "%") +
      gaugeRow("gpu temp", t.gpu_temp, 100, "\u00B0C") +
      gaugeRow("vram", t.vram_used, t.vram_total, "",
        t.vram_used == null ? "\u2013" : (t.vram_used / 1024).toFixed(1) + " / " + (t.vram_total / 1024).toFixed(1) + " GB") +
      gaugeRow("cpu", t.cpu, 100, "%") +
      gaugeRow("ram", t.ram, 100, "%");
  }

  var DIALECT_LABEL = { github: "ci/cd", cloudflare: "cf", alert: "runtime", drill: "drill" };
  function renderFeed() {
    var visible = state.current.events.filter(function (e) { return e.ms <= state.cursor; });
    var rows = visible.slice(-FEED_MAX).reverse().map(function (e, i) {
      var isTrigger = state.current.triggerMs.indexOf(e.ms) !== -1 && e.level === "failure";
      return '<div class="bbx-ev bbx-ev-' + esc(e.level) + (i === 0 ? " bbx-ev-latest" : "") + '">' +
        '<span class="bbx-ev-t">' + hhmmss(e.ms) + "</span>" +
        '<span class="bbx-ev-dot"></span>' +
        '<span class="bbx-ev-dialect">' + esc(DIALECT_LABEL[e.dialect] || e.dialect || "\u2013") + "</span>" +
        '<span class="bbx-ev-title">' + esc(e.title || e.event || "(untitled event)") + "</span>" +
        (isTrigger ? '<span class="bbx-ev-trig">trigger</span>' : "") +
        "</div>";
    });
    els.feed.innerHTML = rows.length
      ? rows.join("")
      : '<div class="bbx-ev bbx-ev-none">no events yet at this point in the window; the quiet before it</div>';
  }

  function renderMarkers() {
    var c = state.current;
    var span = c.t1 - c.t0 || 1;
    var html = "";
    c.events.forEach(function (e) {
      var left = ((e.ms - c.t0) / span) * 100;
      var cls = e.dialect === "github" ? "bbx-mk-deploy" : "bbx-mk-" + (e.level || "info");
      html += '<span class="bbx-mk ' + cls + '" style="left:' + left.toFixed(2) + '%" title="' +
        esc(hhmmss(e.ms) + " \u00B7 " + (e.title || e.event || e.level)) + '"></span>';
    });
    c.triggerMs.forEach(function (ms) {
      var left = ((ms - c.t0) / span) * 100;
      html += '<span class="bbx-mk bbx-mk-trigger" style="left:' + left.toFixed(2) + '%" title="trigger \u00B7 ' + esc(hhmmss(ms)) + '"></span>';
    });
    els.markers.innerHTML = html;

    /* Shade the fall: everything after the first trigger is aftermath. */
    var firstTrig = c.triggerMs.length ? Math.min.apply(null, c.triggerMs) : null;
    if (firstTrig != null) {
      var leftPct = ((firstTrig - c.t0) / span) * 100;
      els.aftermath.style.left = leftPct.toFixed(2) + "%";
      els.aftermath.style.display = "";
    } else {
      els.aftermath.style.display = "none";
    }
  }

  /* ── Replay ──────────────────────────────────────────────────────── */
  function toggleReplay() {
    if (state.playing) { stopReplay(); return; }
    var c = state.current;
    if (!c) return;
    /* Replay means watching the approach: start from the top of the
       window, not from wherever the cursor was parked. */
    setCursor(c.t0);
    state.playing = true;
    els.replay.textContent = "pause";
    state.playTimer = setInterval(function () {
      var next = state.cursor + REPLAY_RATE * REPLAY_TICK_MS;
      if (next >= c.t1) { setCursor(c.t1); stopReplay(); return; }
      setCursor(next);
    }, REPLAY_TICK_MS);
  }
  function stopReplay() {
    if (state.playTimer) clearInterval(state.playTimer);
    state.playTimer = null;
    state.playing = false;
    els.replay.textContent = "replay \u00D7" + REPLAY_RATE;
  }

  /* ── Data flow ───────────────────────────────────────────────────── */
  function loadIncident(id) {
    stopReplay();
    fetchJson(BASE + "/incidents/" + encodeURIComponent(id)).then(function (inc) {
      var frames = (inc.frames || []).slice().sort(function (a, b) { return a.ts - b.ts; });
      if (!frames.length) {
        els.deck.hidden = true;
        showEmpty("this incident recorded an empty buffer; the box was new when it triggered.");
        return;
      }
      var triggerMs = (inc.triggers || []).map(function (t) { return Date.parse(t.ts); })
        .filter(function (n) { return Number.isFinite(n); });
      state.current = {
        id: inc.id,
        sealed: inc.sealed === true,
        frames: frames,
        events: flattenEvents(inc),
        triggerMs: triggerMs,
        t0: frames[0].ts,
        t1: frames[frames.length - 1].ts
      };
      els.badges.innerHTML =
        '<span class="bbx-badge">' + frames.length + " frames</span>" +
        '<span class="bbx-badge">' + state.current.events.length + " events</span>" +
        '<span class="bbx-badge ' + (state.current.sealed ? "bbx-badge-sealed" : "bbx-badge-open") + '">' +
        (state.current.sealed ? "sealed" : "recording aftermath") + "</span>";
      els.scrub.min = state.current.t0;
      els.scrub.max = state.current.t1;
      els.empty.hidden = true;
      els.deck.hidden = false;
      renderMarkers();
      /* Land ON the hit; scrubbing back is the visitor's move. */
      setCursor(triggerMs.length ? triggerMs[0] : state.current.t1);
    }).catch(function () {
      showEmpty("that incident would not load; the recorder is reachable but this record was not. try another.");
    });
  }

  function showEmpty(msg) {
    els.empty.hidden = false;
    els.empty.innerHTML = '<span class="t-dim">' + esc(msg) + "</span>";
  }

  function init() {
    build();
    setStatusline('<span class="t-dim">contacting recorder\u2026</span>');

    fetchJson(BASE + "/status").then(function (s) {
      var tick = s.last_tick ? hhmmss(s.last_tick) + " UTC" : "never";
      setStatusline(
        (s.recording ? '<span class="t-ok">\u25CF recording</span>' : '<span class="t-err">\u25CF not recording</span>') +
        ' <span class="t-faint">\u00B7 ' + (s.buffer ? s.buffer.frames : 0) + " frames buffered \u00B7 last tick " + esc(tick) + "</span>"
      );
    }).catch(function () {
      setStatusline('<span class="t-dim">recorder status unavailable</span>');
    });

    fetchJson(BASE + "/incidents").then(function (list) {
      state.incidents = list.incidents || [];
      if (!state.incidents.length) {
        els.deck.hidden = true;
        showEmpty("no incidents on the shelf. the estate has not failed on record yet; this deck waits for the first one. (a ground test can stage a drill.)");
        return;
      }
      els.picker.innerHTML = state.incidents.map(function (inc) {
        var label = hhmmss(inc.ts) + " \u00B7 " + (inc.trigger && inc.trigger.title ? inc.trigger.title : "failure") +
          (inc.trigger_count > 1 ? " (+" + (inc.trigger_count - 1) + ")" : "");
        return '<option value="' + esc(inc.id) + '">' + esc(label.slice(0, 72)) + "</option>";
      }).join("");
      loadIncident(state.incidents[0].id);
    }).catch(function () {
      els.deck.hidden = true;
      showEmpty("recorder unreachable. the black box is behind api.atlas-systems.uk; when it answers again, the incidents will still be there. that is the point of it.");
    });
  }

  init();

  /* Exposed for the smoke test only; nothing on the page depends on it. */
  window.AtlasBlackboxTimeline = { telemetryAt: telemetryAt, lerp: lerp, flattenEvents: flattenEvents };
})();
