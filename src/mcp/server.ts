/**
 * MCP server exposing zcode-wallpaper to the ZCode agent: the model can
 * enumerate subscribed Wallpaper Engine wallpapers, apply one as a live
 * background, set static images, or tune the appearance on the user's behalf.
 *
 * ZCode launches this MCP server on every app start — the hook that makes the
 * wallpaper panel "just exist": piggyback a detached `serve` process so it
 * injects the panel + wallpaper layer as soon as the renderer is up. Strictly
 * fire-and-forget: a slow or failed bootstrap must never delay MCP startup.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  applyColorsOnly,
  applyWallpaper,
  applyLiveWallpaper,
  reapplyStored,
  resetAppearance,
  wallpaperStatus,
} from "../core/session.js";
import { detectWallpaperType } from "../core/wallpaperType.js";
import { enumerateWallpapers, resolveSourceDir, type WallpaperEntry } from "../core/steam.js";
import { storedCustomSources } from "../core/configApi.js";
import { DEFAULT_API_PORT } from "../core/inject.js";
import { VERSION } from "../core/version.js";

function bootstrapServe(): void {
  try {
    // The serve lives INSIDE this plugin-host process. ZCode spawns plugin
    // hosts at app start, kills them on app close / plugin disable, and
    // restarts them after a crash — which is exactly the lifecycle the
    // wallpaper needs, with no watching protocol of our own. Multiple hosts
    // (multi-window) race for the port; the losers idle and re-check.
    // ZW_DATA_DIR points at a plugin-scoped dir when ZCode spawns us — strip
    // it early so every module uses the shared default data dir.
    delete process.env.ZW_DATA_DIR;

    // CRITICAL: in THIS process stdout is the MCP JSON-RPC channel. The
    // serve logs through console.log — any stray write corrupts the framing
    // and ZCode kills the host (the crash-loop where the wallpaper appeared,
    // got cleared, reappeared and died). Route every log to stderr before
    // any serve code can run.
    console.log = ((...args: unknown[]) => {
      console.error("[serve]", ...args);
    }) as typeof console.log;

    let hosting = false;
    const ensure = () => {
      // Heartbeat an early-launch serve (started hidden by the shortcut
      // wrapper before ZCode): proves this host exists so it keeps owning
      // the session; silence on its side means plugin disabled -> it resets.
      void fetch(`http://127.0.0.1:${DEFAULT_API_PORT}/api/host-alive`, { method: "POST" }).catch(() => undefined);
      if (hosting) return;
      fetch(`http://127.0.0.1:${DEFAULT_API_PORT}/api/health`, { signal: AbortSignal.timeout(1500) })
        .then((r) => r.json())
        .then(async (body) => {
          if ((body as { service?: string })?.service !== "zcode-wallpaper") throw new Error("foreign service");
          const serving = (body as { version?: string })?.version;
          // Missing version = a pre-D18 serve — treat as stale too.
          if (serving !== VERSION) {
            // An older plugin generation's serve still owns the port (the
            // shortcut wrapper's early serve can linger across an update):
            // retire it, then take the port with THIS generation's code.
            await fetch(`http://127.0.0.1:${DEFAULT_API_PORT}/api/retire`, { method: "POST" }).catch(() => undefined);
            await new Promise((r) => setTimeout(r, 1500));
            throw new Error("stale serve retired");
          }
        })
        .catch(() => {
          import("../core/server.js")
            .then((m) => {
              hosting = true;
              return m.startServe({ cdpPort: 28256, apiPort: DEFAULT_API_PORT }).catch((err: Error) => {
                // EADDRINUSE-style: another host process won the race — fine.
                hosting = false;
                if (!String(err?.message ?? err).includes("already running")) throw err;
              });
            })
            .catch(() => {
              /* best effort */
            });
        });
    };
    ensure();
    // 10s: when the previous app instance's host lingers (slow teardown), the
    // old serve holds the port until it dies — this retry bounds the
    // no-observer handoff gap during which an engine stall has no cover.
    setInterval(ensure, 10_000).unref();

    // Self-heal launch shortcuts: without the CDP flag a start-menu launch
    // gets no injection for the whole session. Fire-and-forget, silent.
    import("../core/shortcuts.js")
      .then((m) => m.ensureShortcutsHaveCdpFlag(28256))
      .catch(() => undefined);
  } catch {
    /* best effort */
  }
}
// Last words: the host process crashed ~30s after boot once (caught by the
// page flight recorder timeline) and left no corpse — ZCode does not persist
// plugin-host stderr. Append every fatal signal to a crash journal before
// dying so the next crash names its killer (JS exception, OOM, external kill).
{
  const path = (() => {
    try {
      return require("node:path").join(
        process.env.USERPROFILE || process.env.HOME || ".",
        ".zcode", "cli", "plugins", "data", "zcode-wallpaper", "host-crash.log"
      );
    } catch {
      return "";
    }
  })();
  const journal = (kind: string, detail: unknown) => {
    if (!path) return;
    try {
      require("node:fs").appendFileSync(
        path,
        `${new Date().toISOString()} pid=${process.pid} ${kind} ${String(detail).slice(0, 800)}\n`
      );
    } catch {
      /* nothing more we can do */
    }
  };
  process.on("uncaughtException", (err) => journal("uncaughtException", err?.stack ?? err));
  process.on("unhandledRejection", (err) => journal("unhandledRejection", (err as Error)?.stack ?? err));
  process.on("SIGTERM", () => journal("SIGTERM", "external"));
  process.on("beforeExit", (code) => journal("beforeExit", `code=${code}`));
}

bootstrapServe();

const server = new McpServer({
  name: "zcode-wallpaper",
  version: VERSION,
});

/** Registry of the tools this server exposes (used by tests / docs). */
export const TOOL_NAMES = [
  "set_background",
  "list_wallpapers",
  "import_scene_wallpaper",
  "apply_options",
  "refresh_theme",
  "reset_appearance",
  "wallpaper_status",
] as const;

server.registerTool(
  "set_background",
  {
    title: "Set ZCode wallpaper",
    description:
      "Set the ZCode desktop client's background wallpaper. Accepts a static image, or any Wallpaper Engine wallpaper (scene directory / .pkg / video) — scenes are rendered LIVE in real time (particles, scripts, mouse parallax; no recording, no Wallpaper Engine process needed). Subscribed workshop wallpapers can be addressed by their workshop item id. UI colors adapt via Material Design 3 (Monet).",
    inputSchema: {
      image_path: z.string().describe("Absolute path of the image / scene directory / .pkg file, or a Steam workshop item id of a subscribed wallpaper"),
      blur: z.number().min(0).max(100).optional().describe("Wallpaper blur radius in px (default 0)"),
      dim: z.number().min(0).max(100).optional().describe("Wallpaper darkening 0-100 (default 25)"),
    },
  },
  async ({ image_path, blur, dim }) => {
    try {
      const kind = detectWallpaperType(image_path);
      if (kind === "scene" || kind === "video" || kind === "web" || /^\d{6,}$/.test(image_path)) {
        const r = await applyLiveWallpaper(image_path, { blur, dim });
        return {
          content: [{
            type: "text",
            text:
              r.mediaType === "live"
                ? `"${r.title}" applied as a LIVE rendered wallpaper to ${r.windows} window(s) — real-time WebWallGL rendering, interactive parallax preserved.`
                : `"${r.title}" applied as a looping video wallpaper to ${r.windows} window(s).`,
          }],
        };
      }
      const r = await applyWallpaper(image_path, { blur, dim });
      return { content: [{ type: "text", text: `Wallpaper applied to ${r.windows} window(s) with Monet-adapted colors.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_wallpapers",
  {
    title: "List local wallpapers",
    description:
      "Enumerate the local wallpaper library: Wallpaper Engine workshop subscriptions, WE's own default/my projects, and wallpapers imported on this machine (.pkg / .zw.zip / video / image). Returns id, title, type (scene/video/web) and size for each — pass an id to set_background. A Wallpaper Engine install is OPTIONAL: imported wallpapers and direct file paths (set_background / import_scene_wallpaper) work without it.",
    inputSchema: {},
  },
  async () => {
    const lib = await enumerateWallpapers();
    // Same merge the panel's /api/wallpapers does: Steam/WE enumeration has no
    // idea about locally imported sources, and without them an agent on a
    // WE-less machine reads "0 wallpapers" and wrongly concludes nothing works.
    const custom = storedCustomSources();
    const customs: WallpaperEntry[] = [];
    for (const c of custom) {
      const entry = await resolveSourceDir(c.id, custom);
      if (entry) customs.push(entry);
    }
    const format = (w: WallpaperEntry) =>
      `- ${w.id} | ${w.type} | ${(w.sizeBytes / 1024 / 1024).toFixed(1)}MB | ${w.title}` +
      (w.origin === "custom" ? " (imported)" : w.workshopId ? ` (workshop ${w.workshopId})` : "");
    const lines = [...customs, ...lib.wallpapers].map(format);
    if (lines.length === 0) {
      lines.push(
        "Tip: the library is empty — you can still set a wallpaper without Wallpaper Engine: " +
        "pass a local image / scene directory / .pkg / .zw.zip / video path to set_background."
      );
    }
    const total = customs.length + lib.wallpapers.length;
    const head = lib.we
      ? `Wallpaper Engine: ${lib.we.root} — ${total} wallpapers (${customs.length} imported)`
      : `Wallpaper Engine not installed — OPTIONAL, imports and direct paths still work ` +
        `(steam roots: ${lib.steamRoots.join(", ") || "none"}) — ${total} wallpapers (${customs.length} imported)`;
    return { content: [{ type: "text", text: [head, ...lines].join("\n") }] };
  }
);

server.registerTool(
  "import_scene_wallpaper",
  {
    title: "Apply a Wallpaper Engine scene (live)",
    description:
      "Apply a Wallpaper Engine scene wallpaper as an animated ZCode background. Unlike the old record-and-loop approach this renders the scene LIVE with WebWallGL (particles, SceneScript, audio-reactive effects and mouse parallax keep working, nothing is recorded, no Wallpaper Engine process is launched). Accepts a .pkg file, a wallpaper directory, or a workshop item id of a subscribed wallpaper.",
    inputSchema: {
      path: z.string().describe("Absolute path of the .pkg file / wallpaper directory (project.json folder), or a workshop item id"),
      blur: z.number().min(0).max(100).optional().describe("Wallpaper blur radius in px"),
      dim: z.number().min(0).max(100).optional().describe("Wallpaper darkening 0-100"),
      fps: z.number().min(10).max(60).optional().describe("Live render frame-rate cap (default 30)"),
      muted: z.boolean().optional().describe("Mute the wallpaper's own audio (default true)"),
    },
  },
  async ({ path: scenePath, blur, dim, fps, muted }) => {
    try {
      const r = await applyLiveWallpaper(scenePath, { blur, dim, liveFps: fps, liveMuted: muted });
      const mode =
        r.mediaType === "live"
          ? "live WebWallGL rendering (interactive, real-time)"
          : "video stream (this wallpaper is a video type)";
      return {
        content: [{
          type: "text",
          text: `"${r.title}" applied to ${r.windows} window(s) via ${mode}. Source: ${r.sourceId}.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "apply_options",
  {
    title: "Tune ZCode appearance",
    description:
      "Adjust the live ZCode appearance without changing the wallpaper: blur radius, dim level, Monet colors on/off, wallpaper visibility, framing, and for live scene wallpapers the frame-rate cap, render quality preset and audio mute.",
    inputSchema: {
      blur: z.number().min(0).max(100).optional().describe("Wallpaper blur radius in px"),
      dim: z.number().min(0).max(100).optional().describe("Wallpaper darkening 0-100"),
      monet: z.boolean().optional().describe("Regenerate UI colors from the wallpaper (true) or keep ZCode's original colors (false)"),
      wallpaper_visible: z.boolean().optional().describe("Translucent surfaces showing the wallpaper (true) or opaque surfaces (false)"),
      fit: z.enum(["cover", "contain", "smart"]).optional().describe("Framing: cover fills and crops, contain letterboxes with a blurred backdrop, smart analyzes the picture locally and picks the best framing + focus point"),
      fps: z.number().min(10).max(60).optional().describe("Live scene render frame-rate cap (15/30/60)"),
      quality: z.enum(["low", "balanced", "high", "ultra"]).optional().describe("Live render quality preset (default balanced): low = 0.75x resolution + effects off (weak GPUs), balanced = 1x + mid effects, high/ultra = native resolution + high effects (ultra adds MSAA4) — what 1.0.4 and before always rendered"),
      muted: z.boolean().optional().describe("Mute/unmute the live wallpaper's own audio"),
    },
  },
  async ({ blur, dim, monet, wallpaper_visible, fit, fps, quality, muted }) => {
    try {
      const windows = await applyColorsOnly({
        blur,
        dim,
        monet,
        wallpaperVisible: wallpaper_visible,
        fit,
        liveFps: fps,
        liveQuality: quality,
        liveMuted: muted,
      });
      return { content: [{ type: "text", text: `Appearance updated in ${windows} window(s).` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "refresh_theme",
  {
    title: "Refresh ZCode theme",
    description: "Re-inject the stored wallpaper and Monet theme into the running ZCode client (e.g. after the app was restarted).",
    inputSchema: {},
  },
  async () => {
    try {
      const windows = await reapplyStored();
      return { content: [{ type: "text", text: `Theme re-injected into ${windows} window(s).` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "reset_appearance",
  {
    title: "Reset ZCode appearance",
    description: "Remove the wallpaper and color overrides, restoring ZCode's default appearance.",
    inputSchema: {},
  },
  async () => {
    try {
      await resetAppearance();
      return { content: [{ type: "text", text: "Appearance restored to default." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "wallpaper_status",
  {
    title: "Wallpaper status",
    description: "Report the wallpaper state: Steam roots, Wallpaper Engine install (null = not installed; optional — imported wallpapers still work), library counts including locally imported sources, serve process and the currently applied wallpaper.",
    inputSchema: {},
  },
  async () => {
    const status = await wallpaperStatus();
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

await server.connect(new StdioServerTransport());

// Lifecycle, event-driven: ZCode closes our stdio pipe on plugin disable /
// app close — AND on benign host recycles (new conversation session,
// workspace switch, plugin update). Observed 2026-10-28 16:07: a recycle
// spawned the successor MCP host ~5s later, so an unconditional restore
// tore a healthy wallpaper out of the page mid-session — the visible
// wallpaper blink. Only the DISABLE case must reset the UI (a re-enabled
// plugin brings the stored wallpaper back by itself). On every other
// stdio-close exit WITHOUT restoring: the page-side agent keeps the live
// iframe mounted and reconnects its SSE to the successor serve on its own;
// app close kills the renderer anyway. Hard kills and a mid-session
// disable toggle stay covered by the serve's 5s enablement tick.
async function gracefulShutdown(): Promise<void> {
  let restore = true;
  try {
    const srv = await import("../core/server.js");
    const cfgPath = path.join(os.homedir(), ".zcode", "cli", "config.json");
    restore = srv.pluginDisabledBy(cfgPath) !== null;
    console.error(
      `[serve] stdio closed — plugin ${restore ? "disabled: restoring default appearance" : "still enabled: leaving the wallpaper mounted for the successor serve"}`,
    );
  } catch {
    /* unreadable enablement state — fall back to restore-on-exit */
  }
  try {
    if (restore) {
      const { shutdownServe } = await import("../core/server.js");
      await shutdownServe();
    }
  } catch {
    /* best effort */
  }
  process.exit(0);
}
process.stdin.on("close", () => void gracefulShutdown());
process.stdin.on("end", () => void gracefulShutdown());
process.on("SIGTERM", () => void gracefulShutdown());
