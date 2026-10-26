/**
 * Minimal Chrome DevTools Protocol client for the ZCode desktop renderer.
 *
 * ZCode (production) starts without a debug port; the launcher must start it
 * with `--remote-debugging-port=<port>` before this module can connect.
 *
 * The injected bootstrap supports three wallpaper layer kinds, switched by the
 * payload: a static image (background-image), a loop video (<video>) and the
 * live WebWallGL renderer (an <iframe> pointed at this plugin's local HTTP
 * server). For the live layer the bootstrap also forwards pointer/wheel input
 * and page visibility to the iframe, so scene parallax/click effects react to
 * the real cursor even though the iframe sits behind the whole UI.
 */

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
  fit?: "cover" | "contain";
}

/**
 * Injects CSS + a persistence script into one renderer target. The script is
 * registered via Page.addScriptToEvaluateOnNewDocument so it survives reloads
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
    const bootstrap = buildBootstrapScript(payload);
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
    await conn.send("Runtime.evaluate", {
      expression: bootstrap,
      returnByValue: true,
    });
  } finally {
    conn.close();
  }
}

export function buildBootstrapScript(payload: InjectionPayload): string {
  const marker = payload.marker ?? "zcode-wallpaper";
  const videoSrc = payload.videoSrc ?? "";
  const liveSrc = payload.liveSrc ?? "";
  return `(function(){
  var MARKER = ${JSON.stringify(marker)};
  if (!window.__zw) window.__zw = {};
  var S = window.__zw;
  var VIDEO_SRC = ${JSON.stringify(videoSrc)};
  var LIVE_SRC = ${JSON.stringify(liveSrc)};
  if (S.cssText === ${JSON.stringify(payload.css)} && S.videoSrc === VIDEO_SRC && S.liveSrc === LIVE_SRC) return;
  S.cssText = ${JSON.stringify(payload.css)};
  S.videoSrc = VIDEO_SRC;
  S.liveSrc = LIVE_SRC;

  var style = document.getElementById(MARKER + '-style');
  if (!style) {
    style = document.createElement('style');
    style.id = MARKER + '-style';
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = ${JSON.stringify(payload.css)};

  var wp = document.getElementById(MARKER + '-wallpaper');
  if (${JSON.stringify(Boolean(payload.wallpaperDataUri))} || VIDEO_SRC || LIVE_SRC) {
    if (!wp) {
      wp = document.createElement('div');
      wp.id = MARKER + '-wallpaper';
      document.documentElement.appendChild(wp);
    }
  } else if (wp) {
    wp.remove();
  }

  // --- live renderer iframe (WebWallGL) ---------------------------------
  function queryOf(u) {
    var out = {};
    try {
      var q = new URL(u, location.href).searchParams;
      ['type', 'src', 'fit', 'fps', 'muted'].forEach(function (k) { out[k] = q.get(k) || ''; });
    } catch (e) { /* bad url */ }
    return out;
  }
  function liveFrames() {
    return Array.prototype.slice.call(document.querySelectorAll('#' + MARKER + '-live, #' + MARKER + '-live-next'));
  }
  function postAllFrames(msg) {
    liveFrames().forEach(function (f) {
      try { f.contentWindow.postMessage(msg, '*'); } catch (e) { /* mid-swap */ }
    });
  }
  /** Promotes a pending transition iframe to be THE live frame immediately. */
  function promoteNext() {
    var cur = document.getElementById(MARKER + '-live');
    var next = document.getElementById(MARKER + '-live-next');
    if (!next) return;
    if (cur) cur.remove();
    next.id = MARKER + '-live';
    next.style.transition = 'none';
    next.style.opacity = '1';
    if (S.tr) { clearTimeout(S.tr.timer); window.removeEventListener('message', S.tr.onMsg); S.tr = null; }
  }
  function makeFrame(id, src, extraCss) {
    var f = document.createElement('iframe');
    f.id = id;
    f.setAttribute('allow', 'autoplay');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;background:transparent;' + (extraCss || '');
    f.setAttribute('src', src);
    return f;
  }
  function applyLive(src) {
    // A rapid switch during an in-flight transition: jump to its end first.
    if (document.getElementById(MARKER + '-live-next')) promoteNext();
    var cur = document.getElementById(MARKER + '-live');
    if (!src) { liveFrames().forEach(function (f) { f.remove(); }); return; }
    if (!cur) {
      wp.appendChild(makeFrame(MARKER + '-live', src));
      bindLiveBridge();
      return;
    }
    if (cur.getAttribute('src') === src) { bindLiveBridge(); return; }
    var a = queryOf(cur.getAttribute('src') || '');
    var b = queryOf(src);
    if (a.src && a.src === b.src && a.type === b.type) {
      // Same wallpaper, only fit/fps/muted changed: hot-update via postMessage.
      // (Setting src would reload the iframe and flash.)
      postAllFrames({ zw: 'cfg', fit: b.fit, fps: Number(b.fps) || 30, volume: b.muted === '0' ? 1 : 0 });
      bindLiveBridge();
      return;
    }
    // Different wallpaper: cross-fade. The new frame mounts transparent, fades
    // in when its renderer signals readiness (poster covers it until then),
    // and the old frame is removed after the transition. The old frame's
    // render loop is paused right away — two WebGL contexts rendering at full
    // tilt during assembly starves the GPU and makes the UI jank.
    try { cur.contentWindow.postMessage({ zw: 'pause' }, '*'); } catch (e) { /* mid-swap */ }
    var next = makeFrame(MARKER + '-live-next', src, 'opacity:0;transition:opacity .6s ease;');
    wp.appendChild(next);
    bindLiveBridge();
    var done = false;
    var finalize = function () {
      if (done) return;
      done = true;
      next.style.opacity = '1';
      setTimeout(function () {
        if (document.getElementById(MARKER + '-live-next') === next) promoteNext();
      }, 660);
    };
    var onMsg = function (ev) {
      if (ev.data && ev.data.zwEvent === 'ready' && next.contentWindow === ev.source) finalize();
    };
    window.addEventListener('message', onMsg);
    var timer = setTimeout(finalize, 10000); // renderer never signaled: swap anyway
    S.tr = { timer: timer, onMsg: onMsg };
  }
  applyLive(LIVE_SRC);

  // --- loop video layer ---------------------------------------------------
  var vid = document.getElementById(MARKER + '-video');
  if (VIDEO_SRC) {
    wp.style.backgroundImage = 'none';
    if (!vid) {
      vid = document.createElement('video');
      vid.id = MARKER + '-video';
      vid.setAttribute('autoplay', '');
      vid.setAttribute('loop', '');
      vid.setAttribute('muted', '');
      vid.setAttribute('playsinline', '');
      vid.muted = true;
      vid.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
      wp.appendChild(vid);
    }
    if (vid.getAttribute('src') !== VIDEO_SRC) {
      vid.setAttribute('src', VIDEO_SRC);
      vid.load();
    }
    vid.play().catch(function() {});
  } else {
    if (vid) vid.remove();
    if (${JSON.stringify(Boolean(payload.wallpaperDataUri))}) {
      wp.style.backgroundImage = 'url(' + ${JSON.stringify(payload.wallpaperDataUri ?? "")} + ')';
    } else if (wp) {
      wp.style.backgroundImage = 'none';
    }
  }

  // --- blurred backdrop for contain framing --------------------------------
  var FIT = ${JSON.stringify(payload.fit ?? "cover")};
  var bp = document.getElementById(MARKER + '-backdrop');
  if (FIT === 'contain' && ${JSON.stringify(Boolean(payload.wallpaperDataUri))}) {
    if (!bp) {
      bp = document.createElement('div');
      bp.id = MARKER + '-backdrop';
      document.documentElement.appendChild(bp);
    }
    bp.style.backgroundImage = 'url(' + ${JSON.stringify(payload.wallpaperDataUri ?? "")} + ')';
    bp.dataset.on = '1';
  } else if (bp) {
    bp.dataset.on = '0';
  }

  // --- media watchdog (video layer) ----------------------------------------
  if (!S.visBound) {
    S.visBound = true;
    document.addEventListener('visibilitychange', function() {
      var v = document.getElementById(MARKER + '-video');
      if (v) { if (document.hidden) { v.pause(); } else { v.play().catch(function() {}); } }
      postAllFrames({ zw: document.hidden ? 'pause' : 'resume' });
    });
    window.addEventListener('focus', function() {
      var v = document.getElementById(MARKER + '-video');
      if (v) v.play().catch(function() {});
    });
    window.addEventListener('pageshow', function() {
      var v = document.getElementById(MARKER + '-video');
      if (v) v.play().catch(function() {});
    });
  }
  if (!S.watchdog) {
    S.stallCount = 0;
    S.lastClock = -1;
    S.watchdog = setInterval(function() {
      var v = document.getElementById(MARKER + '-video');
      if (!v) return;
      if (document.hidden) { S.lastClock = -1; return; }
      if (v.ended || (v.paused && v.autoplay)) {
        S.stallCount = 0;
        v.play().catch(function() {});
      } else if (!v.paused && v.readyState >= 2 && S.lastClock === v.currentTime) {
        S.stallCount++;
        if (S.stallCount >= 2) { v.load(); }
        v.play().catch(function() {});
      } else {
        S.stallCount = 0;
      }
      S.lastClock = v.currentTime;
    }, 2000);
  }

  // --- pointer/wheel bridge into the live iframe(s) ----------------------------
  function bindLiveBridge() {
    if (S.boundFrame) return;
    S.boundFrame = true;
    var latest = null, queued = false;
    function flush() {
      queued = false;
      if (!latest) return;
      postAllFrames({ zw: 'ptr', u: latest.u, v: latest.v, buttons: latest.buttons, mods: latest.mods });
      latest = null;
    }
    function coords(e) {
      return { u: Math.max(0, Math.min(1, e.clientX / Math.max(1, window.innerWidth))),
               v: Math.max(0, Math.min(1, e.clientY / Math.max(1, window.innerHeight))),
               buttons: e.buttons, mods: (e.ctrlKey?1:0) | (e.shiftKey?2:0) | (e.altKey?4:0) | (e.metaKey?8:0) };
    }
    document.addEventListener('pointermove', function(e) {
      latest = coords(e);
      if (!queued) { queued = true; requestAnimationFrame(flush); }
    }, { capture: true, passive: true });
    document.addEventListener('pointerdown', function(e) {
      latest = coords(e);
      flush();
    }, { capture: true, passive: true });
    document.addEventListener('pointerup', function(e) {
      postAllFrames({ zw: 'ptrup' });
    }, { capture: true, passive: true });
    document.addEventListener('wheel', function(e) {
      postAllFrames({ zw: 'wheel', dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode,
        mods: (e.ctrlKey?1:0) | (e.shiftKey?2:0) | (e.altKey?4:0) | (e.metaKey?8:0) });
    }, { capture: true, passive: true });
    window.addEventListener('blur', function() {
      postAllFrames({ zw: 'ptrleave' });
    });
  }

  // Persist for the panel's self-heal path (best effort; large wallpapers may
  // exceed the localStorage quota, in which case only the CSS is saved).
  try {
    localStorage.setItem(MARKER + ':css', ${JSON.stringify(payload.css)});
    localStorage.setItem(MARKER + ':wallpaper', ${JSON.stringify(payload.wallpaperDataUri ?? "")});
  } catch (e) {}
})();`;
}

/** Removes everything the bootstrap script created. */
export function buildResetScript(marker = "zcode-wallpaper"): string {
  return `(function(){
  document.getElementById(${JSON.stringify(marker)} + '-style')?.remove();
  document.getElementById(${JSON.stringify(marker)} + '-wallpaper')?.remove();
  document.getElementById(${JSON.stringify(marker)} + '-backdrop')?.remove();
  // Panel sections: current id + legacy ids from older builds.
  document.getElementById('zcode-wallpaper-settings-v6')?.remove();
  document.getElementById('zcode-wallpaper-settings-2')?.remove();
  document.getElementById('zcode-wallpaper-settings')?.remove();
  if (window.__zw) { window.__zw.cssText = null; window.__zw.videoSrc = null; window.__zw.liveSrc = null; window.__zw.boundFrame = null; }
})();`;
}
