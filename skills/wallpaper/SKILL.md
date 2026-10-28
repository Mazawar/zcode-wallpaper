---
name: wallpaper
description: Manage ZCode desktop client wallpapers via the zcode-wallpaper plugin MCP tools — enumerate the wallpaper library (Wallpaper Engine workshop subscriptions, WE projects AND locally imported wallpapers; Wallpaper Engine install is optional), apply scene/video wallpapers as live real-time rendered backgrounds (WebWallGL, no recording), import local .pkg/.zw.zip/video/image files, set static images, tune blur/dim/fit and Monet appearance.
---

# ZCode Wallpaper Skill

Use the `zcode-wallpaper` MCP tools (prefixed `mcp__plugin_zcode-wallpaper_zcode-wallpaper__`).
Diagnostics/troubleshooting is a separate skill: **`wallpaper-doctor`** — use that one when the
wallpaper or panel is not working.

- `list_wallpapers` — the local library: WE workshop subscriptions + WE projects + **locally
  imported** wallpapers. A missing Wallpaper Engine is expected and harmless (`wallpaperEngine: null`
  just means no auto-listed workshop items; imports and direct file paths work fine).
- `import_scene_wallpaper` / `set_background` — apply a wallpaper LIVE (real-time WebWallGL
  rendering: particles, SceneScript, mouse parallax; nothing recorded, WE does not need to run).
  Accepts a `.pkg` file, a wallpaper directory (project.json), a `.zw.zip` package, a video, an
  image, a workshop item id, or a library id from `list_wallpapers`.
- `apply_options` — blur, dim, Monet on/off, wallpaper visibility, fit (cover/contain/smart/
  stretch), live fps cap, audio mute. Blur does NOT zoom the framing (D16).
- `wallpaper_status` / `refresh_theme` / `reset_appearance`.

Cross-machine story: export any wallpaper as `.zw.zip` from the panel, import on a machine with
no Steam/WE at all — import works everywhere.

Prerequisites: ZCode must run with the CDP debug port. The plugin maintains the user's ZCode
shortcuts automatically (wrapper that starts the serve hidden, then launches ZCode with
`--remote-debugging-port`); if a session ever starts without it, `wallpaper_status` reports
`cdp: absent` — fully restarting ZCode fixes it (see `wallpaper-doctor`).

Steam/WE discovery: registry → common paths → `ZW_STEAM_ROOT` override; `libraryfolders.vdf`
expands libraries; workshop content lives under `<lib>/steamapps/workshop/content/431960/`.
