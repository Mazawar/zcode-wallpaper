/** One-off: capture a screenshot of the live ZCode renderer via CDP. */
import fs from "node:fs";

const port = Number(process.argv[2] ?? 28256);
const out = process.argv[3] ?? "zcode-shot.jpg";

const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const targets = await res.json();
const page = targets.find((t) => t.type === "page" && t.url.includes("out/renderer/index.html"));
if (!page) {
  console.error("ZCode renderer target not found");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
});
await new Promise((r, j) => {
  ws.addEventListener("open", r);
  ws.addEventListener("error", j);
});
await send("Page.enable");
const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`saved ${out} (${Math.round(shot.data.length / 1024)} KB)`);
ws.close();
process.exit(0);
