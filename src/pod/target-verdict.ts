import { writeSync } from "node:fs";
import { Socket } from "node:net";

/**
 * K5, parity BY CONSTRUCTION (A9 round 4, brick 46b827ba; FINDINGS.md there).
 *
 * atrium says the target of a passed-through command is not a session (`target-unresolved`, or
 * `target-ambiguous` with the resolver's own sentence). The control pod's answer to that line is whatever acpx's
 * real local path says — commander, the global flags, the verb's own validators, then the lookup that fails — so
 * the pod does not imitate it: it RUNS that path, in a child process the Node permission model has made
 * read-only (no file write, no child process, no worker), with this verdict armed. The resolver throws the
 * control pod's own error for exactly the verdict's values; the runtime refuses everything else that writes.
 *
 * ⚠️ THE VERDICT IS HONOURED ONLY IN A PROCESS THE RUNTIME HAS MADE READ-ONLY (`isReadOnlyProcess`). The variable
 * is therefore inert in any normal process — an agent that sets it opens no way round the placement step — and a
 * child that cannot confirm it is read-only is never believed (the parent keeps the door's refusal).
 *
 * LIGHT MODULE: `src/cli.ts` loads it before the placement step.
 */

export const VERDICT_ENV = "ACPX_POD_TARGET_VERDICT";
/** The child's side channel to its parent (a pipe the parent opens): one JSON line per event. */
export const VERDICT_FD = 3;

export type TargetVerdict = {
  /** The selector value as given, as trimmed, and the `?session=` of a URL: what the resolver is asked for. */
  values: string[];
  kind: "not-found" | "ambiguous";
  /** `ambiguous` only: the resolver's own sentence, from atrium. */
  message?: string;
};

/** The ambiguity sentence goes to a terminal: bounded printable text, or it is not believed. */
const SAFE_SENTENCE = /^[^\p{Cc}]{1,1000}$/u;

export function isSafeSentence(value: unknown): value is string {
  return typeof value === "string" && SAFE_SENTENCE.test(value);
}

function parseJson(raw: string): Partial<TargetVerdict> | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<TargetVerdict> | null;
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

function validValues(values: unknown): values is string[] {
  return (
    Array.isArray(values) &&
    values.length <= 8 &&
    values.every((value) => typeof value === "string" && value.length <= 1000)
  );
}

function verdictFrom(parsed: Partial<TargetVerdict>): TargetVerdict | undefined {
  const { values, kind, message } = parsed;
  if (!validValues(values)) {
    return undefined;
  }
  if (kind === "not-found") {
    return { values, kind };
  }
  return kind === "ambiguous" && isSafeSentence(message) ? { values, kind, message } : undefined;
}

/** The verdict of the env value, or undefined when it is not one this build understands. */
export function parseVerdict(raw: string | undefined): TargetVerdict | undefined {
  const parsed = raw ? parseJson(raw) : undefined;
  return parsed ? verdictFrom(parsed) : undefined;
}

type Permission = { has(scope: string): boolean };

/**
 * Has the RUNTIME made this process read-only: the permission model is on and grants no file write, no child
 * process, no worker, no addon. Anything else — the model absent (an older Node, a normal process) or any of
 * those granted — is "not read-only" and the verdict is not honoured.
 */
export function isReadOnlyProcess(): boolean {
  const permission = (process as unknown as { permission?: Permission }).permission;
  return (
    permission !== undefined &&
    !["fs.write", "child", "worker", "addon"].some((scope) => permission.has(scope))
  );
}

let armed: TargetVerdict | undefined;

export function armTargetVerdict(verdict: TargetVerdict): void {
  armed = verdict;
}

export function armedTargetVerdict(): TargetVerdict | undefined {
  return armed;
}

/** One event on the side channel; a process with no such pipe (a normal one) simply has nothing to tell. */
export type VerdictEvent = "readonly" | "verdict" | "network" | "differs" | "crashed";

export function tellParent(event: VerdictEvent): void {
  try {
    writeSync(VERDICT_FD, `${JSON.stringify({ event })}\n`);
  } catch {
    // no pipe: not a verdict child
  }
}

/** The child's own word that it reached its normal end, with the code it ends with (`process.on("exit")`). */
export function tellExit(code: number): void {
  try {
    writeSync(VERDICT_FD, `${JSON.stringify({ event: "exit", code })}\n`);
  } catch {
    // no pipe
  }
}

/**
 * The Node permission model does not restrict the NETWORK (v22). The verdict child never needs it, so — as one more
 * line of defence, at the single place every `net`, `tls`, `http` and `fetch` connection passes — a connection
 * attempt is told to the parent and refused. (UDP and DNS are not covered; measured clean in the corpus — see
 * FINDINGS.md.)
 */
export function installNetworkBarrier(): void {
  Socket.prototype.connect = function refused(): never {
    tellParent("network");
    throw Object.assign(
      new Error("ERR_ACCESS_DENIED: a pod's verdict child may not use the network"),
      {
        code: "ERR_ACCESS_DENIED",
      },
    );
  } as typeof Socket.prototype.connect;
}
