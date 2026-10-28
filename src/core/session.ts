/**
 * Shared high-level operations used by both the CLI and the MCP server.
 *
 * When the serve process is alive, every mutation goes through its HTTP API so
 * exactly one writer owns the config and pushes updates to all renderer
 * sessions. Without a live serve, changes are persisted and injected directly
 * over CDP (live scene wallpapers need the serve's HTTP surface, so they
 * report the limitation instead of silently showing nothing).
 */

import fs from "node:fs";
import path from "node:path";
import { applyToZCode, buildLiveUrl, buildPayload, DEFAULT_CONFIG, loadWallpaper, resetZCode, type BeautifyConfig } from "./inject.js";
import { dataDir, loadConfig, saveConfig } from "./launch.js";
import { detectWallpaperType } from "./wallpaperType.js";
import { enumerateWallpapers } from "./steam.js";

export interface ApplyOptions {
  port?: number;
  apiPort?: number;
  blur?: number;
  dim?: number;
  monet?: boolean;
  wallpaperVisible?: boolean;
  fit?: "cover" | "contain" | "smart";
  liveFps?: number;
  liveMuted?: boolean;
}

function mergedStored(): BeautifyConfig {
  return { ...DEFAULT_CONFIG, ...(loadConfig() as Partial<BeautifyConfig>) };
}

async function serveHealth(apiPort: number): Promise<{ ok: boolean; service?: string; pid?: number }> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(1200) });
    return (await res.json()) as { ok: boolean; service?: string; pid?: number };
  } catch {
    return { ok: false };
  }
}

export async function isServeAlive(apiPort: number): Promise<boolean> {
  const health = await serveHealth(apiPort);
  return health.ok && health.service === "zcode-wallpaper";
}

async function serveApi(apiPort: number, pathname: string, body?: unknown): Promise<Record<string, any>> {
  const res = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(String(json?.error ?? `serve API ${pathname} failed`));
  return json;
}

/** Merges ApplyOptions over the stored config (CLI/MCP flags win). */
function baseConfig(opts: ApplyOptions, stored: Partial<BeautifyConfig>): BeautifyConfig {
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    port: opts.port ?? stored.port ?? DEFAULT_CONFIG.port,
    apiPort: opts.apiPort ?? stored.apiPort ?? DEFAULT_CONFIG.apiPort,
    blur: opts.blur ?? stored.blur ?? DEFAULT_CONFIG.blur,
    dim: opts.dim ?? stored.dim ?? DEFAULT_CONFIG.dim,
    monet: opts.monet ?? stored.monet ?? DEFAULT_CONFIG.monet,
    wallpaperVisible: opts.wallpaperVisible ?? stored.wallpaperVisible ?? DEFAULT_CONFIG.wallpaperVisible,
    fit: opts.fit ?? stored.fit ?? DEFAULT_CONFIG.fit,
    liveFps: opts.liveFps ?? stored.liveFps ?? DEFAULT_CONFIG.liveFps,
    liveMuted: opts.liveMuted ?? stored.liveMuted ?? DEFAULT_CONFIG.liveMuted,
  };
}

/** Re-applies (or refreshes) the stored config; used after ZCode restarts. */
export async function reapplyStored(opts: ApplyOptions = {}): Promise<number> {
  const config = baseConfig(opts, loadConfig() as Partial<BeautifyConfig>);
  if (await isServeAlive(config.apiPort)) {
    const r = await serveApi(config.apiPort, "/api/config", {});
    return Number(r.windows ?? 0);
  }
  return directApply(config);
}

/** Direct CDP injection from the persisted config (no serve round-trip). */
async function directApply(config: BeautifyConfig): Promise<number> {
  let assets;
  if (config.monetSourcePath && fs.existsSync(config.monetSourcePath)) {
    assets = await loadWallpaper(config.monetSourcePath).catch(() => undefined);
  } else if (config.mediaType === "image" && config.wallpaperPath && fs.existsSync(config.wallpaperPath)) {
    assets = await loadWallpaper(config.wallpaperPath).catch(() => undefined);
  }
  if (config.mediaType === "live") {
    // The live iframe needs the serve HTTP surface; without it the poster
    // preview becomes the static fallback.
    const preview = config.monetSourcePath && fs.existsSync(config.monetSourcePath)
      ? config.monetSourcePath
      : undefined;
    const payload = buildPayload({ ...config, mediaType: preview ? "image" : config.mediaType }, assets);
    if (preview) {
      const buf = fs.readFileSync(preview);
      const ext = path.extname(preview).toLowerCase() || ".jpg";
      const mime = ext === ".png" ? "image/png" : "image/jpeg";
      payload.wallpaperDataUri = `data:${mime};base64,${buf.toString("base64")}`;
    }
    payload.liveSrc = undefined;
    return applyToZCode(config, payload);
  }
  const payload = buildPayload(config, assets, { liveUrl: buildLiveUrl(config) });
  return applyToZCode(config, payload);
}

export async function applyWallpaper(imagePath: string, opts: ApplyOptions = {}): Promise<{ windows: number }> {
  const abs = path.resolve(imagePath);

  // Scene / web / video wallpaper directories route through the live pipeline.
  const kind = detectWallpaperType(abs);
  if (kind === "scene" || kind === "video" || kind === "web") {
    const r = await applyLiveWallpaper(abs, opts);
    return { windows: r.windows };
  }

  const config = baseConfig(opts, loadConfig() as Partial<BeautifyConfig>);
  if (!fs.existsSync(abs)) throw new Error(`Image not found: ${abs}`);

  // Keep a copy inside the data dir so the theme survives the original file
  // being moved/deleted.
  fs.mkdirSync(dataDir(), { recursive: true });
  const dest = path.join(dataDir(), "wallpaper" + path.extname(abs).toLowerCase());
  if (dest !== abs) fs.copyFileSync(abs, dest);

  const next: BeautifyConfig = {
    ...config,
    mediaType: "image",
    wallpaperPath: dest,
    live: undefined,
    sceneVideoUrl: undefined,
    monetSourcePath: dest,
  };
  saveConfig({ ...next, port: loadConfig().port } as Record<string, unknown>);

  if (await isServeAlive(next.apiPort)) {
    const data = await fs.promises.readFile(dest);
    const mime = `image/${path.extname(dest).slice(1) === "png" ? "png" : "jpeg"}`;
    const r = await serveApi(next.apiPort, "/api/wallpaper", {
      dataUri: `data:${mime};base64,${data.toString("base64")}`,
    });
    return { windows: Number(r.windows ?? 0) };
  }

  const assets = await loadWallpaper(dest);
  const payload = buildPayload(next, assets);
  const windows = await applyToZCode(next, payload);
  return { windows };
}

export interface LiveApplyResult {
  windows: number;
  sourceId: string;
  title: string;
  type: string;
  mediaType: "live" | "video";
  served: boolean;
}

/**
 * Applies a Wallpaper Engine wallpaper as the animated background:
 *   - a known source id (ws-<workshopid> / we-… / custom-…) — serve route
 *   - any filesystem path (scene dir, .pkg, video file/dir) — registered as a
 *     custom source first, then applied
 * Scenes and web wallpapers render live via WebWallGL; videos stream as-is
 * (they are authored to loop, so no re-encoding is needed). The serve process
 * must be running for motion — it is auto-started with the plugin.
 */
export async function applyLiveWallpaper(sourceOrPath: string, opts: ApplyOptions = {}): Promise<LiveApplyResult> {
  const config = baseConfig(opts, loadConfig() as Partial<BeautifyConfig>);
  const input = sourceOrPath.trim();
  const lib = await enumerateWallpapers();
  const isKnownId = lib.wallpapers.some((w) => w.id === input);
  const looksLikePath = /[\\/]/.test(input) || fs.existsSync(input);
  const sourceId = isKnownId ? input : looksLikePath ? undefined : (() => {
    // bare workshop item id is accepted as a convenience
    if (/^\d{6,}$/.test(input)) return `ws-${input}`;
    return undefined;
  })();
  if (!sourceId && !looksLikePath) {
    throw new Error(`unknown wallpaper source: ${input} (pass a source id, a workshop item id, or a filesystem path)`);
  }

  if (await isServeAlive(config.apiPort)) {
    const r = sourceId
      ? await serveApi(config.apiPort, "/api/apply-source", { sourceId })
      : await serveApi(config.apiPort, "/api/import", { path: path.resolve(input) });
    return {
      windows: Number(r.windows ?? 0),
      sourceId: String(r.sourceId ?? sourceId ?? ""),
      title: String(r.title ?? ""),
      type: String(r.type ?? ""),
      mediaType: r.mediaType === "video" ? "video" : "live",
      served: true,
    };
  }

  // Without the serve process the renderer page, engine and wallpaper files
  // have no HTTP origin to load from — fail loudly instead of showing nothing.
  throw new Error(
    "the serve process is not running — live scene rendering needs it. " +
    "Start it with `zcode-wallpaper serve --detach` (the plugin normally starts it automatically)."
  );
}

export async function applyColorsOnly(opts: ApplyOptions): Promise<number> {
  const config = baseConfig(opts, loadConfig() as Partial<BeautifyConfig>);
  if (await isServeAlive(config.apiPort)) {
    const patch: Record<string, unknown> = {};
    if (opts.blur !== undefined) patch.blur = opts.blur;
    if (opts.dim !== undefined) patch.dim = opts.dim;
    if (opts.monet !== undefined) patch.monet = opts.monet;
    if (opts.wallpaperVisible !== undefined) patch.wallpaperVisible = opts.wallpaperVisible;
    if (opts.fit !== undefined) patch.fit = opts.fit;
    if (opts.liveFps !== undefined) patch.liveFps = opts.liveFps;
    if (opts.liveMuted !== undefined) patch.liveMuted = opts.liveMuted;
    const r = await serveApi(config.apiPort, "/api/config", patch);
    return Number(r.windows ?? 0);
  }
  saveConfig({ ...config } as Record<string, unknown>);
  return directApply(config);
}

export async function resetAppearance(port?: number): Promise<number> {
  const stored = loadConfig() as Partial<BeautifyConfig>;
  const apiPort = stored.apiPort ?? DEFAULT_CONFIG.apiPort;
  if (await isServeAlive(apiPort)) {
    await serveApi(apiPort, "/api/reset");
    return 0;
  }
  await resetZCode(port ?? stored.port ?? DEFAULT_CONFIG.port);
  saveConfig({
    ...stored,
    wallpaperPath: undefined,
    mediaType: undefined,
    live: undefined,
    sceneVideoUrl: undefined,
    monetSourcePath: undefined,
  } as Record<string, unknown>);
  return 0;
}

/** Library summary for status output and the agent. */
export async function wallpaperStatus(): Promise<Record<string, unknown>> {
  const lib = await enumerateWallpapers();
  const config = mergedStored();
  const counts = lib.wallpapers.reduce<Record<string, number>>((acc, w) => {
    acc[w.type] = (acc[w.type] ?? 0) + 1;
    return acc;
  }, {});
  const imported = Array.isArray(config.customSources) ? config.customSources.length : 0;
  if (imported > 0) counts.imported = imported;
  return {
    steamRoots: lib.steamRoots,
    // null = Wallpaper Engine not installed — optional, imports still work.
    wallpaperEngine: lib.we?.root ?? null,
    counts,
    serve: (await isServeAlive(config.apiPort))
      ? `http://127.0.0.1:${config.apiPort}`
      : "not running",
    current: config.live
      ? { title: config.live.title, sourceId: config.live.sourceId, kind: config.live.kind, fps: config.liveFps, muted: config.liveMuted }
      : config.mediaType ?? null,
  };
}
