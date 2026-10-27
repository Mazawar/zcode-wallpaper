/**
 * Wallpaper layer runtime — THE single applier of wallpaper state in the page.
 *
 * Loaded by the thin CDP bootstrap (serve mode: <script src="/agent.js">, the
 * served copy is always the current build; CLI direct mode: the bootstrap
 * inlines this file's code). Sources of state, in order:
 *   1. window.__zwPayload — embedded by the bootstrap so a fresh page has the
 *      full state before any network round trip (only CSS is applied ahead of
 *      this by the bootstrap itself, pre-paint, to stop opaque-surface flash).
 *   2. SSE /api/events — config changes published by serve land here and are
 *      applied by THIS code. Serve never re-evaluates scripts on config
 *      changes; one applier means no evaluate/re-register/heal races.
 *
 * Everything below is ported from the pre-0.3.0 inline bootstrap string —
 * layer machine, transitions, auto-heal, video preplay, watchdogs, pointer
 * bridge — with the same hard-won invariants (see comments).
 */
(function () {
  if (window.__zwAgent) return;
  window.__zwAgent = true;

  var MARKER = "zcode-wallpaper";
  var S = window.__zw;
  if (!S) S = window.__zw = {};
  var API =
    window.__zwApiBase ||
    "http://127.0.0.1:" + ((window.__zwPayload && window.__zwPayload.apiPort) || 28257);

  // Teardown registry — the bootstrap heartbeat / reset calls this when the
  // serve (the plugin's lifecycle owner) goes away.
  var timers = [];
  var listeners = []; // [target, type, fn, opts]
  var sseHandle = null;
  function every(fn, ms) {
    var t = setInterval(fn, ms);
    timers.push(t);
    return t;
  }
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  // --- flight recorder -------------------------------------------------------
  // Layer lifecycle, visibility, engine messages, heartbeat verdicts — a ring
  // buffer read after an incident instead of guessing.
  if (!window.__zwRec) {
    window.__zwLog = [];
    window.__zwRec = function (tag, d) {
      try {
        window.__zwLog.push({ t: new Date().toISOString().slice(11, 23), tag: tag, d: d === undefined ? "" : String(d).slice(0, 160) });
        if (window.__zwLog.length > 800) window.__zwLog.shift();
      } catch (e) {}
    };
    try {
      var recObs = new MutationObserver(function (muts) {
        muts.forEach(function (mu) {
          if (mu.removedNodes) Array.prototype.forEach.call(mu.removedNodes, function (n) {
            if (n.id && String(n.id).indexOf(MARKER) === 0) window.__zwRec("REMOVE", n.id + " @ " + (mu.target.id || mu.target.tagName));
          });
          if (mu.addedNodes) Array.prototype.forEach.call(mu.addedNodes, function (n) {
            if (n.id && String(n.id).indexOf(MARKER) === 0) window.__zwRec("ADD", n.id);
          });
          if (mu.type === "attributes" && mu.target.id && String(mu.target.id).indexOf(MARKER) === 0)
            window.__zwRec("ATTR", mu.target.id + "." + mu.attributeName);
        });
      });
      recObs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "src"] });
      on(document, "visibilitychange", function () { window.__zwRec("VIS", document.hidden ? "hidden" : "visible"); });
      on(window, "message", function (ev) {
        if (!ev.data || !ev.data.zwEvent) return;
        var d = ev.data;
        if (d.zwEvent === "hb2") {
          window.__zwRec("ENGINE", "fps=" + d.fps + " paused=" + d.paused + " poster=" + d.poster);
        } else {
          window.__zwRec("MSG", d.zwEvent + (d.message ? " " + String(d.message).slice(0, 80) : ""));
        }
      });
      // Periodic state snapshot: silent changes (css rewrites, style attr
      // churn) leave no mutation trail — poll the invariants.
      every(function () {
        var st = document.getElementById(MARKER + "-style");
        var lv = document.getElementById(MARKER + "-live");
        var bd = document.getElementById(MARKER + "-backdrop");
        window.__zwRec("SNAP", "css=" + (st ? st.textContent.length : 0) + " live=" + (lv ? getComputedStyle(lv).opacity : "-") + " bd=" + (bd ? bd.dataset.on : "-"));
      }, 3000);
      on(window, "error", function (e) { window.__zwRec("PAGEERR", (e.message || "") + " @" + (e.lineno || 0)); });
    } catch (e2) {
      /* recorder must never break the runtime */
    }
    window.__zwRec("BOOT", "agent runtime installed");
  }

  // Current payload-derived values — module level because applyLive's exit
  // branch and the video machine read them.
  var VIDEO_SRC = "", LIVE_SRC = "", TRANS = "fade", TSPD = 600;
  var VMUTED = true, VFIT = "cover", WPIMG = "", FIT = "cover", UNDERLAY = "";

  // --- live renderer iframe (WebWallGL) --------------------------------------
  function queryOf(u) {
    var out = {};
    try {
      var q = new URL(u, location.href).searchParams;
      ["type", "src", "file", "fit", "fps", "muted", "poster"].forEach(function (k) { out[k] = q.get(k) || ""; });
    } catch (e) {
      /* bad url */
    }
    return out;
  }
  function liveFrames() {
    return Array.prototype.slice.call(document.querySelectorAll("#" + MARKER + "-live, #" + MARKER + "-live-next"));
  }
  function postAllFrames(msg) {
    liveFrames().forEach(function (f) {
      try { f.contentWindow.postMessage(msg, "*"); } catch (e) { /* mid-swap */ }
    });
  }
  /** Promotes a pending transition iframe to be THE live frame immediately. */
  function promoteNext() {
    var cur = document.getElementById(MARKER + "-live");
    var next = document.getElementById(MARKER + "-live-next");
    if (!next) return;
    if (cur) cur.remove();
    next.id = MARKER + "-live";
    next.style.transition = "none";
    next.style.opacity = "1";
    if (S.tr) { clearTimeout(S.tr.timer); window.removeEventListener("message", S.tr.onMsg); S.tr = null; }
  }
  function makeFrame(id, src, extraCss) {
    var f = document.createElement("iframe");
    f.id = id;
    f.setAttribute("allow", "autoplay");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;background:transparent;" + (extraCss || "");
    f.setAttribute("src", src);
    return f;
  }
  function applyLive(src) {
    // A rapid switch during an in-flight transition: jump to its end first.
    if (document.getElementById(MARKER + "-live-next")) promoteNext();
    var cur = document.getElementById(MARKER + "-live");
    if (!src) {
      // No live layer wanted (switching to a video/image): fade the engine
      // out instead of dropping it on the spot. When a VIDEO is incoming,
      // hold the old visual until the preplay has committed (3s cap) —
      // fading out early leaves a dark gap while the video assembles.
      var holdMs = VIDEO_SRC ? 3000 : 0;
      liveFrames().forEach(function (f) {
        var fo = f;
        setTimeout(function () {
          fo.style.transition = "opacity .6s ease";
          fo.style.opacity = "0";
          setTimeout(function () { fo.remove(); }, 660);
        }, holdMs);
      });
      S.appliedLive = null;
      return;
    }
    if (!cur) {
      // "cut" transitions swap with no animation at all.
      if (TRANS === "cut") {
        var c0 = makeFrame(MARKER + "-live", src, "opacity:1;");
        wpRoot().appendChild(c0);
        S.appliedLive = src;
        bindLiveBridge();
        return;
      }
      // First mount (page load, heartbeat self-clean, plugin re-enable):
      // fade in from the app's own background instead of popping in.
      var first = makeFrame(MARKER + "-live", src, "opacity:0;transition:opacity .6s ease;");
      wpRoot().appendChild(first);
      S.appliedLive = src;
      bindLiveBridge();
      var settled = false;
      var onFirstReady = function (ev) {
        if (ev.data && ev.data.zwEvent === "ready" && first.contentWindow === ev.source) {
          settled = true;
          first.style.opacity = "1";
          window.removeEventListener("message", onFirstReady);
          clearTimeout(firstTimer);
        }
      };
      window.addEventListener("message", onFirstReady);
      var firstTimer = setTimeout(function () {
        if (!settled) { first.style.opacity = "1"; window.removeEventListener("message", onFirstReady); }
      }, 10000);
      return;
    }
    // Compare against the LAST APPLIED url, not the frame's src attribute:
    // hot-updates never rewrite the attribute (that would navigate/reload),
    // so attribute comparison makes the second toggle of a param (e.g. mute
    // -> unmute -> mute) a silent no-op — the volume command never ships.
    var applied = S.appliedLive || cur.getAttribute("src") || "";
    if (applied === src) { bindLiveBridge(); return; }
    var a = queryOf(applied);
    var b = queryOf(src);
    if (a.src && a.src === b.src && a.type === b.type) {
      // Same wallpaper, only fit/fps/muted changed: hot-update via postMessage.
      // (Setting src would reload the iframe and flash.)
      postAllFrames({ zw: "cfg", fit: b.fit, fps: Number(b.fps) || 30, volume: b.muted === "0" ? 1 : 0 });
      S.appliedLive = src;
      bindLiveBridge();
      return;
    }
    // Same-kind switch: IN-PLACE LOAD on the existing frame (dsh's
    // setWallpaper). The engine reuses its WebGL context — remounting for
    // every switch churned destroy/create cycles that lost contexts under
    // GPU pressure (rapid switching + 4K decode) and blanked the canvas.
    // A snapshot of the old frame covers the assembly gap; it fades out on
    // the renderer's ready signal.
    var oldOverlay = document.getElementById(MARKER + "-fade");
    if (oldOverlay) oldOverlay.remove();
    var doLoad = function (overlaySrc) {
      var overlay = null;
      if (overlaySrc) {
        overlay = document.createElement("img");
        overlay.id = MARKER + "-fade";
        overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;";
        overlay.src = overlaySrc;
        wpRoot().appendChild(overlay);
        var faded = false;
        // dsh's effect family: the outgoing snapshot LEAVES with the chosen
        // effect while the freshly-loaded source sits underneath — push
        // slides it away, wipe reveals edge-to-edge, iris opens a circle,
        // zoom recedes; cut never mounts an overlay at all.
        var fadeOut = function () {
          if (faded) return;
          faded = true;
          var t = TSPD + "ms cubic-bezier(.4,0,.2,1)";
          switch (TRANS) {
            case "push":
              overlay.style.transition = "transform " + t;
              overlay.style.transform = "translateX(100%)";
              break;
            case "wipe":
              overlay.style.transition = "clip-path " + t;
              overlay.style.clipPath = "inset(0 0 0 100%)";
              break;
            case "iris":
              overlay.style.transition = "clip-path " + t;
              overlay.style.clipPath = "circle(0% at 50% 50%)";
              break;
            case "zoom":
              overlay.style.transition = "transform " + t + ", opacity " + t;
              overlay.style.transform = "scale(1.18)";
              overlay.style.opacity = "0";
              break;
            default: // fade
              overlay.style.transition = "opacity " + t;
              overlay.style.opacity = "0";
          }
          setTimeout(function () { overlay.remove(); }, TSPD + 80);
        };
        var onReady = function (ev) {
          if (ev.data && ev.data.zwEvent === "ready" && cur.contentWindow === ev.source) {
            fadeOut();
            window.removeEventListener("message", onReady);
          }
        };
        window.addEventListener("message", onReady);
        setTimeout(fadeOut, 10000); // engine never signaled: uncover anyway
      }
      try {
        cur.contentWindow.postMessage({ zw: "load", type: b.type, src: b.src, file: b.file || "", fit: b.fit, fps: Number(b.fps) || 30, muted: b.muted, poster: b.poster || "" }, "*");
      } catch (e) {
        /* frame gone — the watchdogs remount */
      }
      S.appliedLive = src;
      bindLiveBridge();
    };
    if (TRANS === "cut") {
      doLoad("");
      return;
    }
    // Poster fallback: even when the snapshot times out (jpeg-encoding a
    // 1080p canvas can take >250ms), the NEW wallpaper's poster covers the
    // assembly — a switch must never show a bare clearing canvas.
    var posterAbs = b.poster ? API + b.poster : "";
    var snapped = false;
    var onSnap = function (ev) {
      if (snapped || !ev.data || ev.data.zwEvent !== "snap" || !cur.contentWindow || ev.source !== cur.contentWindow) return;
      snapped = true;
      window.removeEventListener("message", onSnap);
      clearTimeout(snapTimer);
      doLoad(ev.data.dataUrl || posterAbs);
    };
    var snapTimer = setTimeout(function () {
      if (snapped) return;
      snapped = true;
      window.removeEventListener("message", onSnap);
      doLoad(posterAbs); // no snapshot in time — the poster still covers
    }, 700);
    window.addEventListener("message", onSnap);
    try {
      cur.contentWindow.postMessage({ zw: "snapshot" }, "*");
    } catch (e) {
      clearTimeout(snapTimer);
      window.removeEventListener("message", onSnap);
      doLoad(posterAbs);
    }
  }

  /** The wallpaper layer container (id-stable; created by apply()). */
  function wpRoot() {
    return document.getElementById(MARKER + "-wallpaper");
  }

  // --- auto-heal opaque surfaces (Zgd03 model) -------------------------------
  // ZCode updates rename internal classes; our copied-class overrides then
  // miss and opaque cards cover the wallpaper (the recurring bare-css bug
  // class). Version-proof DOM-level fallback: scan bg-background surfaces,
  // force-translucent any opaque one covering >=30% of the viewport (skips
  // dialogs/menus/popovers), mark with an attr, recycle marks when layouts
  // change, and report additions to the flight recorder.
  if (!S.autoHeal) {
    S.autoHeal = true;
    var WP_AUTO = "data-zw-auto";
    var wpHeal = function () {
      try {
        var vp = window.innerWidth * window.innerHeight;
        var nodes = document.querySelectorAll("[class*=bg-background]");
        var keep = [];
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.closest("[role=dialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]")) continue;
          var r = n.getBoundingClientRect();
          if (r.width * r.height < vp * 0.3) continue;
          var bg = getComputedStyle(n).backgroundColor;
          var opaque = !(bg === "transparent" || bg === "rgba(0, 0, 0, 0)");
          if (!n.hasAttribute(WP_AUTO) && !opaque) continue;
          keep.push(n);
        }
        var marked = document.querySelectorAll("[" + WP_AUTO + "]");
        for (var m = 0; m < marked.length; m++) {
          if (keep.indexOf(marked[m]) === -1) marked[m].removeAttribute(WP_AUTO);
        }
        var added = 0;
        for (var k = 0; k < keep.length; k++) {
          if (!keep[k].hasAttribute(WP_AUTO)) { keep[k].setAttribute(WP_AUTO, ""); added++; }
          keep[k].style.setProperty("background-color", "var(--color-background)", "important");
        }
        if (added > 0) window.__zwRec && window.__zwRec("AUTOHEAL", added + " surface(s)");
      } catch (e) {
        /* never break the runtime */
      }
    };
    wpHeal();
    every(wpHeal, 5000);
  }

  // --- media watchdog (video layer) ------------------------------------------
  if (!S.visBound) {
    S.visBound = true;
    // Auto-pause debounced: Chromium re-evaluates occlusion when the window's
    // visual composition changes (opening settings, overlays) and can flip the
    // page hidden→visible within a moment — an instant pause froze the last
    // frame to a JPEG (visibly darker) that the resume then peeled off, the
    // "opens darker, then brightens" flash. Only a HIDDEN state that persists
    // pauses the renderer; a real minimize still does after 1.5s.
    var pendingPause = null;
    var schedulePause = function () {
      if (pendingPause) return;
      pendingPause = setTimeout(function () {
        pendingPause = null;
        S.__pauseTimer = null;
        if (!document.hidden) return;
        var v = document.getElementById(MARKER + "-video");
        if (v) v.pause();
        postAllFrames({ zw: "pause" });
      }, 1500);
      S.__pauseTimer = pendingPause;
    };
    var cancelPause = function () {
      if (pendingPause) { clearTimeout(pendingPause); pendingPause = null; }
    };
    on(document, "visibilitychange", function () {
      if (document.hidden) {
        schedulePause();
      } else {
        cancelPause();
        var v = document.getElementById(MARKER + "-video");
        if (v) v.play().catch(function () {});
        postAllFrames({ zw: "resume" });
      }
    });
    var wake = function () {
      var v = document.getElementById(MARKER + "-video");
      if (v) v.play().catch(function () {});
      // Any real window interaction also wakes an auto-paused renderer
      // (boot can leave it paused under a hidden page; the renderer ignores
      // this when the user paused it manually).
      postAllFrames({ zw: "resume" });
    };
    on(window, "focus", wake);
    on(document, "pointerdown", wake, true);
    on(window, "pageshow", wake);
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
      var v = document.getElementById(MARKER + "-video");
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
    S.watchdog = every(kickVideo, 2000);
    on(document, "pointerdown", function () { requestAnimationFrame(function () { kickVideo(); }); }, { capture: true, passive: true });
    on(window, "focus", function () { requestAnimationFrame(function () { kickVideo(); }); });
    on(document, "visibilitychange", function () {
      if (!document.hidden) requestAnimationFrame(function () { kickVideo(); });
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
      postAllFrames({ zw: "ptr", u: latest.u, v: latest.v, buttons: latest.buttons, mods: latest.mods });
      latest = null;
    }
    function coords(e) {
      return { u: Math.max(0, Math.min(1, e.clientX / Math.max(1, window.innerWidth))),
               v: Math.max(0, Math.min(1, e.clientY / Math.max(1, window.innerHeight))),
               buttons: e.buttons, mods: (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0) };
    }
    on(document, "pointermove", function (e) {
      latest = coords(e);
      if (!queued) { queued = true; requestAnimationFrame(flush); }
    }, { capture: true, passive: true });
    on(document, "pointerdown", function (e) {
      latest = coords(e);
      flush();
    }, { capture: true, passive: true });
    on(document, "pointerup", function () {
      postAllFrames({ zw: "ptrup" });
    }, { capture: true, passive: true });
    on(document, "wheel", function (e) {
      postAllFrames({ zw: "wheel", dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode,
        mods: (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0) });
    }, { capture: true, passive: true });
    on(window, "blur", function () {
      postAllFrames({ zw: "ptrleave" });
    });
  }

  // --- THE payload applier ----------------------------------------------------
  function apply(payload) {
    if (!payload) return;
    VIDEO_SRC = payload.videoSrc || "";
    LIVE_SRC = payload.liveSrc || "";
    TRANS = payload.transition === "cut" ? "cut" : payload.transition || "fade";
    TSPD = ({ fast: 260, normal: 600, slow: 1100 })[payload.transitionSpeed] || 600;
    VMUTED = payload.videoMuted !== false;
    VFIT = payload.fit === "contain" ? "contain" : payload.fit === "stretch" ? "fill" : "cover";
    WPIMG = payload.wallpaperDataUri || "";
    FIT = payload.fit || "cover";
    UNDERLAY = payload.livePoster || "";

    if (S.cssText === payload.css && S.videoSrc === VIDEO_SRC && S.liveSrc === LIVE_SRC && S.trans === TRANS) return;
    S.cssText = payload.css;
    S.videoSrc = VIDEO_SRC;
    S.liveSrc = LIVE_SRC;
    S.trans = TRANS;

    var style = document.getElementById(MARKER + "-style");
    if (!style) {
      style = document.createElement("style");
      style.id = MARKER + "-style";
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = payload.css;

    var wp = wpRoot();
    if (WPIMG || VIDEO_SRC || LIVE_SRC) {
      if (!wp) {
        wp = document.createElement("div");
        wp.id = MARKER + "-wallpaper";
        document.documentElement.appendChild(wp);
      }
    } else if (wp) {
      wp.remove();
    }

    applyLive(LIVE_SRC);

    // --- loop video layer (dsh's model: a native <video> in the host page) ----
    // Videos never enter the WebGL engine: engine pause clears the WebCodecs
    // canvas and its scheduler fast-forwards on wake. A native element pauses
    // on its last frame and preplays OFFSCREEN (dsh's prepareVideoProbe): the
    // new video reaches canplay while detached, then commits already playing —
    // on screen it is a live picture immediately, no reload gap, no burst.
    var vid = document.getElementById(MARKER + "-video");
    if (VIDEO_SRC) {
      if (wp) wp.style.backgroundImage = "none";
      if (vid && vid.getAttribute("src") === VIDEO_SRC) {
        // Self-heal: an element that errored once (e.g. its fetch hit a serve
        // restart mid-boot) stays dead forever unless load() restarts it.
        if (vid.error) { vid.load(); }
        vid.muted = VMUTED; // hot-update: same video, muted/fit tweak
        vid.style.objectFit = VFIT;
        vid.play().catch(function () {});
      } else if (S.videoPrepSrc === VIDEO_SRC) {
        // A preplay for this exact video is already in flight — boot pushes
        // overlap inside the 3s preplay window. Starting a second one tears
        // the first mount down the moment it commits: the exact "mounted,
        // suddenly unloaded, remounted" boot artifact.
      } else {
        S.videoPrepSrc = VIDEO_SRC;
        S.videoPrepToken = (S.videoPrepToken || 0) + 1;
        var myToken = S.videoPrepToken;
        var nv = document.createElement("video");
        nv.setAttribute("autoplay", "");
        nv.setAttribute("loop", "");
        nv.setAttribute("playsinline", "");
        nv.muted = VMUTED;
        nv.src = VIDEO_SRC;
        nv.load();
        var committed = false;
        var commit = function () {
          if (committed) return;
          if (S.videoPrepToken !== myToken) return; // superseded by a newer pick
          committed = true;
          S.videoPrepSrc = null;
          // The outgoing video FADES OUT while the preplayed one fades in —
          // removing it up front leaves a hard black gap under the fade.
          var old = document.getElementById(MARKER + "-video");
          if (old) {
            old.removeAttribute("id");
            old.style.transition = "opacity .6s ease";
            old.style.opacity = "0";
            setTimeout(function () { old.remove(); }, 660);
          }
          nv.id = MARKER + "-video";
          nv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:" + VFIT + ";opacity:0;transition:opacity .6s ease;";
          wpRoot().appendChild(nv);
          nv.play().catch(function () {});
          requestAnimationFrame(function () { nv.style.opacity = "1"; });
          setTimeout(function () { if (nv.style) nv.style.transition = "none"; }, 660);
        };
        nv.addEventListener("canplay", commit, { once: true });
        // A load error (e.g. the fetch hit a serve restart mid-boot) must NOT
        // commit a dead element — error 4 never self-heals. Restart the load
        // once; the 3s timeout commits whatever state remains by then.
        nv.addEventListener("error", function onErr() {
          nv.removeEventListener("error", onErr);
          if (S.videoPrepToken === myToken) setTimeout(function () { nv.load(); }, 800);
        }, { once: true });
        setTimeout(commit, 3000);
        nv.play().catch(function () {});
      }
    } else {
      if (vid) {
        // Switching away from a video: hold it until the incoming layer is
        // actually on screen — for a live source that's the engine's 'ready'
        // signal (4s cap), otherwise fade at once.
        var vOut = vid;
        var startFade = function () {
          vOut.style.transition = "opacity .6s ease";
          vOut.style.opacity = "0";
          setTimeout(function () { vOut.remove(); }, 660);
        };
        if (LIVE_SRC) {
          var heardR = false;
          var onR = function (ev) {
            if (heardR) return;
            if (ev.data && ev.data.zwEvent === "ready") {
              heardR = true;
              window.removeEventListener("message", onR);
              clearTimeout(rT);
              startFade();
            }
          };
          window.addEventListener("message", onR);
          var rT = setTimeout(function () {
            if (!heardR) {
              heardR = true;
              window.removeEventListener("message", onR);
              startFade();
            }
          }, 4000);
        } else {
          startFade();
        }
      }
      if (WPIMG) {
        if (wp) wp.style.backgroundImage = "url(" + WPIMG + ")";
      } else if (wp) {
        wp.style.backgroundImage = "none";
      }
    }

    // --- blurred backdrop: contain framing, and the live underlay -----------
    // The blurred layer doubles as dsh's ambient underlay: while the engine
    // assembles (or blanks/reloads), the wallpaper poster shows as a soft
    // blurred wash instead of a hard-cropped zoomed section of itself.
    var bp = document.getElementById(MARKER + "-backdrop");
    if ((FIT === "contain" && WPIMG) || (LIVE_SRC && UNDERLAY)) {
      if (!bp) {
        bp = document.createElement("div");
        bp.id = MARKER + "-backdrop";
        document.documentElement.appendChild(bp);
      }
      bp.style.backgroundImage = "url(" + (WPIMG ? WPIMG : UNDERLAY) + ")";
      bp.dataset.on = "1";
    } else if (bp) {
      bp.dataset.on = "0";
    }
    window.__zwRec && window.__zwRec("APPLY", "live=" + (LIVE_SRC ? "y" : "n") + " video=" + (VIDEO_SRC ? "y" : "n") + " img=" + (WPIMG ? "y" : "n"));
  }

  // --- SSE: config changes from serve ----------------------------------------
  // Reconnect with capped backoff so a busy serve (Monet decode, zip import
  // can block its loop for seconds) never strands this page on a stale
  // config; a really-gone serve is handled by the bootstrap heartbeat.
  function connectSse() {
    if (!window.EventSource) return;
    var es;
    try {
      es = new EventSource(API + "/api/events?client=agent");
    } catch (e) {
      return; // standalone (CLI direct) mode
    }
    sseHandle = es;
    var delay = 1000;
    es.addEventListener("cfg", function (ev) {
      try {
        apply(JSON.parse(ev.data));
      } catch (e) {
        window.__zwRec("SSE", "bad payload");
      }
    });
    es.onopen = function () { delay = 1000; };
    es.onerror = function () {
      try { es.close(); } catch (e) {}
      if (sseHandle === es) sseHandle = null;
      var t = setTimeout(connectSse, delay);
      timers.push(t);
      delay = Math.min(30000, delay * 3);
    };
  }
  connectSse();

  // Head start: whatever the bootstrap embedded (fresh page, no round trip).
  apply(window.__zwPayload);

  // --- teardown (bootstrap heartbeat / reset script) ---------------------------
  window.__zwTeardownAgent = function () {
    if (S.__pauseTimer) { clearTimeout(S.__pauseTimer); S.__pauseTimer = null; }
    if (sseHandle) { try { sseHandle.close(); } catch (e) {} sseHandle = null; }
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    timers = [];
    listeners.forEach(function (l) {
      try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {}
    });
    listeners = [];
    [MARKER + "-style", MARKER + "-wallpaper", MARKER + "-backdrop", MARKER + "-fade", MARKER + "-live", MARKER + "-live-next", MARKER + "-video"].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.remove();
    });
    S.cssText = null;
    S.videoSrc = null;
    S.liveSrc = null;
    S.appliedLive = null;
    S.trans = null;
    S.boundFrame = null;
    S.autoHeal = null;
    S.visBound = null;
    S.watchdog = null;
    window.__zwAgent = null;
    try { window.__zwRec("TEARDOWN", "agent"); } catch (e) {}
  };
})();
