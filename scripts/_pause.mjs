import fs from "node:fs";
const targets = await (await fetch("http://127.0.0.1:28256/json/list")).json();
const page = targets.find(t => t.type === "page" && t.url.includes("out/renderer/index.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1; const pend = new Map();
const send = (m, p = {}) => new Promise(r => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Page.enable");
const shot = async (name) => { const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync("scripts/_p" + name + ".png", Buffer.from(s.data, "base64")); };
// sample a pixel from the live iframe canvas region to check "blank vs content"
const pixel = async () => {
  const r = await send("Runtime.evaluate", { expression: `(() => {
    const f = document.getElementById('zcode-wallpaper-live');
    if (!f) return 'noframe';
    // read a 1x1 pixel through a 2d canvas snapshot of the region — cross-origin iframe blocks getImageData,
    // so instead use CDP screencast? cheaper: check the iframe's internal canvas via its own target is complex.
    // Fallback heuristic: none. Just return frame presence.
    return f.style.opacity;
  })()`, returnByValue: true });
  return r.result && r.result.value;
};
await shot("before");
// PAUSE the live renderer
await send("Runtime.evaluate", { expression: `(() => { const f = document.getElementById('zcode-wallpaper-live'); try { f.contentWindow.postMessage({ zw: 'pause' }, '*'); } catch (e) {} return 'paused'; })()`, returnByValue: true });
await new Promise(r => setTimeout(r, 1800));
await shot("paused");
// RESUME
await send("Runtime.evaluate", { expression: `(() => { const f = document.getElementById('zcode-wallpaper-live'); try { f.contentWindow.postMessage({ zw: 'resume' }, '*'); } catch (e) {} return 'resumed'; })()`, returnByValue: true });
await new Promise(r => setTimeout(r, 2500));
await shot("resumed");
console.log("shots: before/paused/resumed");
ws.close(); process.exit(0);
