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

import fs from "node:fs";
import path from "node:path";
import {
  buildResetScript,
  injectIntoTarget,
  listTargets,
  pickRendererTargets,
  type InjectionPayload,
} from "./cdp.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { buildVariableOverrides, buildTransparencyOverrides } from "./tokens.js";

export type WallpaperFit = "cover" | "contain" | "smart" | "stretch";

export type LiveQualityPreset = "low" | "balanced" | "high" | "ultra";

/**
 * D20: one user-facing preset expands into the engine's render knobs. This
 * table is the ONLY place presets exist — the renderer page never learns
 * preset names, it only ever receives the expanded URL params (see
 * buildLiveUrl), so hot updates and fresh mounts can't drift apart.
 *
 *   dpr   cap on devicePixelRatio for the render backing store (0 = native);
 *         rendering at ≤1× logical pixels is the biggest lever on HiDPI
 *         laptops (DPR 1.5/2 render 2.25–4× the pixels for a wallpaper that
 *         sits behind a translucent UI)
 *   aa    anti-aliasing tier; pq particles; pp post-processing tier
 *   vts   video texture upload scale (video wallpapers only)
 *   aq    engine autoQuality — mount-only (no hot setter): it also acts as
 *         the software-rendering safety net (no GPU → drop post + shrink
 *         canvas), so the two lower presets keep it on; a hot preset change
 *         applies it on the next renderer mount, the other knobs immediately
 */
export interface LiveQualityKnobs {
  dpr: number;
  aa: "off" | "fxaa" | "msaa2" | "msaa4";
  pq: "off" | "low" | "medium" | "high";
  pp: "off" | "low" | "medium" | "high";
  vts: number;
  aq: boolean;
}

export const LIVE_QUALITY_PRESETS: Record<LiveQualityPreset, LiveQualityKnobs> = {
  low: { dpr: 0.75, aa: "off", pq: "low", pp: "off", vts: 0.5, aq: true },
  // Default: full logical resolution (native on DPR-1 screens), mid effect
  // tiers, adaptive safety net — visible quality with roughly half the GPU
  // cost of "ultra" on HiDPI machines. 1.0.4 and before always rendered
  // "ultra" (D20).
  balanced: { dpr: 1, aa: "fxaa", pq: "medium", pp: "medium", vts: 1, aq: true },
  high: { dpr: 0, aa: "msaa2", pq: "high", pp: "high", vts: 1, aq: false },
  ultra: { dpr: 0, aa: "msaa4", pq: "high", pp: "high", vts: 1, aq: false },
};

export function liveQualityKnobs(preset: LiveQualityPreset | undefined): LiveQualityKnobs {
  return LIVE_QUALITY_PRESETS[preset ?? "balanced"] ?? LIVE_QUALITY_PRESETS.balanced;
}

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
  /** Render quality preset (D20) — expanded by LIVE_QUALITY_PRESETS. */
  liveQuality?: LiveQualityPreset;
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
  /** Wallpaper switch animation shared by manual picks and auto-rotation
   *  (dsh's effect family: the outgoing snapshot leaves with the effect
   *  while the new source assembles underneath). */
  switchTransition?: "cut" | "fade" | "push" | "wipe" | "iris" | "zoom";
  switchTransitionSpeed?: "fast" | "normal" | "slow";
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
  liveQuality: "balanced",
  wallBrightness: 100,
  wallContrast: 100,
  wallSaturate: 100,
  wallOpacity: 0,
  posX: 50,
  posY: 50,
  layerScale: 100,
  switchTransition: "fade",
  switchTransitionSpeed: "normal",
  rotationMinutes: 30,
  rotationOrder: "sequence",
};

export const DEFAULT_API_PORT = 28257;

export interface BuiltPayload extends InjectionPayload {
  focusX: number;
  focusY: number;
  /** Present when the live source hard-failed and serve downgraded it to
   *  poster-only (D6); the agent holds the poster phase, the panel shows it. */
  liveFailed?: { reason: string; at: number };
}

/** URL of the live renderer page for the config's live source. */
export function buildLiveUrl(config: BeautifyConfig): string | undefined {
  if (!config.live) return undefined;
  // Videos play at the media's native cadence — the scene fps cap (30) exists
  // to budget scene GPU cost and must not halve a 60fps loop.
  const fps = config.live.kind === "video" ? 60 : (config.liveFps ?? 30);
  // D20 render knobs — always emitted (dpr=0 = native), so a hot preset change
  // can always reach the renderer through the {zw:"cfg"} message, including
  // lifting a previously-set resolution cap.
  const k = liveQualityKnobs(config.liveQuality);
  const q = new URLSearchParams({
    type: config.live.kind,
    src: config.live.sourceId,
    fit: config.fit === "contain" ? "contain" : config.fit === "stretch" ? "stretch" : "cover",
    fps: String(fps),
    muted: config.liveMuted === false ? "0" : "1",
    dpr: String(k.dpr),
    aa: k.aa,
    pq: k.pq,
    pp: k.pp,
    vts: String(k.vts),
    aq: k.aq ? "1" : "0",
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

  const visible = config.wallpaperVisible;

  // Underlay painted under the wallpaper layer: the live poster (dsh's
  // persistent underlay), or for native-video wallpapers the preview image.
  // A CSS blur on the viewport-sized layer bleeds past its edges into
  // transparency; a heavily blurred copy of the same picture behind the
  // layer hides that bleed WITHOUT zooming the framing (D16).
  let underlay: string | undefined;
  if (visible) {
    if (config.live?.poster) {
      underlay = `http://127.0.0.1:${config.apiPort}/files/${config.live.sourceId}/${config.live.poster
        .split(/[\\/]/)
        .map(encodeURIComponent)
        .join("/")}`;
    } else if (config.mediaType === "video" && config.monetSourcePath && fs.existsSync(config.monetSourcePath)) {
      const id = /\/files\/([^/]+)\//.exec(config.sceneVideoUrl ?? "")?.[1];
      if (id) {
        underlay = `http://127.0.0.1:${config.apiPort}/files/${id}/${encodeURIComponent(path.basename(config.monetSourcePath))}`;
      }
    }
  }

  // dsh-style picture knobs: a media filter plus a compositor transform on the
  // wallpaper layer. 100 = untouched; position maps 0–100 to ±25% of the layer.
  const fx: string[] = [];
  if (config.blur > 0) fx.push(`blur(${config.blur}px)`);
  if ((config.wallBrightness ?? 100) !== 100) fx.push(`brightness(${config.wallBrightness}%)`);
  if ((config.wallContrast ?? 100) !== 100) fx.push(`contrast(${config.wallContrast}%)`);
  if ((config.wallSaturate ?? 100) !== 100) fx.push(`saturate(${config.wallSaturate}%)`);
  const tx = ((config.posX ?? 50) - 50) / 2;
  const ty = ((config.posY ?? 50) - 50) / 2;
  // With an underlay (or the image itself) behind the blurred layer the edge
  // bleed is covered and the framing stays untouched; the fixed 4% overscale
  // survives only as the fallback when blur is on but no underlay image
  // exists at all (e.g. a video wallpaper without a preview).
  const blurEdge = config.blur > 0 && !underlay && !(visible && config.mediaType === "image" && assets?.dataUri) ? 1.04 : 1;
  const layerScale = ((config.layerScale ?? 100) / 100) * blurEdge;
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
    // The backdrop gets the same dim: where the blurred layer fades into it
    // at the screen edges, an undimmed backdrop would read as a bright rim.
    parts.push(`#zcode-wallpaper-wallpaper::after, #zcode-wallpaper-backdrop::after {
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
    // Declarative surface transparency (replaces the DOM-mutating auto-heal,
    // 0.4.8): one stylesheet rule makes EVERY bg-background surface consume
    // the (already translucent) token — including routes that ship literal
    // colors instead of the variable (the old heal existed for these; a live
    // experiment showed the rule covers them with zero dark window and zero
    // DOM writes). Same gating as the token overrides: wallpaper off ⇒ the
    // app returns fully opaque.
    parts.push(`[class*="bg-background"] { background-color: var(--color-background) !important; }`);
  }

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
    // Under the live layer this is dsh's persistent underlay (a blank or
    // reloading engine shows a still instead of nothing); under a blurred
    // wallpaper of any kind it doubles as the edge-bleed cover (D16).
    livePoster: underlay,
    // Drives the agent's backdrop underlay decision — CSS blur on the layer
    // means its edges fade and need something beneath them.
    wallBlur: config.blur > 0,
    fit: visible ? resolved : "cover",
    transition: config.switchTransition ?? "fade",
    transitionSpeed: config.switchTransitionSpeed ?? "normal",
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

export { buildResetScript };

/** Re-export so CLI/MCP can load wallpapers without touching monet internals. */
export { loadWallpaper };
export type { WallpaperAssets };
