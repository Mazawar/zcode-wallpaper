/**
 * Live-failure memory (D6): hard failures of the live renderer persist per
 * source; payload assembly consults it and downgrades the source to
 * poster-only with a visible reason. Picking the source again (or the panel's
 * retry button) clears the memory — explicit user intent outranks memory.
 */

import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./launch.js";

export interface LiveFailure {
  reason: string;
  at: number;
}

function file(): string {
  return path.join(dataDir(), "live-failures.json");
}

export function readLiveFailures(): Record<string, LiveFailure> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, LiveFailure>;
  } catch {
    return {};
  }
}

export function liveFailureOf(sourceId: string | undefined): LiveFailure | undefined {
  if (!sourceId) return undefined;
  return readLiveFailures()[sourceId];
}

export function recordLiveFailure(sourceId: string, reason: string): void {
  if (!sourceId) return;
  const all = readLiveFailures();
  all[sourceId] = { reason, at: Date.now() };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all));
}

export function clearLiveFailure(sourceId: string | undefined): void {
  if (!sourceId) return;
  const all = readLiveFailures();
  if (!(sourceId in all)) return;
  delete all[sourceId];
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all));
}
