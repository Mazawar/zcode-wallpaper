# 架构：分层与规则

> 本文回答「代码住在哪、谁允许 import 谁」。机制细节住在各实现文件头注释（纪律：能写在代码旁的规则不单写文档）；
> 「为什么」住 [DECISIONS.md](DECISIONS.md)；壁纸层状态机与失败策略住 [STATE.md](STATE.md)。
> 不写会漂的数值——条数/行数/阈值一律指向实现里的具名常量。

## 分层图

```
┌─ ZCode 客户端页面（CDP 注入，非官方通道）────────────────────────────┐
│  瘦 bootstrap（cdp.ts 生成）                                          │
│    关键 CSS（防闪烁）+ 初始 payload + <script src=/agent.js|/panel.js>│
│    + 生命周期心跳（serve 消失 → teardown 运行时）                     │
│  live/agent.js ← live/src/agent/* 打包    单一施加者：壁纸层状态机     │
│  live/panel.js ← live/src/panel/* 打包    设置→外观页区块              │
│  live/index.html + renderer.js            WebWallGL 渲染页（独立 iframe）│
└──────────────────────────▲ SSE /api/events（cfg）───┐────────────────┘
                           │ CDP（仅注册+30s 探测）    │ fetch /api/*
┌─ 插件宿主进程（ZCode 起/停/崩溃重启）────────────────┴───────────────┐
│ src/mcp/    MCP 服务器（宿主入口，7 个 agent 工具）                    │
│ src/core/                                                              │
│   通道层   server.ts 路由 · broadcast.ts SSE · cdp.ts 连接/引导        │
│   内核层   inject.ts 配置模型+payload · configApi.ts 读写面            │
│            assets.ts · monet.ts/tokens.ts（取色）· payload.ts          │
│   源层     steam.ts 发现 · sources.ts 应用/导入导出/删除 · media.ts    │
│   会话层   sessions.ts（注入保持/自愈） · shortcuts.ts · launch.ts     │
│   失败记忆 livefail.ts（live 硬失败落盘，payload 回退依据）            │
└──────────────────────────────────────────────────────────────────────┘
```

## 规则

1. **单一施加者**：页面里只有 agent 运行时改动壁纸层 DOM；配置变更一律经 SSE → 状态机 → 施加。
   CDP 通道只承载注册与心跳，永不承载配置推送（见 DECISIONS D1）。
2. **import 方向**：`源层/通道层 → 内核层` 允许；内核层不得 import 源层/通道层；
   `live/src/*` 相互同层，但 `state.js` 不得 import 任何带 DOM 依赖的模块（守卫
   `verify-live-machine` 断言其可在纯 Node 环境加载）。
3. **投递形态**：`live/src/**` 是源码，`live/agent.js`、`live/panel.js` 是 esbuild
   产物（iife，零运行时 import）——产物与 dist/ 一样提交入库：市场安装不跑构建。
   改运行时 = 改 `live/src/**` + `npm run build`，不手改产物。
4. **payload 是唯一数据面**：`buildPayload()` 产出的形状即页面所得（嵌入 head start
   与 SSE 推送同形）。加字段 = 改 inject.ts + STATE.md 同步；页面不得自行拼配置。
5. **两方对账**（守卫 `verify-contracts`）：publicConfig 键 ⊇ 面板写入键 ⊆ sanitize
   白名单；SSE 事件名 产出↔消费 一致；payload 字段 构建方↔读取方 一致。
6. **守卫地图**（守卫 `verify-guard-map`）：改哪个文件该跑哪条守卫，查
   [GUARD-MAP.md](GUARD-MAP.md)——由 `scripts/guards.json` 生成，手改文档无效。
