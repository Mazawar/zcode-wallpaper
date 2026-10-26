---
description: Manage the ZCode desktop client's wallpaper — enumerate subscribed Wallpaper Engine wallpapers, apply scenes as live animated backgrounds, upload images, and tune blur/dim/Monet appearance.
allowed-tools: mcp__zcode-wallpaper__*, Bash, Read
---

# /wallpaper — ZCode 壁纸管理

用 zcode-wallpaper 插件的 MCP 工具完成用户请求。常用流程：

1. **列出壁纸库**：`list_wallpapers` — 枚举本机 Wallpaper Engine 订阅（工坊）+
   本地工程，返回 `id / 类型(scene|video|web) / 大小 / 标题`。
2. **应用壁纸**：
   - 场景壁纸 → `import_scene_wallpaper`（path 或工坊 id）：**实时渲染**，保留粒子/
     SceneScript/鼠标视差，无需启动 Wallpaper Engine、不录制。
   - 静态图片 → `set_background`（image_path）。
3. **调节外观**：`apply_options`（blur / dim / monet / wallpaper_visible / fit /
   fps / muted）；重注入 `refresh_theme`；恢复默认 `reset_appearance`；查看状态
   `wallpaper_status`。

注意事项：

- 首次使用需要 ZCode 带 CDP 端口运行（插件会自动尝试；失败时提示用户
  完全退出 ZCode 后由插件重新拉起）。
- 动态壁纸需要插件的 serve 进程（随 MCP 自动启动）。
- 用户说的「换个壁纸」默认调 `list_wallpapers` 展示选项；指定了文件路径就直接应用。
