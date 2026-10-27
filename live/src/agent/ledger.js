/**
 * Transfer ledger sensor (D7): while the live layer is loading, poll serve's
 * byte accounting — "still downloading" must never be misread as "failing to
 * render". Bytes moving resets the stall clock; a static, incomplete transfer
 * is a SOFT failure (retryable); a complete transfer with no engine ready is
 * a HARD failure (renderer). Budget for the overall wait derives from the
 * payload size (D8).
 */

import {
  LEDGER_CAP_MS,
  LEDGER_TICK_MS,
  classifyFailure,
  firstFrameBudgetMs,
} from "../state.js";

export function createLedger({ apiBase, rec, onVerdict }) {
  let timer = null;
  let sourceId = "";
  let totalBytes = 0;
  let lastBytes = -1;
  let stallTicks = 0;
  let startedAt = 0;
  let budgetMs = 0;
  let budgetFromSize = false;

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function tick() {
    if (!sourceId) return;
    if (document.hidden) {
      // A hidden page cannot produce frames (rAF is throttled) — "no ready
      // yet" is not a renderer failure while hidden. Freeze the budget clock
      // and the stall counter; they resume when the page shows again. (A
      // switch picked while the window was in the background used to burn
      // its whole budget unseen and arrive at a false renderer verdict.)
      startedAt = Date.now();
      return;
    }
    const url = apiBase + "/api/transfer?id=" + encodeURIComponent(sourceId);
    fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || typeof d.bytes !== "number" || !timer) return;
      if (d.total && !budgetFromSize) {
        budgetFromSize = true;
        budgetMs = firstFrameBudgetMs(d.total); // D8: budget derives from size
        rec("LEDGER", "total=" + d.total + " budget=" + Math.round(budgetMs) + "ms");
      }
      if (d.bytes > lastBytes) {
        lastBytes = d.bytes;
        stallTicks = 0; // still downloading — not a render failure
      } else {
        stallTicks++;
      }
      // Two ways to give up (docs/STATE.md): a STUCK TRANSFER (static and
      // incomplete) fails soft at LEDGER_STALL_TICKS; a complete-but-silent
      // transfer is only ruled a renderer failure when the OVERALL first-frame
      // budget is spent — assembly after delivery takes unbounded seconds.
      const stalled = classifyFailure({ bytesComplete: d.bytes >= d.total, stallTicks });
      const budgetSpent = Date.now() - startedAt > Math.max(budgetMs, LEDGER_CAP_MS);
      if (stalled === "transfer" || budgetSpent) {
        stop();
        const complete = d.bytes >= d.total;
        onVerdict(budgetSpent ? (complete ? "renderer" : "transfer") : "transfer");
      }
    }).catch(function () {
      // Serve briefly unreachable (busy loop): tolerate, keep polling; the
      // heartbeat's hard-fail path owns the really-gone case.
    });
  }

  return {
    /** Start watching a live source load. */
    watch(id, sizeBytes) {
      stop();
      if (!id) return;
      sourceId = id;
      totalBytes = sizeBytes || 0;
      lastBytes = -1;
      stallTicks = 0;
      startedAt = Date.now();
      budgetMs = firstFrameBudgetMs(totalBytes);
      rec("LEDGER", "watch " + id + " budget=" + Math.round(budgetMs) + "ms" + (totalBytes ? " size=" + totalBytes : ""));
      timer = setInterval(tick, LEDGER_TICK_MS);
    },
    /** The engine reported ready — success, no verdict needed. */
    settle() { stop(); },
    stop,
  };
}
