/**
 * Guard: the guard map is a generated artifact (dsh discipline). guards.json
 * is the single source; docs/GUARD-MAP.md must match what it regenerates,
 * byte for byte, and every file each guard claims must exist.
 *
 *   node scripts/verify-guard-map.mjs           — verify only
 *   node scripts/verify-guard-map.mjs --write   — regenerate the doc
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const table = JSON.parse(fs.readFileSync(path.join(root, "scripts/guards.json"), "utf8"));
const docPath = path.join(root, "docs/GUARD-MAP.md");

function render() {
  const lines = [
    "# 守卫地图（生成物，勿手改）",
    "",
    "> 由 `node scripts/verify-guard-map.mjs --write` 从 [scripts/guards.json](../scripts/guards.json) 重算；`verify-guard-map.mjs` 会重算并逐字比对。",
    "> **怎么用**：改了某个文件，在「文件 → 守卫」表里查该跑哪几条。守卫一律 `node scripts/<id>` 运行（e2e 除外，见其 what）。",
    "",
    `守卫 ${table.guards.length} 个 · 覆盖文件 ${new Set(table.guards.flatMap((g) => g.files)).size} 个`,
    "",
    "## 守卫 → 文件",
    "",
    "| 守卫 | 校验什么 | 覆盖文件 |",
    "|---|---|---|",
  ];
  for (const g of table.guards) {
    lines.push(`| \`${g.id}\` | ${g.what} | ${g.files.map((f) => `\`${f}\``).join(" ")} |`);
  }
  lines.push("", "## 文件 → 守卫", "", "| 文件 | 守卫 |", "|---|---|");
  const byFile = new Map();
  for (const g of table.guards) for (const f of g.files) {
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(g.id);
  }
  for (const [f, gs] of [...byFile.entries()].sort()) lines.push(`| \`${f}\` | ${gs.map((g) => `\`${g}\``).join(" ")} |`);
  lines.push("");
  return lines.join("\n");
}

const rendered = render();
if (process.argv.includes("--write")) {
  fs.writeFileSync(docPath, rendered);
  console.log(`verify-guard-map: docs/GUARD-MAP.md regenerated (${table.guards.length} guards)`);
}

const failures = [];
for (const g of table.guards) {
  for (const f of g.files) {
    if (!fs.existsSync(path.join(root, f))) failures.push(`${g.id} claims missing file: ${f}`);
  }
}
if (!process.argv.includes("--write")) {
  if (!fs.existsSync(docPath)) failures.push("docs/GUARD-MAP.md missing — run with --write");
  else if (fs.readFileSync(docPath, "utf8") !== rendered) failures.push("docs/GUARD-MAP.md is stale — regenerate with --write after editing scripts/guards.json");
}

if (failures.length) {
  console.error(`verify-guard-map: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
if (!process.argv.includes("--write")) console.log(`verify-guard-map: OK (${table.guards.length} guards, all claimed files exist, doc in sync)`);
