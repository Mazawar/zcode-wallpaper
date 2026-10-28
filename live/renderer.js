/**
 * Live renderer page (served at /live/index.html).
 *
 * The rendering core is the npm dependency `webwallgl`: it parses scene.pkg /
 * loose scene.json projects in WebGL2 (layers, particles, puppets, SceneScript,
 * audio reaction) and mounts web wallpapers with the WE API shim. This page is
 * only the host adapter:
 *   - URL protocol: type (scene|video|web), src (source id), file (relative
 *     media path for video), fit, fps, muted, poster
 *     poster (preview image to show until the first frame)
 *     D20 render knobs (host-expanded presets, see inject.ts
 *     LIVE_QUALITY_PRESETS): dpr (cap on devicePixelRatio, 0 = native),
 *     aa / pq / pp (anti-aliasing / particles / post tiers), vts (video
 *     texture scale), aq (engine auto-degrade; mount-only — no hot setter)
 *   - input bridge: parent window postMessage {zw:'ptr'|'ptrup'|'ptrleave'|
 *     'wheel'|'pause'|'resume'} -> inst.pushPointer / pause / resume, so the
 *     scene reacts to the real cursor moving over the ZCode UI above it
 *   - first-frame capture: posts a JPEG snapshot back to the server so Monet
 *     colors can be derived from the real rendered pixels
 *   - diagnostics: every engine diagnostic is beaconed to /api/diag
 */

if (!globalThis.WebWallGL) throw new Error("WebWallGL engine not loaded (/engine/webwallgl.global.min.js)");
const { createScene, httpSource, mediaSource } = globalThis.WebWallGL;

const params = new URLSearchParams(location.search);
const pageType = (params.get("type") || "scene").toLowerCase();
const pageSrc = params.get("src") || "";
const FITS = new Set(["cover", "contain", "stretch"]);
const fitOf = (v) => (FITS.has(v) ? v : "cover");
// MUST stay reassignable: the {zw:"load"} handler updates it on a source
// switch. Declaring it const made that handler throw (assignment to constant)
// inside its try/catch — every host-driven switch was silently swallowed and
// the wallpaper never changed (1.0.0 "switching does nothing").
let volume = params.get("muted") === "0" ? 1 : 0;

const host = document.getElementById("wp");

// Poster placeholder: the author's preview image until the first real frame.
const poster = params.get("poster");
if (poster) {
  host.style.background = `#000 url("${poster}") center / cover no-repeat`;
}

function diag(text, level) {
  try {
    new Image().src = `/api/diag?msg=${encodeURIComponent(String(text).slice(0, 400))}&lvl=${level === "error" || level === "warn" ? level : "info"}`;
  } catch {
    /* diagnostics must never break rendering */
  }
}

/** Web wallpaper source: `src` is a source id; entry html + project.json live under /files/<id>/. */
function webSource(sourceId) {
  const dir = `/files/${sourceId}`;
  let project = null;
  return {
    key: dir,
    project() {
      project ??= fetch(`${dir}/project.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((p) => ({ ...(p && typeof p === "object" ? p : {}), type: "web" }));
      return project;
    },
    async webEntry() {
      return { url: `${dir}/index.html` };
    },
    scenePkg() {
      return Promise.reject(new Error("web wallpaper has no scene.pkg"));
    },
  };
}

function sourceOf(cfg) {
  if (cfg.type === "web") return cfg.src ? webSource(cfg.src) : null;
  if (!cfg.src) return null;
  const base = `${location.origin}/files/${cfg.src}`;
  // Videos ride the engine's media pipeline via mediaSource — httpSource
  // always assembles a scene project (project.json/scene.pkg) and 404s on
  // media URLs, so the same renderer plays every kind and switches
  // cross-fade; Monet colors come from real rendered frames.
  if (cfg.type === "video" && cfg.file) {
    return mediaSource(`${base}/${cfg.file}`, { type: "video" });
  }
  return httpSource(base);
}

// D20 render quality: the host expands a preset into these knobs (the page
// never sees preset names). Absent params fall back to the "balanced" values,
// so a bare URL behaves like the shipped default instead of maxing the GPU.
const AA_TIERS = new Set(["off", "fxaa", "msaa2", "msaa4"]);
const TIER = new Set(["off", "low", "medium", "high"]);
const tierOf = (v, allowed, fallback) => (allowed.has(v) ? v : fallback);
// cap > 0 = never render above cap × CSS pixels; HiDPI screens (DPR 1.5/2
// render 2.25–4× the pixels) are where the savings live. 0 = engine auto
// (device DPR, native).
function capDpr(cap) {
  return cap > 0 ? Math.min(window.devicePixelRatio || 1, cap) : 0;
}

const inst = createScene(host, {
  fit: fitOf(params.get("fit")),
  fps: Number(params.get("fps")) || 30,
  volume,
  renderDpr: capDpr(Number(params.get("dpr")) || 0),
  videoTexScale: Number(params.get("vts")) || 1,
  autoQuality: params.get("aq") !== "0",
  quality: {
    antiAliasing: tierOf(params.get("aa"), AA_TIERS, "fxaa"),
    particles: tierOf(params.get("pq"), TIER, "medium"),
    postProcessing: tierOf(params.get("pp"), TIER, "medium"),
  },
  onDiagnostic: (msg, level) => diag(msg, level),
});

inst.on("error", (err) => {
  diag(`assembly failed: ${err?.message ?? err}`, "error");
  try {
    parent.postMessage({ zwEvent: "error", message: String(err?.message ?? err) }, "*");
  } catch {
    /* parent gone */
  }
});

// Mutable current source — an in-place load (dsh's setWallpaper) swaps it
// without remounting the iframe, so the WebGL context is REUSED across
// switches. Destroy/create context churn was losing contexts (rapid
// switching + 4K decode) and blanking the canvas.
let current = { type: pageType, src: pageSrc, file: params.get("file") || "" };

function loadCurrent() {
  const source = sourceOf(current);
  if (!source) {
    diag(`missing src for ${current.type}`, "error");
    return;
  }
  armPosterWatch();
  inst
    .load(source)
    .then(() => inst.setVolume(volume))
    .then(() => {
      signalReady(); // frame-flow watch may already have fired — idempotent
    })
    .catch(() => {
      /* reported through the error event */
    });
}

// --- first-frame capture -> server (Monet source + panel preview) ------------
let frameSent = false;
async function captureOnce() {
  if (frameSent) return;
  frameSent = true;
  try {
    const canvas = inst.canvas instanceof HTMLCanvasElement ? inst.canvas : host.querySelector("canvas");
    if (!canvas || !canvas.width) return;
    const limit = 960;
    let dataUrl;
    if (canvas.width <= limit) {
      dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    } else {
      const off = document.createElement("canvas");
      off.width = limit;
      off.height = Math.max(1, Math.round(canvas.height * (limit / canvas.width)));
      off.getContext("2d").drawImage(canvas, 0, 0, off.width, off.height);
      dataUrl = off.toDataURL("image/jpeg", 0.82);
    }
    await fetch("/api/live-frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: pageSrc, type: pageType, dataUrl }),
    });
  } catch {
    // A canvas tainted by cross-origin content throws on toDataURL; Monet then
    // falls back to the wallpaper's preview image. Not fatal.
  }
}

let framesSeen = 0;
let posterTimer = null;
// "ready" is signalled by the FIRST FLOWING FRAMES, not by the engine's
// load() promise — on in-place loads that promise never settled (observed:
// engine rendered at 30fps while the host waited for ready and fell through
// the 10s uncover fallback on EVERY switch — "switching is slow" was exactly
// this fixed 10s). Once per load; the load().then() path also signals, the
// flag makes it idempotent.
let readySent = false;
function signalReady() {
  if (readySent) return;
  readySent = true;
  try {
    parent.postMessage({ zwEvent: "ready" }, "*");
  } catch {
    /* parent gone */
  }
}
// Re-armable poster watch: each load starts with the poster covering the
// canvas; three seconds of flowing frames drops it and captures Monet's
// first frame. (Was a one-shot interval — in-place reloads need it again.)
function armPosterWatch() {
  framesSeen = 0;
  readySent = false;
  if (posterTimer) clearInterval(posterTimer);
  posterTimer = setInterval(() => {
    const fps = Math.round(inst.stats?.fps ?? 0);
    if (fps > 0) framesSeen++;
    if (framesSeen >= 3) {
      clearInterval(posterTimer);
      posterTimer = null;
      host.style.background = ""; // real frames are flowing; drop the poster
      signalReady();
      captureOnce();
    }
  }, 1000);
}

// Pausing the engine clears the WebCodecs video canvas to transparent, which
// reads as "the wallpaper vanished". Snapshot the last frame into the host
// background so a pause FREEZES on the current picture instead of blanking.
var frozen = false;
var userPaused = false;
var unfreezeTimer = null;
function freezeFrame() {
  if (frozen || framesSeen < 1) return;
  frozen = true;
  try {
    const c = inst.canvas instanceof HTMLCanvasElement ? inst.canvas : host.querySelector("canvas");
    if (c && c.width) {
      // 0.95: the frozen cover must read as the same picture as the live
      // canvas — lower JPEG quality read as a visible "darker, muddier" flash
      // whenever a pause/resume cycle uncovered it.
      host.style.background = `#000 url("${c.toDataURL("image/jpeg", 0.95)}") center / cover no-repeat`;
    }
  } catch {
    // tainted canvas — leave whatever background is already there
  }
}
function unfreezeFrame() {
  frozen = false;
  host.style.background = "";
}
function doPause(user) {
  if (user) userPaused = true;
  freezeFrame();
  inst.pause();
}
function doResume(user) {
  if (user) {
    userPaused = false;
    unfreezeFrame();
    inst.resume();
    return;
  }
  if (userPaused) return; // an automatic wake must not override the user's pause
  inst.resume();
  // The engine's WebCodecs scheduler flushes its decode backlog on wake,
  // which reads as a fast-forward burst. Keep the frozen still covering the
  // canvas while that backlog drains, then uncover.
  if (frozen) {
    clearTimeout(unfreezeTimer);
    unfreezeTimer = setTimeout(unfreezeFrame, 800);
  }
}
// Waking with the page: an auto-paused renderer resumes by itself when the
// host page becomes visible (the bridge may have missed the transition).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) doResume(false);
});

// --- input bridge from the ZCode host page ------------------------------------
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || typeof d !== "object" || !("zw" in d)) return;
  try {
    if (d.zw === "ptr") inst.pushPointer(Number(d.u), Number(d.v), Number(d.buttons) || 0, Number(d.mods) || 0);
    else if (d.zw === "ptrleave") inst.pointerLeave();
    else if (d.zw === "ptrup") inst.pushPointer(Number(d.u ?? 0.5), Number(d.v ?? 0.5), 0, 0);
    else if (d.zw === "wheel") inst.pushWheel(Number(d.dx) || 0, Number(d.dy) || 0, Number(d.mode) || 0, Number(d.mods) || 0);
    // In-place source switch (dsh's setWallpaper): same iframe, same WebGL
    // context — no destroy/create churn.
    else if (d.zw === "load") {
      current = { type: String(d.type || "scene"), src: String(d.src || ""), file: String(d.file || "") };
      host.style.background = d.poster
        ? `#000 url("${d.poster}") center / cover no-repeat`
        : "";
      if (d.fit) inst.setFit(fitOf(d.fit));
      if (typeof d.fps === "number") inst.setFps(d.fps);
      if (d.muted !== undefined) {
        volume = Number(d.muted) === 0 ? 1 : 0;
        inst.setVolume(volume);
      }
      loadCurrent();
    }
    else if (d.zw === "pause") doPause(d.user === true);
    else if (d.zw === "resume") doResume(d.user === true);
    // Snapshot for the host's transition overlay: the host cannot read this
    // cross-origin canvas, so it asks and we reply with a JPEG data URL.
    else if (d.zw === "snapshot") {
      let dataUrl = "";
      try {
        const c = inst.canvas instanceof HTMLCanvasElement ? inst.canvas : host.querySelector("canvas");
        if (c && c.width) dataUrl = c.toDataURL("image/jpeg", 0.85);
      } catch {
        // tainted canvas — reply empty, host falls back to a bare swap
      }
      try {
        parent.postMessage({ zwEvent: "snap", dataUrl }, "*");
      } catch {
        // parent gone — mid-swap
      }
    }
    // Hot config update (same wallpaper, changed fit/fps/volume/quality) —
    // avoids a full reload (and the reload flash) for tweaks the engine
    // applies live. setRenderDpr is the heavy one: it rebuilds the canvas and
    // re-mounts the scene (engine-owned); the rest apply in place.
    else if (d.zw === "cfg") {
      if (d.fit) inst.setFit(fitOf(d.fit));
      if (d.fps) inst.setFps(Number(d.fps) || 30);
      if (typeof d.volume === "number") inst.setVolume(Math.max(0, Math.min(1, d.volume)));
      if (d.dpr !== undefined && d.dpr !== "") inst.setRenderDpr(capDpr(Number(d.dpr) || 0));
      if (d.q && typeof d.q === "object") {
        const patch = {};
        if (AA_TIERS.has(d.q.aa)) patch.antiAliasing = d.q.aa;
        if (TIER.has(d.q.pq)) patch.particles = d.q.pq;
        if (TIER.has(d.q.pp)) patch.postProcessing = d.q.pp;
        if (Object.keys(patch).length) inst.setQuality(patch);
      }
      if (typeof d.vts === "number" && d.vts > 0) inst.setVideoTexScale(d.vts);
    }
  } catch {
    /* bridge failures must not break the render loop */
  }
});

document.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("pagehide", () => inst.destroy());

// Self-remount helper — two chances per page lifetime (the marker counts).
function reloadOnce() {
  const u = new URL(location.href);
  const n = Number(u.searchParams.get("zwreload") || 0);
  if (n >= 2) return false;
  u.searchParams.set("zwreload", String(n + 1));
  location.replace(u.href);
  return true;
}

// Size watchdog: the engine can initialize while its container has no
// layout yet (canvas stays 1x1) — nothing renders under the poster and the
// wallpaper reads as dead until the engine happens to resize. If the host is
// sized but the canvas stayed tiny, remount.
setTimeout(() => {
  try {
    const c = inst.canvas instanceof HTMLCanvasElement ? inst.canvas : host.querySelector("canvas");
    if (c && c.width < 10 && host.clientWidth > 50) reloadOnce();
  } catch {
    /* ignore */
  }
}, 3000);

// Liveness watch (dsh's startLiveWatch analog): a mounted scene can stall —
// engine hiccup, GPU reset, assembly that never produced a frame. If no
// frames have flowed for 20s (paused renderers are exempt — pause is
// deliberate), remount once instead of showing a dead wallpaper.
// Context loss is the nastier twin: the engine keeps 'rendering' into a
// LOST context (fps stays > 0, the watchdog is fooled) while the canvas
// stays black — catch the event directly and remount.
try {
  const engineCanvas = inst.canvas;
  if (engineCanvas && typeof engineCanvas.addEventListener === "function") {
    engineCanvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      reloadOnce();
    });
  }
} catch {
  /* canvas not available yet — the size/liveness watchdogs cover us */
}
var liveAt = Date.now();
setInterval(function () {
  try {
    if (inst.paused) return;
    var fps = Math.round((inst.stats && inst.stats.fps) || 0);
    if (fps > 0) {
      liveAt = Date.now();
      return;
    }
    if (Date.now() - liveAt > 20000) reloadOnce();
  } catch (e) {
    /* engine gone — the host's heal loop re-injects */
  }
}, 2000);

// Vitals beacon + stall cover: every 2s the engine reports fps/pause/poster
// to the host page's flight recorder. Black-box evidence: after boot the
// engine can drop to fps=0 for a few seconds while NOT paused (a warm-up
// stall) — the canvas goes transparent and the screen reads as dead until
// frames resume. Four consecutive zero-fps beacons (8s) FREEZE the last
// rendered frame over the stall; resumed frames uncover it. Stalls become
// invisible. (2 ticks / 4s was too eager: opening the Settings page janks
// the shared main thread long enough to trip it — the long-standing
// "click settings, screen darkens then brightens" flash was exactly this
// cover engaging on a transient stall.)
let zeroFpsTicks = 0;
setInterval(() => {
  try {
    const fps = Math.round(inst.stats?.fps ?? 0);
    parent.postMessage(
      { zwEvent: "hb2", fps, paused: !!inst.paused, poster: (host.style.background || "") !== "" },
      "*"
    );
    if (inst.paused) {
      zeroFpsTicks = 0;
      return;
    }
    if (fps > 0) {
      zeroFpsTicks = 0;
      if (frozen) doResume(false);
      return;
    }
    if (++zeroFpsTicks >= 4 && framesSeen >= 3) freezeFrame();
  } catch {
    /* parent gone */
  }
}, 2000);

loadCurrent();
