# 决策档案（mini-ADR）

> 每条 = 已做的决定 + 代价 + 非目标。新增大决策追加编号；推翻旧决策时保留条目并注明被谁取代。

- **D1 单一施加者（0.3.0）**：CDP 只注册瘦 bootstrap（关键 CSS + 初始 payload + 运行时加载器），
  真正的层状态机住在 serve 供应的真文件运行时里，配置经 SSE 直达。
  代价：serve 必须活着页面才有行为（心跳+reset 兜底）。
  非目标：不追求 serve 死后壁纸仍可交互。
  背景：0.2.x 前每次配置变更都重新生成脚本穿 CDP——滑杆风暴队列饱和、evaluate/重注册竞态、
  bare-css 推送空窗三类 bug 的共同根因。

- **D2 视频走宿主原生 `<video>`，不进 WebGL 引擎（2691ff0）**：离屏预播 → canplay 后带画提交。
  引擎 WebCodecs 管线曾带来 pause 清画布 / 唤醒快进 / 快照过渡复杂度三宗罪，全部回退。
  引擎边界仅限场景渲染；dsh 结论：「能用宿主原生元素就别进引擎」。

- **D3 同类切换原地 load，跨类双上下文（0.3.x 立，1.0.1 由 D15 撤销）**：同壁纸参数变化走 postMessage 热更新；
  同类换源曾走现有 iframe 原地 load（复用 WebGL 上下文）。1.0.0 实测 webwallgl 3.0.0 的
  `load()` 不可重入——同实例第二次 load 必然「着色器编译失败」，同源亦然——原地换源整条路
  从未真正成立（叠加 renderer 的 `const volume` 赋值 TypeError，每次切换还被静默吞掉）。
  换 D15 双帧切换；参数热更新（postMessage cfg）保留。

- **D4 单文件投递运行时（本文件 D-0.4.0 起）**：页面运行时以 `live/src/**` 多模块开发、
  esbuild 打包成单文件 `live/agent.js` / `live/panel.js` 投递。
  代价：改运行时必须过构建（产物入库，市场安装不跑构建）。
  非目标：不做运行时 ES module 动态 import（多请求 + CSP 面）。

- **D5 状态机唯一权威（0.4.0）**：壁纸层一切相位变化走 `live/src/state.js` 的声明式转移表；
  看门狗不再是散装定时器，而是「触发转移事件的传感器」。DOM 施加器订阅转移，不私改相位。
  代价：新增行为必须先在转移表里声明（守卫禁止未声明转移）。

- **D6 失败分级（0.4.0，dsh P2-12 教义）**：live 失败分软/硬——传输未完成 = 会话内软失败
  （冷却重试、次数有上限）；渲染器真死 = 硬失败落盘记忆，payload 构建时回退 poster 并带原因。
  「要么给真画面、要么明确留空带原因」，绝不用猜来的劣质图冒充成功。

- **D7 载荷账本（0.4.0）**：serve 对 /files 流量按源记账（字节+总量+最后活动），
  agent 装载期轮询——「正在下载」不得被误判成「渲染不出来」（dsh 同款教义）。

- **D8 首帧预算按包大小现算（0.4.0）**：不设固定墙钟；预算 = 基础 + 总字节/速率，封顶，
  具名常量在 `live/src/state.js`（数值复算见 STATE.md，不抄进本文）。

- **D9 透明面：声明式 CSS，零 DOM 改动（0.2.0 立，0.4.8 重写）**：主通道从来不动
  ZCode 的 DOM——只覆盖 CSS 变量，让 ZCode 自己画的表面天然半透明。0.2.0 的兜底是
  DOM 级自愈（扫描 ≥30% 视口的不透明 bg-background 面、写内联样式+attr 标记、
  MutationObserver/轮询触发）；实测它的代价是「点开设置先暗几秒再通透」（新表面要等
  下一拍才被改）且与「最小干预」相悖。0.4.8 页内实验证明一条静态规则即可全量覆盖
  （含不吃变量的字面色表面）：`[class*="bg-background"] { background-color:
  var(--color-background) !important }` 随 payload 注入，JS 自愈整个删除。
  原则：对宿主页面只做「声明样式 + 自有图层」，不做元素级改写。

- **D10 早启 wrapper + 快捷方式自愈（0.2.0–0.3.1）**：VBS wrapper 拉起 ZCode 带 CDP 端口，
  快捷方式重建式幂等维护；他机坏 wrapper 靠版本标记自愈。教训：生成的脚本必须真机执行验证。

- **D11 宿主进程内 serve（f064f21）**：serve 内嵌插件宿主（MCP）进程，启停随 ZCode，
  崩溃由 ZCode 重启宿主；stdout 重绑 stderr（JSON-RPC 通道零污染）。非目标：不再做
  detached daemon / mcp-alive 协议（那是基于「会话级 MCP」的错误观察的过度设计，已删）。

- **D12 官方边界（2026-10-27 调查）**：ZCode 无官方 UI/外观 API（issue #171 开放中；开发中的
  UI Plugin 明确不能改宿主外观）。CDP 注入是全生态唯一非破坏性通道，社区同类工具（zcode-beautify、
  Zgd03、zcode-background）全部同路；改 app.asar 一派（zcode-skin-manager）每次更新即碎，不做。
  reset/restore 永远保留一键还原。

- **D13 市场条目官方目录格式（0.3.3）**：displayName/i18n/category=utilities/keywords/componentTypes
  对齐官方词汇；插件身份与 `source: "./"` 不变。

- **D14 守卫先于重构（0.4.0，dsh 纪律）**：任何结构性改动前先立可复算的守卫；迁移
  「先纯搬移（零行为变化）再改语义」，每批守卫全绿。

- **D15 切换 = 换帧，不再原地 load（1.0.1）**：同类换源挂一个新 iframe（`-live-next`）在旧帧
  之下，新引擎 ready 后旧帧按所选过场效果退场——旧上下文在新画面出现后才销毁，既没有
  destroy/create 抖动，也不再依赖引擎的 `load()` 可重入性（webwallgl 3.0.0 无此保证，见 D3）。
  切换预算归 ledger 统管（换帧即首挂，尺寸感知预算天然适用），switch-cap 传感器撤销。
  同目标的重复 apply（两阶段发布的第二发）不提前 promote，旧画面保持到新帧 ready。
  代价：每次切换多一个短命引擎实例（装配期双份 GPU 占用，秒级）。

- **D16 模糊边缘用垫图盖，不再放大画幅（1.0.2）**：CSS `blur()` 会让视口大小的壁纸层
  边缘羽化透出透明；1.0.0 用固定 `scale(1.04)` 遮边，代价是开模糊即整体放大 4%、构图跳变。
  现改为：模糊开启时把同一画面的重度模糊垫图（live poster / 视频预览 / 图片本体）垫在
  壁纸层之下盖住边缘（payload `wallBlur` 驱动，垫图同步压暗避免亮边）；垫图全部不可得时
  （如无预览的视频壁纸）才保留 1.04 兜底。

- **D17 Windows 快捷方式直接带参，废除 wscript+VBS 早启包装（1.0.2，同日被 D18 修订：包装恢复但加固）**：早启包装的收益只有
  serve 提前 ~9s（插件宿主起来后同样注入已加载的渲染页），代价却是启动链上多两个可断点——
  VBS 三次实爆：0.3.1 编译错误、0.4.1 卸载后路径悬空、1.0.2 时期 nvm 链接迁移暴露 node 路径
  硬编码（FileExists 只守 cli.js 不守 node，sh.Run 抛错即吞掉启动 ZCode 那行）。改为 .lnk 直接
  指向 ZCode.exe + 规范参数（CDP 端口 + 防遮挡），node/插件卸载/路径迁移从此与启动无关；
  遗留 wscript 快捷方式按 meta 迁移，无引用后自动清理 zw-launch.vbs/json。mac/linux 包装器不变。

- **D18 早启包装恢复并加固（1.0.2，撤 D17 的"废除"，改立硬规则）**：用户裁定——早启值得保留
  （渲染页 ~1s 就绪 vs 宿主 ~13s），且插件**不得改动计算机配置**（注册表 Run/开机自启/
  LaunchAgent 等一律禁区；只准动用户自己的启动快捷方式与插件数据目录）。包装是跨系统
  早启的唯一合规形态：win=wscript+VBS（不闪黑窗的唯一原生宿主）、mac=启动器 .app、
  linux=.desktop wrapper。Windows 三炸的教训不归罪形态而归罪实现，v4 包装四条硬规则：
  ①node 与插件**双探存在**才起 serve（1.0.2 事故根因：只探了 cli 没探 node）；
  ②On Error Resume Next 兜底 + 启动 ZCode 那行**无条件执行**——本文件永不可能阻塞启动；
  ③node/cli/zcode 路径每次插件会话重新烘焙（ensure 每趟全量比对重写，nvm 迁移最多
  退化一届"无早启"，下次会话自愈）；④serve 配套：--early 在 ZCode 消失 60s 后退出，
  health 暴露 version，宿主发现端口上是旧代际 serve 即 POST /api/retire 令其退役
  （根治"部署了没生效"的驻留旧码问题）。mac/linux wrapper 同步加 node 探测（其后台
  失败本就不阻塞启动行，属一致性收尾）。

- **D19 启动目标运行时自愈（1.0.4，D18 的收尾）**：包装的最后残余风险=烘焙的 ZCode 路径失效
  （应用挪动/换盘重装）→ 双击无反应。VBS v5 启动行前按**通用信号链**重找目标，不预设安装习惯：
  烘焙路径 → %ZCODE_WINDOWS_APP_INSTALL_DIR%/Program Files/LOCALAPPDATA 标准位 → **WMI 查运行中的
  ZCode.exe 实例路径**（任意安装位置）→ **扫描桌面/开始菜单 .lnk 找仍指向 ZCode.exe 的条目**（搬家后
  安装器新写的快捷方式就是信号）→ 盘符根目录 ZCode\ZCode.exe 约定（兜底的兜底）→ 全落空弹 ASCII
  明示框（wscript 无 BOM 按 ANSI 读，包装内禁非 ASCII），提示直启一次即自愈。实测：伪烘焙路径下全链
  与去 WMI 链都能找回 D:\ZCode\ZCode.exe。mac 同理：open -a 改按应用名调用（自动搜 /Applications +
  ~/Applications，路径挪动不断链）。

- **D20 渲染质量档位化，默认降半档（1.0.5）**：1.0.4 及以前渲染页把引擎拧死在「极致」
  （msaa4 + 粒子/后处理 high + 原生 DPR + autoQuality 关）——低配机器（尤其 HiDPI 笔记本，
  DPR 1.5/2 意味着 2.25–4× 像素）毫无退路。现改为单一配置键 `liveQuality` 四档
  （省电/均衡/高画质/极致），默认**均衡**（≤1×逻辑分辨率 + fxaa + 粒子/后处理 medium +
  autoQuality 开，HiDPI 上 GPU 成本约为极致的一半）；需要满画质的自行切高画质/极致。
  展开表只存在于 `inject.ts LIVE_QUALITY_PRESETS` 一处：宿主把档位展开成 live URL 参数
  （dpr/aa/pq/pp/vts/aq，渲染页永远不认识档位名），挂载即生效；同源热更（不改壁纸只改档位）
  走既有 `{zw:"cfg"}` postMessage → 引擎 `setQuality/setVideoTexScale/setRenderDpr` 就地生效，
  不重载 iframe。已知边界：引擎 `autoQuality`（含无 GPU 自动关后处理的兜底）没有热更 setter，
  档位切换里它的变化要到下次挂载才生效——两个高档位本来就关它，影响面极小。
  `dpr` 参数语义从「目标 DPR」改为「DPR 上限」（min(deviceDPR, cap)，0=原生），URL 里恒下发
  （含 0），保证热更永远能把先前压低的分辨率抬回去。

- **D24 无端口会话的检出与自愈（1.0.10）**：他机实锤案例——插件已装但面板永不出现，根因是那次
  ZCode 启动没带 --remote-debugging-port（CDP 是唯一注入通道且只能进程启动时带上；serve 起得
  再健康也注不进去）。四件套：①serve（规范端口）15s 巡检「ZCode 在跑 + CDP 端口无监听 + 从未
  持有会话 + 启动满 45s」→ 判定本次启动绕过包装：日志明示 + 自动补包装（下次启动生效）+ health
  暴露 cdp:"absent" + wallpaper_status 附 hint「重启 ZCode 即恢复」——任何机器上的 agent 一查
  status 就落地原因，不再瞎猜。②快捷方式发现从「名字前缀」升级为「名字或目标」两阶段（批量 PS 解析
  TargetPath）：改名/本地化 .lnk（他机疑似根因）从此也能被包装。③VBS v7 二次启动：启动 ZCode 25s
  后探 /api/health，不健康且 node+cli 都在 → 重拉 serve——与宿主 10s 重试环互为备份，任何单点
  失败都有第二条路。④撤早启 serve 的「3 分钟无宿主即自杀」（启用/卸载监视已接管该判断；宿主竞争
  场景下它误杀过唯一活着的 serve）。
  补（同夜）：mac/linux 包装器对齐 v7 加固——25s 二次启动（curl/wget 探测，无探测工具则
  跳过避免误重拉）、mac open -a 失败弹 osascript 明示框、.desktop 的 Exec 目标识别放宽为
  zcode 前缀（原精确等值是 Windows 改名快捷方式同款病）。**实测教训：孤儿子 shell 里再 & 出的
  孙进程不可靠（MSYS 实测延迟/可能被回收）——重拉命令必须作为该子 shell 的前台末命令**。

- **D25 用户暂停压过看门狗（1.0.12）**：面板「暂停」对视频壁纸只生效一两秒——kickVideo 每 2s
  巡检见 `paused && autoplay` 即判「管线冻结」强制 play（元素恒带 autoplay），focus/pointerdown
  的 wake 也无条件 resume；live 渲染器早有 userPaused 语义（自动唤醒不得覆盖用户暂停），
  视频通道一直没对齐。修复：video actor 增 `pause(user)/resume(user)/userPaused()`（自动
  resume 见标志即 no-op；同 src 热更不再无条件 play，error 自愈 load() 后重申暂停；换新视频=
  新意图，提交时清标志）；kickVideo 判定加 `!userPaused()`；面板不再直接戳 video 元素（本 bug
  温床：暂停了元素却无人知晓），改 `window.postMessage({zw,user:true})` 由 agent 统一执态，
  按钮初始态从 agent 标志同步。另：壁纸卡操作行加「卸载壁纸」按钮=既有 `/api/reset`（先备份，
  footer「还原上次壁纸」可找回）——服务端与 MCP `reset_appearance` 早已具备，缺的只是显眼入口。
  新守卫 `verify-pause-semantics.mjs`：DOM 桩上跑真实 actor，11 条断言钉死该语义。

- **D26 卸载/重置/还原三分离（1.0.13）**：用户实测反馈「卸载壁纸和恢复默认外观功能一样了，我还原了为啥又给我恢复了」——日志/备份/config 实证：不是机制 bug（轮播未开、无自动恢复痕迹；备份=视频而 config 被写回的是场景=卸载后数秒内一次库内点击应用），是**三个按钮两种动作**的文案歧义：「恢复默认外观」「还原上次壁纸」中文近义，用户无法预判哪个按钮干什么。用户裁定三分语义：①**卸载壁纸**=卸掉当前背景（/api/reset 原语义，备份+清壁纸，库与设置不动）；②**恢复默认配置**=新端点 /api/reset-options，画面/播放键回 DEFAULT_CONFIG、显式关轮播，**壁纸/媒体库/端口不动**；③**还原上次壁纸**=只作为卸载的 undo（/api/restore）。附带：/api/reset 补 publishConfig（resetSessions 漏窗时 SSE 兜底清残留 agent）；MCP reset_appearance 描述改「卸载」并对齐面板语义。教训：**同屏多个破坏性相近按钮必须一词一义，「恢复/还原/重置」在中文 UI 里是同义陷阱**。

- **D27 宿主静默≠禁用：早启看门狗证据化（1.0.14）**：2026-10-30 13:17 用户报「壁纸刚刚挂了」——完整证据链：ZCode
  主进程未重启，~13:16:4x 插件宿主舰队整体换血（旧 mcp/server.js 全灭、新舰队+restoreSession 渲染进程
  13:17:29-31 重建、无 crashpad/无 host-crash——是 ZCode 的正常调度非崩溃），心跳空窗 >45s 时早启 serve 的
  「host silent 45s + ZCode 活着 = 会话中途禁用」启发式（盲目退出路径）直接 restore 默认外观退出=壁纸被
  误杀，3 秒后接替宿主重挂（净损失 ~5s 闪失）。**结构性错误：把「宿主没心跳」当成了禁用证据——显式禁用
  早有自己的权威探测器（enablement watch：pluginDisabledBy 5s tick + fs.watch；ZCode 停用必写 config），
  静默本身不该有任何拆壁纸权限。**修复：判定抽成纯函数 `src/core/earlyWatch.ts`（`earlyHostTick`，可裸跑
  契约同 state.js），语义改为——静默>45s 且 ZCode 活着时**先查 pluginDisabledBy**：确证禁用才 restore+退出
  （保留原兜底意图）；未确证=宿主换血，**原地续命**（churn 日志一次/episode，心跳恢复/接替者 retire/
  ZCode 退出三者最终裁决），心跳恢复时重置 episode 旗标（换血被吞不得掩盖后续真禁用）。ZCode 消失 60s
  退出与「宿主从未出现不得杀 serve」两条原语义不变。新守卫 `verify-early-watch.mjs`：esbuild 现场打包真实
  earlyWatch 源跑 12 场景（含事故场景回归钉）+ 三条接线钉（含「盲退日志行 `plugin host gone (disabled?)`
  不得回归」）。教训：**退出路径的每个分支都要能回答「我的证据是什么」——没有证据的破坏性动作（restore
  拆壁纸）宁可不做；心跳这类弱信号只能触发调查（复查权威状态），不能直接执行处决。**

- **D28 快捷键一键隐藏/显示壁纸（1.0.15）**：需求：一键隐藏壁纸（回到 ZCode 默认外观）随时恢复。实现=复用既有
  wallpaperVisible 全链路（面板「显示壁纸」开关同款 POST /api/config → sanitize 持久化 → SSE 广播 → 各窗口
  agent apply），新增配置键 toggleHotkey（默认 "Ctrl+Alt+W"，空=停用）。**范围裁定：页面级快捷键（ZCode 窗口
  聚焦时生效），不做 OS 全局钩子**——全局热键需要键盘钩子/原生模块，越出「插件不动计算机」边界且需管理员权限，
  而壁纸只在窗口里可见，窗口外按了也没有意义。要点：①组合键文法收进纯函数 hotkey.js（归一化 canonical
  Ctrl+Alt+Shift+Win+Key、ev.code 优先（布局稳定，ArrowLeft 不得被修饰键后缀剥离误伤）、精确匹配=多按修饰键也
  不触发）；②agent 在 window 捕获级挂 keydown（宿主应用无法吞掉），翻转经 payload 跟踪的 wallpaperVisible，
  多窗口同帧一起变；③修饰键强制（裸键热键会在每次敲键时触发）；④面板录制框 data-zw-hotkey 属性从 agent 全局
  处理器豁免（否则录制时按下的组合会被 agent 先行执行）；⑤可编辑目标只放行带修饰键的组合（聊天框里也能一键藏）。
  新守卫 verify-hotkey.mjs：真实 hotkey.js 裸跑 27 断言（文法/录制/匹配/安全规则）+ 7 条接线钉；
  verify-contracts 的白名单链自动把面板推送 ⊆ sanitize ⊆ publicConfig、payload 读取 ⊆ 构建字段对上了账。
  守卫先红后绿抓到两个真 bug：布尔表当字符串比较（所有含修饰键组合全废）、KeyW/Digit5 未折叠成 W/5。

- **D29 端口池浮动 + 会话发现（1.0.16）**：需求：两个固定端口（CDP 28256/API 28257）被外部应用抢占时整个插件瘫死
  （API 被占=serve 绑定失败宿主 10s 重试永不成功；CDP 被占=Chromium 静默无调试端口、整会话无注入）。设计=**首选槽 +
  偶/奇分池浮动 + 会话发现**：①CDP 走偶数池 28256..28274、API 走奇数池 28257..28275（物理不可能互撞；首选槽=历史
  固定端口，`ZW_PORT_BASE` 可整体平移池——守卫用它做全封闭测试，也留给受限机器）；②pickPorts 形态的 serve（wrapper
  cmd/宿主 spawn 传入）启动时先读会话发现（上次选的槽优先——wrapper 25s 二次拉起必须落在同一对端口），再走池：候选
  被自己的 serve 占着=照旧抛 already-running（加入/交接语义不变）、被外部应用占着=下一候选、空闲=绑定；CDP 拾取规则
  「空闲或活的 CDP 端点」（宿主期 ZCode 已绑走启动槽——那正是会话真相）；③选中端口写进两处：`zw-launch.json` 的
  cdpPort/apiPort（发现，宿主/CLI/status 消费）+ `zw-ports.txt` 扁平握手（**VBS 专用**：wrapper 启动先删握手→拉起
  serve→轮询 ~4s→用握手 CDP 端口启动 ZCode，读不到回退烘焙字面量——永不阻塞永不误导，D18 不变）；④显式
  --port/--api-port 完全绕过（dev 验证/二实例），1.0.6 快捷方式护栏保留；ensure+cdp-absent 看门狗对 pickPorts 会话
  也生效（浮动会话同样需要被守护）。**关键坑：isPortFree 的 bind-and-release 探测必须等 close 回调完成再
  resolve——Windows 上先行 resolve 会让调用方紧跟的 listen 吃 EADDRINUSE**（守卫真 socket 测试抓出）。验证：守卫
  verify-ports.mjs（真实 ports.ts 对真 socket 跑池形状/占用探测/活端点拾取/发现往返 + 真实生成器产出 v8 wrapper
  的握手编排/ASCII 钉 + server/MCP/CLI 接线钉）+ smoke-vbs.mjs（cscript 实跑抑制版 v8：编译、轮询超时回退、无条件
  启动行全过——0.3.1 教训的例行执行）+ 本机隔离池真跑两轮（28290/28291 直选、28321 被外部占用浮动到 28293）。macOS
  /Linux sh wrapper 同步 v3（rm→轮询→sed 解析→case 回退），真机仍未验证（0.4.16 起悬置）。边界：CDP 端口每会话
  至多选一次（wrapper 期），会话中途不浮动（Chromium 启动后不可改）；wrapper 健康探测仍打烘焙 apiPort+1，浮动会话
  下二次拉起可能空转一次（无害，宿主 10s 环兜底）。

- **D30 快捷方式覆盖缺口 + 备用启动器（1.0.17）**：Win10 机器报「桌面快捷方式没有重新指向」。根因分析：**扫描清单
  从来没有所有用户公共桌面**（C:\Users\Public\Desktop）——安装器最常把桌面快捷方式放在这里，name/target 两阶段发现
  再强也扫不到看不见的目录；而且公共桌面上管理员创建的 .lnk 普通权限改不动（rewrite 会落 failed 桶，此前只有日志
  无兜底）。修复三层：①扫描清单加公共桌面（env PUBLIC）；②结果解析从 startsWith 粗判升级为 parseLnkOutcome 五码
  细分（updated/has-flag/not-zcode/zcode-missing/err），**has-flag 计入 wrappedCount**（已包装=已覆盖）；③**兜底
  创建（用户要求的「失败了就替换」）**：当 wrappedCount===0（全没扫到、全失败、或压根没有任何 ZCode 快捷方式）时，
  解析 ZCode.exe（运行实例 WMI → 标准安装位 → 盘符根约定），在用户自己的桌面创建「ZCode Wallpaper.lnk」
  （wscript+VBS+ZCode 图标，用户桌面永远可写）——命名以 ZCode 开头让下一趟扫描按名字回收、target 探测识别为
  已包装，创建一次性、后续 pass 全走 fast-path；幂等（Arguments 精确匹配即 skip）。不做的事：不弹 UAC 提权重写
  公共桌面条目（插件不得有惊喜式提权），旧图标原地保留、新图标保证可用。验证：verify-shortcuts.mjs（真实执行
  创建脚本 + COM 读回断言 + 幂等 skip + 扫描覆盖钉）+ 本机 ensure 实跑预演。**手工运维坑：手工跑 ensure 必须
  ZW_DATA_DIR 指向机制目录，否则 dataDir 落 dev 沙盒、.lnk 会被改指沙盒 VBS**（本机已当场修正；宿主/serve 进程
  自身解析正确，不受影响）。

- **D31 快捷键配置区 + 一键切换族（1.0.18）**：用户问「快捷键配置在哪，怎么没有一键切换/随机切换/一键关闭的入口」。
  两层答案：①配置入口 1.0.15 就有（面板「画面与播放」），但**面板由 serve 供应——不重启 ZCode 永远是老面板**（本机
  当时还跑着 1.0.13 宿主 serve），这是「功能发了却找不到」的第一解释，报障先对版本；②切换类快捷键确实没有——本次
  补齐成完整配置区。设计：**组合键=配置键一一对应**，新增 `nextHotkey`（下一张，默认 Ctrl+Alt+D）、`randomHotkey`
  （随机，默认 Ctrl+Alt+R），与 toggleHotkey（隐藏/显示，Ctrl+Alt+W）同文法同管线（hotkey.js 纯函数、payload 三键
  齐发、sanitize 白名单、面板录制行）。**「一键关闭」不设独立键**：toggle 本身就是关+开（按一次回默认外观、再按恢
  复），语义上与「隐藏/显示」完全重合，多一个键只会增加互斥调试面。新端点 `POST /api/switch {mode:"next"|"random"}`：
  选库逻辑从轮播 tick 抽成 pickWallpaperId（自定义导入+工坊全库、排除当前），**手动/快捷键切换与自动轮播共用
  rotationCursor**（顺序游标连贯：手切三张后轮播从第四张起）；手动切换重置轮播计时（避免手切后紧跟自动跳）。agent
  keydown 分发表扩展为三 combo 匹配（可编辑目标豁免按「命中的那个 combo」判修饰键）。面板：单行升级为「快捷键」分
  组三行录制框（hotkeyRow 工厂，Esc 取消/退格清除/占位符显示默认值）。验证：contracts 白名单链自动对账（24
  sanitize ⊆ 31 public）、verify-hotkey 接线钉扩展、隔离池真机 /api/switch 三连发（next 两张按序、random 换图）。

- **D32 插件图标（1.0.18 内）**：按 plugin-creator 规范，icon 属于 **marketplace 条目**（`plugins[].icon`）而非
  plugin.json，取**可达 HTTPS URL**（不 fabricate）——指向仓库 raw 文件
  `raw.githubusercontent.com/Mazawar/zcode-wallpaper/main/docs/icon.png`，push main 后生效（本地市场在 URL 就绪前
  只是不显示图标，无害）。设计=简约三元素：圆角方块（rx 22%）+ 靛→紫垂直渐变（#4F7DF9→#8B5CF6）+ 白太阳 + 双层白
  波浪（壁纸的最小视觉叙事，16px 可读）。产出三件：docs/icon.svg（源）、docs/icon.png（512²，PowerShell GDI+
  渲染，抗锯齿，圆角 clip 防波浪出方角）、scripts/render-icon.ps1（可重渲染）。validate-plugin 的
  "Unresolved placeholder: dist/mcp/server.js" 是历史已知误报（esbuild 内联依赖源码的 TODO 注释，0.3.3 已确认）。

- **D33 卸载还原 + wrapper 卸载存活（1.0.19）**：用户卸载插件后从快捷方式启动 ZCode 直接报「找不到脚本文件 zw-launch.vbs」
  ——**0.4.1 卸载事故的结构性缺口没堵全**：当年给 VBS 加了「插件没了照样启动 ZCode」的 FileExists 守卫，但守卫写在
  VBS 文件里，卸载把数据目录（连同 VBS）一起删掉，.lnk → wscript → 不存在的脚本，守卫根本没机会执行。ZCode 无卸载
  钩子（插件卸载后我方代码不可能再运行），修复两层：①**还原**（主动）：卸载监视（installed_plugins.json 记录消失
  3 拍）在恢复默认外观退出**之前**调 restoreWrappedShortcuts——宿主进程卸载后仍存活一个会话期（0.4.15 实测），这是
  唯一的还原窗口；还原=把每个我方包装的 .lnk 改回直接指向 ZCode.exe（wrapper meta 恢复 zcode 路径 → resolveZcodeExe
  兜底），剥我方 CDP+防遮挡参数、保留用户自有参数，幂等（已还原/not-ours 跳过）。②**存活**（被动兜底）：wrapper
  四件套（vbs/cmd/meta/握手）搬到卸载不清理的自有目录 wrapperDir（win=%LOCALAPPDATA%\zcode-wallpaper，linux=
  ~/.local/share/zcode-wallpaper，mac 启动器 bundle 本就在 ~/Applications 伞下）——就算还原窗口错过（卸载瞬间关
  机/杀进程），悬空 .lnk 指向的 VBS 仍然存在，内置守卫照常「跳过 serve、无条件启动 ZCode」（无壁纸但能开）。发现/
  握手文件（zw-launch.json=wrapper meta 二合一、zw-ports.txt）随 wrapper 目录走（D29 读者全部经 paths.wrapperDir）。
  守卫：verify-shortcuts 真实执行还原脚本（包装→还原→COM 读回：target=meta 的 zcode、我方 flags 剥离、用户参数
  保留、幂等、非我方不碰）+ wrapperDir/接线钉。**守卫抓到真实运维险情：verify-ports 曾把测试端口写进真实
  LOCALAPPDATA wrapper meta——D33 后守卫重定向 LOCALAPPDATA 到临时目录，并当场清理了污染**。本机已用新代码跑
  ensure：两个 .lnk 已迁指 wrapperDir（卸载安全的启动链）。边界：卸载瞬间强杀宿主则还原窗口错过（靠②兜底）；
  wrapper 目录卸载后残留两个小文件（vbs+cmd，无害且自说明，重装后原地复用）。

- **D34 启动载荷惰性构建 → 挂载延迟 66 秒（1.0.19 内）**：用户报「壁纸挂不上，只面板」。页面 CDP 探针（video
  readyState/currentTime/__zwLog 飞行记录）还原真相：**挂上了，但慢了 66 秒**——06:44:13 注入只有引导薄 CSS（858 字
  节），06:45:17 全量载荷（3687 字节）才到、SET_SOURCE video 才发生。根因：serve 启动后**没有任何"启动即构建载荷"的
  调用**——SSE 订阅者拿到的 initial 是 currentRuntimePayload()=undefined，agent 一直用注入时嵌入的薄 head-start
  载荷，全量要等下一次不相关的 publishConfig（某次 heal/配置触碰）。「no boot-wave needed」的注释假设 holdSession
  首推会覆盖，宿主形态 serve + 裸重启 + 视频壁纸的实证推翻了它。双层修复：①startServe 在会话环启动前
  publishConfig(runtimeConfig(), allowDecode=true)（正确性优先于延迟，同 holdSession 首推契约）；②SSE 订阅时若仍无
  现成载荷 → 立即构建并广播（页面先于启动波连上的窗口也不落空）。方法论：**「挂不上」先 CDP 探页面真态（元素/
  readyState/飞行记录）再下结论——用户看到的失败可能是慢，不是没挂**。

- **D35 卸载还原保留启动参数（1.0.19 内）**：用户实测卸载→重装循环：「卸载时图标恢复了 ✓，但重装后图标很久才重新包装
  （「反应这么慢么」）」。生命周期真相：**ZCode 无任何重装钩子**——卸载还原后宿主退出，重装要等 ZCode 下一次会话才
  重新拉起宿主（我们无法在重装瞬间运行代码）；更糟的是 D33 的还原把 CDP+防遮挡参数一并剥掉了——宿主重 spawn 后，
  当前会话是普通方式启动的（无 CDP），注入不了，壁纸要等**下一次完整重启**才回来。修复：还原语义从「剥掉我方参数」
  改为「只剥离 wrapper 依赖（wscript+vbs），**CDP 端口与防遮挡参数保留在还原后的快捷方式上**」——目标照样是直接的
  ZCode.exe（用户看到的「恢复」不变），但重装后宿主第一次 spawn 就能注入正在运行的会话：壁纸无需重启即回，图标重
  包装只是随后的化妆步骤。守卫真实执行断言同步（flags 保留）。边界：卸载期间 CDP 端口保持开启（本地回环，与安装期
  同等暴露面）；无参数剥离意味着「绝对干净还原」不再成立——是「可即时复活的最小还原」。

- **D36 无感化三件套（1.0.19 内）**：用户要「恢复和注入无感、不需要等待」。可达性盘点：正常启动的主导延迟是
  **ZCode 自己 ~10s 的开窗时间**（改不动），我们的可控环节三处收紧——①**注入轮询自适应**（sessions.ts）：无持有会话
  时 400ms 快速轮询（启动/舰队重生），壁纸随渲染页出现 ≤0.5s 落地；持有后回落 1.5s 稳态；heal 从「20 tick 计数」改
  「30s 时间基准」（变步长下节奏不再漂移）。②**wrapper v9 探针自愈**：VBS/sh 启动时若烘焙 cli.js 失效（插件升级/
  重装 = 新版本目录），自动扫描插件缓存目录按 DateLastModified/-nt 取**最新** dist/cli.js，经 zw-serve.cmd 的 %1
  传给 serve——**重装后的第一次启动即满血**（早启 serve+注入），不再依赖「宿主先 spawn 过一轮 ensure」；sh 侧
  `sh -n` 语法门进守卫持续验证。③D35 的还原保留 CDP 参数（重装后宿主首次 spawn 即注入运行中会话）已是恢复链的
  运行时半边。诚实边界：**会话中途重装**的恢复时机仍由 ZCode 的宿主 spawn 调度决定（无钩子可挂，D35 保证那一刻
  即注入）；开窗前的那 ~10s 是 ZCode 本体的。教训：python 补丁 replace 静默失败（搜索串含运行时才生成的 ' 字符，
  源码里没有）——**批量替换必须 assert**。

- **D37 VBS 拼接编译错误 + 版本撞车终结（1.0.20）**：用户卸载测试时快捷方式启动弹 VBScript 编译错误（800A0401 语句未
  结束，行 66）——**D36 的 v9 探针块把 VBS 拼接写错了**：`sh.Run "<cmd>" "" & cliUse & ""`——两个字符串字面量直接并
  置没有 & 连接，VBScript 直接编译失败，wrapper 比「悬空」更糟（存在但编译不过）。为什么守卫和冒烟都没拦住：**smoke
  的抑制方式是把 sh.Run 行注释掉——恰好把我们每次都在改的行排除在 cscript 编译之外**（0.3.1 教训的新形态：抑制不
  得把被改代码排除出编译）。双修复：①生成器改 runline 变量（`runline = "<cmd>" & " " & """" & cliUse & """"`，
  VBS 合法拼接）+ 两处 spawn 全走 runline；②smoke 抑制改 **token 替换**（`sh.Run`→`NoopRun` 桩 Sub），整个文件仍被
  cscript 编译，并断言两条 serve spawn 的抑制日志在位。**版本撞车终结**：D33~D36 五个 commit 全部压在 1.0.19 上，
  市场快照/装机版无法区分新旧——用户机器上「我本地 ensure 写的坏 v9」被「装机旧 1.0.19 的 serve 重新烘焙回 v8」
  覆盖，同版本号互相践踏。bump **1.0.20** 终结；流程铁律补充：**凡部署到 .local-market 的变更必须 bump 版本**
  （同会话内多次部署同样各 bump）。裸名数据目录（用户点名违规）已删除——其中只有前天误运行的 wrapper 残留（无用户
  数据），D33 后 wrapper 不再写数据目录，此类残留不会再产生。关于 LOCALAPPDATA\zcode-wallpaper 为什么不能按
  「插件@市场」放：**ZCode 卸载时会清空 plugins/data/<plugin>@<market>（用户的卸载测试实证）**，幸存 wrapper 的
  存在意义就是活过卸载——放回机制数据目录等于恢复悬空 bug；该目录是插件自有小目录（vbs/cmd/meta/握手四个小文件，
  插件命名，可随手删）。
