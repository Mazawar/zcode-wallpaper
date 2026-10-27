/**
 * The wallpaper settings section, mounted into ZCode's Settings → Appearance
 * (外观) page as a native-looking custom section (mount.js owns placement and
 * lifecycle). Served as a real file (/panel.js); talks to the serve control
 * API over CORS-enabled fetch and subscribes to the same SSE stream the agent
 * uses, so every config change refreshes it live.
 *
 * 0.4.0: live hard-failure is visible — when serve downgraded a live source
 * to poster-only (D6), the panel shows the reason and a retry button instead
 * of pretending the wallpaper is fine.
 */

import {
  CLS, el, button, dropdown, setSwitch, makeSwitch, ensureSliderStyle,
  paintRange, syncRange, makeSeg, setSeg, prow, groupLabel, toast,
} from "./controls.js";
import { createLibrary } from "./library.js";
import { MARKER, createMountLoop } from "./mount.js";

(function () {
  if (window.__zwPanel) return;
  window.__zwPanel = true;

  const API = window.__zwApiBase || "http://127.0.0.1:28257";
  const PAGE_SIZE = 15;

  const timers = [];
  const observers = [];
  let es = null;
  const reg = {
    every(fn, ms) { const t = setInterval(fn, ms); timers.push(t); return t; },
    timer(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; },
    observer(o) { observers.push(o); },
  };

  const state = { cfg: null, lib: null, page: 0, filter: "", typeF: "all", gridH: 0, tab: "lib" };
  const ui = { libBox: null, pagerBox: null, badge: null, search: null, failBox: null };

  function fetchJson(url, opts) {
    return fetch(API + url, opts).then(function (r) { return r.json(); });
  }
  function post(path, body) {
    return fetchJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function pushConfig(patch) {
    post("/api/config", patch).catch(function () {});
  }
  // Debounced+merged push for slider drags: 'input' fires at pointer
  // frequency; the merge keeps bursts down to one request per 180ms.
  let soonTimer = null;
  let soonPatch = {};
  function pushConfigSoon(patch) {
    for (const k in patch) soonPatch[k] = patch[k];
    if (soonTimer) return;
    soonTimer = setTimeout(function () {
      soonTimer = null;
      const body = soonPatch;
      soonPatch = {};
      pushConfig(body);
    }, 180);
  }

  state.onChanged = refresh; // library callbacks trigger a refresh
  const library = createLibrary({ API, PAGE_SIZE, post, state, ui });

  function refresh() {
    fetchJson("/api/config").then(function (c) {
      state.cfg = c;
      if (ui.badge) {
        ui.badge.textContent = c.liveFailed
          ? "实时渲染失败（已回退预览图）"
          : c.mediaType === "live" ? "实时场景" : c.mediaType === "video" ? "视频壁纸" : (c.wallpaperSet ? "图片" : "未设置");
      }
      if (ui.failBox) {
        const fail = c.liveFailed;
        ui.failBox.style.display = fail ? "" : "none";
        if (fail) ui.failBox.querySelector("[data-role=fail-reason]").textContent = fail.reason || "未知原因";
      }
      const f = document.getElementById(MARKER);
      if (!f) return;
      const q = function (k) { return f.querySelector("[data-k=" + k + "]"); };
      syncRange(f, "blur", c.blur, "px");
      syncRange(f, "dim", c.dim, "%");
      const monet = q("monet"); if (monet) setSwitch(monet, !!c.monet);
      const vis = q("vis"); if (vis) setSwitch(vis, !!c.wallpaperVisible);
      const mute = q("mute"); if (mute) setSwitch(mute, c.liveMuted !== false);
      syncRange(f, "bright", c.wallBrightness == null ? 100 : c.wallBrightness, "%");
      syncRange(f, "contrast", c.wallContrast == null ? 100 : c.wallContrast, "%");
      syncRange(f, "saturate", c.wallSaturate == null ? 100 : c.wallSaturate, "%");
      syncRange(f, "opacity", c.wallOpacity == null ? 0 : c.wallOpacity, "%");
      syncRange(f, "posx", c.posX == null ? 50 : c.posX, "");
      syncRange(f, "posy", c.posY == null ? 50 : c.posY, "");
      syncRange(f, "scale", c.layerScale == null ? 100 : c.layerScale, "%");
      const flip = q("flip"); if (flip) setSwitch(flip, !!c.flip);
      const rot = q("rot"); if (rot) setSwitch(rot, !!c.rotationEnabled);
      setSeg(f, "fit", c.fit || "cover");
      setSeg(f, "fps", String(c.liveFps || 30));
      setSeg(f, "trans", c.switchTransition || "fade");
      setSeg(f, "tspd", c.switchTransitionSpeed || "normal");
      setSeg(f, "rotmin", String(c.rotationMinutes || 30));
      setSeg(f, "rotord", c.rotationOrder === "random" ? "random" : "sequence");
    }).catch(function () {});
    fetchJson("/api/wallpapers").then(function (d) {
      state.lib = d;
      library.renderCurrent(d);
      if (ui.libBox) library.render(d.wallpapers, d.current);
    }).catch(function () {});
  }
  window.__zwPanelRefresh = refresh;

  // Live refresh: subscribe to the same SSE stream the agent applies — every
  // config change (this panel's own pushes included, other windows' pushes
  // too) lands as a refresh without any CDP round trip.
  if (window.EventSource) {
    try {
      es = new EventSource(API + "/api/events?client=panel");
      es.addEventListener("cfg", function () { refresh(); });
    } catch (e) {
      /* standalone mode — refresh() stays manual */
    }
  }

  function buildSection(host) {
    const section = el("div", CLS.section);
    section.id = MARKER;

    const head = el("div", "flex flex-wrap items-center justify-between gap-2");
    const headText = el("div");
    headText.appendChild(el("h3", CLS.title, "壁纸引擎"));
    headText.appendChild(el("p", CLS.desc, "使用 Wallpaper Engine 订阅的壁纸：场景为实时渲染（保留粒子、脚本与鼠标视差），图片与视频亦可作为背景。"));
    head.appendChild(headText);
    ui.badge = el("span", CLS.badge, "…");
    head.appendChild(ui.badge);
    section.appendChild(head);

    // Live hard-failure banner (D6): honest empty state with a retry, never a
    // fake "working" wallpaper.
    ui.failBox = el("div");
    ui.failBox.style.cssText = "display:none;margin-top:8px;padding:10px 12px;border:1px solid var(--color-border,#ffffff1a);border-radius:10px;font-size:13px;color:var(--color-foreground,#eee);";
    const failText = el("span");
    failText.setAttribute("data-role", "fail-reason");
    const failBtn = button("重试实时渲染", function () {
      post("/api/live-retry", {}).then(function () { refresh(); }).catch(function () { toast("重试失败：网络错误"); });
    }, "清除该壁纸的失败记忆，重新尝试实时渲染");
    failBtn.style.marginLeft = "10px";
    ui.failBox.appendChild(el("span", null, "实时渲染失败："));
    ui.failBox.appendChild(failText);
    ui.failBox.appendChild(failBtn);
    section.appendChild(ui.failBox);

    const card = el("div", CLS.card);
    card.setAttribute("data-slot", "card");
    const content = el("div", CLS.content);
    content.setAttribute("data-slot", "card-content");

    // --- full-width tab strip (dsh: equal tabs in one bordered container) -------
    ensureSliderStyle(MARKER);
    const tabBar = el("div", "rounded-lg");
    tabBar.style.cssText = "display:flex;gap:2px;padding:3px;margin:12px 16px 2px;border:1px solid var(--color-border,#ffffff1a);";
    function tabBtn(label) {
      const b = el("button", "h-8 rounded-md text-sm outline-none transition-colors cursor-pointer");
      b.type = "button";
      b.style.cssText = "flex:1 1 0;";
      b.textContent = label;
      tabBar.appendChild(b);
      return b;
    }
    const tabLibBtn = tabBtn("壁纸库");
    const tabPlayBtn = tabBtn("画面与播放");
    content.appendChild(tabBar);
    const tabLib = el("div");
    const tabPlay = el("div");
    tabPlay.style.display = "none";
    content.appendChild(tabLib);
    content.appendChild(tabPlay);
    function showTab(t) {
      const isLib = t !== "play";
      tabLib.style.display = isLib ? "" : "none";
      tabPlay.style.display = isLib ? "none" : "";
      Array.prototype.forEach.call([tabLibBtn, tabPlayBtn], function (b, idx) {
        const on = (idx === 0) === isLib;
        b.style.background = on ? "var(--color-input,#2b2b2b)" : "transparent";
        b.style.color = on ? "var(--color-foreground,#eee)" : "var(--color-foreground-subtle,#999)";
        b.style.fontWeight = on ? "500" : "400";
        b.style.boxShadow = on ? "inset 0 0 0 1px var(--color-input-border,#ffffff1a)" : "none";
      });
      state.tab = isLib ? "lib" : "play";
      try { localStorage.setItem("zw-panel-tab", state.tab); } catch (e) { /* private mode */ }
    }
    tabLibBtn.addEventListener("click", function () { showTab("lib"); });
    tabPlayBtn.addEventListener("click", function () { showTab("play"); });
    showTab((function () { try { return localStorage.getItem("zw-panel-tab") || "lib"; } catch (e) { return "lib"; } })());

    tabLib.appendChild(groupLabel("当前壁纸"));
    // Current wallpaper strip: poster + title + meta + badge.
    const curCard = el("div", "border-t border-border");
    curCard.style.cssText = "padding:12px 16px;display:flex;align-items:center;gap:14px;";
    ui.curPoster = el("img");
    ui.curPoster.loading = "lazy";
    ui.curPoster.style.cssText = "width:120px;height:68px;border-radius:8px;object-fit:cover;background:rgba(0,0,0,.25);flex:none;";
    const curInfo = el("div", "min-w-0 flex-1");
    ui.curTitle = el("div", "text-sm font-medium text-foreground truncate", "…");
    ui.curMeta = el("div", "text-xs text-foreground-subtle truncate");
    curInfo.appendChild(ui.curTitle);
    curInfo.appendChild(ui.curMeta);
    ui.curBadge = el("span", CLS.badge, "…");
    curCard.appendChild(ui.curPoster);
    curCard.appendChild(curInfo);
    curCard.appendChild(ui.curBadge);
    tabLib.appendChild(curCard);

    // ── picture pane: two columns of slider rows (user preference). ──────────
    tabPlay.appendChild(groupLabel("画面"));

    function sliderRow(k, cfgKey, labelText, min, max, unit, def) {
      const r = el("div", "border-t border-border");
      r.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 12px;";
      const lab = el("span", "text-sm text-foreground-subtle", labelText);
      lab.style.cssText = "flex:none;width:48px;";
      r.appendChild(lab);
      const i = el("input");
      i.type = "range";
      i.className = "zw-range";
      i.min = String(min);
      i.max = String(max);
      i.value = String(def);
      i.style.flex = "1 1 0";
      i.style.minWidth = "0";
      i.setAttribute("data-k", k);
      const v = el("span", "text-xs text-foreground-subtle");
      v.setAttribute("data-k", k + "v");
      v.style.cssText = "flex:none;min-width:46px;text-align:right;border:1px solid var(--color-border,#ffffff1a);border-radius:6px;padding:2px 6px;font-variant-numeric:tabular-nums;";
      v.textContent = def + unit;
      i.addEventListener("input", function () {
        v.textContent = i.value + unit;
        paintRange(i);
        const p = {};
        p[cfgKey] = Number(i.value);
        pushConfigSoon(p);
      });
      paintRange(i);
      r.appendChild(i);
      r.appendChild(v);
      return r;
    }
    const knobs = el("div");
    knobs.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:16px;";
    knobs.appendChild(sliderRow("blur", "blur", "模糊", 0, 40, "px", 0));
    knobs.appendChild(sliderRow("dim", "dim", "压暗", 0, 100, "%", 0));
    knobs.appendChild(sliderRow("bright", "wallBrightness", "亮度", 40, 160, "%", 100));
    knobs.appendChild(sliderRow("contrast", "wallContrast", "对比度", 40, 200, "%", 100));
    knobs.appendChild(sliderRow("saturate", "wallSaturate", "饱和度", 0, 200, "%", 100));
    knobs.appendChild(sliderRow("opacity", "wallOpacity", "透明度", 0, 90, "%", 0));
    knobs.appendChild(sliderRow("posx", "posX", "水平", 0, 100, "", 50));
    knobs.appendChild(sliderRow("posy", "posY", "垂直", 0, 100, "", 50));
    knobs.appendChild(sliderRow("scale", "layerScale", "缩放", 50, 150, "%", 100));
    tabPlay.appendChild(knobs);

    const rFit = prow("适配", "覆盖 = 裁切铺满 · 留边 = 完整显示 · 拉伸 = 变形填满 · 智能 = 自动构图。");
    rFit.right.style.flex = "1 1 0";
    rFit.right.style.minWidth = "240px";
    rFit.right.appendChild(makeSeg([["cover", "覆盖"], ["contain", "留边"], ["stretch", "拉伸"], ["smart", "智能"]], "cover", function (v) { pushConfig({ fit: v }); }, "fit", true));
    tabPlay.appendChild(rFit.r);

    const rLive = prow("帧率上限", "场景渲染帧率；视频按源帧率播放。");
    const fpsSeg = makeSeg([["15", "15"], ["30", "30"], ["60", "60"]], "30", function (v) { pushConfig({ liveFps: Number(v) }); }, "fps", true);
    fpsSeg.style.maxWidth = "200px";
    rLive.right.appendChild(fpsSeg);
    rLive.right.appendChild(makeSwitch(true, function (v) { pushConfig({ liveMuted: v }); }, "静音", "mute"));
    tabPlay.appendChild(rLive.r);

    const rFlip = prow("水平翻转", "镜像整个壁纸层，纯合成器操作。");
    rFlip.right.appendChild(makeSwitch(false, function (v) { pushConfig({ flip: v }); }, "翻转", "flip"));
    tabPlay.appendChild(rFlip.r);

    tabPlay.appendChild(groupLabel("取色"));

    const rTheme = prow("Monet 动态取色", "从壁纸真实渲染像素提取 Material Design 3 配色适配界面；关闭「显示壁纸」则只取色不铺图。");
    rTheme.right.appendChild(makeSwitch(true, function (v) { pushConfig({ monet: v }); }, "取色", "monet"));
    rTheme.right.appendChild(makeSwitch(true, function (v) { pushConfig({ wallpaperVisible: v }); }, "显示壁纸", "vis"));
    tabPlay.appendChild(rTheme.r);

    // library pane — dsh order: actions under the current card, then 切换过场 /
    // 自动轮播 sections, then the picker (filter row + poster grid + pager).
    const libRow = tabLib;
    const actRow = el("div");
    actRow.style.cssText = "padding:10px 16px 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    // Instant pause/resume: posted straight into the live renderer iframes in
    // this page — no server roundtrip, no config change.
    let livePaused = false;
    const pauseBtn = button("暂停", function () {
      livePaused = !livePaused;
      pauseBtn.textContent = livePaused ? "继续" : "暂停";
      Array.prototype.forEach.call(document.querySelectorAll("iframe"), function (f) {
        if ((f.getAttribute("src") || "").indexOf("/live/index.html") !== -1) {
          try { f.contentWindow.postMessage({ zw: livePaused ? "pause" : "resume", user: true }, "*"); } catch (e) { /* mid-swap */ }
        }
      });
      const v = document.getElementById("zcode-wallpaper-video");
      if (v) { if (livePaused) { v.pause(); } else { v.play().catch(function () {}); } }
    }, "暂停/恢复实时渲染");
    actRow.appendChild(pauseBtn);
    actRow.appendChild(button("刷新", function () { refresh(); }));
    // One import entry: a browser file chooser for images, .zw.zip packages,
    // .pkg scenes and videos — dispatched by file type.
    const importFile = el("input");
    importFile.type = "file";
    importFile.accept = "image/*,.zip,.pkg,.mp4,.webm";
    importFile.className = "hidden";
    importFile.addEventListener("change", function () {
      const f = importFile.files && importFile.files[0];
      if (!f) return;
      state.page = 0;
      if (/^image\//.test(f.type)) {
        const fr = new FileReader();
        fr.onload = function () {
          post("/api/wallpaper", { dataUri: fr.result }).then(function (r) {
            if (r.error) toast("导入失败：" + r.error); else { toast("图片已应用"); refresh(); }
          }).catch(function () { toast("导入失败：网络错误"); });
        };
        fr.readAsDataURL(f);
      } else {
        fetch(API + "/api/upload-wallpaper?apply=1", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", "X-ZW-Filename": encodeURIComponent(f.name) },
          body: f,
        })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            if (r.error) { toast("导入失败：" + r.error); return; }
            toast("已导入「" + (r.title || f.name) + "」" + (r.mediaType === "live" ? "（实时渲染）" : ""));
            refresh();
          })
          .catch(function () { toast("导入失败：网络错误"); });
      }
      importFile.value = "";
    });
    actRow.appendChild(button("导入壁纸…", function () { importFile.click(); }, "支持：图片、.zw.zip 资源包、.pkg 场景、.mp4/.webm 视频（无需 Wallpaper Engine）"));
    actRow.appendChild(importFile);
    libRow.appendChild(actRow);

    libRow.appendChild(groupLabel("切换过场"));
    const rTrans = prow("过场动画", "切换时旧画面退场的效果（新画面在下方接替）。");
    rTrans.right.appendChild(makeSeg([["fade", "淡入"], ["push", "推移"], ["wipe", "擦除"], ["iris", "光圈"], ["zoom", "缩放"], ["cut", "直接"]], "fade", function (v) { pushConfig({ switchTransition: v }); }, "trans"));
    rTrans.right.appendChild(makeSeg([["fast", "快"], ["normal", "标准"], ["slow", "慢"]], "normal", function (v) { pushConfig({ switchTransitionSpeed: v }); }, "tspd"));
    libRow.appendChild(rTrans.r);

    libRow.appendChild(groupLabel("自动轮播"));
    const rRot = prow("自动轮转", "按间隔在壁纸库（订阅 + 本机导入）中自动切换。");
    rRot.right.appendChild(makeSeg([["sequence", "顺序"], ["random", "随机"]], "sequence", function (v) { pushConfig({ rotationOrder: v }); }, "rotord"));
    rRot.right.appendChild(makeSeg([["5", "5 分"], ["15", "15 分"], ["30", "30 分"], ["60", "1 小时"], ["120", "2 小时"]], "30", function (v) { pushConfig({ rotationMinutes: Number(v) }); }, "rotmin"));
    rRot.right.appendChild(makeSwitch(false, function (v) { pushConfig({ rotationEnabled: v }); }, "轮播", "rot"));
    libRow.appendChild(rRot.r);

    libRow.appendChild(groupLabel("壁纸库"));

    // Filter row: search takes the slack, the type filter stays compact.
    const filterRow = el("div");
    filterRow.style.cssText = "padding:2px 16px 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    const search = el("input", CLS.input);
    search.type = "search";
    search.placeholder = "搜索壁纸（名称 / 类型 / 来源）";
    search.value = state.filter || "";
    search.style.cssText = "flex:1 1 180px;min-width:160px;";
    let searchTimer = null;
    search.addEventListener("input", function () {
      clearTimeout(searchTimer);
      const v = search.value;
      searchTimer = setTimeout(function () {
        state.filter = v;
        state.page = 0;
        library.render(state.lib && state.lib.wallpapers, state.lib && state.lib.current);
      }, 200);
    });
    ui.search = search;
    filterRow.appendChild(search);
    const typeSel = dropdown([["all", "全部类型"], ["scene", "场景"], ["video", "视频"], ["web", "网页"]], state.typeF || "all", function (v) {
      state.typeF = v; state.page = 0;
      library.render(state.lib && state.lib.wallpapers, state.lib && state.lib.current);
    });
    typeSel.style.width = "128px";
    typeSel.style.flex = "none";
    filterRow.appendChild(typeSel);
    libRow.appendChild(filterRow);

    ui.libBox = el("div");
    ui.libBox.style.cssText = "padding:0 16px;";
    libRow.appendChild(ui.libBox);
    ui.pagerBox = el("div");
    ui.pagerBox.style.cssText = "padding:2px 16px 12px;";
    libRow.appendChild(ui.pagerBox);

    // footer actions
    const footRow = el("div", "px-4 py-3 flex items-center gap-2 justify-end");
    footRow.appendChild(button("恢复默认外观", function () {
      post("/api/reset", {}).then(function () { refresh(); });
    }));
    footRow.appendChild(button("还原上次壁纸", function () {
      post("/api/restore", {}).then(function () { refresh(); });
    }));
    content.appendChild(footRow);

    card.appendChild(content);
    section.appendChild(card);
    host.appendChild(section);
    refresh();
  }

  // ── lifecycle wiring ───────────────────────────────────────────────────────
  const mount = createMountLoop({ API, reg, buildSection });
  mount.onResetUi(function () {
    ui.libBox = null; ui.pagerBox = null; ui.badge = null; ui.search = null; ui.failBox = null;
    state.page = 0;
  });
  mount.start();

  // --- teardown (bootstrap heartbeat / reset script) ---------------------------
  window.__zwTeardownPanel = function () {
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    observers.forEach(function (o) { o.disconnect(); });
    try { if (es) es.close(); } catch (e) {}
    mount.teardown();
    window.__zwPanel = null;
    window.__zwPanelRefresh = null;
  };
})();
