# 待办计划清单（D39 工程健康轮遗留）

> 2026-11-19 审计 + 五步重构（见 [DECISIONS.md](DECISIONS.md) D39）之后剩余事项，按价值/成本排序。
> 铁律沿用：凡部署 `.local-market` 的变更必须 bump 版本（D37）；push / Release 须用户明确同意。

## A · 立即可做（小件，一个下午内）— ✅ 2026-11-20 完成（1.0.23，见 DECISIONS D40）

### ~~A1. 补 ARCHITECTURE.md 的 console.log 补丁顺序禁令〔漏做项〕~~ ✅ 规则 7 已补
### ~~A2. biome 57 条 warning 清零~~ ✅ 0/0（顺藤摸出并修复 v10 探针真 bug：VBS/PS 生成串被 JS 转义吃掉分隔符——`distcli.js`，守卫断言同样退化故同瞎；详见 D40）
### ~~A3. bump 1.0.23 + 本机部署~~ ✅ 已部署 .local-market

## B · 观察型（依赖下一次 push）

### B1. CI 首跑观察：verify-shortcuts + smoke-vbs 转正
- **现状**：`.github/workflows/verify.yml` 里这两条 `continue-on-error: true`（真实 COM .lnk 往返 +
  cscript 编译，未在 runner 上验证过）。
- **动作**：push 后看第一次 CI 结果；连续 2~3 次绿 → 删掉 `continue-on-error` 那行转正为必过。
- **验收**：CI required 步骤含 verify-shortcuts 且不飘。

### B2. push + Release（等用户指令）
- 1.0.22（或并完 A 的 1.0.23）目前仅本地；发布需用户明确同意 + 代理 `127.0.0.1:7897`。

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
