import { randomUUID } from "node:crypto";
import { callerIdentityFrom } from "./caller-identity.js";
import type { Classification, OutputMode } from "./command-classes.js";
import { isClaudePtyCommand } from "./harness-support.js";
import { isHomeOnlyHarness, readBoxFacts } from "./home-only.js";
import {
  registerBranchHandler,
  type BranchContext,
  type BranchHandler,
  type PlacementDecision,
} from "./placement-step.js";
import { testRuntimeDir } from "./placement.js";
import { isRoutedCall, refuseRoutedTwice } from "./routed-twice.js";

// ⚠️ NO static import — not even a type-only one — of `routed-call.ts` / `broker-client.ts` here:
// `test/pod-command-classes.test.ts` ("the light graph") counts type imports, and those modules reach
// acpx's heavy graph. Type-position `import("…")` expressions are not static imports.
type RoutedCallOptions = import("./routed-call.js").RoutedCallOptions;
type RoutedCallResult = import("./routed-call.js").RoutedCallResult;
type AgentPodLookup = import("./routed-call.js").AgentPodLookup;
type ResolveReleasesResult = import("./routed-call.js").ResolveReleasesResult;
type AgentHarness = import("./broker-client.js").AgentHarness;

/**
 * A6.1 — the two branches of A1's placement step that A6 builds (C1.2):
 *
 *   routed-ensure   class `owner-ensure` (`prompt`) on the control pod: ensure the session's pod
 *                   through the broker (C4), then the routed call (C2).
 *   routed-if-pod   class `owner-if-pod` on the control pod: the routed call if the pod exists
 *                   (C3.3); otherwise `"proceed"` — today's local path answers from the record.
 *
 * ⚠️ LIGHT GRAPH. `src/cli.ts` registers these before acpx's heavy imports, so this module imports
 * only types and A1's registry at load time; everything else is `import()`ed when a branch runs.
 * ⚠️ ONLY `routed-ensure` MAY ASK THE BROKER (C1.2): `routed-if-pod` passes no broker options and its
 * class never reaches `ensureOwnerPod` (held by test/pod-routed-call.test.ts "only owner-ensure…").
 */

type Branch = PlacementDecision & { kind: "branch" };
type Classified = Classification & { kind: "classified" };

export type RoutedRecord = {
  acpxRecordId: string;
  agentCommand: string;
  seatId?: string;
};

export type BranchDeps = {
  argv: () => string[];
  env: NodeJS.ProcessEnv;
  cwd: () => string;
  isTty: () => boolean;
  readStdin: () => Promise<string>;
  resolveTarget: (classification: Classified) => Promise<string | null>;
  loadRecord: (id: string) => Promise<RoutedRecord | undefined>;
  harnessOf: (agentCommand: string) => string | undefined;
  lookup: AgentPodLookup;
  /**
   * The uid of the pod the session's LEASE names — the pod the failed call targeted. The DELETE's uid
   * comes from here and nowhere else (C4's precondition exists so a pod that replaced it meanwhile is
   * never deleted); absent or undefined ⇒ nothing is deleted.
   */
  leasePodUid?: (sessionId: string) => Promise<string | undefined>;
  /**
   * `DELETE /v1/agents/<key>?uid=<uid>` (C4, A-1): what `close` and `recover` send for a pod they
   * could not reach. Optional so a caller that never deletes needs none; absent ⇒ nothing is deleted.
   */
  deleteAgent?: (
    key: string,
    uid: string,
  ) => Promise<{ kind: "deleted" | "refused" | "unavailable" }>;
  /**
   * ba830305 (A-32, C3.1): the control pod's judgement of the session's PREDECESSOR lease, made before the call is
   * routed into a pod. A replacement pod's owner can never prove its predecessor dead (an agent pod never asks
   * the API server, C3.3 A-4), so a lease that names a pod proven `gone` on a stale heartbeat is reaped HERE, the one
   * place that may prove it. Never throws, never signals; absent ⇒ nothing is judged.
   */
  reapPredecessorLease?: (sessionId: string) => Promise<void>;
  releases: () => ResolveReleasesResult;
  /** The target session's URL for the broker's Job annotation (C4 `sessionUrl`); may read the box's base URL. */
  sessionUrl?: (sessionId: string) => string | undefined;
  /** Where payload files go; absent = the production directory. A test seam, see `liveDeps`. */
  payloadDir?: string;
  admissionClass: () => string | undefined;
  run: (options: RoutedCallOptions) => Promise<RoutedCallResult>;
  /** Prints a failure the way acpx prints one (`output`: text, json, json-strict), and returns the exit code. */
  fail: (error: unknown, output: OutputMode) => Promise<number>;
  stderr: (text: string) => void;
};

// `exec` reads its prompt from stdin like `prompt` does; its payload travels the same way (A10, the
// utility-pod branch is the only caller that reaches `planPayload` with it).
const PROMPT_PATHS = new Set(["", "<agent>", "prompt", "exec"]);
/**
 * The harnesses a pod may host. ⚠️ `claude-pty` IS NOT ONE (A-39, brick b69eeecf): the terminal harness is
 * not in phase 1 and C12.1 (A-30, the screen lease) is withdrawn. A pod-mode `claude-pty` record is
 * refused BY NAME — `ROUTED outcome=not_run reason=harness_unsupported` — before any broker request.
 * Do not "restore" it here: `test/pod-routed-branches.test.ts` (A-39 rows) goes red if you do.
 */
const HARNESSES: ReadonlySet<string> = new Set(["claude", "pi", "codex"]);

/** The same normalization `src/cli.ts` applies to `process.argv` before the placement step. */
export function routedArgv(argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const raw = argv.slice(2);
  return raw[0] === "--" && (env.npm_lifecycle_event || env.npm_lifecycle_script)
    ? raw.slice(1)
    : raw;
}

type PayloadPlan =
  | { text: string; argvFor: (payloadPath: string | undefined) => string[] }
  | undefined;

/** The index of `--file`/`-f` taking `-`, or -1; the inline form `--file=-` is index of that token. */
function stdinFileFlagIndex(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      return -1;
    }
    if ((token === "--file" || token === "-f") && argv[i + 1] === "-") {
      return i + 1;
    }
    if (token === "--file=-") {
      return i;
    }
  }
  return -1;
}

function hasFileFlag(argv: readonly string[]): boolean {
  const stop = argv.indexOf("--");
  const head = stop >= 0 ? argv.slice(0, stop) : argv;
  return head.some(
    (t) =>
      t === "--file" ||
      t === "-f" ||
      t.startsWith("--file=") ||
      t === "--batch-file" ||
      t.startsWith("--batch-file="),
  );
}

/** The prompt arrives on the caller's stdin, which does not travel: it goes in the payload file instead. */
function replaceStdinFlag(
  argv: readonly string[],
  at: number,
  payloadPath: string | undefined,
): string[] {
  const out = [...argv];
  const path = payloadPath ?? "-";
  if (out[at] === "--file=-") {
    out[at] = `--file=${path}`;
  } else {
    out[at] = path;
  }
  return out;
}

function appendFileFlag(argv: readonly string[], payloadPath: string | undefined): string[] {
  const stop = argv.indexOf("--");
  const at = stop >= 0 ? stop : argv.length;
  return [...argv.slice(0, at), "--file", payloadPath ?? "-", ...argv.slice(at)];
}

export const PROMPT_REQUIRED_MESSAGE =
  "Prompt is required (pass as argument, --file, or pipe via stdin)";

/**
 * C2 gives the routed command no stdin. A prompt that reads stdin — `--file -`, or no text at all
 * with stdin not a terminal (what the local CLI does) — is read HERE, on the control pod, and travels
 * as the payload file. No text, no file and a terminal: acpx's own usage error, said HERE and named —
 * never an "empty stdin" from inside the pod.
 */
export async function planPayload(
  classification: Classified,
  argv: string[],
  deps: Pick<BranchDeps, "isTty" | "readStdin">,
): Promise<PayloadPlan | "prompt_required"> {
  if (!PROMPT_PATHS.has(classification.path)) {
    return undefined;
  }
  const flagAt = stdinFileFlagIndex(argv);
  if (flagAt >= 0) {
    return { text: await deps.readStdin(), argvFor: (p) => replaceStdinFlag(argv, flagAt, p) };
  }
  if (hasFileFlag(argv) || classification.operandIndexes.length > 0) {
    return undefined;
  }
  if (deps.isTty()) {
    return "prompt_required";
  }
  return { text: await deps.readStdin(), argvFor: (p) => appendFileFlag(argv, p) };
}

/**
 * C2 (A-24): the routed `argv` is the WHOLE command — `argv[0]` is the string `acpx`, which the pod's
 * entry executes and resolves on the pod's PATH to the release C9 pinned; `argv[1…]` are acpx's own
 * arguments, unchanged. Never a path of our own. ⚠️ Sending the arguments alone made the pod run
 * `claude …` / `prompt …` / `cancel …` as a program (TE F-1).
 */
export const ROUTED_PROGRAM = "acpx";

function sessionTarget(record: RoutedRecord, deps: BranchDeps) {
  const admissionClass = deps.admissionClass();
  const harness = deps.harnessOf(record.agentCommand) as AgentHarness;
  const sessionUrl = deps.sessionUrl;
  return {
    sessionId: record.acpxRecordId,
    ...(sessionUrl ? { sessionUrl: () => sessionUrl(record.acpxRecordId) } : {}),
    seat: record.seatId ?? record.acpxRecordId,
    harness,
    // A-45 (C4): a home-only harness is placed `home`, anything else `auto`. The SAME function decides the
    // utility pod's key (`home-only.ts`, A-44), so sessions and one-shots switch together when P1 lands.
    placement: isHomeOnlyHarness(harness, readBoxFacts(deps.env))
      ? ("home" as const)
      : ("auto" as const),
    ...(admissionClass ? { admissionClass } : {}),
  };
}

async function resolveRecord(
  classification: Classified,
  deps: BranchDeps,
): Promise<RoutedRecord | undefined> {
  const id = await deps.resolveTarget(classification);
  return id ? await deps.loadRecord(id) : undefined;
}

/** acpx's own kind of failure for a call that never started: named, exit 1 (C2 table's `not_run`). */
async function notRun(reason: string, output: OutputMode, deps: BranchDeps): Promise<number> {
  const { RoutedCallError } = await import("./pod-refusal.js");
  return await deps.fail(
    new RoutedCallError({ outcome: "not_run", reason, callId: randomUUID() }),
    output,
  );
}

type Ready = { record: RoutedRecord; classification: Classified; argv: string[] };

/** The session a branch is about, or the named failure (already printed) that ends the command. */
async function readyOrFail(
  decision: Branch,
  deps: BranchDeps,
  routedClass: "owner-ensure" | "owner-if-pod",
): Promise<Ready | number> {
  const argv = deps.argv();
  const classification = decision.classification;
  const record =
    classification.kind === "classified" ? await resolveRecord(classification, deps) : undefined;
  if (classification.kind !== "classified" || !record) {
    return await notRun("target_unresolved", decision.classification.output, deps);
  }
  const harness = deps.harnessOf(record.agentCommand);
  if (
    routedClass === "owner-ensure" &&
    (isClaudePtyCommand(record.agentCommand) || harness === undefined || !HARNESSES.has(harness))
  ) {
    return await notRun("harness_unsupported", decision.classification.output, deps);
  }
  return { record, classification, argv };
}

/** acpx's own usage failure (exit 2), printed in the command's output mode. */
async function usageError(message: string, output: OutputMode, deps: BranchDeps): Promise<number> {
  if (output === "text") {
    deps.stderr(`${message}\n`);
    return 2;
  }
  const { AcpxOperationalError } = await import("../errors.js");
  return await deps.fail(
    new AcpxOperationalError(message, { outputCode: "USAGE", origin: "cli" }),
    output,
  );
}

function runOptions(
  ready: Ready,
  plan: Exclude<PayloadPlan, undefined> | undefined,
  deps: BranchDeps,
  routedClass: "owner-ensure" | "owner-if-pod",
  key: string,
): RoutedCallOptions {
  return {
    class: routedClass,
    key,
    target: sessionTarget(ready.record, deps),
    argv: plan
      ? (payloadPath: string | undefined) => [ROUTED_PROGRAM, ...plan.argvFor(payloadPath)]
      : [ROUTED_PROGRAM, ...ready.argv],
    cwd: deps.cwd(),
    env: deps.env,
    lookup: deps.lookup,
    // C2: the caller's identity travels ONLY when an agent caused the call through the pass-through
    // — which is exactly when the server put it in this process's environment (caller-identity.ts).
    callerIdentity: callerIdentityFrom(deps.env),
    ...(plan ? { payload: plan.text } : {}),
    ...(deps.payloadDir ? { payloadDir: deps.payloadDir } : {}),
    ...(routedClass === "owner-ensure" ? { releases: deps.releases() } : {}),
  };
}

async function dispatchRouted(
  decision: Branch,
  context: BranchContext,
  deps: BranchDeps,
  routedClass: "owner-ensure" | "owner-if-pod",
): Promise<number | "proceed"> {
  if (isRoutedCall(deps.env)) {
    // A command that arrived in a pod already routed is never routed again (A-8 `routed_twice`) —
    // the same helper block A3's pass-through uses.
    return refuseRoutedTwice(decision.classification.output, context.write, context.writeStdout);
  }
  const ready = await readyOrFail(decision, deps, routedClass);
  if (typeof ready === "number") {
    return ready;
  }
  const plan =
    routedClass === "owner-ensure"
      ? await planPayload(ready.classification, ready.argv, deps)
      : undefined;
  if (plan === "prompt_required") {
    return await usageError(PROMPT_REQUIRED_MESSAGE, ready.classification.output, deps);
  }
  const key = await podKeyAfterPredecessorJudgement(ready.record.acpxRecordId, deps);
  try {
    const result = await deps.run(runOptions(ready, plan, deps, routedClass, key));
    return result.kind === "no_pod" ? "proceed" : result.exitCode;
  } catch (error) {
    if (await deletedUnreachablePod(error, ready, routedClass, key, deps)) {
      return "proceed";
    }
    return await deps.fail(await refusalForCaller(error, ready), ready.classification.output);
  }
}

/**
 * A-79: the sentence of a refusal that promises a hold is chosen here and at A-16's guard, by ONE helper
 * (`refusalForCaller`, pod-refusal.ts): the promise stands only for atrium's delivery spawns (`--message-id`,
 * `--batch-file`); every other caller is told nothing was queued. Token line and exit code unchanged.
 */
async function refusalForCaller(error: unknown, ready: Ready): Promise<unknown> {
  const { refusalForCaller: choose } = await import("./pod-refusal.js");
  return choose(error, ready.argv);
}

/**
 * The session's pod key, after the control pod has judged the session's predecessor lease (ba830305, A-32 + C3.1,
 * row 32.5): "the control pod's next judgement" is THIS one, made before the call goes into a pod.
 */
async function podKeyAfterPredecessorJudgement(
  sessionId: string,
  deps: BranchDeps,
): Promise<string> {
  const { agentPodKey } = await import("./routed-call.js");
  await deps.reapPredecessorLease?.(sessionId);
  return agentPodKey(sessionId);
}

const DELETES_UNREACHABLE_POD = new Set(["sessions close", "sessions recover"]);

/** A routed call that ended `ROUTED outcome=not_run reason=agent_unreachable` (C2, past the 60 s bound). */
function isUnreachable(error: unknown): boolean {
  const failure = error as { outcome?: unknown; reason?: unknown } | null;
  return failure?.outcome === "not_run" && failure.reason === "agent_unreachable";
}

/**
 * A4 (C2 "A pod that is Ready and cannot be reached", C4): an EXPLICIT `close` or `recover` whose
 * routed call found the pod unreachable deletes it through the broker with the pod's uid as the
 * precondition — so a pod that replaced it meanwhile is never deleted — and then answers from the
 * record, as `owner-if-pod` does for a session with no pod. Nothing else deletes a pod because it
 * cannot be reached: not a prompt, not a status, not a setting (A-1). Returns true only when the
 * broker confirmed the pod gone; on `refused` / `unavailable` the original failure is shown.
 */
async function deletedUnreachablePod(
  error: unknown,
  ready: Ready,
  routedClass: "owner-ensure" | "owner-if-pod",
  key: string,
  deps: BranchDeps,
): Promise<boolean> {
  const path = ready.classification.path;
  if (
    routedClass !== "owner-if-pod" ||
    !DELETES_UNREACHABLE_POD.has(path) ||
    !isUnreachable(error) ||
    !deps.deleteAgent ||
    !deps.leasePodUid
  ) {
    return false;
  }
  // F2: the uid of the pod that could not be reached — from the lease, never from a second lookup,
  // which could answer with a replacement pod.
  const uid = await deps.leasePodUid(ready.record.acpxRecordId);
  return uid !== undefined && (await deps.deleteAgent(key, uid)).kind === "deleted";
}

export function routedBranchHandlers(
  deps: BranchDeps,
): Record<"routed-ensure" | "routed-if-pod", BranchHandler> {
  return {
    "routed-ensure": async (decision, context) =>
      await dispatchRouted(decision, context, deps, "owner-ensure"),
    "routed-if-pod": async (decision, context) =>
      await dispatchRouted(decision, context, deps, "owner-if-pod"),
  };
}

export async function failLikeAcpx(error: unknown, output: OutputMode): Promise<number> {
  const { normalizeOutputError, exitCodeForOutputErrorCode } =
    await import("../acp/error-normalization.js");
  const normalized = normalizeOutputError(error, { origin: "cli" });
  const stderrLine = (error as { stderrLine?: unknown } | null)?.stderrLine;
  if (output === "text") {
    process.stderr.write(`${normalized.message}\n`);
  } else {
    const { createOutputFormatter } = await import("../cli/output/output.js");
    const formatter = createOutputFormatter("json", {
      jsonContext: { sessionId: "unknown" },
      suppressReads: false,
    });
    formatter.onError(normalized);
    formatter.flush();
    // `--json-strict` keeps stderr machine-clean; plain json keeps line 1 for a stderr-only reader.
    if (output === "json" && typeof stderrLine === "string") {
      process.stderr.write(`${stderrLine}\n`);
    }
  }
  return exitCodeForOutputErrorCode(normalized.code);
}

/**
 * TEST SEAMS, honoured ONLY under `node --test` (`NODE_TEST_CONTEXT`): the release layout (`testRuntimeDir`,
 * in `placement.ts`, re-exported here) and the payload directory of a sandbox. ⚠️ DO NOT read
 * either unconditionally — on a box they would redirect what a pod is pinned to and where a prompt's text
 * is written. Held by test/pod-routed-branches.test.ts.
 */
export { testRuntimeDir } from "./placement.js";

export function testPayloadDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.NODE_TEST_CONTEXT ? env.ACPX_POD_TEST_HOME?.trim() : undefined;
  return home ? `${home}/.acpx/routed` : undefined;
}

/**
 * The live `reapPredecessorLease` (ba830305). Only a lease that NAMES A POD is judged here, and only by the
 * existing reaper `readQueueOwnerStatus`: on the control pod a stale heartbeat plus the death proof `gone` removes
 * exactly the judged generation (and records the pod's end on the session); a fresh heartbeat, an `exists` or
 * `unknown` proof, an A-68 lease whose `pod` key names no pod and an A-69 lease acpx cannot parse are all left
 * alone by that judge. A failure here never fails the call — the pod can still do what it can.
 */
async function reapPredecessorLease(sessionId: string): Promise<void> {
  try {
    const leases = await import("../cli/queue/lease-store.js");
    const owner = await leases.readQueueOwnerRecord(sessionId);
    if (owner?.pod === undefined) {
      return;
    }
    await leases.readQueueOwnerStatus(sessionId);
  } catch {
    // best effort: a lease that cannot be judged now is judged by the next call
  }
}

async function liveDeps(): Promise<BranchDeps> {
  const authEnv = await import("../acp/auth-env.js");
  const [
    { createAgentPodLookup },
    routed,
    { resolveTargetRecordId },
    persistence,
    agentCommand,
    admission,
  ] = await Promise.all([
    import("./agent-pod-lookup.js"),
    import("./routed-call.js"),
    import("./target-resolver.js"),
    import("../session/persistence.js"),
    import("../acp/agent-command.js"),
    import("../capacity/admission.js"),
  ]);
  // Atrium finds a routed call's token by its head and the exit code (C2, A-53), so a line before it would
  // not break the reader — the index-rebuild notice, which the record read can print, is still kept off a
  // routed call's stderr so it stays the command's own. `main` sets this flag itself when the call proceeds
  // locally.
  (await import("../session/persistence/index.js")).setSessionIndexRebuildLogSuppressed(true);
  return {
    argv: () => routedArgv(process.argv, process.env),
    env: process.env,
    cwd: () => process.cwd(),
    isTty: () => process.stdin.isTTY,
    readStdin: async () => {
      let data = "";
      for await (const chunk of process.stdin) {
        data += String(chunk);
      }
      return data;
    },
    resolveTarget: (classification) => resolveTargetRecordId(classification.target),
    loadRecord: async (id) => {
      try {
        return await persistence.resolveSessionRecord(id);
      } catch {
        return undefined;
      }
    },
    harnessOf: (command) => agentCommand.acpAdapterKind(command),
    lookup: createAgentPodLookup(process.env),
    leasePodUid: async (sessionId) =>
      (await (await import("../cli/queue/lease-store.js")).readQueueOwnerRecord(sessionId))?.pod
        ?.uid,
    deleteAgent: async (key, uid) => {
      const broker = await import("./broker-client.js");
      const origin = broker.resolveAgentBrokerOrigin(
        process.env,
        broker.readAgentBrokerOriginSources(),
      );
      return origin
        ? await broker.deleteAgent(key, { uid, origin })
        : { kind: "unavailable" as const };
    },
    reapPredecessorLease: reapPredecessorLease,
    releases: () => routed.resolveReleases(testRuntimeDir(process.env)),
    payloadDir: testPayloadDir(process.env),
    sessionUrl: (id) => {
      const base = authEnv.resolveAcpxUiBaseUrl(process.env);
      return base ? `${base}/?session=${encodeURIComponent(id)}` : undefined;
    },
    admissionClass: () => admission.declaredAdmissionClass(),
    run: routed.runRoutedCall,
    fail: failLikeAcpx,
    stderr: (text) => process.stderr.write(text),
  };
}

/** Called by `src/cli.ts` before the placement step; loads nothing heavy. */
export function registerRoutedBranches(): void {
  for (const name of ["routed-ensure", "routed-if-pod"] as const) {
    registerBranchHandler(name, async (decision, context) => {
      const handlers = routedBranchHandlers(await liveDeps());
      return await handlers[name](decision, context);
    });
  }
}
