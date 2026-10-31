/**
 * CDP probe: inspect the wallpaper agent's live state in the ZCode page —
 * why is the wallpaper not mounting while the panel is?
 */
const list = await (await fetch("http://127.0.0.1:28256/json/list")).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));

const expr = `(() => {
  const out = {};
  out.agent = !!window.__zwAgent;
  out.sse = !!(window.__zw && window.__zwLog);
  const vid = document.querySelector("video");
  out.video = vid ? {
    id: vid.id, src: (vid.getAttribute("src") || "").slice(0, 90),
    readyState: vid.readyState, paused: vid.paused, error: vid.error && vid.error.code,
    currentTime: vid.currentTime, networkState: vid.networkState,
    inDom: document.documentElement.contains(vid),
  } : null;
  const wp = document.getElementById("zcode-wallpaper-wallpaper");
  out.wpRoot = wp ? { display: getComputedStyle(wp).display, z: getComputedStyle(wp).zIndex, bg: (getComputedStyle(wp).backgroundImage || "").slice(0, 60) } : null;
  const style = document.getElementById("zcode-wallpaper-style");
  out.cssLen = style ? style.textContent.length : 0;
  out.log = (window.__zwLog || []).slice(-12);
  return JSON.stringify(out);
})()`;
const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log(res.result?.result?.value ?? JSON.stringify(res));
const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 55 });
if (shot.result?.data) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("tmp-screen.jpg", Buffer.from(shot.result.data, "base64"));
  console.log("SCREENSHOT saved tmp-screen.jpg");
}
ws.close();
process.exit(0);
