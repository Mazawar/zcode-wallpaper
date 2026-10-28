---
name: wallpaper-doctor
description: Diagnose and repair the zcode-wallpaper plugin (排查/修复壁纸插件) — when the wallpaper or the settings panel is missing, frozen, wrong version, or the serve is down. Covers the #1 cause (ZCode launched without the CDP debug port), serve lifecycle & ownership handover, stale-generation eviction, log locations, wrapper/shortcut inspection on Windows/macOS/Linux, and safe repair operations. Use for any "壁纸没出现 / 面板没了 / 插件没生效 / not working / debug" situation.
---

# Wallpaper Doctor — 排查与修复手册

Constants: CDP port **28256**, serve API **28257**. First rule: **never kill the ZCode process
and never touch machine config (registry Run keys, autostart, LaunchAgents) — the plugin must
not modify the computer, and neither should you.** Restarting ZCode is the universal safe fix.

## Step 1 — always start here

Call `wallpaper_status` (MCP) or `GET http://127.0.0.1:28257/api/health`:

| Observation | Verdict | Action |
|---|---|---|
| `cdp: "absent …"` + `hint` | **This ZCode launch has no debug port** — injection is impossible for the whole session (unwrapped/overwritten shortcut, or ZCode started directly). Shortcuts are auto-healed already. | Fully quit ZCode, relaunch from the (healed) shortcut. Done. |
| `serve: "not running"` | No serve at all (plugin just installed, update race, or crashed). | Check host process & logs below; usually fixed by restarting ZCode. Interim bridge: `node <plugin-cache>/<version>/dist/cli.js serve --detach`. |
| `version` ≠ installed plugin version in `<zcode>/cli/plugins/installed_plugins.json` | A serve from an older generation still owns the port. | Newer hosts evict it automatically (`POST /api/retire` forces it). |
| All healthy but user sees nothing | Page/window layer — go to Step 3. | |

## Step 2 — where the evidence lives

Data dir resolution (D23): `ZW_DATA_DIR` env → else derived from the install layout
`plugins/data/<plugin>@<marketplace>` → else legacy sandbox `~/.zcode/cli/plugins/data/zcode-wallpaper`.
Both dirs can exist; the ACTIVE one contains the freshest `zw-serve.log`.

- `zw-serve.log` — wrapper boot trace (`vbs:` lines), serve boot identity (`pid=… early=… mcpHost=… v…`),
  full serve stdout (D22 tee), `[live:*]` renderer diagnostics. First stop for any boot question.
- `GET /api/log` — serve ring buffer (recent events, live render trace).
- `live-failures.json` (data dir) — hard live-render failures with reasons; `POST /api/live-retry`
  clears the memory and retries.
- `host-crash.log` (data dir) — MCP host fatal signals (uncaughtException / SIGTERM journal).
- `GET /api/transfer` — byte ledger during wallpaper assembly ("downloading ≠ broken").
- Enablement state: user `~/.zcode/cli/config.json` + each active workspace `<ws>/.zcode/config.json`
  — any explicit `false` disables; a *missing* entry means enabled.

## Step 3 — symptom table

| Symptom | Root cause | Fix |
|---|---|---|
| Panel never appears, `cdp: absent` | Launch bypassed the wrapped shortcut (updater overwrote the .lnk, renamed shortcut, direct ZCode.exe start) | Restart ZCode; wrapper re-applied automatically (D24 also discovers shortcuts by TARGET, not name) |
| Wallpaper gone right after a plugin update | Old-generation serve lingered / handover | Host auto-retires stale versions; if needed `POST /api/retire`, then the host starts its own |
| Wallpaper disappears when window is occluded/backgrounded | Anti-occlusion flags missing from the launch args | Verify shortcut args include `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`; restart |
| ZCode won't start from the shortcut | Wrapper is hardened to be UNABLE to block launches (D18/D19: node+plugin existence guards, unconditional ZCode line, stale-path re-probe). If a dialog appears, even the probe failed. | Launch ZCode.exe directly from its install folder once — the plugin repairs the shortcut next session |
| Live scene stuck on poster | Transfer or renderer failure (reason in `live-failures.json`) | `POST /api/live-retry`; re-pick the wallpaper to clear failure memory |
| Serve died at boot, nothing re-armed | VBS/sh wrapper second chance re-arms at +25s; host retries every 10s | Both automatic; if still down, bridge serve (Step 1) and read `zw-serve.log` |
| Node was moved/updated (nvm) | Wrapper bakes the node path; a move degrades ONE session to "no early serve" | Self-heals next plugin session; verify node resolves on PATH |
| Blurred wallpaper shows a zoomed framing | Only expected on videos without a preview image (D16 fallback) | None needed; or import with a preview |
| Everything healthy but colors/wallpaper stale in UI | Session held across serve handover | `refresh_theme` (MCP) or toggle the wallpaper once |

## Step 4 — platform inspection

**Windows** — shortcut & wrapper:
```powershell
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('<Desktop>\ZCode.lnk')
$s.TargetPath; $s.Arguments   # expect wscript.exe + "…\zw-launch.vbs" + --remote-debugging-port=28256 …
```
The generated `zw-launch.vbs` must contain marker `zw-wrapper-v7`, FileExists guards for BOTH node
and cli, and an unconditional ZCode launch line. Never hand-edit it — regenerated every session.

**macOS** — launcher `~/Applications/ZCode Wallpaper.app` (shell script starts serve, then
`open -a ZCode --args …`). **Linux** — `~/.local/share/applications/*.desktop` Exec rewritten to a
wrapper script (system-wide entries need root and are left alone).

## Lifecycle cheat sheet (how ownership works)

1. Shortcut wrapper starts `serve --early` hidden BEFORE ZCode → owns port 28257, injects at ~1s.
2. Plugin host (MCP) spawns ~10s later → sees a healthy same-version serve → idles and heartbeats
   `/api/host-alive` every 10s (host races are covered: the early serve no longer self-retires).
3. Different version on the port → host retires it and takes over. ZCode gone 60s → early serve
   exits. Explicit disable/uninstall → serve restores default appearance and exits.
4. Page runtime survives serve handovers (mounted iframe is adopted; SSE reconnects).

## Repair operations (safe, in order of preference)

1. Restart ZCode fully (fixes CDP-absence, host races, generation handovers).
2. MCP: `refresh_theme`, `apply_options` (re-push), `reset_appearance` (restore default look).
3. HTTP: `POST /api/live-retry`, `POST /api/retire` (force serve handover).
4. Bridge (ZCode alive, no serve): `node <cache>/<plugin>/<version>/dist/cli.js serve --detach`.
5. Report: attach `zw-serve.log` + `wallpaper_status` output — the log is designed to attribute
   every failure (D22 exists precisely so "died with zero evidence" cannot recur).
