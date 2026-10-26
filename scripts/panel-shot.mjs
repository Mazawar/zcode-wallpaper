/** One-off: open Settings→Appearance in the live ZCode window, screenshot the
 *  wallpaper panel, dump its HTML, and probe which CSS vars/classes exist. */
import fs from "node:fs";

const port = Number(process.argv[2] ?? 28256);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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

const open = await evalJs(`(async () => {
  // already on the appearance tab?
  const onAppearance = [...document.querySelectorAll('h2')].some(h => h.offsetParent !== null && /^(外观|Appearance)$/.test(h.textContent.trim())) && document.getElementById('zcode-wallpaper-settings-v6');
  if (onAppearance) return 'already';
  const btn = document.querySelector('button[aria-label="设置"]');
  if (!btn) return 'no-settings-btn';
  btn.click();
  await new Promise(r => setTimeout(r, 800));
  const tab = [...document.querySelectorAll('h2')].find(h => h.offsetParent !== null && /^(外观|Appearance)$/.test(h.textContent.trim()));
  if (!tab) return 'no-appearance-h2';
  tab.click();
  await new Promise(r => setTimeout(r, 600));
  return 'opened';
})()`);
console.log('open:', open);
await sleep(700);

const state = await evalJs(`(() => {
  const s = document.getElementById('zcode-wallpaper-settings-v6');
  if (!s) return JSON.stringify({ panel: false, onAppearance: [...document.querySelectorAll('h2')].some(h => h.offsetParent !== null && /^(外观|Appearance)$/.test(h.textContent.trim())) });
  s.scrollIntoView({ block: 'start' });
  return JSON.stringify({ panel: true, rect: s.getBoundingClientRect().toJSON(), h: s.offsetHeight });
})()`);
console.log('panel:', state);

// CSS capability probe: do the CSS vars and utility classes I used actually exist?
const caps = await evalJs(`(() => {
  const vars = {};
  const cs = getComputedStyle(document.documentElement);
  ['--color-primary','--color-foreground','--color-foreground-subtle','--color-menu-hover','--color-input','--color-background','--color-border','--color-card','--color-primary-foreground','--color-input-border','--color-input-border-hover','--color-input-border-focused','--color-menu','--color-popover-border','--color-accent','--radius-lg'].forEach(v => { vars[v] = cs.getPropertyValue(v).trim() || null; });
  const cls = {};
  const test = (name, prop) => {
    const a = document.createElement('div'), b = document.createElement('div');
    a.className = name; a.style.position = 'absolute'; a.style.visibility = 'hidden';
    document.body.appendChild(a); document.body.appendChild(b);
    cls[name] = getComputedStyle(a)[prop] !== getComputedStyle(b)[prop];
    a.remove(); b.remove();
  };
  test('bg-input','backgroundColor'); test('bg-menu-hover','backgroundColor'); test('bg-card','backgroundColor');
  test('border-border','borderTopColor'); test('border-input-border','borderTopColor'); test('border-input-border-focused','borderTopColor'); test('border-transparent','borderTopColor');
  test('text-foreground','color'); test('text-foreground-subtle','color'); test('text-foreground-subtlest','color');
  test('font-medium','fontWeight'); test('font-semibold','fontWeight');
  test('text-ui-lg','fontSize'); test('text-ui-base','fontSize'); test('text-sm','fontSize'); test('text-xs','fontSize');
  test('rounded-lg','borderTopLeftRadius'); test('rounded-md','borderTopLeftRadius'); test('rounded-full','borderTopLeftRadius');
  test('h-7','height'); test('h-8','height'); test('h-9','height'); test('px-3','paddingLeft'); test('p-1','padding'); test('p-px','padding');
  test('inline-flex','display'); test('grid','display'); test('grid-cols-2','display');
  test('gap-1','columnGap'); test('gap-2','columnGap');
  test('flex-1','flexGrow'); test('truncate','textOverflow'); test('object-cover','objectFit');
  test('bg-primary','backgroundColor'); test('accent-[var(--color-primary,#7aa2f7)]','accentColor');
  return JSON.stringify({ vars, cls });
})()`);
fs.writeFileSync("scripts/_caps.json", caps);
console.log('caps written');

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("scripts/_panel.png", Buffer.from(shot.data, "base64"));
console.log("screenshot: scripts/_panel.png");

// Section HTML (trimmed) for structural review
const html = await evalJs(`(() => { const s = document.getElementById('zcode-wallpaper-settings-v6'); return s ? s.outerHTML.slice(0, 6000) : ''; })()`);
fs.writeFileSync("scripts/_panel.html", html);
ws.close();
process.exit(0);
