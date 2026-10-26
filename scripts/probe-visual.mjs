/** Probe current visual state of the wallpaper layer. */
const targets = await (await fetch("http://127.0.0.1:28256/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("out/renderer/index.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pend = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));

const probe = `(() => {
  const s = document.getElementById('zcode-wallpaper-settings-v6');
  const ifr = document.getElementById('zcode-wallpaper-live');
  const wp = document.getElementById('zcode-wallpaper-wallpaper');
  const canvas = ifr && ifr.contentDocument ? ifr.contentDocument.querySelector('#wp canvas') : null;
  return JSON.stringify({
    panelOnScreen: !!s,
    settingsOpen: [...document.querySelectorAll('h2')].some(h => h.offsetParent !== null && /^(外观|Appearance)$/.test(h.textContent.trim())),
    iframeOpacity: ifr ? ifr.style.opacity : 'none',
    iframeRect: ifr ? Math.round(ifr.getBoundingClientRect().width) + 'x' + Math.round(ifr.getBoundingClientRect().height) : 'none',
    wpZ: wp ? getComputedStyle(wp).zIndex : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  });
})()`;
const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
console.log(r.result.value);
ws.close();
process.exit(0);
