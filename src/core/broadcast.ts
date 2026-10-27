/**
 * Server-sent-events hub: how config changes reach the injected page runtimes.
 *
 * Every page holds one EventSource to /api/events; serve publishes the built
 * runtime payload on change. This replaces per-change CDP evaluates — the
 * slider-storm queue saturation, the evaluate/re-register race and the
 * bare-css push windows all had their root in re-evaluating a generated script
 * through CDP on every mutation. The CDP channel now carries only
 * registration (once per hold) and the 30s heal probe.
 */

import http from "node:http";
import type { BeautifyConfig } from "./inject.js";
import { buildRuntimePayload } from "./payload.js";

export class SseHub {
  private clients = new Set<http.ServerResponse>();

  /** Upgrades a request to an event stream and sends the current payload. */
  subscribe(req: http.IncomingMessage, res: http.ServerResponse, initial?: unknown): void {
    try {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });
      res.write(": zw\n\n");
    } catch {
      return; // client vanished mid-handshake
    }
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
    res.on("error", () => this.clients.delete(res));
    if (initial !== undefined) this.send(res, "cfg", initial);
  }

  private send(res: http.ServerResponse, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }

  publish(event: string, data: unknown): void {
    for (const res of [...this.clients]) this.send(res, event, data);
  }

  get size(): number {
    return this.clients.size;
  }
}

export const hub = new SseHub();

/** The payload subscribers connected last; null until the first build. */
let currentPayload: Awaited<ReturnType<typeof buildRuntimePayload>> | undefined;

export function currentRuntimePayload() {
  return currentPayload;
}

/**
 * Builds the payload for `config` and broadcasts it to every connected page
 * runtime. `allowDecode=false` skips a cold image decode: the fast first push
 * of a wallpaper switch uses it, the decoded palette follows in a second
 * publish (same two-phase contract the CDP pushes had).
 */
export async function publishConfig(config: BeautifyConfig, allowDecode = true): Promise<void> {
  const payload = await buildRuntimePayload(config, allowDecode);
  currentPayload = payload;
  hub.publish("cfg", payload);
}
