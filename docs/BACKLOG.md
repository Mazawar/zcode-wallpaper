# 待办计划清单（D39 工程健康轮遗留）

> 2026-11-19 审计 + 五步重构（见 [DECISIONS.md](DECISIONS.md) D39）之后剩余事项，按价值/成本排序。
> 铁律沿用：凡部署 `.local-market` 的变更必须 bump 版本（D37）；push / Release 须用户明确同意。

## A · 立即可做（小件，一个下午内）

### A1. 补 ARCHITECTURE.md 的 console.log 补丁顺序禁令〔漏做项〕
- **什么**：mcp/server.ts 必须先把 console.log 改道 stderr（MCP framing 保护），server.ts 只能被
  **动态 import**——两处猴补丁的顺序是隐式契约，谁把 import 提成静态的就打爆 stdio framing。
  在 ARCHITECTURE.md「规则」区写一条显式禁令（D39 时说了要做，只写了 enablement.ts 那行，漏了这条）。
- **量级**：纯文档，10 分钟，无版本影响（docs/ 不进市场交付面）。
- **验收**：规则区新增一条，明确「mcp/server.ts 对 core/server.js 仅限动态 import」。

### A2. biome 57 条 warning 清零（已知债清单）
- **构成**：未用变量/参数/ import ≈34（多为页面运行时回调未用的 `ev`/`_` 参数，改名或删）；
  `noExplicitAny` 10（cdp.ts 的 pending map、configApi 的 `sanitize(body: any)` 等，补真实类型）；
  非空断言 5；`noPrototypeBuiltins` 2（state.js）；`useImportType` 2；其余零星。
- **量级**：约 1 小时，机械但需逐处过目（守卫执行真实代码，改错会立刻被抓）。
- **验收**：`npm run lint` 0 error **0 warning**；11 守卫 + smoke-vbs 全绿；`npm run build` 产物同步。
- **注意**：触及 dist/live 产物 → 若随后部署 `.local-market` 必须 bump（并入 A3）。

### A3. bump 1.0.23 + 本机部署（做完 A2 后）
- `node scripts/version.mjs 1.0.23` → build → verify 全绿 → commit → `npm run market`。

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
