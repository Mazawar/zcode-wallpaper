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
