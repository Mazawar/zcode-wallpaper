/**
 * Guard: shortcut wrapping coverage + fallback launcher (D30). The Win10
 * report: the desktop shortcut "never got wrapped" — the installer had put
 * it on the ALL-USERS desktop (C:\Users\Public\Desktop), which the scan
 * never looked at, and admin-owned entries can't be rewritten without
 * elevation. Pins: the scan covers the public desktop, outcome parsing
 * distinguishes already-wrapped from not-ZCode, the fallback creation
 * script builds a working wscript launcher idempotently (executed for real
 * against a scratch dir and read back through COM), and the server flow
 * only creates the fallback when nothing ended up wrapped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(os.tmpdir(), `zw-shortcuts-guard-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const failures = [];
const ok = (cond, msg) => {
  if (!cond) failures.push(msg);
  else console.log(`ok: ${msg}`);
};

const bundled = path.join(tmp, "shortcuts.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "src", "core", "shortcuts.ts")],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const sc = await import(pathToFileURL(bundled).href);

// ── scan coverage ────────────────────────────────────────────────────────────
process.env.USERPROFILE = path.join(tmp, "home");
process.env.APPDATA = path.join(tmp, "appdata");
delete process.env.OneDrive;
process.env.PUBLIC = path.join(tmp, "public");
const dirs = sc.shortcutDirs();
ok(dirs.some((d) => d === path.join(tmp, "public", "Desktop")), "scan covers the ALL-USERS desktop (the Win10 gap)");
ok(dirs.some((d) => d === path.join(tmp, "home", "Desktop")), "scan covers the user desktop");
ok(dirs.some((d) => d.includes("TaskBar")), "scan covers pinned taskbar entries");

// ── outcome parsing: has-flag must count as wrapped, not-zcode must not ──────
ok(sc.parseLnkOutcome("updated|D:\\Z\\ZCode.exe").kind === "updated", "updated parses");
ok(sc.parseLnkOutcome("ok|has-flag|D:\\Z\\ZCode.exe").kind === "has-flag", "has-flag parses");
ok(sc.parseLnkOutcome("ok|not-zcode").kind === "not-zcode", "not-zcode parses");
ok(sc.parseLnkOutcome("ok|zcode-missing|D:\\gone\\ZCode.exe").kind === "zcode-missing", "zcode-missing parses");
ok(sc.parseLnkOutcome("err|Access denied").kind === "err", "err parses");
ok(sc.parseLnkOutcome("ok|has-flag|D:\\Z\\ZCode.exe").zcode === "D:\\Z\\ZCode.exe", "has-flag carries the zcode path");

// ── the fallback creation script, EXECUTED for real ──────────────────────────
const vbsFile = path.join(tmp, "zw-launch.vbs");
fs.writeFileSync(vbsFile, "' smoke vbs\r\n", "utf8");
const zcode = process.execPath; // a real existing exe stands in for ZCode.exe
const lnkPath = path.join(tmp, "ZCode Wallpaper.lnk");
const readBack = `
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}')
Write-Output ([string]$s.TargetPath)
Write-Output ([string]$s.Arguments)
Write-Output ([string]$s.IconLocation)`;
const runPs = async (script) => {
  const { stdout } = await exec("powershell", ["-NoProfile", "-Command", script], { timeout: 20_000, windowsHide: true });
  return stdout.trim();
};
ok((await runPs(sc.buildCreateFallbackScript(vbsFile, zcode, lnkPath))) === "created", "fallback script creates the launcher");
const [target, args, icon] = (await runPs(readBack)).split(/\r?\n/);
ok(target.endsWith("wscript.exe"), `launcher targets wscript.exe (got ${target})`);
ok(args === `"${vbsFile}"`, "launcher arguments are exactly the quoted VBS path");
ok(icon.startsWith(zcode) && icon.endsWith(",0"), "launcher icons from the ZCode exe");
ok((await runPs(sc.buildCreateFallbackScript(vbsFile, zcode, lnkPath))) === "skip", "second run skips (idempotent)");
ok(/^ZCode/i.test(sc.FALLBACK_LNK_NAME), "fallback name is recollected by the next scan's zcode* name match");

// ── wiring pins ──────────────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(root, "src", "core", "shortcuts.ts"), "utf8");
ok(src.includes("if (wrappedCount === 0)"), "fallback creation fires only when nothing ended up wrapped");
ok(src.includes('kind === "updated" || kind === "has-flag"'), "already-wrapped entries count toward coverage");
ok(src.includes("path.join(pub, \"Desktop\")"), "public desktop wired into the scan list");
ok(src.includes("resolveZcodeExe()") && src.includes("Get-CimInstance Win32_Process"), "zcode resolution probes the running instance");

// ── D33: wrapper dir survives uninstall + the restore path ───────────────────
const pathsSrc = fs.readFileSync(path.join(root, "src", "core", "paths.ts"), "utf8");
ok(pathsSrc.includes("LOCALAPPDATA") && pathsSrc.includes("zcode-wallpaper"), "wrapperDir keeps the wrapper outside the uninstalled data dir (win)");
ok(fs.readFileSync(path.join(root, "src", "core", "server.ts"), "utf8").includes("restoreWrappedShortcuts()"), "the uninstall watch restores shortcuts before exiting");
const portsSrc = fs.readFileSync(path.join(root, "src", "core", "ports.ts"), "utf8");
ok(portsSrc.includes("wrapperDir()") && !portsSrc.includes('dataDir(), "zw-launch.json"'), "discovery + handshake follow the wrapper dir");

// buildRestoreShortcutScript, EXECUTED for real: wrap → restore → read back.
const anti = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];
const fakeVbsDir = path.join(tmp, "wrapdir");
fs.mkdirSync(fakeVbsDir, { recursive: true });
const fakeVbs = path.join(fakeVbsDir, "zw-launch.vbs");
fs.writeFileSync(fakeVbs, "' smoke\r\n", "utf8");
fs.writeFileSync(
  path.join(fakeVbsDir, "zw-launch.json"),
  JSON.stringify({ zcode: process.execPath, node: "n", cli: "c" }),
  "utf8"
);
const wrapLnk = path.join(tmp, "ZCode.lnk");
const zcodeExe = process.execPath;
const wrapArgs = `"${fakeVbs}" --remote-debugging-port=28256 ${anti.join(" ")} --my-own-flag`;
await runPs(`
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('${wrapLnk.replace(/'/g, "''")}')
$s.TargetPath = 'wscript.exe'
$s.Arguments = '${wrapArgs.replace(/'/g, "''")}'
$s.Save()`);
const restoredOut = await runPs(sc.buildRestoreShortcutScript(wrapLnk, "", anti));
ok(restoredOut.startsWith("restored"), "restore script unwraps a wrapped entry");
const rb = (await runPs(`
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('${wrapLnk.replace(/'/g, "''")}')
Write-Output ([string]$s.TargetPath)
Write-Output ([string]$s.Arguments)`)).split(/\r?\n/);
ok(rb[0] === zcodeExe, `restored target is the meta's ZCode exe (got ${rb[0]})`);
ok(rb[1] === "--my-own-flag", `our flags stripped, user args kept (got "${rb[1]}")`);
ok((await runPs(sc.buildRestoreShortcutScript(wrapLnk, "", anti))).startsWith("not-ours"), "second restore skips the now-plain entry (idempotent)");
const plain = path.join(tmp, "Other.lnk");
await runPs(`
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('${plain.replace(/'/g, "''")}')
$s.TargetPath = '${zcodeExe.replace(/'/g, "''")}'
$s.Save()`);
ok((await runPs(sc.buildRestoreShortcutScript(plain, "", []))).startsWith("not-ours"), "non-wrapped entries are never touched");

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.error("FAIL:", f);
  process.exitCode = 1;
}
console.log(process.exitCode ? "SHORTCUTS: FAILED" : "SHORTCUTS: ALL OK");
