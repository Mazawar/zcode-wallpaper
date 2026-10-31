/**
 * Guard: port-pool float + session discovery (D29). The walk semantics run
 * against the REAL ports.ts (esbuild-bundled): even/odd pool partition, free
 * probes against actual sockets, CDP-or-free pick, discovery round-trip.
 * The generated wrappers are execution-critical (0.3.1 lesson: a generated
 * script must be inspected as produced, not as intended), so the guard runs
 * the REAL writeEarlyLaunchVbs against a scratch dir and pins the handshake
 * delete/poll/fallback choreography plus the ASCII-only rule (wscript reads
 * non-BOM files as ANSI).
 */
import esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const ok = (cond, msg) => {
  if (!cond) failures.push(msg);
  else console.log(`ok: ${msg}`);
};

const tmp = path.join(os.tmpdir(), `zw-ports-guard-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
const bundled = path.join(tmp, "ports.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "src", "core", "ports.ts")],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});

// Discovery must land in a scratch dir, and the pool must be hermetic: the
// developer machine's real ZCode may hold 28256 RIGHT NOW (that is the point
// of the feature), so shift the pool base to a scratch range for this run.
// D33: discovery/handshake live in wrapperDir (= %LOCALAPPDATA% on win), so
// the guard redirects that too — writing the REAL wrapper meta with test
// ports would poison the next session's discovery.
process.env.ZW_DATA_DIR = path.join(tmp, "data");
process.env.LOCALAPPDATA = path.join(tmp, "localappdata");
fs.mkdirSync(process.env.ZW_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
const ports = await import(pathToFileURL(bundled).href);
const wrapperHome = path.join(process.env.LOCALAPPDATA, "zcode-wallpaper");

async function allFree(base) {
  for (let i = 0; i < 10; i++) {
    if (!(await ports.isPortFree(base + 2 * i))) return false;
    if (!(await ports.isPortFree(base + 1 + 2 * i))) return false;
  }
  return true;
}
let B = 0;
for (let attempt = 0; attempt < 20 && !B; attempt++) {
  const cand = 34000 + attempt * 40 + 2 * Math.floor(Math.random() * 10);
  if (await allFree(cand)) B = cand;
}
if (!B) {
  console.error("FAIL: no free 20-slot scratch range found — skipping live-socket assertions");
  process.exit(1);
}
process.env.ZW_PORT_BASE = String(B);

// ── pool shape ───────────────────────────────────────────────────────────────
const cdp = ports.cdpCandidates();
const api = ports.apiCandidates();
ok(ports.portBase() === B, `ZW_PORT_BASE override honored (pool base ${B})`);
ok(cdp.length === 10 && api.length === 10, "pool holds 10 slots per role");
ok(cdp.every((p) => p % 2 === 0) && api.every((p) => p % 2 === 1), "even/odd partition (CDP↔API can never collide)");
ok(new Set([...cdp, ...api]).size === 20, "pools are disjoint");
ok(cdp[0] === B && api[0] === B + 1, "historical-default ordering: preferred slot first");
ok(ports.cdpCandidates(B + 4)[0] === B + 4 && ports.cdpCandidates(B + 4).length === 10, "preferred slot is tried first");
ok(ports.apiCandidates(B).filter((p) => p === B).length === 0, "a CDP port passed as API preference stays out of the API pool");

// ── isPortFree against a real socket ─────────────────────────────────────────
const srv = net.createServer();
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const busyPort = srv.address().port;
ok((await ports.isPortFree(busyPort)) === false, "bound port reads busy");
srv.close();
await new Promise((r) => srv.close(r));
ok((await ports.isPortFree(busyPort)) === true, "released port reads free");

// ── pickCdpPort: foreign squatter → walk; live debug endpoint → take ────────
// Windows sockets can linger briefly after close(); the guard gives the
// release a grace period instead of awaiting the close callback (whose
// timing on this platform proved unreliable under a probe storm).
const grace = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const squatter = net.createServer();
await new Promise((r) => squatter.listen(B, "127.0.0.1", r));
ok((await ports.pickCdpPort(B)) === B + 2, "foreign TCP squatter on the preferred slot → walk to the next");
squatter.close();
await grace();
const fakeCdp = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end('{"Browser":"chrome/133"}');
});
await new Promise((r) => fakeCdp.listen(B, "127.0.0.1", r));
ok((await ports.pickCdpPort(B)) === B, "live debug endpoint on the preferred slot → take it (host-time session truth)");
fakeCdp.close();
await grace();

// ── discovery round-trip ─────────────────────────────────────────────────────
ports.writeSessionPorts(B + 4, B + 5);
const disc = ports.readSessionPorts();
ok(disc.cdpPort === B + 4 && disc.apiPort === B + 5, "discovery round-trips through zw-launch.json");
const hsRaw = fs.readFileSync(path.join(wrapperHome, "zw-ports.txt"), "utf8");
ok(new RegExp(`^cdp=${B + 4}\\r?\\napi=${B + 5}\\r?\\n$`).test(hsRaw), "boot handshake is the flat two-line file");
ok(/^[\x00-\x7F]*$/.test(hsRaw), "handshake is pure ASCII (VBS parses it as ANSI)");
ok(ports.readHandshake().cdpPort === B + 4 && ports.readHandshake().apiPort === B + 5, "readHandshake parses both fields");
// meta merge: existing fields (zcode/node/cli) must survive the port write
fs.writeFileSync(path.join(wrapperHome, "zw-launch.json"), JSON.stringify({ zcode: "X\\ZCode.exe", node: "n", cli: "c" }));
ports.writeSessionPorts(28256, 28257);
const merged = JSON.parse(fs.readFileSync(path.join(wrapperHome, "zw-launch.json"), "utf8"));
ok(merged.zcode === "X\\ZCode.exe" && merged.cdpPort === 28256, "discovery write merges, never replaces the wrapper meta");

// ── the REAL generated Windows wrapper ───────────────────────────────────────
// ports.ts doesn't carry the shortcut builders — bundle shortcuts.ts too.
const bundledSc = path.join(tmp, "shortcuts.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "src", "core", "shortcuts.ts")],
  outfile: bundledSc,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const sc = await import(pathToFileURL(bundledSc).href);

const scratch = { dir: path.join(tmp, "launch"), root };
fs.mkdirSync(scratch.dir, { recursive: true });
sc.writeEarlyLaunchVbs(28256, "D:\\ZCode\\ZCode.exe", scratch);
const vbs = fs.readFileSync(path.join(scratch.dir, "zw-launch.vbs"), "utf8");
const cmd = fs.readFileSync(path.join(scratch.dir, "zw-serve.cmd"), "utf8");
ok(vbs.includes("zw-wrapper-v9"), "generated wrapper carries the v9 marker");
ok(vbs.includes("DateLastModified") && vbs.includes("\dist\cli.js"), "v9 probes the plugin cache for the newest cli.js (reinstall self-recovery)");
ok(vbs.includes('" \"\" & cliUse & \"\"'), "cmd spawn passes the resolved cli as %1");
ok(/^[\x00-\x7F]*$/.test(vbs), "generated VBS is pure ASCII (wscript ANSI rule)");
ok(vbs.includes('fso.DeleteFile pf, True'), "wrapper deletes any stale handshake before spawning the serve");
ok(vbs.includes("For t = 1 To 20") && vbs.includes("WScript.Sleep 200"), "wrapper polls ~4s for the fresh handshake");
ok(vbs.includes('InStr(hs, "cdp=")'), "wrapper parses the cdp= line");
ok(vbs.includes('cdpUse = "28256"'), "baked literal stays as the fallback port");
ok(vbs.includes('"--remote-debugging-port=" & cdpUse'), "ZCode launch line uses the handshake port");
ok(vbs.includes("WScript.Sleep 25000"), "second-chance re-arm survives (D24)");
ok(vbs.includes("sh.Run Chr(34) & zc & Chr(34)"), "unconditional ZCode launch line survives (D18)");
ok(cmd.includes("--pick-ports"), "zw-serve.cmd launches the serve with port picking");
ok(cmd.includes("%1"), "zw-serve.cmd takes the cli path as %1 (probe-aware)");
ok(vbs.includes("zw-ports.txt"), "wrapper knows the handshake path");

const shTxt = sc.buildEarlyLaunchSh("/usr/bin/node", "/opt/zw/dist/cli.js", 28256, "/opt/zcode/zcode %U", path.join(tmp, "early.log"));
ok(shTxt.includes("rm -f \"$PF\""), "sh wrapper deletes the stale handshake");
ok(shTxt.includes("while [ \"$i\" -lt 20 ]"), "sh wrapper polls the handshake");
ok(shTxt.includes("sed -n 's/^cdp=//p'"), "sh wrapper parses cdp=");
ok(shTxt.includes("case \"$ZWCDP\" in ''|*[!0-9]*) ZWCDP=28256;; esac"), "sh wrapper falls back to the baked literal");
ok(shTxt.includes("--remote-debugging-port=$ZWCDP"), "sh launch line uses the handshake port");
ok(shTxt.includes("--pick-ports"), "sh serve line enables port picking");
ok(shTxt.includes("CLI_NEW") && shTxt.includes("*/dist/cli.js"), "sh wrapper probes for the newest cli.js (reinstall self-recovery)");
ok(/^[\x00-\x7F]*$/.test(shTxt), "sh wrapper is pure ASCII");
const macTxt = sc.buildEarlyLaunchCommand("/usr/bin/node", "/opt/zw/dist/cli.js", 28256, "/Applications/ZCode.app", path.join(tmp, "early.log"));
ok(macTxt.includes("--remote-debugging-port=$ZWCDP") && macTxt.includes("--pick-ports"), "mac wrapper matches the sh contract");
// Syntax-gate the linux wrapper with the real shell — the probe/glob block
// is exactly the kind of code a typo silently kills.
const shFile = path.join(tmp, "zw-launch-check.sh");
fs.writeFileSync(shFile, shTxt);
try {
  execFileSync("sh", ["-n", shFile], { stdio: "ignore" });
  ok(true, "linux wrapper passes sh -n syntax check");
} catch {
  failures.push("linux wrapper fails sh -n syntax check");
}

// ── wiring pins on the live sources ──────────────────────────────────────────
const serverSrc = fs.readFileSync(path.join(root, "src", "core", "server.ts"), "utf8");
const mcpSrc = fs.readFileSync(path.join(root, "src", "mcp", "server.ts"), "utf8");
const cliSrc = fs.readFileSync(path.join(root, "src", "cli.ts"), "utf8");
function pin(cond, msg) {
  ok(cond, msg);
}
pin(serverSrc.includes("pickPorts") && serverSrc.includes("writeSessionPorts(cdpPort, apiPort)"), "serve resolves + records session ports under pickPorts");
pin(serverSrc.includes("apiCandidates(discovery.apiPort ?? apiPort)"), "API walk starts from session discovery");
pin(serverSrc.includes("opts.pickPorts || (cdpPort === DEFAULT_CONFIG.port"), "shortcut ensure + cdp-absent watchdog also run for pickPorts sessions");
pin(mcpSrc.includes("readSessionPorts()") && mcpSrc.includes("pickPorts: true"), "MCP host heartbeats/spawns on the discovered session ports");
pin(cliSrc.includes('pickPorts: has("--pick-ports")'), "CLI exposes --pick-ports");
pin(fs.readFileSync(path.join(root, "src", "core", "session.ts"), "utf8").includes("sp.apiPort ?? config.apiPort"), "wallpaper_status probes the discovered API port first");

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  for (const f of failures) console.error("FAIL:", f);
  process.exitCode = 1;
}
console.log(process.exitCode ? "PORTS: FAILED" : "PORTS: ALL OK");
