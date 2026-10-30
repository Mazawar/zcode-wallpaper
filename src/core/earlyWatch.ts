/**
 * Early-launch serve host watchdog verdict (D27). The wrapper-started serve
 * owns the port for the whole ZCode session; the plugin host's MCP heartbeats
 * /api/host-alive every 10s. ZCode recycles its plugin-host fleet on window/
 * session churn (2026-10-30: the whole fleet was reborn while the app process
 * never restarted), so a silent host is NOT evidence of disablement — explicit
 * disable is already owned by the enablement watch (pluginDisabledBy, 5s tick
 * + fs.watch) and uninstall by the install-record watch. This verdict exits on
 * confirmed evidence only, never on silence alone.
 *
 * Dependency-free and loadable in bare Node so verify-early-watch.mjs pins
 * the semantics against the real code (same contract as live/src/state.js).
 */

export interface EarlyHostWatch {
  /** a heartbeat was seen at least once this session */
  hostSeen: boolean;
  /** epoch ms of the freshest /api/host-alive (0 = never) */
  lastHostAlive: number;
  /** epoch ms ZCode's process was last seen alive (0 = never) */
  zcodeSeenAt: number;
  /** churn already logged for the current silent episode */
  churnLogged: boolean;
}

export type EarlyHostVerdict =
  | { kind: "none" }
  /** host silent past the window while still enabled — assumed fleet churn:
   *  STAY UP (log once; heartbeats resume, a successor retires us, or ZCode
   *  exits — silence alone must never unmount the wallpaper) */
  | { kind: "churn" }
  /** host silent AND the enablement state confirms disable — the only
   *  silent-host exit that still restores default appearance */
  | { kind: "exit-restore" }
  /** ZCode gone past 60s — end of session (the wrapper respawns next launch) */
  | { kind: "exit-zcode-gone" };

/** Silence window after which a gone host becomes actionable at all. */
export const HOST_SILENT_MS = 45_000;
/** ZCode must have been seen this recently for host silence to be judged
 *  (a live ZCode is the entire point; a dead one belongs to the gone rule). */
export const ZCODE_RECENT_MS = 30_000;
/** ZCode gone this long ends the session. */
export const ZCODE_GONE_MS = 60_000;

export function earlyHostTick(w: EarlyHostWatch, now: number, disabledNow: boolean): EarlyHostVerdict {
  const hostSilent = w.hostSeen && w.lastHostAlive > 0 && now - w.lastHostAlive > HOST_SILENT_MS;
  const zcodeAlive = w.zcodeSeenAt > 0 && now - w.zcodeSeenAt < ZCODE_RECENT_MS;
  if (hostSilent && zcodeAlive) {
    if (disabledNow) return { kind: "exit-restore" };
    return w.churnLogged ? { kind: "none" } : { kind: "churn" };
  }
  if (w.zcodeSeenAt > 0 && now - w.zcodeSeenAt > ZCODE_GONE_MS) return { kind: "exit-zcode-gone" };
  return { kind: "none" };
}
