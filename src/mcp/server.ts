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

import { spawn } from "node:child_process";
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
    const serverFile = path.resolve(process.argv[1] ?? "");
    // Only from the built layout (dist/mcp/server.js -> dist/cli.js); under
    // tsx from src/ there is nothing to point at, so skip quietly.
    const cliJs = path.join(path.dirname(serverFile), "..", "cli.js");
    if (path.basename(serverFile) !== "server.js" || !existsSync(cliJs)) return;
    fetch(`http://127.0.0.1:${DEFAULT_API_PORT}/api/health`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.json())
      .then((body) => {
        if ((body as { service?: string })?.service !== "zcode-wallpaper") throw new Error("foreign service");
      })
      .catch(() => {
        try {
          // ZCode launches MCP servers with ZW_DATA_DIR pointed at a
          // plugin-scoped directory; letting the serve inherit it splits the
          // store from manually-started serves. Strip it so every serve uses
          // the default data dir.
          const childEnv = { ...process.env };
          delete childEnv.ZW_DATA_DIR;
          childEnv.ZW_SPAWNED_BY_MCP = "1"; // serve tracks MCP processes as its owner
          spawn(process.execPath, [cliJs, "serve", "--detach"], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: childEnv,
          }).unref();
        } catch {
          /* best effort */
        }
      });
    // Self-heal launch shortcuts: without the CDP flag a start-menu launch
    // gets no injection for the whole session. Fire-and-forget, silent.
    import("../core/shortcuts.js")
      .then((m) => m.ensureShortcutsHaveCdpFlag(28256))
      .catch(() => undefined);
    // Keep the serve alive for as long as this MCP process lives (it may exit
    // on its own when its owner checks fail — e.g. transient failures).
    setInterval(() => {
      fetch("http://127.0.0.1:28257/api/health", { signal: AbortSignal.timeout(1500) })
        .then((r) => r.json())
        .then((body) => {
          if ((body as { service?: string })?.service !== "zcode-wallpaper") throw new Error("foreign");
        })
        .catch(() => {
          try {
            const childEnv2 = { ...process.env };
            delete childEnv2.ZW_DATA_DIR;
            childEnv2.ZW_SPAWNED_BY_MCP = "1";
            spawn(process.execPath, [cliJs, "serve", "--detach"], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
              env: childEnv2,
            }).unref();
          } catch {
            /* best effort */
          }
        });
    }, 60_000).unref();
  } catch {
    /* best effort */
  }
}
bootstrapServe();

const server = new McpServer({
  name: "zcode-wallpaper",
  version: "1.1.0",
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
