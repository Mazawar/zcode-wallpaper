/**
 * ZCode plugin-enablement probing — is OUR plugin switched off right now?
 *
 * Three sources feed the verdict, all read best-effort (ZCode's private
 * formats, versioned only by try/catch):
 *   - the user-scope config (~/.zcode/cli/config.json)
 *   - workspace-scope configs (<workspace>/.zcode/config.json) of every
 *     workspace ZCode currently has open — the toggle has been observed
 *     writing to EITHER scope on different clicks, so the scopes can
 *     disagree, each recording a different moment of the user's intent
 *   - the install record (installed_plugins.json) for our own id, whose
 *     DISAPPEARANCE is the uninstall signal (server.ts owns that watch)
 *
 * Resolution for our own id: the NEWEST explicit entry across scopes wins —
 * write history is the only truthful precedence — and ties lean disabled
 * (safe). Without an install record (manual/CLI run) the identity is unknown
 * and the conservative fallback applies: disabled only when EVERY
 * zcode-wallpaper@* key in a scope is explicitly false.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pluginRoot } from "./paths.js";

export interface Disablement {
  scope: string;
  key: string;
}

export interface ScopeEntry {
  scope: string;
  disabled: boolean;
  mtime: number;
}

/**
 * Pure precedence rule (unit-tested by verify-enablement): the newest
 * explicit entry wins; equal mtimes lean disabled (a tie means we cannot
 * prove the newer intent, and stopping is the reversible side). Null when no
 * scope carries an entry for the id at all.
 */
export function resolveDisablement(key: string, entries: ScopeEntry[]): Disablement | null {
  if (!entries.length) return null;
  const newest = entries.reduce((a, b) => (b.mtime >= a.mtime ? b : a));
  return newest.disabled ? { scope: newest.scope, key } : null;
}

/** Reads OUR id's explicit entry from one config file, null when absent. */
export function readOwnScopeEntry(cfgPath: string, id: string): ScopeEntry | null {
  try {
    const ep = (JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { plugins?: { enabledPlugins?: Record<string, boolean> } })
      ?.plugins?.enabledPlugins;
    if (!ep || ep[id] === undefined) return null;
    return { scope: cfgPath, disabled: ep[id] === false, mtime: fs.statSync(cfgPath).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Conservative fallback (identity unknown — manual/CLI run): disabled only
 * when EVERY zcode-wallpaper@* key in this file is explicitly false.
 * Returns the triggering keys for the serve log.
 */
export function pluginDisabledKeyIn(cfgPath: string): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
      plugins?: { enabledPlugins?: Record<string, boolean> };
    };
    const ep = cfg?.plugins?.enabledPlugins;
    if (!ep || typeof ep !== "object") return null;
    const keys = Object.keys(ep).filter((k) => k.includes("zcode-wallpaper"));
    return keys.length > 0 && keys.every((k) => ep[k] === false) ? keys.join("+") : null;
  } catch {
    return null;
  }
}

/**
 * Our own `name@marketplace` id, resolved from ZCode's install records by
 * matching the install path against this plugin's root (works for cache
 * installs of any market). Null when not installed (CLI/manual run) — the
 * caller then falls back to the every-key-false rule.
 */
export function ownPluginId(): string | undefined {
  try {
    const rec = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".zcode", "cli", "plugins", "installed_plugins.json"), "utf8"),
    ) as { plugins?: Array<{ id: string; name: string; marketplace: string; installPath?: string }> };
    const hit = rec.plugins?.find((p) => p.installPath && path.resolve(pluginRoot).startsWith(path.resolve(p.installPath)));
    return hit ? hit.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The workspaces ZCode currently has open. Open workspaces are not exposed
 * anywhere official; every distinct "workspaceKey" in ZCode's log names them
 * — ALL of them, not the newest: several windows can be open at once
 * (observed: two workspaces logging interleaved) and the newest line's
 * workspace is not necessarily the one carrying the disable. Private format
 * again — best-effort, tail-only read.
 */
export function activeWorkspaceDirs(): string[] {
  try {
    const logDir = path.join(os.homedir(), ".zcode", "cli", "log");
    const files = fs.readdirSync(logDir).filter((f) => /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    if (!files.length) return [];
    const file = path.join(logDir, files[files.length - 1]);
    const stat = fs.statSync(file);
    const tail = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(tail);
    fs.readSync(fd, buf, 0, tail, stat.size - tail);
    fs.closeSync(fd);
    const out = new Set<string>();
    for (const m of buf.toString("utf8").matchAll(/"workspaceKey":"((?:[^"\\]|\\.)*)"/g)) {
      out.add(JSON.parse(`"${m[1]}"`) as string);
    }
    return [...out];
  } catch {
    return [];
  }
}

/**
 * Disablement for OUR OWN plugin id across both scopes. ZCode's client has
 * written the toggle to the user file on some clicks and to the workspace
 * file on others (both observed the same day), so the scopes can disagree —
 * each recording a different moment of the user's intent. Resolution: the
 * NEWEST explicit entry for our exact id wins (write history is the only
 * truthful precedence); ties lean disabled (safe). Without an install record
 * (manual/CLI run) the identity is unknown — fall back to the conservative
 * every-zcode-wallpaper-key-false rule.
 */
export function pluginDisabledBy(userCfgPath: string): Disablement | null {
  const ownId = ownPluginId();
  const scopes = [userCfgPath, ...activeWorkspaceDirs().map((ws) => path.join(ws, ".zcode", "config.json"))];
  if (ownId) {
    const mine = scopes.map((p) => readOwnScopeEntry(p, ownId)).filter((x): x is ScopeEntry => x !== null);
    return resolveDisablement(ownId, mine);
  }
  for (const p of scopes) {
    const key = pluginDisabledKeyIn(p);
    if (key) return { scope: p, key };
  }
  return null;
}
