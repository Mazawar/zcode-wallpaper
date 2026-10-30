/**
 * Port pool + session discovery (D29). The two fixed ports (CDP 28256, API
 * 28257) become "preferred" slots inside an interleaved pool: CDP walks the
 * even ports 28256..28274, API the odd ports 28257..28275 — the even/odd
 * partition makes a CDP↔API collision impossible even when both walk.
 *
 * Three consumers coordinate through two files in the data dir:
 *   zw-launch.json  — session discovery (cdpPort/apiPort merged into the
 *                     wrapper meta): read by the MCP host, CLI and status
 *                     surfaces; rewritten by every pickPorts serve at boot.
 *   zw-ports.txt    — boot handshake for the launch wrappers (flat text, VBS-
 *                     parseable: wscript reads non-BOM files as ANSI, so this
 *                     file must stay pure ASCII): the wrapper DELETES it
 *                     before spawning the serve, the serve writes it after
 *                     picking ports, the wrapper polls for it (~4s) and
 *                     launches ZCode with the handshake CDP port — falling
 *                     back to the baked literal when it never shows up, so a
 *                     wrapper can still never block or misdirect a launch.
 *
 * Explicit `--port/--api-port` (dev verification, second instances) bypass
 * all of this — the 1.0.6 guard stays: only wrapper/host-launched serves
 * (pickPorts) walk and write discovery.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { dataDir } from "./launch.js";

/** First (preferred) port of the pool — the historical fixed CDP port.
 *  ZW_PORT_BASE shifts the whole pool (constrained environments; the guard
 *  uses it to test the walk hermetically on a machine whose real ports are
 *  live). Must stay even so the even/odd partition holds. */
export function portBase(): number {
  const env = Number(process.env.ZW_PORT_BASE);
  return Number.isFinite(env) && env >= 1024 && env % 2 === 0 ? env : 28256;
}
/** How many even/odd slots each pool holds (base..base+2*(size-1)). */
export const PORT_POOL_SIZE = 10;

/** CDP pool, preferred slot first when it belongs to the pool. */
export function cdpCandidates(preferred?: number): number[] {
  const pool = Array.from({ length: PORT_POOL_SIZE }, (_, i) => portBase() + 2 * i);
  return orderPreferred(pool, preferred);
}

/** API pool (odd), preferred slot first. */
export function apiCandidates(preferred?: number): number[] {
  const pool = Array.from({ length: PORT_POOL_SIZE }, (_, i) => portBase() + 1 + 2 * i);
  return orderPreferred(pool, preferred);
}

function orderPreferred(pool: number[], preferred?: number): number[] {
  if (preferred === undefined || !pool.includes(preferred)) return pool;
  return [preferred, ...pool.filter((p) => p !== preferred)];
}

/** True when nothing listens on the port right now (bind-and-release probe).
 *  Resolves only after the probe socket is FULLY released — the caller's real
 *  listen() follows immediately, and on Windows a still-closing socket hands
 *  back EADDRINUSE. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let free = false;
    const finish = () => resolve(free);
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      free = true;
      srv.close(() => finish());
    });
    // A listening socket must accept instantly; this only fires on wedged
    // stacks — resolve "busy" and let the walk move on.
    setTimeout(() => {
      if (free) return; // normal path owns the resolution
      try {
        srv.close();
      } catch {
        /* never opened */
      }
      finish();
    }, 600).unref();
  });
}

/** True when the port answers like a CDP debug endpoint (our ZCode or a
 *  foreign debugger — either way injection can talk to it). */
export async function cdpResponds(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(900) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Pick the session CDP port: free → take it; a live debug endpoint → take it
 * (at host-spawn time ZCode has already bound the boot-chosen port — that IS
 * the session truth); TCP-busy non-CDP (a foreign app squatting the slot) →
 * next candidate. Never throws: if every slot is busy-non-CDP the preferred
 * port is returned and the cdp-absent watchdog reports the situation.
 */
export async function pickCdpPort(preferred?: number): Promise<number> {
  const cands = cdpCandidates(preferred);
  for (const c of cands) {
    if (await isPortFree(c)) return c;
    if (await cdpResponds(c)) return c;
  }
  return preferred ?? cands[0];
}

// --- discovery ------------------------------------------------------------------

export interface SessionPorts {
  cdpPort?: number;
  apiPort?: number;
  /** Epoch ms of the last write (informational). */
  at?: number;
}

/** The wrapper meta json doubles as session discovery (same file the
 *  shortcut-recovery logic reads zcode/node/cli from — merged, never replaced). */
function discoveryPath(): string {
  return path.join(dataDir(), "zw-launch.json");
}
function handshakePath(): string {
  return path.join(dataDir(), "zw-ports.txt");
}

export function readSessionPorts(): SessionPorts {
  try {
    const meta = JSON.parse(fs.readFileSync(discoveryPath(), "utf8")) as Record<string, unknown>;
    const out: SessionPorts = {};
    if (typeof meta.cdpPort === "number" && meta.cdpPort > 0) out.cdpPort = meta.cdpPort;
    if (typeof meta.apiPort === "number" && meta.apiPort > 0) out.apiPort = meta.apiPort;
    if (typeof meta.at === "number") out.at = meta.at;
    return out;
  } catch {
    return {};
  }
}

/** Merge the session ports into the discovery meta + write the flat boot
 *  handshake. Best-effort: an unwritable data dir degrades to the baked
 *  fallback ports, never to a failed boot. */
export function writeSessionPorts(cdpPort: number, apiPort: number): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(fs.readFileSync(discoveryPath(), "utf8")) as Record<string, unknown>;
    } catch {
      /* fresh dir */
    }
    meta.cdpPort = cdpPort;
    meta.apiPort = apiPort;
    meta.at = Date.now();
    fs.writeFileSync(discoveryPath(), JSON.stringify(meta, null, 1));
    // Flat, ASCII-only, VBS-parseable: two "key=number" lines, nothing else.
    fs.writeFileSync(handshakePath(), `cdp=${cdpPort}\r\napi=${apiPort}\r\n`, "utf8");
  } catch {
    /* best effort */
  }
}

/** Parses the boot handshake back (used by status surfaces and the guard). */
export function readHandshake(): SessionPorts {
  try {
    const text = fs.readFileSync(handshakePath(), "utf8");
    const out: SessionPorts = {};
    const cdp = /^cdp=(\d+)/m.exec(text);
    const api = /^api=(\d+)/m.exec(text);
    if (cdp) out.cdpPort = Number(cdp[1]);
    if (api) out.apiPort = Number(api[1]);
    return out;
  } catch {
    return {};
  }
}
