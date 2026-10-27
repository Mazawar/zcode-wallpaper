/**
 * Steam / Wallpaper Engine discovery and wallpaper library enumeration.
 *
 * The discovery chain mirrors dsh-wallpaper-engine's host contract:
 *   ZW_STEAM_ROOT override -> registry -> common install dirs; then
 * libraryfolders.vdf expands the library list; Wallpaper Engine is detected
 * by marker files (wallpaper32/64.exe, or distribution/version.json), and the
 * wallpaper library is the union of:
 *   <we>/projects/defaultprojects, <we>/projects/myprojects and
 *   <steamlib>/steamapps/workshop/content/431960/*  (subscribed items).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectWallpaperType, type WallpaperType } from "./wallpaperType.js";

const execFileAsync = promisify(execFile);

export const WE_APP_ID = "431960";

export type WallpaperOrigin = "workshop" | "default" | "myprojects" | "custom";

export interface WallpaperEntry {
  /** Registry key used to serve this wallpaper's files (/files/<id>/...). */
  id: string;
  /** Absolute directory of the wallpaper project. */
  dir: string;
  title: string;
  type: WallpaperType;
  /** Relative path of the preview inside dir, when present. */
  preview?: string;
  /** Total directory size in bytes (0 when unknown). */
  sizeBytes: number;
  origin: WallpaperOrigin;
  /** Steam workshop item id (same as id for origin=workshop). */
  workshopId?: string;
  mtimeMs: number;
}

export interface WeInstall {
  /** Directory containing projects/ and config.json. */
  root: string;
}

// --- Steam root discovery -----------------------------------------------------

/** Reads a value from the Windows registry via `reg query`; undefined off-Windows or on failure. */
async function regQuery(key: string, value: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("reg", ["query", key, "/v", value], { timeout: 4000, windowsHide: true });
    // "    SteamPath    REG_SZ    D:\Steam"
    const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`).exec(stdout);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Steam install roots worth probing per platform (besides registry/env). */
export function commonSteamDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === "win32") {
    return [path.join("C:", "Program Files (x86)", "Steam"), path.join("C:", "Program Files", "Steam")];
  }
  if (platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Steam")];
  }
  // Linux: ~/.steam/steam and ~/.steam/root are the standard symlinks created
  // by Steam itself; ~/.local/share/Steam is the flatpak/default data dir.
  return [
    path.join(home, ".steam", "steam"),
    path.join(home, ".local", "share", "Steam"),
    path.join(home, ".steam", "root"),
  ];
}

/** Case-folded key for Windows path comparisons (registry may return d:\steam, vdf D:\Steam). */
function pathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** All Steam roots worth scanning: explicit override first, then registry, then defaults. */
export async function findSteamRoots(): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | undefined) => {
    if (!p) return;
    try {
      if (!fs.existsSync(path.join(p, "steamapps"))) return;
    } catch {
      return;
    }
    if (seen.has(pathKey(p))) return;
    seen.add(pathKey(p));
    roots.push(p);
  };

  push(process.env.ZW_STEAM_ROOT);
  push(await regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath"));
  push(await regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"));
  for (const d of commonSteamDirs(process.platform, os.homedir())) push(d);
  return roots;
}

/** Extracts the quoted "path" values from a libraryfolders.vdf. */
export function parseLibraryFolders(vdfPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(vdfPath, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
    const dir = m[1].replace(/\\\\/g, "\\");
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/** Steam libraries = every root's own libraryfolders.vdf entries, de-duplicated. */
export async function steamLibraries(roots: string[]): Promise<string[]> {
  const libs: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | undefined) => {
    if (!p) return;
    try {
      fs.accessSync(path.join(p, "steamapps"));
    } catch {
      return; // a listed library that isn't mounted anymore
    }
    if (seen.has(pathKey(p))) return;
    seen.add(pathKey(p));
    libs.push(p);
  };
  for (const root of roots) {
    push(root);
    for (const lib of parseLibraryFolders(path.join(root, "steamapps", "libraryfolders.vdf"))) push(lib);
  }
  return libs;
}

const WE_DIR_CANDIDATES = ["WallpaperEngine", "wallpaper_engine", "Wallpaper Engine"];

/**
 * Finds the Wallpaper Engine install root across all Steam libraries.
 * Detection is by marker files, not the exe path: both the classic layout
 * (wallpaper32/64.exe at the top) and the current layout (exe inside
 * distribution\ with a stable version.json) count.
 */
export async function findWallpaperEngine(libraries: string[]): Promise<WeInstall | undefined> {
  for (const lib of libraries) {
    for (const name of WE_DIR_CANDIDATES) {
      const dir = path.join(lib, "steamapps", "common", name);
      try {
        fs.accessSync(dir);
      } catch {
        continue;
      }
      const classic =
        fs.existsSync(path.join(dir, "wallpaper32.exe")) || fs.existsSync(path.join(dir, "wallpaper64.exe"));
      const modern = fs.existsSync(path.join(dir, "distribution", "version.json"));
      if (classic || modern) return { root: dir };
    }
  }
  return undefined;
}

// --- Enumeration ---------------------------------------------------------------

function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    try {
      if (e.isDirectory()) total += dirSize(path.join(dir, e.name));
      else total += fs.statSync(path.join(dir, e.name)).size;
    } catch {
      /* unreadable entry */
    }
  }
  return total;
}

const PREVIEW_FALLBACKS = ["preview.gif", "preview.jpg", "preview.jpeg", "preview.png"];

function readProject(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function entryFromDir(
  dir: string,
  id: string,
  origin: WallpaperOrigin,
  workshopId?: string
): WallpaperEntry | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory()) return undefined;

  const project = readProject(dir);
  const type = detectWallpaperType(dir);
  // Skip workshop items that are not wallpapers at all (e.g. tools).
  if (type === "unknown" && !project) return undefined;

  const title =
    (typeof project?.title === "string" && project.title.trim()) ||
    path.basename(dir);
  const previewDeclared = typeof project?.preview === "string" ? project.preview : undefined;
  const preview =
    previewDeclared && fs.existsSync(path.join(dir, previewDeclared))
      ? previewDeclared
      : PREVIEW_FALLBACKS.find((p) => fs.existsSync(path.join(dir, p)));

  return {
    id,
    dir,
    title,
    type,
    preview,
    sizeBytes: dirSize(dir),
    origin,
    workshopId,
    mtimeMs: stat.mtimeMs,
  };
}

export interface WallpaperLibrary {
  steamRoots: string[];
  libraries: string[];
  we?: WeInstall;
  wallpapers: WallpaperEntry[];
}

let cachedLibrary: { at: number; value: WallpaperLibrary } | undefined;
const LIBRARY_TTL_MS = 10_000;

/**
 * Enumerates the full wallpaper library: subscribed workshop items across all
 * Steam libraries plus WE's own default/my projects. Cheap enough to call per
 * request; results are cached briefly.
 */
export async function enumerateWallpapers(force = false): Promise<WallpaperLibrary> {
  if (!force && cachedLibrary && Date.now() - cachedLibrary.at < LIBRARY_TTL_MS) {
    return cachedLibrary.value;
  }
  const steamRoots = await findSteamRoots();
  const libraries = await steamLibraries(steamRoots);
  const we = await findWallpaperEngine(libraries);

  const wallpapers: WallpaperEntry[] = [];
  const seen = new Set<string>();

  // Subscribed workshop items (the main course).
  for (const lib of libraries) {
    const workshopDir = path.join(lib, "steamapps", "workshop", "content", WE_APP_ID);
    let ids: string[];
    try {
      ids = fs.readdirSync(workshopDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const dir = path.join(workshopDir, id);
      if (seen.has(pathKey(dir))) continue;
      seen.add(pathKey(dir));
      const entry = entryFromDir(dir, `ws-${id}`, "workshop", id);
      if (entry) wallpapers.push(entry);
    }
  }

  // WE's own project folders (bundled defaults + user projects).
  if (we) {
    for (const [sub, origin] of [
      ["defaultprojects", "default"],
      ["myprojects", "myprojects"],
    ] as const) {
      const base = path.join(we.root, "projects", sub);
      let names: string[];
      try {
        names = fs.readdirSync(base);
      } catch {
        continue;
      }
      for (const name of names) {
        const dir = path.join(base, name);
        if (seen.has(pathKey(dir))) continue;
        seen.add(pathKey(dir));
        const entry = entryFromDir(dir, `we-${origin}-${name}`, origin);
        if (entry) wallpapers.push(entry);
      }
    }
  }

  wallpapers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const value: WallpaperLibrary = { steamRoots, libraries, we, wallpapers };
  cachedLibrary = { at: Date.now(), value };
  return value;
}

/**
 * Maps a source id back to its directory, consulting both the enumerated
 * library and the custom sources registered by the user (stored config).
 */
export async function resolveSourceDir(id: string, custom: Array<{ id: string; dir: string }>): Promise<WallpaperEntry | undefined> {
  const customHit = custom.find((c) => c.id === id);
  if (customHit) {
    const entry = entryFromDir(customHit.dir, id, "custom");
    return entry ?? undefined;
  }
  const lib = await enumerateWallpapers();
  return lib.wallpapers.find((w) => w.id === id);
}

export function dataHomeHint(): string {
  return path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "zcode-wallpaper");
}
