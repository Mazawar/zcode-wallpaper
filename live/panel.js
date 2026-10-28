"use strict";
(() => {
  // live/src/panel/controls.js
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
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== void 0) e.textContent = text;
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
  function dropdown(options, value, onChange) {
    var wrap = el("div", "relative w-full");
    var trigger = el("button", CLS.trigger);
    trigger.type = "button";
    var valueSpan = el("span", "line-clamp-1 truncate");
    var currentLabel = "";
    options.forEach(function(o) {
      if (String(o[0]) === String(value)) currentLabel = o[1];
    });
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
    function onDocDown(e) {
      if (!wrap.contains(e.target)) close();
    }
    trigger.addEventListener("click", function(e) {
      e.stopPropagation();
      if (menu.style.display === "none") {
        menu.style.display = "block";
        trigger.setAttribute("data-state", "open");
        document.addEventListener("pointerdown", onDocDown, true);
      } else close();
    });
    trigger.addEventListener("keydown", function(e) {
      if (e.key === "Escape") close();
    });
    options.forEach(function(o) {
      var item = el("div", CLS.item, o[1]);
      item.setAttribute("role", "option");
      if (String(o[0]) === String(value)) item.setAttribute("aria-selected", "true");
      item.addEventListener("mouseenter", function() {
        Array.prototype.forEach.call(menu.children, function(c) {
          c.removeAttribute("data-highlighted");
        });
        item.setAttribute("data-highlighted", "true");
      });
      item.addEventListener("click", function() {
        valueSpan.textContent = o[1];
        Array.prototype.forEach.call(menu.children, function(c) {
          c.removeAttribute("data-highlighted");
          c.removeAttribute("aria-selected");
        });
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
  function setSwitch(btn, checked) {
    btn.setAttribute("data-state", checked ? "checked" : "unchecked");
    btn.setAttribute("aria-checked", checked ? "true" : "false");
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
    btn.addEventListener("click", function() {
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
  function ensureSliderStyle(marker) {
    if (document.getElementById(marker + "-range-style")) return;
    var st = document.createElement("style");
    st.id = marker + "-range-style";
    st.textContent = "input.zw-range{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:9999px;margin:0;background:linear-gradient(to right,var(--color-primary,#fff) var(--zw-fill,50%),rgba(127,127,127,.28) var(--zw-fill,50%));outline:none;cursor:pointer;}input.zw-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:var(--color-primary,#fff);border:2px solid var(--color-background,#161616);box-shadow:0 1px 3px rgba(0,0,0,.35);}";
    (document.head || document.documentElement).appendChild(st);
  }
  function paintRange(i) {
    var min = Number(i.min) || 0;
    var max = Number(i.max) || 100;
    var pct = (Number(i.value) - min) / (max - min) * 100;
    i.style.setProperty("--zw-fill", Math.max(0, Math.min(100, pct)) + "%");
  }
  function syncRange(f, k, val, unit) {
    var i = f.querySelector("[data-k=" + k + "]");
    if (!i) return;
    i.value = String(val);
    var chip = f.querySelector("[data-k=" + k + "v]");
    if (chip) chip.textContent = val + (unit || "");
    paintRange(i);
  }
  function ensurePaintStyle(marker) {
    if (document.getElementById(marker + "-paint-style")) return;
    const st = document.createElement("style");
    st.id = marker + "-paint-style";
    st.textContent = `#${marker} .zw-paint{border:1px solid var(--color-border,#ffffff1a);border-radius:8px;padding:3px;display:inline-flex;gap:4px;flex-wrap:wrap;row-gap:2px;}#${marker} .zw-paint[data-fill="1"]{display:flex;flex-wrap:nowrap;gap:2px;}#${marker} .zw-paint>button{padding:0 12px;border-radius:6px;background:transparent;color:var(--color-foreground-subtle,#999);font-weight:400;box-shadow:none;border:0;outline:none;cursor:pointer;transition:color .15s ease,background-color .15s ease;}#${marker} .zw-paint[data-fill="1"]>button{flex:1 1 0;padding:0 8px;}#${marker} .zw-paint>button:hover{color:var(--color-foreground,#eee);}#${marker} .zw-paint>button[data-active="1"]{background:var(--color-input,#2b2b2b);color:var(--color-foreground,#eee);font-weight:500;box-shadow:inset 0 0 0 1px var(--color-input-border,#ffffff33)!important;}#${marker} .zw-paint>button:focus{outline:none;}#${marker} .zw-paint>button:focus-visible{box-shadow:inset 0 0 0 1px var(--color-primary,#7aa2f7)!important;}`;
    (document.head || document.documentElement).appendChild(st);
  }
  function makeSeg(options, value, onChange, key, fill) {
    const wrap = el("div", "zw-paint");
    if (fill) {
      wrap.dataset.fill = "1";
      wrap.style.width = "100%";
    }
    wrap.setAttribute("role", "radiogroup");
    if (key) wrap.setAttribute("data-k", key);
    wrap.setAttribute("data-value", String(value));
    wrap.__zwPaint = function() {
      const cur = String(wrap.getAttribute("data-value"));
      Array.prototype.forEach.call(wrap.children, function(b) {
        b.dataset.active = b.getAttribute("data-v") === cur ? "1" : "0";
      });
    };
    options.forEach(function(o) {
      const b = el("button", "h-7 text-xs");
      b.type = "button";
      b.textContent = o[1];
      b.setAttribute("data-v", String(o[0]));
      b.addEventListener("click", function() {
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
    return { r, right };
  }
  function groupLabel(t) {
    var g = el("div", "text-sm font-semibold text-foreground");
    g.style.cssText = "padding:16px 16px 8px;font-size:15px;";
    g.textContent = t;
    return g;
  }
  function toast(text) {
    var host = document.body || document.documentElement;
    var t = el("div", "fixed right-4 bottom-4 z-[2147483647] rounded-lg bg-card px-3 py-2 text-sm text-foreground shadow-md");
    t.style.border = "1px solid var(--color-border,#ffffff1a)";
    t.textContent = text;
    host.appendChild(t);
    setTimeout(function() {
      t.remove();
    }, 2500);
  }

  // live/src/panel/library.js
  var TYPE_LABEL = { scene: "\u573A\u666F", video: "\u89C6\u9891", web: "\u7F51\u9875", image: "\u56FE\u7247", unknown: "\u672A\u77E5" };
  var ORIGIN_LABEL = { workshop: "\u5DE5\u574A\u8BA2\u9605", custom: "\u672C\u673A\u5BFC\u5165", default: "WE \u5185\u7F6E", myprojects: "WE \u5DE5\u7A0B" };
  function createLibrary({ API, PAGE_SIZE, post, state, ui }) {
    function fetchJson(url, opts) {
      return fetch(API + url, opts).then(function(r) {
        return r.json();
      });
    }
    function filteredList(list) {
      var q = (state.filter || "").trim().toLowerCase();
      var t = state.typeF || "all";
      return list.filter(function(w) {
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
        ui.libBox.appendChild(el("div", CLS.stat, "\u672A\u53D1\u73B0 Wallpaper Engine \u58C1\u7EB8\u3002\u6CA1\u6709\u5B89\u88C5 Steam / Wallpaper Engine \u4E5F\u53EF\u4EE5\uFF1A\u70B9\u300C\u5BFC\u5165\u58C1\u7EB8\u2026\u300D\u5BFC\u5165 .zw.zip \u8D44\u6E90\u5305\u3001.pkg \u573A\u666F\u6216\u89C6\u9891\u6587\u4EF6\u3002"));
        return;
      }
      var all = filteredList(list);
      if (!all.length) {
        ui.libBox.appendChild(el("div", CLS.stat, "\u6CA1\u6709\u5339\u914D\u300C" + state.filter + "\u300D\u7684\u58C1\u7EB8"));
        return;
      }
      var pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
      if (state.page >= pages) state.page = pages - 1;
      var slice = all.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);
      var grid = el("div");
      grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;";
      grid.style.alignContent = "start";
      slice.forEach(function(w) {
        var sel = w.id === currentId;
        var card = el("div");
        card.style.cssText = "position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;cursor:pointer;background:rgba(0,0,0,.3);border:1px solid " + (sel ? "var(--color-primary,#fff)" : "var(--color-border,#ffffff1a)") + ";" + (sel ? "box-shadow:0 0 0 1px var(--color-primary,#fff);" : "");
        var img = el("img");
        img.loading = "lazy";
        img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
        if (w.previewUrl) img.src = API + w.previewUrl;
        card.appendChild(img);
        var tag = el("span", null, TYPE_LABEL[w.type] || w.type || "");
        tag.style.cssText = "position:absolute;top:6px;left:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;line-height:1;padding:3px 6px;border-radius:4px;";
        card.appendChild(tag);
        if (sel) {
          var use = el("span", null, "\u4F7F\u7528\u4E2D");
          use.style.cssText = "position:absolute;top:6px;right:6px;background:var(--color-primary,#fff);color:var(--color-primary-foreground,#000);font-size:11px;line-height:1;padding:3px 6px;border-radius:4px;";
          card.appendChild(use);
        } else {
          var chips = el("div");
          chips.style.cssText = "position:absolute;top:6px;right:6px;display:flex;gap:4px;";
          var mini = function(t, title, fn) {
            var mb = el("button", null, t);
            mb.type = "button";
            mb.title = title;
            mb.style.cssText = "background:rgba(0,0,0,.6);color:#fff;font-size:11px;line-height:1;padding:3px 6px;border-radius:4px;border:0;cursor:pointer;";
            mb.addEventListener("click", function(e) {
              e.stopPropagation();
              fn();
            });
            return mb;
          };
          chips.appendChild(mini("\u5BFC\u51FA", "\u6253\u5305\u4E3A .zw.zip\uFF0C\u53EF\u5728\u53E6\u4E00\u53F0\u7535\u8111\u5BFC\u5165", function() {
            var a = el("a");
            a.href = API + "/api/export?id=" + encodeURIComponent(w.id);
            a.download = "";
            document.body.appendChild(a);
            a.click();
            a.remove();
          }));
          if (w.origin === "custom") {
            chips.appendChild(mini("\u5220\u9664", "\u4ECE\u5E93\u4E2D\u5220\u9664\uFF08\u6B63\u5728\u4F7F\u7528\u4F1A\u81EA\u52A8\u5207\u6362\uFF09", function() {
              post("/api/delete-source", { id: w.id }).then(function(r) {
                if (r.error) {
                  toast("\u5220\u9664\u5931\u8D25\uFF1A" + r.error);
                  return;
                }
                toast("\u5DF2\u5220\u9664\u300C" + (w.title || w.id) + "\u300D" + (r.switchedTo ? "\uFF0C\u5DF2\u5207\u6362\u5230\u300C" + r.switchedTo + "\u300D" : ""));
                state.page = 0;
                state.onChanged && state.onChanged();
              }).catch(function(err) {
                toast("\u5220\u9664\u5931\u8D25\uFF1A" + (err && err.message ? err.message : "\u7F51\u7EDC\u9519\u8BEF"));
              });
            }));
          }
          card.appendChild(chips);
        }
        var name = el("div", null, w.title || w.id);
        name.style.cssText = "position:absolute;left:0;right:0;bottom:0;padding:16px 8px 6px;color:#fff;font-size:12px;background:linear-gradient(transparent,rgba(0,0,0,.78));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        card.appendChild(name);
        var lastApply = 0;
        card.addEventListener("click", function() {
          if (Date.now() - lastApply < 600) return;
          lastApply = Date.now();
          post("/api/apply-source", { sourceId: w.id }).then(function(r) {
            if (!r.error) state.onChanged && state.onChanged();
          }).catch(function() {
          });
        });
        grid.appendChild(card);
      });
      ui.libBox.appendChild(grid);
      requestAnimationFrame(function() {
        if (!grid.firstChild) return;
        if (!grid.offsetParent) return;
        if (slice.length === PAGE_SIZE && pages > 1) {
          state.gridH = grid.offsetHeight;
        }
        if (state.gridH) grid.style.minHeight = state.gridH + "px";
        else {
          var rows = Math.ceil(PAGE_SIZE / 4);
          grid.style.minHeight = rows * grid.firstChild.offsetHeight + (rows - 1) * 8 + "px";
        }
      });
      var pager = el("div", "flex items-center justify-end gap-2 mt-2");
      var prev = button("\u4E0A\u4E00\u9875", function() {
        if (state.page > 0) {
          state.page--;
          render(state.lib && state.lib.wallpapers, state.lib && state.lib.current);
        }
      }, null, CLS.btnIcon);
      if (state.page === 0) {
        prev.disabled = true;
        prev.classList.add("opacity-50", "cursor-not-allowed");
      }
      pager.appendChild(prev);
      pager.appendChild(el("span", "text-sm text-foreground-subtle", state.page + 1 + " / " + pages + " \u9875 \xB7 \u5171 " + all.length + " \u9879" + (all.length !== list.length ? "\uFF08\u7B5B\u9009\u81EA " + list.length + "\uFF09" : "")));
      var next = button("\u4E0B\u4E00\u9875", function() {
        if (state.page < pages - 1) {
          state.page++;
          render(state.lib && state.lib.wallpapers, state.lib && state.lib.current);
        }
      }, null, CLS.btnIcon);
      if (state.page >= pages - 1) {
        next.disabled = true;
        next.classList.add("opacity-50", "cursor-not-allowed");
      }
      pager.appendChild(next);
      ui.pagerBox.appendChild(pager);
    }
    function renderCurrent(d) {
      if (!ui.curTitle) return;
      var cur = null;
      if (d && d.current && d.wallpapers) {
        for (var i = 0; i < d.wallpapers.length; i++) if (d.wallpapers[i].id === d.current) {
          cur = d.wallpapers[i];
          break;
        }
      }
      if (cur) {
        ui.curTitle.textContent = cur.title || cur.id;
        ui.curMeta.textContent = (TYPE_LABEL[cur.type] || cur.type || "") + " \xB7 " + (ORIGIN_LABEL[cur.origin] || cur.origin || "");
        ui.curBadge.textContent = "\u4F7F\u7528\u4E2D";
        ui.curBadge.style.display = "";
        if (cur.previewUrl) {
          ui.curPoster.src = API + cur.previewUrl;
          ui.curPoster.style.display = "";
        } else ui.curPoster.style.display = "none";
      } else if (state.cfg && state.cfg.wallpaperSet) {
        ui.curTitle.textContent = "\u56FE\u7247\u58C1\u7EB8";
        ui.curMeta.textContent = "\u901A\u8FC7\u300C\u5BFC\u5165\u58C1\u7EB8\u2026\u300D\u8BBE\u7F6E\u7684\u9759\u6001\u56FE\u7247";
        ui.curBadge.textContent = "\u4F7F\u7528\u4E2D";
        ui.curBadge.style.display = "";
        ui.curPoster.style.display = "none";
      } else {
        ui.curTitle.textContent = "\u672A\u8BBE\u7F6E\u58C1\u7EB8";
        ui.curMeta.textContent = "\u4ECE\u4E0B\u65B9\u58C1\u7EB8\u5E93\u9009\u62E9\uFF0C\u6216\u70B9\u300C\u5BFC\u5165\u58C1\u7EB8\u2026\u300D";
        ui.curBadge.style.display = "none";
        ui.curPoster.style.display = "none";
      }
    }
    return { render, renderCurrent };
  }

  // live/src/panel/mount.js
  var MARKER = "zcode-wallpaper-settings-v6";
  var LEGACY_IDS = ["zcode-wallpaper-settings", "zcode-wallpaper-settings-2"];
  var H2_TEXT = /^(外观|Appearance)$/;
  function appearanceSectionList() {
    const h2 = Array.prototype.find.call(document.querySelectorAll("h2"), function(h) {
      return H2_TEXT.test((h.textContent || "").trim()) && h.offsetParent !== null;
    });
    if (!h2) return null;
    const main = h2.closest("main");
    const col = main && main.querySelector(".max-w-4xl");
    if (!col || !col.contains(h2)) return null;
    if (!/(界面主题|Interface theme|界面主題)/.test(col.textContent || "")) return null;
    return col.querySelector(".space-y-8") || col;
  }
  function createMountLoop({ API, reg, buildSection }) {
    let scheduled = false;
    let hbRetired = false;
    let hbHard = 0;
    let hbSoft = 0;
    let hbSeen = false;
    let resetUi = function() {
    };
    function sweepLegacy() {
      LEGACY_IDS.forEach(function(id) {
        const e = document.getElementById(id);
        if (e) e.remove();
      });
    }
    function onMutations() {
      const mine = document.getElementById(MARKER);
      if (mine && !appearanceSectionList()) {
        mine.remove();
        resetUi();
      }
      schedule();
    }
    function scan() {
      scheduled = false;
      if (hbRetired) return;
      const mine = document.getElementById(MARKER);
      const host = appearanceSectionList();
      if (!host) {
        if (mine) mine.remove();
        resetUi();
        return;
      }
      if (mine) return;
      sweepLegacy();
      resetUi();
      buildSection(host);
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      reg.timer(scan, 80);
    }
    function start() {
      const mountObserver = new MutationObserver(onMutations);
      mountObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
      reg.observer(mountObserver);
      reg.every(function() {
        if (hbRetired) return;
        if (document.getElementById(MARKER)) return;
        if (!appearanceSectionList()) return;
        schedule();
      }, 2e3);
      reg.every(function() {
        const t0 = Date.now();
        fetch(API + "/api/health", { signal: AbortSignal.timeout(2500) }).then(function(r) {
          return r.json();
        }).then(function(b) {
          if (!b || b.service !== "zcode-wallpaper") throw 0;
          const revive = hbRetired || !hbSeen;
          hbSeen = true;
          hbHard = 0;
          hbSoft = 0;
          hbRetired = false;
          if (revive) schedule();
        }).catch(function() {
          if (!hbSeen) return;
          const hard = Date.now() - t0 < 150;
          if (hard) {
            hbHard++;
            hbSoft = 0;
          } else {
            hbSoft++;
            hbHard = 0;
          }
          if (hbHard < 2 && hbSoft < 6) return;
          hbHard = 0;
          hbSoft = 0;
          hbRetired = true;
          const mine = document.getElementById(MARKER);
          if (mine) mine.remove();
        });
      }, 5e3);
      sweepLegacy();
      scan();
    }
    return {
      start,
      schedule,
      get retired() {
        return hbRetired;
      },
      onResetUi(fn) {
        resetUi = fn;
      },
      teardown() {
        hbRetired = true;
        [MARKER, MARKER + "-range-style"].forEach(function(id) {
          const n = document.getElementById(id);
          if (n) n.remove();
        });
      }
    };
  }

  // live/src/panel/main.js
  (function() {
    if (window.__zwPanel) return;
    window.__zwPanel = true;
    const PANEL_VERSION = false ? "dev" : "1.0.6";
    const API = window.__zwApiBase || "http://127.0.0.1:28257";
    const PAGE_SIZE = 15;
    const timers = [];
    const observers = [];
    let es = null;
    const reg = {
      every(fn, ms) {
        const t = setInterval(fn, ms);
        timers.push(t);
        return t;
      },
      timer(fn, ms) {
        const t = setTimeout(fn, ms);
        timers.push(t);
        return t;
      },
      observer(o) {
        observers.push(o);
      }
    };
    const state = { cfg: null, lib: null, page: 0, filter: "", typeF: "all", gridH: 0, tab: "lib" };
    const ui = { libBox: null, pagerBox: null, badge: null, search: null, failBox: null };
    function fetchJson(url, opts) {
      return fetch(API + url, opts).then(function(r) {
        return r.json();
      });
    }
    function post(path, body) {
      return fetchJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    }
    function pushConfig(patch) {
      post("/api/config", patch).catch(function() {
      });
    }
    let soonTimer = null;
    let soonPatch = {};
    function pushConfigSoon(patch) {
      for (const k in patch) soonPatch[k] = patch[k];
      if (soonTimer) return;
      soonTimer = setTimeout(function() {
        soonTimer = null;
        const body = soonPatch;
        soonPatch = {};
        pushConfig(body);
      }, 180);
    }
    state.onChanged = refresh;
    const library = createLibrary({ API, PAGE_SIZE, post, state, ui });
    function refresh() {
      fetchJson("/api/config").then(function(c) {
        state.cfg = c;
        if (ui.badge) {
          ui.badge.textContent = c.liveFailed ? "\u5B9E\u65F6\u6E32\u67D3\u5931\u8D25\uFF08\u5DF2\u56DE\u9000\u9884\u89C8\u56FE\uFF09" : c.mediaType === "live" ? "\u5B9E\u65F6\u573A\u666F" : c.mediaType === "video" ? "\u89C6\u9891\u58C1\u7EB8" : c.wallpaperSet ? "\u56FE\u7247" : "\u672A\u8BBE\u7F6E";
        }
        if (ui.failBox) {
          const fail = c.liveFailed;
          ui.failBox.style.display = fail ? "" : "none";
          if (fail) ui.failBox.querySelector("[data-role=fail-reason]").textContent = fail.reason || "\u672A\u77E5\u539F\u56E0";
        }
        const f = document.getElementById(MARKER);
        if (!f) return;
        const q = function(k) {
          return f.querySelector("[data-k=" + k + "]");
        };
        syncRange(f, "blur", c.blur, "px");
        syncRange(f, "dim", c.dim, "%");
        const monet = q("monet");
        if (monet) setSwitch(monet, !!c.monet);
        const vis = q("vis");
        if (vis) setSwitch(vis, !!c.wallpaperVisible);
        const mute = q("mute");
        if (mute) setSwitch(mute, c.liveMuted !== false);
        syncRange(f, "bright", c.wallBrightness == null ? 100 : c.wallBrightness, "%");
        syncRange(f, "contrast", c.wallContrast == null ? 100 : c.wallContrast, "%");
        syncRange(f, "saturate", c.wallSaturate == null ? 100 : c.wallSaturate, "%");
        syncRange(f, "opacity", c.wallOpacity == null ? 0 : c.wallOpacity, "%");
        syncRange(f, "posx", c.posX == null ? 50 : c.posX, "");
        syncRange(f, "posy", c.posY == null ? 50 : c.posY, "");
        syncRange(f, "scale", c.layerScale == null ? 100 : c.layerScale, "%");
        const flip = q("flip");
        if (flip) setSwitch(flip, !!c.flip);
        const rot = q("rot");
        if (rot) setSwitch(rot, !!c.rotationEnabled);
        setSeg(f, "fit", c.fit || "cover");
        setSeg(f, "fps", String(c.liveFps || 30));
        setSeg(f, "qual", c.liveQuality || "balanced");
        setSeg(f, "trans", c.switchTransition || "fade");
        setSeg(f, "tspd", c.switchTransitionSpeed || "normal");
        setSeg(f, "rotmin", String(c.rotationMinutes || 30));
        setSeg(f, "rotord", c.rotationOrder === "random" ? "random" : "sequence");
      }).catch(function() {
      });
      fetchJson("/api/wallpapers").then(function(d) {
        state.lib = d;
        library.renderCurrent(d);
        if (ui.libBox) library.render(d.wallpapers, d.current);
      }).catch(function() {
      });
    }
    window.__zwPanelRefresh = refresh;
    if (window.EventSource) {
      try {
        es = new EventSource(API + "/api/events?client=panel");
        es.addEventListener("cfg", function() {
          refresh();
        });
      } catch (e) {
      }
    }
    function buildSection(host) {
      const section = el("div", CLS.section);
      section.id = MARKER;
      const head = el("div", "flex flex-wrap items-center justify-between gap-2");
      const headText = el("div");
      const titleRow = el("div", "flex items-center gap-2");
      titleRow.appendChild(el("h3", CLS.title, "\u58C1\u7EB8\u5F15\u64CE"));
      const verBadge = el("span", CLS.badge, "p" + PANEL_VERSION);
      verBadge.title = "\u9762\u677F\u6784\u5EFA\u7248\u672C\uFF08\u5BF9\u6BD4\u63D2\u4EF6\u7248\u672C\u53EF\u53D1\u73B0\u672A\u91CD\u542F\u7684\u65E7\u9762\u677F\uFF09";
      titleRow.appendChild(verBadge);
      headText.appendChild(titleRow);
      headText.appendChild(el("p", CLS.desc, "\u4F7F\u7528 Wallpaper Engine \u8BA2\u9605\u7684\u58C1\u7EB8\uFF1A\u573A\u666F\u4E3A\u5B9E\u65F6\u6E32\u67D3\uFF08\u4FDD\u7559\u7C92\u5B50\u3001\u811A\u672C\u4E0E\u9F20\u6807\u89C6\u5DEE\uFF09\uFF0C\u56FE\u7247\u4E0E\u89C6\u9891\u4EA6\u53EF\u4F5C\u4E3A\u80CC\u666F\u3002"));
      head.appendChild(headText);
      ui.badge = el("span", CLS.badge, "\u2026");
      ui.badge.title = "\u5F53\u524D\u58C1\u7EB8\u72B6\u6001";
      head.appendChild(ui.badge);
      section.appendChild(head);
      ui.failBox = el("div");
      ui.failBox.style.cssText = "display:none;margin-top:8px;padding:10px 12px;border:1px solid var(--color-border,#ffffff1a);border-radius:10px;font-size:13px;color:var(--color-foreground,#eee);";
      const failText = el("span");
      failText.setAttribute("data-role", "fail-reason");
      const failBtn = button("\u91CD\u8BD5\u5B9E\u65F6\u6E32\u67D3", function() {
        post("/api/live-retry", {}).then(function() {
          refresh();
        }).catch(function() {
          toast("\u91CD\u8BD5\u5931\u8D25\uFF1A\u7F51\u7EDC\u9519\u8BEF");
        });
      }, "\u6E05\u9664\u8BE5\u58C1\u7EB8\u7684\u5931\u8D25\u8BB0\u5FC6\uFF0C\u91CD\u65B0\u5C1D\u8BD5\u5B9E\u65F6\u6E32\u67D3");
      failBtn.style.marginLeft = "10px";
      ui.failBox.appendChild(el("span", null, "\u5B9E\u65F6\u6E32\u67D3\u5931\u8D25\uFF1A"));
      ui.failBox.appendChild(failText);
      ui.failBox.appendChild(failBtn);
      section.appendChild(ui.failBox);
      const card = el("div", CLS.card);
      card.setAttribute("data-slot", "card");
      const content = el("div", CLS.content);
      content.setAttribute("data-slot", "card-content");
      ensureSliderStyle(MARKER);
      ensurePaintStyle(MARKER);
      const tabBar = el("div", "zw-paint rounded-lg");
      tabBar.dataset.fill = "1";
      tabBar.style.margin = "12px 16px 2px";
      tabBar.setAttribute("data-value", "lib");
      function tabBtn(label, v) {
        const b = el("button", "h-8 text-sm");
        b.type = "button";
        b.textContent = label;
        b.setAttribute("data-v", v);
        tabBar.appendChild(b);
        return b;
      }
      const tabLibBtn = tabBtn("\u58C1\u7EB8\u5E93", "lib");
      const tabPlayBtn = tabBtn("\u753B\u9762\u4E0E\u64AD\u653E", "play");
      tabBar.__zwPaint = function() {
        const cur = String(tabBar.getAttribute("data-value"));
        Array.prototype.forEach.call(tabBar.children, function(b) {
          b.dataset.active = b.getAttribute("data-v") === cur ? "1" : "0";
        });
      };
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
        tabBar.setAttribute("data-value", isLib ? "lib" : "play");
        tabBar.__zwPaint();
        state.tab = isLib ? "lib" : "play";
        try {
          localStorage.setItem("zw-panel-tab", state.tab);
        } catch (e) {
        }
      }
      tabLibBtn.addEventListener("click", function() {
        showTab("lib");
      });
      tabPlayBtn.addEventListener("click", function() {
        showTab("play");
      });
      tabBar.__zwPaint();
      showTab((function() {
        try {
          return localStorage.getItem("zw-panel-tab") || "lib";
        } catch (e) {
          return "lib";
        }
      })());
      tabLib.appendChild(groupLabel("\u5F53\u524D\u58C1\u7EB8"));
      const curCard = el("div", "border-t border-border");
      curCard.style.cssText = "padding:12px 16px;display:flex;align-items:center;gap:14px;";
      ui.curPoster = el("img");
      ui.curPoster.loading = "lazy";
      ui.curPoster.style.cssText = "width:120px;height:68px;border-radius:8px;object-fit:cover;background:rgba(0,0,0,.25);flex:none;";
      const curInfo = el("div", "min-w-0 flex-1");
      ui.curTitle = el("div", "text-sm font-medium text-foreground truncate", "\u2026");
      ui.curMeta = el("div", "text-xs text-foreground-subtle truncate");
      curInfo.appendChild(ui.curTitle);
      curInfo.appendChild(ui.curMeta);
      ui.curBadge = el("span", CLS.badge, "\u2026");
      curCard.appendChild(ui.curPoster);
      curCard.appendChild(curInfo);
      curCard.appendChild(ui.curBadge);
      tabLib.appendChild(curCard);
      tabPlay.appendChild(groupLabel("\u753B\u9762"));
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
        i.addEventListener("input", function() {
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
      knobs.appendChild(sliderRow("blur", "blur", "\u6A21\u7CCA", 0, 40, "px", 0));
      knobs.appendChild(sliderRow("dim", "dim", "\u538B\u6697", 0, 100, "%", 0));
      knobs.appendChild(sliderRow("bright", "wallBrightness", "\u4EAE\u5EA6", 40, 160, "%", 100));
      knobs.appendChild(sliderRow("contrast", "wallContrast", "\u5BF9\u6BD4\u5EA6", 40, 200, "%", 100));
      knobs.appendChild(sliderRow("saturate", "wallSaturate", "\u9971\u548C\u5EA6", 0, 200, "%", 100));
      knobs.appendChild(sliderRow("opacity", "wallOpacity", "\u900F\u660E\u5EA6", 0, 90, "%", 0));
      knobs.appendChild(sliderRow("posx", "posX", "\u6C34\u5E73", 0, 100, "", 50));
      knobs.appendChild(sliderRow("posy", "posY", "\u5782\u76F4", 0, 100, "", 50));
      knobs.appendChild(sliderRow("scale", "layerScale", "\u7F29\u653E", 50, 150, "%", 100));
      tabPlay.appendChild(knobs);
      const rFit = prow("\u9002\u914D", "\u8986\u76D6 = \u88C1\u5207\u94FA\u6EE1 \xB7 \u7559\u8FB9 = \u5B8C\u6574\u663E\u793A \xB7 \u62C9\u4F38 = \u53D8\u5F62\u586B\u6EE1 \xB7 \u667A\u80FD = \u81EA\u52A8\u6784\u56FE\u3002");
      rFit.right.style.flex = "1 1 0";
      rFit.right.style.minWidth = "240px";
      rFit.right.appendChild(makeSeg([["cover", "\u8986\u76D6"], ["contain", "\u7559\u8FB9"], ["stretch", "\u62C9\u4F38"], ["smart", "\u667A\u80FD"]], "cover", function(v) {
        pushConfig({ fit: v });
      }, "fit", true));
      tabPlay.appendChild(rFit.r);
      const rLive = prow("\u5E27\u7387\u4E0A\u9650", "\u573A\u666F\u6E32\u67D3\u5E27\u7387\uFF1B\u89C6\u9891\u6309\u6E90\u5E27\u7387\u64AD\u653E\u3002");
      const fpsSeg = makeSeg([["15", "15"], ["30", "30"], ["60", "60"]], "30", function(v) {
        pushConfig({ liveFps: Number(v) });
      }, "fps", true);
      fpsSeg.style.maxWidth = "200px";
      rLive.right.appendChild(fpsSeg);
      rLive.right.appendChild(makeSwitch(true, function(v) {
        pushConfig({ liveMuted: v });
      }, "\u9759\u97F3", "mute"));
      tabPlay.appendChild(rLive.r);
      const rQual = prow("\u6E32\u67D3\u8D28\u91CF", "\u6863\u4F4D\u6253\u5305\u5206\u8FA8\u7387\u4E0A\u9650\u3001\u6297\u952F\u9F7F\u3001\u7C92\u5B50\u4E0E\u540E\u5904\u7406\uFF1A\u7701\u7535=0.75\xD7\u903B\u8F91\u5206\u8FA8\u7387+\u5173\u7279\u6548\uFF1B\u5747\u8861=1\xD7+\u4E2D\u6863\u7279\u6548\uFF08\u9ED8\u8BA4\uFF09\uFF1B\u9AD8\u753B\u8D28/\u6781\u81F4=\u539F\u751F\u5206\u8FA8\u7387+\u9AD8\u6863\u7279\u6548\u3002\u5373\u6539\u5373\u70ED\u66F4\u751F\u6548\u3002");
      rQual.right.style.flex = "1 1 0";
      rQual.right.style.minWidth = "260px";
      rQual.right.appendChild(makeSeg([["low", "\u7701\u7535"], ["balanced", "\u5747\u8861"], ["high", "\u9AD8\u753B\u8D28"], ["ultra", "\u6781\u81F4"]], "balanced", function(v) {
        pushConfig({ liveQuality: v });
      }, "qual", true));
      tabPlay.appendChild(rQual.r);
      const rFlip = prow("\u6C34\u5E73\u7FFB\u8F6C", "\u955C\u50CF\u6574\u4E2A\u58C1\u7EB8\u5C42\uFF0C\u7EAF\u5408\u6210\u5668\u64CD\u4F5C\u3002");
      rFlip.right.appendChild(makeSwitch(false, function(v) {
        pushConfig({ flip: v });
      }, "\u7FFB\u8F6C", "flip"));
      tabPlay.appendChild(rFlip.r);
      tabPlay.appendChild(groupLabel("\u53D6\u8272"));
      const rTheme = prow("Monet \u52A8\u6001\u53D6\u8272", "\u4ECE\u58C1\u7EB8\u771F\u5B9E\u6E32\u67D3\u50CF\u7D20\u63D0\u53D6 Material Design 3 \u914D\u8272\u9002\u914D\u754C\u9762\uFF1B\u5173\u95ED\u300C\u663E\u793A\u58C1\u7EB8\u300D\u5219\u53EA\u53D6\u8272\u4E0D\u94FA\u56FE\u3002");
      rTheme.right.appendChild(makeSwitch(true, function(v) {
        pushConfig({ monet: v });
      }, "\u53D6\u8272", "monet"));
      rTheme.right.appendChild(makeSwitch(true, function(v) {
        pushConfig({ wallpaperVisible: v });
      }, "\u663E\u793A\u58C1\u7EB8", "vis"));
      tabPlay.appendChild(rTheme.r);
      const libRow = tabLib;
      const actRow = el("div");
      actRow.style.cssText = "padding:10px 16px 4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
      let livePaused = false;
      const pauseBtn = button("\u6682\u505C", function() {
        livePaused = !livePaused;
        pauseBtn.textContent = livePaused ? "\u7EE7\u7EED" : "\u6682\u505C";
        Array.prototype.forEach.call(document.querySelectorAll("iframe"), function(f) {
          if ((f.getAttribute("src") || "").indexOf("/live/index.html") !== -1) {
            try {
              f.contentWindow.postMessage({ zw: livePaused ? "pause" : "resume", user: true }, "*");
            } catch (e) {
            }
          }
        });
        const v = document.getElementById("zcode-wallpaper-video");
        if (v) {
          if (livePaused) {
            v.pause();
          } else {
            v.play().catch(function() {
            });
          }
        }
      }, "\u6682\u505C/\u6062\u590D\u5B9E\u65F6\u6E32\u67D3");
      actRow.appendChild(pauseBtn);
      actRow.appendChild(button("\u5237\u65B0", function() {
        refresh();
      }));
      const importFile = el("input");
      importFile.type = "file";
      importFile.accept = "image/*,.zip,.pkg,.mp4,.webm";
      importFile.className = "hidden";
      importFile.addEventListener("change", function() {
        const f = importFile.files && importFile.files[0];
        if (!f) return;
        state.page = 0;
        if (/^image\//.test(f.type)) {
          const fr = new FileReader();
          fr.onload = function() {
            post("/api/wallpaper", { dataUri: fr.result }).then(function(r) {
              if (r.error) toast("\u5BFC\u5165\u5931\u8D25\uFF1A" + r.error);
              else {
                toast("\u56FE\u7247\u5DF2\u5E94\u7528");
                refresh();
              }
            }).catch(function() {
              toast("\u5BFC\u5165\u5931\u8D25\uFF1A\u7F51\u7EDC\u9519\u8BEF");
            });
          };
          fr.readAsDataURL(f);
        } else {
          fetch(API + "/api/upload-wallpaper?apply=1", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream", "X-ZW-Filename": encodeURIComponent(f.name) },
            body: f
          }).then(function(r) {
            return r.json();
          }).then(function(r) {
            if (r.error) {
              toast("\u5BFC\u5165\u5931\u8D25\uFF1A" + r.error);
              return;
            }
            toast("\u5DF2\u5BFC\u5165\u300C" + (r.title || f.name) + "\u300D" + (r.mediaType === "live" ? "\uFF08\u5B9E\u65F6\u6E32\u67D3\uFF09" : ""));
            refresh();
          }).catch(function() {
            toast("\u5BFC\u5165\u5931\u8D25\uFF1A\u7F51\u7EDC\u9519\u8BEF");
          });
        }
        importFile.value = "";
      });
      actRow.appendChild(button("\u5BFC\u5165\u58C1\u7EB8\u2026", function() {
        importFile.click();
      }, "\u652F\u6301\uFF1A\u56FE\u7247\u3001.zw.zip \u8D44\u6E90\u5305\u3001.pkg \u573A\u666F\u3001.mp4/.webm \u89C6\u9891\uFF08\u65E0\u9700 Wallpaper Engine\uFF09"));
      actRow.appendChild(importFile);
      libRow.appendChild(actRow);
      libRow.appendChild(groupLabel("\u5207\u6362\u8FC7\u573A"));
      const rTrans = prow("\u8FC7\u573A\u52A8\u753B", "\u5207\u6362\u65F6\u65E7\u753B\u9762\u9000\u573A\u7684\u6548\u679C\uFF08\u65B0\u753B\u9762\u5728\u4E0B\u65B9\u63A5\u66FF\uFF09\u3002");
      rTrans.right.appendChild(makeSeg([["fade", "\u6DE1\u5165"], ["push", "\u63A8\u79FB"], ["wipe", "\u64E6\u9664"], ["iris", "\u5149\u5708"], ["zoom", "\u7F29\u653E"], ["cut", "\u76F4\u63A5"]], "fade", function(v) {
        pushConfig({ switchTransition: v });
      }, "trans"));
      rTrans.right.appendChild(makeSeg([["fast", "\u5FEB"], ["normal", "\u6807\u51C6"], ["slow", "\u6162"]], "normal", function(v) {
        pushConfig({ switchTransitionSpeed: v });
      }, "tspd"));
      libRow.appendChild(rTrans.r);
      libRow.appendChild(groupLabel("\u81EA\u52A8\u8F6E\u64AD"));
      const rRot = prow("\u81EA\u52A8\u8F6E\u8F6C", "\u6309\u95F4\u9694\u5728\u58C1\u7EB8\u5E93\uFF08\u8BA2\u9605 + \u672C\u673A\u5BFC\u5165\uFF09\u4E2D\u81EA\u52A8\u5207\u6362\u3002");
      rRot.right.appendChild(makeSeg([["sequence", "\u987A\u5E8F"], ["random", "\u968F\u673A"]], "sequence", function(v) {
        pushConfig({ rotationOrder: v });
      }, "rotord"));
      rRot.right.appendChild(makeSeg([["5", "5 \u5206"], ["15", "15 \u5206"], ["30", "30 \u5206"], ["60", "1 \u5C0F\u65F6"], ["120", "2 \u5C0F\u65F6"]], "30", function(v) {
        pushConfig({ rotationMinutes: Number(v) });
      }, "rotmin"));
      rRot.right.appendChild(makeSwitch(false, function(v) {
        pushConfig({ rotationEnabled: v });
      }, "\u8F6E\u64AD", "rot"));
      libRow.appendChild(rRot.r);
      libRow.appendChild(groupLabel("\u58C1\u7EB8\u5E93"));
      const filterRow = el("div");
      filterRow.style.cssText = "padding:2px 16px 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
      const search = el("input", CLS.input);
      search.type = "search";
      search.placeholder = "\u641C\u7D22\u58C1\u7EB8\uFF08\u540D\u79F0 / \u7C7B\u578B / \u6765\u6E90\uFF09";
      search.value = state.filter || "";
      search.style.cssText = "flex:1 1 180px;min-width:160px;";
      let searchTimer = null;
      search.addEventListener("input", function() {
        clearTimeout(searchTimer);
        const v = search.value;
        searchTimer = setTimeout(function() {
          state.filter = v;
          state.page = 0;
          library.render(state.lib && state.lib.wallpapers, state.lib && state.lib.current);
        }, 200);
      });
      ui.search = search;
      filterRow.appendChild(search);
      const typeSel = dropdown([["all", "\u5168\u90E8\u7C7B\u578B"], ["scene", "\u573A\u666F"], ["video", "\u89C6\u9891"], ["web", "\u7F51\u9875"]], state.typeF || "all", function(v) {
        state.typeF = v;
        state.page = 0;
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
      const footRow = el("div", "px-4 py-3 flex items-center gap-2 justify-end");
      footRow.appendChild(button("\u6062\u590D\u9ED8\u8BA4\u5916\u89C2", function() {
        post("/api/reset", {}).then(function() {
          refresh();
        });
      }));
      footRow.appendChild(button("\u8FD8\u539F\u4E0A\u6B21\u58C1\u7EB8", function() {
        post("/api/restore", {}).then(function() {
          refresh();
        });
      }));
      content.appendChild(footRow);
      card.appendChild(content);
      section.appendChild(card);
      host.appendChild(section);
      refresh();
    }
    const mount = createMountLoop({ API, reg, buildSection });
    mount.onResetUi(function() {
      ui.libBox = null;
      ui.pagerBox = null;
      ui.badge = null;
      ui.search = null;
      ui.failBox = null;
      state.page = 0;
    });
    mount.start();
    window.__zwTeardownPanel = function() {
      timers.forEach(function(t) {
        clearTimeout(t);
        clearInterval(t);
      });
      observers.forEach(function(o) {
        o.disconnect();
      });
      try {
        if (es) es.close();
      } catch (e) {
      }
      mount.teardown();
      window.__zwPanel = null;
      window.__zwPanelRefresh = null;
    };
  })();
})();
