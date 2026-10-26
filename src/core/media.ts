/**
 * Static file serving for wallpaper assets and the live renderer page.
 *
 * Wallpaper Engine scenes are consumed by WebWallGL's httpSource, which fetches
 * project.json / scene.pkg / loose assets by relative path under one base URL
 * and re-requests them on every layer rebuild — so ETag/304 keeps a multi-hundred-
 * MB pkg from re-reading disk, and Range keeps media seekable.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".pkg": "application/octet-stream",
  ".tex": "application/octet-stream",
  ".mdl": "application/octet-stream",
};

export interface ServeFileOptions {
  /** Force no-store (renderer HTML carries query-state; don't cache it). */
  noStore?: boolean;
}

/**
 * Serves `filePath` with Range support (206 partial content), ETag/304 and
 * CORS headers. Returns false when the file does not exist.
 */
export function sendStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  opts: ServeFileOptions = {}
): boolean {
  const isHead = req.method === "HEAD";
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${crypto
    .createHash("sha1")
    .update(filePath)
    .digest("hex")
    .slice(0, 12)}"`;

  const baseHeaders: Record<string, string | number> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": opts.noStore ? "no-store" : "no-cache",
    ETag: etag,
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return true;
  }

  const bodyHeaders = (extra: Record<string, string | number> = {}): Record<string, string | number> => ({
    ...baseHeaders,
    ...extra,
  });

  // Handles "bytes=A-B", "bytes=A-" and suffix "bytes=-N".
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range && (range[1] !== "" || range[2] !== "")) {
    let start: number;
    let end: number;
    if (range[1] === "") {
      start = Math.max(0, stat.size - Number(range[2]));
      end = stat.size - 1;
    } else if (range[2] === "") {
      start = Number(range[1]);
      end = stat.size - 1;
    } else {
      start = Number(range[1]);
      end = Math.min(Number(range[2]), stat.size - 1);
    }
    if (start >= stat.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return true;
    }
    const headers = bodyHeaders({
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
    });
    if (isHead) {
      res.writeHead(206, headers);
      res.end();
    } else {
      res.writeHead(206, headers);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  } else {
    const headers = bodyHeaders({ "Content-Length": stat.size });
    res.writeHead(200, headers);
    if (isHead) res.end();
    else fs.createReadStream(filePath).pipe(res);
  }
  return true;
}

/** Safely joins and confines `rel` under `root` (no traversal outside it). */
export function safeJoin(root: string, rel: string): string | undefined {
  const clean = rel.replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
  if (!clean) return root;
  const target = path.resolve(root, clean);
  const relFromRoot = path.relative(path.resolve(root), target);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) return undefined;
  return target;
}
