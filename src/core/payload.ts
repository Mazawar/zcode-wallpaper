/**
 * Runtime payload assembly: the single object both injection paths consume.
 *
 * The page-side runtime (live/agent.js) receives exactly this shape — from the
 * embedded `window.__zwPayload` head start in the thin bootstrap, then kept
 * current over SSE. One shape, one applier, no divergence between what a fresh
 * reload gets and what a live push gets.
 */

import {
  buildLiveUrl,
  buildPayload,
  type BeautifyConfig,
  type BuiltPayload,
} from "./inject.js";
import { getAssets, getLastGoodAssets } from "./assets.js";
import { liveFailureOf } from "./livefail.js";

export async function buildRuntimePayload(config: BeautifyConfig, allowDecode = true): Promise<BuiltPayload> {
  const assets = (await getAssets(config, allowDecode)) ?? getLastGoodAssets();
  const payload: BuiltPayload = buildPayload(config, assets, {
    liveUrl: buildLiveUrl(config),
  });
  payload.apiPort = config.apiPort;
  // D6 downgrade: a source with a hard live failure renders poster-only —
  // the agent stays in the poster phase and the panel shows the reason.
  const failure = liveFailureOf(config.live?.sourceId);
  if (failure && payload.liveSrc) {
    payload.liveSrc = undefined;
    payload.liveFailed = failure;
  }
  return payload;
}
