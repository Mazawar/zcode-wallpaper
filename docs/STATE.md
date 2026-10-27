# 壁纸层状态机与失败策略

> 规范源：`live/src/state.js`（转移表、失败策略、具名常量全在那里，本文只画形状）。
> 守卫：`scripts/verify-live-machine.mjs` 直接加载该模块断言下列全部不变量。

## 双轴模型

壁纸层 = **kind（在渲染什么）× phase（该 kind 处于哪个相位）**，状态字符串 `"<kind>/<phase>"`。

| kind | phases | 进入条件 |
|---|---|---|
| `none` | `idle` | 无壁纸 / wallpaperVisible=false |
| `image` | `shown` | 图片壁纸 |
| `video` | `prep` → `shown` → `leaving` | 原生 `<video>`：离屏预播 → canplay 提交 → 退场 |
| `live` | `poster` → `loading` → `shown` ⇄ `paused` / `stalled`；`shown` → `switching` → `shown`；任何 → `failed` | WebWallGL iframe |

`SET_SOURCE` 是万能事件（任何状态可发，目标相位由 payload 的 kind 决定）；
`RESUME` 从 `paused` 回到暂停前的相位。其余事件只在声明过的源状态上合法——
**未声明的转移被记录并忽略**（flight recorder 可见），绝不静默放行。

## live 装载预算与失败分级（D6/D7/D8）

装载期（`live/loading`）每 `LEDGER_TICK_MS` 轮询 serve 账本（`GET /api/transfer`）：

- 字节仍在涨 → 重置停滞计数（正在下载 ≠ 渲染不出来）；
- **传输停涨且未完成** ≥ `LEDGER_STALL_TICKS` → **软失败**（`transfer`）：会话内冷却
  `SOFT_RETRY_DELAY_MS` 后重试，上限 `SOFT_RETRY_LIMIT` 次；耗尽即升级硬失败；
- **传输已完成但引擎未报 ready**：**不因停滞计数判死**——装配（shader/纹理/粒子）
  在交付后可合法耗时数秒以上；只有**总预算耗尽**（`max(firstFrameBudget, LEDGER_CAP)`）
  才判硬失败（`renderer`）。0.4.0 曾以 8 拍停滞冤杀装配期场景（切换卡静态页），此即修正。
- 硬失败：`POST /api/live-verdict` 落盘（serve 端 `livefail.ts`），此后 payload 构建对
  该源 **不放 liveSrc**、保留 livePoster、附 `liveFailed: {reason, at}`——页面停在
  poster 相位并在面板显示原因与「重试」按钮（`POST /api/live-retry` 清记忆重推）。
- 换源 / 手动重试 / 重新启用实时渲染 = 显式清除该源失败记忆（用户意图优先于记忆）。

数值全部为 `state.js` 具名导出常量；本文不抄（防漂移）。

## 看门狗 = 状态机的传感器

| 传感器 | 间隔 | 触发的事件 | 施加器响应 |
|---|---|---|---|
| 账本轮询 | `LEDGER_TICK_MS` | `BUDGET_PROGRESS` / `BUDGET_EXHAUSTED` | 停滞计数、失败判定 |
| 切换超时 | `SWITCH_CAP_MS` | 无 SWITCH_READY → `FAIL_SOFT` | 掀掉覆盖层、按软失败重试 |
| 隐藏暂停（去抖） | 1.5s | `PAUSE` / `RESUME` | 暂停视频元素与引擎 |
| 视频解冻 kick | 2s | （video 域） | load()+play()，时钟比对 |
| 透明面自愈 | 5s | （DOM 域，无相位） | 强制半透明遮罩面 |
| 引擎内看门狗 | renderer.js 自治 | 自重挂后重发 ready | 相位回 `loading→shown` |

渲染页内部的存活/尺寸看门狗保持自治（重挂自愈后重发 `ready`，状态机自然回归 `shown`）。

## 面板生命周期（与壁纸层状态机分离的第二个机器）

挂载条件：外观页可见 ∧ serve 健康；serve 硬失联（连接拒绝）→ 退役，恢复后自复活。
心跳「先见健康才计失败」的冷启动闸门保持不变（V=20 的教训）。
