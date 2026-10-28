/**
 * Bumps the version everywhere it must stay in sync:
 *   package.json, .zcode-plugin/plugin.json, marketplace.json,
 *   src/mcp/server.ts (serverInfo), README.md (download link).
 *
 * Usage: node scripts/version.mjs 1.2.3
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [v] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("usage: node scripts/version.mjs <x.y.z>");
  process.exit(1);
}

function patch(file, fn) {
  const p = path.join(root, file);
  const before = fs.readFileSync(p, "utf8");
  const after = fn(before);
  if (before === after) {
    if (before.includes(`"${v}"`)) {
      console.log(`already ${v}: ${file}`);
      return;
    }
    throw new Error(`no version pattern matched in ${file}`);
  }
  fs.writeFileSync(p, after);
  console.log(`bumped ${file}`);
}

patch("package.json", (s) => s.replace(/("version":\s*)"\d+\.\d+\.\d+"/, `$1"${v}"`));
patch(".zcode-plugin/plugin.json", (s) => s.replace(/("version":\s*)"\d+\.\d+\.\d+"/, `$1"${v}"`));
patch("marketplace.json", (s) => s.replace(/("version":\s*)"\d+\.\d+\.\d+"/g, `$1"${v}"`));
patch("src/core/version.ts", (s) => s.replace(/(VERSION = ")\d+\.\d+\.\d+(")/, `$1${v}$2`));
// README references the zip generically (x.y.z) — replace only concrete versions.
const readme = path.join(root, "README.md");
const rb = fs.readFileSync(readme, "utf8");
const ra = rb.replace(/zcode-wallpaper-\d+\.\d+\.\d+\.zip/g, `zcode-wallpaper-${v}.zip`);
if (ra !== rb) {
  fs.writeFileSync(readme, ra);
  console.log("bumped README.md");
}

console.log(`version -> ${v}`);
