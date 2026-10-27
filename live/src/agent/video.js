/**
 * Native video actor (D2): videos never enter the WebGL engine — the engine's
 * pause clears the WebCodecs canvas and its scheduler fast-forwards on wake.
 * A native element pauses on its last frame and preplays OFFSCREEN (dsh's
 * prepareVideoProbe): the new video reaches canplay while detached, then
 * commits already playing — on screen it is a live picture immediately.
 *
 * The DOM code is the proven pre-0.4.0 applier; the machine learns through
 * the callbacks (onEnter / onReady / onLeaveDone).
 */

import { MARKER } from "./recorder.js";

export function createVideoActor({ reg, rec, wpRoot, onReady }) {
  const S = (window.__zw = window.__zw || {});
  let currentSrc = ""; // committed element's src

  function findVideo() { return document.getElementById(MARKER + "-video"); }

  /**
   * @param {string} src video URL ("" = no video layer wanted)
   * @param {{muted?:boolean,fit?:string,liveIncoming?:boolean}} opts
   */
  function apply(src, opts) {
    opts = opts || {};
    const VMUTED = opts.muted !== false;
    const VFIT = opts.fit === "contain" ? "contain" : opts.fit === "stretch" ? "fill" : "cover";
    const vid = findVideo();
    if (src) {
      if (wpRoot()) wpRoot().style.backgroundImage = "none";
      if (vid && vid.getAttribute("src") === src) {
        // Self-heal: an element that errored once (its fetch hit a serve
        // restart mid-boot) stays dead forever unless load() restarts it.
        if (vid.error) vid.load();
        vid.muted = VMUTED; // hot-update: same video, muted/fit tweak
        vid.style.objectFit = VFIT;
        vid.play().catch(function () {});
        return "hot";
      }
      if (S.videoPrepSrc === src) {
        // A preplay for this exact video is already in flight — boot pushes
        // overlap inside the 3s preplay window. Starting a second one tears
        // the first mount down the moment it commits.
        return "prep-pending";
      }
      S.videoPrepSrc = src;
      S.videoPrepToken = (S.videoPrepToken || 0) + 1;
      const myToken = S.videoPrepToken;
      const nv = document.createElement("video");
      nv.setAttribute("autoplay", "");
      nv.setAttribute("loop", "");
      nv.setAttribute("playsinline", "");
      nv.muted = VMUTED;
      nv.src = src;
      nv.load();
      let committed = false;
      const commit = function () {
        if (committed) return;
        if (S.videoPrepToken !== myToken) return; // superseded by a newer pick
        committed = true;
        S.videoPrepSrc = null;
        // The outgoing video FADES OUT while the preplayed one fades in —
        // removing it up front leaves a hard black gap under the fade.
        const old = findVideo();
        if (old) {
          old.removeAttribute("id");
          old.style.transition = "opacity .6s ease";
          old.style.opacity = "0";
          reg.timer(function () { old.remove(); }, 660);
        }
        nv.id = MARKER + "-video";
        nv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:" + VFIT + ";opacity:0;transition:opacity .6s ease;";
        wpRoot().appendChild(nv);
        nv.play().catch(function () {});
        requestAnimationFrame(function () { nv.style.opacity = "1"; });
        reg.timer(function () { if (nv.style) nv.style.transition = "none"; }, 660);
        currentSrc = src;
        if (onReady) onReady();
      };
      nv.addEventListener("canplay", commit, { once: true });
      // A load error must NOT commit a dead element — error 4 never self-heals.
      // Restart the load once; the 3s timeout commits whatever state remains.
      nv.addEventListener("error", function onErr() {
        nv.removeEventListener("error", onErr);
        if (S.videoPrepToken === myToken) reg.timer(function () { nv.load(); }, 800);
      }, { once: true });
      reg.timer(commit, 3000);
      nv.play().catch(function () {});
      return "prep";
    }
    // Switching away from a video: hold it until the incoming layer is
    // actually on screen — for a live source that's the engine's ready signal
    // (4s cap), otherwise fade at once.
    if (vid) {
      const vOut = vid;
      const startFade = function () {
        vOut.style.transition = "opacity .6s ease";
        vOut.style.opacity = "0";
        reg.timer(function () { vOut.remove(); }, 660);
      };
      if (opts.liveIncoming) {
        let heardR = false;
        const onR = function (ev) {
          if (heardR) return;
          if (ev.data && ev.data.zwEvent === "ready") {
            heardR = true;
            window.removeEventListener("message", onR);
            clearTimeout(rT);
            startFade();
          }
        };
        window.addEventListener("message", onR);
        const rT = setTimeout(function () {
          if (!heardR) {
            heardR = true;
            window.removeEventListener("message", onR);
            startFade();
          }
        }, 4000);
      } else {
        startFade();
      }
      currentSrc = "";
    }
    return "removed";
  }

  return {
    apply,
    findVideo,
    get currentSrc() { return currentSrc; },
    pause() { const v = findVideo(); if (v) v.pause(); },
    resume() { const v = findVideo(); if (v) v.play().catch(function () {}); },
  };
}
