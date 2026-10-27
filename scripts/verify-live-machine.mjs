/**
 * Guard: the layer state machine's invariants (docs/STATE.md).
 *
 *   1. every state in STATES is reachable from "none/idle" through declared
 *      transitions (dynamic targets — SET_SOURCE / RESUME / RETRY — expand to
 *      their legal destinations)
 *   2. every event key in TRANSITIONS is fired somewhere in live/src/agent or
 *      explicitly reserved in state.js
 *   3. machine behavior: PAUSE/RESUME restores, undeclared transitions are
 *      rejected AND recorded (never silent)
 *   4. failure policy: classifier boundaries, size-derived budget (monotone,
 *      capped), soft-retry accounting caps
 *   5. state.js stays pure — its source references no DOM/browser globals
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KIND, STATES, TRANSITIONS, RESERVED_EVENTS, entryPhase,
  createMachine, classifyFailure, firstFrameBudgetMs,
  LEDGER_STALL_TICKS, FIRST_FRAME_CAP_MS, FIRST_FRAME_BASE_MS, SOFT_RETRY_LIMIT,
} from "../live/src/state.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function ok(cond, msg) {
  if (!cond) failures.push(msg);
}

// ── 1. reachability ──────────────────────────────────────────────────────────
const allStates = Object.entries(STATES).flatMap(([k, phs]) => phs.map((p) => `${k}/${p}`));
const edges = (from) => {
  const out = [];
  for (const [ev, to] of Object.entries(TRANSITIONS[from] ?? {})) {
    if (ev === "SET_SOURCE") {
      out.push(entryPhase(KIND.NONE), entryPhase(KIND.IMAGE), entryPhase(KIND.VIDEO), entryPhase(KIND.LIVE, true), entryPhase(KIND.LIVE, false));
    } else if (to === "restore") {
      // RESUME restores every phase PAUSE can be entered from.
      for (const [f, row] of Object.entries(TRANSITIONS)) if (row.PAUSE) out.push(f);
    } else if (to === "reenter") {
      out.push(entryPhase(KIND.LIVE, true), entryPhase(KIND.LIVE, false));
    } else if (to === true) {
      out.push(from);
    } else {
      out.push(to);
    }
  }
  return out;
};
const seen = new Set(["none/idle"]);
let frontier = ["none/idle"];
while (frontier.length) {
  const next = [];
  for (const f of frontier) for (const t of edges(f)) if (!seen.has(t)) { seen.add(t); next.push(t); }
  frontier = next;
}
for (const s of allStates) ok(seen.has(s), `unreachable state: ${s}`);
for (const s of Object.keys(TRANSITIONS)) ok(allStates.includes(s), `transition table has non-state: ${s}`);

// ── 2. every event is fired or reserved ──────────────────────────────────────
const fired = new Set();
for (const f of fs.readdirSync(path.join(root, "live/src/agent"))) {
  const src = fs.readFileSync(path.join(root, "live/src/agent", f), "utf8");
  for (const m of src.matchAll(/(?:machine\.fire|fire)\(\s*"([A-Z_]+)"/g)) fired.add(m[1]);
}
for (const row of Object.values(TRANSITIONS))
  for (const ev of Object.keys(row))
    ok(fired.has(ev) || RESERVED_EVENTS.includes(ev), `event ${ev} is declared but never fired and not reserved`);

// ── 3. machine behavior ──────────────────────────────────────────────────────
const log = [];
const m = createMachine((ev) => log.push(ev));
m.fire("SET_SOURCE", { kind: KIND.LIVE, hasPoster: false });
ok(m.phase === "live/loading", `SET_SOURCE live→${m.phase}, expected live/loading`);
m.fire("READY");
ok(m.phase === "live/shown", `READY →${m.phase}, expected live/shown`);
m.fire("PAUSE");
ok(m.phase === "live/paused", "PAUSE → live/paused");
m.fire("RESUME");
ok(m.phase === "live/shown", `RESUME restored →${m.phase}, expected live/shown`);
const rejected = m.fire("READY"); // READY is not legal from live/shown
ok(rejected === false, "undeclared transition must be rejected");
ok(m.history.some((h) => h.rejected && h.event === "READY"), "rejected transition must be recorded");
// Soft-retry accounting caps then escalates.
const m2 = createMachine();
m2.fire("SET_SOURCE", { kind: KIND.LIVE });
m2.fire("BUDGET_EXHAUSTED", { reason: "transfer" });
let waits = 0;
while (m2.scheduleSoftRetry() != null) waits++;
ok(waits === SOFT_RETRY_LIMIT, `scheduleSoftRetry allowed ${waits} retries, expected ${SOFT_RETRY_LIMIT}`);
ok(m2.scheduleSoftRetry() === null, "soft retries must run out");

// ── 4. failure policy ────────────────────────────────────────────────────────
ok(classifyFailure({ bytesComplete: false, stallTicks: LEDGER_STALL_TICKS }) === "transfer", "static incomplete transfer ⇒ transfer");
ok(classifyFailure({ bytesComplete: true, stallTicks: LEDGER_STALL_TICKS }) === "renderer", "complete but silent ⇒ renderer");
ok(classifyFailure({ bytesComplete: false, stallTicks: LEDGER_STALL_TICKS - 1 }) === null, "still moving ⇒ no verdict");
ok(firstFrameBudgetMs(0) === FIRST_FRAME_BASE_MS, "zero-size budget = base");
ok(firstFrameBudgetMs(10e9) === FIRST_FRAME_CAP_MS, "budget must cap");
ok(firstFrameBudgetMs(50e6) > firstFrameBudgetMs(10e6), "budget must grow with size");

// ── 5. state.js purity ───────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(root, "live/src/state.js"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
for (const bad of [/\bdocument\b/, /\bwindow\b/, /\bfetch\(/, /\bnavigator\b/, /setTimeout/, /setInterval/]) {
  ok(!bad.test(code), `state.js must stay DOM-free — matched ${bad}`);
}

if (failures.length) {
  console.error(`verify-live-machine: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`verify-live-machine: OK (${allStates.length} states reachable, ${fired.size} events fired, policy boundaries hold, state.js pure)`);
