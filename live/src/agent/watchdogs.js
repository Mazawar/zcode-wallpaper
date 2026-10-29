/**
 * Machine sensors that live on timers/visibility:
 *
 *  - hidden-pause: Chromium re-evaluates occlusion when the window's visual
 *    composition changes (opening settings, overlays) and can flip the page
 *    hidden→visible within a moment — an instant pause froze the last frame
 *    to a JPEG (visibly darker) that the resume then peeled off. Only a
 *    HIDDEN state that persists 1.5s pauses the renderer.
 *  - video-kick: Chromium can mis-detect transparent Electron windows as
 *    occluded and freeze the media pipeline (paused stays false, the clock
 *    stops). Page code cannot lift the occlusion — only real window
 *    interaction can — but once the window wakes we thaw immediately.
 *  - wake: any real window interaction wakes an auto-paused renderer (the
 *    renderer ignores this when the user paused it manually).
 */

export function createWatchdogs({ reg, machine, video, postAll }) {
  // ── hidden-pause (debounced 1.5s) ──────────────────────────────────────────
  // The machine's PAUSE/RESUME bookkeeping is live-scoped; for the video kind
  // the element's own paused state is the truth (firing live-only events there
  // would just pile rejected records).
  let pendingPause = null;
  function schedulePause() {
    if (pendingPause) return;
    pendingPause = setTimeout(function () {
      pendingPause = null;
      if (!document.hidden) return;
      video.pause();
      postAll({ zw: "pause" });
      if (machine.kind === "live") machine.fire("PAUSE");
    }, 1500);
  }
  function cancelPause() {
    if (pendingPause) { clearTimeout(pendingPause); pendingPause = null; }
  }
  reg.on(document, "visibilitychange", function () {
    if (document.hidden) {
      schedulePause();
    } else {
      cancelPause();
      video.resume();
      postAll({ zw: "resume" });
      if (machine.phase === "live/paused") machine.fire("RESUME");
    }
  });

  // ── wake on real interaction ──────────────────────────────────────────────
  const wake = function () {
    video.resume();
    postAll({ zw: "resume" });
    if (machine.phase === "live/paused") machine.fire("RESUME");
  };
  reg.on(window, "focus", wake);
  reg.on(document, "pointerdown", wake, true);
  reg.on(window, "pageshow", wake);

  // ── video-kick (frozen media pipeline) ────────────────────────────────────
  let stallCount = 0;
  let lastClock = -1;
  const kickVideo = function () {
    const v = video.findVideo();
    if (!v || document.hidden) return;
    if (v.ended || (v.paused && v.autoplay && !video.userPaused())) {
      stallCount = 0;
      v.play().catch(function () {});
    } else if (!v.paused && v.readyState >= 2 && lastClock === v.currentTime) {
      stallCount++;
      if (stallCount >= 1) { v.load(); }
      v.play().catch(function () {});
    } else {
      stallCount = 0;
    }
    lastClock = v.currentTime;
  };
  reg.every(kickVideo, 2000);
  reg.on(document, "pointerdown", function () { requestAnimationFrame(kickVideo); }, { capture: true, passive: true });
  reg.on(window, "focus", function () { requestAnimationFrame(kickVideo); });
  reg.on(document, "visibilitychange", function () {
    if (!document.hidden) requestAnimationFrame(kickVideo);
  });

  return { kickVideo };
}
