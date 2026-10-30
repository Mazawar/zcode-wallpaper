# 守卫地图（生成物，勿手改）

> 由 `node scripts/verify-guard-map.mjs --write` 从 [scripts/guards.json](../scripts/guards.json) 重算；`verify-guard-map.mjs` 会重算并逐字比对。
> **怎么用**：改了某个文件，在「文件 → 守卫」表里查该跑哪几条。守卫一律 `node scripts/<id>` 运行（e2e 除外，见其 what）。

守卫 7 个 · 覆盖文件 20 个

## 守卫 → 文件

| 守卫 | 校验什么 | 覆盖文件 |
|---|---|---|
| `verify-live-machine.mjs` | 状态机不变量：转移表完整可达、每个事件有消费者或显式保留、失败策略边界、state.js 纯净性（零 DOM） | `live/src/state.js` `live/src/agent/main.js` `live/src/agent/ledger.js` `live/src/agent/watchdogs.js` `docs/STATE.md` |
| `verify-contracts.mjs` | 双向对账：SSE 事件 产出↔消费；面板写入键 ⊆ sanitize 白名单 ⊆ publicConfig 键；agent 读取的 payload 字段 ⊆ 构建方字段 | `src/core/broadcast.ts` `src/core/server.ts` `src/core/configApi.ts` `src/core/inject.ts` `src/core/payload.ts` `live/src/agent/main.js` `live/src/panel/main.js` |
| `verify-guard-map.mjs` | 守卫地图是生成物：guards.json → docs/GUARD-MAP.md 逐字一致，表内文件全部存在 | `scripts/guards.json` `docs/GUARD-MAP.md` |
| `e2e.mjs` | 端到端闸门（需 serve 运行中 + ZCode 带 CDP）：注入、SSE 推送、切换、重置/还原全链路断言 | `src/core/cdp.ts` `src/core/sessions.ts` `src/core/inject.ts` `live/src/agent/main.js` `live/src/panel/main.js` |
| `panel-check.mjs` | 构建产物完整性：live/agent.js + live/panel.js 可解析、生命周期/SSE/挂载/回退契约标记在位 | `live/src/panel/controls.js` `live/src/panel/main.js` `live/src/agent/main.js` `live/agent.js` `live/panel.js` |
| `verify-pause-semantics.mjs` | 视频用户暂停语义：用户暂停压过 kick/wake 看门狗与热更新，仅用户恢复或换新视频解除（DOM 桩上跑真实 actor） | `live/src/agent/video.js` `live/src/agent/watchdogs.js` |
| `verify-early-watch.mjs` | 早启 serve 宿主看门狗语义：宿主静默≠禁用（宿主舰队换血不拆壁纸，仅显式禁用确证才 restore 退出；ZCode 消失 60s 结束会话）——esbuild 现场打包真实 earlyWatch 源跑全场景 + 钉死 server 接线（盲退日志行不得回归） | `src/core/earlyWatch.ts` `src/core/server.ts` |

## 文件 → 守卫

| 文件 | 守卫 |
|---|---|
| `docs/GUARD-MAP.md` | `verify-guard-map.mjs` |
| `docs/STATE.md` | `verify-live-machine.mjs` |
| `live/agent.js` | `panel-check.mjs` |
| `live/panel.js` | `panel-check.mjs` |
| `live/src/agent/ledger.js` | `verify-live-machine.mjs` |
| `live/src/agent/main.js` | `verify-live-machine.mjs` `verify-contracts.mjs` `e2e.mjs` `panel-check.mjs` |
| `live/src/agent/video.js` | `verify-pause-semantics.mjs` |
| `live/src/agent/watchdogs.js` | `verify-live-machine.mjs` `verify-pause-semantics.mjs` |
| `live/src/panel/controls.js` | `panel-check.mjs` |
| `live/src/panel/main.js` | `verify-contracts.mjs` `e2e.mjs` `panel-check.mjs` |
| `live/src/state.js` | `verify-live-machine.mjs` |
| `scripts/guards.json` | `verify-guard-map.mjs` |
| `src/core/broadcast.ts` | `verify-contracts.mjs` |
| `src/core/cdp.ts` | `e2e.mjs` |
| `src/core/configApi.ts` | `verify-contracts.mjs` |
| `src/core/earlyWatch.ts` | `verify-early-watch.mjs` |
| `src/core/inject.ts` | `verify-contracts.mjs` `e2e.mjs` |
| `src/core/payload.ts` | `verify-contracts.mjs` |
| `src/core/server.ts` | `verify-contracts.mjs` `verify-early-watch.mjs` |
| `src/core/sessions.ts` | `e2e.mjs` |
