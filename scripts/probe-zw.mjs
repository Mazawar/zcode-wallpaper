/** Deep probe: __zw state, heartbeat flag, css, held-session evidence. */
const targets = await (await fetch("http://127.0.0.1:28256/json/list")).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("out/renderer/index.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pend = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));

const probe = `(() => {
  const zw = window.__zw;
  return JSON.stringify({
    hasZw: !!zw,
    cssTextLen: zw && zw.cssText ? zw.cssText.length : 0,
    liveSrc: zw && zw.liveSrc ? zw.liveSrc.slice(60, 110) : null,
    hb: zw ? zw.hb : null,
    styleEl: !!document.getElementById('zcode-wallpaper-style'),
    bootFlag: window.__zwSettingsBoot,
  });
})()`;
const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
console.log(r.result.value);
ws.close();
process.exit(0);
