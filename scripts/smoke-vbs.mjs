/**
 * cscript smoke test for the generated zw-wrapper-v8 (0.3.1 lesson: generated
 * launch scripts must be EXECUTED, not just inspected). Generates the real
 * VBS via the real writeEarlyLaunchVbs into a scratch dir, comments out the
 * three sh.Run lines (serve spawn / ZCode launch / second chance), runs it
 * with cscript, and asserts the boot log: v8 marker, handshake poll expiry
 * (no serve → fallback literal), unconditional-launch line reached.
 */
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(os.tmpdir(), `zw-vbs-smoke-${process.pid}`);
const dir = path.join(tmp, "launch");
fs.mkdirSync(dir, { recursive: true });

const bundled = path.join(tmp, "shortcuts.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "src", "core", "shortcuts.ts")],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const sc = await import(pathToFileURL(bundled).href);
sc.writeEarlyLaunchVbs(28256, "D:\\ZCode\\ZCode.exe", { dir, root });

const vbsPath = path.join(dir, "zw-launch.vbs");
const testPath = path.join(dir, "zw-launch-test.vbs");
const suppressed = fs
  .readFileSync(vbsPath, "utf8")
  .split("\r\n")
  .map((l) => (l.trim().startsWith("sh.Run") ? "' SMOKE-SUPPRESSED: " + l : l))
  .join("\r\n");
fs.writeFileSync(testPath, suppressed, "utf8");

const failures = [];
const ok = (cond, msg) => {
  if (!cond) failures.push(msg);
  else console.log("ok:", msg);
};

let out = "";
try {
  out = execFileSync("cscript", ["//nologo", testPath], { timeout: 60_000, encoding: "utf8" });
  ok(true, "cscript ran the wrapper (exit 0, compile + execute clean)");
} catch (e) {
  failures.push(`cscript failed: ${String(e.stderr ?? e.message).slice(0, 300)}`);
}
const log = fs.existsSync(path.join(dir, "zw-serve.log")) ? fs.readFileSync(path.join(dir, "zw-serve.log"), "utf8") : "";
ok(log.includes("vbs: wrapper v8 boot"), "boot log line present (v8)");
ok(log.includes("vbs: spawning serve via zw-serve.cmd"), "serve spawn path reached");
ok(/vbs: session cdp port: 28256/.test(log), "handshake poll expired without a serve → fallback literal 28256");
ok(log.includes("vbs: launching zcode: D:\\ZCode\\ZCode.exe"), "unconditional ZCode launch line reached");
ok(!out.includes("Microsoft") && !/\r?\nerror/i.test(out), "no runtime errors on stdout");

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.error("FAIL:", f);
  process.exitCode = 1;
}
console.log(process.exitCode ? "VBS SMOKE: FAILED" : "VBS SMOKE: ALL OK");
