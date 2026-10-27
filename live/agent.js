"use strict";
(() => {
  // live/src/state.js
  var KIND = { NONE: "none", IMAGE: "image", VIDEO: "video", LIVE: "live" };
  var STATES = {
    [KIND.NONE]: ["idle"],
    [KIND.IMAGE]: ["shown"],
    [KIND.VIDEO]: ["prep", "shown", "leaving"],
    [KIND.LIVE]: ["poster", "loading", "shown", "switching", "stalled", "paused", "failed"]
  };
  var TRANSITIONS = {
    "none/idle": { SET_SOURCE: true },
    "image/shown": { SET_SOURCE: true, CLEAR: "none/idle" },
    "video/prep": { SET_SOURCE: true, VREADY: "video/shown", VLEAVE_BEGIN: "video/leaving", CLEAR: "none/idle" },
    "video/shown": { SET_SOURCE: true, VLEAVE_BEGIN: "video/leaving", CLEAR: "none/idle" },
    "video/leaving": { SET_SOURCE: true, VLEAVE_DONE: "none/idle" },
    "live/poster": {
      SET_SOURCE: true,
      // A poster phase with a real source arriving must be able to graduate:
      // 0.4.0-0.4.13 got stuck here (SWITCH_BEGIN rejected) when a payload
      // carried a live URL while the machine idled in poster.
      SWITCH_BEGIN: "live/switching",
      READY: "live/shown"
    },
    "live/loading": {
      SET_SOURCE: true,
      READY: "live/shown",
      SWITCH_BEGIN: true,
      // a re-pick during loading restarts it in place
      PAUSE: "live/paused",
      BUDGET_EXHAUSTED: "live/failed",
      STALL_PERSIST: "live/failed"
    },
    "live/shown": {
      SET_SOURCE: true,
      SWITCH_BEGIN: "live/switching",
      STALL: "live/stalled",
      PAUSE: "live/paused",
      CLEAR: "none/idle"
    },
    "live/switching": {
      SET_SOURCE: true,
      SWITCH_BEGIN: true,
      // rapid re-switch: restart the in-place load
      SWITCH_READY: "live/shown",
      PAUSE: "live/paused",
      BUDGET_EXHAUSTED: "live/failed",
      STALL_PERSIST: "live/failed"
    },
    "live/stalled": {
      SET_SOURCE: true,
      RESUME: "live/shown",
      STALL_PERSIST: "live/failed",
      PAUSE: "live/paused"
    },
    "live/paused": { SET_SOURCE: true, RESUME: "restore" },
    "live/failed": { SET_SOURCE: true, RETRY: "reenter", CLEAR: "none/idle" }
  };
  function entryPhase(kind, hasPoster) {
    if (kind === KIND.LIVE) return hasPoster ? "live/poster" : "live/loading";
    if (kind === KIND.VIDEO) return "video/prep";
    if (kind === KIND.IMAGE) return "image/shown";
    return "none/idle";
  }
  var LEDGER_TICK_MS = 1e3;
  var LEDGER_STALL_TICKS = 8;
  var LEDGER_CAP_MS = 6e4;
  var FIRST_FRAME_BASE_MS = 12e3;
  var FIRST_FRAME_BYTES_PER_MS = 2048;
  var FIRST_FRAME_CAP_MS = 4e4;
  var SOFT_RETRY_LIMIT = 2;
  var SOFT_RETRY_DELAY_MS = 4e3;
  var TRANSITION_HISTORY = 200;
  function firstFrameBudgetMs(totalBytes) {
    if (!totalBytes || totalBytes <= 0) return FIRST_FRAME_BASE_MS;
    return Math.min(FIRST_FRAME_CAP_MS, FIRST_FRAME_BASE_MS + totalBytes / FIRST_FRAME_BYTES_PER_MS);
  }
  function classifyFailure({ bytesComplete, stallTicks }) {
    if (!bytesComplete && stallTicks >= LEDGER_STALL_TICKS) return "transfer";
    return null;
  }
  function createMachine(onEvent) {
    let kind = KIND.NONE;
    let phase = "none/idle";
    let prePause = null;
    let softRetries = 0;
    const history = [];
    function moveTo(target, event, data) {
      if (event === "PAUSE") prePause = phase;
      else prePause = null;
      const from = phase;
      phase = target;
      kind = target.split("/")[0];
      if (event === "SET_SOURCE" || event === "RETRY") softRetries = 0;
      history.push({ t: Date.now(), from, event, to: phase, reason: data && data.reason, rejected: false });
      if (history.length > TRANSITION_HISTORY) history.shift();
      if (onEvent) onEvent({ from, event, to: phase, phase, kind, data });
    }
    function reject(event, data) {
      history.push({ t: Date.now(), from: phase, event, to: phase, rejected: true });
      if (history.length > TRANSITION_HISTORY) history.shift();
      if (onEvent) onEvent({ from: phase, event, to: phase, phase, kind, data, rejected: true });
      return false;
    }
    return {
      get phase() {
        return phase;
      },
      get kind() {
        return kind;
      },
      get history() {
        return history;
      },
      canFire(event) {
        const row = TRANSITIONS[phase];
        return !!row && Object.prototype.hasOwnProperty.call(row, event);
      },
      fire(event, data) {
        if (event === "SET_SOURCE") {
          moveTo(entryPhase(data && data.kind || KIND.NONE, data && data.hasPoster), event, data);
          return true;
        }
        if (event === "RETRY") {
          if (phase !== "live/failed") return reject(event, data);
          moveTo(entryPhase(KIND.LIVE, data && data.hasPoster), event, data);
          return true;
        }
        if (event === "RESUME" && phase === "live/paused") {
          moveTo(prePause || "live/shown", event, data);
          return true;
        }
        const row = TRANSITIONS[phase];
        if (!row || !Object.prototype.hasOwnProperty.call(row, event)) return reject(event, data);
        const to = row[event];
        if (to === true) {
          const from = phase;
          history.push({ t: Date.now(), from, event, to: phase, reason: data && data.reason, rejected: false });
          if (history.length > TRANSITION_HISTORY) history.shift();
          if (onEvent) onEvent({ from, event, to: phase, phase, kind, data });
          return true;
        }
        moveTo(to, event, data);
        return true;
      },
      /** Soft-failure retry accounting: returns ms to wait, or null when the
       *  budget is spent and the failure must escalate to hard. */
      scheduleSoftRetry() {
        if (softRetries >= SOFT_RETRY_LIMIT) return null;
        softRetries++;
        return SOFT_RETRY_DELAY_MS;
      },
      get softRetries() {
        return softRetries;
      }
    };
  }

  // live/src/agent/recorder.js
  var MARKER = "zcode-wallpaper";
  function createRecorder(reg) {
    if (window.__zwRec) return window.__zwRec;
    window.__zwLog = [];
    let lastEntry = "";
    window.__zwRec = function(tag, d) {
      try {
        const line = tag + "|" + (d === void 0 ? "" : String(d));
        if (line === lastEntry) return;
        lastEntry = line;
        window.__zwLog.push({ t: (/* @__PURE__ */ new Date()).toISOString().slice(11, 23), tag, d: d === void 0 ? "" : String(d).slice(0, 160) });
        if (window.__zwLog.length > 800) window.__zwLog.shift();
      } catch (e) {
      }
    };
    const rec = window.__zwRec;
    try {
      const obs = new MutationObserver(function(muts) {
        muts.forEach(function(mu) {
          if (mu.removedNodes) Array.prototype.forEach.call(mu.removedNodes, function(n) {
            if (n.id && String(n.id).indexOf(MARKER) === 0) rec("REMOVE", n.id + " @ " + (mu.target.id || mu.target.tagName));
          });
          if (mu.addedNodes) Array.prototype.forEach.call(mu.addedNodes, function(n) {
            if (n.id && String(n.id).indexOf(MARKER) === 0) rec("ADD", n.id);
          });
          if (mu.type === "attributes" && mu.target.id && String(mu.target.id).indexOf(MARKER) === 0)
            rec("ATTR", mu.target.id + "." + mu.attributeName);
        });
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "src"] });
      reg.observer(obs);
      reg.on(document, "visibilitychange", function() {
        rec("VIS", document.hidden ? "hidden" : "visible");
      });
      reg.on(window, "message", function(ev) {
        if (!ev.data || !ev.data.zwEvent) return;
        const d = ev.data;
        if (d.zwEvent === "hb2") rec("ENGINE", "fps=" + d.fps + " paused=" + d.paused + " poster=" + d.poster);
        else rec("MSG", d.zwEvent + (d.message ? " " + String(d.message).slice(0, 80) : ""));
      });
      let lastSnap = "";
      reg.every(function() {
        const st = document.getElementById(MARKER + "-style");
        const lv = document.getElementById(MARKER + "-live");
        const bd = document.getElementById(MARKER + "-backdrop");
        const line = "css=" + (st ? st.textContent.length : 0) + " live=" + (lv ? getComputedStyle(lv).opacity : "-") + " bd=" + (bd ? bd.dataset.on : "-");
        if (line !== lastSnap) {
          lastSnap = line;
          rec("SNAP", line);
        }
      }, 3e3);
      reg.on(window, "error", function(e) {
        rec("PAGEERR", (e.message || "") + " @" + (e.lineno || 0));
      });
    } catch (e) {
    }
    rec("BOOT", "agent runtime installed");
    return rec;
  }

  // live/src/agent/bridge.js
  function createBridge(reg, frames, rec) {
    let bound = false;
    function postAll(msg) {
      frames().forEach(function(f) {
        try {
          f.contentWindow.postMessage(msg, "*");
        } catch (e) {
        }
      });
    }
    function start() {
      if (bound) return;
      bound = true;
      let latest = null, queued = false;
      function flush() {
        queued = false;
        if (!latest) return;
        postAll({ zw: "ptr", u: latest.u, v: latest.v, buttons: latest.buttons, mods: latest.mods });
        latest = null;
      }
      function coords(e) {
        return {
          u: Math.max(0, Math.min(1, e.clientX / Math.max(1, window.innerWidth))),
          v: Math.max(0, Math.min(1, e.clientY / Math.max(1, window.innerHeight))),
          buttons: e.buttons,
          mods: (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0)
        };
      }
      reg.on(document, "pointermove", function(e) {
        latest = coords(e);
        if (!queued) {
          queued = true;
          requestAnimationFrame(flush);
        }
      }, { capture: true, passive: true });
      reg.on(document, "pointerdown", function(e) {
        latest = coords(e);
        flush();
      }, { capture: true, passive: true });
      reg.on(document, "pointerup", function() {
        postAll({ zw: "ptrup" });
      }, { capture: true, passive: true });
      reg.on(document, "wheel", function(e) {
        postAll({
          zw: "wheel",
          dx: e.deltaX,
          dy: e.deltaY,
          mode: e.deltaMode,
          mods: (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0)
        });
      }, { capture: true, passive: true });
      reg.on(window, "blur", function() {
        postAll({ zw: "ptrleave" });
      });
    }
    return { start, postAll };
  }

  // live/src/agent/liveframe.js
  function queryOf(u) {
    const out = {};
    try {
      const q = new URL(u, location.href).searchParams;
      ["type", "src", "file", "fit", "fps", "muted", "poster"].forEach(function(k) {
        out[k] = q.get(k) || "";
      });
    } catch (e) {
    }
    return out;
  }
  function createLiveFrame({ reg, rec, wpRoot, bridge }) {
    let applied = "";
    let api = "";
    function frames() {
      return Array.prototype.slice.call(document.querySelectorAll("#" + MARKER + "-live, #" + MARKER + "-live-next"));
    }
    function postAll(msg) {
      frames().forEach(function(f) {
        try {
          f.contentWindow.postMessage(msg, "*");
        } catch (e) {
        }
      });
    }
    function makeFrame(id, src, extraCss) {
      const f = document.createElement("iframe");
      f.id = id;
      f.setAttribute("allow", "autoplay");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;background:transparent;" + (extraCss || "");
      f.setAttribute("src", src);
      return f;
    }
    function promoteNext() {
      const cur = document.getElementById(MARKER + "-live");
      const next = document.getElementById(MARKER + "-live-next");
      if (!next) return;
      if (cur) cur.remove();
      next.id = MARKER + "-live";
      next.style.transition = "none";
      next.style.opacity = "1";
      const tr = window.__zw && window.__zw.tr;
      if (tr) {
        clearTimeout(tr.timer);
        window.removeEventListener("message", tr.onMsg);
        window.__zw.tr = null;
      }
    }
    function applySrc(src, opts) {
      opts = opts || {};
      const TRANS = opts.trans || "fade";
      const TSPD = opts.tspd || 600;
      api = opts.apiBase || api;
      if (document.getElementById(MARKER + "-live-next")) promoteNext();
      const cur = document.getElementById(MARKER + "-live");
      if (!src) {
        const holdMs = opts.videoIncoming ? 3e3 : 0;
        frames().forEach(function(f) {
          const fo = f;
          setTimeout(function() {
            fo.style.transition = "opacity .6s ease";
            fo.style.opacity = "0";
            setTimeout(function() {
              fo.remove();
            }, 660);
          }, holdMs);
        });
        applied = "";
        return "removed";
      }
      if (!cur) {
        if (TRANS === "cut") {
          wpRoot().appendChild(makeFrame(MARKER + "-live", src, "opacity:1;"));
          applied = src;
          bridge.start();
          return "mount";
        }
        const first = makeFrame(MARKER + "-live", src, "opacity:0;transition:opacity .6s ease;");
        wpRoot().appendChild(first);
        applied = src;
        bridge.start();
        let settled = false;
        const onFirstReady = function(ev) {
          if (ev.data && ev.data.zwEvent === "ready" && first.contentWindow === ev.source) {
            settled = true;
            first.style.opacity = "1";
            window.removeEventListener("message", onFirstReady);
            clearTimeout(firstTimer);
          }
        };
        window.addEventListener("message", onFirstReady);
        reg.timer(function() {
          if (!settled) {
            first.style.opacity = "1";
            window.removeEventListener("message", onFirstReady);
          }
        }, 1e4);
        return "mount";
      }
      const appliedUrl = applied || cur.getAttribute("src") || "";
      if (appliedUrl === src) {
        bridge.start();
        return "hot";
      }
      const a = queryOf(appliedUrl);
      const b = queryOf(src);
      if (a.src && a.src === b.src && a.type === b.type) {
        postAll({ zw: "cfg", fit: b.fit, fps: Number(b.fps) || 30, volume: b.muted === "0" ? 1 : 0 });
        applied = src;
        bridge.start();
        return "hot";
      }
      const oldOverlay = document.getElementById(MARKER + "-fade");
      if (oldOverlay) oldOverlay.remove();
      const doLoad = function(overlaySrc) {
        let overlay = null;
        if (overlaySrc) {
          overlay = document.createElement("img");
          overlay.id = MARKER + "-fade";
          overlay.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;";
          overlay.src = overlaySrc;
          wpRoot().appendChild(overlay);
          let faded = false;
          const fadeOut = function() {
            if (faded) return;
            faded = true;
            const t = TSPD + "ms cubic-bezier(.4,0,.2,1)";
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
              default:
                overlay.style.transition = "opacity " + t;
                overlay.style.opacity = "0";
            }
            reg.timer(function() {
              overlay.remove();
            }, TSPD + 80);
          };
          const onReady = function(ev) {
            if (ev.data && ev.data.zwEvent === "ready" && cur.contentWindow === ev.source) {
              fadeOut();
              window.removeEventListener("message", onReady);
            }
          };
          window.addEventListener("message", onReady);
          reg.timer(fadeOut, 1e4);
        }
        try {
          cur.contentWindow.postMessage({ zw: "load", type: b.type, src: b.src, file: b.file || "", fit: b.fit, fps: Number(b.fps) || 30, muted: b.muted, poster: b.poster || "" }, "*");
        } catch (e) {
        }
        applied = src;
        bridge.start();
      };
      if (TRANS === "cut") {
        doLoad("");
        return "switch";
      }
      const posterAbs = b.poster ? api + b.poster : "";
      let snapped = false;
      const onSnap = function(ev) {
        if (snapped || !ev.data || ev.data.zwEvent !== "snap" || !cur.contentWindow || ev.source !== cur.contentWindow) return;
        snapped = true;
        window.removeEventListener("message", onSnap);
        clearTimeout(snapTimer);
        doLoad(ev.data.dataUrl || posterAbs);
      };
      const snapTimer = setTimeout(function() {
        if (snapped) return;
        snapped = true;
        window.removeEventListener("message", onSnap);
        doLoad(posterAbs);
      }, 700);
      window.addEventListener("message", onSnap);
      try {
        cur.contentWindow.postMessage({ zw: "snapshot" }, "*");
      } catch (e) {
        clearTimeout(snapTimer);
        window.removeEventListener("message", onSnap);
        doLoad(posterAbs);
      }
      return "switch";
    }
    return {
      applySrc,
      postAll,
      frames,
      get applied() {
        return applied;
      },
      reset() {
        applied = "";
      }
    };
  }

  // live/src/agent/video.js
  function createVideoActor({ reg, rec, wpRoot, onReady }) {
    const S = window.__zw = window.__zw || {};
    let currentSrc = "";
    function findVideo() {
      return document.getElementById(MARKER + "-video");
    }
    function apply(src, opts) {
      opts = opts || {};
      const VMUTED = opts.muted !== false;
      const VFIT = opts.fit === "contain" ? "contain" : opts.fit === "stretch" ? "fill" : "cover";
      const vid = findVideo();
      if (src) {
        if (wpRoot()) wpRoot().style.backgroundImage = "none";
        if (vid && vid.getAttribute("src") === src) {
          if (vid.error) vid.load();
          vid.muted = VMUTED;
          vid.style.objectFit = VFIT;
          vid.play().catch(function() {
          });
          return "hot";
        }
        if (S.videoPrepSrc === src) {
          return "prep-pending";
        }
        S.videoPrepSrc = src;
        S.videoPrepToken = (S.videoPrepToken || 0) + 1;
        const myToken = S.videoPrepToken;
        const nv = document.createElement("video");
        nv.setAttribute("autoplay", "");
        nv.setAttribute("loop", "");
        nv.setAttribute("playsinline", "");
        nv.muted = VMUTED;
        nv.src = src;
        nv.load();
        let committed = false;
        const commit = function() {
          if (committed) return;
          if (S.videoPrepToken !== myToken) return;
          committed = true;
          S.videoPrepSrc = null;
          const old = findVideo();
          if (old) {
            old.removeAttribute("id");
            old.style.transition = "opacity .6s ease";
            old.style.opacity = "0";
            reg.timer(function() {
              old.remove();
            }, 660);
          }
          nv.id = MARKER + "-video";
          nv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:" + VFIT + ";opacity:0;transition:opacity .6s ease;";
          wpRoot().appendChild(nv);
          nv.play().catch(function() {
          });
          requestAnimationFrame(function() {
            nv.style.opacity = "1";
          });
          reg.timer(function() {
            if (nv.style) nv.style.transition = "none";
          }, 660);
          currentSrc = src;
          if (onReady) onReady();
        };
        nv.addEventListener("canplay", commit, { once: true });
        nv.addEventListener("error", function onErr() {
          nv.removeEventListener("error", onErr);
          if (S.videoPrepToken === myToken) reg.timer(function() {
            nv.load();
          }, 800);
        }, { once: true });
        reg.timer(commit, 3e3);
        nv.play().catch(function() {
        });
        return "prep";
      }
      if (vid) {
        const vOut = vid;
        const startFade = function() {
          vOut.style.transition = "opacity .6s ease";
          vOut.style.opacity = "0";
          reg.timer(function() {
            vOut.remove();
          }, 660);
        };
        if (opts.liveIncoming) {
          let heardR = false;
          const onR = function(ev) {
            if (heardR) return;
            if (ev.data && ev.data.zwEvent === "ready") {
              heardR = true;
              window.removeEventListener("message", onR);
              clearTimeout(rT);
              startFade();
            }
          };
          window.addEventListener("message", onR);
          const rT = setTimeout(function() {
            if (!heardR) {
              heardR = true;
              window.removeEventListener("message", onR);
              startFade();
            }
          }, 4e3);
        } else {
          startFade();
        }
        currentSrc = "";
      }
      return "removed";
    }
    return {
      apply,
      findVideo,
      get currentSrc() {
        return currentSrc;
      },
      pause() {
        const v = findVideo();
        if (v) v.pause();
      },
      resume() {
        const v = findVideo();
        if (v) v.play().catch(function() {
        });
      }
    };
  }

  // live/src/agent/watchdogs.js
  function createWatchdogs({ reg, machine, video, postAll }) {
    let pendingPause = null;
    function schedulePause() {
      if (pendingPause) return;
      pendingPause = setTimeout(function() {
        pendingPause = null;
        if (!document.hidden) return;
        video.pause();
        postAll({ zw: "pause" });
        if (machine.kind === "live") machine.fire("PAUSE");
      }, 1500);
    }
    function cancelPause() {
      if (pendingPause) {
        clearTimeout(pendingPause);
        pendingPause = null;
      }
    }
    reg.on(document, "visibilitychange", function() {
      if (document.hidden) {
        schedulePause();
      } else {
        cancelPause();
        video.resume();
        postAll({ zw: "resume" });
        if (machine.phase === "live/paused") machine.fire("RESUME");
      }
    });
    const wake = function() {
      video.resume();
      postAll({ zw: "resume" });
      if (machine.phase === "live/paused") machine.fire("RESUME");
    };
    reg.on(window, "focus", wake);
    reg.on(document, "pointerdown", wake, true);
    reg.on(window, "pageshow", wake);
    let stallCount = 0;
    let lastClock = -1;
    const kickVideo = function() {
      const v = video.findVideo();
      if (!v || document.hidden) return;
      if (v.ended || v.paused && v.autoplay) {
        stallCount = 0;
        v.play().catch(function() {
        });
      } else if (!v.paused && v.readyState >= 2 && lastClock === v.currentTime) {
        stallCount++;
        if (stallCount >= 1) {
          v.load();
        }
        v.play().catch(function() {
        });
      } else {
        stallCount = 0;
      }
      lastClock = v.currentTime;
    };
    reg.every(kickVideo, 2e3);
    reg.on(document, "pointerdown", function() {
      requestAnimationFrame(kickVideo);
    }, { capture: true, passive: true });
    reg.on(window, "focus", function() {
      requestAnimationFrame(kickVideo);
    });
    reg.on(document, "visibilitychange", function() {
      if (!document.hidden) requestAnimationFrame(kickVideo);
    });
    return { kickVideo };
  }

  // live/src/agent/ledger.js
  function createLedger({ apiBase, rec, onVerdict }) {
    let timer = null;
    let sourceId = "";
    let totalBytes = 0;
    let lastBytes = -1;
    let stallTicks = 0;
    let startedAt = 0;
    let budgetMs = 0;
    let budgetFromSize = false;
    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
    function tick() {
      if (!sourceId) return;
      const url = apiBase + "/api/transfer?id=" + encodeURIComponent(sourceId);
      fetch(url).then(function(r) {
        return r.json();
      }).then(function(d) {
        if (!d || typeof d.bytes !== "number" || !timer) return;
        if (d.total && !budgetFromSize) {
          budgetFromSize = true;
          budgetMs = firstFrameBudgetMs(d.total);
          rec("LEDGER", "total=" + d.total + " budget=" + Math.round(budgetMs) + "ms");
        }
        if (d.bytes > lastBytes) {
          lastBytes = d.bytes;
          stallTicks = 0;
        } else {
          stallTicks++;
        }
        const stalled = classifyFailure({ bytesComplete: d.bytes >= d.total, stallTicks });
        const budgetSpent = Date.now() - startedAt > Math.max(budgetMs, LEDGER_CAP_MS);
        if (stalled === "transfer" || budgetSpent) {
          stop();
          const complete = d.bytes >= d.total;
          onVerdict(budgetSpent ? complete ? "renderer" : "transfer" : "transfer");
        }
      }).catch(function() {
      });
    }
    return {
      /** Start watching a live source load. */
      watch(id, sizeBytes) {
        stop();
        if (!id) return;
        sourceId = id;
        totalBytes = sizeBytes || 0;
        lastBytes = -1;
        stallTicks = 0;
        startedAt = Date.now();
        budgetMs = firstFrameBudgetMs(totalBytes);
        rec("LEDGER", "watch " + id + " budget=" + Math.round(budgetMs) + "ms" + (totalBytes ? " size=" + totalBytes : ""));
        timer = setInterval(tick, LEDGER_TICK_MS);
      },
      /** The engine reported ready — success, no verdict needed. */
      settle() {
        stop();
      },
      stop
    };
  }

  // live/src/agent/main.js
  (function() {
    if (window.__zwAgent) return;
    window.__zwAgent = true;
    const S = window.__zw = window.__zw || {};
    const API = window.__zwApiBase || "http://127.0.0.1:" + (window.__zwPayload && window.__zwPayload.apiPort || 28257);
    const timers = [];
    const listeners = [];
    const observers = [];
    const reg = {
      every(fn, ms) {
        const t = setInterval(fn, ms);
        timers.push(t);
        return t;
      },
      timer(fn, ms) {
        const t = setTimeout(fn, ms);
        timers.push(t);
        return t;
      },
      on(target, type, fn, opts) {
        target.addEventListener(type, fn, opts);
        listeners.push([target, type, fn, opts]);
      },
      observer(o) {
        observers.push(o);
      }
    };
    const rec = createRecorder(reg);
    let VIDEO_SRC = "", LIVE_SRC = "", TRANS = "fade", TSPD = 600;
    let VMUTED = true, VFIT = "cover", WPIMG = "", FIT = "cover", UNDERLAY = "";
    let failedInfo = null;
    function wpRoot() {
      return document.getElementById(MARKER + "-wallpaper");
    }
    let liveframe;
    const bridge = createBridge(reg, () => liveframe.frames(), rec);
    liveframe = createLiveFrame({ reg, rec, wpRoot, bridge });
    const video = createVideoActor({ reg, rec, wpRoot, onReady: () => machine.fire("VREADY") });
    const ledger = createLedger({
      apiBase: API,
      rec,
      onVerdict: (reason) => machine.fire("BUDGET_EXHAUSTED", { reason })
    });
    const heal = null;
    const machine = createMachine(function(ev) {
      if (ev.rejected) {
        rec("MACH", "! " + ev.event + " @ " + ev.from + " rejected");
        return;
      }
      rec("MACH", ev.from + " --" + ev.event + (ev.data && ev.data.reason ? "(" + ev.data.reason + ")" : "") + "--> " + ev.to);
      if (ev.to === "live/failed") onLiveFailed(ev.data && ev.data.reason);
      if (ev.to === "live/shown" || ev.to === "live/switching") {
        if (ev.event === "READY" || ev.event === "SWITCH_READY") ledger.settle();
      }
    });
    function currentSourceId() {
      try {
        const q = new URL(LIVE_SRC, location.href).searchParams;
        return q.get("src") || "";
      } catch (e) {
        return "";
      }
    }
    function onLiveFailed(reason) {
      if (reason === "transfer") {
        const wait = machine.scheduleSoftRetry();
        if (wait != null) {
          rec("LIVEFAIL", "soft (transfer) \u2014 retry in " + wait + "ms");
          reg.timer(function() {
            if (machine.phase !== "live/failed") return;
            liveframe.reset();
            machine.fire("RETRY", { hasPoster: false });
            const mode = liveframe.applySrc(LIVE_SRC, { trans: TRANS, tspd: TSPD, apiBase: API });
            if (mode === "mount") ledger.watch(currentSourceId());
          }, wait);
          return;
        }
        reason = "transfer-exhausted";
      }
      rec("LIVEFAIL", "hard (" + reason + ") \u2014 reporting to serve");
      const id = currentSourceId();
      if (id) {
        fetch(API + "/api/live-verdict", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: id, reason })
        }).catch(function() {
        });
      }
    }
    createWatchdogs({ reg, machine, video, postAll: bridge.postAll });
    reg.on(window, "message", function(ev) {
      if (!ev.data || !ev.data.zwEvent) return;
      if (ev.data.zwEvent !== "ready") return;
      if (machine.phase === "live/loading") machine.fire("READY");
      else if (machine.phase === "live/switching") machine.fire("SWITCH_READY");
    });
    function apply(payload) {
      if (!payload) return;
      VIDEO_SRC = payload.videoSrc || "";
      LIVE_SRC = payload.liveSrc || "";
      TRANS = payload.transition === "cut" ? "cut" : payload.transition || "fade";
      TSPD = { fast: 260, normal: 600, slow: 1100 }[payload.transitionSpeed] || 600;
      VMUTED = payload.videoMuted !== false;
      VFIT = payload.fit === "contain" ? "contain" : payload.fit === "stretch" ? "fill" : "cover";
      WPIMG = payload.wallpaperDataUri || "";
      FIT = payload.fit || "cover";
      UNDERLAY = payload.livePoster || "";
      failedInfo = payload.liveFailed || null;
      if (S.cssText === payload.css && S.videoSrc === VIDEO_SRC && S.liveSrc === LIVE_SRC && S.trans === TRANS) return;
      S.cssText = payload.css;
      S.videoSrc = VIDEO_SRC;
      S.liveSrc = LIVE_SRC;
      S.trans = TRANS;
      let style = document.getElementById(MARKER + "-style");
      if (!style) {
        style = document.createElement("style");
        style.id = MARKER + "-style";
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = payload.css;
      const kind = failedInfo ? KIND.LIVE : LIVE_SRC ? KIND.LIVE : VIDEO_SRC ? KIND.VIDEO : WPIMG ? KIND.IMAGE : KIND.NONE;
      if (machine.kind !== kind) machine.fire("SET_SOURCE", { kind, hasPoster: !!failedInfo });
      let wp = wpRoot();
      if (WPIMG || VIDEO_SRC || LIVE_SRC || kind === KIND.LIVE && UNDERLAY) {
        if (!wp) {
          wp = document.createElement("div");
          wp.id = MARKER + "-wallpaper";
          document.documentElement.appendChild(wp);
        }
      } else if (wp) {
        wp.remove();
      }
      if (kind === KIND.LIVE && !failedInfo) {
        const mode = liveframe.applySrc(LIVE_SRC, { trans: TRANS, tspd: TSPD, apiBase: API, videoIncoming: false });
        if (mode === "mount") {
          if (machine.phase !== "live/loading" && machine.phase !== "live/shown" && machine.phase !== "live/switching") {
            machine.fire("SET_SOURCE", { kind: KIND.LIVE, hasPoster: false });
          }
          ledger.watch(currentSourceId());
        } else if (mode === "switch") {
          if (machine.phase !== "live/switching") machine.fire("SWITCH_BEGIN");
          ledger.watch(currentSourceId());
        }
      } else if (kind === KIND.LIVE && failedInfo) {
        liveframe.applySrc("", {});
      }
      if (kind === KIND.VIDEO) {
        video.apply(VIDEO_SRC, { muted: VMUTED, fit: VFIT });
      } else {
        video.apply("", { liveIncoming: kind === KIND.LIVE && !failedInfo });
      }
      if (kind !== KIND.VIDEO && WPIMG && wp) wp.style.backgroundImage = "url(" + WPIMG + ")";
      else if (kind !== KIND.VIDEO && wp && !LIVE_SRC && !failedInfo) wp.style.backgroundImage = "none";
      const bp = document.getElementById(MARKER + "-backdrop");
      const underlayWanted = FIT === "contain" && WPIMG || (LIVE_SRC || failedInfo) && UNDERLAY;
      if (underlayWanted) {
        let b = bp;
        if (!b) {
          b = document.createElement("div");
          b.id = MARKER + "-backdrop";
          document.documentElement.appendChild(b);
        }
        b.style.backgroundImage = "url(" + (WPIMG ? WPIMG : UNDERLAY) + ")";
        b.dataset.on = "1";
      } else if (bp) {
        bp.dataset.on = "0";
      }
      rec("APPLY", "kind=" + kind.split("/")[0] + " phase=" + machine.phase + " live=" + (LIVE_SRC ? "y" : failedInfo ? "failed" : "n") + " video=" + (VIDEO_SRC ? "y" : "n") + " img=" + (WPIMG ? "y" : "n"));
    }
    let sseHandle = null;
    function connectSse() {
      if (!window.EventSource) return;
      let es;
      try {
        es = new EventSource(API + "/api/events?client=agent");
      } catch (e) {
        return;
      }
      sseHandle = es;
      let delay = 1e3;
      es.addEventListener("cfg", function(ev) {
        try {
          apply(JSON.parse(ev.data));
        } catch (e) {
          rec("SSE", "bad payload");
        }
      });
      es.onopen = function() {
        delay = 1e3;
      };
      es.onerror = function() {
        try {
          es.close();
        } catch (e) {
        }
        if (sseHandle === es) sseHandle = null;
        const t = setTimeout(connectSse, delay);
        timers.push(t);
        delay = Math.min(3e4, delay * 3);
      };
    }
    connectSse();
    apply(window.__zwPayload);
    window.__zwTeardownAgent = function() {
      if (sseHandle) {
        try {
          sseHandle.close();
        } catch (e) {
        }
        sseHandle = null;
      }
      ledger.stop();
      timers.forEach(function(t) {
        clearTimeout(t);
        clearInterval(t);
      });
      listeners.forEach(function(l) {
        try {
          l[0].removeEventListener(l[1], l[2], l[3]);
        } catch (e) {
        }
      });
      observers.forEach(function(o) {
        try {
          o.disconnect();
        } catch (e) {
        }
      });
      [
        MARKER + "-style",
        MARKER + "-wallpaper",
        MARKER + "-backdrop",
        MARKER + "-fade",
        MARKER + "-live",
        MARKER + "-live-next",
        MARKER + "-video"
      ].forEach(function(id) {
        const n = document.getElementById(id);
        if (n) n.remove();
      });
      S.cssText = null;
      S.videoSrc = null;
      S.liveSrc = null;
      S.trans = null;
      window.__zwAgent = null;
      try {
        rec("TEARDOWN", "agent");
      } catch (e) {
      }
    };
  })();
})();
