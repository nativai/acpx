import { statSync } from "node:fs";

export const ACPX_AGENT_OS_BIN_ENV = "ACPX_AGENT_OS_BIN";
export const DEFAULT_AGENT_OS_BIN_DIR = "/wisdom/Operating System/bin";

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Append the Operating System's script directory to the PATH an agent process is spawned with, so
 * the bare script names the OS teaching uses (`send-message.sh`, `transcript.sh`) resolve in the
 * harness's Bash tool.
 *
 * The directory goes at the END, so it can never shadow a binary an agent already resolves. It is
 * appended only when it exists at spawn, never twice (a nested spawn inherits the entry), and no
 * existing entry is reordered. `ACPX_AGENT_OS_BIN` overrides the directory; the empty string
 * disables the append. A directory containing `:` cannot be represented in PATH and is skipped.
 */
export function appendAgentOsBinToPath(env: NodeJS.ProcessEnv): void {
  const dir = env[ACPX_AGENT_OS_BIN_ENV] ?? DEFAULT_AGENT_OS_BIN_DIR;
  if (!dir || dir.includes(":") || !isDirectory(dir)) {
    return;
  }
  const current = env.PATH;
  if (!current) {
    env.PATH = dir;
    return;
  }
  if (current.split(":").includes(dir)) {
    return;
  }
  env.PATH = `${current}:${dir}`;
}
