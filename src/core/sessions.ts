/**
 * CDP session management: hold one connection per ZCode renderer, register
 * the thin bootstrap + panel loader, poll for new/dead targets, and self-heal
 * drifted pages. Since config changes travel over SSE, the CDP channel here
 * carries only registration (once per hold) and the 30s heal probe — no
 * per-change traffic, so no queue to storm and no push/reload races.
 */

import {
  CdpConnection,
  buildPanelLoader,
  buildThinBootstrap,
  buildClearWallpaperScript,
  buildResetScript,
  listTargets,
  pickRendererTargets,
  type CdpTarget,
} from "./cdp.js";
import type { BeautifyConfig } from "./inject.js";
import { liveFailureOf } from "./livefail.js";
import { buildRuntimePayload } from "./payload.js";

const POLL_MS = 1500;

export interface SessionOptions {
  cdpPort: number;
  apiPort: number;
}

interface HeldSession {
  conn: CdpConnection;
  bootstrapId?: string;
  panelId?: string;
}

const held = new Map<string, HeldSession>();

export function heldWindowCount(): number {
  return held.size;
}

/** Races a promise against a timeout — a half-dead socket can otherwise leave
 *  an await pending forever (no close event), wedging the heal loop. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))]);
}

async function bootstrapScriptFor(config: BeautifyConfig, apiPort: number): Promise<string> {
  // Boot correctness beats boot latency: the FIRST push on a fresh page must
  // include the Monet/transparency overrides or the app's opaque surfaces
  // cover the wallpaper. Decode on demand here (cached across holds, so it
  // costs one decode per capture).
  const payload = await buildRuntimePayload(config, true);
  return buildThinBootstrap(payload, {
    apiPort,
    gen: Date.now(),
    agent: { src: `http://127.0.0.1:${apiPort}/agent.js` },
  });
}

async function holdSession(
  target: { id: string; title: string; webSocketDebuggerUrl?: string },
  config: BeautifyConfig,
  apiPort: number
): Promise<void> {
  if (!target.webSocketDebuggerUrl) return;
  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl);
  await conn.send("Page.enable");
  // The live renderer iframe loads from http://127.0.0.1; a restrictive CSP on
  // the host page must not be able to block it.
  await conn.send("Page.setBypassCSP", { enabled: true }).catch(() => undefined);

  const bootstrap = await bootstrapScriptFor(config, apiPort);
  const { identifier: bootstrapId } = await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
  await conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true });

  const panel = buildPanelLoader(apiPort);
  const { identifier: panelId } = await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: panel });
  await conn.send("Runtime.evaluate", { expression: panel, returnByValue: true });

  held.set(target.id, { conn, bootstrapId, panelId });
}

async function poll(config: BeautifyConfig, apiPort: number): Promise<void> {
  try {
    const targets = pickRendererTargets(await listTargets(config.port));
    const current = new Set(targets.map((t) => t.id));
    for (const t of targets) {
      if (!held.has(t.id)) {
        try {
          await holdSession(t, config, apiPort);
          console.log(`serve: panel + wallpaper runtime injected into "${t.title}" (${t.id})`);
        } catch {
          /* retry next tick */
        }
      }
    }
    for (const id of [...held.keys()]) {
      if (!current.has(id)) {
        held.get(id)!.conn.close();
        held.delete(id);
      }
    }
  } catch {
    /* CDP not reachable; keep polling */
  }
}

/**
 * Clears the wallpaper layer in every held page (the settings panel stays)
 * and unregisters the bootstrap so a reload doesn't bring the wallpaper back.
 * Sessions stay held. Used by /api/reset.
 */
export async function resetSessions(): Promise<void> {
  for (const [id, session] of held) {
    try {
      await session.conn.send("Runtime.evaluate", { expression: buildClearWallpaperScript() });
      if (session.bootstrapId) {
        await session.conn
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.bootstrapId })
          .catch(() => {});
        session.bootstrapId = undefined;
      }
    } catch {
      session.conn.close();
      held.delete(id);
    }
  }
}

/**
 * Re-arms the wallpaper bootstrap on every held page: fresh registration
 * (so reloads replay the CURRENT payload) + immediate evaluate. Used by
 * /api/restore after a reset cleared the registration, and harmless at any
 * other time (generation supersession + instance guards make it idempotent).
 */
export async function rearmSessions(config: BeautifyConfig, apiPort: number): Promise<void> {
  const bootstrap = await bootstrapScriptFor(config, apiPort).catch(() => undefined);
  if (!bootstrap) return;
  for (const [id, session] of held) {
    try {
      if (session.bootstrapId) {
        await session.conn
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.bootstrapId })
          .catch(() => {});
      }
      const { identifier } = await session.conn.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrap });
      session.bootstrapId = identifier;
      await session.conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true });
    } catch {
      session.conn.close();
      held.delete(id);
    }
  }
}

/**
 * Graceful shutdown: restore ZCode's default appearance (reset injection,
 * unregister page scripts), close held CDP sessions. Called by the hosting
 * MCP process when ZCode closes its stdio pipe (plugin disabled / app
 * closing) — the event-driven lifecycle exit.
 */
export async function shutdownSessions(): Promise<void> {
  for (const [, session] of held) {
    try {
      await session.conn.send("Runtime.evaluate", { expression: buildResetScript() });
      if (session.bootstrapId) {
        await session.conn.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.bootstrapId }).catch(() => {});
      }
      if (session.panelId) {
        await session.conn.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.panelId }).catch(() => {});
      }
      session.conn.close();
    } catch {
      /* already gone */
    }
  }
  held.clear();
}

/**
 * The serve's main loop: poll for renderer targets every 1.5s; every ~30s
 * compare each held page against the expected injection (wallpaper layer /
 * live iframe / css present when configured). Any mismatch — heartbeat
 * misfire, page-side race, manual DOM tampering, a runtime whose script
 * failed to load — re-evaluates the bootstrap, which rebuilds exactly what is
 * missing (the agent loader re-arms a dead runtime through its instance
 * flag). Every tick races a timeout: a half-dead CDP socket can leave an
 * await pending FOREVER (no close event ever fires), which wedges this loop
 * while /api/health stays green. One bad tick must never kill or wedge the
 * loop. Never resolves.
 */
export async function startSessionLoop(
  getConfig: () => BeautifyConfig,
  apiPort: number
): Promise<never> {
  await withTimeout(poll(getConfig(), apiPort), 20_000).catch((err) =>
    console.error(`serve: initial poll failed — ${(err as Error).message}`),
  );
  let healTick = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    await withTimeout(poll(getConfig(), apiPort), 20_000).catch((err) =>
      console.error(`serve: poll tick failed — ${(err as Error).message}`),
    );
    if (++healTick % 20 !== 0) continue;
    const config = getConfig();
    const wantLayer = config.wallpaperVisible && Boolean(config.live || config.sceneVideoUrl || config.wallpaperPath);
    // A hard-failed source is DELIBERATELY downgraded to poster-only with no
    // engine iframe (D6) — demanding one anyway made every heal tick re-inject
    // the bootstrap, forever, while the user stared at the poster.
    const degraded = Boolean(config.live && liveFailureOf(config.live.sourceId));
    const wantLive = config.wallpaperVisible && config.mediaType === "live" && !degraded;
    const bootstrap = await bootstrapScriptFor(config, apiPort).catch(() => null);
    if (!bootstrap) continue;
    for (const [id, session] of held) {
      try {
        const r = (await withTimeout(
          session.conn.send("Runtime.evaluate", {
            expression: `JSON.stringify({layer:!!document.getElementById('zcode-wallpaper-wallpaper'),live:!!document.getElementById('zcode-wallpaper-live'),css:!!document.getElementById('zcode-wallpaper-style'),stale:!!(window.__zw&&window.__zw.cssText)})`,
            returnByValue: true,
          }),
          8_000,
        )) as { result?: { value?: string } };
        const st = JSON.parse(r?.result?.value ?? "{}");
        const broken =
          (wantLayer && !st.layer) ||
          (wantLive && !st.live) ||
          (!wantLayer && st.layer) ||
          !st.css ||
          !st.stale; // page never received an injection (fresh reload race)
        if (broken) {
          await withTimeout(
            session.conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true }),
            8_000,
          );
          console.log(`serve: self-heal re-injected window ${id}`);
        }
      } catch (err) {
        // timeout or dead socket — drop the stale session so poll() re-holds it
        console.error(`serve: heal tick dropped session ${id} — ${(err as Error).message}`);
        held.delete(id);
        try {
          session.conn.close();
        } catch {
          /* already gone */
        }
      }
    }
  }
}
