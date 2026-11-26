import { spawnSync, type SpawnSyncReturns } from "node:child_process";

// brick 35d4e64b (acpx half of ef5934ba) — the pod's idle predicate, called INSIDE the owner's atomic release.
//
// "Is this pod idle apart from the owner?" is infra's definition (its idle loop, `workbench-idle --agent`),
// kept in ONE place: the in-pod executable `nv-agent-idle --check`, which `reclaimed` re-checks too. acpx
// never reads the pod's status file or in-flight marks itself (decision of the acpx sub-HoD, 2026-11-26: one
// seam, no fallback read).
//
//   nv-agent-idle --check --owner-pid <pid> [--exclude-call-id <id>]
//     exit 0  idle (apart from the owner's subtree and the one excluded call)
//     exit 10 browser_open · 11 call_in_flight · 12 busy      (stdout: one line with the reason word)
//     anything else, a timeout, a signal, a missing binary ⇒ UNKNOWN
//
// ⚠️ A DOUBT IS A REFUSAL, NEVER IDLE. Only exit 0 is idle; every other outcome — including a binary that is
// not installed yet (the image carrying it lands after the devbox switch) — answers `unknown`, and the
// owner is left untouched. ⚠️ The call is SYNCHRONOUS on purpose: the owner holds its own loop from this
// call to its exit, so no prompt can start a turn in between; its bound is the 5 s below.

export type PodBusyReason = "browser_open" | "call_in_flight" | "busy" | "unknown";

export type PodMarksVerdict = { ok: true } | { ok: false; reason: PodBusyReason; detail: string };

export const IDLE_PREDICATE_PATH = "/usr/local/bin/nv-agent-idle";
export const IDLE_PREDICATE_TIMEOUT_MS = 5_000;
/** The test-only path override; honoured ONLY under `node --test` (a box setting it changes nothing). */
export const IDLE_PREDICATE_TEST_ENV = "ACPX_IDLE_PREDICATE";

const EXIT_REASONS: Readonly<Record<number, Exclude<PodBusyReason, "unknown">>> = {
  10: "browser_open",
  11: "call_in_flight",
  12: "busy",
};

export function idlePredicatePath(env: NodeJS.ProcessEnv): string {
  const override = env[IDLE_PREDICATE_TEST_ENV];
  return env.NODE_TEST_CONTEXT !== undefined && override ? override : IDLE_PREDICATE_PATH;
}

export type IdlePredicateOptions = {
  path: string;
  ownerPid: number;
  /**
   * The release call's own `ACPX_ROUTED_CALL_ID`: the routed entry's in-flight mark for THAT call
   * (`call_id=` inside it) is the call that asks, not work. Absent for a call that was not routed.
   */
  excludeCallId?: string;
  timeoutMs?: number;
  /** Injection seam for tests that must not spawn. */
  spawn?: typeof spawnSync;
};

function unknown(detail: string): PodMarksVerdict {
  return { ok: false, reason: "unknown", detail };
}

/** Why the predicate gave no answer at all (it did not run, or was ended), or undefined when it exited. */
function noAnswerDetail(result: SpawnSyncReturns<string>): string | undefined {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return `the idle predicate could not run (${code ?? result.error.message})`;
  }
  return result.signal ? `the idle predicate was ended by ${result.signal}` : undefined;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 120) ?? "";
}

function verdictOfResult(result: SpawnSyncReturns<string>): PodMarksVerdict {
  const noAnswer = noAnswerDetail(result);
  if (noAnswer) {
    return unknown(noAnswer);
  }
  if (result.status === 0) {
    return { ok: true };
  }
  const word = firstLine(result.stdout);
  const reason = EXIT_REASONS[result.status ?? -1];
  if (reason) {
    return { ok: false, reason, detail: word || reason };
  }
  return unknown(`the idle predicate exited ${String(result.status)}: ${word}`);
}

export function runIdlePredicate(options: IdlePredicateOptions): PodMarksVerdict {
  const args = ["--check", "--owner-pid", String(options.ownerPid)];
  if (options.excludeCallId) {
    args.push("--exclude-call-id", options.excludeCallId);
  }
  const run = options.spawn ?? spawnSync;
  const result = run(options.path, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? IDLE_PREDICATE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return verdictOfResult(result);
}
