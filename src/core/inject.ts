/**
 * Config model + injected payload assembly.
 *
 * Three wallpaper layer kinds share one fixed-position container behind the UI:
 *   image  — background-image (data URI)
 *   live   — <iframe> to /live/index.html, where WebWallGL renders the source
 *            in real time (scenes with particles/SceneScript/parallax, web
 *            wallpapers, and video files — one engine pipeline for all)
 *   video  — legacy <video> element; only configs written before videos moved
 *            into the live renderer still stream this way
 */

import {
  buildBootstrapScript as buildBootstrap,
  buildResetScript,
  injectIntoTarget,
  listTargets,
  pickRendererTargets,
  type InjectionPayload,
} from "./cdp.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { buildVariableOverrides, buildTransparencyOverrides } from "./tokens.js";

export type WallpaperFit = "cover" | "contain" | "smart" | "stretch";

export interface LiveSourceRef {
  /** Registry id served under /files/<id>/. */
  sourceId: string;
  kind: "scene" | "web" | "video";
  title?: string;
  /** Relative path of the poster preview inside the source dir. */
  poster?: string;
  /** Relative media file path inside the source dir (kind "video"). */
  file?: string;
}

export interface CustomSource {
  id: string;
  dir: string;
  name?: string;
}

export interface BeautifyConfig {
  port: number;
  apiPort: number;
  wallpaperPath?: string;
  blur: number;
  dim: number;
  monet: boolean;
  wallpaperVisible: boolean;
  fit: WallpaperFit;
  /** "live" renders via the WebWallGL iframe; "video" is the pre-0.1.0 <video> path. */
  mediaType?: "image" | "video" | "live";
  /** Loop video URL for video wallpapers (serve /files endpoint, Range-capable). */
  sceneVideoUrl?: string;
  live?: LiveSourceRef;
  liveFps?: number;
  liveMuted?: boolean;
  // ── dsh-style picture knobs: media filter + framing on the wallpaper layer ──
  /** Percent, 100 = untouched (brightness 40–160 / contrast 40–200 / saturate 0–200). */
  wallBrightness?: number;
  wallContrast?: number;
  wallSaturate?: number;
  /** Wallpaper transparency in % (0 = opaque, higher = more see-through). */
  wallOpacity?: number;
  /** Framing: 0–100 with 50 centered (100 shifts the layer by 25% of its size). */
  posX?: number;
  posY?: number;
  /** Layer scale in %, 100 = original size. */
  layerScale?: number;
  /** Horizontal mirror (compositor-only, no render cost). */
  flip?: boolean;
  /** Wallpaper-switch animation shared by manual picks and auto-rotation. */
  switchTransition?: "fade" | "cut";
  // ── auto-rotation over the wallpaper library ──
  rotationEnabled?: boolean;
  rotationMinutes?: number;
  rotationOrder?: "sequence" | "random";
  /** Absolute path of the Monet source image (captured live frame or preview). */
  monetSourcePath?: string;
  /** User-registered wallpaper directories outside Steam/workshop. */
  customSources?: CustomSource[];
}

export const DEFAULT_CONFIG: BeautifyConfig = {
  port: 28256,
  apiPort: 28257,
  blur: 0,
  dim: 25,
  monet: true,
  wallpaperVisible: true,
  fit: "cover",
  liveFps: 30,
  liveMuted: true,
  wallBrightness: 100,
  wallContrast: 100,
  wallSaturate: 100,
  wallOpacity: 0,
  posX: 50,
  posY: 50,
  layerScale: 100,
  switchTransition: "fade",
  rotationMinutes: 30,
  rotationOrder: "sequence",
};

export const DEFAULT_API_PORT = 28257;

export interface BuiltPayload extends InjectionPayload {
  focusX: number;
  focusY: number;
}

/** URL of the live renderer page for the config's live source. */
export function buildLiveUrl(config: BeautifyConfig): string | undefined {
  if (!config.live) return undefined;
  // Videos play at the media's native cadence — the scene fps cap (30) exists
  // to budget scene GPU cost and must not halve a 60fps loop.
  const fps = config.live.kind === "video" ? 60 : (config.liveFps ?? 30);
  const q = new URLSearchParams({
    type: config.live.kind,
    src: config.live.sourceId,
    fit: config.fit === "contain" ? "contain" : config.fit === "stretch" ? "stretch" : "cover",
    fps: String(fps),
    muted: config.liveMuted === false ? "0" : "1",
  });
  // live.file is stored pre-encoded (applySource composes it via
  // encodeURIComponent). URLSearchParams encodes again on set(), so decode
  // first — otherwise the renderer receives %25-encoded names and 404s.
  if (config.live.file) {
    let raw = config.live.file;
    try {
      raw = decodeURIComponent(config.live.file);
    } catch {
      /* not encoded — use as stored */
    }
    q.set("file", raw);
  }
  if (config.live.poster) {
    q.set("poster", `/files/${config.live.sourceId}/${config.live.poster.split(/[\\/]/).map(encodeURIComponent).join("/")}`);
  }
  return `http://127.0.0.1:${config.apiPort}/live/index.html?${q.toString()}`;
}

export interface BuildPayloadOptions {
  /** Live-renderer iframe URL; computed by the caller via buildLiveUrl(). */
  liveUrl?: string;
}

export function buildPayload(config: BeautifyConfig, assets?: WallpaperAssets, opts: BuildPayloadOptions = {}): BuiltPayload {
  const parts: string[] = [];

  // "smart" resolves to the analyzed suggestion at build time, so the injected
  // CSS only ever deals with cover, contain or stretch (100% 100%).
  const smartFit = (assets?.focus.fit ?? "cover") as "cover" | "contain";
  const resolved: "cover" | "contain" | "stretch" =
    config.fit === "smart"
      ? smartFit
      : config.fit === "contain"
        ? "contain"
        : config.fit === "stretch"
          ? "stretch"
          : "cover";
  const focusX = config.fit === "smart" ? (assets?.focus.x ?? 0.5) : 0.5;
  const focusY = config.fit === "smart" ? (assets?.focus.y ?? 0.5) : 0.5;
  const position = `${Math.round(focusX * 100)}% ${Math.round(focusY * 100)}%`;
  const bgSize = resolved === "stretch" ? "100% 100%" : resolved;

  // dsh-style picture knobs: a media filter plus a compositor transform on the
  // wallpaper layer. 100 = untouched; position maps 0–100 to ±25% of the layer.
  const fx: string[] = [];
  if (config.blur > 0) fx.push(`blur(${config.blur}px)`);
  if ((config.wallBrightness ?? 100) !== 100) fx.push(`brightness(${config.wallBrightness}%)`);
  if ((config.wallContrast ?? 100) !== 100) fx.push(`contrast(${config.wallContrast}%)`);
  if ((config.wallSaturate ?? 100) !== 100) fx.push(`saturate(${config.wallSaturate}%)`);
  const tx = ((config.posX ?? 50) - 50) / 2;
  const ty = ((config.posY ?? 50) - 50) / 2;
  const layerScale = ((config.layerScale ?? 100) / 100) * (config.blur > 0 ? 1.04 : 1);
  const transform = `translate(${tx}%, ${ty}%)${config.flip ? " scaleX(-1)" : ""} scale(${layerScale})`;
  const layerOpacity = 1 - (config.wallOpacity ?? 0) / 100;

  parts.push(`
html, body { background: transparent !important; }
#zcode-wallpaper-wallpaper {
  position: fixed;
  inset: 0;
  z-index: -2147483646;
  background-size: ${bgSize};
  background-position: ${resolved === "contain" ? "center" : position};
  background-repeat: no-repeat;
  pointer-events: none;
  filter: ${fx.length ? fx.join(" ") : "none"};
  transform: ${transform};
  opacity: ${layerOpacity};
}
#zcode-wallpaper-backdrop {
  position: fixed;
  inset: 0;
  z-index: -2147483647;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  pointer-events: none;
  filter: blur(28px) saturate(1.15) brightness(0.85);
  transform: scale(1.12);
  display: none;
}
#zcode-wallpaper-backdrop[data-on="1"] { display: block; }`);
  if (config.dim > 0) {
    parts.push(`#zcode-wallpaper-wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / var(--zcode-wallpaper-dim, ${config.dim / 100}));
}`);
  }

  if (assets) {
    // Monet recolors the UI from the wallpaper; the wallpaper toggle only
    // decides whether the picture is visible at all. With Monet off we still
    // need transparency, otherwise the opaque UI hides the wallpaper.
    if (config.monet) {
      parts.push(buildVariableOverrides(assets.theme, {
        dim: config.dim,
        wallpaperVisible: config.wallpaperVisible,
      }));
    } else if (config.wallpaperVisible) {
      parts.push(buildTransparencyOverrides({ dim: config.dim }));
    }
  }

  const visible = config.wallpaperVisible;
  const liveSrc = visible && config.mediaType === "live" ? opts.liveUrl : undefined;
  const videoSrc = visible && config.mediaType === "video" ? config.sceneVideoUrl : undefined;
  const wallpaperDataUri =
    !visible || config.mediaType !== "image" ? undefined : assets?.dataUri;

  return {
    css: parts.join("\n"),
    wallpaperDataUri,
    videoSrc,
    videoMuted: config.liveMuted !== false,
    liveSrc,
    // dsh's persistent underlay: the poster under the live layer, so a
    // blank/reloading/stalled engine shows a still instead of nothing.
    livePoster:
      visible && config.live?.poster
        ? `http://127.0.0.1:${config.apiPort}/files/${config.live.sourceId}/${config.live.poster
            .split(/[\\/]/)
            .map(encodeURIComponent)
            .join("/")}`
        : undefined,
    fit: visible ? resolved : "cover",
    transition: config.switchTransition === "cut" ? "cut" : "fade",
    focusX,
    focusY,
  };
}

/** Apply config to a running ZCode instance. Returns how many windows got it. */
export async function applyToZCode(config: BeautifyConfig, payload: BuiltPayload): Promise<number> {
  const targets = pickRendererTargets(await listTargets(config.port));
  if (targets.length === 0) {
    throw new Error("No ZCode renderer target found on the CDP endpoint.");
  }
  let count = 0;
  for (const target of targets) {
    try {
      await injectIntoTarget(target, payload);
      count++;
    } catch (err) {
      console.warn(`Injection into "${target.title}" failed: ${(err as Error).message}`);
    }
  }
  return count;
}

export async function resetZCode(port: number): Promise<number> {
  const targets = pickRendererTargets(await listTargets(port));
  let count = 0;
  for (const target of targets) {
    try {
      const { CdpConnection } = await import("./cdp.js");
      const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
      await conn.send("Runtime.evaluate", { expression: buildResetScript() });
      conn.close();
      count++;
    } catch (err) {
      console.warn(`Reset of "${target.title}" failed: ${(err as Error).message}`);
    }
  }
  return count;
}

export { buildBootstrap as buildBootstrapScript, buildResetScript };

/** Re-export so CLI/MCP can load wallpapers without touching monet internals. */
export { loadWallpaper };
export type { WallpaperAssets };
