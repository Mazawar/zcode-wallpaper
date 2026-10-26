/** Read both black boxes: page recorder (via CDP) + serve log (/api/log). */
const targets = await (await fetch("http://127.0.0.1:28256/json/list")).json();
const page = targets.find(t => t.type === "page" && t.url.includes("out/renderer/index.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1; const pend = new Map();
const send = (m, p = {}) => new Promise(r => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const r = await send("Runtime.evaluate", { expression: "JSON.stringify(window.__zwBB || window.__zwLog || [])", returnByValue: true });
const pageLog = JSON.parse(r.result?.value || "[]");
ws.close();
let serveLog = [];
try { serveLog = (await (await fetch("http://127.0.0.1:28257/api/log")).json()).log || []; } catch {}
console.log("=== PAGE (" + pageLog.length + " entries, last 40) ===");
pageLog.slice(-40).forEach(l => console.log(l.t, l.tag, l.d));
console.log("=== SERVE (" + serveLog.length + " lines, last 15) ===");
serveLog.slice(-15).forEach(l => console.log(l));
