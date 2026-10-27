/**
 * Bundles the runtime entry points into self-contained files with esbuild
 * (jimp / MCP SDK / zod / adm-zip inlined), so the installed plugin needs no
 * node_modules. The WebWallGL engine stays a vendored file (served as-is),
 * never inlined.
 *
 * dist/cli.js         — CLI entry (serve/launch/apply/…)
 * dist/mcp/server.js  — MCP server entry (spawned by the plugin manifest)
 * live/agent.js       — page runtime, bundled from live/src/agent/main.js (D4)
 * live/panel.js       — settings section, bundled from live/src/panel/main.js
 *
 * live/agent.js and live/panel.js are BUILD ARTIFACTS committed to the repo
 * (market installs never run a build). Never edit them directly — edit
 * live/src/** and run `npm run build`.
 */

import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Page runtimes: authored as ES modules under live/src, delivered as single
// iife files (no runtime imports — one <script src> per runtime, D4). The
// package version is baked in so the panel can show exactly what's running
// (ends the "which build is this?" class of confusion during updates).
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const liveDefine = { define: { __ZW_VERSION__: JSON.stringify(pkg.version) } };
const liveEntries = [
  { in: path.join(root, "live", "src", "agent", "main.js"), out: path.join(root, "live", "agent.js") },
  { in: path.join(root, "live", "src", "panel", "main.js"), out: path.join(root, "live", "panel.js") },
];
for (const e of liveEntries) {
  await esbuild.build({
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
    entryPoints: [e.in],
    outfile: e.out,
    ...liveDefine,
  });
}

// Syntax-gate the renderer page (plain JS served as-is, not bundled).
await esbuild.transform(fs.readFileSync(path.join(root, "live", "renderer.js"), "utf8"), { loader: "js" });
// And the pure state machine must stay loadable in bare Node (guard contract).
await import(pathToFileURL(path.join(root, "live", "src", "state.js")).href);
console.log("bundle: live runtime bundled (agent.js, panel.js); renderer parses; state.js loads in Node");

// Vendor the WebWallGL engine build (server resolves vendor/ before node_modules).
const engineSrc = path.join(root, "node_modules", "webwallgl", "webwallgl.global.min.js");
const destDir = path.join(root, "vendor");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(engineSrc, path.join(destDir, "webwallgl.global.min.js"));
console.log(`bundle: vendored engine (${(fs.statSync(engineSrc).size / 1024 / 1024).toFixed(1)} MB)`);
