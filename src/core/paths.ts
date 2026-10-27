/**
 * Filesystem locations shared across serve modules: the plugin root (probed
 * upward so the tsc layout, the esbuild layout and cache installs all work),
 * the live/ directory holding the served page runtime (agent.js / panel.js /
 * renderer.js), and the vendored WebWallGL engine.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Plugin root: the directory holding live/ and .zcode-plugin/. */
export const pluginRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, ".zcode-plugin")) || fs.existsSync(path.join(dir, "live"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
})();

export function liveDir(): string {
  return path.join(pluginRoot, "live");
}

/** The WebWallGL engine build: explicit override, vendored copy, then node_modules. */
export function engineFile(): string | undefined {
  const candidates = [
    process.env.ZW_ENGINE_FILE,
    path.join(pluginRoot, "vendor", "webwallgl.global.min.js"),
    path.join(pluginRoot, "node_modules", "webwallgl", "webwallgl.global.min.js"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p));
}
