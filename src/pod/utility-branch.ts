import { randomUUID } from "node:crypto";
import { callerIdentityFrom } from "./caller-identity.js";
import type { Classification, OutputMode } from "./command-classes.js";
import { isClaudePtyCommand } from "./harness-support.js";
import { isHomeOnlyHarness, readBoxFacts, type BoxFacts } from "./home-only.js";
import {
  registerBranchHandler,
  type BranchContext,
  type PlacementDecision,
} from "./placement-step.js";
import {
  failLikeAcpx,
  planPayload,
  PROMPT_REQUIRED_MESSAGE,
  ROUTED_PROGRAM,
  routedArgv,
  testPayloadDir,
  testRuntimeDir,
} from "./routed-branches.js";
import { isRoutedCall, refuseRoutedTwice } from "./routed-twice.js";

// ⚠️ LIGHT GRAPH, like `routed-branches.ts`: no static import (not even a type-only one) of the
// modules that reach acpx's heavy graph — `test/pod-command-classes.test.ts` ("the light graph") counts them.
type RoutedCallOptions = import("./routed-call.js").RoutedCallOptions;
type RoutedCallResult = import("./routed-call.js").RoutedCallResult;
type AgentPodLookup = import("./routed-call.js").AgentPodLookup;
type ResolveReleasesResult = import("./routed-call.js").ResolveReleasesResult;
type UtilityKey = import("./routed-call.js").UtilityKey;

/**
 * A10 — the `utility-pod` branch of A1's placement step: class `one-shot` on the CONTROL pod
 * (CONTRACTS-r4 C1.2, A-7). Four rules, in this order:
 *
 *   1. A command that arrived in a pod already routed is never routed again (`routed_twice`).
 *   2. A probe the records can answer is answered HERE, from them — `"proceed"` runs today's local
 *      handler, which in pod mode reads the newest session record of the harness and never starts a
 *      bridge (`probe-records.ts`). Only `output-styles` and `model-catalogue` have such a form.
 *   3. Everything else a one-shot does — what records cannot answer, `exec`, `flow run`,
 *      `sessions list` without `--local` — is ONE routed call (C2) to the box's utility pod of the
 *      agent's placement (`ag-util-pool`, or `ag-util-home` for Codex and the terminal harness).
 *   4. That is the only start a one-shot has (A-7): the call's target is a utility pod and nothing
 *      else — `routed-call.ts` refuses any other (`UtilityScopeError`, nothing sent, broker not asked).
 *
 * The pod is reached with `placement` fixed to the key's (never `auto`: a probe never waits for a new
 * machine), waits at most the wake bound, and a pod not ready in time is `REFUSED reason=pod_starting`
 * (exit 75) — which a probe shows as "not available right now". The utility pod ends by its own idle loop.
 */

type Branch = PlacementDecision & { kind: "branch" };
type Classified = Classification & { kind: "classified" };

/** The paths that have a record-served form (C1.2 "from records where possible"). */
export const RECORD_SERVED_PATHS: ReadonlySet<string> = new Set([
  "output-styles",
  "model-catalogue",
]);

/**
 * C2: a one-shot's deadline is the caller's own. `--timeout <s>` (acpx's "maximum time to wait for
 * agent response") plus a grace in which acpx's own timeout answers first; without one, a bound per
 * kind of run. Named constants — a probe is a handshake (measured ~3 s), a run is a whole turn.
 */
export const UTILITY_PROBE_DEADLINE_MS = 30_000;
export const UTILITY_RUN_DEADLINE_MS = 15 * 60_000;
export const UTILITY_TIMEOUT_GRACE_MS = 15_000;

// Which harnesses go to the HOME utility pod is `isHomeOnlyHarness` (`home-only.ts`, A-44): codex always, pi
// until P1 is on THIS box — a per-box fact, never an acpx release.

export function utilityKeyFor(
  harness: string | undefined,
  box: BoxFacts = readBoxFacts(),
): UtilityKey {
  return isHomeOnlyHarness(harness, box) ? "util-home" : "util-pool";
}

/** The value of a global flag in an argv, `--flag v` or `--flag=v`, up to the `--` terminator. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const stop = argv.indexOf("--");
  const head = stop >= 0 ? argv.slice(0, stop) : argv;
  for (let i = 0; i < head.length; i += 1) {
    const token = head[i];
    if (token === flag) {
      return head[i + 1];
    }
    if (token.startsWith(`${flag}=`)) {
      return token.slice(flag.length + 1);
    }
  }
  return undefined;
}

export function deadlineMsFor(path: string, argv: readonly string[]): number {
  const seconds = Number(flagValue(argv, "--timeout"));
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000 + UTILITY_TIMEOUT_GRACE_MS;
  }
  return RECORD_SERVED_PATHS.has(path) ? UTILITY_PROBE_DEADLINE_MS : UTILITY_RUN_DEADLINE_MS;
}

export type UtilityDeps = {
  argv: () => string[];
  env: NodeJS.ProcessEnv;
  cwd: () => string;
  isTty: () => boolean;
  readStdin: () => Promise<string>;
  /** The agent command the invocation names (`--agent`, the positional agent, the config's default) — `undefined` when it cannot be resolved. */
  agentCommandOf: (
    classification: Classified,
    argv: readonly string[],
  ) => Promise<string | undefined>;
  harnessOf: (agentCommand: string) => string | undefined;
  /** Whether the newest session record can answer this probe (`probe-records.ts`). */
  recordsCanAnswer: (
    path: string,
    agentCommand: string,
    profile: string | undefined,
  ) => Promise<boolean>;
  lookup: AgentPodLookup;
  releases: () => ResolveReleasesResult;
  payloadDir?: string;
  admissionClass: () => string | undefined;
  run: (options: RoutedCallOptions) => Promise<RoutedCallResult>;
  fail: (error: unknown, output: OutputMode) => Promise<number>;
  stderr: (text: string) => void;
};

async function usageError(message: string, output: OutputMode, deps: UtilityDeps): Promise<number> {
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

/** C1.2 "from records where possible": the probe's answer is on disk — run today's local handler, which reads it. */
async function answerableFromRecords(
  classification: Classified,
  argv: readonly string[],
  agentCommand: string | undefined,
  deps: UtilityDeps,
): Promise<boolean> {
  return (
    RECORD_SERVED_PATHS.has(classification.path) &&
    agentCommand !== undefined &&
    (await deps.recordsCanAnswer(classification.path, agentCommand, flagValue(argv, "--profile")))
  );
}

function utilityCallOptions(
  classification: Classified,
  argv: readonly string[],
  agentCommand: string | undefined,
  plan: Exclude<Awaited<ReturnType<typeof planPayload>>, "prompt_required">,
  deps: UtilityDeps,
): RoutedCallOptions {
  const key = utilityKeyFor(
    agentCommand === undefined ? undefined : deps.harnessOf(agentCommand),
    readBoxFacts(deps.env),
  );
  const admissionClass = deps.admissionClass();
  return {
    class: "one-shot",
    key,
    // A-43: the call is about a Pi AGENT even though its pod is a utility one — `routed-call` then refuses it,
    // named, when `pi` is not in the releases it would send or in the Ready pod it would reach.
    ...(agentCommand !== undefined && deps.harnessOf(agentCommand) === "pi"
      ? { agentIsPi: true }
      : {}),
    // A-10: a utility pod belongs to no session and no seat — the routed call sends neither.
    target: {
      sessionId: "",
      seat: "",
      harness: "utility",
      ...(admissionClass ? { admissionClass } : {}),
    },
    argv: plan
      ? (payloadPath: string | undefined) => [ROUTED_PROGRAM, ...plan.argvFor(payloadPath)]
      : [ROUTED_PROGRAM, ...argv],
    cwd: deps.cwd(),
    env: deps.env,
    lookup: deps.lookup,
    callerIdentity: callerIdentityFrom(deps.env),
    deadlineMs: deadlineMsFor(classification.path, argv),
    releases: deps.releases(),
    ...(plan ? { payload: plan.text } : {}),
    ...(deps.payloadDir ? { payloadDir: deps.payloadDir } : {}),
    callId: randomUUID(),
  };
}

/** The `utility-pod` branch's whole behaviour, over injected dependencies (the tests' seam). */
export async function dispatchUtility(
  decision: Branch,
  context: BranchContext,
  deps: UtilityDeps,
): Promise<number | "proceed"> {
  if (isRoutedCall(deps.env)) {
    return refuseRoutedTwice(decision.classification.output, context.write, context.writeStdout);
  }
  const classification = decision.classification;
  if (classification.kind !== "classified") {
    return await deps.fail(new Error("the utility-pod branch needs a classified command"), "text");
  }
  const argv = deps.argv();
  const agentCommand = await deps.agentCommandOf(classification, argv);
  // A-39: the terminal harness has no pod — neither a utility pod nor a record's answer stands in for one.
  if (isClaudePtyCommand(agentCommand)) {
    const { RoutedCallError } = await import("./pod-refusal.js");
    return await deps.fail(
      new RoutedCallError({
        outcome: "not_run",
        reason: "harness_unsupported",
        callId: randomUUID(),
      }),
      classification.output,
    );
  }
  if (await answerableFromRecords(classification, argv, agentCommand, deps)) {
    return "proceed";
  }
  const plan = await planPayload(classification, argv, deps);
  if (plan === "prompt_required") {
    return await usageError(PROMPT_REQUIRED_MESSAGE, classification.output, deps);
  }
  try {
    const result = await deps.run(
      utilityCallOptions(classification, argv, agentCommand, plan, deps),
    );
    return result.kind === "completed" ? result.exitCode : 1;
  } catch (error) {
    return await deps.fail(error, classification.output);
  }
}

async function liveUtilityDeps(): Promise<UtilityDeps> {
  const [
    { createAgentPodLookup },
    routed,
    agentCommand,
    admission,
    registry,
    records,
    configModule,
  ] = await Promise.all([
    import("./agent-pod-lookup.js"),
    import("./routed-call.js"),
    import("../acp/agent-command.js"),
    import("../capacity/admission.js"),
    import("../agent-registry.js"),
    import("./probe-records.js"),
    import("../cli/config.js"),
  ]);
  // Atrium finds a routed call's token by its head and the exit code (C2, A-53), so a line before it would
  // not break the reader — the index-rebuild notice, which the record read can print, is still kept off a
  // routed call's stderr so it stays the command's own. `main` sets this flag itself when the call proceeds locally.
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
    agentCommandOf: async (classification, argv) => {
      const override = flagValue(argv, "--agent")?.trim();
      if (override) {
        return override;
      }
      configModule.suppressProjectConfigWarningForArgv(argv);
      const config = await configModule.loadResolvedConfig(
        flagValue(argv, "--cwd") ?? process.cwd(),
      );
      return registry.resolveAgentCommand(
        classification.agent ?? config.defaultAgent ?? registry.DEFAULT_AGENT_NAME,
        config.agents,
      );
    },
    harnessOf: (command) => agentCommand.acpAdapterKind(command),
    recordsCanAnswer: async (path, command, profile) =>
      (await records.newestRecordAdvertisement({
        agentCommand: command,
        need: path === "output-styles" ? "config_options" : "available_models",
        ...(profile ? { profile } : {}),
      })) !== undefined,
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
export function registerUtilityBranch(): void {
  registerBranchHandler("utility-pod", async (decision, context) => {
    if (decision.kind !== "branch") {
      return 1;
    }
    return await dispatchUtility(decision, context, await liveUtilityDeps());
  });
}
