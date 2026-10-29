/**
 * Agent runtime assembly — the single applier (D1/D5).
 *
 * Loaded by the thin CDP bootstrap via <script src="/agent.js">. Sources of
 * state: window.__zwPayload (embedded head start), then SSE /api/events.
 * Every payload goes through apply(): the machine owns the phase, actors own
 * the DOM, sensors only fire events. One applier = no evaluate/re-register/
 * heal races.
 */

import { createMachine, KIND } from "../state.js";
import { createRecorder, MARKER } from "./recorder.js";
import { createBridge } from "./bridge.js";
import { createLiveFrame } from "./liveframe.js";
import { createVideoActor } from "./video.js";
import { createWatchdogs } from "./watchdogs.js";
import { createLedger } from "./ledger.js";

(function () {
  if (window.__zwAgent) return;
  window.__zwAgent = true;

  const S = (window.__zw = window.__zw || {});
  const API =
    window.__zwApiBase ||
    "http://127.0.0.1:" + ((window.__zwPayload && window.__zwPayload.apiPort) || 28257);

  // ── teardown registry (heartbeat / reset call this when serve goes away) ──
  const timers = [];
  const listeners = []; // [target, type, fn, opts]
  const observers = [];
  const reg = {
    every(fn, ms) { const t = setInterval(fn, ms); timers.push(t); return t; },
    timer(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; },
    on(target, type, fn, opts) { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); },
    observer(o) { observers.push(o); },
  };

  const rec = createRecorder(reg);

  // Current payload-derived values (shared with actors via apply() opts).
  let VIDEO_SRC = "", LIVE_SRC = "", TRANS = "fade", TSPD = 600;
  let VMUTED = true, VFIT = "cover", WPIMG = "", FIT = "cover", UNDERLAY = "";
  let BLURON = false; // payload.wallBlur — layer blur needs the backdrop underlay (D16)
  let failedInfo = null; // payload.liveFailed — degraded, poster-only mode

  function wpRoot() { return document.getElementById(MARKER + "-wallpaper"); }

  // The bridge posts into the live frames; liveframe needs the bridge to
  // start() — break the cycle with a lazy getter.
  let liveframe;
  const bridge = createBridge(reg, () => liveframe.frames(), rec);
  liveframe = createLiveFrame({ reg, rec, wpRoot, bridge });
  const video = createVideoActor({ reg, rec, wpRoot, onReady: () => machine.fire("VREADY") });
  const ledger = createLedger({
    apiBase: API,
    rec,
    onVerdict: (reason) => machine.fire("BUDGET_EXHAUSTED", { reason }),
  });
  const heal = null; // retired 0.4.8 — declarative CSS rule in the payload (D9)

  // ── the machine: every transition is visible; failures carry policy ──────
  const machine = createMachine(function (ev) {
    if (ev.rejected) { rec("MACH", "! " + ev.event + " @ " + ev.from + " rejected"); return; }
    rec("MACH", ev.from + " --" + ev.event + (ev.data && ev.data.reason ? "(" + ev.data.reason + ")" : "") + "--> " + ev.to);
    if (ev.to === "live/failed") onLiveFailed(ev.data && ev.data.reason);
    if (ev.to === "live/shown" || ev.to === "live/switching") {
      if (ev.event === "READY" || ev.event === "SWITCH_READY") ledger.settle();
    }
  });

  function currentSourceId() {
    try {
      const q = new URL(LIVE_SRC, location.href).searchParams;
      return q.get("src") || "";
    } catch (e) { return ""; }
  }

  /** live/failed: soft failures retry in-session; hard failures report to
   *  serve, whose republished (downgraded) payload walks us to poster. */
  function onLiveFailed(reason) {
    if (reason === "transfer") {
      const wait = machine.scheduleSoftRetry();
      if (wait != null) {
        rec("LIVEFAIL", "soft (transfer) — retry in " + wait + "ms");
        reg.timer(function () {
          if (machine.phase !== "live/failed") return;
          liveframe.reset(); // force a fresh comparison, not a hot no-op
          machine.fire("RETRY", { hasPoster: false });
          const mode = liveframe.applySrc(LIVE_SRC, { trans: TRANS, tspd: TSPD, apiBase: API });
          // reset() with the old frame still in the DOM makes the retry a
          // fresh-frame SWITCH — the budget must cover that path too.
          if (mode === "mount" || mode === "switch") ledger.watch(currentSourceId());
        }, wait);
        return;
      }
      reason = "transfer-exhausted"; // retries spent — escalate to hard
    }
    rec("LIVEFAIL", "hard (" + reason + ") — reporting to serve");
    const id = currentSourceId();
    if (id) {
      fetch(API + "/api/live-verdict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: id, reason: reason }),
      }).catch(function () {});
    }
  }

  createWatchdogs({ reg, machine, video, postAll: bridge.postAll });

  // Engine signals: ready (first mount, fresh-frame switch, renderer
  // self-reload) and error (assembly failure — shader compile, broken pkg).
  reg.on(window, "message", function (ev) {
    // User pause/resume from the settings panel (same document, posted on
    // window — the panel must not poke the video element directly: state
    // the kick/wake watchdogs consult lives here, not on the element).
    if (ev.data && ev.data.user === true && (ev.data.zw === "pause" || ev.data.zw === "resume")) {
      if (ev.data.zw === "pause") video.pause(true);
      else video.resume(true);
      return;
    }
    if (!ev.data || !ev.data.zwEvent) return;
    if (ev.data.zwEvent === "error") {
      // A load that cannot assemble fails NOW — burning the whole first-frame
      // budget on a scene whose shaders already failed to compile helps no one.
      rec("ENGINE", "error " + String(ev.data.message || "").slice(0, 90));
      if (machine.phase === "live/loading" || machine.phase === "live/switching") {
        machine.fire("BUDGET_EXHAUSTED", { reason: "engine" });
      }
      return;
    }
    if (ev.data.zwEvent !== "ready") return;
    if (machine.phase === "live/loading") machine.fire("READY");
    else if (machine.phase === "live/switching") machine.fire("SWITCH_READY");
    // live/shown: the renderer self-healed and reloaded — phase stays.
  });

  // ── THE payload applier ────────────────────────────────────────────────────
  function apply(payload) {
    if (!payload) return;
    VIDEO_SRC = payload.videoSrc || "";
    LIVE_SRC = payload.liveSrc || "";
    TRANS = payload.transition === "cut" ? "cut" : payload.transition || "fade";
    TSPD = ({ fast: 260, normal: 600, slow: 1100 })[payload.transitionSpeed] || 600;
    VMUTED = payload.videoMuted !== false;
    VFIT = payload.fit === "contain" ? "contain" : payload.fit === "stretch" ? "fill" : "cover";
    WPIMG = payload.wallpaperDataUri || "";
    FIT = payload.fit || "cover";
    UNDERLAY = payload.livePoster || "";
    BLURON = payload.wallBlur === true;
    failedInfo = payload.liveFailed || null;

    if (S.cssText === payload.css && S.videoSrc === VIDEO_SRC && S.liveSrc === LIVE_SRC && S.trans === TRANS) return;
    S.cssText = payload.css;
    S.videoSrc = VIDEO_SRC;
    S.liveSrc = LIVE_SRC;
    S.trans = TRANS;

    // Kind-independent bookkeeping: theme/transparent CSS + layer root.
    let style = document.getElementById(MARKER + "-style");
    if (!style) {
      style = document.createElement("style");
      style.id = MARKER + "-style";
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = payload.css;

    const kind = failedInfo
      ? KIND.LIVE // degraded: mediaType live, serve withheld liveSrc (D6)
      : LIVE_SRC ? KIND.LIVE
      : VIDEO_SRC ? KIND.VIDEO
      : WPIMG ? KIND.IMAGE
      : KIND.NONE;
    if (machine.kind !== kind) machine.fire("SET_SOURCE", { kind, hasPoster: !!failedInfo });

    let wp = wpRoot();
    if (WPIMG || VIDEO_SRC || LIVE_SRC || (kind === KIND.LIVE && UNDERLAY)) {
      if (!wp) {
        wp = document.createElement("div");
        wp.id = MARKER + "-wallpaper";
        document.documentElement.appendChild(wp);
      }
    } else if (wp) {
      wp.remove();
    }

    // Live actor: mounting/switching reports back and steers the machine.
    // hasPoster:false on entry — the poster phase is RESERVED for degraded
    // (failedInfo) payloads; a real live URL always enters loading.
    if (kind === KIND.LIVE && !failedInfo) {
      // Normalize the phase BEFORE the actor runs: a live payload can arrive
      // in any phase (paused — a switch while the window was in the
      // background; stalled; failed). SET_SOURCE is the universal event;
      // after it we are in live/loading and mount/switch events are always
      // declared. (0.4.16: SWITCH_BEGIN fired from live/paused was rejected,
      // yet the DOM switch had already happened — a silently lost switch.)
      if (machine.phase !== "live/loading" && machine.phase !== "live/shown" && machine.phase !== "live/switching") {
        machine.fire("SET_SOURCE", { kind: KIND.LIVE, hasPoster: false });
      }
      const mode = liveframe.applySrc(LIVE_SRC, { trans: TRANS, tspd: TSPD, apiBase: API, videoIncoming: false });
      S.appliedLive = liveframe.applied || "";
      if (mode === "mount") {
        ledger.watch(currentSourceId());
      } else if (mode === "switch") {
        if (machine.phase !== "live/switching") machine.fire("SWITCH_BEGIN");
        if (machine.phase === "live/switching") ledger.watch(currentSourceId());
      }
    } else if (kind === KIND.LIVE && failedInfo) {
      liveframe.applySrc("", {}); // degraded: poster-only, no engine layer
      S.appliedLive = "";
    } else if (liveframe.frames().length) {
      // Video/image payloads must retire a leftover engine frame: it keeps
      // burning GPU under the new layer (and covers an image — the iframe
      // paints over the layer's background-image).
      liveframe.applySrc("", { videoIncoming: kind === KIND.VIDEO });
      S.appliedLive = "";
    }

    // Video actor: removal also runs when switching live←video (hold-for-ready
    // fade handled inside via liveIncoming).
    if (kind === KIND.VIDEO) {
      video.apply(VIDEO_SRC, { muted: VMUTED, fit: VFIT });
    } else {
      video.apply("", { liveIncoming: kind === KIND.LIVE && !failedInfo });
    }

    // Static image layer + blurred backdrop underlay (dsh ambient wash).
    if (kind !== KIND.VIDEO && WPIMG && wp) wp.style.backgroundImage = "url(" + WPIMG + ")";
    else if (kind !== KIND.VIDEO && wp && !LIVE_SRC && !failedInfo) wp.style.backgroundImage = "none";

    const bp = document.getElementById(MARKER + "-backdrop");
    // BLURON: the layer's blur filter bleeds past its edges into transparency
    // (D16) — the blurred backdrop of the same picture covers that bleed so
    // the framing needs no overscale.
    const underlayWanted =
      (FIT === "contain" && WPIMG) ||
      ((LIVE_SRC || failedInfo) && UNDERLAY) ||
      (BLURON && (WPIMG || UNDERLAY));
    if (underlayWanted) {
      let b = bp;
      if (!b) {
        b = document.createElement("div");
        b.id = MARKER + "-backdrop";
        document.documentElement.appendChild(b);
      }
      b.style.backgroundImage = "url(" + (WPIMG ? WPIMG : UNDERLAY) + ")";
      b.dataset.on = "1";
    } else if (bp) {
      bp.dataset.on = "0";
    }
    rec("APPLY", "kind=" + kind.split("/")[0] + " phase=" + machine.phase +
      " live=" + (LIVE_SRC ? "y" : failedInfo ? "failed" : "n") + " video=" + (VIDEO_SRC ? "y" : "n") + " img=" + (WPIMG ? "y" : "n"));
  }

  // ── SSE: config changes from serve (reconnect with capped backoff) ────────
  let sseHandle = null;
  function connectSse() {
    if (!window.EventSource) return;
    let es;
    try {
      es = new EventSource(API + "/api/events?client=agent");
    } catch (e) {
      return; // standalone (CLI direct) mode
    }
    sseHandle = es;
    let delay = 1000;
    es.addEventListener("cfg", function (ev) {
      try {
        apply(JSON.parse(ev.data));
      } catch (e) {
        rec("SSE", "bad payload");
      }
    });
    es.onopen = function () { delay = 1000; };
    es.onerror = function () {
      try { es.close(); } catch (e) {}
      if (sseHandle === es) sseHandle = null;
      const t = setTimeout(connectSse, delay);
      timers.push(t);
      delay = Math.min(30000, delay * 3);
    };
  }
  connectSse();

  // Head start: whatever the bootstrap embedded (fresh page, no round trip).
  apply(window.__zwPayload);

  // ── teardown (bootstrap heartbeat / reset script) ──────────────────────────
  window.__zwTeardownAgent = function () {
    if (sseHandle) { try { sseHandle.close(); } catch (e) {} sseHandle = null; }
    ledger.stop();
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    listeners.forEach(function (l) {
      try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {}
    });
    observers.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
    [MARKER + "-style", MARKER + "-wallpaper", MARKER + "-backdrop", MARKER + "-fade",
     MARKER + "-live", MARKER + "-live-next", MARKER + "-video"].forEach(function (id) {
      const n = document.getElementById(id);
      if (n) n.remove();
    });
    S.cssText = null;
    S.videoSrc = null;
    S.liveSrc = null;
    S.trans = null;
    window.__zwAgent = null;
    try { rec("TEARDOWN", "agent"); } catch (e) {}
  };
})();
