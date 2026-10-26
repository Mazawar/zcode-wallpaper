const targets = await (await fetch("http://127.0.0.1:28256/json/list")).json();
const page = targets.find(t => t.type === "page" && t.url.includes("out/renderer/index.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1; const pend = new Map();
const send = (m, p = {}) => new Promise(r => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const snap = async (tag) => {
  const r = await send("Runtime.evaluate", { expression: `(() => {
    const ov = document.getElementById('zcode-wallpaper-fade');
    const f = document.getElementById('zcode-wallpaper-live');
    return (ov ? 'OV(src ' + (ov.src.startsWith('data') ? 'data:' + ov.src.length : ov.src.slice(30, 60)) + ',op ' + ov.style.opacity + ')' : 'OV-') + ' ' + (f ? 'F(op ' + getComputedStyle(f).opacity + ')' : 'F-');
  })()`, returnByValue: true });
  console.log(tag, r.result && r.result.value);
};
const apply = (id2) => fetch("http://127.0.0.1:28257/api/apply-source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: id2 }) });
await apply("ws-1375031246"); // Sunset scene (different from current ponytail)
for (let t = 0; t <= 5; t++) { await snap("t" + t + ":"); await new Promise(r => setTimeout(r, 500)); }
for (let t = 6; t <= 10; t++) { await snap("t" + t + ":"); await new Promise(r => setTimeout(r, 1000)); }
ws.close(); process.exit(0);
