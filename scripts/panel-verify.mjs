/** One-off: inject the freshly built panel script into the live ZCode page
 *  (bypasses the not-yet-restarted serve), then screenshot both tabs. */
import fs from "node:fs";

const targets = await (await fetch("http://127.0.0.1:28256/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("out/renderer/index.html"));
if (!page) { console.error("renderer target not found"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pend = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
await send("Page.enable");
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Inject the new panel (V=17 owns the page; stale registrations retire).
const src = fs.readFileSync("scripts/_panel-inject.js", "utf8");
await evalJs("try { window.__zwSettingsBoot = undefined; } catch (e) {}"); await evalJs("(() => { var m = document.getElementById('zcode-wallpaper-settings-v6'); if (m) m.remove(); return 1; })()"); await evalJs("(() => { var st = document.getElementById('zcode-wallpaper-settings-v6-range-style'); if (st) st.remove(); return 1; })()");
const inj = await send("Runtime.evaluate", { expression: src, returnByValue: true });
if (inj.exceptionDetails) console.error("inject exception:", inj.exceptionDetails.exception?.description?.slice(0, 300));
console.log("injected");

const open = await evalJs(`(async () => {
  const onAppearance = [...document.querySelectorAll('h2')].some(h => h.offsetParent !== null && /^(外观|Appearance)$/.test(h.textContent.trim()));
  if (!onAppearance) {
    const btn = document.querySelector('button[aria-label="设置"]');
    if (btn) { btn.click(); await new Promise(r => setTimeout(r, 800)); }
    const tab = [...document.querySelectorAll('h2')].find(h => h.offsetParent !== null && /^(外观|Appearance)$/.test(h.textContent.trim()));
    if (tab) { tab.click(); await new Promise(r => setTimeout(r, 600)); }
  }
  // force our section to mount if the observer is mid-wait
  if (window.__zwPanelRefresh) window.__zwPanelRefresh();
  await new Promise(r => setTimeout(r, 900));
  const s = document.getElementById('zcode-wallpaper-settings-v6');
  if (s) s.scrollIntoView({ block: 'start' });
  return s ? 'mounted h=' + s.offsetHeight : 'NOT MOUNTED';
})()`);
console.log(open);
await sleep(1200);

const shot1 = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("scripts/_panel-lib.png", Buffer.from(shot1.data, "base64"));
await evalJs(`(() => { const b = document.querySelector('#zcode-wallpaper-settings-v6 [data-k=zwtabs] button[data-v=play]'); if (b) b.click(); return !!b; })()`);
await sleep(500);
const s2 = await evalJs(`(() => { const s = document.getElementById('zcode-wallpaper-settings-v6'); if (s) s.scrollIntoView({ block: 'start' }); return !!s; })()`);
await sleep(400);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("scripts/_panel-play.png", Buffer.from(shot2.data, "base64"));
console.log("shots written");
ws.close();
process.exit(0);
