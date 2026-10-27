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
    ["type", "src", "file", "fit", "fps", "muted", "poster"].forEach(function (k) { out[k] = q.get(k) || ""; });
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
    // A rapid switch during an in-flight transition: jump to its end first.
    if (document.getElementById(MARKER + "-live-next")) promoteNext();
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
      const onFirstReady = function (ev) {
        if (ev.data && ev.data.zwEvent === "ready" && first.contentWindow === ev.source) {
          settled = true;
          first.style.opacity = "1";
          window.removeEventListener("message", onFirstReady);
          clearTimeout(firstTimer);
        }
      };
      window.addEventListener("message", onFirstReady);
      reg.timer(function () {
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
      // Same wallpaper, only fit/fps/muted changed: hot-update via postMessage
      // (setting src would reload the iframe and flash).
      postAll({ zw: "cfg", fit: b.fit, fps: Number(b.fps) || 30, volume: b.muted === "0" ? 1 : 0 });
      applied = src;
      bridge.start();
      return "hot";
    }
    // Same-kind switch: IN-PLACE LOAD on the existing frame (dsh's
    // setWallpaper). The engine reuses its WebGL context — remounting churned
    // destroy/create cycles that lost contexts under GPU pressure. A snapshot
    // of the old frame covers the assembly gap; it leaves with the chosen
    // effect on the renderer's ready signal.
    const oldOverlay = document.getElementById(MARKER + "-fade");
    if (oldOverlay) oldOverlay.remove();
    const doLoad = function (overlaySrc) {
      let overlay = null;
      if (overlaySrc) {
        overlay = document.createElement("img");
        overlay.id = MARKER + "-fade";
        overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;";
        overlay.src = overlaySrc;
        wpRoot().appendChild(overlay);
        let faded = false;
        const fadeOut = function () {
          if (faded) return;
          faded = true;
          const t = TSPD + "ms cubic-bezier(.4,0,.2,1)";
          switch (TRANS) {
            case "push":
              overlay.style.transition = "transform " + t;
              overlay.style.transform = "translateX(100%)";
              break;
            case "wipe":
              overlay.style.transition = "clip-path " + t;
              overlay.style.clipPath = "inset(0 0 0 100%)";
              break;
            case "iris":
              overlay.style.transition = "clip-path " + t;
              overlay.style.clipPath = "circle(0% at 50% 50%)";
              break;
            case "zoom":
              overlay.style.transition = "transform " + t + ", opacity " + t;
              overlay.style.transform = "scale(1.18)";
              overlay.style.opacity = "0";
              break;
            default: // fade
              overlay.style.transition = "opacity " + t;
              overlay.style.opacity = "0";
          }
          reg.timer(function () { overlay.remove(); }, TSPD + 80);
        };
        const onReady = function (ev) {
          if (ev.data && ev.data.zwEvent === "ready" && cur.contentWindow === ev.source) {
            fadeOut();
            window.removeEventListener("message", onReady);
          }
        };
        window.addEventListener("message", onReady);
        reg.timer(fadeOut, 10000); // engine never signaled: uncover anyway
      }
      try {
        cur.contentWindow.postMessage({ zw: "load", type: b.type, src: b.src, file: b.file || "", fit: b.fit, fps: Number(b.fps) || 30, muted: b.muted, poster: b.poster || "" }, "*");
      } catch (e) { /* frame gone — the watchdogs remount */ }
      applied = src;
      bridge.start();
    };
    if (TRANS === "cut") {
      doLoad("");
      return "switch";
    }
    // Poster fallback: even when the snapshot times out (jpeg-encoding a
    // 1080p canvas can take >250ms), the NEW wallpaper's poster covers the
    // assembly — a switch must never show a bare clearing canvas.
    const posterAbs = b.poster ? api + b.poster : "";
    let snapped = false;
    const onSnap = function (ev) {
      if (snapped || !ev.data || ev.data.zwEvent !== "snap" || !cur.contentWindow || ev.source !== cur.contentWindow) return;
      snapped = true;
      window.removeEventListener("message", onSnap);
      clearTimeout(snapTimer);
      doLoad(ev.data.dataUrl || posterAbs);
    };
    const snapTimer = setTimeout(function () {
      if (snapped) return;
      snapped = true;
      window.removeEventListener("message", onSnap);
      doLoad(posterAbs); // no snapshot in time — the poster still covers
    }, 700);
    window.addEventListener("message", onSnap);
    try {
      cur.contentWindow.postMessage({ zw: "snapshot" }, "*");
    } catch (e) {
      clearTimeout(snapTimer);
      window.removeEventListener("message", onSnap);
      doLoad(posterAbs);
    }
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
