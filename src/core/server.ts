/**
 * `serve` mode: a localhost-only control API, the SSE config channel, the
 * live-renderer + page-runtime file surface, and boot orchestration.
 *
 * Surfaces:
 *   control   /api/*  — config, wallpaper library, apply/reset, live-frame;
 *                       /api/events is the SSE stream every page runtime holds
 *   runtime   /agent.js + /panel.js — the page-side code, served as files so
 *                       the deployed copy is always the current build
 *   live      /live/index.html + /renderer.js, /engine/webwallgl.global.min.js
 *   files     /files/<sourceId>/<rel> — wallpaper directories as plain static
 *             files (Range + ETag), which is all WebWallGL's httpSource needs
 *
 * Config changes are broadcast over SSE (broadcast.ts); CDP session holding,
 * injection and the self-heal loop live in sessions.ts; source apply/import/
 * delete in sources.ts. This module is composition + routing.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { liveDir, engineFile } from "./paths.js";
import {
  DEFAULT_API_PORT,
  type BeautifyConfig,
} from "./inject.js";
import { loadWallpaper } from "./monet.js";
import { loadConfig, saveConfig, dataDir } from "./launch.js";
import { safeJoin, sendStaticFile } from "./media.js";
import { enumerateWallpapers, resolveSourceDir } from "./steam.js";
import { currentConfig, publicConfig, persisted, sanitize, storedCustomSources, hasBackup, readBackup, writeBackup } from "./configApi.js";
import { primeAssets, invalidateAssets } from "./assets.js";
import { hub, publishConfig, currentRuntimePayload } from "./broadcast.js";
import {
  applySource,
  importPackageFromFile,
  registerCustomSource,
  deleteSource,
  liveFrameFile,
  migrateLegacyVideo,
  type ApplyLiveResult,
} from "./sources.js";
import {
  heldWindowCount,
  resetSessions,
  rearmSessions,
  shutdownSessions,
  startSessionLoop,
} from "./sessions.js";

const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_WALLPAPER_BYTES + 1024 * 1024;

// Serve-side flight recorder: everything the serve logs also lands in a ring
// buffer exposed at GET /api/log — after an incident both sides (page +
// serve) can be read side by side. console.log in the host is already
// stderr-routed by mcp/server.ts before this module loads.
const serveLog: string[] = [];
{
  const orig = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    try {
      serveLog.push(`${new Date().toISOString().slice(11, 19)} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 200)}`);
      if (serveLog.length > 400) serveLog.shift();
    } catch {
      /* recording must never break logging */
    }
    orig(...args);
  };
}

export interface ServeOptions {
  cdpPort: number;
  apiPort: number;
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  // The client can vanish mid-request (panel closed, renderer reloaded); a
  // write to a dead socket must not escape as a rejection.
  try {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-ZW-Filename",
    });
    res.end(JSON.stringify(body));
  } catch {
    /* response already finished or socket gone */
  }
}

/** True when another `serve` of this plugin already owns the port. */
export async function existingServePid(apiPort: number): Promise<number | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = (await res.json()) as { service?: string; pid?: number };
    return body?.service === "zcode-wallpaper" ? body.pid : undefined;
  } catch {
    return undefined;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Streams a raw request body to a file (resource packages can be hundreds of MB). */
function readBodyToFile(req: http.IncomingMessage, dest: string, maxBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(dest);
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        out.destroy();
        req.destroy();
        reject(new Error(`package too large (max ${maxBytes / 1024 / 1024 / 1024} GB)`));
        return;
      }
      if (!out.write(c)) {
        req.pause();
        out.once("drain", () => req.resume());
      }
    });
    req.on("end", () => out.end(() => resolve(size)));
    req.on("error", reject);
    out.on("error", reject);
  });
}

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

/**
 * Native wallpaper file picker, shown from the serve process via PowerShell
 * WinForms (STA + a topmost owner form so it surfaces above ZCode). The
 * panel is a web page and cannot read absolute paths from <input type=file>,
 * so the dialog has to live in this local process. Resolves "" on cancel.
 */
async function pickFileViaDialog(): Promise<string> {
  if (process.platform !== "win32") return "";
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '选择 Wallpaper Engine 壁纸（场景目录 / .pkg / 视频文件 / .zw.zip 资源包）'
$d.Filter = '壁纸 (project.json;*.pkg;*.mp4;*.webm;*.zip)|project.json;*.pkg;*.mp4;*.webm;*.zip|所有文件 (*.*)|*.*'
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }`;
  try {
    const { stdout } = await promisify(execFile)("powershell", ["-STA", "-NoProfile", "-Command", script], { timeout: 300_000, windowsHide: true });
    return stdout.trim();
  } catch {
    return "";
  }
}

let activeServer: http.Server | undefined;

/**
 * Reads ZCode's persisted plugin-enablement. A disabled plugin spawns no
 * hosts, and from heartbeats alone "host slow to boot" and "host will never
 * come" are indistinguishable for minutes — the config file settles it in
 * seconds. Unreadable/absent entries count as inconclusive (the caller falls
 * back to its host-timeout heuristics); this is ZCode's private format,
 * parsed best-effort and versioned by try/catch.
 */
export function pluginDisabledIn(cfgPath: string): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins?: { enabledPlugins?: Record<string, boolean> };
    };
    const ep = cfg?.plugins?.enabledPlugins;
    if (!ep || typeof ep !== "object") return false;
    const keys = Object.keys(ep).filter((k) => k.includes("zcode-wallpaper"));
    return keys.length > 0 && keys.every((k) => ep[k] === false);
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown: restore ZCode's default appearance (reset injection,
 * unregister page scripts), close held CDP sessions and the HTTP server.
 * Called by the hosting MCP process when ZCode closes its stdio pipe
 * (plugin disabled / app closing) — the event-driven lifecycle exit.
 */
export async function shutdownServe(): Promise<void> {
  await shutdownSessions();
  await new Promise<void>((r) => (activeServer ? activeServer.close(() => r()) : r()));
}

export async function startServe(opts: ServeOptions): Promise<void> {
  const { cdpPort, apiPort } = opts;
  const runtimeConfig = () => currentConfig(cdpPort, apiPort);

  // Auto-rotation clock (dsh-style): shared by the 30s tick below and the
  // /api/config handler, so (re-)enabling rotation never fires an immediate
  // switch — the first rotation happens a full interval after the toggle.
  let lastRotateAt = Date.now();
  let rotationCursor = 0;

  const already = await existingServePid(apiPort);
  if (already !== undefined) {
    throw new Error(
      `a zcode-wallpaper service is already running on http://127.0.0.1:${apiPort} (pid ${already}) — ` +
        `open its panel, or stop that process first`
    );
  }

  // A request handler that rejects would otherwise take the whole process down
  // (unhandled rejection), killing every held injection session with it.
  const server = http.createServer((req, res) => {
    activeServer = server;
    handleRequest(req, res).catch(() => {
      try {
        res.destroy();
      } catch {
        /* socket gone */
      }
    });
  });

  // Belt and braces: this process IS the plugin's MCP. Any stray exception
  // must not unmount the whole plugin — log it and keep serving; the page-side
  // heartbeats already tolerate brief stalls and the 30s self-heal re-injects.
  process.on("uncaughtException", (err) => console.error(`serve: uncaught exception — ${(err as Error).stack ?? err}`));
  process.on("unhandledRejection", (err) => console.error(`serve: unhandled rejection — ${(err as Error)?.stack ?? err}`));

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      // --- page runtime + live renderer surface ------------------------------

      const staticRoute = (file: string, noStore = false) =>
        sendStaticFile(req, res, file, { noStore }) || sendJson(res, 404, { error: `missing file: ${path.basename(file)} (run \`npm run build\`)` });

      if (req.method === "GET" || req.method === "HEAD") {
        if (url.pathname === "/agent.js") return void staticRoute(path.join(liveDir(), "agent.js"), true);
        if (url.pathname === "/panel.js") return void staticRoute(path.join(liveDir(), "panel.js"), true);
        if (url.pathname === "/live/index.html" || url.pathname === "/live/") return void staticRoute(path.join(liveDir(), "index.html"), true);
        if (url.pathname === "/renderer.js") return void staticRoute(path.join(liveDir(), "renderer.js"));
        if (url.pathname === "/engine/webwallgl.global.min.js") {
          const engine = engineFile();
          if (!engine) return void sendJson(res, 404, { error: "webwallgl engine not installed (npm install webwallgl)" });
          return void staticRoute(engine);
        }
      }

      // --- wallpaper files (WebWallGL httpSource target) ---------------------

      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/files/")) {
        const rest = url.pathname.slice("/files/".length);
        const slash = rest.indexOf("/");
        const sourceId = slash >= 0 ? rest.slice(0, slash) : rest;
        const rel = slash >= 0 ? decodeURIComponent(rest.slice(slash + 1)) : "";
        const entry = await resolveSourceDir(sourceId, storedCustomSources());
        if (!entry) {
          sendJson(res, 404, { error: `unknown source: ${sourceId}` });
          return;
        }
        const target = rel ? safeJoin(entry.dir, rel) : undefined;
        if (!target || !sendStaticFile(req, res, target)) {
          sendJson(res, 404, { error: "not found" });
        }
        return;
      }

      // --- control API -------------------------------------------------------

      if (req.method === "GET" && url.pathname === "/api/log") {
        sendJson(res, 200, { log: serveLog });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/host-alive") {
        (globalThis as { __zwHostAlive?: number }).__zwHostAlive = Date.now();
        sendJson(res, 200, { ok: true });
        return;
      }

      // SSE: the config channel. New subscribers get the current payload as
      // their first event, so a runtime that connects late never misses a push.
      if (req.method === "GET" && url.pathname === "/api/events") {
        hub.subscribe(req, res, currentRuntimePayload());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true, service: "zcode-wallpaper", pid: process.pid, cdpPort, apiPort });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, publicConfig(runtimeConfig()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const patch = sanitize(JSON.parse(await readBody(req)));
        const before = runtimeConfig();
        const config = { ...before, ...patch };
        if (patch.rotationEnabled === true && !before.rotationEnabled) lastRotateAt = Date.now();
        saveConfig(persisted(config));
        await publishConfig(config);
        sendJson(res, 200, { ok: true, windows: heldWindowCount(), ...publicConfig(config) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/wallpaper") {
        const body = JSON.parse(await readBody(req));
        const dataUri = typeof body?.dataUri === "string" ? body.dataUri : "";
        const m = /^data:(image\/(?:jpeg|png|webp|gif|bmp));base64,(.+)$/.exec(dataUri);
        if (!m) throw new Error("dataUri must be a base64 image data URI");
        const bytes = Buffer.from(m[2], "base64");
        if (bytes.length > MAX_WALLPAPER_BYTES) {
          throw new Error(`image too large (max ${MAX_WALLPAPER_BYTES / 1024 / 1024} MB)`);
        }
        const config = runtimeConfig();
        fs.mkdirSync(dataDir(), { recursive: true });
        const dest = path.join(dataDir(), "wallpaper" + IMAGE_EXT[m[1]]);
        fs.writeFileSync(dest, bytes);
        primeAssets(dest, await loadWallpaper(dest));
        const next: BeautifyConfig = {
          ...config,
          mediaType: "image",
          wallpaperPath: dest,
          live: undefined,
          sceneVideoUrl: undefined,
          monetSourcePath: dest,
        };
        saveConfig(persisted(next));
        await publishConfig(next);
        sendJson(res, 200, { ok: true, windows: heldWindowCount(), ...publicConfig(next) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        const stored = loadConfig();
        if (stored.wallpaperPath || stored.live || stored.sceneVideoUrl) {
          writeBackup(stored);
        }
        await resetSessions();
        saveConfig({
          ...stored,
          wallpaperPath: undefined,
          mediaType: undefined,
          live: undefined,
          sceneVideoUrl: undefined,
          monetSourcePath: undefined,
        });
        invalidateAssets();
        sendJson(res, 200, { ok: true, hasBackup: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/restore") {
        let saved: Partial<BeautifyConfig>;
        try {
          saved = readBackup();
        } catch {
          throw new Error("no wallpaper backup available");
        }
        const config: BeautifyConfig = { ...runtimeConfig(), ...saved };
        saveConfig(persisted(config));
        await publishConfig(config);
        // A prior /api/reset cleared the bootstrap registration; re-register
        // + re-evaluate so the wallpaper survives reloads again.
        await rearmSessions(config, apiPort);
        sendJson(res, 200, { ok: true, windows: heldWindowCount(), ...publicConfig(config) });
        return;
      }

      // --- wallpaper library ---------------------------------------------------

      if (req.method === "GET" && url.pathname === "/api/wallpapers") {
        const lib = await enumerateWallpapers();
        const custom = storedCustomSources();
        const entries = lib.wallpapers.map((w) => ({
          id: w.id,
          title: w.title,
          type: w.type,
          origin: w.origin,
          sizeBytes: w.sizeBytes,
          mtimeMs: w.mtimeMs,
          dir: w.dir,
          previewUrl: w.preview ? `/files/${w.id}/${w.preview}` : undefined,
        }));
        const customs = [];
        for (const c of custom) {
          const entry = await resolveSourceDir(c.id, custom);
          if (entry) {
            customs.push({
              id: c.id,
              title: entry.title,
              type: entry.type,
              origin: "custom" as const,
              sizeBytes: entry.sizeBytes,
              mtimeMs: entry.mtimeMs,
              dir: entry.dir,
              previewUrl: entry.preview ? `/files/${c.id}/${entry.preview}` : undefined,
            });
          }
        }
        // The active source id across all wallpaper kinds: live scenes carry
        // it in config.live; video wallpapers only in sceneVideoUrl's path.
        const curCfg = runtimeConfig();
        const current =
          curCfg.live?.sourceId ??
          (curCfg.mediaType === "video" && curCfg.sceneVideoUrl
            ? (/\/files\/([^/]+)\//.exec(curCfg.sceneVideoUrl)?.[1] ?? null)
            : null);
        sendJson(res, 200, {
          we: lib.we ? { root: lib.we.root } : null,
          steamRoots: lib.steamRoots,
          wallpapers: [...customs, ...entries],
          current,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apply-source") {
        const body = JSON.parse(await readBody(req));
        const id = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
        if (!id) throw new Error("sourceId is required");
        const result = await applySource(id, runtimeConfig());
        sendJson(res, 200, {
          ...publicConfig(runtimeConfig()),
          ok: true,
          windows: heldWindowCount(),
          mediaType: result.mediaType,
          title: result.entry.title,
          type: result.entry.type,
        });
        return;
      }

      // Register a picked local path (scene dir / .pkg / video / .zw.zip
      // package) and apply it. Zip paths run through the package importer.
      if (req.method === "POST" && url.pathname === "/api/import") {
        const body = JSON.parse(await readBody(req));
        const input = typeof body?.path === "string" ? body.path.trim() : "";
        if (!input) throw new Error("path is required");
        const abs = path.resolve(input);
        let result: ApplyLiveResult;
        let sourceId: string;
        if (/\.zip$/i.test(abs)) {
          if (!fs.existsSync(abs)) throw new Error(`package not found: ${abs}`);
          const r = await importPackageFromFile(abs, runtimeConfig(), true);
          sourceId = r.id;
          result = r;
        } else {
          const { id } = registerCustomSource(abs);
          sourceId = id;
          result = await applySource(id, runtimeConfig());
        }
        sendJson(res, 200, {
          ...publicConfig(runtimeConfig()),
          ok: true,
          windows: heldWindowCount(),
          sourceId,
          mediaType: result.mediaType,
          title: result.entry.title,
          type: result.entry.type,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/pick-path") {
        const picked = await pickFileViaDialog();
        sendJson(res, 200, { ok: Boolean(picked), path: picked });
        return;
      }

      // --- cross-machine resource packages -----------------------------------

      // Export a wallpaper directory as a .zw.zip the user can carry to
      // another machine (its panel's 导入资源包… accepts it back).
      if (req.method === "GET" && url.pathname === "/api/export") {
        const id = url.searchParams.get("id") ?? "";
        const entry = id ? await resolveSourceDir(id, storedCustomSources()) : undefined;
        if (!entry) {
          sendJson(res, 404, { error: `unknown source: ${id}` });
          return;
        }
        const { default: AdmZip } = await import("adm-zip");
        const zip = new AdmZip();
        zip.addLocalFolder(entry.dir);
        const safeTitle = entry.title.replace(/[\\\\/:*?"<>|]/g, "").trim().slice(0, 60) || "wallpaper";
        const zipPath = path.join(os.tmpdir(), `zw-export-${id}-${Date.now()}.zip`);
        await zip.writeZipPromise(zipPath);
        const size = fs.statSync(zipPath).size;
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": size,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeTitle)}.zw.zip`,
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Content-Disposition",
        });
        const stream = fs.createReadStream(zipPath);
        stream.pipe(res);
        stream.on("close", () => fs.rm(zipPath, { force: true }, () => undefined));
        return;
      }

      // Import an uploaded .zw.zip package: binary body -> temp -> extract ->
      // register (and optionally apply). Sizes up to ~4 GB stream to disk.
      if (req.method === "POST" && url.pathname === "/api/import-package") {
        const apply = url.searchParams.get("apply") === "1";
        const tempZip = path.join(os.tmpdir(), `zw-import-${Date.now()}.zip`);
        await readBodyToFile(req, tempZip, 4 * 1024 ** 3);
        try {
          const r = await importPackageFromFile(tempZip, runtimeConfig(), apply);
          sendJson(res, 200, {
            ok: true,
            sourceId: r.id,
            title: r.entry.title,
            type: r.entry.type,
            mediaType: r.mediaType,
            windows: heldWindowCount(),
          });
        } finally {
          fs.rmSync(tempZip, { force: true });
        }
        return;
      }

      // Browser-chooser import (same UX as image upload): file bytes ->
      // server-side storage. Accepts .zw.zip packages, bare .pkg scene files
      // (a minimal project.json is synthesized) and video files. No
      // Wallpaper Engine / Steam involved.
      if (req.method === "POST" && url.pathname === "/api/upload-wallpaper") {
        const apply = url.searchParams.get("apply") === "1";
        const name = (req.headers["x-zw-filename"] ?? "wallpaper.bin").toString();
        const ext = path.extname(name).toLowerCase();
        if (![".zip", ".pkg", ".mp4", ".webm"].includes(ext)) {
          throw new Error(`unsupported file type: ${ext || "(none)"} — use .zip / .pkg / .mp4 / .webm`);
        }
        const tempFile = path.join(os.tmpdir(), `zw-upl-${Date.now()}${ext}`);
        await readBodyToFile(req, tempFile, 4 * 1024 ** 3);
        try {
          const title = name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "").trim() || "导入的壁纸";
          if (ext === ".zip") {
            const r = await importPackageFromFile(tempFile, runtimeConfig(), apply);
            sendJson(res, 200, { ok: true, sourceId: r.id, title: r.entry.title, type: r.entry.type, mediaType: r.mediaType, windows: heldWindowCount() });
            return;
          }
          // .pkg / video: store under the packages dir with a synthesized
          // project.json so enumeration and serving treat it like any source.
          const dest = path.join(dataDir(), "packages", `upl-${Date.now()}`);
          fs.mkdirSync(dest, { recursive: true });
          if (ext === ".pkg") {
            fs.copyFileSync(tempFile, path.join(dest, "scene.pkg"));
            fs.writeFileSync(path.join(dest, "project.json"), JSON.stringify({ title, type: "scene", file: "scene.pkg", visibility: "private" }, null, 2));
          } else {
            fs.copyFileSync(tempFile, path.join(dest, name.replace(/[\\/:*?"<>|]/g, "_")));
            fs.writeFileSync(path.join(dest, "project.json"), JSON.stringify({ title, type: "video", file: name.replace(/[\\/:*?"<>|]/g, "_"), visibility: "private" }, null, 2));
          }
          const { id } = registerCustomSource(dest);
          const result = await applySource(id, runtimeConfig(), apply);
          sendJson(res, 200, { ok: true, sourceId: id, title: result.entry.title, type: result.entry.type, mediaType: result.mediaType, windows: heldWindowCount() });
        } finally {
          fs.rmSync(tempFile, { force: true });
        }
        return;
      }

      // Delete a custom-imported source (sources.ts owns the switch-away +
      // background file cleanup policy).
      if (req.method === "POST" && url.pathname === "/api/delete-source") {
        const body = JSON.parse(await readBody(req));
        const id = typeof body?.id === "string" ? body.id : "";
        if (!id) throw new Error("id is required");
        const r = await deleteSource(id, runtimeConfig());
        sendJson(res, 200, r);
        return;
      }

      // --- live-frame feedback (Monet source from real rendered pixels) --------

      if (req.method === "POST" && url.pathname === "/api/live-frame") {
        const body = JSON.parse(await readBody(req));
        const source = typeof body?.source === "string" ? body.source : "";
        const m = /^data:image\/(?:jpeg|png);base64,(.+)$/.exec(typeof body?.dataUrl === "string" ? body.dataUrl : "");
        if (!source || !m) {
          sendJson(res, 400, { error: "source and dataUrl are required" });
          return;
        }
        const file = liveFrameFile(source);
        fs.mkdirSync(dataDir(), { recursive: true });
        fs.writeFileSync(file, Buffer.from(m[1], "base64"));
        const config = runtimeConfig();
        if (config.live?.sourceId === source) {
          const next: BeautifyConfig = { ...config, monetSourcePath: file };
          saveConfig(persisted(next));
          await publishConfig(next);
        }
        sendJson(res, 200, { ok: true, file });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/diag") {
        const msg = url.searchParams.get("msg") ?? "";
        const lvl = url.searchParams.get("lvl") ?? "info";
        console.log(`[live:${lvl}] ${msg}`);
        sendJson(res, 204, {});
        return;
      }

      // Static images the user uploaded (library listing for the panel).
      if (req.method === "GET" && url.pathname === "/api/library") {
        const images: Array<{ name: string; path: string }> = [];
        try {
          for (const f of fs.readdirSync(dataDir())) {
            if (/\.(jpe?g|png|webp|bmp|gif)$/i.test(f)) {
              images.push({ name: f, path: path.join(dataDir(), f) });
            }
          }
        } catch {
          /* empty data dir */
        }
        sendJson(res, 200, { images });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apply-image") {
        const body = JSON.parse(await readBody(req));
        if (typeof body?.path !== "string" || !fs.existsSync(body.path)) {
          throw new Error("provide an existing image path");
        }
        const config = runtimeConfig();
        const next: BeautifyConfig = {
          ...config,
          mediaType: "image",
          wallpaperPath: body.path,
          live: undefined,
          sceneVideoUrl: undefined,
          monetSourcePath: body.path,
        };
        saveConfig(persisted(next));
        await publishConfig(next);
        sendJson(res, 200, { ok: true, windows: heldWindowCount(), ...publicConfig(next) });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(apiPort, "127.0.0.1", resolve);
  });

  server.on("error", (err) => {
    console.error(`serve: http server error — ${(err as Error).message}`);
  });

  console.log(`serve: control API on http://127.0.0.1:${apiPort} — Ctrl+C to stop`);
  console.log(`serve: injecting into ZCode renderers on CDP port ${cdpPort}`);
  console.log(`serve: webwallgl engine: ${engineFile() ?? "NOT FOUND (npm install webwallgl)"}`);

  // A manually-started serve (CLI, no MCP host) must not linger forever:
  // when ZCode has been gone for ~10 minutes (generous: manual serves are
  // typically used to bridge restarts during development), exit.
  if (process.env.ZW_SPAWNED_BY_MCP !== "1") {
    let manualTicks = 0;
    const { isZcodeProcessRunning } = await import("./launch.js");
    setInterval(() => {
      void (async () => {
        const alive = await isZcodeProcessRunning().catch(() => true);
        if (alive) {
          manualTicks = 0;
          return;
        }
        if (++manualTicks >= 20) {
          console.log("serve: ZCode not running for ~10 minutes — exiting (manual serve).");
          process.exit(0);
        }
      })();
    }, 30_000);
  }

  // Early-launch serve (ZW_EARLY=1, started hidden by the shortcut wrapper
  // BEFORE ZCode): it owns the session until the plugin host's MCP shows up
  // (it heartbeats /api/host-alive every 10s; the host sees this serve
  // healthy and never starts its own). Lifecycle: no host within 3 minutes of
  // ZCode running means the plugin is disabled/uninstalled — reset the UI
  // and exit; a host that goes silent for 45s after being seen means the
  // plugin was disabled mid-session — same. Handing back never happens
  // (port handoff would flash); the early serve simply is the serve.
  if (process.env.ZW_EARLY === "1") {
    let hostSeen = false;
    let lastHostAlive = 0;
    const startedAt = Date.now();
    let zcodeSeenAt = 0;
    const { isZcodeProcessRunning } = await import("./launch.js");
    setInterval(() => {
      void (async () => {
        // Explicit disable beats every timeout heuristic: the moment ZCode's
        // config says this plugin is off, restore default appearance and exit
        // (a disabled-restart via shortcut then shows nothing at all, instead
        // of the wallpaper lingering for the no-host grace window).
        if (pluginDisabledIn(path.join(os.homedir(), ".zcode", "cli", "config.json"))) {
          console.log("serve: plugin disabled in ZCode — restoring default appearance and exiting");
          await shutdownServe().catch(() => undefined);
          process.exit(0);
        }
        const zcode = await isZcodeProcessRunning().catch(() => true);
        if (zcode) zcodeSeenAt = Date.now();
        const now = Date.now();
        const lastAlive = (globalThis as { __zwHostAlive?: number }).__zwHostAlive ?? 0;
        if (lastAlive > lastHostAlive) { lastHostAlive = lastAlive; hostSeen = true; }
        if (hostSeen && lastAlive && now - lastAlive > 45_000 && now - zcodeSeenAt < 30_000) {
          console.log("serve: plugin host gone (disabled?) — restoring default appearance and exiting");
          await shutdownServe().catch(() => undefined);
          process.exit(0);
        }
        if (!hostSeen && now - startedAt > 180_000 && zcode) {
          console.log("serve: no plugin host appeared within 3 minutes — plugin not enabled, exiting");
          await shutdownServe().catch(() => undefined);
          process.exit(0);
        }
      })();
    }, 5_000);
  }

  // Auto-rotation: a 30s tick checks whether the configured interval has
  // fully elapsed, then applies the next library wallpaper (custom imports +
  // workshop subscriptions; the one in use is never re-applied). Sequence
  // mode walks the list in order; random re-rolls every time.
  setInterval(() => {
    void (async () => {
      const cfg = runtimeConfig();
      if (!cfg.rotationEnabled) return;
      if (Date.now() - lastRotateAt < (cfg.rotationMinutes ?? 30) * 60_000) return;
      const ids = storedCustomSources().map((c) => c.id);
      const lib = await enumerateWallpapers().catch(() => undefined);
      if (lib) for (const w of lib.wallpapers) ids.push(w.id);
      lastRotateAt = Date.now();
      const pool = ids.filter((id) => id !== (cfg.live?.sourceId ?? ""));
      if (pool.length === 0) return;
      const next =
        cfg.rotationOrder === "random"
          ? pool[Math.floor(Math.random() * pool.length)]
          : pool[rotationCursor++ % pool.length];
      console.log(`serve: auto-rotation -> ${next}`);
      await applySource(next, runtimeConfig()).catch(() => undefined);
    })();
  }, 30_000);

  // Launch-shortcut sync also runs here (not only in the MCP bootstrap): the
  // early serve exists before any plugin host, and a healthy serve keeps the
  // host from ever starting its own — this is the only reliable hook it has.
  import("./shortcuts.js")
    .then((m) => m.ensureShortcutsHaveCdpFlag(cdpPort))
    .then((r) => { if (r.updated.length) console.log(`serve: ${r.updated.length} shortcut(s) point at the early launcher`); })
    .catch(() => undefined);

  await migrateLegacyVideo();
  // The session loop never resolves: poll, hold, self-heal. Pages that come
  // up after boot receive the current payload as their first SSE event, so
  // no boot-wave double push is needed anymore.
  await startSessionLoop(runtimeConfig, apiPort);
}

export { DEFAULT_API_PORT };
