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

携带 live URL 的 payload 到达时，applier 先用 `SET_SOURCE` 把相位归一到
`live/loading`（来源可以是 `paused`/`stalled`/`failed`/`poster` 任何相位——
后台窗口里切壁纸不再产生被拒绝的 `SWITCH_BEGIN`），再按「无帧 = mount、
有帧 = switch」驱动 actor。

## live 装载预算与失败分级（D6/D7/D8）

装载期（`live/loading` / `live/switching`）每 `LEDGER_TICK_MS` 轮询 serve 账本
（`GET /api/transfer`）：

- 字节仍在涨 → 重置停滞计数（正在下载 ≠ 渲染不出来）；
- **传输停涨且未完成** ≥ `LEDGER_STALL_TICKS` → **软失败**（`transfer`）：会话内冷却
  `SOFT_RETRY_DELAY_MS` 后重试，上限 `SOFT_RETRY_LIMIT` 次；耗尽即升级硬失败；
- **传输已完成但引擎未报 ready**：**不因停滞计数判死**——装配（shader/纹理/粒子）
  在交付后可合法耗时数秒以上；只有**总预算耗尽**（`max(firstFrameBudget, LEDGER_CAP)`）
  才判硬失败（`renderer`）。0.4.0 曾以 8 拍停滞冤杀装配期场景（切换卡静态页），此即修正。
- **页面隐藏时账本冻结**（预算时钟与停滞计数都暂停）：隐藏页 rAF 停转，ready 不可能
  到来——后台窗口里的切换曾在无人看见时烧完整个预算、落一个假 renderer 硬失败。
- **引擎 error 事件即时判死**（`engine`）：装载/切换期收到渲染器的装配失败
  （如着色器编译失败）直接走硬失败路径，不为必败的装配烧满预算。
- 硬失败：`POST /api/live-verdict` 落盘（serve 端 `livefail.ts`），此后 payload 构建对
  该源 **不放 liveSrc**、保留 livePoster、附 `liveFailed: {reason, at}`——页面停在
  poster 相位并在面板显示原因与「重试」按钮（`POST /api/live-retry` 清记忆重推）。
  降级（poster-only）期自愈探测不再要求 live iframe（那是 1.0.0 的每 30 秒重注入风暴）。
- 换源 / 手动重试 / 重新启用实时渲染 = 显式清除该源失败记忆（用户意图优先于记忆）。

数值全部为 `state.js` 具名导出常量；本文不抄（防漂移）。

## 切换 = 换帧（D15）

同类换源**不再原地 load**（webwallgl 3.0.0 的 `load()` 不可重入，见 DECISIONS D3/D15）：
挂新 iframe（`-live-next`）于旧帧之下，新引擎 ready（`SWITCH_READY`）后旧帧按所选
过场效果退场。旧画面就是装配期的封面——没有快照、没有覆盖层 img。切换预算归 ledger
统一管（换帧即一次首挂，尺寸感知预算天然适用），switch-cap 传感器已撤销。

## 渲染质量档位（D20）

配置键 `liveQuality`（省电/均衡/高画质/极致，默认**均衡**）由 serve 侧
`inject.ts LIVE_QUALITY_PRESETS`（唯一展开表）展开成 live URL 参数：
`dpr`（DPR **上限**，min(deviceDPR, cap)，0=原生；恒下发含 0，热更才能抬回）、
`aa/pq/pp`（抗锯齿/粒子/后处理档）、`vts`（视频纹理倍率）、`aq`（引擎自动降档，
仅挂载期生效——无热更 setter）。渲染页不认识档位名，只消费参数；缺参回落均衡值。
改档位不改壁纸 = URL 变化但 src/type 不变 → liveframe 走既有热更路径
`{zw:"cfg"}` postMessage → 引擎 `setQuality/setVideoTexScale/setRenderDpr` 就地生效
（setRenderDpr 内部重建画布重挂场景，引擎自治）。

## 看门狗 = 状态机的传感器

| 传感器 | 间隔 | 触发的事件 | 施加器响应 |
|---|---|---|---|
| 账本轮询 | `LEDGER_TICK_MS` | `BUDGET_EXHAUSTED` | 失败判定（装载与切换共用，见上） |
| 隐藏暂停（去抖） | 1.5s | `PAUSE` / `RESUME` | 暂停视频元素与引擎 |
| 视频解冻 kick | 2s | （video 域） | load()+play()，时钟比对 |
| 引擎内看门狗 | renderer.js 自治 | 自重挂后重发 ready | 相位回 `loading→shown` |

（0.4.8 起「透明面自愈」从看门狗表移除——它不再是 JS 传感器，改为 payload 里的
一条声明式 CSS 规则，见 DECISIONS D9。1.0.1 起「切换超时」移除——换帧切换的
预算与装载同源，由 ledger 统管，见 D15。）

渲染页内部的存活/尺寸看门狗保持自治（重挂自愈后重发 `ready`，状态机自然回归 `shown`）。

## 面板生命周期（与壁纸层状态机分离的第二个机器）

挂载条件：外观页可见 ∧ serve 健康；serve 硬失联（连接拒绝）→ 退役，恢复后自复活。
心跳「先见健康才计失败」的冷启动闸门保持不变（V=20 的教训）。
