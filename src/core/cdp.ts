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
  fit?: "cover" | "contain" | "stretch";
  /** Mute state for the native loop-video layer. */
  videoMuted?: boolean;
  /** Wallpaper switch animation: "cut" swaps instantly, default cross-fades. */
  transition?: string;
  /** Serve API port for the injected heartbeat (lifecycle self-clean). */
  apiPort?: number;
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
  const apiPort = payload.apiPort ?? 28257;
  return `(function(){
  var MARKER = ${JSON.stringify(marker)};
  if (!window.__zw) window.__zw = {};
  var S = window.__zw;
  var VIDEO_SRC = ${JSON.stringify(videoSrc)};
  var LIVE_SRC = ${JSON.stringify(liveSrc)};
  var TRANS = ${JSON.stringify(payload.transition === "cut" ? "cut" : "fade")};
  if (S.cssText === ${JSON.stringify(payload.css)} && S.videoSrc === VIDEO_SRC && S.liveSrc === LIVE_SRC && S.trans === TRANS) return;
  S.cssText = ${JSON.stringify(payload.css)};
  S.videoSrc = VIDEO_SRC;
  S.liveSrc = LIVE_SRC;
  S.trans = TRANS;

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
      ['type', 'src', 'file', 'fit', 'fps', 'muted'].forEach(function (k) { out[k] = q.get(k) || ''; });
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
    if (!src) { liveFrames().forEach(function (f) { f.remove(); }); S.appliedLive = null; return; }
    if (!cur) {
      // "cut" transitions swap with no animation at all.
      if (TRANS === 'cut') {
        var c0 = makeFrame(MARKER + '-live', src, 'opacity:1;');
        wp.appendChild(c0);
        S.appliedLive = src;
        bindLiveBridge();
        return;
      }
      // First mount (page load, heartbeat self-clean, plugin re-enable):
      // fade in from the app's own background instead of popping in.
      var first = makeFrame(MARKER + '-live', src, 'opacity:0;transition:opacity .6s ease;');
      wp.appendChild(first);
      S.appliedLive = src;
      bindLiveBridge();
      var settled = false;
      var onFirstReady = function (ev) {
        if (ev.data && ev.data.zwEvent === 'ready' && first.contentWindow === ev.source) {
          settled = true;
          first.style.opacity = '1';
          window.removeEventListener('message', onFirstReady);
          clearTimeout(firstTimer);
        }
      };
      window.addEventListener('message', onFirstReady);
      var firstTimer = setTimeout(function () {
        if (!settled) { first.style.opacity = '1'; window.removeEventListener('message', onFirstReady); }
      }, 10000);
      return;
    }
    // Compare against the LAST APPLIED url, not the frame's src attribute:
    // hot-updates never rewrite the attribute (that would navigate/reload),
    // so attribute comparison makes the second toggle of a param (e.g. mute
    // -> unmute -> mute) a silent no-op — the volume command never ships.
    var applied = S.appliedLive || cur.getAttribute('src') || '';
    if (applied === src) { bindLiveBridge(); return; }
    var a = queryOf(applied);
    var b = queryOf(src);
    if (a.src && a.src === b.src && a.type === b.type) {
      // Same wallpaper, only fit/fps/muted changed: hot-update via postMessage.
      // (Setting src would reload the iframe and flash.)
      postAllFrames({ zw: 'cfg', fit: b.fit, fps: Number(b.fps) || 30, volume: b.muted === '0' ? 1 : 0 });
      S.appliedLive = src;
      bindLiveBridge();
      return;
    }
    // Different wallpaper: SNAPSHOT transition. Two WebGL engines at once
    // saturate the GPU (a 4K video switch freezes the whole UI), and pausing
    // the old engine blanks its canvas — so instead: snapshot the old frame
    // into a plain <img> overlay, destroy the old engine immediately, let the
    // new one assemble behind the still image, then fade the still out.
    // Exactly one engine runs at any moment and the screen never goes empty.
    var oldOverlay = document.getElementById(MARKER + '-fade');
    if (oldOverlay) oldOverlay.remove();
    var doSwap = function (overlaySrc) {
      cur.remove();
      var frame = makeFrame(MARKER + '-live', src, 'opacity:1;');
      wp.appendChild(frame);
      S.appliedLive = src;
      bindLiveBridge();
      if (!overlaySrc) return;
      var overlay = document.createElement('img');
      overlay.id = MARKER + '-fade';
      overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;';
      overlay.src = overlaySrc;
      wp.appendChild(overlay);
      var faded = false;
      var fadeOut = function () {
        if (faded) return;
        faded = true;
        overlay.style.transition = 'opacity .6s ease';
        overlay.style.opacity = '0';
        setTimeout(function () { overlay.remove(); }, 660);
      };
      var onReady = function (ev) {
        if (ev.data && ev.data.zwEvent === 'ready' && frame.contentWindow === ev.source) {
          fadeOut();
          window.removeEventListener('message', onReady);
        }
      };
      window.addEventListener('message', onReady);
      setTimeout(fadeOut, 10000); // engine never signaled: uncover anyway
    };
    if (TRANS === 'cut') {
      doSwap('');
      return;
    }
    var snapped = false;
    var onSnap = function (ev) {
      if (snapped || !ev.data || ev.data.zwEvent !== 'snap' || !cur.contentWindow || ev.source !== cur.contentWindow) return;
      snapped = true;
      window.removeEventListener('message', onSnap);
      clearTimeout(snapTimer);
      doSwap(ev.data.dataUrl || '');
    };
    var snapTimer = setTimeout(function () {
      if (snapped) return;
      snapped = true;
      window.removeEventListener('message', onSnap);
      doSwap(''); // no snapshot in time — swap without a still (brief poster)
    }, 250);
    window.addEventListener('message', onSnap);
    try {
      cur.contentWindow.postMessage({ zw: 'snapshot' }, '*');
    } catch (e) {
      clearTimeout(snapTimer);
      window.removeEventListener('message', onSnap);
      doSwap('');
    }
  }
  applyLive(LIVE_SRC);

  // --- loop video layer (dsh's model: a native <video> in the host page) ----
  // Videos never enter the WebGL engine: engine pause clears the WebCodecs
  // canvas and its scheduler fast-forwards on wake. A native element pauses
  // on its last frame and preplays OFFSCREEN (dsh's prepareVideoProbe): the
  // new video reaches canplay while detached, then commits already playing —
  // on screen it is a live picture immediately, no reload gap, no burst.
  var vid = document.getElementById(MARKER + '-video');
  var VMUTED = ${JSON.stringify(payload.videoMuted !== false)};
  var VFIT = ${JSON.stringify(payload.fit === "contain" ? "contain" : payload.fit === "stretch" ? "fill" : "cover")};
  if (VIDEO_SRC) {
    wp.style.backgroundImage = 'none';
    if (vid && vid.getAttribute('src') === VIDEO_SRC) {
      vid.muted = VMUTED; // hot-update: same video, muted/fit tweak
      vid.style.objectFit = VFIT;
      vid.play().catch(function() {});
    } else {
      var nv = document.createElement('video');
      nv.setAttribute('autoplay', '');
      nv.setAttribute('loop', '');
      nv.setAttribute('playsinline', '');
      nv.muted = VMUTED;
      nv.src = VIDEO_SRC;
      nv.load();
      var committed = false;
      var commit = function () {
        if (committed) return;
        committed = true;
        var old = document.getElementById(MARKER + '-video');
        if (old) old.remove();
        nv.id = MARKER + '-video';
        nv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:' + VFIT + ';opacity:0;transition:opacity .6s ease;';
        wp.appendChild(nv);
        nv.play().catch(function() {});
        requestAnimationFrame(function () { nv.style.opacity = '1'; });
        setTimeout(function () { if (nv.style) nv.style.transition = 'none'; }, 660);
      };
      nv.addEventListener('canplay', commit, { once: true });
      nv.addEventListener('error', commit, { once: true });
      setTimeout(commit, 3000); // slow disk: commit anyway, element keeps loading
      nv.play().catch(function() {});
    }
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
    var wake = function () {
      var v = document.getElementById(MARKER + '-video');
      if (v) v.play().catch(function () {});
      // Any real window interaction also wakes an auto-paused renderer
      // (boot can leave it paused under a hidden page; the renderer ignores
      // this when the user paused it manually).
      postAllFrames({ zw: 'resume' });
    };
    window.addEventListener('focus', wake);
    document.addEventListener('pointerdown', wake, true);
    window.addEventListener('pageshow', wake);
  }
  if (!S.watchdog) {
    S.stallCount = 0;
    S.lastClock = -1;
    // Kick a frozen video: Chromium can mis-detect transparent Electron
    // windows as occluded and freeze the media pipeline (paused stays false,
    // the clock stops, the last frame disappears). Page code cannot lift the
    // occlusion itself — only real window interaction can — but once the
    // window wakes (any click / focus / visible) we thaw immediately.
    var kickVideo = function () {
      var v = document.getElementById(MARKER + '-video');
      if (!v || document.hidden) return;
      if (v.ended || (v.paused && v.autoplay)) {
        S.stallCount = 0;
        v.play().catch(function () {});
      } else if (!v.paused && v.readyState >= 2 && S.lastClock === v.currentTime) {
        S.stallCount++;
        if (S.stallCount >= 1) { v.load(); }
        v.play().catch(function () {});
      } else {
        S.stallCount = 0;
      }
      S.lastClock = v.currentTime;
    };
    S.kickVideo = kickVideo;
    S.watchdog = setInterval(kickVideo, 2000);
    document.addEventListener('pointerdown', function () { requestAnimationFrame(function(){ kickVideo(); }); }, { capture: true, passive: true });
    window.addEventListener('focus', function () { requestAnimationFrame(function(){ kickVideo(); }); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) requestAnimationFrame(function(){ kickVideo(); });
    });
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

  // --- lifecycle heartbeat ------------------------------------------------
  // The serve lives inside the plugin's MCP process. If it disappears
  // (plugin disabled, app closed, hard kill) this page removes the injection
  // itself within ~10s, so the wallpaper follows the plugin's lifecycle.
  if (!S.hb) {
    S.hb = true;
    var hbHard = 0, hbSoft = 0;
    setInterval(function () {
      var t0 = Date.now();
      fetch('http://127.0.0.1:' + ${JSON.stringify(apiPort)} + '/api/health', { signal: AbortSignal.timeout(8000) })
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
          document.getElementById(MARKER + '-style')?.remove();
          document.getElementById(MARKER + '-wallpaper')?.remove();
          document.getElementById(MARKER + '-backdrop')?.remove();
          document.getElementById('zcode-wallpaper-settings-v6')?.remove();
          document.getElementById('zcode-wallpaper-settings-2')?.remove();
          try { localStorage.removeItem(MARKER + ':css'); localStorage.removeItem(MARKER + ':wallpaper'); } catch (e) {}
          // allow a clean re-injection if the serve comes back (app restart)
          S.cssText = null; S.videoSrc = null; S.liveSrc = null; S.appliedLive = null;
        });
    }, 5000);
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
