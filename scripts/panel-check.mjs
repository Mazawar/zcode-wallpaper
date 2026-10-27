/**
 * Guard: the BUILT page-runtime artifacts parse and carry their contract
 * markers. (Source-level syntax gating happens in bundle.mjs; this checks the
 * committed deliverables — what serve actually hands to the page.)
 */

import fs from "node:fs";
import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function ok(cond, msg) {
  if (!cond) failures.push(msg);
}

const artifacts = [
  {
    file: "live/agent.js",
    markers: [
      "__zwTeardownAgent", // lifecycle contract with the bootstrap heartbeat
      "/api/events", // SSE subscription
      'MARKER = "zcode-wallpaper"', // the layer id family base (-live, -style…)
      'MARKER + "-live"', // …and its live-frame composition
      "data-zw-auto", // opaque-surface auto-heal marks
    ],
  },
  {
    file: "live/panel.js",
    markers: [
      "zcode-wallpaper-settings-v6", // mount id (LEGACY_IDS must stay older)
      "zcode-wallpaper-settings-2", // legacy sweep keeps old installs clean
      "/api/live-retry", // D6 retry surface
      "zw-panel-tab", // tab memory survives remounts
    ],
    absent: ["/api/transfer"], // the transfer ledger is the agent's channel
  },
];

for (const a of artifacts) {
  const p = path.join(root, a.file);
  if (!fs.existsSync(p)) {
    failures.push(`${a.file} missing — run npm run build`);
    continue;
  }
  const src = fs.readFileSync(p, "utf8");
  await esbuild.transform(src, { loader: "js" }); // throws on syntax error
  for (const mk of a.markers ?? []) ok(src.includes(mk), `${a.file} lost marker "${mk}"`);
  for (const mk of a.absent ?? []) ok(!src.includes(mk), `${a.file} unexpectedly contains "${mk}"`);
}

if (failures.length) {
  console.error(`panel-check: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("panel-check: OK (agent.js + panel.js parse; contract markers present)");
