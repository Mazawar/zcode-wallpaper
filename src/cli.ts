#!/usr/bin/env node
/**
 * zcode-wallpaper CLI
 *
 *   launch        Start ZCode with the CDP debug port enabled (required once).
 *   apply         Set a wallpaper (image, scene dir, .pkg, video, workshop id).
 *   wallpapers    List the local Wallpaper Engine library.
 *   colors        Re-apply colors only (no wallpaper change).
 *   reset         Restore ZCode's default appearance.
 *   status        Show CDP reachability, library summary and current wallpaper.
 *   serve         Watch mode + settings panel + live renderer server.
 */

import path from "node:path";
import { launchZcode } from "./core/launch.js";
import { applyWallpaper, applyLiveWallpaper, wallpaperStatus } from "./core/session.js";
import { enumerateWallpapers } from "./core/steam.js";
import { listTargets, pickRendererTargets } from "./core/cdp.js";
import { DEFAULT_API_PORT } from "./core/inject.js";

const USAGE = `zcode-wallpaper <command> [options]

Commands:
  launch [--port N]              Start ZCode with --remote-debugging-port=N
  apply <path-or-id> [options]   Set a wallpaper and adapt colors
    --blur <px>                  Blur the wallpaper (default 0)
    --dim <0-100>                Darken the wallpaper (default 25)
    --fit <mode>                 cover | contain | smart (default cover)
    --fps <10-60>                Live scene frame-rate cap (default 30)
    --unmute                     Play the wallpaper's own audio
    --port <N>                   CDP port (default 28256)
  wallpapers                     List subscribed Wallpaper Engine wallpapers
  colors [--port N]              Re-apply stored theme without wallpaper change
  reset [--port N]               Remove wallpaper and color overrides
  status [--port N]              Show CDP reachability and library summary
  serve [--port N] [--api-port M] [--detach]
                                 Watch mode + settings panel + live renderer
                                 (default API port 28257); --detach runs in the
                                 background, outliving this shell
`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
  };
  const has = (name: string): boolean => rest.includes(name);
  const port = Number(flag("--port") ?? 28256);
  const apiPort = Number(flag("--api-port") ?? DEFAULT_API_PORT);

  try {
    switch (cmd) {
      case "launch": {
        const r = await launchZcode(port);
        const { ensureShortcutsHaveCdpFlag } = await import("./core/shortcuts.js");
        const sync = await ensureShortcutsHaveCdpFlag(port);
        for (const p of sync.updated) console.log(`shortcut updated: ${p}`);
        if (sync.failed.length > 0) {
          console.log(`some shortcuts need one elevated run to update:`);
          for (const f of sync.failed) console.log(`  - ${f.path} (${f.reason})`);
        }
        if (r.started) {
          console.log(`ZCode started with CDP on port ${port}.`);
        } else if (r.reason === "running-without-cdp") {
          console.error(
            `A ZCode instance is already running without the debug port, so the single-instance lock ` +
              `would immediately close the new process's CDP port.\n` +
              `Quit ZCode completely (including any tray icon), then run \`zcode-wallpaper launch\` again.`
          );
          process.exitCode = 1;
        } else {
          console.log(`ZCode already reachable on port ${port}.`);
        }
        break;
      }

      case "apply": {
        const input = rest.find((a) => !a.startsWith("--"));
        if (!input) die("apply: missing <path-or-id>\n\n" + USAGE);
        const r = await applyWallpaper(input, {
          port,
          blur: flag("--blur") !== undefined ? Number(flag("--blur")) : undefined,
          dim: flag("--dim") !== undefined ? Number(flag("--dim")) : undefined,
          fit: flag("--fit") as "cover" | "contain" | "smart" | undefined,
        });
        console.log(`Wallpaper applied to ${r.windows} window(s).`);
        break;
      }

      case "apply-scene":
      case "scene": {
        const input = rest.find((a) => !a.startsWith("--"));
        if (!input) die(`${cmd}: missing <path-or-id>\n\n` + USAGE);
        const r = await applyLiveWallpaper(input, {
          port,
          apiPort,
          blur: flag("--blur") !== undefined ? Number(flag("--blur")) : undefined,
          dim: flag("--dim") !== undefined ? Number(flag("--dim")) : undefined,
          liveFps: flag("--fps") !== undefined ? Number(flag("--fps")) : undefined,
          liveMuted: has("--unmute") ? false : undefined,
        });
        console.log(
          `"${r.title}" (${r.type}) applied to ${r.windows} window(s) — ${r.mediaType === "live" ? "live rendering" : "video stream"}.`
        );
        break;
      }

      case "wallpapers":
      case "list": {
        const lib = await enumerateWallpapers(true);
        if (!lib.we) {
          console.log(`Wallpaper Engine not found (steam roots: ${lib.steamRoots.join(", ") || "none"}).`);
          if (lib.wallpapers.length === 0) break;
        } else {
          console.log(`Wallpaper Engine: ${lib.we.root}`);
        }
        for (const w of lib.wallpapers) {
          console.log(
            `${w.id.padEnd(24)} ${w.type.padEnd(6)} ${`${(w.sizeBytes / 1024 / 1024).toFixed(1)}MB`.padStart(9)}  ${w.title}`
          );
        }
        console.log(`${lib.wallpapers.length} wallpaper(s).`);
        break;
      }

      case "colors": {
        const { reapplyStored } = await import("./core/session.js");
        const windows = await reapplyStored({ port });
        console.log(`Theme re-injected into ${windows} window(s).`);
        break;
      }

      case "reset": {
        const { resetAppearance } = await import("./core/session.js");
        await resetAppearance(port);
        console.log("Appearance restored to default.");
        break;
      }

      case "status": {
        const targets = await listTargets(port).catch(() => undefined);
        if (targets) {
          const renderers = pickRendererTargets(targets);
          console.log(`CDP: reachable on port ${port}; ${renderers.length} renderer target(s):`);
          for (const t of renderers) console.log(`  - ${t.title} (${t.id})`);
        } else {
          console.log(`CDP: NOT reachable on port ${port} (run \`zcode-wallpaper launch\`).`);
        }
        console.log(JSON.stringify(await wallpaperStatus(), null, 2));
        break;
      }

      case "serve": {
        if (has("--detach")) {
          const { spawn } = await import("node:child_process");
          const self = path.resolve(process.argv[1] ?? "");
          const child = spawn(process.execPath, [self, "serve", "--port", String(port), "--api-port", String(apiPort)], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.unref();
          console.log(`serve detached on http://127.0.0.1:${apiPort} (pid ${child.pid}).`);
          break;
        }
        const { startServe } = await import("./core/server.js");
        await startServe({ cdpPort: port, apiPort });
        break;
      }

      default:
        die(USAGE);
    }
  } catch (err) {
    console.error(String((err as Error).message ?? err));
    process.exitCode = 1;
  }
}

main();
