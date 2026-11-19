/**
 * Guard: plugin-enablement resolution semantics (enablement.ts). The
 * precedence rule is pure and gets the full scenario treatment; the two
 * file-reading probes run against REAL temp files (write history is the
 * truth source, so what lands on disk must be read back exactly); the
 * consumers are pinned to consult the module (the serve's disable/uninstall
 * watches and the MCP host's gracefulShutdown must never drift back to
 * silence-based guesses).
 */
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tmp = path.join(os.tmpdir(), "zw-enablement-guard.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "src", "core", "enablement.ts")],
  outfile: tmp,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { resolveDisablement, readOwnScopeEntry, pluginDisabledKeyIn } = await import(pathToFileURL(tmp).href);

const failures = [];
function ok(cond, msg) {
  if (!cond) failures.push(msg);
  else console.log(`ok: ${msg}`);
}

// ── 1. pure precedence: newest explicit entry wins, ties lean disabled ─────
const E = (scope, disabled, mtime) => ({ scope, disabled, mtime });
ok(resolveDisablement("id", []) === null, "no entries at all → null (inconclusive)");
ok(resolveDisablement("id", [E("user", true, 100)]).scope === "user", "single disabled entry → disabled");
ok(resolveDisablement("id", [E("user", false, 100)]) === null, "single enabled entry → null");
ok(resolveDisablement("id", [E("user", false, 100), E("ws", true, 200)]).scope === "ws", "newer workspace disable outranks older user enable");
ok(resolveDisablement("id", [E("user", true, 100), E("ws", false, 200)]) === null, "newer workspace enable outranks older user disable");
ok(resolveDisablement("id", [E("user", false, 100), E("ws", true, 100)]).scope === "ws", "mtime tie → disabled wins (cannot prove newer intent; stopping is reversible)");
ok(resolveDisablement("id", [E("user", true, 100), E("ws", false, 300), E("ws2", true, 300)]).scope === "ws2", "tie among the newest still leans disabled");
ok(resolveDisablement("id", [E("user", true, 100)]).key === "id", "the verdict carries the triggering key");

// ── 2. own-id scope read against real files ─────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zw-enable-"));
const mkCfg = (name, entries, opts = {}) => {
  const p = path.join(dir, name);
  const cfg = { plugins: { enabledPlugins: Object.fromEntries(entries) } };
  fs.writeFileSync(p, JSON.stringify({ ...cfg, ...opts }));
  return p;
};
const cfgDisabled = mkCfg("disabled.json", [["zcode-wallpaper@dev", false]]);
const cfgEnabled = mkCfg("enabled.json", [["zcode-wallpaper@dev", true]]);
const cfgAbsent = mkCfg("absent.json", [["other@market", false]]);
const cfgGarbage = path.join(dir, "garbage.json");
fs.writeFileSync(cfgGarbage, "{not json");

ok(readOwnScopeEntry(cfgDisabled, "zcode-wallpaper@dev")?.disabled === true, "explicit false reads back disabled");
ok(readOwnScopeEntry(cfgEnabled, "zcode-wallpaper@dev")?.disabled === false, "explicit true reads back enabled");
ok(readOwnScopeEntry(cfgAbsent, "zcode-wallpaper@dev") === null, "absent id → null (no explicit intent)");
ok(readOwnScopeEntry(cfgGarbage, "zcode-wallpaper@dev") === null, "unparsable file → null, never a guess");
ok(typeof readOwnScopeEntry(cfgDisabled, "zcode-wallpaper@dev")?.mtime === "number", "the entry carries the file mtime (write history)");

// ── 3. conservative fallback (identity unknown) against real files ─────────
const cfgAllFalse = mkCfg("allfalse.json", [["zcode-wallpaper@a", false], ["zcode-wallpaper@b", false]]);
const cfgMixed = mkCfg("mixed.json", [["zcode-wallpaper@a", false], ["zcode-wallpaper@b", true]]);
ok(pluginDisabledKeyIn(cfgAllFalse) === "zcode-wallpaper@a+zcode-wallpaper@b", "every key false → disabled, keys returned for the log");
ok(pluginDisabledKeyIn(cfgMixed) === null, "any explicit true → not disabled under the fallback rule");
ok(pluginDisabledKeyIn(cfgAbsent) === null, "no zcode-wallpaper keys → inconclusive");
ok(pluginDisabledKeyIn(cfgGarbage) === null, "unparsable file → inconclusive");
ok(pluginDisabledKeyIn(path.join(dir, "missing.json")) === null, "missing file → inconclusive");

// ── 4. wiring pins: the consumers must consult enablement ───────────────────
const serverSrc = fs.readFileSync(path.join(root, "src", "core", "server.ts"), "utf8");
const mcpSrc = fs.readFileSync(path.join(root, "src", "mcp", "server.ts"), "utf8");
ok(serverSrc.includes('from "./enablement.js"'), "serve imports the enablement verdicts");
ok(serverSrc.includes("pluginDisabledBy(cfgPath)"), "the enablement watch consults pluginDisabledBy");
ok(serverSrc.includes("!!pluginDisabledBy(cfgPath)"), "the early host-watchdog verdict is gated on confirmed disablement (D27)");
ok(serverSrc.includes("ownPluginId()"), "the uninstall watch resolves its install identity");
ok(mcpSrc.includes('import("../core/enablement.js")'), "MCP gracefulShutdown resolves restore-vs-leave through enablement");

fs.rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.error("FAIL:", f);
  process.exitCode = 1;
}
console.log(process.exitCode ? "ENABLEMENT: FAILED" : "ENABLEMENT: ALL OK");
