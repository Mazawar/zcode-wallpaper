// Re-parses the panel template exactly as the TS module would (escapes,
// ${apiPort} interpolation), then emits it for `node --check`.
import fs from "node:fs";
const ts = fs.readFileSync(new URL("../src/panel/panelScript.ts", import.meta.url), "utf8");
const a = ts.indexOf("return `") + 8;
const b = ts.lastIndexOf("`;");
const body = ts.slice(a, b);
const panel = new Function("apiPort", "return `" + body + "`")(28257);
fs.writeFileSync(new URL("./_panel-check.js", import.meta.url), panel);
console.log("extracted", panel.length, "chars");
