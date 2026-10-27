/**
 * Control factories + ZCode-native class strings. Markup mirrors ZCode's own
 * settings controls so light/dark themes and typography match the built-ins
 * (class strings captured from its compiled UI — see DECISIONS D9 for why we
 * never hard-code copied rules beyond these known-stable atoms).
 */

export const CLS = {
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

export function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function svgChevron(down) {
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

export function row(labelText, descText) {
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
export function dropdown(options, value, onChange) {
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
export function setSwitch(btn, checked) {
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
export function makeSwitch(checked, onChange, labelText, key) {
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

export function button(text, onClick, title, cls) {
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
export function ensureSliderStyle(marker) {
  if (document.getElementById(marker + "-range-style")) return;
  var st = document.createElement("style");
  st.id = marker + "-range-style";
  st.textContent =
    "input.zw-range{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:9999px;margin:0;" +
    "background:linear-gradient(to right,var(--color-primary,#fff) var(--zw-fill,50%),rgba(127,127,127,.28) var(--zw-fill,50%));" +
    "outline:none;cursor:pointer;}" +
    "input.zw-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;" +
    "background:var(--color-primary,#fff);border:2px solid var(--color-background,#161616);box-shadow:0 1px 3px rgba(0,0,0,.35);}";
  (document.head || document.documentElement).appendChild(st);
}
export function paintRange(i) {
  var min = Number(i.min) || 0;
  var max = Number(i.max) || 100;
  var pct = ((Number(i.value) - min) / (max - min)) * 100;
  i.style.setProperty("--zw-fill", Math.max(0, Math.min(100, pct)) + "%");
}
/** Read-back for refresh(): input value, chip text, fill level. */
export function syncRange(f, k, val, unit) {
  var i = f.querySelector("[data-k=" + k + "]");
  if (!i) return;
  i.value = String(val);
  var chip = f.querySelector("[data-k=" + k + "v]");
  if (chip) chip.textContent = val + (unit || "");
  paintRange(i);
}

// --- segmented control (dsh's 帧率 / 适配 rows) --------------------------------
// Dropdowns hide the choices; a segment row shows them. Active segment =
// bg-input pill with a hairline inset border, verified classes + inline only.
export function makeSeg(options, value, onChange, key, fill) {
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
export function setSeg(f, key, val) {
  var w = f && f.querySelector("[data-k=" + key + "]");
  if (!w || !w.__zwPaint) return;
  w.setAttribute("data-value", String(val));
  w.__zwPaint();
}

// Full-width play-pane row (label + description left, control right). The
// native 192px control column only fits dropdowns — segments need width.
export function prow(labelText, descText) {
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
export function groupLabel(t) {
  // dsh section heading: big, bold, white — the visual anchor of a group.
  var g = el("div", "text-sm font-semibold text-foreground");
  g.style.cssText = "padding:16px 16px 8px;font-size:15px;";
  g.textContent = t;
  return g;
}

// Transient feedback (2.5s, auto-dismiss) — failures would otherwise be
// completely silent.
export function toast(text) {
  var host = document.body || document.documentElement;
  var t = el("div", "fixed right-4 bottom-4 z-[2147483647] rounded-lg bg-card px-3 py-2 text-sm text-foreground shadow-md");
  t.style.border = "1px solid var(--color-border,#ffffff1a)";
  t.textContent = text;
  host.appendChild(t);
  setTimeout(function () { t.remove(); }, 2500);
}
