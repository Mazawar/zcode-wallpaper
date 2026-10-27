/**
 * End-to-end gate for a live environment: serve running + ZCode on the CDP
 * port. Verifies the 0.3.0 injection pipeline the way a user experiences it:
 *
 *   1. serve surface     — health, agent.js/panel.js served
 *   2. page runtime      — thin bootstrap + agent + panel live in the page
 *   3. SSE config push   — POST /api/config lands as a page CSS change
 *   4. wallpaper switch  — apply-source swaps the live source, engine renders
 *   5. reset & restore   — elements removed, backup round-trips
 *   6. visual            — screenshots (inspected manually after the run)
 *
 * Usage: node scripts/e2e.mjs [--cdp 28256] [--api 28257]
 * Exits non-zero on any failure.
 */

import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const CDP = Number(flag("--cdp", 28256));
const API = `http://127.0.0.1:${flag("--api", 28257)}`;

let failures = 0;
const ok = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
};

// --- CDP plumbing -------------------------------------------------------------
const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("out/renderer/index.html"));
if (!page) {
  console.error("FAIL  no ZCode renderer target on CDP — is ZCode running with the debug port?");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 1;
const pend = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = msgId++;
    pend.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }
};
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const ev = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const s = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`scripts/e2e-${name}.png`, Buffer.from(s.data, "base64"));
};

// --- 1. serve surface -----------------------------------------------------------
{
  const health = await (await fetch(`${API}/api/health`)).json();
  ok("serve health", health.service === "zcode-wallpaper", `pid ${health.pid}`);
  for (const f of ["agent.js", "panel.js"]) {
    const r = await fetch(`${API}/${f}`);
    const text = await r.text();
    ok(`serve /${f}`, r.status === 200 && text.length > 1000, `${text.length}B`);
  }
}

// --- 2. page runtime (give the first hold a moment if serve just started) -------
await sleep(1200);
{
  const st = JSON.parse(
    await ev(`JSON.stringify({
      style: !!document.getElementById('zcode-wallpaper-style'),
      css: (document.getElementById('zcode-wallpaper-style')||{textContent:''}).textContent.length,
      agent: !!window.__zwAgent,
      agentEl: !!document.getElementById('zcode-wallpaper-agent'),
      panel: !!window.__zwPanel,
      panelEl: !!document.getElementById('zcode-wallpaper-panel'),
      bootGen: !!(window.__zw && window.__zw.bootGen),
      payload: !!window.__zwPayload,
      hb: !!(window.__zw && window.__zw.hb),
    })`)
  );
  ok("bootstrap critical css", st.style && st.css > 500, `${st.css} chars`);
  ok("agent runtime loaded", st.agent && st.agentEl);
  ok("panel runtime loaded", st.panel && st.panelEl);
  ok("registration + heartbeat", st.bootGen && st.payload && st.hb);
}

// --- 3. SSE config push ----------------------------------------------------------
{
  const ac = new AbortController();
  const events = [];
  const consume = (async () => {
    const res = await fetch(`${API}/api/events?client=e2e`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const evName = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (evName === "cfg" && data) events.push(JSON.parse(data));
      }
    }
  })();

  const before = await ev(`(document.getElementById('zcode-wallpaper-style')||{textContent:''}).textContent`);
  await fetch(`${API}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dim: 40 }),
  });
  await sleep(700);
  const cssAfter = await ev(`(document.getElementById('zcode-wallpaper-style')||{textContent:''}).textContent`);
  ok("SSE cfg event received", events.length >= 1, `${events.length} event(s)`);
  ok("config change reached page css", cssAfter !== before && cssAfter.includes("0.4"), `dim 40 → --zcode-wallpaper-dim 0.4`);
  ac.abort();
  await consume.catch(() => {});
  // restore
  await fetch(`${API}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dim: 25 }),
  }).then((r) => r.json());
}

// --- 4. wallpaper switch ----------------------------------------------------------
{
  const lib = await (await fetch(`${API}/api/wallpapers`)).json();
  const scenes = lib.wallpapers.filter((w) => w.type === "scene");
  if (scenes.length >= 2) {
    const current = lib.current;
    const target = scenes.find((w) => w.id !== current) ?? scenes[0];
    await shot("before-switch");
    const r = await (
      await fetch(`${API}/api/apply-source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: target.id }),
      })
    ).json();
    ok("apply-source accepted", r.ok && r.mediaType === "live", `-> ${r.title}`);
    // engine boot + in-place load + first frames
    await sleep(6000);
    const st = JSON.parse(
      await ev(`JSON.stringify({
        applied: window.__zw && window.__zw.appliedLive || '',
        live: !!document.getElementById('zcode-wallpaper-live'),
        engine: (window.__zwLog||[]).filter(x=>x.tag==='ENGINE').slice(-1)[0] || null,
        cfgApplied: window.__zw && window.__zw.liveSrc || '',
      })`)
    );
    ok("switch reached the page", st.live && st.applied.includes(target.id), `applied=${st.applied.slice(0, 60)}...`);
    // engine boot + first frames — heavy 4K scenes can take >6s to assemble,
    // so poll the ENGINE beacons for up to 15s instead of one snapshot.
    let engineBeacon = st.engine?.d ?? "";
    for (let i = 0; i < 9 && !/fps=[1-9]/.test(engineBeacon); i++) {
      await sleep(1000);
      engineBeacon =
        (await ev(`((window.__zwLog||[]).filter(x=>x.tag==='ENGINE').slice(-1)[0]||{d:''}).d`)) ?? "";
    }
    ok("engine renders after switch", /fps=[1-9]/.test(engineBeacon), engineBeacon || "no ENGINE beacon yet");
    await shot("after-switch");
    // switch back so the user's wallpaper survives the test run
    if (current) {
      await fetch(`${API}/api/apply-source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: current }),
      }).then((x) => x.json());
      await sleep(5000);
    }
  } else {
    ok("wallpaper switch", false, "fewer than 2 scene wallpapers in the library");
  }
}

// --- 5. reset & restore -------------------------------------------------------------
{
  const r1 = await (await fetch(`${API}/api/reset`, { method: "POST" })).json();
  await sleep(800);
  const gone = JSON.parse(
    await ev(`JSON.stringify({
      style: !!document.getElementById('zcode-wallpaper-style'),
      wp: !!document.getElementById('zcode-wallpaper-wallpaper'),
      agent: !!window.__zwAgent,
      panel: !!window.__zwPanel,
    })`)
  );
  ok(
    "reset clears wallpaper, keeps panel",
    r1.ok && !gone.style && !gone.wp && !gone.agent,
    `panel=${gone.panel} (stays mounted by design — it is serve UI)`
  );
  const r2 = await (await fetch(`${API}/api/restore`, { method: "POST" })).json();
  await sleep(3000);
  const back = JSON.parse(
    await ev(`JSON.stringify({
      style: !!document.getElementById('zcode-wallpaper-style'),
      agent: !!window.__zwAgent,
      panel: !!window.__zwPanel,
    })`)
  );
  ok("restore re-injects", r2.ok && back.style && back.agent, `panel=${back.panel} (mounts on the Appearance page)`);
  await shot("restored");
}

ws.close();
console.log(failures === 0 ? "\ne2e: ALL PASS" : `\ne2e: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
