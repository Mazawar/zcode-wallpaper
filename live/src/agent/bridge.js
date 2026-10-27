/**
 * Pointer/wheel bridge into the live renderer iframe(s) — real mouse position
 * drives scene parallax at rAF frequency.
 */

export function createBridge(reg, frames, rec) {
  let bound = false;
  function postAll(msg) {
    frames().forEach(function (f) {
      try { f.contentWindow.postMessage(msg, "*"); } catch (e) { /* mid-swap */ }
    });
  }
  function start() {
    if (bound) return;
    bound = true;
    let latest = null, queued = false;
    function flush() {
      queued = false;
      if (!latest) return;
      postAll({ zw: "ptr", u: latest.u, v: latest.v, buttons: latest.buttons, mods: latest.mods });
      latest = null;
    }
    function coords(e) {
      return { u: Math.max(0, Math.min(1, e.clientX / Math.max(1, window.innerWidth))),
               v: Math.max(0, Math.min(1, e.clientY / Math.max(1, window.innerHeight))),
               buttons: e.buttons, mods: (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0) };
    }
    reg.on(document, "pointermove", function (e) {
      latest = coords(e);
      if (!queued) { queued = true; requestAnimationFrame(flush); }
    }, { capture: true, passive: true });
    reg.on(document, "pointerdown", function (e) {
      latest = coords(e);
      flush();
    }, { capture: true, passive: true });
    reg.on(document, "pointerup", function () {
      postAll({ zw: "ptrup" });
    }, { capture: true, passive: true });
    reg.on(document, "wheel", function (e) {
      postAll({ zw: "wheel", dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode,
        mods: (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0) });
    }, { capture: true, passive: true });
    reg.on(window, "blur", function () {
      postAll({ zw: "ptrleave" });
    });
  }
  return { start, postAll };
}
