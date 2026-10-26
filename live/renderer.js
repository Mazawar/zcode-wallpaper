/**
 * Live renderer page (served at /live/index.html).
 *
 * The rendering core is the npm dependency `webwallgl`: it parses scene.pkg /
 * loose scene.json projects in WebGL2 (layers, particles, puppets, SceneScript,
 * audio reaction) and mounts web wallpapers with the WE API shim. This page is
 * only the host adapter:
 *   - URL protocol: type (scene|video|web), src (source id), file (relative
 *     media path for video), fit, fps, muted, dpr, poster
 *     poster (preview image to show until the first frame)
 *   - input bridge: parent window postMessage {zw:'ptr'|'ptrup'|'ptrleave'|
 *     'wheel'|'pause'|'resume'} -> inst.pushPointer / pause / resume, so the
 *     scene reacts to the real cursor moving over the ZCode UI above it
 *   - first-frame capture: posts a JPEG snapshot back to the server so Monet
 *     colors can be derived from the real rendered pixels
 *   - diagnostics: every engine diagnostic is beaconed to /api/diag
 */

if (!globalThis.WebWallGL) throw new Error("WebWallGL engine not loaded (/engine/webwallgl.global.min.js)");
const { createScene, httpSource } = globalThis.WebWallGL;

const params = new URLSearchParams(location.search);
const pageType = (params.get("type") || "scene").toLowerCase();
const pageSrc = params.get("src") || "";
const FITS = new Set(["cover", "contain", "stretch"]);
const fitOf = (v) => (FITS.has(v) ? v : "cover");
const volume = params.get("muted") === "0" ? 1 : 0;

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
  // Videos ride the same engine pipeline as scenes (dsh-style): httpSource
  // sniffs the file's content type and the engine plays it in WebGL — one
  // renderer for every kind, so switches cross-fade and Monet colors come
  // from real rendered frames.
  const file = cfg.type === "video" && cfg.file ? `/${cfg.file}` : "";
  return httpSource(`${location.origin}/files/${cfg.src}${file}`);
}

const inst = createScene(host, {
  fit: fitOf(params.get("fit")),
  fps: Number(params.get("fps")) || 30,
  volume,
  renderDpr: Number(params.get("dpr")) || 0,
  // Full fidelity: no texture downsampling, original particle/post settings,
  // MSAA like Wallpaper Engine, and no automatic quality degradation — the
  // wallpaper renders exactly as authored (perf is managed via the fps cap).
  videoTexScale: 1,
  autoQuality: false,
  quality: { antiAliasing: "msaa4", particles: "high", postProcessing: "high" },
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

function loadCurrent() {
  const source = sourceOf({ type: pageType, src: pageSrc, file: params.get("file") || "" });
  if (!source) {
    diag(`missing src for ${pageType}`, "error");
    return;
  }
  inst
    .load(source)
    .then(() => inst.setVolume(volume))
    .then(() => {
      try {
        parent.postMessage({ zwEvent: "ready" }, "*");
      } catch {
        /* parent gone */
      }
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
const statsTimer = setInterval(() => {
  const fps = Math.round(inst.stats?.fps ?? 0);
  if (fps > 0) framesSeen++;
  if (framesSeen >= 3) {
    clearInterval(statsTimer);
    host.style.background = ""; // real frames are flowing; drop the poster
    captureOnce();
  }
}, 1000);

// --- input bridge from the ZCode host page ------------------------------------
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || typeof d !== "object" || !("zw" in d)) return;
  try {
    if (d.zw === "ptr") inst.pushPointer(Number(d.u), Number(d.v), Number(d.buttons) || 0, Number(d.mods) || 0);
    else if (d.zw === "ptrleave") inst.pointerLeave();
    else if (d.zw === "ptrup") inst.pushPointer(Number(d.u ?? 0.5), Number(d.v ?? 0.5), 0, 0);
    else if (d.zw === "wheel") inst.pushWheel(Number(d.dx) || 0, Number(d.dy) || 0, Number(d.mode) || 0, Number(d.mods) || 0);
    else if (d.zw === "pause") inst.pause();
    else if (d.zw === "resume") inst.resume();
    // Hot config update (same wallpaper, changed fit/fps/volume) — avoids a
    // full reload (and the reload flash) for tweaks the engine applies live.
    else if (d.zw === "cfg") {
      if (d.fit) inst.setFit(fitOf(d.fit));
      if (d.fps) inst.setFps(Number(d.fps) || 30);
      if (typeof d.volume === "number") inst.setVolume(Math.max(0, Math.min(1, d.volume)));
    }
  } catch {
    /* bridge failures must not break the render loop */
  }
});

document.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("pagehide", () => inst.destroy());

loadCurrent();
