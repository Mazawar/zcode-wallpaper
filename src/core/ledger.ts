/**
 * Transfer ledger (D7): per-source byte accounting for the live load phase,
 * so "still downloading" is never misread as "failing to render".
 *
 * Session-scoped (since serve start), keyed sourceId → relPath. Range and
 * suffix requests extend `requested`; 304 revalidations count as fully
 * received (the client already holds the file — see media.ts).
 */

interface FileAccount {
  requested: number;
  received: number;
  lastAt: number;
}

const accounts = new Map<string, Map<string, FileAccount>>();

function account(sourceId: string, rel: string): FileAccount {
  let files = accounts.get(sourceId);
  if (!files) {
    files = new Map();
    accounts.set(sourceId, files);
  }
  let a = files.get(rel);
  if (!a) {
    a = { requested: 0, received: 0, lastAt: 0 };
    files.set(rel, a);
  }
  return a;
}

export function transferBegin(sourceId: string, rel: string, start: number, end: number): void {
  const a = account(sourceId, rel);
  a.requested = Math.max(a.requested, end + 1);
  a.lastAt = Date.now();
}

export function transferChunk(sourceId: string, rel: string, n: number): void {
  const a = account(sourceId, rel);
  a.received = Math.min(a.requested, a.received + n);
  a.lastAt = Date.now();
}

export interface TransferSnapshot {
  bytes: number;
  total: number;
  /** Every requested file fully delivered (304s included). */
  complete: boolean;
  lastAt: number;
}

export function transferSnapshot(sourceId: string): TransferSnapshot {
  const files = accounts.get(sourceId);
  if (!files || files.size === 0) return { bytes: 0, total: 0, complete: false, lastAt: 0 };
  let bytes = 0;
  let total = 0;
  let lastAt = 0;
  let complete = true;
  for (const a of files.values()) {
    bytes += a.received;
    total += a.requested;
    lastAt = Math.max(lastAt, a.lastAt);
    if (a.received < a.requested) complete = false;
  }
  return { bytes, total, complete, lastAt };
}
