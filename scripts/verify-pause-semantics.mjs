/**
 * Video user-pause semantics (1.0.12): a user pause must survive the kick/wake
 * watchdogs and hot-updates; only a user resume (or a fresh pick) lifts it.
 * Runs the real createVideoActor against a DOM stub — the regression it pins
 * is the one where kickVideo saw `paused && autoplay` and re-played the
 * user-paused video within 2s (panel 暂停 looked dead).
 */
import { createVideoActor } from "../live/src/agent/video.js";

// Minimal DOM stubs: enough surface for the video actor.
const elements = new Map();
class StubVideo {
  constructor() {
    this.paused = false;
    this.ended = false;
    this.error = null;
    this.autoplay = true;
    this.muted = true;
    this.currentTime = 0;
    this._listeners = {};
    this.style = { cssText: "", objectFit: "" };
    this._id = "";
    this._srcAttr = "";
  }
  set src(v) { this._srcAttr = v; }
  get src() { return this._srcAttr; }
  set id(v) { this._id = v; }
  get id() { return this._id; }
  getAttribute(n) { return n === "src" ? this._srcAttr : null; }
  setAttribute(n, v) { if (n === "src") this._srcAttr = v; }
  removeAttribute(n) { if (n === "id") this._id = ""; }
  load() { this.paused = false; } // autoplay attr restarts (per fix assumption)
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener() {}
  appendChild() {}
  remove() { elements.delete(this._id); }
}
class StubDiv {
  constructor() { this.style = {}; this.dataset = {}; }
  appendChild(c) { elements.set(c._id, c); }
}
const root = new StubDiv();
globalThis.window = {};
globalThis.document = {
  getElementById(id) { return elements.get(id) || null; },
  createElement(tag) { return new StubVideo(); },
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.clearTimeout = clearTimeout;

const reg = { timer(fn) { setTimeout(fn, 0); return 0; } };
const video = createVideoActor({ reg, rec() {}, wpRoot: () => root, onReady() {} });
const SRC = "http://x/v.mp4";

function fire(el, type) { for (const fn of el._listeners[type] || []) fn({}); }
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); }

// 1) fresh pick commits + plays
video.apply(SRC, {});
await new Promise((r) => setTimeout(r, 20));
const v1 = video.findVideo();
assert(v1 && !v1.paused, "fresh pick plays after commit");

// 2) user pause sticks; kick guard + auto wake must not resume
video.pause(true);
assert(v1.paused && video.userPaused(), "user pause pauses + flags");
assert(!(v1.paused && v1.autoplay && !video.userPaused()), "kickVideo first branch skipped when user-paused");
video.resume(); // auto wake (focus/pointerdown/visible)
assert(v1.paused, "auto wake does not resume a user-paused video");

// 3) hot-update (same src, muted/fit tweak) keeps the pause
video.apply(SRC, { muted: false, fit: "contain" });
assert(v1.paused, "hot-update keeps user pause");

// 4) user resume plays
video.resume(true);
assert(!v1.paused && !video.userPaused(), "user resume clears flag + plays");

// 5) auto-pause (hidden 1.5s) sets no flag; auto wake then resumes
video.pause();
assert(v1.paused && !video.userPaused(), "auto pause sets no flag");
video.resume();
assert(!v1.paused, "auto wake resumes an auto-paused video");

// 6) re-user-pause, then a NEW pick clears the flag and plays
video.pause(true);
video.apply("http://x/v2.mp4", {});
await new Promise((r) => setTimeout(r, 20));
const v2 = video.findVideo();
assert(v2 && v2 !== v1, "new pick mounts a fresh element");
assert(!v2.paused && !video.userPaused(), "new pick clears user pause and plays");

// 7) error self-heal under user pause re-asserts the pause after load()
v2.error = { code: 2 };
video.pause(true);
video.apply("http://x/v2.mp4", {});
assert(v2.paused, "self-heal load() re-asserts user pause");

console.log(process.exitCode ? "PAUSE SEMANTICS: FAILED" : "PAUSE SEMANTICS: ALL OK");
