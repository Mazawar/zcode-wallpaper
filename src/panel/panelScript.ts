/**
 * The wallpaper settings section, injected into ZCode's Settings → Appearance
 * (外观) page as a native-looking custom section at the bottom of the section list.
 *
 * Pure vanilla JS (string form), run inside the ZCode page:
 *   - mounts ONLY while the Appearance page is visible: all settings tabs share
 *     one React-managed `.space-y-8` container, and a foreign child survives
 *     tab switches — so the scan removes the section the moment the Appearance
 *     heading is off screen and remounts when it returns
 *   - build versioning: CDP-registered scripts outlive their serve process and
 *     replay on reload. Protocol (since 1.0.0): a numeric version in
 *     `window.__zwSettingsBoot`; a build whose version is lower than the
 *     current flag retires (disconnects its observer) — so from this build on,
 *     all versions share one stable section id and the newest wins without a
 *     remove/remount war. Sections from pre-1.0.0 builds (different ids) are
 *     neutralized in the same frame (before paint) by the counter-observer.
 *   - markup mirrors ZCode's own settings structure and control classes, so
 *     light/dark themes and typography match the built-in cards
 *   - wallpaper library: search + pagination at a fixed grid height; import by
 *     path (directory / .pkg / .zw.zip) or native file picker; export packages
 *   - talks to the serve control API over CORS-enabled fetch
 */

export function buildPanelScript(apiPort: number): string {
  return `(function () {
  var API = 'http://127.0.0.1:${apiPort}';
  var MARKER = 'zcode-wallpaper-settings-v6';
  var LEGACY_IDS = ['zcode-wallpaper-settings', 'zcode-wallpaper-settings-2'];
  var H2_TEXT = /^(外观|Appearance)$/;
  var PAGE_SIZE = 6;
  var V = 12;
  // NOTE: bump V on EVERY deployed change (even content-only edits) — a same-
  // version redeploy is a no-op on a live page (flag already set), and the
  // older registration keeps running with the stale logic.
  var flag = window.__zwSettingsBoot;
  if (flag === V) return;            // same build already running
  if (typeof flag === 'number' && flag > V) return; // a newer build owns the page
  window.__zwSettingsBoot = V;

  // --- counter-observer for pre-1.0.0 builds ---------------------------------
  // Those builds mount on their own ids and actively remove anything else.
  // Mutation callbacks run before paint, so their sections never flash.
  var neutralize = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var added = muts[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n && n.id && LEGACY_IDS.indexOf(n.id) >= 0) n.remove();
      }
    }
  });
  function sweepLegacy() {
    LEGACY_IDS.forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.remove();
    });
  }

  var state = { cfg: null, lib: null, page: 0, filter: '', gridH: 0 };
  var ui = { libBox: null, pagerBox: null, badge: null, search: null };
  var mountObserver = null;

  function fetchJson(url, opts) {
    return fetch(API + url, opts).then(function (r) { return r.json(); });
  }
  function post(path, body) {
    return fetchJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  // --- the Appearance settings page, only while it is the active tab --------
  // Other settings pages (e.g. scheduled-task settings) carry their own visible
  // "外观" heading in an identical layout, so the heading alone is not enough:
  // the real Appearance page also contains the 界面主题 (theme) control.
  function appearanceSectionList() {
    var h2 = Array.prototype.find.call(document.querySelectorAll('h2'), function (h) {
      return H2_TEXT.test((h.textContent || '').trim()) && h.offsetParent !== null;
    });
    if (!h2) return null;
    var main = h2.closest('main');
    var col = main && main.querySelector('.max-w-4xl');
    if (!col || !col.contains(h2)) return null;
    if (!/(界面主题|Interface theme|界面主題)/.test(col.textContent || '')) return null;
    return col.querySelector('.space-y-8') || col;
  }

  // --- class strings captured from ZCode's own settings UI ---------------------
  var CLS = {
    section: 'min-w-0 space-y-3',
    title: 'text-ui-lg font-semibold text-foreground',
    desc: 'mt-1 text-ui-base leading-6 text-foreground-subtle',
    card: 'group/card flex flex-col gap-4 overflow-hidden rounded-xl text-ui-base/relaxed text-foreground border border-border bg-card py-0 shadow-none',
    content: 'space-y-0 px-0',
    row: 'border-t border-border px-4 py-3 first:border-t-0',
    grid: 'grid items-center gap-4 grid-cols-[minmax(0,1fr)_192px]',
    label: 'text-ui-base font-medium text-foreground',
    rowDesc: 'mt-1 text-ui-base leading-6 text-foreground-subtle',
    ctrl: 'flex w-full flex-nowrap items-center justify-end gap-2',
    btn: 'cursor-pointer border border-input-border bg-background text-foreground hover:border-input-border-hover hover:bg-input rounded-lg h-8 px-3 text-sm outline-none transition-colors',
    btnIcon: 'cursor-pointer inline-flex items-center justify-center gap-1 border border-input-border bg-background text-foreground hover:border-input-border-hover hover:bg-input rounded-md h-6 px-1.5 text-xs outline-none transition-colors',
    trigger: 'flex items-center justify-between gap-1.5 border whitespace-nowrap transition-colors outline-none border-input-border bg-input text-foreground hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 h-8 rounded-lg pl-3 pr-2 text-ui-base w-full',
    menu: 'z-[60] min-w-32 max-h-60 overflow-y-auto rounded-lg border border-popover-border bg-menu p-1 text-foreground shadow-md',
    item: 'relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base/relaxed text-foreground outline-none select-none data-[highlighted=true]:bg-menu-hover',
    input: 'border border-input-border bg-input text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused rounded-lg h-8 px-3 text-sm outline-none transition-colors',
    switch: 'p-px group/switch relative inline-flex shrink-0 items-center rounded-full transition-all outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-input-border-focused/30 data-[size=default]:h-[18px] data-[size=default]:w-[32px] data-checked:bg-primary data-unchecked:bg-primary/30',
    switchThumb: 'pointer-events-none block rounded-full bg-primary-foreground ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0',
    stat: 'text-ui-base leading-6 text-foreground-subtle',
    badge: 'text-xs px-1.5 py-px rounded-full border border-border text-foreground-subtle'
  };
  var TYPE_LABEL = { scene: '场景', video: '视频', web: '网页', image: '图片', unknown: '未知' };
  var ORIGIN_LABEL = { workshop: '工坊订阅', custom: '本机导入', default: 'WE 内置', myprojects: 'WE 工程' };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function svgChevron(down) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.classList.add('shrink-0', 'size-4', 'text-foreground-subtle');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', down ? 'm6 9 6 6 6-6' : 'm18 15-6-6-6 6');
    s.appendChild(p);
    return s;
  }

  function row(labelText, descText) {
    var r = el('div', CLS.row);
    var g = el('div', CLS.grid);
    var left = el('div', 'min-w-0');
    left.appendChild(el('div', CLS.label, labelText));
    if (descText) left.appendChild(el('div', CLS.rowDesc, descText));
    var right = el('div', CLS.ctrl);
    g.appendChild(left); g.appendChild(right);
    r.appendChild(g);
    return { r: r, right: right };
  }

  // --- Radix-look select ---------------------------------------------------------
  function dropdown(options, value, onChange) {
    var wrap = el('div', 'relative w-full');
    var trigger = el('button', CLS.trigger);
    trigger.type = 'button';
    var valueSpan = el('span', 'line-clamp-1 truncate');
    var currentLabel = '';
    options.forEach(function (o) { if (String(o[0]) === String(value)) currentLabel = o[1]; });
    valueSpan.textContent = currentLabel;
    trigger.appendChild(valueSpan);
    trigger.appendChild(svgChevron(true));

    var menu = el('div', CLS.menu);
    menu.style.cssText = 'display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;';

    function close() {
      menu.style.display = 'none';
      trigger.setAttribute('data-state', 'closed');
      document.removeEventListener('pointerdown', onDocDown, true);
    }
    function onDocDown(e) { if (!wrap.contains(e.target)) close(); }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu.style.display === 'none') {
        menu.style.display = 'block';
        trigger.setAttribute('data-state', 'open');
        document.addEventListener('pointerdown', onDocDown, true);
      } else close();
    });
    trigger.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    options.forEach(function (o) {
      var item = el('div', CLS.item, o[1]);
      item.setAttribute('role', 'option');
      if (String(o[0]) === String(value)) item.setAttribute('aria-selected', 'true');
      item.addEventListener('mouseenter', function () {
        Array.prototype.forEach.call(menu.children, function (c) { c.removeAttribute('data-highlighted'); });
        item.setAttribute('data-highlighted', 'true');
      });
      item.addEventListener('click', function () {
        valueSpan.textContent = o[1];
        Array.prototype.forEach.call(menu.children, function (c) { c.removeAttribute('data-highlighted'); c.removeAttribute('aria-selected'); });
        item.setAttribute('aria-selected', 'true');
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
    btn.setAttribute('data-state', checked ? 'checked' : 'unchecked');
    btn.setAttribute('aria-checked', checked ? 'true' : 'false');
  }
  function makeSwitch(checked, onChange, labelText, key) {
    var wrap = el('label', 'inline-flex items-center gap-2 cursor-pointer');
    var btn = el('button', CLS.switch);
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    btn.setAttribute('data-size', 'default');
    if (key) btn.setAttribute('data-k', key);
    var cur = !!checked;
    setSwitch(btn, cur);
    btn.appendChild(el('span', CLS.switchThumb));
    btn.addEventListener('click', function () {
      cur = !cur;
      setSwitch(btn, cur);
      onChange(cur);
    });
    wrap.appendChild(btn);
    if (labelText) wrap.appendChild(el('span', 'text-sm text-foreground-subtle', labelText));
    return wrap;
  }

  function button(text, onClick, title, cls) {
    var b = el('button', cls || CLS.btn, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function pushConfig(patch) {
    post('/api/config', patch).catch(function () {});
  }

  // Transient feedback (2.5s, auto-dismiss) — the library has no permanent
  // status line; failures would otherwise be completely silent.
  function toast(text) {
    var host = document.body || document.documentElement;
    var t = el('div', 'fixed right-4 bottom-4 z-[2147483647] rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-md');
    t.textContent = text;
    host.appendChild(t);
    setTimeout(function () { t.remove(); }, 2500);
  }

  // --- library (searchable, paginated, fixed height) --------------------------
  function filteredList(list) {
    var q = (state.filter || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (w) {
      var hay = ((w.title || '') + ' ' + (w.id || '') + ' ' + (TYPE_LABEL[w.type] || w.type || '') + ' ' + (ORIGIN_LABEL[w.origin] || w.origin || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function renderLibrary(list, currentId) {
    ui.libBox.textContent = '';
    ui.pagerBox.textContent = '';
    if (!list || !list.length) {
      ui.libBox.appendChild(el('div', CLS.stat, '未发现 Wallpaper Engine 壁纸。没有安装 Steam / Wallpaper Engine 也可以：点「导入壁纸…」导入 .zw.zip 资源包、.pkg 场景或视频文件。'));
      return;
    }
    var all = filteredList(list);
    if (!all.length) {
      ui.libBox.appendChild(el('div', CLS.stat, '没有匹配「' + state.filter + '」的壁纸'));
      return;
    }
    var pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (state.page >= pages) state.page = pages - 1;
    var slice = all.slice(state.page * PAGE_SIZE, state.page * PAGE_SIZE + PAGE_SIZE);

    // With the fixed min-height, a short last page keeps its rows at natural
    // size instead of stretching them to fill the container. Inline style —
    // the align-content utility class may not exist in ZCode's compiled CSS.
    var grid = el('div', 'grid grid-cols-1 gap-2 sm:grid-cols-2');
    grid.style.alignContent = 'start';
    slice.forEach(function (w) {
      var item = el('div', 'flex items-center gap-3 border rounded-lg p-2 cursor-pointer transition-colors ' +
        (w.id === currentId ? 'border-input-border-focused bg-input' : 'border-border bg-background hover:border-input-border-hover'));
      var img = el('img', 'w-20 h-11 object-cover rounded-md bg-black/20 flex-none');
      img.loading = 'lazy';
      if (w.previewUrl) img.src = API + w.previewUrl;
      var info = el('div', 'min-w-0 flex-1');
      var name = el('div', 'text-ui-base font-medium text-foreground truncate');
      name.textContent = w.title || w.id;
      var meta = el('div', 'text-ui-base text-foreground-subtle truncate');
      var badge = el('span', 'inline-block text-xs px-1.5 py-px rounded-full mr-1 border border-border', TYPE_LABEL[w.type] || w.type);
      meta.appendChild(badge);
      meta.appendChild(document.createTextNode(
        (w.sizeBytes / 1048576).toFixed(1) + 'MB · ' + (ORIGIN_LABEL[w.origin] || w.origin)));
      info.appendChild(name); info.appendChild(meta);
      item.appendChild(img); item.appendChild(info);
      if (w.id === currentId) item.appendChild(el('span', 'text-xs text-foreground-subtle flex-none', '使用中'));
      item.appendChild(button('导出', function (e) {
        e.stopPropagation();
        var a = el('a');
        a.href = API + '/api/export?id=' + encodeURIComponent(w.id);
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, '打包为 .zw.zip，可在另一台电脑导入', CLS.btnIcon));
      if (w.origin === 'custom') {
        item.appendChild(button('删除', function (e) {
          e.stopPropagation();
          post('/api/delete-source', { id: w.id }).then(function (r) {
            if (r.error) { toast('删除失败：' + r.error); return; }
            toast('已删除「' + (w.title || w.id) + '」' + (r.switchedTo ? '，已切换到「' + r.switchedTo + '」' : ''));
            state.page = 0;
            refresh();
          }).catch(function (err) { toast('删除失败：' + (err && err.message ? err.message : '网络错误')); });
        }, '从库中删除（已导入的文件一并清理；若正在使用会自动切换）', CLS.btnIcon));
      }
      item.addEventListener('click', function () {
        post('/api/apply-source', { sourceId: w.id }).then(function (r) {
          if (!r.error) refresh();
        }).catch(function () {});
      });
      grid.appendChild(item);
    });
    ui.libBox.appendChild(grid);
    // Fixed height: remember the natural height of a FULL page and keep it for
    // short pages too, so the last page never collapses the section.
    requestAnimationFrame(function () {
      if (!grid.firstChild) return;
      if (slice.length === PAGE_SIZE && pages > 1) {
        state.gridH = grid.offsetHeight;
      }
      if (state.gridH) grid.style.minHeight = state.gridH + 'px';
      else {
        var rows = Math.ceil(PAGE_SIZE / 2);
        grid.style.minHeight = (rows * grid.firstChild.offsetHeight + (rows - 1) * 8) + 'px';
      }
    });

    var pager = el('div', 'flex items-center justify-end gap-2 mt-2');
    var prev = button('上一页', function () { if (state.page > 0) { state.page--; renderLibrary(state.lib && state.lib.wallpapers, state.lib && state.lib.current); } }, null, CLS.btnIcon);
    if (state.page === 0) { prev.disabled = true; prev.classList.add('opacity-50', 'cursor-not-allowed'); }
    pager.appendChild(prev);
    pager.appendChild(el('span', 'text-sm text-foreground-subtle', (state.page + 1) + ' / ' + pages + ' 页 · 共 ' + all.length + ' 项' + (all.length !== list.length ? '（筛选自 ' + list.length + '）' : '')));
    var next = button('下一页', function () { if (state.page < pages - 1) { state.page++; renderLibrary(state.lib && state.lib.wallpapers, state.lib && state.lib.current); } }, null, CLS.btnIcon);
    if (state.page >= pages - 1) { next.disabled = true; next.classList.add('opacity-50', 'cursor-not-allowed'); }
    pager.appendChild(next);
    ui.pagerBox.appendChild(pager);
  }

  function refresh() {
    fetchJson('/api/config').then(function (c) {
      state.cfg = c;
      if (ui.badge) {
        ui.badge.textContent = c.mediaType === 'live' ? '实时场景' : c.mediaType === 'video' ? '视频壁纸' : (c.wallpaperSet ? '图片' : '未设置');
      }
      var f = document.getElementById(MARKER);
      if (!f) return;
      var q = function (k) { return f.querySelector('[data-k=' + k + ']'); };
      var blur = q('blur'); if (blur) { blur.value = c.blur; q('blurv').textContent = c.blur + 'px'; }
      var dim = q('dim'); if (dim) { dim.value = c.dim; q('dimv').textContent = c.dim + '%'; }
      var monet = q('monet'); if (monet) setSwitch(monet, !!c.monet);
      var vis = q('vis'); if (vis) setSwitch(vis, !!c.wallpaperVisible);
      var fit = q('fit'); if (fit) fit.setAttribute('data-value', c.fit || 'cover');
      var fps = q('fps'); if (fps) fps.setAttribute('data-value', String(c.liveFps || 30));
      var mute = q('mute'); if (mute) setSwitch(mute, c.liveMuted !== false);
    }).catch(function () {});
    fetchJson('/api/wallpapers').then(function (d) {
      state.lib = d;
      if (ui.libBox) renderLibrary(d.wallpapers, d.current);
    }).catch(function () {});
  }
  window.__zwPanelRefresh = refresh;

  function buildSection() {
    var section = el('div', CLS.section);
    section.id = MARKER;

    var head = el('div', 'flex flex-wrap items-center justify-between gap-2');
    var headText = el('div');
    headText.appendChild(el('h3', CLS.title, '壁纸引擎'));
    headText.appendChild(el('p', CLS.desc, '使用 Wallpaper Engine 订阅的壁纸：场景为实时渲染（保留粒子、脚本与鼠标视差），图片与视频亦可作为背景。'));
    head.appendChild(headText);
    ui.badge = el('span', CLS.badge, '…');
    head.appendChild(ui.badge);
    section.appendChild(head);

    var card = el('div', CLS.card);
    card.setAttribute('data-slot', 'card');
    var content = el('div', CLS.content);
    content.setAttribute('data-slot', 'card-content');

    var rBlur = row('背景模糊', null);
    var blurBox = el('div', 'flex items-center gap-2 w-full');
    var blur = el('input'); blur.type = 'range'; blur.min = 0; blur.max = 40; blur.className = 'w-full accent-[var(--color-primary,#7aa2f7)]'; blur.setAttribute('data-k', 'blur');
    var blurv = el('span', 'text-sm text-foreground-subtle w-10 text-right'); blurv.setAttribute('data-k', 'blurv');
    blur.addEventListener('input', function () { blurv.textContent = blur.value + 'px'; pushConfig({ blur: Number(blur.value) }); });
    blurBox.appendChild(blur); blurBox.appendChild(blurv);
    rBlur.right.appendChild(blurBox);
    content.appendChild(rBlur.r);

    var rDim = row('背景压暗', null);
    var dimBox = el('div', 'flex items-center gap-2 w-full');
    var dim = el('input'); dim.type = 'range'; dim.min = 0; dim.max = 100; dim.className = 'w-full accent-[var(--color-primary,#7aa2f7)]'; dim.setAttribute('data-k', 'dim');
    var dimv = el('span', 'text-sm text-foreground-subtle w-10 text-right'); dimv.setAttribute('data-k', 'dimv');
    dim.addEventListener('input', function () { dimv.textContent = dim.value + '%'; pushConfig({ dim: Number(dim.value) }); });
    dimBox.appendChild(dim); dimBox.appendChild(dimv);
    rDim.right.appendChild(dimBox);
    content.appendChild(rDim.r);

    var rFit = row('填充方式', 'cover 裁切铺满；contain 留边；smart 本地分析主体后自动构图。');
    var fit = dropdown([['cover', 'cover 裁切铺满'], ['contain', 'contain 留边'], ['smart', 'smart 智能构图']], 'cover', function (v) { pushConfig({ fit: v }); });
    fit.setAttribute('data-k', 'fit');
    rFit.right.appendChild(fit);
    content.appendChild(rFit.r);

    var rLive = row('实时渲染', '场景壁纸的渲染帧率上限与自带音频。');
    var liveBox = el('div', 'flex items-center gap-3 justify-end w-full');
    var fps = dropdown([['15', '15 fps'], ['30', '30 fps'], ['60', '60 fps']], '30', function (v) { pushConfig({ liveFps: Number(v) }); });
    fps.setAttribute('data-k', 'fps');
    var mute = makeSwitch(true, function (v) { pushConfig({ liveMuted: v }); }, '静音', 'mute');
    liveBox.appendChild(fps); liveBox.appendChild(mute);
    rLive.right.appendChild(liveBox);
    content.appendChild(rLive.r);

    var rTheme = row('Monet 动态取色', '从壁纸真实渲染像素提取 Material Design 3 配色并适配界面。');
    var themeBox = el('div', 'flex items-center gap-4');
    var monet = makeSwitch(true, function (v) { pushConfig({ monet: v }); }, '启用', 'monet');
    var vis = makeSwitch(true, function (v) { pushConfig({ wallpaperVisible: v }); }, '显示壁纸', 'vis');
    themeBox.appendChild(monet); themeBox.appendChild(vis);
    rTheme.right.appendChild(themeBox);
    content.appendChild(rTheme.r);

    // library block
    var libRow = el('div', 'px-4 py-3');
    var libHead = el('div', 'flex items-center justify-between gap-2 mb-2');
    libHead.appendChild(el('div', CLS.label, '壁纸库'));
    var acts = el('div', 'flex items-center gap-2 flex-wrap justify-end');
    acts.appendChild(button('刷新', function () { refresh(); }));
    // One import entry: a browser file chooser for images, .zw.zip packages,
    // .pkg scenes and videos — dispatched by file type. Same chooser UX as
    // everywhere else in the app; no Wallpaper Engine involved.
    var importFile = el('input');
    importFile.type = 'file';
    importFile.accept = 'image/*,.zip,.pkg,.mp4,.webm';
    importFile.className = 'hidden';
    importFile.addEventListener('change', function () {
      var f = importFile.files && importFile.files[0];
      if (!f) return;
      state.page = 0;
      if (/^image\\//.test(f.type)) {
        var fr = new FileReader();
        fr.onload = function () {
          post('/api/wallpaper', { dataUri: fr.result }).then(function (r) {
            if (r.error) toast('导入失败：' + r.error); else { toast('图片已应用'); refresh(); }
          }).catch(function () { toast('导入失败：网络错误'); });
        };
        fr.readAsDataURL(f);
      } else {
        fetch(API + '/api/upload-wallpaper?apply=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-ZW-Filename': encodeURIComponent(f.name) },
          body: f,
        })
          .then(function (r) { return r.json(); })
          .then(function (r) {
            if (r.error) { toast('导入失败：' + r.error); return; }
            toast('已导入「' + (r.title || f.name) + '」' + (r.mediaType === 'live' ? '（实时渲染）' : ''));
            refresh();
          })
          .catch(function () { toast('导入失败：网络错误'); });
      }
      importFile.value = '';
    });
    acts.appendChild(button('导入壁纸…', function () { importFile.click(); }, '支持：图片、.zw.zip 资源包、.pkg 场景、.mp4/.webm 视频（无需 Wallpaper Engine）'));
    acts.appendChild(importFile);
    libHead.appendChild(acts);
    libRow.appendChild(libHead);

    // search box
    var search = el('input', CLS.input + ' w-full mb-2');
    search.type = 'search';
    search.placeholder = '搜索壁纸（名称 / 类型 / 来源）';
    search.value = state.filter || '';
    var searchTimer = null;
    search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var v = search.value;
      searchTimer = setTimeout(function () {
        state.filter = v;
        state.page = 0;
        renderLibrary(state.lib && state.lib.wallpapers, state.lib && state.lib.current);
      }, 200);
    });
    ui.search = search;
    libRow.appendChild(search);

    ui.libBox = el('div');
    libRow.appendChild(ui.libBox);
    ui.pagerBox = el('div');
    libRow.appendChild(ui.pagerBox);
    content.appendChild(libRow);

    // footer actions
    var footRow = el('div', 'px-4 py-3 flex items-center gap-2 justify-end');
    footRow.appendChild(button('恢复默认外观', function () {
      post('/api/reset', {}).then(function () { refresh(); });
    }));
    footRow.appendChild(button('还原上次壁纸', function () {
      post('/api/restore', {}).then(function () { refresh(); });
    }));
    content.appendChild(footRow);

    card.appendChild(content);
    section.appendChild(card);
    return section;
  }

  // --- mount loop ----------------------------------------------------------------
  var scheduled = false;
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
    // Retire when a newer build has taken over the page.
    if (typeof window.__zwSettingsBoot === 'number' && window.__zwSettingsBoot > V) {
      if (mountObserver) mountObserver.disconnect();
      neutralize.disconnect();
      return;
    }
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
  mountObserver = new MutationObserver(onMutations);
  mountObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  neutralize.observe(document.body || document.documentElement, { childList: true, subtree: true });
  sweepLegacy();
  scan();
})();`;
}
