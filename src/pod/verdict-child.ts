import { spawnSync } from "node:child_process";
import type { Classification } from "./command-classes.js";
import { ROUTED_MARKER_ENV } from "./routed-twice.js";
import { isSafeSentence, parseVerdict, VERDICT_ENV, type TargetVerdict } from "./target-verdict.js";

/**
 * The pod's half of K5 parity by construction (brick 46b827ba): start acpx's real local path for the SAME argv in a
 * child the Node permission model has made read-only, with atrium's verdict armed (`target-verdict.ts`), and relay
 * what it says — but only an answer the parent has reason to believe. EVERYTHING ELSE KEEPS THE DOOR'S REFUSAL:
 *
 *   - the child did not confirm it is read-only (an older Node, a model that is off): never run unrestricted;
 *   - it could not start, crashed (a signal), or ran out of its bounded time;
 *   - the child's OWN read of the session store disagreed with atrium's verdict (`differs`: the record is there, two
 *     records became one, the read failed otherwise) — never a "not found" the pod's own disk contradicts;
 *   - the child tried the network (`network`);
 *   - a write or a child process was DENIED (`ERR_ACCESS_DENIED`): the path reached for something a pod must not do;
 *   - it ended 0: an armed run of a command about a session nobody can find that SUCCEEDED resolved something else;
 *   - it did not report its own normal end with the exit code it left with (killed, or exited by something other than
 *     acpx's own exit path — a fixture that just `exit(5)`s says nothing), or it crashed (an uncaught exception).
 *
 * `ACPX_ROUTED=1` is in the child's environment so that a child which did NOT arm (and so would be placed as an
 * ordinary invocation) is refused `routed_twice` instead of calling home again.
 */

export const VERDICT_CHILD_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type ChildSpec = {
  argv: readonly string[];
  verdict: TargetVerdict;
  env: NodeJS.ProcessEnv;
};

export type ChildResult = {
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** What the child wrote on its side channel (`target-verdict.ts`), one JSON line per event. */
  events: string;
  /** The child could not be run to completion: a spawn error, the timeout, the output bound. */
  error?: string;
};

export type ChildRunner = (spec: ChildSpec) => ChildResult;

/** Under `node --test` only (the precedent of `ACPX_POD_TEST_HOME`): a shorter bound for the row that holds a child at it. */
function timeoutMs(env: NodeJS.ProcessEnv): number {
  const seam = Number(env.ACPX_POD_VERDICT_TIMEOUT_MS);
  return env.NODE_TEST_CONTEXT && Number.isFinite(seam) && seam > 0
    ? seam
    : VERDICT_CHILD_TIMEOUT_MS;
}

const DEFAULT_CHILD_FLAGS = ["--permission", "--allow-fs-read=*"];

/**
 * TEST SEAMS, honoured ONLY under `node --test` (`NODE_TEST_CONTEXT`, the precedent of `ACPX_POD_TEST_HOME`): the
 * flags the child gets (`none` = a Node with no permission model at all; anything else replaces them) and the entry it
 * runs (a fixture that writes, connects, hangs, crashes … — `test/pod-not-found.test.ts`). In production the child is
 * this very CLI under `--permission` and nothing in the environment changes that.
 */
function childCommand(env: NodeJS.ProcessEnv): { flags: string[]; entry: string | undefined } {
  const testing = Boolean(env.NODE_TEST_CONTEXT);
  const flagSeam = testing ? env.ACPX_POD_VERDICT_CHILD_FLAGS : undefined;
  const flags =
    flagSeam === undefined
      ? DEFAULT_CHILD_FLAGS
      : flagSeam === "none"
        ? []
        : flagSeam.split(" ").filter((flag) => flag !== "");
  const entry = (testing ? env.ACPX_POD_VERDICT_CHILD_ENTRY : undefined) ?? process.argv[1];
  return { flags, entry };
}

/**
 * The child's environment: the pod's, with the verdict and `ACPX_ROUTED`, and WITHOUT `NODE_OPTIONS` — a pod image or an
 * agent that sets `NODE_OPTIONS=--allow-fs-write=<the store>` must not hand the child a write grant (TE F1). The flags are
 * constructed here, exactly (`DEFAULT_CHILD_FLAGS`). Test seam (under `node --test` only): `ACPX_POD_VERDICT_CHILD_NODE_OPTIONS`
 * puts a value back, to prove the CHILD refuses one that got through (its own checks, `isReadOnlyProcess`).
 */
function childEnv(spec: ChildSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...spec.env,
    [ROUTED_MARKER_ENV]: "1",
    [VERDICT_ENV]: JSON.stringify(spec.verdict),
  };
  delete env.NODE_OPTIONS;
  const seam = spec.env.NODE_TEST_CONTEXT
    ? spec.env.ACPX_POD_VERDICT_CHILD_NODE_OPTIONS
    : undefined;
  if (seam !== undefined) {
    env.NODE_OPTIONS = seam;
  }
  return env;
}

/** The real child: this very CLI, under `--permission` (no file write, no child process, no worker), reads allowed. */
export const spawnVerdictChild: ChildRunner = (spec) => {
  const { flags, entry } = childCommand(spec.env);
  if (!entry) {
    return { status: null, signal: null, stdout: "", stderr: "", events: "", error: "no-entry" };
  }
  const result = spawnSync(process.execPath, [...flags, entry, ...spec.argv], {
    env: childEnv(spec),
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    timeout: timeoutMs(spec.env),
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: "utf8",
  });
  const side = (result.output as unknown[] | null)?.[3];
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    events: typeof side === "string" ? side : "",
    ...(result.error ? { error: (result.error as NodeJS.ErrnoException).code ?? "error" } : {}),
  };
};

export type Judgement =
  | { relay: true; stdout: string; stderr: string; exit: number }
  | { relay: false; why: string };

type Events = { seen: Set<string>; exitCode: number | undefined };

function eventsOf(text: string): Events {
  const events: Events = { seen: new Set(), exitCode: undefined };
  for (const line of text.split("\n")) {
    try {
      const parsed = JSON.parse(line) as { event?: unknown; code?: unknown };
      if (typeof parsed.event === "string") {
        events.seen.add(parsed.event);
        events.exitCode =
          parsed.event === "exit" && typeof parsed.code === "number"
            ? parsed.code
            : events.exitCode;
      }
    } catch {
      // not an event line
    }
  }
  return events;
}

/** Why the child's end is NOT an answer, when the child did not even finish or confirm itself. */
function unfinished(result: ChildResult, events: Events): string | undefined {
  if (result.error !== undefined) {
    return `child-${result.error}`;
  }
  if (result.signal !== null || result.status === null) {
    return "child-signal";
  }
  return events.seen.has("readonly") ? undefined : "not-confirmed-read-only";
}

/** Events the child tells that make its answer untrustworthy, each with the reason the parent gives for the refusal. */
const MISBEHAVIOURS: ReadonlyArray<readonly [string, string]> = [
  ["network", "network"],
  ["denied", "denied"],
  ["differs", "pod-view-differs"],
  ["registry", "pod-registry-refusal"],
];

/** Why it is not an answer when it finished and confirmed itself: it did what it must not, or it succeeded. */
function misbehaved(result: ChildResult, events: Events): string | undefined {
  for (const [event, why] of MISBEHAVIOURS) {
    if (events.seen.has(event)) {
      return why;
    }
  }
  return result.status === 0 ? "child-succeeded" : undefined;
}

/**
 * Why the child's END is not an answer: it crashed, a write was denied, or it did not report its own normal end with
 * the code it left with (a process killed or exited by something other than acpx's own exit path).
 */
function unconvincing(result: ChildResult, events: Events): string | undefined {
  const output = `${result.stdout}${result.stderr}`;
  if (events.seen.has("crashed")) {
    return "crashed";
  }
  if (DENIAL_TEXT.some((text) => output.includes(text))) {
    return "denied";
  }
  return events.exitCode === result.status ? undefined : "no-normal-end";
}

/** What a denied write looks like in the output, when a handler prints the message and not the code (TE F5). */
const DENIAL_TEXT = ["ERR_ACCESS_DENIED", "Access to this API has been restricted"];

/** Is this the control pod's answer, and may it be relayed? (See the header for the cases that may not.) */
export function judgeChild(result: ChildResult): Judgement {
  const events = eventsOf(result.events);
  const why =
    unfinished(result, events) ?? misbehaved(result, events) ?? unconvincing(result, events);
  return why === undefined
    ? { relay: true, stdout: result.stdout, stderr: result.stderr, exit: result.status ?? 1 }
    : { relay: false, why };
}

/** The `?session=` of a URL, as the command line carried it. */
function sessionParamOf(value: string): string | undefined {
  try {
    return new URL(value).searchParams.get("session") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * atrium's verdict on the target, from a `400 class-not-passable` (A-52): `target-unresolved` — no session
 * matches (or none was named); `target-ambiguous` — two do, with the resolver's own sentence. Any other
 * reason — `target-lookup-failed`, `own-session`, a reason this build does not know — is not a verdict.
 */
export function verdictOf(
  status: number,
  body: { error?: unknown; reason?: unknown; message?: unknown },
  classification: Classification,
): TargetVerdict | undefined {
  if (status !== 400 || body.error !== "class-not-passable") {
    return undefined;
  }
  const target = classification.kind === "classified" ? classification.target : undefined;
  const named = target ? [target.value, sessionParamOf(target.value)] : [];
  const values = [...new Set(named.flatMap((v) => (v === undefined ? [] : [v, v.trim()])))].filter(
    (v) => v !== "",
  );
  if (body.reason === "target-unresolved") {
    return parseVerdict(JSON.stringify({ values, kind: "not-found" }));
  }
  return body.reason === "target-ambiguous" && isSafeSentence(body.message)
    ? parseVerdict(JSON.stringify({ values, kind: "ambiguous", message: body.message }))
    : undefined;
}
