/**
 * Shared child-process helper: every external tool (powershell, ffmpeg,
 * wallpaper64.exe) is a console program, and without windowsHide each spawn
 * flashes a terminal window. One wrapper, used everywhere.
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const execRaw = promisify(execFile);

export function execFileP(
  cmd: string,
  args: string[],
  opts: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  // powershell/cscript output arrives as strings under the default encoding;
  // the runtime type is string|Buffer only because of generic overloads.
  return execRaw(cmd, args, { windowsHide: true, ...opts }) as Promise<{ stdout: string; stderr: string }>;
}
