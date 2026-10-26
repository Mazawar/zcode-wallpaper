// Re-parses the bootstrap template exactly as buildBootstrapScript would
// (escapes + payload.* interpolations), then node --check the result.
import fs from "node:fs";
const ts = fs.readFileSync(new URL("../src/core/cdp.ts", import.meta.url), "utf8");
const fn = ts.indexOf("return `(function(){");
const a = fn + "return `".length;
const b = ts.indexOf("`;", ts.indexOf("applyLive(LIVE_SRC)", a));
const body = ts.slice(a, b);
const fakePayload = {
  css: "/*css*/", wallpaperDataUri: "", videoSrc: "http://x/v.mp4", videoMuted: true,
  liveSrc: "", livePoster: "", fit: "cover", transition: "fade", marker: "zcode-wallpaper",
  apiPort: 28257, focusX: 0.5, focusY: 0.5,
};
const script = new Function("payload", "return `" + body + "`")(fakePayload);
fs.writeFileSync(new URL("./_boot-check.js", import.meta.url), script);
console.log("extracted", script.length, "chars");
