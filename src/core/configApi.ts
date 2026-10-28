/**
 * Config surface shared by the HTTP routes: merge stored config over
 * defaults, whitelist/validate incoming patches, project the public shape the
 * panel reads, and decide what actually goes to disk (runtime port flags are
 * not persisted settings; a registration captured after this config object
 * must never be clobbered).
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  type BeautifyConfig,
  type CustomSource,
} from "./inject.js";
import { dataDir, loadConfig } from "./launch.js";
import { liveFailureOf } from "./livefail.js";

export function storedCustomSources(): CustomSource[] {
  const stored = loadConfig();
  return Array.isArray(stored.customSources) ? (stored.customSources as CustomSource[]) : [];
}

export function currentConfig(cdpPort: number, apiPort: number): BeautifyConfig {
  const stored = loadConfig() as Partial<BeautifyConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    port: cdpPort,
    apiPort,
    customSources: storedCustomSources(),
  };
}

/** What goes to disk — stored port values win, customSources re-read fresh. */
export function persisted(config: BeautifyConfig): Record<string, unknown> {
  const stored = loadConfig() as Partial<BeautifyConfig>;
  const out: Record<string, unknown> = { ...config, port: stored.port, apiPort: stored.apiPort };
  out.customSources = storedCustomSources();
  if (out.port === undefined) delete out.port;
  if (out.apiPort === undefined) delete out.apiPort;
  return out;
}

function backupFile(): string {
  return path.join(dataDir(), "config.backup.json");
}

export function hasBackup(): boolean {
  return fs.existsSync(backupFile());
}

export function readBackup(): Partial<BeautifyConfig> {
  return JSON.parse(fs.readFileSync(backupFile(), "utf8")) as Partial<BeautifyConfig>;
}

export function writeBackup(config: Record<string, unknown>): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(backupFile(), JSON.stringify(config));
}

export function publicConfig(config: BeautifyConfig) {
  return {
    blur: config.blur,
    dim: config.dim,
    monet: config.monet,
    wallpaperVisible: config.wallpaperVisible,
    fit: config.fit,
    wallpaperSet: Boolean(
      (config.wallpaperPath && fs.existsSync(config.wallpaperPath)) ||
        config.sceneVideoUrl ||
        config.live
    ),
    mediaType: config.mediaType ?? "image",
    live: config.live ?? null,
    liveFps: config.liveFps ?? 30,
    liveMuted: config.liveMuted ?? true,
    liveQuality: config.liveQuality ?? "balanced",
    wallBrightness: config.wallBrightness ?? 100,
    wallContrast: config.wallContrast ?? 100,
    wallSaturate: config.wallSaturate ?? 100,
    wallOpacity: config.wallOpacity ?? 0,
    posX: config.posX ?? 50,
    posY: config.posY ?? 50,
    layerScale: config.layerScale ?? 100,
    flip: config.flip === true,
    switchTransition: config.switchTransition ?? "fade",
    switchTransitionSpeed: config.switchTransitionSpeed ?? "normal",
    rotationEnabled: config.rotationEnabled === true,
    rotationMinutes: config.rotationMinutes ?? 30,
    rotationOrder: config.rotationOrder === "random" ? "random" : "sequence",
    hasBackup: hasBackup(),
    liveFailed: liveFailureOf(config.live?.sourceId),
    cdpPort: config.port,
    apiPort: config.apiPort,
  };
}

export function sanitize(body: any): Partial<BeautifyConfig> {
  const out: Partial<BeautifyConfig> = {};
  if (typeof body?.blur === "number" && body.blur >= 0 && body.blur <= 100) out.blur = body.blur;
  if (typeof body?.dim === "number" && body.dim >= 0 && body.dim <= 100) out.dim = body.dim;
  if (typeof body?.monet === "boolean") out.monet = body.monet;
  if (typeof body?.wallpaperVisible === "boolean") out.wallpaperVisible = body.wallpaperVisible;
  if (body?.fit === "cover" || body?.fit === "contain" || body?.fit === "smart" || body?.fit === "stretch") out.fit = body.fit;
  if (typeof body?.liveFps === "number" && body.liveFps >= 10 && body.liveFps <= 60) out.liveFps = Math.round(body.liveFps);
  if (typeof body?.liveMuted === "boolean") out.liveMuted = body.liveMuted;
  if (["low", "balanced", "high", "ultra"].includes(body?.liveQuality)) out.liveQuality = body.liveQuality;
  // dsh-style picture knobs
  if (typeof body?.wallBrightness === "number") out.wallBrightness = Math.min(160, Math.max(40, Math.round(body.wallBrightness)));
  if (typeof body?.wallContrast === "number") out.wallContrast = Math.min(200, Math.max(40, Math.round(body.wallContrast)));
  if (typeof body?.wallSaturate === "number") out.wallSaturate = Math.min(200, Math.max(0, Math.round(body.wallSaturate)));
  if (typeof body?.wallOpacity === "number") out.wallOpacity = Math.min(90, Math.max(0, Math.round(body.wallOpacity)));
  if (typeof body?.posX === "number") out.posX = Math.min(100, Math.max(0, Math.round(body.posX)));
  if (typeof body?.posY === "number") out.posY = Math.min(100, Math.max(0, Math.round(body.posY)));
  if (typeof body?.layerScale === "number") out.layerScale = Math.min(150, Math.max(50, Math.round(body.layerScale)));
  if (typeof body?.flip === "boolean") out.flip = body.flip;
  if (["cut", "fade", "push", "wipe", "iris", "zoom"].includes(body?.switchTransition)) out.switchTransition = body.switchTransition;
  if (["fast", "normal", "slow"].includes(body?.switchTransitionSpeed)) out.switchTransitionSpeed = body.switchTransitionSpeed;
  // auto-rotation
  if (typeof body?.rotationEnabled === "boolean") out.rotationEnabled = body.rotationEnabled;
  if (typeof body?.rotationMinutes === "number") out.rotationMinutes = Math.min(1440, Math.max(1, Math.round(body.rotationMinutes)));
  if (body?.rotationOrder === "sequence" || body?.rotationOrder === "random") out.rotationOrder = body.rotationOrder;
  return out;
}
