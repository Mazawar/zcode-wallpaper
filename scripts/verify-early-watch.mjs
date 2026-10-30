/**
 * Guard: early-serve host-watchdog semantics (D27). A silent plugin host is
 * fleet churn, not disablement — the wallpaper must survive ZCode recycling
 * its plugin-host fleet (2026-10-30 incident: silence >45s was misread as a
 * mid-session disable, restoring default appearance ~5s before the successor
 * remounted). Runs the REAL earlyHostTick — esbuild-bundled straight from
 * src/core/earlyWatch.ts — through the lifecycle scenarios, then pins the
 * server wiring (the blind-exit log line must never come back).
 */
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = path.join(os.tmpdir(), "zw-early-watch-guard.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "src", "core", "earlyWatch.ts")],
  outfile: tmp,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { earlyHostTick } = await import(pathToFileURL(tmp).href);

const failures = [];
function expect(actual, kind, msg) {
  const ok = actual.kind === kind;
  if (!ok) failures.push(`${msg} (expected kind="${kind}", got "${actual.kind}")`);
  else console.log(`ok: ${msg}`);
}

// t0 is arbitrary; all deltas below are the watchdog's real windows.
const t0 = 1_000_000;
const hb = (t) => t; // heartbeat timestamp helper (readability)

// 1) host never spawned → nothing may kill the serve (2026-10-28 rule),
//    even if the plugin reads as disabled — the enablement watch owns that.
let w = { hostSeen: false, lastHostAlive: 0, zcodeSeenAt: t0 + 120_000, churnLogged: false };
expect(earlyHostTick(w, t0 + 120_000, false), "none", "host never seen: no verdict (enabled)");
expect(earlyHostTick(w, t0 + 120_000, true), "none", "host never seen: no verdict (disable belongs to the enablement watch)");

// 2) heartbeats fresh → none.
w = { hostSeen: true, lastHostAlive: hb(t0 + 100_000), zcodeSeenAt: t0 + 100_000, churnLogged: false };
expect(earlyHostTick(w, t0 + 110_000, false), "none", "fresh heartbeat: no verdict");

// 3) THE REGRESSION — silent >45s + ZCode alive + still enabled → churn
//    (stay up), NOT exit-restore. This is exactly the 2026-10-30 incident.
w = { hostSeen: true, lastHostAlive: hb(t0), zcodeSeenAt: t0 + 50_000, churnLogged: false };
expect(earlyHostTick(w, t0 + 50_000, false), "churn", "host silent >45s + enabled: churn, wallpaper stays");

// 4) same episode next tick → still nothing (log once per episode, no exit).
w.churnLogged = true;
expect(earlyHostTick(w, t0 + 55_000, false), "none", "churn already logged: quiet, still no exit");

// 5) silent >45s + ZCode alive + CONFIRMED disable → exit-restore.
w = { hostSeen: true, lastHostAlive: hb(t0), zcodeSeenAt: t0 + 50_000, churnLogged: false };
expect(earlyHostTick(w, t0 + 50_000, true), "exit-restore", "host silent + confirmed disable: restore + exit");

// 6) heartbeats resume, then a second silent episode → churn again
//    (the reset matters: a swallowed episode must not mask a later disable).
w = { hostSeen: true, lastHostAlive: hb(t0), zcodeSeenAt: t0 + 130_000, churnLogged: true };
w.lastHostAlive = t0 + 100_000; // successor host heartbeats resume
w.churnLogged = false; // server resets this when a fresher heartbeat lands
expect(earlyHostTick(w, t0 + 110_000, false), "none", "heartbeats resumed: healthy again");
expect(earlyHostTick(w, t0 + 151_000, false), "churn", "second silent episode (ZCode alive): churn logs again");

// 7) ZCode gone >60s → session ends (the wrapper respawns next launch).
w = { hostSeen: true, lastHostAlive: hb(t0), zcodeSeenAt: t0, churnLogged: false };
expect(earlyHostTick(w, t0 + 61_000, false), "exit-zcode-gone", "ZCode gone >60s: exit");
expect(earlyHostTick(w, t0 + 61_000, true), "exit-zcode-gone", "ZCode gone >60s: exit even if disabled (disable path is redundant here, exit is exit)");

// 8) host silent but ZCode last seen 30–60s ago → not actionable; the gone
//    rule resolves it at +60s. No restore may fire in this window.
w = { hostSeen: true, lastHostAlive: hb(t0), zcodeSeenAt: t0 + 20_000, churnLogged: false };
expect(earlyHostTick(w, t0 + 46_000, false), "churn", "silent 46s + ZCode seen 26s ago: churn");
w.zcodeSeenAt = t0 + 15_000; // ZCode last seen 35s ago → outside the 30s window, inside 60s
expect(earlyHostTick(w, t0 + 50_000, false), "none", "silent 50s + ZCode seen 35s ago: wait for the gone rule");

// ── wiring pins on the live server source ───────────────────────────────────
const serverSrc = fs.readFileSync(path.join(root, "src", "core", "server.ts"), "utf8");
function pin(cond, msg) {
  if (!cond) failures.push(msg);
  else console.log(`ok: ${msg}`);
}
pin(serverSrc.includes("earlyHostTick(watch, now, !!pluginDisabledBy(cfgPath))"), "server consults the verdict with the enablement state");
pin(serverSrc.includes('verdict.kind === "exit-restore"'), "server maps exit-restore to its shutdown path");
pin(!serverSrc.includes("plugin host gone (disabled?)"), "the blind silence-means-disable exit line is gone for good");

if (failures.length) {
  for (const f of failures) console.error("FAIL:", f);
  process.exitCode = 1;
}
console.log(process.exitCode ? "EARLY WATCH: FAILED" : "EARLY WATCH: ALL OK");
