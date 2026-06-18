import { spawn } from "node:child_process";
import { buildSpawnCommandOptions } from "../spawn-command-options.js";

/**
 * The OS-primer resolver: runs the shared session-context script once per acpx
 * process and hands its stdout to `buildNewSessionMeta` so every new session —
 * for every agent type — is primed at the acpx layer (claude via
 * `_meta.systemPrompt {append}`, codex via `_meta.codex.developerInstructions`).
 * Replaces the Claude-Code `SessionStart` hook, which only reached `claude` and
 * truncated the payload to a saved-to-path preview.
 *
 * The default points at the dynamic `shared/session-context.sh` (host block +
 * agents.md via includeFull.sh), run PER box so the host block stays live. The
 * `ACPX_SESSION_PRIMER_COMMAND` seam mirrors the agent-registry overrides: it
 * lets the fleet relocate the script and lets dev/test point at a marked or
 * fast primer without an acpx release.
 */
const DEFAULT_SESSION_PRIMER_COMMAND =
  "/wisdom/Operating System/Harnesses/shared/session-context.sh";

const SESSION_PRIMER_TIMEOUT_MS = 5_000;

/**
 * Memoized SUCCESS. The primer is constant per box per acpx invocation, and
 * acpx is spawned per-command by acpx-ui, so this is typically one exec per
 * session op — the memo is cheap insurance. Only successes are cached, so a
 * transient failure (missing script / timeout) is retried on the next call.
 */
let memoizedPrimer: string | undefined;
let primerMemoized = false;

/** Test-only: drop the success memo so a fresh exec runs next call. */
export function resetSessionPrimerMemoForTests(): void {
  memoizedPrimer = undefined;
  primerMemoized = false;
}

function resolveSessionPrimerCommand(): string {
  const override = process.env.ACPX_SESSION_PRIMER_COMMAND;
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return DEFAULT_SESSION_PRIMER_COMMAND;
}

function warnPrimer(command: string, reason: string): void {
  // Structured, single-line warning — same convention as the other acpx
  // spawn-time advisories (auth-env.ts). Fail-open: the session is still
  // created without the primer (== today's codex behavior).
  process.stderr.write(
    `[acpx] session primer unavailable (${command}): ${reason}; continuing unprimed\n`,
  );
}

/**
 * Resolve the OS primer text for a new session. Fail-open: a missing script,
 * non-zero exit, timeout, or empty output emits a structured warning and
 * returns `undefined` — never throws, never blocks session creation (AC8).
 */
export async function resolveSessionPrimer(): Promise<string | undefined> {
  if (primerMemoized) {
    return memoizedPrimer;
  }
  const command = resolveSessionPrimerCommand();
  const primer = await execSessionPrimer(command);
  if (primer !== undefined) {
    memoizedPrimer = primer;
    primerMemoized = true;
  }
  return primer;
}

function execSessionPrimer(command: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // The primer command is a single executable path (the default carries
      // spaces) — spawn it directly, no shell, no arg splitting.
      child = spawn(
        command,
        [],
        buildSpawnCommandOptions(command, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }),
      );
    } catch (error) {
      warnPrimer(command, `spawn failed: ${describeError(error)}`);
      resolve(undefined);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      warnPrimer(command, `timed out after ${SESSION_PRIMER_TIMEOUT_MS}ms`);
      finish(undefined);
    }, SESSION_PRIMER_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      warnPrimer(command, `exec error: ${describeError(error)}`);
      finish(undefined);
    });
    child.once("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim();
        warnPrimer(command, `exited with code ${code ?? "null"}${tail ? `: ${tail}` : ""}`);
        finish(undefined);
        return;
      }
      if (stdout.trim().length === 0) {
        warnPrimer(command, "produced empty output");
        finish(undefined);
        return;
      }
      finish(stdout);
    });
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
