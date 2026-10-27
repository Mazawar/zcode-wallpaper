/**
 * Builds the clean local dev marketplace at .local-market/ — the shipped
 * surface ONLY (no src/, scripts/, docs/, node_modules/).
 *
 * Why: adding the REPO ROOT as a local marketplace makes ZCode copy the
 * whole working tree (~255 MB, tens of thousands of node_modules files) on
 * every refresh — slow, antivirus-locked (EPERM on the refresh rename), and
 * it never needs any of it. This export is ~3 MB and refreshes instantly.
 *
 *   npm run market          — (re)build .local-market/
 *   then: Plugin Marketplace → Add → paste  <repo>\.local-market
 *
 * The market name is deliberately distinct (dev-zcode-wallpaper) so this dev
 * install never collides with the published zcode-wallpaper market identity.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".local-market");
const pluginOut = path.join(out, "zcode-wallpaper");

const manifest = JSON.parse(fs.readFileSync(path.join(root, ".zcode-plugin", "plugin.json"), "utf8"));

// The shipped surface (mirrors package.json "files" + marketplace.json).
const shipped = ["dist", "live", "vendor", "commands", "skills", ".zcode-plugin", "README.md", "LICENSE", "package.json"];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(pluginOut, { recursive: true });
for (const name of shipped) {
  const src = path.join(root, name);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(pluginOut, name);
  fs.cpSync(src, dest, { recursive: true });
}

const entry = JSON.parse(fs.readFileSync(path.join(root, "marketplace.json"), "utf8")).plugins[0];
fs.writeFileSync(
  path.join(out, "marketplace.json"),
  JSON.stringify(
    {
      name: "dev-zcode-wallpaper",
      plugins: [{ ...entry, source: "./zcode-wallpaper", version: manifest.version }],
    },
    null,
    2,
  ),
);

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      files++;
      bytes += fs.statSync(p).size;
    }
  }
})(out);
console.log(`local-market: ${out}`);
console.log(`  ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, plugin v${manifest.version} (market: dev-zcode-wallpaper)`);
