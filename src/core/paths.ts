/**
 * Filesystem locations shared across serve modules: the plugin root (probed
 * upward so the tsc layout, the esbuild layout and cache installs all work),
 * the live/ directory holding the served page runtime (agent.js / panel.js /
 * renderer.js), and the vendored WebWallGL engine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./launch.js";

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

/**
 * D33: launch-wrapper artifacts (zw-launch.vbs / zw-serve.cmd / wrapper meta)
 * must SURVIVE plugin uninstall — the plugin data dir is wiped with the
 * plugin, and a .lnk pointing at wscript + a deleted vbs made ZCode
 * unlaunchable from shortcuts (the no-uninstall-hook gap: no code of ours
 * runs after uninstall, so nothing could restore them). The wrapper set
 * therefore lives in the plugin's OWN folder outside the data dir:
 *   win32   %LOCALAPPDATA%\zcode-wallpaper
 *   linux   ~/.local/share/zcode-wallpaper (same dangling-wrapper bug)
 *   darwin  the launcher bundle itself is in ~/Applications (already
 *           survives); its log path rides the data dir, which is fine.
 */
export function wrapperDir(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "zcode-wallpaper"
    );
  }
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".local", "share", "zcode-wallpaper");
  }
  return dataDir();
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
