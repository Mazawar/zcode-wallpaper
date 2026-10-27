/**
 * Flight recorder — a ring buffer read after an incident instead of guessing.
 * Layer lifecycle (from the state machine), DOM ADD/REMOVE/ATTR trails,
 * visibility, engine messages, and periodic invariants snapshots.
 */

export const MARKER = "zcode-wallpaper";

export function createRecorder(reg) {
  // Singleton = the ring buffer + rec() only: they survive agent re-injections
  // (heartbeat teardown + heal re-eval) so the timeline stays continuous. The
  // SENSORS below are per-agent — they live in THIS agent's reg and are
  // cleaned by ITS teardown, so every agent must install its own. (1.0.0
  // regression: a re-created agent got the singleton back and skipped the
  // sensor block — ADD/REMOVE/MSG/ENGINE/VIS trails went dark exactly when a
  // heal re-injection had happened, i.e. exactly during incidents.)
  if (!window.__zwRec) {
    window.__zwLog = [];
    let lastEntry = ""; // dedupe runs of identical entries (771 identical page
    // errors once evicted every other diagnostic from the 800-slot ring)
    window.__zwRec = function (tag, d) {
      try {
        const line = tag + "|" + (d === undefined ? "" : String(d));
        if (line === lastEntry) return;
        lastEntry = line;
        window.__zwLog.push({ t: new Date().toISOString().slice(11, 23), tag: tag, d: d === undefined ? "" : String(d).slice(0, 160) });
        if (window.__zwLog.length > 800) window.__zwLog.shift();
      } catch (e) { /* recorder must never break the runtime */ }
    };
  }
  const rec = window.__zwRec;
  try {
    const obs = new MutationObserver(function (muts) {
      muts.forEach(function (mu) {
        if (mu.removedNodes) Array.prototype.forEach.call(mu.removedNodes, function (n) {
          if (n.id && String(n.id).indexOf(MARKER) === 0) rec("REMOVE", n.id + " @ " + (mu.target.id || mu.target.tagName));
        });
        if (mu.addedNodes) Array.prototype.forEach.call(mu.addedNodes, function (n) {
          if (n.id && String(n.id).indexOf(MARKER) === 0) rec("ADD", n.id);
        });
        if (mu.type === "attributes" && mu.target.id && String(mu.target.id).indexOf(MARKER) === 0)
          rec("ATTR", mu.target.id + "." + mu.attributeName);
      });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "src"] });
    reg.observer(obs);
    reg.on(document, "visibilitychange", function () { rec("VIS", document.hidden ? "hidden" : "visible"); });
    reg.on(window, "message", function (ev) {
      if (!ev.data || !ev.data.zwEvent) return;
      const d = ev.data;
      if (d.zwEvent === "hb2") rec("ENGINE", "fps=" + d.fps + " paused=" + d.paused + " poster=" + d.poster);
      else rec("MSG", d.zwEvent + (d.message ? " " + String(d.message).slice(0, 80) : ""));
    });
    // Periodic state snapshot: silent changes (css rewrites, style attr churn)
    // leave no mutation trail — poll the invariants. Only CHANGES are recorded:
    // an unconditional 3s entry floods the 800-slot ring in 40 minutes and
    // evicts the very transitions an incident review needs.
    let lastSnap = "";
    reg.every(function () {
      const st = document.getElementById(MARKER + "-style");
      const lv = document.getElementById(MARKER + "-live");
      const bd = document.getElementById(MARKER + "-backdrop");
      const line = "css=" + (st ? st.textContent.length : 0) + " live=" + (lv ? getComputedStyle(lv).opacity : "-") + " bd=" + (bd ? bd.dataset.on : "-");
      if (line !== lastSnap) {
        lastSnap = line;
        rec("SNAP", line);
      }
    }, 3000);
    reg.on(window, "error", function (e) { rec("PAGEERR", (e.message || "") + " @" + (e.lineno || 0)); });
  } catch (e) { /* never break the runtime */ }
  rec("BOOT", "agent runtime installed");
  return rec;
}
