/**
 * The live renderer iframe actor (WebWallGL). All DOM code here is the
 * battle-tested applier from the pre-0.4.0 agent; what changed is that the
 * machine now owns the phase (main fires SET_SOURCE / SWITCH_BEGIN / READY on
 * what this actor reports back).
 *
 * applySrc returns what it did — "mount" | "hot" | "switch" | "removed" — so
 * the machine records reality instead of predicting it.
 */

import { MARKER } from "./recorder.js";

function queryOf(u) {
  const out = {};
  try {
    const q = new URL(u, location.href).searchParams;
    ["type", "src", "file", "fit", "fps", "muted", "poster", "dpr", "aa", "pq", "pp", "vts"].forEach(function (k) { out[k] = q.get(k) || ""; });
  } catch (e) { /* bad url */ }
  return out;
}

export function createLiveFrame({ reg, rec, wpRoot, bridge }) {
  let applied = ""; // LAST APPLIED url — hot-updates never rewrite the attribute
  let api = "";

  function frames() {
    return Array.prototype.slice.call(document.querySelectorAll("#" + MARKER + "-live, #" + MARKER + "-live-next"));
  }
  function postAll(msg) {
    frames().forEach(function (f) {
      try { f.contentWindow.postMessage(msg, "*"); } catch (e) { /* mid-swap */ }
    });
  }
  function makeFrame(id, src, extraCss) {
    const f = document.createElement("iframe");
    f.id = id;
    f.setAttribute("allow", "autoplay");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;background:transparent;" + (extraCss || "");
    f.setAttribute("src", src);
    return f;
  }
  /** Promotes a pending transition iframe to be THE live frame immediately. */
  function promoteNext() {
    const cur = document.getElementById(MARKER + "-live");
    const next = document.getElementById(MARKER + "-live-next");
    if (!next) return;
    if (cur) cur.remove();
    next.id = MARKER + "-live";
    next.style.transition = "none";
    next.style.opacity = "1";
    const tr = window.__zw && window.__zw.tr;
    if (tr) { clearTimeout(tr.timer); window.removeEventListener("message", tr.onMsg); window.__zw.tr = null; }
  }

  /**
   * @param {string} src live renderer URL ("" = no live layer wanted)
   * @param {{trans?:string,tspd?:number,apiBase?:string,videoIncoming?:boolean}} opts
   */
  function applySrc(src, opts) {
    opts = opts || {};
    const TRANS = opts.trans || "fade";
    const TSPD = opts.tspd || 600;
    api = opts.apiBase || api;
    // A rapid switch during an in-flight transition: a re-apply of the SAME
    // target (the two-phase publish of one apply-source) keeps the pending
    // switch — promoting now would drop the old cover before the new frame
    // renders. A DIFFERENT target jumps to the pending switch's end first.
    const pending = document.getElementById(MARKER + "-live-next");
    if (pending) {
      if (src && (pending.getAttribute("src") || "") === src) {
        applied = src;
        bridge.start();
        return "switch";
      }
      promoteNext();
    }
    const cur = document.getElementById(MARKER + "-live");
    if (!src) {
      // No live layer (switching to video/image): fade the engine out. When a
      // VIDEO is incoming, hold the old visual until the preplay committed
      // (3s cap) — fading early leaves a dark gap while the video assembles.
      const holdMs = opts.videoIncoming ? 3000 : 0;
      frames().forEach(function (f) {
        const fo = f;
        setTimeout(function () {
          fo.style.transition = "opacity .6s ease";
          fo.style.opacity = "0";
          setTimeout(function () { fo.remove(); }, 660);
        }, holdMs);
      });
      applied = "";
      return "removed";
    }
    if (!cur) {
      if (TRANS === "cut") {
        wpRoot().appendChild(makeFrame(MARKER + "-live", src, "opacity:1;"));
        applied = src;
        bridge.start();
        return "mount";
      }
      // First mount (page load, heartbeat self-clean, plugin re-enable):
      // fade in from the app's own background instead of popping in.
      const first = makeFrame(MARKER + "-live", src, "opacity:0;transition:opacity .6s ease;");
      wpRoot().appendChild(first);
      applied = src;
      bridge.start();
      let settled = false;
      let firstTimer = 0;
      const onFirstReady = function (ev) {
        if (ev.data && ev.data.zwEvent === "ready" && first.contentWindow === ev.source) {
          settled = true;
          first.style.opacity = "1";
          window.removeEventListener("message", onFirstReady);
          clearTimeout(firstTimer);
        }
      };
      window.addEventListener("message", onFirstReady);
      firstTimer = reg.timer(function () {
        if (!settled) { first.style.opacity = "1"; window.removeEventListener("message", onFirstReady); }
      }, 10000);
      return "mount";
    }
    // Compare against the LAST APPLIED url, not the frame's src attribute:
    // hot-updates never rewrite the attribute (that would navigate/reload),
    // so attribute comparison makes the second toggle of a param a silent
    // no-op — the volume command never ships.
    const appliedUrl = applied || cur.getAttribute("src") || "";
    if (appliedUrl === src) { bridge.start(); return "hot"; }
    const a = queryOf(appliedUrl);
    const b = queryOf(src);
    if (a.src && a.src === b.src && a.type === b.type) {
      // Same wallpaper, only fit/fps/muted/quality changed: hot-update via
      // postMessage (setting src would reload the iframe and flash). The D20
      // render knobs ride along when the URL carries them (pre-D20 URLs
      // simply omit them and keep their legacy behavior).
      var msg = { zw: "cfg", fit: b.fit, fps: Number(b.fps) || 30, volume: b.muted === "0" ? 1 : 0 };
      if (b.dpr !== "") msg.dpr = b.dpr;
      if (b.aa !== "" || b.pq !== "" || b.pp !== "") msg.q = { aa: b.aa, pq: b.pq, pp: b.pp };
      if (b.vts !== "") msg.vts = Number(b.vts);
      postAll(msg);
      applied = src;
      bridge.start();
      return "hot";
    }
    // Same-kind switch: MOUNT A FRESH FRAME. webwallgl 3.0.0's load() is not
    // re-entrant — a second load() on one instance rejects with a shader
    // compile failure (same source included), so in-place loads are retired
    // (D15). The new frame is inserted UNDER the current one: the old picture
    // stays on top as the live cover of the assembly and leaves with the
    // chosen effect the moment the new engine reports ready. The old WebGL
    // context dies only after the new one renders — no destroy/create churn.
    const next = makeFrame(MARKER + "-live-next", src, "");
    wpRoot().insertBefore(next, cur); // under cur: cur is the transition cover
    applied = src;
    bridge.start();
    let settled = false;
    const commitSwitch = function () {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onSwitchReady);
      clearTimeout(leaveTimer);
      if (TRANS === "cut") { cur.remove(); next.id = MARKER + "-live"; return; }
      const t = TSPD + "ms cubic-bezier(.4,0,.2,1)";
      switch (TRANS) {
        case "push":
          cur.style.transition = "transform " + t;
          cur.style.transform = "translateX(100%)";
          break;
        case "wipe":
          cur.style.transition = "clip-path " + t;
          cur.style.clipPath = "inset(0 0 0 100%)";
          break;
        case "iris":
          cur.style.transition = "clip-path " + t;
          cur.style.clipPath = "circle(0% at 50% 50%)";
          break;
        case "zoom":
          cur.style.transition = "transform " + t + ", opacity " + t;
          cur.style.transform = "scale(1.18)";
          cur.style.opacity = "0";
          break;
        default: // fade
          cur.style.transition = "opacity " + t;
          cur.style.opacity = "0";
      }
      reg.timer(function () { cur.remove(); }, TSPD + 80);
      next.id = MARKER + "-live";
    };
    const onSwitchReady = function (ev) {
      if (!ev.data || ev.data.zwEvent !== "ready" || next.contentWindow !== ev.source) return;
      commitSwitch();
    };
    window.addEventListener("message", onSwitchReady);
    // The ledger owns the switch verdict (a failed source downgrades to
    // poster-only, whose payload tears both frames down); this long cap is
    // only the no-verdict belt — uncover the new frame's own poster instead
    // of holding a stale cover forever.
    const leaveTimer = reg.timer(commitSwitch, 60000);
    return "switch";
  }

  return {
    applySrc,
    postAll,
    frames,
    get applied() { return applied; },
    reset() { applied = ""; },
  };
}
