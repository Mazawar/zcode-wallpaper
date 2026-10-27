/**
 * The wallpaper settings section, mounted into ZCode's Settings → Appearance
 * (外观) page as a native-looking custom section at the bottom of the list.
 *
 * Served as a real file (/panel.js) and loaded by a thin injected loader; the
 * served copy is always the current build, which retires the per-build
 * version-flag protocol the inline-string era needed. Guarded by
 * window.__zwPanel so loader replays never double-run it.
 *
 *   - mounts ONLY while the Appearance page is visible: all settings tabs
 *     share one React-managed container, and a foreign child survives tab
 *     switches — the scan removes the section the moment the Appearance
 *     heading is off screen and remounts when it returns
 *   - markup mirrors ZCode's own settings structure and control classes, so
 *     light/dark themes and typography match the built-in cards
 *   - wallpaper library: search + pagination at a fixed grid height; import by
 *     path (directory / .pkg / .zw.zip) or browser file chooser; export packages
 *   - talks to the serve control API over CORS-enabled fetch, and subscribes
 *     to the same SSE stream the agent uses so pushes refresh it live
 */
(function () {
  if (window.__zwPanel) return;
  window.__zwPanel = true;

  var API = window.__zwApiBase || "http://127.0.0.1:28257";
  var MARKER = "zcode-wallpaper-settings-v6";
  var LEGACY_IDS = ["zcode-wallpaper-settings", "zcode-wallpaper-settings-2"];
  var H2_TEXT = /^(外观|Appearance)$/;
  var PAGE_SIZE = 15;

  var timers = [];
  var observers = [];
  var es = null;
  function every(fn, ms) {
    var t = setInterval(fn, ms);
    timers.push(t);
    return t;
  }

  var state = { cfg: null, lib: null, page: 0, filter: "", typeF: "all", gridH: 0 };
  var ui = { libBox: null, pagerBox: null, badge: null, search: null };

  function fetchJson(url, opts) {
    return fetch(API + url, opts).then(function (r) { return r.json(); });
  }
  function post(path, body) {
    return fetchJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  // --- the Appearance settings page, only while it is the active tab --------
  // Other settings pages (e.g. scheduled-task settings) carry their own visible
  // "外观" heading in an identical layout, so the heading alone is not enough:
  // the real Appearance page also contains the 界面主题 (theme) control.
  function appearanceSectionList() {
    var h2 = Array.prototype.find.call(document.querySelectorAll("h2"), function (h) {
      return H2_TEXT.test((h.textContent || "").trim()) && h.offsetParent !== null;
    });
    if (!h2) return null;
    var main = h2.closest("main");
    var col = main && main.querySelector(".max-w-4xl");
    if (!col || !col.contains(h2)) return null;
    if (!/(界面主题|Interface theme|界面主題)/.test(col.textContent || "")) return null;
    return col.querySelector(".space-y-8") || col;
  }

  // --- class strings captured from ZCode's own settings UI ---------------------
  var CLS = {
    section: "min-w-0 space-y-3",
    title: "text-ui-lg font-semibold text-foreground",
    desc: "mt-1 text-ui-base leading-6 text-foreground-subtle",
    card: "group/card flex flex-col gap-4 overflow-hidden rounded-xl text-ui-base/relaxed text-foreground border border-border bg-card py-0 shadow-none",
    content: "space-y-0 px-0",
    row: "border-t border-border px-4 py-3 first:border-t-0",
    grid: "grid items-center gap-4 grid-cols-[minmax(0,1fr)_192px]",
    label: "text-ui-base font-medium text-foreground",
    rowDesc: "mt-1 text-ui-base leading-6 text-foreground-subtle",
    ctrl: "flex w-full flex-nowrap items-center justify-end gap-2",
    btn: "cursor-pointer border border-input-border bg-background text-foreground hover:border-input-border-hover hover:bg-input rounded-lg h-8 px-3 text-sm outline-none transition-colors",
    btnIcon: "cursor-pointer inline-flex items-center justify-center gap-1 border border-input-border bg-background text-foreground hover:border-input-border-hover hover:bg-input rounded-md h-6 px-1.5 text-xs outline-none transition-colors",
    trigger: "flex items-center justify-between gap-1.5 border whitespace-nowrap transition-colors outline-none border-input-border bg-input text-foreground hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 h-8 rounded-lg pl-3 pr-2 text-ui-base w-full",
    menu: "z-[60] min-w-32 max-h-60 overflow-y-auto rounded-lg border border-popover-border bg-menu p-1 text-foreground shadow-md",
    item: "relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base/relaxed text-foreground outline-none select-none data-[highlighted=true]:bg-menu-hover",
    input: "border border-input-border bg-input text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused rounded-lg h-8 px-3 text-sm outline-none transition-colors",
    switch: "p-px group/switch relative inline-flex shrink-0 items-center rounded-full transition-all outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-input-border-focused/30 data-[size=default]:h-[18px] data-[size=default]:w-[32px] data-checked:bg-primary data-unchecked:bg-primary/30",
    switchThumb: "pointer-events-none block rounded-full bg-primary-foreground ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0",
    stat: "text-ui-base leading-6 text-foreground-subtle",
    badge: "text-xs px-1.5 py-px rounded-full border border-border text-foreground-subtle"
  };
  var TYPE_LABEL = { scene: "场景", video: "视频", web: "网页", image: "图片", unknown: "未知" };
  var ORIGIN_LABEL = { workshop: "工坊订阅", custom: "本机导入", default: "WE 内置", myprojects: "WE 工程" };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svgChevron(down) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.classList.add("shrink-0", "size-4", "text-foreground-subtle");
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", down ? "m6 9 6 6 6-6" : "m18 15-6-6-6 6");
    s.appendChild(p);
    return s;
  }

  function row(labelText, descText) {
    var r = el("div", CLS.row);
    var g = el("div", CLS.grid);
    var left = el("div", "min-w-0");
    left.appendChild(el("div", CLS.label, labelText));
    if (descText) left.appendChild(el("div", CLS.rowDesc, descText));
    var right = el("div", CLS.ctrl);
    g.appendChild(left); g.appendChild(right);
    r.appendChild(g);
    return { r: r, right: right };
  }

  // --- Radix-look select ---------------------------------------------------------
  function dropdown(options, value, onChange) {
    var wrap = el("div", "relative w-full");
    var trigger = el("button", CLS.trigger);
    trigger.type = "button";
    var valueSpan = el("span", "line-clamp-1 truncate");
    var currentLabel = "";
    options.forEach(function (o) { if (String(o[0]) === String(value)) currentLabel = o[1]; });
    valueSpan.textContent = currentLabel;
    trigger.appendChild(valueSpan);
    trigger.appendChild(svgChevron(true));

    var menu = el("div", CLS.menu);
    menu.style.cssText = "display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;";

    function close() {
      menu.style.display = "none";
      trigger.setAttribute("data-state", "closed");
      document.removeEventListener("pointerdown", onDocDown, true);
    }
    function onDocDown(e) { if (!wrap.contains(e.target)) close(); }
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.style.display === "none") {
        menu.style.display = "block";
        trigger.setAttribute("data-state", "open");
        document.addEventListener("pointerdown", onDocDown, true);
      } else close();
    });
    trigger.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });

    options.forEach(function (o) {
      var item = el("div", CLS.item, o[1]);
      item.setAttribute("role", "option");
      if (String(o[0]) === String(value)) item.setAttribute("aria-selected", "true");
      item.addEventListener("mouseenter", function () {
        Array.prototype.forEach.call(menu.children, function (c) { c.removeAttribute("data-highlighted"); });
        item.setAttribute("data-highlighted", "true");
      });
      item.addEventListener("click", function () {
        valueSpan.textContent = o[1];
        Array.prototype.forEach.call(menu.children, function (c) { c.removeAttribute("data-highlighted"); c.removeAttribute("aria-selected"); });
        item.setAttribute("aria-selected", "true");
        close();
        onChange(o[0]);
      });
      menu.appendChild(item);
    });
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    return wrap;
  }

  // ZCode-style switch (classes captured from its native [data-slot=switch]).
  function setSwitch(btn, checked) {
    btn.setAttribute("data-state", checked ? "checked" : "unchecked");
    btn.setAttribute("aria-checked", checked ? "true" : "false");
    // ZCode's switch CSS keys on data-checked / data-unchecked ATTRIBUTES on
    // BOTH the track (group) and the thumb — without them the track never
    // recolors and the thumb never slides.
    var parts = [btn, btn.firstElementChild];
    for (var i = 0; i < parts.length; i++) {
      var n = parts[i];
      if (!n) continue;
      if (checked) {
        n.setAttribute("data-checked", "true");
        n.removeAttribute("data-unchecked");
      } else {
        n.setAttribute("data-unchecked", "true");
        n.removeAttribute("data-checked");
      }
    }
  }
  function makeSwitch(checked, onChange, labelText, key) {
    var wrap = el("label", "inline-flex items-center gap-2 cursor-pointer");
    var btn = el("button", CLS.switch);
    btn.type = "button";
    btn.setAttribute("role", "switch");
    btn.setAttribute("data-size", "default");
    if (key) btn.setAttribute("data-k", key);
    var cur = !!checked;
    setSwitch(btn, cur);
    btn.appendChild(el("span", CLS.switchThumb));
    btn.addEventListener("click", function () {
      cur = !cur;
      setSwitch(btn, cur);
      onChange(cur);
    });
    wrap.appendChild(btn);
    if (labelText) wrap.appendChild(el("span", "text-sm text-foreground-subtle", labelText));
    return wrap;
  }

  function button(text, onClick, title, cls) {
    var b = el("button", cls || CLS.btn, text);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  // --- custom slider (dsh-style thin track + filled progress) -------------------
  // ZCode's compiled CSS has no accent-* utility for range inputs — left alone
  // they render as chunky native Chromium widgets. A tiny stylesheet plus a
  // --zw-fill custom property gives the filled-track look; --color-primary is
  // the theme accent (white in this dark theme, black in light).
  function ensureSliderStyle() {
    if (document.getElementById(MARKER + "-range-style")) return;
    var st = document.createElement("style");
    st.id = MARKER + "-range-style";
    st.textContent =
      "input.zw-range{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:9999px;margin:0;" +
      "background:linear-gradient(to right,var(--color-primary,#fff) var(--zw-fill,50%),rgba(127,127,127,.28) var(--zw-fill,50%));" +
      "outline:none;cursor:pointer;}" +
      "input.zw-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;" +
      "background:var(--color-primary,#fff);border:2px solid var(--color-background,#161616);box-shadow:0 1px 3px rgba(0,0,0,.35);}";
    (document.head || document.documentElement).appendChild(st);
  }
  function paintRange(i) {
    var min = Number(i.min) || 0;
    var max = Number(i.max) || 100;
    var pct = ((Number(i.value) - min) / (max - min)) * 100;
    i.style.setProperty("--zw-fill", Math.max(0, Math.min(100, pct)) + "%");
  }
  /** Read-back for refresh(): input value, chip text, fill level. */
  function syncRange(f, k, val, unit) {
    var i = f.querySelector("[data-k=" + k + "]");
    if (!i) return;
    i.value = String(val);
    var chip = f.querySelector("[data-k=" + k + "v]");
    if (chip) chip.textContent = val + (unit || "");
    paintRange(i);
  }

  // --- segmented control (dsh's 倍速 / 帧率 / 适配 rows) --------------------------
  // Dropdowns hide the choices; a segment row shows them. Active segment =
  // bg-input pill with a hairline inset border, verified classes + inline only.
  function makeSeg(options, value, onChange, key, fill) {
    var wrap = el("div", "inline-flex items-center gap-1 rounded-lg");
    // Inline border: borrowed host utility classes (border border-border)
    // can lose the race with the host's async stylesheet — our chrome defines
    // its own look, like dsh ships its own styles instead of borrowing.
    wrap.style.border = "1px solid var(--color-border,#ffffff1a)";
    wrap.style.cssText += fill
      ? "padding:3px;display:flex;flex-wrap:nowrap;width:100%;"
      : "padding:3px;flex-wrap:wrap;row-gap:2px;";
    wrap.setAttribute("role", "radiogroup");
    if (key) wrap.setAttribute("data-k", key);
    wrap.setAttribute("data-value", String(value));
    wrap.__zwPaint = function () {
      var cur = String(wrap.getAttribute("data-value"));
      Array.prototype.forEach.call(wrap.children, function (b) {
        var on = b.getAttribute("data-v") === cur;
        b.style.background = on ? "var(--color-input,#2b2b2b)" : "transparent";
        b.style.color = on ? "var(--color-foreground,#eee)" : "var(--color-foreground-subtle,#999)";
        b.style.fontWeight = on ? "500" : "400";
        b.style.boxShadow = on ? "inset 0 0 0 1px var(--color-input-border,#ffffff1a)" : "none";
      });
    };
    options.forEach(function (o) {
      var b = el("button", "h-7 rounded-md text-xs cursor-pointer outline-none transition-colors");
      b.type = "button";
      b.style.cssText = fill ? "flex:1 1 0;padding:0 8px;" : "padding:0 12px;";
      b.textContent = o[1];
      b.setAttribute("data-v", String(o[0]));
      b.addEventListener("click", function () {
        wrap.setAttribute("data-value", String(o[0]));
        wrap.__zwPaint();
        onChange(o[0]);
      });
      wrap.appendChild(b);
    });
    wrap.__zwPaint();
    return wrap;
  }
  function setSeg(f, key, val) {
    var w = f && f.querySelector("[data-k=" + key + "]");
    if (!w || !w.__zwPaint) return;
    w.setAttribute("data-value", String(val));
    w.__zwPaint();
  }

  // Full-width play-pane row (label + description left, control right). The
  // native 192px control column only fits dropdowns — segments need width.
  function prow(labelText, descText) {
    var r = el("div", "border-t border-border");
    r.style.cssText = "padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;";
    var left = el("div", "min-w-0");
    left.appendChild(el("div", "text-sm font-medium text-foreground", labelText));
    if (descText) left.appendChild(el("div", "text-xs text-foreground-subtle", descText));
    var right = el("div", "inline-flex items-center");
    right.style.cssText = "gap:12px;flex-wrap:wrap;justify-content:flex-end;";
    r.appendChild(left);
    r.appendChild(right);
    return { r: r, right: right };
  }
  function groupLabel(t) {
    // dsh section heading: big, bold, white — the visual anchor of a group.
    var g = el("div", "text-sm font-semibold text-foreground");
    g.style.cssText = "padding:16px 16px 8px;font-size:15px;";
    g.textContent = t;
    return g;
  }

  function pushConfig(patch) {
    post("/api/config", patch).catch(function () {});
  }
  // Debounced+merged push for slider drags: 'input' fires at pointer
  // frequency; the merge keeps bursts down to one request per 180ms.
  var soonTimer = null;
  var soonPatch = {};
  function pushConfigSoon(patch) {
    for (var k in patch) soonPatch[k] = patch[k];
    if (soonTimer) return;
    soonTimer = setTimeout(function () {
      soonTimer = null;
      var body = soonPatch;
      soonPatch = {};
      pushConfig(body);
    }, 180);
  }

  // Transient feedback (2.5s, auto-dismiss) — the library has no permanent
  // status line; failures would otherwise be completely silent.
  function toast(text) {
    var host = document.body || document.documentElement;
    var t = el("div", "fixed right-4 bottom-4 z-[2147483647] rounded-lg bg-card px-3 py-2 text-sm text-foreground shadow-md");
    t.style.border = "1px solid var(--color-border,#ffffff1a)";
    t.textContent = text;
    host.appendChild(t);
    setTimeout(function () { t.remove(); }, 2500);
  }

  // --- library (searchable, paginated, fixed height) --------------------------
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

  function renderLibrary(list, currentId) {
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
              refresh();
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
        // anything within 600ms of the last one (a drag over cards should
        // not fire a dozen loads).
        if (Date.now() - lastApply < 600) return;
        lastApply = Date.now();
        post("/api/apply-source", { sourceId: w.id }).then(function (r) {
          if (!r.error) refresh();
        }).catch(function () {});
      });
      grid.appendChild(card);
    });
    ui.libBox.appendChild(grid);
    // Fixed height: remember the natural height of a FULL page and keep it for
    // short pages too, so the last page never collapses the section. Skipped
    // while the pane is hidden (offsetHeight 0 would poison the memory).
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
    var prev = button("上一页", function () { if (state.page > 0) { state.page--; renderLibrary(state.lib && state.lib.wallpapers, state.lib && state.lib.current); } }, null, CLS.btnIcon);
    if (state.page === 0) { prev.disabled = true; prev.classList.add("opacity-50", "cursor-not-allowed"); }
    pager.appendChild(prev);
    pager.appendChild(el("span", "text-sm text-foreground-subtle", (state.page + 1) + " / " + pages + " 页 · 共 " + all.length + " 项" + (all.length !== list.length ? "（筛选自 " + list.length + "）" : "")));
    var next = button("下一页", function () { if (state.page < pages - 1) { state.page++; renderLibrary(state.lib && state.lib.wallpapers, state.lib && state.lib.current); } }, null, CLS.btnIcon);
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

  function refresh() {
    fetchJson("/api/config").then(function (c) {
      state.cfg = c;
      if (ui.badge) {
        ui.badge.textContent = c.mediaType === "live" ? "实时场景" : c.mediaType === "video" ? "视频壁纸" : (c.wallpaperSet ? "图片" : "未设置");
      }
      var f = document.getElementById(MARKER);
      if (!f) return;
      var q = function (k) { return f.querySelector("[data-k=" + k + "]"); };
      var blur = syncRange(f, "blur", c.blur, "px");
      var dim = syncRange(f, "dim", c.dim, "%");
      var monet = q("monet"); if (monet) setSwitch(monet, !!c.monet);
      var vis = q("vis"); if (vis) setSwitch(vis, !!c.wallpaperVisible);
      var mute = q("mute"); if (mute) setSwitch(mute, c.liveMuted !== false);
      syncRange(f, "bright", c.wallBrightness == null ? 100 : c.wallBrightness, "%");
      syncRange(f, "contrast", c.wallContrast == null ? 100 : c.wallContrast, "%");
      syncRange(f, "saturate", c.wallSaturate == null ? 100 : c.wallSaturate, "%");
      syncRange(f, "opacity", c.wallOpacity == null ? 0 : c.wallOpacity, "%");
      syncRange(f, "posx", c.posX == null ? 50 : c.posX, "");
      syncRange(f, "posy", c.posY == null ? 50 : c.posY, "");
      syncRange(f, "scale", c.layerScale == null ? 100 : c.layerScale, "%");
      var flip = q("flip"); if (flip) setSwitch(flip, !!c.flip);
      var rot = q("rot"); if (rot) setSwitch(rot, !!c.rotationEnabled);
      setSeg(f, "fit", c.fit || "cover");
      setSeg(f, "fps", String(c.liveFps || 30));
      setSeg(f, "trans", c.switchTransition || "fade");
      setSeg(f, "tspd", c.switchTransitionSpeed || "normal");
      setSeg(f, "rotmin", String(c.rotationMinutes || 30));
      setSeg(f, "rotord", c.rotationOrder === "random" ? "random" : "sequence");
    }).catch(function () {});
    fetchJson("/api/wallpapers").then(function (d) {
      state.lib = d;
      renderCurrent(d);
      if (ui.libBox) renderLibrary(d.wallpapers, d.current);
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

  function buildSection() {
    var section = el("div", CLS.section);
    section.id = MARKER;

    var head = el("div", "flex flex-wrap items-center justify-between gap-2");
    var headText = el("div");
    headText.appendChild(el("h3", CLS.title, "壁纸引擎"));
    headText.appendChild(el("p", CLS.desc, "使用 Wallpaper Engine 订阅的壁纸：场景为实时渲染（保留粒子、脚本与鼠标视差），图片与视频亦可作为背景。"));
    head.appendChild(headText);
    ui.badge = el("span", CLS.badge, "…");
    head.appendChild(ui.badge);
    section.appendChild(head);

    var card = el("div", CLS.card);
    card.setAttribute("data-slot", "card");
    var content = el("div", CLS.content);
    content.setAttribute("data-slot", "card-content");

    // --- full-width tab strip (dsh: equal tabs in one bordered container) -------
    ensureSliderStyle();
    var tabBar = el("div", "rounded-lg");
    tabBar.style.cssText = "display:flex;gap:2px;padding:3px;margin:12px 16px 2px;border:1px solid var(--color-border,#ffffff1a);";
    function tabBtn(label) {
      var b = el("button", "h-8 rounded-md text-sm outline-none transition-colors cursor-pointer");
      b.type = "button";
      b.style.cssText = "flex:1 1 0;";
      b.textContent = label;
      tabBar.appendChild(b);
      return b;
    }
    var tabLibBtn = tabBtn("壁纸库");
    var tabPlayBtn = tabBtn("画面与播放");
    content.appendChild(tabBar);
    var tabLib = el("div");
    var tabPlay = el("div");
    tabPlay.style.display = "none";
    content.appendChild(tabLib);
    content.appendChild(tabPlay);
    function showTab(t) {
      var isLib = t !== "play";
      tabLib.style.display = isLib ? "" : "none";
      tabPlay.style.display = isLib ? "none" : "";
      Array.prototype.forEach.call([tabLibBtn, tabPlayBtn], function (b, idx) {
        var on = (idx === 0) === isLib;
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
    var curCard = el("div", "border-t border-border");
    curCard.style.cssText = "padding:12px 16px;display:flex;align-items:center;gap:14px;";
    ui.curPoster = el("img");
    ui.curPoster.loading = "lazy";
    ui.curPoster.style.cssText = "width:120px;height:68px;border-radius:8px;object-fit:cover;background:rgba(0,0,0,.25);flex:none;";
    var curInfo = el("div", "min-w-0 flex-1");
    ui.curTitle = el("div", "text-sm font-medium text-foreground truncate", "…");
    ui.curMeta = el("div", "text-xs text-foreground-subtle truncate");
    curInfo.appendChild(ui.curTitle);
    curInfo.appendChild(ui.curMeta);
    ui.curBadge = el("span", CLS.badge, "…");
    curCard.appendChild(ui.curPoster);
    curCard.appendChild(curInfo);
    curCard.appendChild(ui.curBadge);
    tabLib.appendChild(curCard);

    // ── picture pane: two columns of slider rows (user preference). Each cell
    // keeps the label · slider · chip anatomy; the grid supplies the gutter. ──
    tabPlay.appendChild(groupLabel("画面"));

    function sliderRow(k, cfgKey, labelText, min, max, unit, def) {
      var r = el("div", "border-t border-border");
      r.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 12px;";
      var lab = el("span", "text-sm text-foreground-subtle", labelText);
      lab.style.cssText = "flex:none;width:48px;";
      r.appendChild(lab);
      var i = el("input");
      i.type = "range";
      i.className = "zw-range";
      i.min = String(min);
      i.max = String(max);
      i.value = String(def);
      i.style.flex = "1 1 0";
      i.style.minWidth = "0";
      i.setAttribute("data-k", k);
      var v = el("span", "text-xs text-foreground-subtle");
      v.setAttribute("data-k", k + "v");
      v.style.cssText = "flex:none;min-width:46px;text-align:right;border:1px solid var(--color-border,#ffffff1a);border-radius:6px;padding:2px 6px;font-variant-numeric:tabular-nums;";
      v.textContent = def + unit;
      i.addEventListener("input", function () {
        v.textContent = i.value + unit;
        paintRange(i);
        var p = {};
        p[cfgKey] = Number(i.value);
        pushConfigSoon(p);
      });
      paintRange(i);
      r.appendChild(i);
      r.appendChild(v);
      return r;
    }
    var knobs = el("div");
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

    var rFit = prow("适配", "覆盖 = 裁切铺满 · 留边 = 完整显示 · 拉伸 = 变形填满 · 智能 = 自动构图。");
    rFit.right.style.flex = "1 1 0";
    rFit.right.style.minWidth = "240px";
    rFit.right.appendChild(makeSeg([["cover", "覆盖"], ["contain", "留边"], ["stretch", "拉伸"], ["smart", "智能"]], "cover", function (v) { pushConfig({ fit: v }); }, "fit", true));
    tabPlay.appendChild(rFit.r);

    var rLive = prow("帧率上限", "场景渲染帧率；视频按源帧率播放。");
    var fpsSeg = makeSeg([["15", "15"], ["30", "30"], ["60", "60"]], "30", function (v) { pushConfig({ liveFps: Number(v) }); }, "fps", true);
    fpsSeg.style.maxWidth = "200px";
    rLive.right.appendChild(fpsSeg);
    rLive.right.appendChild(makeSwitch(true, function (v) { pushConfig({ liveMuted: v }); }, "静音", "mute"));
    tabPlay.appendChild(rLive.r);

    var rFlip = prow("水平翻转", "镜像整个壁纸层，纯合成器操作。");
    rFlip.right.appendChild(makeSwitch(false, function (v) { pushConfig({ flip: v }); }, "翻转", "flip"));
    tabPlay.appendChild(rFlip.r);

    tabPlay.appendChild(groupLabel("取色"));

    var rTheme = prow("Monet 动态取色", "从壁纸真实渲染像素提取 Material Design 3 配色适配界面；关闭「显示壁纸」则只取色不铺图。");
    rTheme.right.appendChild(makeSwitch(true, function (v) { pushConfig({ monet: v }); }, "取色", "monet"));
    rTheme.right.appendChild(makeSwitch(true, function (v) { pushConfig({ wallpaperVisible: v }); }, "显示壁纸", "vis"));
    tabPlay.appendChild(rTheme.r);

    // library pane — dsh order: actions under the current card, then 切换过场 /
    // 自动轮播 sections, then the picker (filter row + poster grid + pager).
    var libRow = tabLib;
    var actRow = el("div");
    actRow.style.cssText = "padding:10px 16px 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    // Instant pause/resume: posted straight into the live renderer iframes in
    // this page — no server roundtrip, no config change.
    var livePaused = false;
    var pauseBtn = button("暂停", function () {
      livePaused = !livePaused;
      pauseBtn.textContent = livePaused ? "继续" : "暂停";
      // live scenes: message the renderer iframes; videos: the native element
      Array.prototype.forEach.call(document.querySelectorAll("iframe"), function (f) {
        if ((f.getAttribute("src") || "").indexOf("/live/index.html") !== -1) {
          try { f.contentWindow.postMessage({ zw: livePaused ? "pause" : "resume", user: true }, "*"); } catch (e) { /* mid-swap */ }
        }
      });
      var v = document.getElementById("zcode-wallpaper-video");
      if (v) { if (livePaused) { v.pause(); } else { v.play().catch(function () {}); } }
    }, "暂停/恢复实时渲染");
    actRow.appendChild(pauseBtn);
    actRow.appendChild(button("刷新", function () { refresh(); }));
    // One import entry: a browser file chooser for images, .zw.zip packages,
    // .pkg scenes and videos — dispatched by file type. Same chooser UX as
    // everywhere else in the app; no Wallpaper Engine involved.
    var importFile = el("input");
    importFile.type = "file";
    importFile.accept = "image/*,.zip,.pkg,.mp4,.webm";
    importFile.className = "hidden";
    importFile.addEventListener("change", function () {
      var f = importFile.files && importFile.files[0];
      if (!f) return;
      state.page = 0;
      if (/^image\//.test(f.type)) {
        var fr = new FileReader();
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
    var rTrans = prow("过场动画", "切换时旧画面退场的效果（新画面在下方接替）。");
    rTrans.right.appendChild(makeSeg([["fade", "淡入"], ["push", "推移"], ["wipe", "擦除"], ["iris", "光圈"], ["zoom", "缩放"], ["cut", "直接"]], "fade", function (v) { pushConfig({ switchTransition: v }); }, "trans"));
    rTrans.right.appendChild(makeSeg([["fast", "快"], ["normal", "标准"], ["slow", "慢"]], "normal", function (v) { pushConfig({ switchTransitionSpeed: v }); }, "tspd"));
    libRow.appendChild(rTrans.r);

    libRow.appendChild(groupLabel("自动轮播"));
    var rRot = prow("自动轮转", "按间隔在壁纸库（订阅 + 本机导入）中自动切换。");
    rRot.right.appendChild(makeSeg([["sequence", "顺序"], ["random", "随机"]], "sequence", function (v) { pushConfig({ rotationOrder: v }); }, "rotord"));
    rRot.right.appendChild(makeSeg([["5", "5 分"], ["15", "15 分"], ["30", "30 分"], ["60", "1 小时"], ["120", "2 小时"]], "30", function (v) { pushConfig({ rotationMinutes: Number(v) }); }, "rotmin"));
    rRot.right.appendChild(makeSwitch(false, function (v) { pushConfig({ rotationEnabled: v }); }, "轮播", "rot"));
    libRow.appendChild(rRot.r);

    libRow.appendChild(groupLabel("壁纸库"));

    // Filter row: search takes the slack, the type filter stays compact.
    var filterRow = el("div");
    filterRow.style.cssText = "padding:2px 16px 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    var search = el("input", CLS.input);
    search.type = "search";
    search.placeholder = "搜索壁纸（名称 / 类型 / 来源）";
    search.value = state.filter || "";
    search.style.cssText = "flex:1 1 180px;min-width:160px;";
    var searchTimer = null;
    search.addEventListener("input", function () {
      clearTimeout(searchTimer);
      var v = search.value;
      searchTimer = setTimeout(function () {
        state.filter = v;
        state.page = 0;
        renderLibrary(state.lib && state.lib.wallpapers, state.lib && state.lib.current);
      }, 200);
    });
    ui.search = search;
    filterRow.appendChild(search);
    var typeSel = dropdown([["all", "全部类型"], ["scene", "场景"], ["video", "视频"], ["web", "网页"]], state.typeF || "all", function (v) {
      state.typeF = v; state.page = 0;
      renderLibrary(state.lib && state.lib.wallpapers, state.lib && state.lib.current);
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
    var footRow = el("div", "px-4 py-3 flex items-center gap-2 justify-end");
    footRow.appendChild(button("恢复默认外观", function () {
      post("/api/reset", {}).then(function () { refresh(); });
    }));
    footRow.appendChild(button("还原上次壁纸", function () {
      post("/api/restore", {}).then(function () { refresh(); });
    }));
    content.appendChild(footRow);

    card.appendChild(content);
    section.appendChild(card);
    return section;
  }

  // --- mount loop ----------------------------------------------------------------
  var scheduled = false;
  var hbRetired = false;
  // Leaving the Appearance tab: the shared container keeps foreign children,
  // so the section must be removed SYNCHRONOUSLY here — MutationObserver
  // callbacks run before paint, while the debounced scan (80ms) would leave
  // the section visible over the new tab for a few frames (visible flash).
  function onMutations() {
    var mine = document.getElementById(MARKER);
    if (mine && !appearanceSectionList()) {
      mine.remove();
      ui.libBox = null; ui.pagerBox = null; ui.badge = null; ui.search = null;
    }
    schedule();
  }
  function scan() {
    scheduled = false;
    if (hbRetired) return; // serve is gone — no stale panel without data
    var mine = document.getElementById(MARKER);
    var host = appearanceSectionList();
    if (!host) {
      // Belt and braces (the synchronous path in onMutations usually got here
      // first): never leak into another settings tab.
      if (mine) mine.remove();
      ui.libBox = null; ui.pagerBox = null; ui.badge = null; ui.search = null;
      return;
    }
    if (mine) return; // mounted and current
    sweepLegacy();
    ui.libBox = null; ui.pagerBox = null; ui.badge = null; ui.search = null;
    state.page = 0;
    var section = buildSection();
    host.appendChild(section);
    refresh();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 80);
  }
  function sweepLegacy() {
    LEGACY_IDS.forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.remove();
    });
  }

  // Lifecycle heartbeat — hard/soft contract:
  //   hard = connection REFUSED (fast reject): the serve process is really
  //   gone (plugin disabled / crash) → retire the section within ~10s.
  //   soft = timeout while the serve is alive but busy (Monet decode, sync
  //   library enumeration block its loop for seconds) → tolerated, never
  //   retires. Latched on first success: cold start (page up before the
  //   serve) doesn't count. If health returns after a retire (serve
  //   respawned), the panel revives itself.
  var hbHard = 0;
  var hbSoft = 0;
  var hbSeen = false;
  every(function () {
    var t0 = Date.now();
    fetch(API + "/api/health", { signal: AbortSignal.timeout(2500) })
      .then(function (r) { return r.json(); })
      .then(function (b) {
        if (!b || b.service !== "zcode-wallpaper") throw 0;
        var revive = hbRetired || !hbSeen;
        hbSeen = true;
        hbHard = 0;
        hbSoft = 0;
        hbRetired = false;
        if (revive) schedule(); // serve just came up (or back) — (re)mount
      })
      .catch(function () {
        if (!hbSeen) return; // cold-start race: keep waiting for the serve
        var hard = (Date.now() - t0) < 150;
        if (hard) { hbHard++; hbSoft = 0; } else { hbSoft++; hbHard = 0; }
        if (hbHard < 2 && hbSoft < 6) return;
        hbHard = 0;
        hbSoft = 0;
        hbRetired = true;
        var mine = document.getElementById(MARKER);
        if (mine) mine.remove();
      });
  }, 5000);

  var mountObserver = new MutationObserver(onMutations);
  mountObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  observers.push(mountObserver);
  // Safety rescan: React re-renders of the settings page can transiently
  // replace the host container, taking the section with it; when the
  // appearance page is back but the section is not, requiring another DOM
  // mutation (a user click) to remount reads as "the box disappeared until I
  // clicked somewhere". Poll for that state instead.
  every(function () {
    if (hbRetired) return;
    if (document.getElementById(MARKER)) return;
    if (!appearanceSectionList()) return;
    schedule();
  }, 2000);
  sweepLegacy();
  scan();

  // --- teardown (bootstrap heartbeat / reset script) ---------------------------
  window.__zwTeardownPanel = function () {
    timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
    timers = [];
    observers.forEach(function (o) { o.disconnect(); });
    observers = [];
    try { if (es) es.close(); } catch (e) {}
    [MARKER, MARKER + "-range-style"].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.remove();
    });
    hbRetired = true;
    window.__zwPanel = null;
    window.__zwPanelRefresh = null;
  };
})();
