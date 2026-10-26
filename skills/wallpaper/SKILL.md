---
name: wallpaper
description: Manage ZCode desktop client wallpapers via the zcode-wallpaper plugin MCP tools — enumerate subscribed Wallpaper Engine wallpapers, apply scene wallpapers as live real-time rendered backgrounds (WebWallGL, no recording), set images, tune Monet appearance.
---

# ZCode Wallpaper Skill

Use the `zcode-wallpaper` MCP tools (tools are prefixed `mcp__zcode-wallpaper__`):

- `list_wallpapers` — enumerate the local Wallpaper Engine library (Steam workshop
  subscriptions + WE projects). Each entry: `id`, `type` (scene/video/web), size, title.
- `import_scene_wallpaper` — apply a scene/web/video wallpaper **live**: it is
  rendered in real time by WebWallGL inside ZCode (particles, SceneScript, mouse
  parallax all work; nothing is recorded; Wallpaper Engine does not need to run).
  Accepts a `.pkg`, a wallpaper directory, or a workshop item id.
- `set_background` — static image wallpaper (also routes scene/video inputs live).
- `apply_options` — tune blur, dim, Monet on/off, visibility, fit, live fps, mute.
- `refresh_theme` / `reset_appearance` / `wallpaper_status`.

Prerequisites: ZCode must run with the CDP debug port (the plugin appends it to
shortcuts on `launch`; otherwise the user must fully quit and relaunch ZCode via
the plugin). The serve process auto-starts with the plugin and owns the live
renderer HTTP surface on `127.0.0.1:9223`.

Steam/WE discovery: registry → common paths → `ZW_STEAM_ROOT` override;
`libraryfolders.vdf` expands libraries; workshop content lives under
`<lib>/steamapps/workshop/content/431960/`.
