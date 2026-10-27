/**
 * Minimal Chrome DevTools Protocol client for the ZCode desktop renderer.
 *
 * ZCode (production) starts without a debug port; the launcher must start it
 * with `--remote-debugging-port=<port>` before this module can connect.
 *
 * Injection model (0.3.0): the registered script is THIN — critical CSS (so
 * opaque surfaces never flash over the wallpaper, pre-paint), the embedded
 * initial payload, a loader for the real runtime (live/agent.js, served as a
 * file so the deployed copy is always current) and the lifecycle heartbeat.
 * Config changes NEVER re-evaluate this script: they travel over SSE to the
 * agent, the page's single applier. That removes the whole push-race family
 * the inline-string bootstrap kept fighting (CDP queue storms from slider
 * drags, bare-css windows, evaluate-vs-reload ordering).
 */

import fs from "node:fs";
import { liveDir } from "./paths.js";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export class CdpError extends Error {}

export async function listTargets(port: number, host = "127.0.0.1"): Promise<CdpTarget[]> {
  let res: Response;
  try {
    res = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new CdpError(`Cannot reach CDP at ${host}:${port} — is ZCode running with --remote-debugging-port=${port}?`);
  }
  if (!res.ok) throw new CdpError(`CDP /json/list returned HTTP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

/** The main chat window renderer; excludes helper pages and overlay panels. */
export function pickRendererTargets(targets: CdpTarget[]): CdpTarget[] {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const main = pages.filter(
    (t) => t.url.includes("out/renderer/index.html") || t.title === "ZCode"
  );
  return main.length > 0 ? main : pages.filter((t) => !t.url.includes("devtools://"));
}

export class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, Set<(params: any) => void>>();
  readonly targetUrl: string;

  private constructor(wsUrl: string) {
    this.targetUrl = wsUrl;
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new CdpError(`${msg.error.message} (code ${msg.error.code})`));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.eventHandlers.get(msg.method)?.forEach((h) => h(msg.params));
      }
    });
    this.ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new CdpError("CDP connection closed"));
      this.pending.clear();
    });
  }

  static connect(wsUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const conn = new CdpConnection(wsUrl);
      const timer = setTimeout(() => reject(new CdpError("CDP websocket connect timeout")), 5000);
      conn.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(conn);
      });
      conn.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError(`CDP websocket error for ${wsUrl}`));
      });
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (params: any) => void): void {
    let set = this.eventHandlers.get(event);
    if (!set) {
      this.eventHandlers.set(event, (set = new Set()));
    }
    set.add(handler);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export interface InjectionPayload {
  /** CSS text covering :root/.dark variable overrides + wallpaper layer styling. */
  css: string;
  /** Optional data-URI wallpaper image; empty to skip the wallpaper layer. */
  wallpaperDataUri?: string;
  /** Optional loop video URL (http://127.0.0.1 from serve). */
  videoSrc?: string;
  /**
   * Optional live-renderer URL (http://127.0.0.1 from serve). Rendered as a
   * pointer-transparent <iframe> behind the UI; pointer input is forwarded
   * via postMessage so scene parallax/click effects keep working.
   */
  liveSrc?: string;
  /** Unique-ish id so re-injection is idempotent. */
  marker?: string;
  /** "contain" additionally drives a blurred backdrop layer behind the image. */
  fit?: "cover" | "contain" | "stretch";
  /** Poster URL painted UNDER the live layer — dsh's persistent underlay. */
  livePoster?: string;
  /** Mute state for the native loop-video layer. */
  videoMuted?: boolean;
  /** Switch effect (dsh's family) + speed, applied to the outgoing overlay. */
  transition?: string;
  transitionSpeed?: string;
  /** Serve API port for the injected heartbeat (lifecycle self-clean). */
  apiPort?: number;
}

/** How the thin bootstrap gets the page runtime onto the page. */
export type AgentDelivery =
  /** Serve mode: <script src> — always the current served build. */
  | { src: string }
  /** CLI direct mode (no serve running): the runtime code, inlined. */
  | { code: string };

export interface ThinBootstrapOptions {
  apiPort: number;
  /** Registration generation (monotonic, e.g. Date.now()); newer wins. */
  gen: number;
  agent: AgentDelivery;
}

/**
 * Builds the thin bootstrap. Deliberately small: it must be safe to register
 * on every hold (Page.addScriptToEvaluateOnNewDocument) and evaluate on a
 * live page — all the stateful logic lives in the runtime it loads.
 */
export function buildThinBootstrap(payload: InjectionPayload, opts: ThinBootstrapOptions): string {
  const api = `http://127.0.0.1:${opts.apiPort}`;
  const loader =
    "src" in opts.agent
      ? `var s = document.createElement('script');
  s.id = MARKER + '-agent';
  s.src = ${JSON.stringify(opts.agent.src)};
  s.async = true;
  (document.head || document.documentElement).appendChild(s);`
      : `try { ${opts.agent.code} } catch (e) {}`;
  return `(function () {
  var MARKER = 'zcode-wallpaper';
  var GEN = ${JSON.stringify(opts.gen)};
  var API = ${JSON.stringify(api)};
  if (!window.__zw) window.__zw = {};
  var S = window.__zw;
  // Supersession: when a NEWER registration has already run on this page, an
  // older replay (stale serve generation) stands down instead of fighting it.
  if (typeof S.bootGen === 'number' && S.bootGen > GEN) return;
  S.bootGen = GEN;

  // Critical CSS first — synchronous, pre-paint: without the transparency
  // overrides the app's opaque surfaces cover the wallpaper for a moment on
  // every reload. This is the one part that cannot wait for a network fetch.
  var style = document.getElementById(MARKER + '-style');
  if (!style) {
    style = document.createElement('style');
    style.id = MARKER + '-style';
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = ${JSON.stringify(payload.css)};

  // Head start for the runtime (full payload, embedded). The SSE stream
  // corrects within milliseconds; the runtime applies this immediately, so a
  // fresh page shows the right wallpaper without a round trip.
  window.__zwApiBase = API;
  window.__zwPayload = ${JSON.stringify(payload)};

  // Runtime loader. Guarded by the runtime's own instance flag: recreating
  // the script element after a failed load or a heartbeat teardown is how the
  // heal path re-arms it; a live instance never double-runs.
  if (!window.__zwAgent) {
    var old = document.getElementById(MARKER + '-agent');
    if (old) old.remove();
${loader}
  }

  // --- lifecycle heartbeat ------------------------------------------------
  // The serve lives inside the plugin's MCP process. If it disappears
  // (plugin disabled, app closed, hard kill) this page removes the injection
  // itself within ~10s, so the wallpaper follows the plugin's lifecycle.
  // Lives HERE (not in the runtime): it must keep working when the runtime
  // failed to load at all.
  if (!S.hb) {
    S.hb = true;
    var hbHard = 0, hbSoft = 0;
    setInterval(function () {
      var t0 = Date.now();
      fetch(API + '/api/health', { signal: AbortSignal.timeout(8000) })
        .then(function (r) { return r.json(); })
        .then(function (b) { if (!b || b.service !== 'zcode-wallpaper') throw 0; hbHard = 0; hbSoft = 0; })
        .catch(function () {
          // "hard" = connection refused within milliseconds: the serve process
          // is gone (plugin disabled / app closed) -> clean up after 2 ticks.
          // "soft" = slow/timeout: the serve is busy (zip/decode work blocks
          // its loop for a while) -> tolerate 6 ticks (~50s) before cleaning.
          var hard = (Date.now() - t0) < 150;
          if (hard) { hbHard++; hbSoft = 0; } else { hbSoft++; hbHard = 0; }
          if (hbHard < 2 && hbSoft < 6) return;
          hbHard = 0; hbSoft = 0;
          if (window.__zwTeardownAgent) { try { window.__zwTeardownAgent(); } catch (e) {} }
          if (window.__zwTeardownPanel) { try { window.__zwTeardownPanel(); } catch (e) {} }
          [MARKER + '-agent', MARKER + '-panel'].forEach(function (id) {
            var n = document.getElementById(id);
            if (n) n.remove();
          });
          try { localStorage.removeItem(MARKER + ':css'); localStorage.removeItem(MARKER + ':wallpaper'); } catch (e) {}
          // allow a clean re-injection if the serve comes back (app restart)
          S.cssText = null; S.videoSrc = null; S.liveSrc = null; S.appliedLive = null;
          window.__zwAgent = null; window.__zwPanel = null;
        });
    }, 5000);
  }
})();`;
}

/** The agent runtime source, for CLI direct injection (no serve to fetch from). */
export function readAgentCode(): string {
  return fs.readFileSync(`${liveDir()}/agent.js`.replace(/\\/g, "/"), "utf8");
}

/**
 * Injects the wallpaper layer into one renderer target: the thin bootstrap
 * with the runtime inlined (this path runs without a serve, so there is no
 * HTTP origin to load agent.js from — the embedded payload is all it gets;
 * the heartbeat still self-cleans when no serve ever appears).
 * Registered via Page.addScriptToEvaluateOnNewDocument so it survives reloads
 * for as long as this CDP session lives. Page.setBypassCSP is enabled so the
 * localhost live-renderer iframe cannot be blocked by a restrictive CSP.
 */
export async function injectIntoTarget(
  target: CdpTarget,
  payload: InjectionPayload
): Promise<void> {
  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
  try {
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    await conn.send("Page.setBypassCSP", { enabled: true }).catch(() => undefined);
    const bootstrap = buildThinBootstrap(payload, {
      apiPort: payload.apiPort ?? 28257,
      gen: Date.now(),
      agent: { code: readAgentCode() },
    });
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
    await conn.send("Runtime.evaluate", {
      expression: bootstrap,
      returnByValue: true,
    });
  } finally {
    conn.close();
  }
}

/**
 * Builds the panel loader: retires inline-string-era panels (their scan steps
 * down before a higher build flag), sweeps their mounted sections, and loads
 * live/panel.js from the serve — the served copy is always the current build,
 * which is why no per-build version protocol is needed anymore.
 */
export function buildPanelLoader(apiPort: number): string {
  const api = `http://127.0.0.1:${apiPort}`;
  return `(function () {
  var API = ${JSON.stringify(api)};
  window.__zwApiBase = API;
  // Inline-string era builds (<=0.2.0) arbiter by __zwSettingsBoot; a higher
  // flag makes their scan() stand down permanently.
  window.__zwSettingsBoot = 31;
  if (window.__zwPanel) return; // current panel owns the page
  ['zcode-wallpaper-settings-v6', 'zcode-wallpaper-settings-2', 'zcode-wallpaper-settings'].forEach(function (id) {
    var e = document.getElementById(id);
    if (e) e.remove();
  });
  var s = document.createElement('script');
  s.id = 'zcode-wallpaper-panel';
  s.src = API + '/panel.js';
  s.async = true;
  (document.head || document.documentElement).appendChild(s);
})();`;
}

/**
 * Removes the wallpaper layer + theme overrides but leaves the settings
 * panel mounted (the panel is serve UI, not appearance — resetting the
 * wallpaper must not tear the user's controls away). Used by /api/reset.
 */
export function buildClearWallpaperScript(marker = "zcode-wallpaper"): string {
  return `(function(){
  if (window.__zwTeardownAgent) { try { window.__zwTeardownAgent(); } catch (e) {} }
  var n = document.getElementById(${JSON.stringify(marker)} + '-agent');
  if (n) n.remove();
  try { localStorage.removeItem(${JSON.stringify(marker)} + ':css'); localStorage.removeItem(${JSON.stringify(marker)} + ':wallpaper'); } catch (e) {}
  window.__zwAgent = null;
})();`;
}

/** Removes everything the bootstrap, runtime and panel created. */
export function buildResetScript(marker = "zcode-wallpaper"): string {
  return `(function(){
  if (window.__zwTeardownAgent) { try { window.__zwTeardownAgent(); } catch (e) {} }
  if (window.__zwTeardownPanel) { try { window.__zwTeardownPanel(); } catch (e) {} }
  [${JSON.stringify(marker)} + '-style', ${JSON.stringify(marker)} + '-wallpaper', ${JSON.stringify(marker)} + '-backdrop',
   ${JSON.stringify(marker)} + '-agent', ${JSON.stringify(marker)} + '-panel'].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) n.remove();
  });
  // Panel sections: current id + legacy ids from older builds.
  ['zcode-wallpaper-settings-v6', 'zcode-wallpaper-settings-2', 'zcode-wallpaper-settings'].forEach(function (id) {
    var n = document.getElementById(id);
    if (n) n.remove();
  });
  try { localStorage.removeItem(${JSON.stringify(marker)} + ':css'); localStorage.removeItem(${JSON.stringify(marker)} + ':wallpaper'); } catch (e) {}
  window.__zwAgent = null; window.__zwPanel = null; window.__zwSettingsBoot = null;
  if (window.__zw) {
    window.__zw.cssText = null; window.__zw.videoSrc = null; window.__zw.liveSrc = null;
    window.__zw.boundFrame = null; window.__zw.bootGen = null;
  }
})();`;
}
