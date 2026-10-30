/**
 * Guard: hotkey toggle semantics (D28). The combo grammar (normalize /
 * record-from-event / exact match / modifier rule / editable-target rule) is
 * pinned against the REAL hotkey.js — the one module the agent toggler, the
 * panel recorder and this guard share. The regression it pins: an
 * ArrowLeft-like code must survive modifier-suffix stripping, a bare-key
 * combo must never fire inside editable targets, and the wallpaper toggle
 * must go through the same POST the panel switch uses.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hk = await import(pathToFileURL(path.join(root, "live", "src", "agent", "hotkey.js")).href);

const failures = [];
function eq(actual, expected, msg) {
  const ok = actual === expected;
  if (!ok) failures.push(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  else console.log(`ok: ${msg}`);
}
function ok(cond, msg) {
  if (!cond) failures.push(msg);
  else console.log(`ok: ${msg}`);
}

// ── normalizeCombo: canonical form, grammar edges ────────────────────────────
eq(hk.normalizeCombo("ctrl+alt+w"), "Ctrl+Alt+W", "normalize lowercases modifiers, uppercases the key");
eq(hk.normalizeCombo("Alt + Shift + F5"), "Alt+Shift+F5", "normalize tolerates spaces, keeps token order canonical");
eq(hk.normalizeCombo("meta+p"), "Win+P", "meta maps to Win");
eq(hk.normalizeCombo("Ctrl+Alt+ArrowUp"), "Ctrl+Alt+Up", "ArrowUp displays as Up");
eq(hk.normalizeCombo("Up"), "Up", "arrow token round-trips");
eq(hk.normalizeCombo("Ctrl"), "", "modifiers only → no combo");
eq(hk.normalizeCombo("Ctrl+Alt"), "", "two modifiers only → no combo");
eq(hk.normalizeCombo("Ctrl+W+X"), "", "two non-modifier keys → rejected");
eq(hk.normalizeCombo(""), "", "empty string = disabled");
eq(hk.normalizeCombo("Ctrl+Alt+W+Q"), "", "garbage beyond one key → rejected");

// ── comboFromEvent: record what the user pressed ────────────────────────────
eq(hk.comboFromEvent({ key: "w", code: "KeyW", ctrlKey: true, altKey: true }), "Ctrl+Alt+W", "records Ctrl+Alt+W");
eq(hk.comboFromEvent({ key: "Meta", code: "MetaLeft", metaKey: true }), "", "modifier-only press records nothing");
eq(hk.comboFromEvent({ key: "F9", code: "F9" }), "F9", "bare F-key records (agent enforces the modifier rule)");
eq(hk.comboFromEvent({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }), "Alt+Left", "ArrowLeft survives the modifier-suffix strip");
eq(hk.comboFromEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true }), "", "ShiftLeft records nothing");
eq(hk.comboFromEvent({ key: " ", code: "Space", ctrlKey: true }), "Ctrl+Space", "space bar records as Space");
eq(hk.comboFromEvent({ key: "W", code: "KeyW", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+W", "shift combo keeps order canonical");

// ── matchesCombo: exact semantics ────────────────────────────────────────────
ok(hk.matchesCombo("Ctrl+Alt+W", { key: "w", code: "KeyW", ctrlKey: true, altKey: true }), "match: Ctrl+Alt+W");
ok(!hk.matchesCombo("Ctrl+Alt+W", { key: "w", code: "KeyW", ctrlKey: true, altKey: true, shiftKey: true }), "extra modifier → no match");
ok(!hk.matchesCombo("Ctrl+Alt+W", { key: "w", code: "KeyW", ctrlKey: true }), "missing modifier → no match");
ok(!hk.matchesCombo("Ctrl+Alt+W", { key: "x", code: "KeyX", ctrlKey: true, altKey: true }), "wrong key → no match");
ok(hk.matchesCombo("Ctrl+Alt+Up", { key: "ArrowUp", code: "ArrowUp", ctrlKey: true, altKey: true }), "arrow combo matches by code");
ok(!hk.matchesCombo("", { key: "w", code: "KeyW", ctrlKey: true, altKey: true }), "disabled combo matches nothing");
// round-trip: what the recorder saves, the toggler must fire on
ok(hk.matchesCombo(hk.comboFromEvent({ key: "w", code: "KeyW", ctrlKey: true, altKey: true }), { key: "w", code: "KeyW", ctrlKey: true, altKey: true }), "record → fire round-trip");

// ── hasModifier / isEditableTarget: the safety rules ─────────────────────────
ok(hk.hasModifier("Ctrl+Alt+W"), "Ctrl+Alt+W has a modifier");
ok(!hk.hasModifier("F9"), "bare F9 has none — agent skips editable targets for it");
ok(hk.isEditableTarget({ tagName: "INPUT" }), "input is editable");
ok(hk.isEditableTarget({ tagName: "TEXTAREA" }), "textarea is editable");
ok(hk.isEditableTarget({ tagName: "div", isContentEditable: true }), "contenteditable is editable");
ok(!hk.isEditableTarget({ tagName: "DIV" }), "plain div is not");

// ── wiring pins on the live sources ──────────────────────────────────────────
const agentSrc = fs.readFileSync(path.join(root, "live/src/agent/main.js"), "utf8");
const panelSrc = fs.readFileSync(path.join(root, "live/src/panel/main.js"), "utf8");
const payloadSrc = fs.readFileSync(path.join(root, "src/core/payload.ts"), "utf8");
function pin(cond, msg) {
  if (!cond) failures.push(msg);
  else console.log(`ok: ${msg}`);
}
pin(agentSrc.includes("payload.toggleHotkey") && agentSrc.includes("payload.wallpaperVisible"), "agent tracks combo + visibility from the payload");
pin(agentSrc.includes('"keydown"') && agentSrc.includes(", true)"), "agent listens in capture phase");
pin(agentSrc.includes('getAttribute("data-zw-hotkey")'), "agent opts the panel recorder out of the global handler");
pin(agentSrc.includes("wallpaperVisible: !VISIBLE"), "agent toggles via the panel switch's config key");
pin(agentSrc.includes('"/api/config"'), "toggle goes through POST /api/config (SSE rebroadcast, all windows)");
pin(panelSrc.includes("data-zw-hotkey") && panelSrc.includes("comboFromEvent") && panelSrc.includes("hasModifier"), "panel recorder shares the hotkey module");
pin(payloadSrc.includes("payload.toggleHotkey") && payloadSrc.includes("payload.wallpaperVisible"), "serve builds both fields into every payload");

if (failures.length) {
  for (const f of failures) console.error("FAIL:", f);
  process.exitCode = 1;
}
console.log(process.exitCode ? "HOTKEY: FAILED" : "HOTKEY: ALL OK");
