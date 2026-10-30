/**
 * Hotkey combo semantics (D28) — pure, DOM-free, loadable in bare Node.
 *
 * Combos are canonical strings "Ctrl+Alt+Shift+Win+<Key>" (modifier order
 * fixed, key last, e.g. "Ctrl+Alt+W"; "" = disabled). Events are matched from
 * plain KeyboardEvent-like objects so the recorder (panel), the toggler
 * (agent) and the guard all run this one implementation.
 */

var MODIFIERS = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", win: "Win", meta: "Win", cmd: "Win", super: "Win" };
var MOD_TOKENS = { ctrl: true, control: true, alt: true, shift: true, win: true, meta: true, cmd: true, super: true };
/** ev.code → display token for the non-letter keys we support. */
var CODE_NAMES = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Space: "Space", Escape: "Esc", Enter: "Enter", Tab: "Tab",
  Backspace: "Backspace", Delete: "Delete", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";",
  Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
};

function titleKey(tok) {
  var km = /^Key([A-Z])$/.exec(tok);
  if (km) return km[1];
  var dm = /^Digit([0-9])$/.exec(tok);
  if (dm) return dm[1];
  if (/^[a-z]$/i.test(tok)) return tok.toUpperCase();
  if (/^f\d{1,2}$/i.test(tok)) return tok.toUpperCase();
  var lower = tok.toLowerCase();
  if (CODE_NAMES[tok] !== undefined) return CODE_NAMES[tok];
  return MOD_TOKENS[lower] ? MODIFIERS[lower] : tok;
}

/** Canonical combo string, or "" when nothing bindable was pressed. */
export function normalizeCombo(raw) {
  if (typeof raw !== "string") return "";
  var parts = String(raw).trim().split(/\s*\+\s*/).filter(Boolean);
  if (!parts.length) return "";
  var ctrl = false, alt = false, shift = false, win = false;
  var key = "";
  for (var i = 0; i < parts.length; i++) {
    var m = MODIFIERS[parts[i].toLowerCase()];
    if (m === "Ctrl") ctrl = true;
    else if (m === "Alt") alt = true;
    else if (m === "Shift") shift = true;
    else if (m === "Win") win = true;
    else if (!key) key = titleKey(parts[i]);
    else return ""; // two non-modifier keys — not a combo we can match
  }
  if (!key) return ""; // modifiers only
  var out = [];
  if (ctrl) out.push("Ctrl");
  if (alt) out.push("Alt");
  if (shift) out.push("Shift");
  if (win) out.push("Win");
  out.push(key);
  return out.join("+");
}

/** True when the combo carries at least one modifier (required for any
 *  user-bindable hotkey — bare keys would fire on every keystroke). */
export function hasModifier(combo) {
  return /(^|\+)(Ctrl|Alt|Shift|Win)\+/.test("+" + String(combo) + "+");
}

/** Canonical combo from a KeyboardEvent-like object; "" for modifier-only
 *  presses. Prefers ev.code (layout-stable), falls back to ev.key. */
export function comboFromEvent(ev) {
  if (!ev || typeof ev.key !== "string") return "";
  if (MOD_TOKENS[String(ev.key).toLowerCase()]) return ""; // a modifier press alone never binds
  var keyTok = ev.code || ev.key;
  // Modifiers carry L/R suffixes in ev.code (ShiftLeft, MetaRight) — strip
  // only when the stem is a modifier ("ArrowLeft" must survive intact).
  var m = /^(.+)(Left|Right)$/.exec(String(keyTok));
  if (m && MOD_TOKENS[m[1].toLowerCase()]) keyTok = m[1];
  var mods = [];
  if (ev.ctrlKey) mods.push("Ctrl");
  if (ev.altKey) mods.push("Alt");
  if (ev.shiftKey) mods.push("Shift");
  if (ev.metaKey) mods.push("Win");
  var key = titleKey(String(keyTok));
  if (!key || key.length > 12) return "";
  return normalizeCombo(mods.concat([key]).join("+"));
}

/** Exact match: every recorded modifier present, no extra modifier, key equal. */
export function matchesCombo(combo, ev) {
  var c = normalizeCombo(combo);
  if (!c) return false;
  var parts = c.split("+");
  var key = parts[parts.length - 1];
  var want = { Ctrl: false, Alt: false, Shift: false, Win: false };
  for (var i = 0; i < parts.length - 1; i++) want[parts[i]] = true;
  if (!!ev.ctrlKey !== want.Ctrl) return false;
  if (!!ev.altKey !== want.Alt) return false;
  if (!!ev.shiftKey !== want.Shift) return false;
  if (!!ev.metaKey !== want.Win) return false;
  var evKey = (ev.code ? titleKey(ev.code) : titleKey(ev.key)) || titleKey(ev.key);
  return String(evKey).toLowerCase() === key.toLowerCase();
}

/** Inputs where keystrokes belong to the app/user, not to our hotkey
 *  (plain-object target: {tagName, isContentEditable, type}). */
export function isEditableTarget(t) {
  if (!t) return false;
  var tag = (t.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (tag === "summary" || tag === "details") return false;
  return t.isContentEditable === true;
}
