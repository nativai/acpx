import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
 *
 * The primer is rendered in the SESSION's environment — the caller passes the
 * very env its agent process was spawned with (`buildAgentSpawnOptions().env`).
 * agents.md gates fragments on `if_env="…"` (today `ACPX_BRICK` and
 * `ACPX_PARENT_SESSION_URL`), and those guards are evaluated by the render
 * process, so rendering under acpx's own env answered them for the SPAWNER
 * instead of the child: a child spawned WITH a parent lost the parent-reporting
 * fragment, and a brick-less child spawned from a brick-holding parent was told
 * to run `brick context "$ACPX_BRICK"` against an unset var (brick 589f0062).
 * Passing the whole child env — not a copied subset of "the vars today's guards
 * read" — is what keeps a newly added guard correct without a change here.
 */
const DEFAULT_SESSION_PRIMER_COMMAND =
  "/wisdom/Operating System/Harnesses/shared/session-context.sh";

const SESSION_PRIMER_TIMEOUT_MS = 5_000;

/**
 * Memoized SUCCESS, keyed by (command + render env). The primer is NOT constant
 * per acpx invocation — it is a function of the environment it renders in (see
 * the `if_env` guards above), so an unkeyed memo would serve a second session
 * the first session's fragments. Keying on the env CONTENT rather than on a
 * session id makes that structural: two sessions share the memo exactly when
 * their rendered primer cannot differ.
 *
 * Single slot, so it cannot grow: acpx is spawned per-command by acpx-ui, so a
 * process serves one session's create + resume re-supply — the repeat this memo
 * exists for — and a differing key simply replaces the entry. Only successes are
 * cached, so a transient failure (missing script / timeout) is retried next call.
 */
let memoizedPrimer: string | undefined;
let memoizedPrimerKey: string | undefined;

/** Test-only: drop the success memo so a fresh exec runs next call. */
export function resetSessionPrimerMemoForTests(): void {
  memoizedPrimer = undefined;
  memoizedPrimerKey = undefined;
}

/**
 * Hash of everything the render depends on. Hashed rather than stored verbatim
 * so the memo never holds a second plaintext copy of the credentials the agent
 * env carries.
 */
function buildPrimerMemoKey(command: string, env: NodeJS.ProcessEnv): string {
  const entries = Object.keys(env)
    .toSorted()
    .map((key) => [key, env[key] ?? ""]);
  return createHash("sha256")
    .update(JSON.stringify([command, entries]))
    .digest("hex");
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
 *
 * `sessionEnv` — the environment the session's agent process was spawned with —
 * is REQUIRED, deliberately. An optional parameter defaulting to `process.env`
 * would mean that omitting it silently restores the very defect this plumbing
 * exists to fix, with no type error, no test failure and no log line. Required,
 * a missed call site is a compile error instead. Note this is NOT the fail-open
 * behavior below wearing different clothes: a failed *render* warns and returns
 * undefined; a missing *env argument* is not a runtime condition at all.
 */
export async function resolveSessionPrimer(
  sessionEnv: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const command = resolveSessionPrimerCommand();
  const key = buildPrimerMemoKey(command, sessionEnv);
  if (memoizedPrimerKey === key) {
    return memoizedPrimer;
  }
  const primer = await execSessionPrimer(command, sessionEnv);
  if (primer !== undefined) {
    memoizedPrimer = primer;
    memoizedPrimerKey = key;
  }
  return primer;
}

function execSessionPrimer(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
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
          env,
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
