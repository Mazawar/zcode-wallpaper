/**
 * Bundles the two runtime entry points into self-contained ESM files with
 * esbuild (jimp / MCP SDK / zod / adm-zip inlined), so the installed plugin
 * needs no node_modules. The WebWallGL engine stays a vendored file (served
 * as-is), never inlined.
 *
 * dist/cli.js         — CLI entry (serve/launch/apply/…)
 * dist/mcp/server.js  — MCP server entry (spawned by the plugin manifest)
 */

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Common options. node built-ins are external automatically (platform=node). */
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  // CJS deps inside the ESM bundle (jimp → gifwrap) call require(); give them
  // a real one rooted at the bundle file.
  banner: {
    js: "import { createRequire as __zwCreateRequire } from 'node:module'; const require = __zwCreateRequire(import.meta.url);",
  },
};

const entries = [
  { in: path.join(root, "src", "cli.ts"), out: path.join(root, "dist", "cli.js") },
  { in: path.join(root, "src", "mcp", "server.ts"), out: path.join(root, "dist", "mcp", "server.js") },
];

fs.mkdirSync(path.join(root, "dist", "mcp"), { recursive: true });
for (const e of entries) {
  await esbuild.build({ ...common, entryPoints: [e.in], outfile: e.out });
}

// Vendor the WebWallGL engine build (server resolves vendor/ before node_modules).
const engineSrc = path.join(root, "node_modules", "webwallgl", "webwallgl.global.min.js");
const destDir = path.join(root, "vendor");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(engineSrc, path.join(destDir, "webwallgl.global.min.js"));
console.log(`bundle: vendored engine (${(fs.statSync(engineSrc).size / 1024 / 1024).toFixed(1)} MB)`);
