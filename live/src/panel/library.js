/**
 * Wallpaper library rendering: search + pagination at a fixed grid height,
 * poster cards (dsh picker), current-wallpaper strip.
 */

import { CLS, el, button, toast } from "./controls.js";

export const TYPE_LABEL = { scene: "场景", video: "视频", web: "网页", image: "图片", unknown: "未知" };
export const ORIGIN_LABEL = { workshop: "工坊订阅", custom: "本机导入", default: "WE 内置", myprojects: "WE 工程" };

export function createLibrary({ API, PAGE_SIZE, post, state, ui }) {
  function fetchJson(url, opts) {
    return fetch(API + url, opts).then(function (r) { return r.json(); });
  }

  function filteredList(list) {
    var q = (state.filter || "").trim().toLowerCase();
    var t = state.typeF || "all";
    return list.filter(function (w) {
      if (t !== "all" && String(w.type || "") !== t) return false;
      if (!q) return true;
      var hay = ((w.title || "") + " " + (w.id || "") + " " + (TYPE_LABEL[w.type] || w.type || "") + " " + (ORIGIN_LABEL[w.origin] || w.origin || "")).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function render(list, currentId) {
    ui.libBox.textContent = "";
    ui.pagerBox.textContent = "";
    if (!list || !list.length) {
      ui.libBox.appendChild(el("div", CLS.stat, "未发现 Wallpaper Engine 壁纸。没有安装 Steam / Wallpaper Engine 也可以：点「导入壁纸…」导入 .zw.zip 资源包、.pkg 场景或视频文件。"));
      return;
    }
    var all = filteredList(list);
    if (!all.length) {
      ui.libBox.appendChild(el("div", CLS.stat, "没有匹配「" + state.filter + "」的壁纸"));
      return;
    }
    var pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (state.page >= pages) state.page = pages - 1;
    var slice = all.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

    // Poster grid (dsh picker): 16:9 image cards, title overlaid at the
    // bottom, type tag top-left, export/delete chips top-right. Inline styles
    // throughout — aspect-ratio & gradient utilities aren't in the app CSS.
    var grid = el("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;";
    grid.style.alignContent = "start";
    slice.forEach(function (w) {
      var sel = w.id === currentId;
      var card = el("div");
      card.style.cssText = "position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;cursor:pointer;" +
        "background:rgba(0,0,0,.3);border:1px solid " + (sel ? "var(--color-primary,#fff)" : "var(--color-border,#ffffff1a)") + ";" +
        (sel ? "box-shadow:0 0 0 1px var(--color-primary,#fff);" : "");
      var img = el("img");
      img.loading = "lazy";
      img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
      if (w.previewUrl) img.src = API + w.previewUrl;
      card.appendChild(img);
      var tag = el("span", null, TYPE_LABEL[w.type] || w.type || "");
      tag.style.cssText = "position:absolute;top:6px;left:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;line-height:1;padding:3px 6px;border-radius:4px;";
      card.appendChild(tag);
      if (sel) {
        var use = el("span", null, "使用中");
        use.style.cssText = "position:absolute;top:6px;right:6px;background:var(--color-primary,#fff);color:var(--color-primary-foreground,#000);font-size:11px;line-height:1;padding:3px 6px;border-radius:4px;";
        card.appendChild(use);
      } else {
        var chips = el("div");
        chips.style.cssText = "position:absolute;top:6px;right:6px;display:flex;gap:4px;";
        var mini = function (t, title, fn) {
          var mb = el("button", null, t);
          mb.type = "button";
          mb.title = title;
          mb.style.cssText = "background:rgba(0,0,0,.6);color:#fff;font-size:11px;line-height:1;padding:3px 6px;border-radius:4px;border:0;cursor:pointer;";
          mb.addEventListener("click", function (e) { e.stopPropagation(); fn(); });
          return mb;
        };
        chips.appendChild(mini("导出", "打包为 .zw.zip，可在另一台电脑导入", function () {
          var a = el("a");
          a.href = API + "/api/export?id=" + encodeURIComponent(w.id);
          a.download = "";
          document.body.appendChild(a);
          a.click();
          a.remove();
        }));
        if (w.origin === "custom") {
          chips.appendChild(mini("删除", "从库中删除（正在使用会自动切换）", function () {
            post("/api/delete-source", { id: w.id }).then(function (r) {
              if (r.error) { toast("删除失败：" + r.error); return; }
              toast("已删除「" + (w.title || w.id) + "」" + (r.switchedTo ? "，已切换到「" + r.switchedTo + "」" : ""));
              state.page = 0;
              state.onChanged && state.onChanged();
            }).catch(function (err) { toast("删除失败：" + (err && err.message ? err.message : "网络错误")); });
          }));
        }
        card.appendChild(chips);
      }
      var name = el("div", null, w.title || w.id);
      name.style.cssText = "position:absolute;left:0;right:0;bottom:0;padding:16px 8px 6px;color:#fff;font-size:12px;" +
        "background:linear-gradient(transparent,rgba(0,0,0,.78));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      card.appendChild(name);
      var lastApply = 0;
      card.addEventListener("click", function () {
        // Rapid card clicks queue heavy scene loads on the engine — swallow
        // anything within 600ms of the last one.
        if (Date.now() - lastApply < 600) return;
        lastApply = Date.now();
        post("/api/apply-source", { sourceId: w.id }).then(function (r) {
          if (!r.error) state.onChanged && state.onChanged();
        }).catch(function () {});
      });
      grid.appendChild(card);
    });
    ui.libBox.appendChild(grid);
    // Fixed height: remember the natural height of a FULL page and keep it for
    // short pages too, so the last page never collapses the section.
    requestAnimationFrame(function () {
      if (!grid.firstChild) return;
      if (!grid.offsetParent) return;
      if (slice.length === PAGE_SIZE && pages > 1) {
        state.gridH = grid.offsetHeight;
      }
      if (state.gridH) grid.style.minHeight = state.gridH + "px";
      else {
        var rows = Math.ceil(PAGE_SIZE / 4);
        grid.style.minHeight = (rows * grid.firstChild.offsetHeight + (rows - 1) * 8) + "px";
      }
    });

    var pager = el("div", "flex items-center justify-end gap-2 mt-2");
    var prev = button("上一页", function () { if (state.page > 0) { state.page--; render(state.lib && state.lib.wallpapers, state.lib && state.lib.current); } }, null, CLS.btnIcon);
    if (state.page === 0) { prev.disabled = true; prev.classList.add("opacity-50", "cursor-not-allowed"); }
    pager.appendChild(prev);
    pager.appendChild(el("span", "text-sm text-foreground-subtle", (state.page + 1) + " / " + pages + " 页 · 共 " + all.length + " 项" + (all.length !== list.length ? "（筛选自 " + list.length + "）" : "")));
    var next = button("下一页", function () { if (state.page < pages - 1) { state.page++; render(state.lib && state.lib.wallpapers, state.lib && state.lib.current); } }, null, CLS.btnIcon);
    if (state.page >= pages - 1) { next.disabled = true; next.classList.add("opacity-50", "cursor-not-allowed"); }
    pager.appendChild(next);
    ui.pagerBox.appendChild(pager);
  }

  // Current-wallpaper strip on the library tab: poster + title + badge.
  function renderCurrent(d) {
    if (!ui.curTitle) return;
    var cur = null;
    if (d && d.current && d.wallpapers) {
      for (var i = 0; i < d.wallpapers.length; i++) if (d.wallpapers[i].id === d.current) { cur = d.wallpapers[i]; break; }
    }
    if (cur) {
      ui.curTitle.textContent = cur.title || cur.id;
      ui.curMeta.textContent = (TYPE_LABEL[cur.type] || cur.type || "") + " · " + (ORIGIN_LABEL[cur.origin] || cur.origin || "");
      ui.curBadge.textContent = "使用中";
      ui.curBadge.style.display = "";
      if (cur.previewUrl) { ui.curPoster.src = API + cur.previewUrl; ui.curPoster.style.display = ""; }
      else ui.curPoster.style.display = "none";
    } else if (state.cfg && state.cfg.wallpaperSet) {
      ui.curTitle.textContent = "图片壁纸";
      ui.curMeta.textContent = "通过「导入壁纸…」设置的静态图片";
      ui.curBadge.textContent = "使用中";
      ui.curBadge.style.display = "";
      ui.curPoster.style.display = "none";
    } else {
      ui.curTitle.textContent = "未设置壁纸";
      ui.curMeta.textContent = "从下方壁纸库选择，或点「导入壁纸…」";
      ui.curBadge.style.display = "none";
      ui.curPoster.style.display = "none";
    }
  }

  return { render, renderCurrent };
}
