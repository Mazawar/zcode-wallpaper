/** Inject a standalone flight recorder into the live ZCode page (no restart
 *  needed) — watches our elements' lifecycle, visibility, engine messages and
 *  layer mutations into a ring buffer readable via CDP. */
const REC = `(() => {
  if (window.__zwBB) return 'already installed';
  const M = 'zcode-wallpaper';
  window.__zwBB = [];
  const rec = (tag, d) => {
    try {
      window.__zwBB.push({ t: new Date().toISOString().slice(11, 23), tag, d: d === undefined ? "" : String(d).slice(0, 160) });
      if (window.__zwBB.length > 800) window.__zwBB.shift();
    } catch (e) {}
  };
  window.__zwBBRec = rec;
  rec("BOOT", "recorder installed");
  const isMine = (n) => n && n.id && String(n.id).indexOf(M) === 0;
  new MutationObserver((muts) => {
    for (const mu of muts) {
      if (mu.removedNodes) for (const n of mu.removedNodes) if (isMine(n)) rec("REMOVE", n.id + " @ " + (mu.target.id || mu.target.tagName));
      if (mu.addedNodes) for (const n of mu.addedNodes) if (isMine(n)) rec("ADD", n.id);
      if (mu.type === "attributes" && isMine(mu.target)) rec("ATTR", mu.target.id + "." + mu.attributeName);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "src"] });
  document.addEventListener("visibilitychange", () => rec("VIS", document.hidden ? "hidden" : "visible"));
  window.addEventListener("message", (ev) => { if (ev.data && ev.data.zwEvent) rec("MSG", ev.data.zwEvent); });
  window.addEventListener("error", (e) => rec("PAGEERR", (e.message || "") + " @" + (e.lineno || 0)));
  const healthPoll = setInterval(() => {
    fetch("http://127.0.0.1:28257/api/health", { signal: AbortSignal.timeout(2500) })
      .then((r) => r.json())
      .then((b) => { if (!b || b.service !== "zcode-wallpaper") throw 0; rec("HB", "ok pid " + (b && b.pid)); })
      .catch((e) => rec("HB", "FAIL " + (e && e.name === "TimeoutError" ? "timeout" : "refused")));
  }, 5000);
  return "recorder installed";
})()`;
const targets = await (await fetch("http://127.0.0.1:28256/json/list")).json();
const page = targets.find(t => t.type === "page" && t.url.includes("out/renderer/index.html"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1; const pend = new Map();
const send = (m, p = {}) => new Promise(r => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const r = await send("Runtime.evaluate", { expression: REC, returnByValue: true });
console.log("blackbox:", r.result && r.result.value);
ws.close(); process.exit(0);
