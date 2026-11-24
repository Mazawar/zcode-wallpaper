# 待办计划清单（D39 工程健康轮遗留）

> 2026-11-19 审计 + 五步重构（见 [DECISIONS.md](DECISIONS.md) D39）之后剩余事项，按价值/成本排序。
> 铁律沿用：凡部署 `.local-market` 的变更必须 bump 版本（D37）；push / Release 须用户明确同意。

## A · 立即可做（小件，一个下午内）— ✅ 2026-11-20 完成（1.0.23，见 DECISIONS D40）

### ~~A1. 补 ARCHITECTURE.md 的 console.log 补丁顺序禁令〔漏做项〕~~ ✅ 规则 7 已补
### ~~A2. biome 57 条 warning 清零~~ ✅ 0/0（顺藤摸出并修复 v10 探针真 bug：VBS/PS 生成串被 JS 转义吃掉分隔符——`distcli.js`，守卫断言同样退化故同瞎；详见 D40）
### ~~A3. bump 1.0.23 + 本机部署~~ ✅ 已部署 .local-market

## B · 观察型（依赖下一次 push）

### B1. CI 首跑观察：verify-shortcuts + smoke-vbs 转正 — 进行中（2026-11-24 两跑证据）
- **run 1（45396729183，红）**：verify:ci 挂在 verify-guard-map——windows runner `autocrlf=true` 把 LF 检出成
  CRLF，全文件逐字节比对炸（已修：守卫比对前归一化行尾，4f176d0）。typecheck/lint/build 全绿。
- **run 2（45397155059，绿 1m57s）**：hermetic 守卫全过；real-machine 步骤（continue-on-error）内部数据：
  **verify-shortcuts（COM .lnk 往返）在 runner 上全过**；**smoke-vbs cscript 静默失败**（"cscript failed:" 空
  stderr，未到启动行——疑似 runner 无交互桌面 / 25s Sleep 与超时交互，待单独排查）。
- **下一步**：①smoke-vbs 的 runner 失败根因（本机过、runner 挂，差异在 cscript 执行环境）；②smoke 修好 +
  verify-shortcuts 连续 2~3 次绿后，把步骤拆开转正（shorts 必过 / smoke 视情况），删 continue-on-error。
- **注意**：token 需含 `workflow` scope 才能 push 工作流改动（2026-11-24 已通过 gh auth refresh -s workflow
  授予；GCM 旧条目仍是 repo-only，推送工作流时用 `git -c credential.helper='!gh auth git-credential'`）。

### ~~B2. push + Release~~ ✅ v1.0.23 已发布（2026-11-24，Release v1.0.23 = latest，asset zcode-wallpaper-1.0.23.zip 1294844B，tag 4f176d0）

## C · 可选大件（暂缓，做前先评估）

### C1. shortcuts.ts 按平台物理拆分
- **现状**：文件内去重已完成（-70 行，~950 行单一职责）；拆 `shortcuts/{windows,macos,linux,common}.ts`
  需同步改 verify-ports / verify-shortcuts 的文件读取路径 + guards.json + GUARD-MAP 再生成。
- **建议**：等下次必须大改 shortcuts 时顺势做，不为拆而拆。

### C2. BeautifyConfig 类型分组
- 35+ 字段扁平对象 → `picture`/`playback`/`hotkeys`/`rotation` 嵌套**仅类型层面**（序列化形状不变，
  config.json 兼容不动）。触碰面大（inject/configApi/payload/panel 全链），收益中等；做前需
  verify-contracts 护航，必要时分两步。

---
*完成一项就划掉并在提交信息里引用编号（如 `chore: A1 — …`）；全清后本文件归档进 DECISIONS 或删除。*
