/**
 * Guard: two-way reconciliation between the serve surface and the page
 * runtimes (docs/ARCHITECTURE.md rule 5). Nothing is declared without a
 * consumer, nothing consumed without a producer:
 *
 *   1. SSE event names: what serve publishes (hub.publish / subscribe) ↔ what
 *      the page runtimes addEventListener for
 *   2. config keys: panel pushes ⊆ sanitize whitelist ⊆ publicConfig shape
 *      (the panel may read everything publicConfig exposes; it may only push
 *      what sanitize accepts)
 *   3. payload fields: every payload.<key> the agent reads exists in the
 *      built payload (InjectionPayload in cdp.ts / BuiltPayload in inject.ts /
 *      runtime additions in payload.ts)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const failures = [];
function ok(cond, msg) {
  if (!cond) failures.push(msg);
}

// ── 1. SSE events ────────────────────────────────────────────────────────────
const published = new Set();
for (const m of read("src/core/broadcast.ts").matchAll(/(?:send\(res,\s*|publish\()\s*"([a-z-]+)"/g)) published.add(m[1]);
for (const m of read("src/core/server.ts").matchAll(/hub\.publish\(\s*"([a-z-]+)"/g)) published.add(m[1]);
const consumed = new Set();
for (const f of ["live/src/agent/main.js", "live/src/panel/main.js"]) {
  // Only EventSource subscriptions count — element listeners (click/input)
  // are not SSE traffic.
  for (const m of read(f).matchAll(/\bes\.addEventListener\(\s*"([a-z-]+)"/g)) consumed.add(m[1]);
}
for (const e of consumed) ok(published.has(e), `runtime listens to SSE event "${e}" that serve never publishes`);
for (const e of published) ok(consumed.has(e), `serve publishes SSE event "${e}" that no runtime consumes`);

// ── 2. config keys ───────────────────────────────────────────────────────────
const sanitizeSrc = read("src/core/configApi.ts");
const whitelist = new Set();
for (const m of sanitizeSrc.matchAll(/body\?\.\w+|body\?\["\w+"\]/g)) whitelist.add(m[0].replace(/body\?\.\??/, "").replace(/["[\]]/g, ""));
const publicSrc = sanitizeSrc.match(/export function publicConfig[\s\S]*?\n}/)?.[0] ?? "";
const publicKeys = new Set();
for (const m of publicSrc.matchAll(/^\s{4}(\w+):/gm)) publicKeys.add(m[1]);
ok(publicKeys.size > 10, "publicConfig shape not parsed (guard regex drifted?)");

const panelSrc = read("live/src/panel/main.js");
const pushed = new Set();
for (const m of panelSrc.matchAll(/pushConfig(?:Soon)?\(\s*\{\s*([\w\s:,!0-9."']+)\}/g)) {
  for (const k of m[1].matchAll(/(\w+)\s*:/g)) pushed.add(k[1]);
}
for (const k of pushed) ok(whitelist.has(k), `panel pushes config key "${k}" that sanitize() rejects (silently dropped!)`);
for (const k of whitelist) ok(publicKeys.has(k), `sanitize() accepts "${k}" but publicConfig never exposes it`);

// ── 3. payload fields ────────────────────────────────────────────────────────
const injectSrc = read("src/core/inject.ts") + read("src/core/payload.ts") + read("src/core/cdp.ts");
const agentSrc = read("live/src/agent/main.js");
const payloadReads = new Set();
for (const m of agentSrc.matchAll(/payload\.(\w+)/g)) payloadReads.add(m[1]);
const builtKeys = new Set();
for (const m of injectSrc.matchAll(/^\s{2,4}(?:readonly\s+)?(\w+)[?]?:/gm)) builtKeys.add(m[1]);
for (const k of ["css", "liveSrc", "videoSrc", "apiPort"]) ok(builtKeys.has(k), `built-payload key "${k}" not found in TS sources (guard regex drifted?)`);
for (const k of payloadReads) ok(builtKeys.has(k), `agent reads payload.${k} that the builder never sets`);

if (failures.length) {
  console.error(`verify-contracts: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`verify-contracts: OK (SSE ${[...published].join("/")}; ${pushed.size} panel keys ⊆ ${whitelist.size} sanitize ⊆ ${publicKeys.size} public; ${payloadReads.size} payload reads all built)`);
