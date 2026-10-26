/**
 * `serve` mode: a localhost-only control API, the live-renderer file surface,
 * and persistent CDP injection sessions.
 *
 * Routes, in three families:
 *   control   /api/*  — config, wallpaper library, apply/reset, live-frame
 *   live      /live/index.html + /renderer.js, /engine/webwallgl.global.min.js
 *   files     /files/<sourceId>/<rel> — the wallpaper directories, served as
 *             plain static files (Range + ETag), which is all WebWallGL's
 *             httpSource needs: it fetches project.json / scene.pkg / loose
 *             assets by relative path under one base URL.
 *
 * Injection connections are held open so Page.addScriptToEvaluateOnNewDocument
 * keeps re-running across renderer reloads for as long as this process lives.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";import {
  CdpConnection,
  buildBootstrapScript,
  buildResetScript,
  listTargets,
  pickRendererTargets,
} from "./cdp.js";
import {
  buildLiveUrl,
  buildPayload,
  DEFAULT_API_PORT,
  DEFAULT_CONFIG,
  type BeautifyConfig,
  type BuiltPayload,
  type CustomSource,
} from "./inject.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { buildPanelScript } from "../panel/panelScript.js";
import { dataDir, loadConfig, saveConfig } from "./launch.js";
import { safeJoin, sendStaticFile } from "./media.js";
import { detectWallpaperType } from "./wallpaperType.js";
import {
  enumerateWallpapers,
  resolveSourceDir,
  type WallpaperEntry,
} from "./steam.js";

const POLL_MS = 1500;
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

// Plugin root: the directory holding live/ and .zcode-plugin/. Located by
// probing upward because the module's own depth differs between the tsc
// layout (dist/core/server.js -> 2 up) and the bundled layout (dist/cli.js ->
// 1 up).
const pluginRoot = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, ".zcode-plugin")) || fs.existsSync(path.join(dir, "live"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
})();

function liveDir(): string {
  return path.join(pluginRoot, "live");
}

/** The WebWallGL engine build: explicit override, vendored copy, then node_modules. */
function engineFile(): string | undefined {
  const candidates = [
    process.env.ZW_ENGINE_FILE,
    path.join(pluginRoot, "vendor", "webwallgl.global.min.js"),
    path.join(pluginRoot, "node_modules", "webwallgl", "webwallgl.global.min.js"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p));
}

export interface ServeOptions {
  cdpPort: number;
  apiPort: number;
}

interface HeldSession {
  conn: CdpConnection;
  themeScriptId?: string;
  /** Panel script registration; removed before re-registering so serve
   * restarts don't stack duplicate (self-no-op'ing) page scripts. */
  panelScriptId?: string;
}

// One decoded image + extracted theme, reused across slider updates so the
// panel feels instant. Invalidated whenever the Monet source file changes.
let cachedAssets: { file: string; mtimeMs: number; assets: WallpaperAssets } | undefined;

/**
 * @param allowDecode false = cache-only (used for the instant first push of a
 * wallpaper switch; the palette follows in a second push once decoded).
 */
async function getAssets(config: BeautifyConfig, allowDecode = true): Promise<WallpaperAssets | undefined> {
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
    return assets;
  } catch {
    return undefined; // undecodable source: inject without Monet rather than not at all
  }
}

function storedCustomSources(): CustomSource[] {
  const stored = loadConfig();
  return Array.isArray(stored.customSources) ? (stored.customSources as CustomSource[]) : [];
}

function currentConfig(cdpPort: number, apiPort: number): BeautifyConfig {
  const stored = loadConfig() as Partial<BeautifyConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    port: cdpPort,
    apiPort,
    customSources: storedCustomSources(),
  };
}

/** What goes to disk — runtime port flags are not persisted settings; the
 * stored values win, and customSources is re-read from disk (a registration
 * that happened after this config object was captured must not be clobbered). */
function persisted(config: BeautifyConfig): Record<string, unknown> {
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

function hasBackup(): boolean {
  return fs.existsSync(backupFile());
}

function publicConfig(config: BeautifyConfig) {
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
    wallBrightness: config.wallBrightness ?? 100,
    wallContrast: config.wallContrast ?? 100,
    wallSaturate: config.wallSaturate ?? 100,
    wallOpacity: config.wallOpacity ?? 0,
    posX: config.posX ?? 50,
    posY: config.posY ?? 50,
    layerScale: config.layerScale ?? 100,
    flip: config.flip === true,
    switchTransition: config.switchTransition === "cut" ? "cut" : "fade",
    rotationEnabled: config.rotationEnabled === true,
    rotationMinutes: config.rotationMinutes ?? 30,
    rotationOrder: config.rotationOrder === "random" ? "random" : "sequence",
    hasBackup: hasBackup(),
    cdpPort: config.port,
    apiPort: config.apiPort,
  };
}

function sanitize(body: any): Partial<BeautifyConfig> {
  const out: Partial<BeautifyConfig> = {};
  if (typeof body?.blur === "number" && body.blur >= 0 && body.blur <= 100) out.blur = body.blur;
  if (typeof body?.dim === "number" && body.dim >= 0 && body.dim <= 100) out.dim = body.dim;
  if (typeof body?.monet === "boolean") out.monet = body.monet;
  if (typeof body?.wallpaperVisible === "boolean") out.wallpaperVisible = body.wallpaperVisible;
  if (body?.fit === "cover" || body?.fit === "contain" || body?.fit === "smart" || body?.fit === "stretch") out.fit = body.fit;
  if (typeof body?.liveFps === "number" && body.liveFps >= 10 && body.liveFps <= 60) out.liveFps = Math.round(body.liveFps);
  if (typeof body?.liveMuted === "boolean") out.liveMuted = body.liveMuted;
  // dsh-style picture knobs
  if (typeof body?.wallBrightness === "number") out.wallBrightness = Math.min(160, Math.max(40, Math.round(body.wallBrightness)));
  if (typeof body?.wallContrast === "number") out.wallContrast = Math.min(200, Math.max(40, Math.round(body.wallContrast)));
  if (typeof body?.wallSaturate === "number") out.wallSaturate = Math.min(200, Math.max(0, Math.round(body.wallSaturate)));
  if (typeof body?.wallOpacity === "number") out.wallOpacity = Math.min(90, Math.max(0, Math.round(body.wallOpacity)));
  if (typeof body?.posX === "number") out.posX = Math.min(100, Math.max(0, Math.round(body.posX)));
  if (typeof body?.posY === "number") out.posY = Math.min(100, Math.max(0, Math.round(body.posY)));
  if (typeof body?.layerScale === "number") out.layerScale = Math.min(150, Math.max(50, Math.round(body.layerScale)));
  if (typeof body?.flip === "boolean") out.flip = body.flip;
  if (body?.switchTransition === "cut" || body?.switchTransition === "fade") out.switchTransition = body.switchTransition;
  // auto-rotation
  if (typeof body?.rotationEnabled === "boolean") out.rotationEnabled = body.rotationEnabled;
  if (typeof body?.rotationMinutes === "number") out.rotationMinutes = Math.min(1440, Math.max(1, Math.round(body.rotationMinutes)));
  if (body?.rotationOrder === "sequence" || body?.rotationOrder === "random") out.rotationOrder = body.rotationOrder;
  return out;
}

// --- source application --------------------------------------------------------

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

export interface ApplyLiveResult {
  entry: WallpaperEntry;
  mediaType: "live" | "video";
  /** The composed config that was (or would be) persisted for this source. */
  config: BeautifyConfig;
  windows: number;
}

/**
 * Applies a wallpaper source (workshop subscription, WE project or custom dir)
 * as the current wallpaper. Scenes, web pages and video files all render live
 * through the WebWallGL iframe — videos ride the same engine pipeline as
 * scenes (dsh-style) instead of a separately injected <video> element.
 */
async function applySource(
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
    // dsh's model: video wallpapers play on a NATIVE <video> element in the
    // host page (preplayed offscreen, swapped in already playing). The
    // engine's WebCodecs path clears its canvas on pause and fast-forwards
    // on wake — native elements have neither quirk.
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
  let windows = 0;
  if (apply) {
    saveConfig(persisted(next));
    // Two-phase push: switch the wallpaper layer first (cache-only palette,
    // instant), then decode the new Monet source in the background and push
    // the recolored UI as a second pass — the switch itself never waits on
    // image decoding.
    windows = await pushConfigToSessions(next).catch(() => 0);
    void (async () => {
      await getAssets(next, true).catch(() => undefined);
      await pushConfigToSessions(next, true).catch(() => 0);
    })();
  }
  return { entry, mediaType: next.mediaType === "video" ? "video" : "live", config: next, windows };
}

/**
 * One-time migration: video wallpapers briefly went through the WebGL engine
 * (live.kind "video"); that path pauses to a cleared canvas and fast-forwards
 * on wake. Move any stored config back onto the native <video> layer.
 */
async function migrateLegacyVideo(): Promise<void> {
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
function registerCustomSource(input: string): { id: string; dir: string; name?: string } {
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
async function importPackageFromFile(
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

// --- injection session management -------------------------------------------

/** Races a promise against a timeout — a half-dead socket can otherwise leave
 *  an await pending forever (no close event), wedging the heal loop. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))]);
}

const held = new Map<string, HeldSession>();

async function registerScript(session: HeldSession, source: string): Promise<string> {
  const { identifier } = await session.conn.send("Page.addScriptToEvaluateOnNewDocument", { source });
  return identifier;
}

async function buildBootstrapFor(config: BeautifyConfig, allowDecode = false): Promise<string> {
  const assets = await getAssets(config, allowDecode);
  const payload: BuiltPayload = buildPayload(config, assets, {
    liveUrl: buildLiveUrl(config),
  });
  payload.apiPort = config.apiPort;
  return buildBootstrapScript(payload);
}

async function holdSession(
  target: { id: string; title: string; webSocketDebuggerUrl?: string },
  config: BeautifyConfig,
  apiPort: number
): Promise<void> {
  if (!target.webSocketDebuggerUrl) return;
  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl);
  await conn.send("Page.enable");
  // The live renderer iframe loads from http://127.0.0.1; a restrictive CSP on
  // the host page must not be able to block it.
  await conn.send("Page.setBypassCSP", { enabled: true }).catch(() => undefined);
  const session: HeldSession = { conn };

  // The FIRST push on a fresh page must include the Monet/transparency
  // overrides or the app's opaque surfaces cover the wallpaper. Cache-only
  // pushes can't guarantee that: every live-frame capture bumps the source
  // file's mtime and invalidates the cache, so the next page's initial push
  // would be bare again. Boot correctness beats boot latency — decode on
  // demand here (cached across holds, so it costs one decode per capture).
  const bootstrap = await buildBootstrapFor(config, true);
  session.themeScriptId = await registerScript(session, bootstrap);
  await conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true });

  const panelScript = buildPanelScript(apiPort);
  if (session.panelScriptId) {
    await session.conn
      .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.panelScriptId })
      .catch(() => {});
  }
  const { identifier: panelId } = await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: panelScript });
  session.panelScriptId = panelId;
  await conn.send("Runtime.evaluate", { expression: panelScript, returnByValue: true });

  held.set(target.id, session);
}

/** Re-evaluates the theme bootstrap in every live session after a config change. */
async function pushConfigToSessions(config: BeautifyConfig, allowDecode = false): Promise<number> {
  const bootstrap = await buildBootstrapFor(config, allowDecode);
  let ok = 0;
  for (const [id, session] of held) {
    try {
      if (session.themeScriptId) {
        await session.conn
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.themeScriptId })
          .catch(() => {});
      }
      session.themeScriptId = await registerScript(session, bootstrap);
      await session.conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true });
      // The panel reads config once at mount; keep its badge/library in sync
      // with this push. Missing panel (older build) degrades silently.
      await session.conn
        .send("Runtime.evaluate", {
          expression: "if (window.__zwPanelRefresh) window.__zwPanelRefresh()",
          returnByValue: true,
        })
        .catch(() => undefined);
      ok++;
    } catch {
      session.conn.close();
      held.delete(id);
    }
  }
  return ok;
}

async function poll(config: BeautifyConfig, apiPort: number): Promise<void> {
  try {
    const targets = pickRendererTargets(await listTargets(config.port));
    const current = new Set(targets.map((t) => t.id));
    for (const t of targets) {
      if (!held.has(t.id)) {
        try {
          await holdSession(t, config, apiPort);
          console.log(`serve: panel + wallpaper layer injected into "${t.title}" (${t.id})`);
        } catch {
          /* retry next tick */
        }
      }
    }
    for (const id of [...held.keys()]) {
      if (!current.has(id)) {
        held.get(id)!.conn.close();
        held.delete(id);
      }
    }
  } catch {
    /* CDP not reachable; keep polling */
  }
}

// --- HTTP API ----------------------------------------------------------------

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

/** Live-frame capture path in the data dir, keyed by source id. */
function liveFrameFile(sourceId: string): string {
  const safe = sourceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(dataDir(), `live-frame-${safe}.jpg`);
}

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
 * Graceful shutdown: restore ZCode's default appearance (reset injection,
 * unregister page scripts), close held CDP sessions and the HTTP server.
 * Called by the hosting MCP process when ZCode closes its stdio pipe
 * (plugin disabled / app closing) — the event-driven lifecycle exit.
 */
export async function shutdownServe(): Promise<void> {
  for (const [, session] of held) {
    try {
      await session.conn.send("Runtime.evaluate", { expression: buildResetScript() });
      if (session.themeScriptId) {
        await session.conn.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.themeScriptId }).catch(() => {});
      }
      if (session.panelScriptId) {
        await session.conn.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.panelScriptId }).catch(() => {});
      }
      session.conn.close();
    } catch {
      /* already gone */
    }
  }
  held.clear();
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

      // --- live renderer surface -------------------------------------------

      if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/live/index.html" || url.pathname === "/live/")) {
        if (!sendStaticFile(req, res, path.join(liveDir(), "index.html"), { noStore: true })) {
          sendJson(res, 404, { error: "renderer page missing (run `npm run build`)" });
        }
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/renderer.js") {
        if (!sendStaticFile(req, res, path.join(liveDir(), "renderer.js"))) {
          sendJson(res, 404, { error: "renderer script missing (run `npm run build`)" });
        }
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/engine/webwallgl.global.min.js") {
        const engine = engineFile();
        if (!engine || !sendStaticFile(req, res, engine)) {
          sendJson(res, 404, { error: "webwallgl engine not installed (npm install webwallgl)" });
        }
        return;
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
        const windows = await pushConfigToSessions(config).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(config) });
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
        cachedAssets = { file: dest, mtimeMs: fs.statSync(dest).mtimeMs, assets: await loadWallpaper(dest) };
        const next: BeautifyConfig = {
          ...config,
          mediaType: "image",
          wallpaperPath: dest,
          live: undefined,
          sceneVideoUrl: undefined,
          monetSourcePath: dest,
        };
        saveConfig(persisted(next));
        const windows = await pushConfigToSessions(next).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        const stored = loadConfig();
        if (stored.wallpaperPath || stored.live || stored.sceneVideoUrl) {
          fs.mkdirSync(dataDir(), { recursive: true });
          fs.writeFileSync(backupFile(), JSON.stringify(stored));
        }
        for (const [id, session] of held) {
          try {
            if (session.themeScriptId) {
              await session.conn
                .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.themeScriptId })
                .catch(() => {});
              session.themeScriptId = undefined;
            }
            await session.conn.send("Runtime.evaluate", { expression: buildResetScript() });
          } catch {
            session.conn.close();
            held.delete(id);
          }
        }
        saveConfig({
          ...stored,
          wallpaperPath: undefined,
          mediaType: undefined,
          live: undefined,
          sceneVideoUrl: undefined,
          monetSourcePath: undefined,
        });
        cachedAssets = undefined;
        sendJson(res, 200, { ok: true, hasBackup: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/restore") {
        let saved: Partial<BeautifyConfig>;
        try {
          saved = JSON.parse(fs.readFileSync(backupFile(), "utf8"));
        } catch {
          throw new Error("no wallpaper backup available");
        }
        const config: BeautifyConfig = { ...runtimeConfig(), ...saved };
        saveConfig(persisted(config));
        const windows = await pushConfigToSessions(config).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(config) });
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
          windows: result.windows,
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
        let result: ApplyLiveResult & { id?: string };
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
          windows: result.windows,
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
            windows: r.windows,
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
            sendJson(res, 200, { ok: true, sourceId: r.id, title: r.entry.title, type: r.entry.type, mediaType: r.mediaType, windows: r.windows });
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
          sendJson(res, 200, { ok: true, sourceId: id, title: result.entry.title, type: result.entry.type, mediaType: result.mediaType, windows: result.windows });
        } finally {
          fs.rmSync(tempFile, { force: true });
        }
        return;
      }

      // Delete a custom-imported source. Files are removed only when they live
      // inside this plugin's packages dir (uploaded/extracted copies); sources
      // registered from a user path are only unregistered. When the source is
      // the current wallpaper, another one is applied first (or the wallpaper
      // is reset when the library has nothing else) so the delete just works.
      if (req.method === "POST" && url.pathname === "/api/delete-source") {
        const body = JSON.parse(await readBody(req));
        const id = typeof body?.id === "string" ? body.id : "";
        if (!id) throw new Error("id is required");
        const sources = storedCustomSources();
        const hit = sources.find((c) => c.id === id);
        if (!hit) throw new Error(`not a custom source: ${id}`);
        const config = runtimeConfig();
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
            await applySource(candidate.id, runtimeConfig());
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
            await pushConfigToSessions(runtimeConfig()).catch(() => 0);
          }
        }
        const packagesRoot = path.join(dataDir(), "packages");
        const rel = path.relative(packagesRoot, path.resolve(hit.dir));
        const managed = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
        // Unregister first and answer immediately — the source vanishes from
        // the library right away. File deletion happens in the background
        // with retries: the outgoing wallpaper iframe keeps file handles open
        // through its cross-fade (~1s), and Windows refuses to delete files
        // with open handles (the intermittent “删除失败”).
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
        sendJson(res, 200, { ok: true, filesRemoved: managed, switchedTo });
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
          await pushConfigToSessions(next).catch(() => 0);
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
        const windows = await pushConfigToSessions(next).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(next) });
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

  await migrateLegacyVideo();
  await withTimeout(poll(runtimeConfig(), apiPort), 20_000).catch((err) =>
    console.error(`serve: initial poll failed — ${(err as Error).message}`),
  );
  // Cold-cache boot wave: the initial injection is cache-only and lacks the
  // Monet/transparency overrides when the asset cache is cold — without them
  // the app's opaque surfaces cover the wallpaper once fully painted (the
  // "saw it at boot, then it vanished" effect). Decode and push the complete
  // payload on two beats: the first wave can race the initial holdSession's
  // CDP traffic, the second lands it. pushConfigToSessions(_, true) decodes
  // on first call and is cached thereafter.
  const bootWave = () => void pushConfigToSessions(runtimeConfig(), true).catch(() => undefined);
  setTimeout(bootWave, 1200);
  setTimeout(bootWave, 4000);
  // Self-heal: every ~30s compare each held page against the expected
  // injection (wallpaper layer / live iframe / css present when configured).
  // Any mismatch — heartbeat misfire, page-side race, manual DOM tampering —
  // re-evaluates the bootstrap, which rebuilds exactly what is missing.
  // Every tick races a timeout: a half-dead CDP socket can leave an await
  // pending FOREVER (no close event ever fires), which wedges this loop while
  // /api/health stays green — a "healthy but braindead" serve that also blocks
  // the plugin MCP's takeover. One bad tick must never kill or wedge the loop.
  let healTick = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    await withTimeout(poll(runtimeConfig(), apiPort), 20_000).catch((err) =>
      console.error(`serve: poll tick failed — ${(err as Error).message}`),
    );
    if (++healTick % 20 !== 0) continue;
    const config = runtimeConfig();
    const wantLayer = config.wallpaperVisible && Boolean(config.live || config.sceneVideoUrl || config.wallpaperPath);
    const wantLive = config.wallpaperVisible && config.mediaType === "live";
    const bootstrap = await buildBootstrapFor(config).catch(() => null);
    if (!bootstrap) continue;
    for (const [id, session] of held) {
      try {
        const r = (await withTimeout(
          session.conn.send("Runtime.evaluate", {
            expression: `JSON.stringify({layer:!!document.getElementById('zcode-wallpaper-wallpaper'),live:!!document.getElementById('zcode-wallpaper-live'),css:!!document.getElementById('zcode-wallpaper-style'),stale:!!(window.__zw&&window.__zw.cssText)})`,
            returnByValue: true,
          }),
          8_000,
        )) as { result?: { value?: string } };
        const st = JSON.parse(r?.result?.value ?? "{}");
        const broken =
          (wantLayer && !st.layer) ||
          (wantLive && !st.live) ||
          (!wantLayer && st.layer) ||
          !st.css ||
          !st.stale; // page never received an injection (fresh reload race)
        if (broken) {
          await withTimeout(
            session.conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true }),
            8_000,
          );
          console.log(`serve: self-heal re-injected window ${id}`);
        }
      } catch (err) {
        // timeout or dead socket — drop the stale session so poll() re-holds it
        console.error(`serve: heal tick dropped session ${id} — ${(err as Error).message}`);
        held.delete(id);
        try {
          session.conn.close();
        } catch {
          /* already gone */
        }
      }
    }
  }
}

export { DEFAULT_API_PORT };
