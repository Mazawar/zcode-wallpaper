/**
 * Wallpaper source management: apply a library/custom source as the current
 * wallpaper, register user-picked directories, import/export cross-machine
 * packages, delete custom sources. All apply paths funnel through
 * publishConfig (broadcast.ts) — the two-phase switch (instant push, decoded
 * palette follows) is preserved from the CDP-push era.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveSourceDir, enumerateWallpapers, type WallpaperEntry } from "./steam.js";
import { detectWallpaperType } from "./wallpaperType.js";
import { dataDir, loadConfig, saveConfig } from "./launch.js";
import { DEFAULT_API_PORT, DEFAULT_CONFIG, type BeautifyConfig, type CustomSource } from "./inject.js";
import { persisted, storedCustomSources } from "./configApi.js";
import { clearLiveFailure } from "./livefail.js";
import { publishConfig } from "./broadcast.js";

export interface ApplyLiveResult {
  entry: WallpaperEntry;
  mediaType: "live" | "video";
  /** The composed config that was (or would be) persisted for this source. */
  config: BeautifyConfig;
}

/** First .mp4/.webm in the wallpaper root, then its files/ subfolder. */
function findVideoInDir(dir: string): string | undefined {
  for (const subdir of ["", "files"]) {
    const base = path.join(dir, subdir);
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    const hit = entries.find((e) => /\.(mp4|webm)$/i.test(e));
    if (hit) return path.join(base, hit);
  }
  return undefined;
}

function toRel(dir: string, file: string): string {
  return path.relative(dir, file).replace(/\\/g, "/");
}

/** Live-frame capture path in the data dir, keyed by source id. */
export function liveFrameFile(sourceId: string): string {
  const safe = sourceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dataDir(), `live-frame-${safe}.jpg`);
}

/**
 * Applies a wallpaper source (workshop subscription, WE project or custom dir)
 * as the current wallpaper. Scenes and web pages render live through the
 * WebWallGL iframe; videos ride a native <video> element (dsh's actual
 * integration model: the engine's WebCodecs path clears its canvas on pause
 * and fast-forwards on wake; native elements have neither quirk).
 */
export async function applySource(
  id: string,
  config: BeautifyConfig,
  apply = true
): Promise<ApplyLiveResult> {
  const entry = await resolveSourceDir(id, storedCustomSources());
  if (!entry) throw new Error(`unknown wallpaper source: ${id}`);
  const type = entry.type === "scene" || entry.type === "web" ? entry.type : detectWallpaperType(entry.dir);

  let next: BeautifyConfig;
  if (type === "scene" || type === "web") {
    next = {
      ...config,
      mediaType: "live",
      live: { sourceId: id, kind: type, title: entry.title, poster: entry.preview },
      sceneVideoUrl: undefined,
      wallpaperPath: undefined,
      monetSourcePath: entry.preview
        ? path.join(entry.dir, entry.preview)
        : config.monetSourcePath,
    };
  } else if (type === "video") {
    const video = findVideoInDir(entry.dir);
    if (!video) throw new Error(`no .mp4/.webm inside video wallpaper: ${entry.dir}`);
    const file = toRel(entry.dir, video).split("/").map(encodeURIComponent).join("/");
    next = {
      ...config,
      mediaType: "video",
      sceneVideoUrl: `http://127.0.0.1:${config.apiPort}/files/${id}/${file}`,
      live: undefined,
      wallpaperPath: undefined,
      monetSourcePath: entry.preview ? path.join(entry.dir, entry.preview) : config.monetSourcePath,
    };
  } else {
    throw new Error(`unsupported wallpaper type (${type}): ${entry.title}`);
  }

  // apply=false means "import only": register the source, leave the current
  // wallpaper untouched.
  if (apply) {
    // Re-picking a source is an explicit retry — its live-failure memory (D6)
    // must not downgrade the fresh attempt.
    clearLiveFailure(id);
    saveConfig(persisted(next));
    // Two-phase publish: switch the wallpaper layer first (cache-only palette,
    // instant), then decode the new Monet source in the background and publish
    // the recolored UI as a second pass — the switch itself never waits on
    // image decoding.
    await publishConfig(next, false).catch(() => undefined);
    void publishConfig(next, true).catch(() => undefined);
  }
  return { entry, mediaType: next.mediaType === "video" ? "video" : "live", config: next };
}

/**
 * One-time migration: video wallpapers briefly went through the WebGL engine
 * (live.kind "video"); that path pauses to a cleared canvas and fast-forwards
 * on wake. Move any stored config back onto the native <video> layer.
 */
export async function migrateLegacyVideo(): Promise<void> {
  const stored = loadConfig() as Partial<BeautifyConfig>;
  const live = stored.live;
  if (!live || live.kind !== "video" || !live.file) return;
  const next: BeautifyConfig = {
    ...(DEFAULT_CONFIG as unknown as BeautifyConfig),
    ...stored,
    mediaType: "video",
    live: undefined,
    sceneVideoUrl: `http://127.0.0.1:${stored.apiPort ?? DEFAULT_API_PORT}/files/${live.sourceId}/${live.file}`,
  };
  saveConfig(persisted(next));
  console.log(`serve: video wallpaper moved back to the native layer (${live.sourceId})`);
}

/** Walks up from a picked file to the nearest enclosing project.json directory. */
function resolveSceneInput(input: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input);
  } catch {
    return input;
  }
  if (stat.isDirectory()) return input;
  if (input.toLowerCase().endsWith(".pkg")) return path.dirname(path.resolve(input));
  let dir = path.dirname(path.resolve(input));
  for (let hop = 0; hop < 4; hop++) {
    if (fs.existsSync(path.join(dir, "project.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.resolve(input));
}

/** Registers a user-picked wallpaper directory as a custom source. */
export function registerCustomSource(input: string): { id: string; dir: string; name?: string } {
  const dir = path.resolve(resolveSceneInput(input));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`not a wallpaper directory: ${dir}`);
  }
  const id = `custom-${crypto.createHash("sha1").update(dir.toLowerCase()).digest("hex").slice(0, 10)}`;
  const sources = storedCustomSources().filter((c) => c.id !== id);
  let name: string | undefined;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    if (typeof p?.title === "string") name = p.title;
  } catch {
    /* untitled */
  }
  sources.push({ id, dir, name });
  saveConfig({ ...loadConfig(), customSources: sources });
  return { id, dir, name };
}

/**
 * Imports an extracted-from-zip wallpaper package: unzip to the data dir,
 * descend single top-level folders, validate, register (and optionally apply).
 * Shared by the upload endpoint and path imports pointing at a .zip file.
 */
export async function importPackageFromFile(
  zipPath: string,
  config: BeautifyConfig,
  apply: boolean
): Promise<{ id: string } & ApplyLiveResult> {
  const { default: AdmZip } = await import("adm-zip");
  const zip = new AdmZip(zipPath);
  const dest = path.join(dataDir(), "packages", `pkg-${Date.now()}`);
  fs.mkdirSync(dest, { recursive: true });
  zip.extractAllTo(dest, true);
  // Packages exported with one top-level folder: descend into it.
  let root = dest;
  for (let i = 0; i < 2; i++) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) root = path.join(root, entries[0].name);
    else break;
  }
  if (
    !fs.existsSync(path.join(root, "project.json")) &&
    !fs.existsSync(path.join(root, "scene.pkg"))
  ) {
    throw new Error("package contains no project.json / scene.pkg — not a wallpaper package");
  }
  const { id } = registerCustomSource(root);
  const result = await applySource(id, config, apply);
  return { id, ...result };
}

export interface DeleteSourceResult {
  ok: boolean;
  filesRemoved: boolean;
  switchedTo: string | null;
}

/**
 * Deletes a custom-imported source. Files are removed only when they live
 * inside this plugin's packages dir (uploaded/extracted copies); sources
 * registered from a user path are only unregistered. When the source is the
 * current wallpaper, another one is applied first (or the wallpaper layer is
 * reset when the library has nothing else) so the delete just works.
 */
export async function deleteSource(id: string, config: BeautifyConfig): Promise<DeleteSourceResult> {
  const sources = storedCustomSources();
  const hit = sources.find((c) => c.id === id);
  if (!hit) throw new Error(`not a custom source: ${id}`);
  const inUse =
    config.live?.sourceId === id ||
    (config.mediaType === "video" && (config.sceneVideoUrl ?? "").includes(`/files/${id}/`));
  let switchedTo: string | null = null;
  if (inUse) {
    // cached enumeration — the forced rescan stats the whole library
    // (hundreds of MB) and made the delete feel slow
    const lib = await enumerateWallpapers();
    const candidate = lib.wallpapers.find((w) => w.id !== id && (w.type === "scene" || w.type === "web"));
    if (candidate) {
      await applySource(candidate.id, config);
      switchedTo = candidate.title;
    } else {
      // nothing else to show: clear the wallpaper layer
      saveConfig({
        ...loadConfig(),
        mediaType: undefined,
        live: undefined,
        sceneVideoUrl: undefined,
        monetSourcePath: undefined,
      } as Record<string, unknown>);
      await publishConfig(config).catch(() => undefined);
    }
  }
  const packagesRoot = path.join(dataDir(), "packages");
  const rel = path.relative(packagesRoot, path.resolve(hit.dir));
  const managed = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  // Unregister first and answer immediately — the source vanishes from the
  // library right away. File deletion happens in the background with retries:
  // the outgoing wallpaper iframe keeps file handles open through its
  // cross-fade (~1s), and Windows refuses to delete files with open handles.
  saveConfig({ ...loadConfig(), customSources: storedCustomSources().filter((c) => c.id !== id) });
  const frameFile = liveFrameFile(id);
  void (async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 750 * (i + 1)));
      try {
        if (managed) fs.rmSync(hit.dir, { recursive: true, force: true });
        fs.rmSync(frameFile, { force: true });
        return;
      } catch {
        /* still held by the fading iframe — retry */
      }
    }
    console.warn(`delete-source: could not fully remove ${hit.dir} (locked); it stays unregistered`);
  })();
  return { ok: true, filesRemoved: managed, switchedTo };
}
