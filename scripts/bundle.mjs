/**
 * Post-build step: vendor the WebWallGL engine build so the packaged plugin
 * works without node_modules (the server resolves vendor/ before node_modules).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules", "webwallgl", "webwallgl.global.min.js");
const destDir = path.join(root, "vendor");
const dest = path.join(destDir, "webwallgl.global.min.js");

if (!fs.existsSync(src)) {
  console.error("bundle: webwallgl not installed — run `npm install` first");
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`bundle: vendored engine -> ${path.relative(root, dest)} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
