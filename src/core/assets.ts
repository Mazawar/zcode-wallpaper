/**
 * Decoded-image asset cache backing payload assembly.
 *
 * One decoded image + extracted theme, reused across slider updates so config
 * changes feel instant. Invalidated whenever the Monet source file's mtime
 * changes. `lastGoodAssets` keeps the last successful decode independent of
 * which file it came from — a switch's instant first push can't have the NEW
 * wallpaper decoded yet, and falling back to the old palette keeps the
 * transparency overrides in that push instead of shipping bare css that the
 * opaque UI covers the screen with.
 */

import fs from "node:fs";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import type { BeautifyConfig } from "./inject.js";

let cachedAssets: { file: string; mtimeMs: number; assets: WallpaperAssets } | undefined;
let lastGoodAssets: WallpaperAssets | undefined;

export function invalidateAssets(): void {
  cachedAssets = undefined;
  lastGoodAssets = undefined;
}

export function primeAssets(file: string, assets: WallpaperAssets): void {
  cachedAssets = { file, mtimeMs: fs.statSync(file).mtimeMs, assets };
  lastGoodAssets = assets;
}

/**
 * @param allowDecode false = cache-only (used for the instant first push of a
 * wallpaper switch; the palette follows in a second push once decoded).
 */
export async function getAssets(config: BeautifyConfig, allowDecode = true): Promise<WallpaperAssets | undefined> {
  const sourcePath = config.monetSourcePath;
  if (!sourcePath || !fs.existsSync(sourcePath)) return undefined;
  const mtimeMs = fs.statSync(sourcePath).mtimeMs;
  if (cachedAssets?.file === sourcePath && cachedAssets.mtimeMs === mtimeMs) {
    return cachedAssets.assets;
  }
  if (!allowDecode) return undefined;
  try {
    const assets = await loadWallpaper(sourcePath);
    cachedAssets = { file: sourcePath, mtimeMs, assets };
    lastGoodAssets = assets;
    return assets;
  } catch {
    return undefined; // undecodable source: inject without Monet rather than not at all
  }
}

export function getLastGoodAssets(): WallpaperAssets | undefined {
  return lastGoodAssets;
}
