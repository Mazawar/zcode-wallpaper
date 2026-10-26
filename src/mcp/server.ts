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
import { enumerateWallpapers } from "../core/steam.js";
import { DEFAULT_API_PORT } from "../core/inject.js";

function bootstrapServe(): void {
  try {
    // The wallpaper serve is a DETACHED daemon, not this process: MCP
    // instances are per-conversation and die when a chat closes, which used
    // to take the wallpaper with it. Any MCP instance (re)spawns the daemon
    // when the health check fails and heartbeats it every 30s; the daemon
    // follows the PLUGIN's lifecycle instead (all MCPs gone -> reset UI and
    // exit; app closed -> exit). ZW_DATA_DIR points at a plugin-scoped dir
    // when ZCode spawns us — strip it early so everything shares one data dir.
    delete process.env.ZW_DATA_DIR;

    const api = `http://127.0.0.1:${DEFAULT_API_PORT}`;
    let spawning = false;
    const spawnDaemon = async () => {
      if (spawning) return;
      spawning = true;
      try {
        const { spawn } = await import("node:child_process");
        const { daemonEntry } = await import("../core/server.js");
        const entry = daemonEntry();
        if (!entry) return;
        const child = spawn(process.execPath, [entry, "serve"], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, ZW_DAEMON: "1" },
          windowsHide: true,
        });
        child.unref();
      } catch {
        /* best effort — the next ensure() retries */
      } finally {
        spawning = false;
      }
    };
    const ensure = () => {
      void (async () => {
        try {
          const r = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(1500) });
          const body = await r.json();
          if ((body as { service?: string })?.service !== "zcode-wallpaper") throw new Error("foreign service");
        } catch {
          await spawnDaemon();
        }
        // heartbeat either way so a fresh daemon never ages out under us
        await fetch(`${api}/api/mcp-alive`, { method: "POST" }).catch(() => undefined);
      })();
    };
    ensure();
    setInterval(ensure, 30_000).unref();

    // Self-heal launch shortcuts: without the CDP flag a start-menu launch
    // gets no injection for the whole session. Fire-and-forget, silent.
    import("../core/shortcuts.js")
      .then((m) => m.ensureShortcutsHaveCdpFlag(28256))
      .catch(() => undefined);
  } catch {
    /* best effort */
  }
}
bootstrapServe();

const server = new McpServer({
  name: "zcode-wallpaper",
  version: "0.1.0",
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
    title: "List Wallpaper Engine wallpapers",
    description:
      "Enumerate the local Wallpaper Engine library: subscribed Steam workshop wallpapers plus WE's own default/my projects. Returns id, title, type (scene/video/web) and size for each — pass an id to set_background / import_scene_wallpaper.",
    inputSchema: {},
  },
  async () => {
    const lib = await enumerateWallpapers();
    const lines = lib.wallpapers.map(
      (w) => `- ${w.id} | ${w.type} | ${(w.sizeBytes / 1024 / 1024).toFixed(1)}MB | ${w.title}${w.workshopId ? ` (workshop ${w.workshopId})` : ""}`
    );
    const head = lib.we
      ? `Wallpaper Engine: ${lib.we.root} — ${lib.wallpapers.length} wallpapers`
      : `Wallpaper Engine not found (steam roots: ${lib.steamRoots.join(", ") || "none"}) — ${lib.wallpapers.length} wallpapers`;
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
      "Adjust the live ZCode appearance without changing the wallpaper: blur radius, dim level, Monet colors on/off, wallpaper visibility, framing, and for live scene wallpapers the frame-rate cap and audio mute.",
    inputSchema: {
      blur: z.number().min(0).max(100).optional().describe("Wallpaper blur radius in px"),
      dim: z.number().min(0).max(100).optional().describe("Wallpaper darkening 0-100"),
      monet: z.boolean().optional().describe("Regenerate UI colors from the wallpaper (true) or keep ZCode's original colors (false)"),
      wallpaper_visible: z.boolean().optional().describe("Translucent surfaces showing the wallpaper (true) or opaque surfaces (false)"),
      fit: z.enum(["cover", "contain", "smart"]).optional().describe("Framing: cover fills and crops, contain letterboxes with a blurred backdrop, smart analyzes the picture locally and picks the best framing + focus point"),
      fps: z.number().min(10).max(60).optional().describe("Live scene render frame-rate cap (15/30/60)"),
      muted: z.boolean().optional().describe("Mute/unmute the live wallpaper's own audio"),
    },
  },
  async ({ blur, dim, monet, wallpaper_visible, fit, fps, muted }) => {
    try {
      const windows = await applyColorsOnly({
        blur,
        dim,
        monet,
        wallpaperVisible: wallpaper_visible,
        fit,
        liveFps: fps,
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
    description: "Report the wallpaper engine state: Steam roots, Wallpaper Engine install, library counts, serve process and the currently applied wallpaper.",
    inputSchema: {},
  },
  async () => {
    const status = await wallpaperStatus();
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

await server.connect(new StdioServerTransport());

// Lifecycle: ZCode closes our stdio pipe on plugin disable / app close. The
// daemon outlives this MCP instance (sessions come and go), so we only say
// goodbye — the daemon decides whether that was the last MCP (plugin
// disabled: reset UI + exit) or just a closing chat (keep serving).
async function gracefulShutdown(): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${DEFAULT_API_PORT}/api/mcp-gone`, {
      method: "POST",
      signal: AbortSignal.timeout(800),
    });
  } catch {
    /* daemon already gone */
  }
  process.exit(0);
}
process.stdin.on("close", () => void gracefulShutdown());
process.stdin.on("end", () => void gracefulShutdown());
process.on("SIGTERM", () => void gracefulShutdown());
