import { randomUUID } from "node:crypto";
import type { Classification } from "./command-classes.js";
import {
  registerBranchHandler,
  type BranchHandler,
  type PlacementDecision,
} from "./placement-step.js";

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
  name?: string;
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
  releases: () => ResolveReleasesResult;
  /** Where payload files go; absent = the production directory. A test seam, see `liveDeps`. */
  payloadDir?: string;
  admissionClass: () => string | undefined;
  run: (options: RoutedCallOptions) => Promise<RoutedCallResult>;
  /** Prints a failure the way acpx prints one, and returns the exit code. */
  fail: (error: unknown, argv: string[]) => Promise<number>;
  stderr: (text: string) => void;
};

const PROMPT_PATHS = new Set(["", "<agent>", "prompt"]);
const HARNESSES: ReadonlySet<string> = new Set(["claude", "pi", "codex", "claude-pty"]);

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
  if (hasFileFlag(argv) || classification.operandCount > 0) {
    return undefined;
  }
  if (deps.isTty()) {
    return "prompt_required";
  }
  return { text: await deps.readStdin(), argvFor: (p) => appendFileFlag(argv, p) };
}

function sessionTarget(record: RoutedRecord, deps: BranchDeps) {
  const admissionClass = deps.admissionClass();
  return {
    sessionId: record.acpxRecordId,
    seat: record.seatId ?? record.acpxRecordId,
    harness: deps.harnessOf(record.agentCommand) as AgentHarness,
    ...(admissionClass ? { admissionClass } : {}),
    ...(record.name ? { sessionName: record.name } : {}),
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
async function notRun(reason: string, argv: string[], deps: BranchDeps): Promise<number> {
  const { RoutedCallError } = await import("./pod-refusal.js");
  return await deps.fail(
    new RoutedCallError({ outcome: "not_run", reason, callId: randomUUID() }),
    argv,
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
    return await notRun("target_unresolved", argv, deps);
  }
  const harness = deps.harnessOf(record.agentCommand);
  if (routedClass === "owner-ensure" && (harness === undefined || !HARNESSES.has(harness))) {
    return await notRun("harness_unsupported", argv, deps);
  }
  return { record, classification, argv };
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
    argv: plan ? plan.argvFor : ready.argv,
    cwd: deps.cwd(),
    env: deps.env,
    lookup: deps.lookup,
    ...(plan ? { payload: plan.text } : {}),
    ...(deps.payloadDir ? { payloadDir: deps.payloadDir } : {}),
    ...(routedClass === "owner-ensure" ? { releases: deps.releases() } : {}),
  };
}

async function dispatchRouted(
  decision: Branch,
  deps: BranchDeps,
  routedClass: "owner-ensure" | "owner-if-pod",
): Promise<number | "proceed"> {
  const ready = await readyOrFail(decision, deps, routedClass);
  if (typeof ready === "number") {
    return ready;
  }
  const plan =
    routedClass === "owner-ensure"
      ? await planPayload(ready.classification, ready.argv, deps)
      : undefined;
  if (plan === "prompt_required") {
    deps.stderr(`${PROMPT_REQUIRED_MESSAGE}\n`);
    return 2;
  }
  const { agentPodKey } = await import("./routed-call.js");
  try {
    const result = await deps.run(
      runOptions(ready, plan, deps, routedClass, agentPodKey(ready.record.acpxRecordId)),
    );
    return result.kind === "no_pod" ? "proceed" : result.exitCode;
  } catch (error) {
    return await deps.fail(error, ready.argv);
  }
}

export function routedBranchHandlers(
  deps: BranchDeps,
): Record<"routed-ensure" | "routed-if-pod", BranchHandler> {
  return {
    "routed-ensure": async (decision) => await dispatchRouted(decision, deps, "owner-ensure"),
    "routed-if-pod": async (decision) => await dispatchRouted(decision, deps, "owner-if-pod"),
  };
}

function wantsJson(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      return false;
    }
    if (
      token === "--json-strict" ||
      token.startsWith("--json-strict=") ||
      token === "--format=json"
    ) {
      return true;
    }
    if (token === "--format" && argv[i + 1] === "json") {
      return true;
    }
  }
  return false;
}

async function failLikeAcpx(error: unknown, argv: string[]): Promise<number> {
  const { normalizeOutputError, exitCodeForOutputErrorCode } =
    await import("../acp/error-normalization.js");
  const normalized = normalizeOutputError(error, { origin: "cli" });
  const stderrLine = (error as { stderrLine?: unknown } | null)?.stderrLine;
  if (wantsJson(argv)) {
    const { createOutputFormatter } = await import("../cli/output/output.js");
    const formatter = createOutputFormatter("json", {
      jsonContext: { sessionId: "unknown" },
      suppressReads: false,
    });
    formatter.onError(normalized);
    formatter.flush();
    if (typeof stderrLine === "string") {
      process.stderr.write(`${stderrLine}\n`);
    }
  } else {
    process.stderr.write(`${normalized.message}\n`);
  }
  return exitCodeForOutputErrorCode(normalized.code);
}

/**
 * TEST SEAMS, honoured ONLY under `node --test` (`NODE_TEST_CONTEXT`, the precedent of
 * `ACPX_OS_COMPAT_LINK` / `ACPX_POD_TEST_HOME`): the release layout and the payload directory of a
 * sandbox. ⚠️ DO NOT read either unconditionally — on a box they would redirect what a pod is pinned
 * to and where a prompt's text is written. Held by test/pod-routed-branches.test.ts.
 */
function testRuntimeDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.NODE_TEST_CONTEXT ? env.ACPX_TEST_RUNTIME_DIR?.trim() || undefined : undefined;
}

function testPayloadDir(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.NODE_TEST_CONTEXT ? env.ACPX_POD_TEST_HOME?.trim() : undefined;
  return home ? `${home}/.acpx/routed` : undefined;
}

async function liveDeps(): Promise<BranchDeps> {
  const [
    { createAgentPodLookup },
    routed,
    { targetResolver },
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
  // The first stderr line of a routed call is atrium's to read (C2): the index-rebuild notice must not
  // precede it. `main` sets this flag itself when the call proceeds locally.
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
    resolveTarget: targetResolver,
    loadRecord: async (id) => {
      try {
        return await persistence.resolveSessionRecord(id);
      } catch {
        return undefined;
      }
    },
    harnessOf: (command) => agentCommand.acpAdapterKind(command),
    lookup: createAgentPodLookup(process.env),
    releases: () => routed.resolveReleases(testRuntimeDir(process.env)),
    payloadDir: testPayloadDir(process.env),
    admissionClass: () => admission.declaredAdmissionClass(),
    run: routed.runRoutedCall,
    fail: failLikeAcpx,
    stderr: (text) => process.stderr.write(text),
  };
}

/** Called by `src/cli.ts` before the placement step; loads nothing heavy. */
export function registerRoutedBranches(): void {
  for (const name of ["routed-ensure", "routed-if-pod"] as const) {
    registerBranchHandler(name, async (decision) => {
      const handlers = routedBranchHandlers(await liveDeps());
      return await handlers[name](decision);
    });
  }
}
