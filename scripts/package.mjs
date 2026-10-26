/**
 * Packages the plugin into a zip for local installation:
 * dist + live + vendor + commands + skills + .zcode-plugin + docs/README.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, `${pkg.name}-${pkg.version}.zip`);

const include = ["dist", "live", "vendor", "commands", "skills", ".zcode-plugin", "README.md", "LICENSE"];
const staged = include.filter((p) => fs.existsSync(path.join(root, p)));
if (!fs.existsSync(path.join(root, "dist", "mcp", "server.js"))) {
  console.error("package: dist/mcp/server.js missing — run `npm run build` first");
  process.exit(1);
}
if (!fs.existsSync(path.join(root, "vendor", "webwallgl.global.min.js"))) {
  console.error("package: vendored engine missing — run `npm run build` first");
  process.exit(1);
}

if (fs.existsSync(out)) fs.rmSync(out);
const zipName = path.basename(out);
if (process.platform === "win32") {
  // Passing the directory itself keeps the `dist\...` prefix in the archive
  // (the plugin manifest points at dist/mcp/server.js).
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Compress-Archive -Path ${staged.map((a) => `'${a}'`).join(",")} -DestinationPath '${zipName}' -Force`],
    { cwd: root, stdio: "inherit" }
  );
} else {
  // bsdtar elsewhere (zip via -a); GNU tar does not write zips.
  execFileSync("tar", ["-a", "-c", "-f", zipName, ...staged], { cwd: root, stdio: "inherit" });
}
console.log(`package: ${path.relative(root, out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
