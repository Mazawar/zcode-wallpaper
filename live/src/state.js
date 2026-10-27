/**
 * The wallpaper-layer state machine — single authority for layer phase (D5).
 *
 * PURE LOGIC: this module must not touch DOM, window, fetch or timers (the
 * guard `verify-live-machine.mjs` loads it in bare Node to keep it that way).
 * Actors (agent runtime) subscribe to transitions and do the DOM work; sensors
 * (watchdogs) only ever fire events. An undeclared transition is recorded and
 * ignored — never silently allowed.
 *
 * Spec: docs/STATE.md. Constants are named exports; docs quote names, not
 * values, so nothing drifts.
 */

// ── kinds & phases ──────────────────────────────────────────────────────────

export const KIND = { NONE: "none", IMAGE: "image", VIDEO: "video", LIVE: "live" };

export const STATES = {
  [KIND.NONE]: ["idle"],
  [KIND.IMAGE]: ["shown"],
  [KIND.VIDEO]: ["prep", "shown", "leaving"],
  [KIND.LIVE]: ["poster", "loading", "shown", "switching", "stalled", "paused", "failed"],
};

// ── events ──────────────────────────────────────────────────────────────────
// SET_SOURCE  — a config payload arrived (universal; target from payload kind)
// READY       — engine reported ready / video reached canplay
// SWITCH_BEGIN/READY — same-kind in-place load started / its engine ready
// STALL / STALL_PERSIST — frames stopped / stayed stopped past the budget
// PAUSE / RESUME — page hidden (debounced) or user pause / back
// BUDGET_EXHAUSTED — ledger gave up; data.reason: "transfer" | "renderer"
// RETRY — explicit retry (soft-retry timer / user button) from failed
// VLEAVE_BEGIN / VLEAVE_DONE — outgoing video starts / finishes its fade (reserved)
// CLEAR — layer removed entirely (reserved: teardown goes around the machine)
//
// Reserved events are declared for the model's completeness but not fired by
// the current agent; verify-live-machine.mjs keeps this list honest.

export const RESERVED_EVENTS = [
  // VLEAVE_*: the video fade is purely visual — no phase consumer yet.
  "VLEAVE_BEGIN", "VLEAVE_DONE",
  // STALL/STALL_PERSIST: mid-live frame stalls are self-healed inside the
  // renderer (it reloads and re-fires ready); an agent-side stall sensor is
  // a declared future upgrade, not current behavior.
  "STALL", "STALL_PERSIST",
  // CLEAR: teardown goes around the machine (the heartbeat tears everything).
  "CLEAR",
];

export const TRANSITIONS = {
  "none/idle": { SET_SOURCE: true },
  "image/shown": { SET_SOURCE: true, CLEAR: "none/idle" },
  "video/prep": { SET_SOURCE: true, VREADY: "video/shown", VLEAVE_BEGIN: "video/leaving", CLEAR: "none/idle" },
  "video/shown": { SET_SOURCE: true, VLEAVE_BEGIN: "video/leaving", CLEAR: "none/idle" },
  "video/leaving": { SET_SOURCE: true, VLEAVE_DONE: "none/idle" },
  "live/poster": {
    SET_SOURCE: true,
    // A poster phase with a real source arriving must be able to graduate:
    // 0.4.0-0.4.13 got stuck here (SWITCH_BEGIN rejected) when a payload
    // carried a live URL while the machine idled in poster.
    SWITCH_BEGIN: "live/switching",
    READY: "live/shown",
  },
  "live/loading": {
    SET_SOURCE: true,
    READY: "live/shown",
    SWITCH_BEGIN: true, // a re-pick during loading restarts it in place
    PAUSE: "live/paused",
    BUDGET_EXHAUSTED: "live/failed",
    STALL_PERSIST: "live/failed",
  },
  "live/shown": {
    SET_SOURCE: true,
    SWITCH_BEGIN: "live/switching",
    STALL: "live/stalled",
    PAUSE: "live/paused",
    CLEAR: "none/idle",
  },
  "live/switching": {
    SET_SOURCE: true,
    SWITCH_BEGIN: true, // rapid re-switch: restart the in-place load
    SWITCH_READY: "live/shown",
    PAUSE: "live/paused",
    BUDGET_EXHAUSTED: "live/failed",
    STALL_PERSIST: "live/failed",
  },
  "live/stalled": {
    SET_SOURCE: true,
    RESUME: "live/shown",
    STALL_PERSIST: "live/failed",
    PAUSE: "live/paused",
  },
  "live/paused": { SET_SOURCE: true, RESUME: "restore" },
  "live/failed": { SET_SOURCE: true, RETRY: "reenter", CLEAR: "none/idle" },
};

/** Entry phase per kind (used by SET_SOURCE / RETRY). */
export function entryPhase(kind, hasPoster) {
  if (kind === KIND.LIVE) return hasPoster ? "live/poster" : "live/loading";
  if (kind === KIND.VIDEO) return "video/prep";
  if (kind === KIND.IMAGE) return "image/shown";
  return "none/idle";
}

// ── failure policy (D6/D7/D8) ───────────────────────────────────────────────

export const LEDGER_TICK_MS = 1000;
export const LEDGER_STALL_TICKS = 8;
export const LEDGER_CAP_MS = 60000;
// The first-frame budget covers transfer AND assembly (shader compile,
// textures, particle systems — a delivered scene can legitimately take many
// seconds before its first frame). Bytes-complete says nothing yet; only the
// overall budget may rule a complete transfer a renderer failure.
export const FIRST_FRAME_BASE_MS = 12000;
export const FIRST_FRAME_BYTES_PER_MS = 2048;
export const FIRST_FRAME_CAP_MS = 40000;
export const SOFT_RETRY_LIMIT = 2;
export const SOFT_RETRY_DELAY_MS = 4000;
export const SWITCH_CAP_MS = 10000;
export const TRANSITION_HISTORY = 200;

/** First-frame budget from payload size — a wall clock that pretends 300 MB
 *  arrives in 4s turns every big scene into a false failure (D8). */
export function firstFrameBudgetMs(totalBytes) {
  if (!totalBytes || totalBytes <= 0) return FIRST_FRAME_BASE_MS;
  return Math.min(FIRST_FRAME_CAP_MS, FIRST_FRAME_BASE_MS + totalBytes / FIRST_FRAME_BYTES_PER_MS);
}

/**
 * Ledger verdict at a tick:
 *   "transfer" — bytes STATIC and INCOMPLETE for LEDGER_STALL_TICKS: the
 *                download itself is stuck → SOFT (session retry, capped)
 *   null       — keep waiting. A COMPLETE but silent transfer is NOT a
 *                failure here: assembly takes unbounded seconds after
 *                delivery; only the overall budget (caller) may rule it a
 *                renderer failure. (0.4.0 killed assembling scenes at 8s —
 *                "switch stuck on a static poster" — before this split.)
 */
export function classifyFailure({ bytesComplete, stallTicks }) {
  if (!bytesComplete && stallTicks >= LEDGER_STALL_TICKS) return "transfer";
  return null;
}

// ── the machine ─────────────────────────────────────────────────────────────

export function createMachine(onEvent) {
  let kind = KIND.NONE;
  let phase = "none/idle";
  let prePause = null; // phase to restore on RESUME
  let softRetries = 0;
  const history = [];

  function moveTo(target, event, data) {
    if (event === "PAUSE") prePause = phase;
    else prePause = null;
    const from = phase;
    phase = target;
    kind = target.split("/")[0];
    if (event === "SET_SOURCE" || event === "RETRY") softRetries = 0;
    history.push({ t: Date.now(), from, event, to: phase, reason: data && data.reason, rejected: false });
    if (history.length > TRANSITION_HISTORY) history.shift();
    if (onEvent) onEvent({ from, event, to: phase, phase, kind, data });
  }

  function reject(event, data) {
    history.push({ t: Date.now(), from: phase, event, to: phase, rejected: true });
    if (history.length > TRANSITION_HISTORY) history.shift();
    if (onEvent) onEvent({ from: phase, event, to: phase, phase, kind, data, rejected: true });
    return false;
  }

  return {
    get phase() { return phase; },
    get kind() { return kind; },
    get history() { return history; },
    canFire(event) {
      const row = TRANSITIONS[phase];
      return !!row && Object.prototype.hasOwnProperty.call(row, event);
    },
    fire(event, data) {
      if (event === "SET_SOURCE") {
        moveTo(entryPhase((data && data.kind) || KIND.NONE, data && data.hasPoster), event, data);
        return true;
      }
      if (event === "RETRY") {
        if (phase !== "live/failed") return reject(event, data);
        moveTo(entryPhase(KIND.LIVE, data && data.hasPoster), event, data);
        return true;
      }
      if (event === "RESUME" && phase === "live/paused") {
        moveTo(prePause || "live/shown", event, data);
        return true;
      }
      const row = TRANSITIONS[phase];
      if (!row || !Object.prototype.hasOwnProperty.call(row, event)) return reject(event, data);
      const to = row[event];
      if (to === true) { // self-transition: restart in place (e.g. load restart)
        const from = phase;
        history.push({ t: Date.now(), from, event, to: phase, reason: data && data.reason, rejected: false });
        if (history.length > TRANSITION_HISTORY) history.shift();
        if (onEvent) onEvent({ from, event, to: phase, phase, kind, data });
        return true;
      }
      moveTo(to, event, data);
      return true;
    },
    /** Soft-failure retry accounting: returns ms to wait, or null when the
     *  budget is spent and the failure must escalate to hard. */
    scheduleSoftRetry() {
      if (softRetries >= SOFT_RETRY_LIMIT) return null;
      softRetries++;
      return SOFT_RETRY_DELAY_MS;
    },
    get softRetries() { return softRetries; },
  };
}

// ── watchdog registry (sensors; intervals owned by the agent main) ──────────
// scope "*" = active in every phase. Intervals are guidance for the agent's
// scheduler; event-driven sensors name their event source instead.
export const WATCHDOGS = [
  { id: "ledger", intervalMs: LEDGER_TICK_MS, scope: ["live/loading", "live/switching"] },
  { id: "switch-cap", intervalMs: SWITCH_CAP_MS, scope: ["live/switching"], once: true },
  { id: "hidden-pause", event: "visibilitychange", scope: "*" },
  { id: "video-kick", intervalMs: 2000, scope: ["video/shown", "video/prep"] },
];
