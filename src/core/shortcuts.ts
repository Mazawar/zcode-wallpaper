/**
 * Persists the CDP debug-port flag into every ZCode launch shortcut.
 *
 * ZCode only accepts --remote-debugging-port at process start, so a shortcut
 * without it means no injection for that whole session (wallpaper/panel never
 * appear). Scans the usual .lnk locations, appends the flag where missing.
 * Idempotent; the all-users Start Menu may need elevation — reported, never
 * prompted (no UAC popups from a background serve).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileP as exec } from "./exec.js";

export interface ShortcutSyncResult {
  /** Shortcuts that gained the flag this run. */
  updated: string[];
  /** Shortcuts already carrying the flag (or not pointing at ZCode.exe). */
  skipped: string[];
  /** Shortcuts that could not be saved (typically ProgramData without elevation). */
  failed: Array<{ path: string; reason: string }>;
}

/** Directories that hold ZCode launch shortcuts, in priority order. */
function shortcutDirs(): string[] {
  const home = process.env.USERPROFILE ?? "";
  const appData = process.env.APPDATA ?? "";
  return [
    // Desktop may be OneDrive-redirected; cover both physical locations.
    path.join(home, "Desktop"),
    ...(process.env.OneDrive ? [path.join(process.env.OneDrive, "Desktop")] : []),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join("C:", "ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
  ];
}

export async function ensureShortcutsHaveCdpFlag(port: number): Promise<ShortcutSyncResult> {
  if (process.platform !== "win32") return { updated: [], skipped: [], failed: [] };
  const result: ShortcutSyncResult = { updated: [], skipped: [], failed: [] };

  const links: string[] = [];
  const collect = (dir: string) => {
    links.push(...fs.readdirSync(dir).filter((f) => /^zcode/i.test(f) && f.endsWith(".lnk")).map((f) => path.join(dir, f)));
  };
  for (const dir of shortcutDirs()) {
    try {
      collect(dir);
      // One subdirectory level (desktop folders like "agent", start-menu groups).
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        try {
          collect(path.join(dir, sub.name));
        } catch {
          /* unreadable subdir */
        }
      }
    } catch {
      /* dir absent */
    }
  }
  if (links.length === 0) return result;

  // Early-launch wrapper: ZCode spawns plugin hosts ~10s after boot while the
  // renderer page exists at ~1s. Shortcuts get repointed at a generated .vbs
  // that starts the wallpaper serve hidden FIRST, then launches ZCode with
  // the same flags — everything discovered at runtime (ZCode exe from the
  // shortcut's own original target, node from the very process running this
  // plugin, plugin root by probing), so the plugin stays portable.
  const launcher = discoverLauncher();

  const antiOcclusion = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];
  for (const lnk of links) {
    const script = `
$ErrorActionPreference = 'Stop'
try {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}')
  $vbs = '${launcher.vbs.replace(/'/g, "''")}'
  $meta = Get-Content -Raw '${launcher.meta.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ConvertFrom-Json
  $zcode = $null
  if ($s.TargetPath -match 'ZCode\.exe$') { $zcode = $s.TargetPath }
  elseif ($s.TargetPath -match 'wscript\.exe$' -and ([string]$s.Arguments) -like '*zw-launch.vbs*' -and $meta) { $zcode = $meta.zcode }
  if (-not $zcode) { Write-Output 'ok|not-zcode'; exit }
  if (-not (Test-Path $zcode)) { Write-Output 'ok|zcode-missing'; exit }
  $anti = @('${antiOcclusion.join("', '")}')
  # rebuild zcode args: strip wrapper reference + managed flags, append canonical
  $argStr = ([string]$s.Arguments) -replace '^"[^"]*zw-launch\.vbs"\s*','' -replace '^\S*zw-launch\.vbs\s*',''
  $parts = @($argStr -split ' ' | Where-Object { $_ -ne '' -and $_ -notlike '--remote-debugging-port=*' -and $anti -notcontains $_ })
  $canonical = @('--remote-debugging-port=${port}') + $anti
  $zargs = ($parts + $canonical) -join ' '
  $newArgs = '"' + $vbs + '" ' + $zargs
  if ($s.TargetPath -eq 'wscript.exe' -and ([string]$s.Arguments) -eq $newArgs) { Write-Output 'ok|has-flag'; exit }
  $icon = $zcode + ',0'
  if (-not $s.IconLocation -or $s.IconLocation -eq ',0' -or $s.IconLocation -like '*zw-launch*') { $s.IconLocation = $icon }
  $s.WorkingDirectory = Split-Path $zcode -Parent
  $s.TargetPath = 'wscript.exe'
  $s.Arguments = $newArgs
  $s.Save()
  Write-Output ('updated|' + $zcode)
} catch { Write-Output ('err|' + $_.Exception.Message) }`;
    try {
      const { stdout } = await exec("powershell", ["-NoProfile", "-Command", script], { timeout: 15_000, windowsHide: true });
      const out = stdout.trim();
      if (out.startsWith("updated")) {
        result.updated.push(lnk);
        const zcode = out.slice(out.indexOf("|") + 1);
        if (zcode) writeEarlyLaunchWrapper(port, zcode, launcher);
      } else if (out.startsWith("err")) result.failed.push({ path: lnk, reason: out.slice(4) });
      else result.skipped.push(lnk);
    } catch (err) {
      result.failed.push({ path: lnk, reason: (err as Error).message });
    }
  }
  return result;
}

/** Where the generated wrapper lives: next to the plugin's dist/cli.js,
 *  located by probing upward (tsc layout, bundle layout, cache installs). */
function discoverLauncher(): { vbs: string; meta: string } {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "dist", "cli.js"))) break;
    dir = path.dirname(dir);
  }
  return { vbs: path.join(dir, "zw-launch.vbs"), meta: path.join(dir, "zw-launch.json") };
}

/** Writes zw-launch.vbs (+ meta json). The ZCode path comes from the user's
 *  own shortcut (discovered per machine — nothing hardcoded); node is the
 *  process running the plugin right now. Idempotent. */
function writeEarlyLaunchWrapper(port: number, zcode: string, launcher: { vbs: string; meta: string }): void {
  const anti = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];
  const cli = path.join(path.dirname(launcher.vbs), "dist", "cli.js");
  const node = process.execPath;
  if (!fs.existsSync(cli) || !fs.existsSync(node)) return;
  // VBS string literals double every embedded quote; sh.Run takes a full
  // command line, so each token is quoted and every quote doubled.
  const DQ = String.fromCharCode(34);
  const vbq = (v: string) => DQ + DQ + v + DQ + DQ;
  const serveCmd = [vbq(node), vbq(cli), "serve", "--early", "--port", String(port), "--api-port", String(port + 1)].join(" ");
  const zcodeCmd = [vbq(zcode), "--remote-debugging-port=" + port].concat(anti).join(" ");
  const lines = [
    String.fromCharCode(39) + " zcode-wallpaper early launch (generated by the plugin)",
    String.fromCharCode(39) + " Starts the wallpaper serve hidden BEFORE ZCode so the renderer page",
    String.fromCharCode(39) + " is injected the moment it exists (plugin hosts spawn ~10s later).",
    "Set sh = CreateObject(\"WScript.Shell\")",
    DQ + serveCmd + DQ + ", 0, False",
    DQ + zcodeCmd + DQ + ", 1, False",
  ];
  try {
    const prev = fs.existsSync(launcher.meta) ? (JSON.parse(fs.readFileSync(launcher.meta, "utf8")) as Record<string, unknown>) : {};
    fs.writeFileSync(launcher.meta, JSON.stringify({ ...prev, zcode, port }, null, 1));
    const crlf = String.fromCharCode(13, 10);
    fs.writeFileSync(launcher.vbs, lines.join(crlf) + crlf, { encoding: "utf8" });
  } catch {
    /* unwritable location - shortcuts fall back to plain flag mode */
  }
}
