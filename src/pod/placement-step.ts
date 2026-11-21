import { classifyArgv, type Classification, type CommandClass } from "./command-classes.js";
import { placeOf, podMode, thisPodFile, type AgentPodFile, type Place } from "./placement.js";

/**
 * C1.2's dispatch, class × place (CONTRACTS-r4 C1.2, brick b479441f). Runs in `src/cli.ts` BEFORE the
 * rest of acpx is imported; light graph only.
 *
 * The branches that later blocks build are named here and REFUSE until they exist — they never fall
 * through to today's local path in pod mode:
 *   routed-ensure      A6 — ensure the pod through the broker (C4), then the routed call (C2)
 *   routed-if-pod      A6 + A5 — routed call if the pod exists (C3.3); else answered from the record
 *   record-setting     the seam for "a setting on a session without a pod is a record write" (C1.2);
 *                      reached from routed-if-pod's "no pod" answer, never directly from a class
 *   record-only-create A2 — every create form writes a record and nothing else (C1.3)
 *   pass-through       A3 — POST /api/acpx/call on the control pod (C6.2)
 *   message-route      A3 — a prompt for another session goes to atrium's message routes
 *   utility-pod        a one-shot run that cannot be answered from records (K2): the utility pod
 *
 * ⚠️ ONLY `routed-ensure` MAY EVER ASK THE BROKER FOR A POD (C1.2 fixed consequence) — and it is
 * reached only from class `owner-ensure`. Held by `test/pod-placement-step.test.ts`.
 */
export type PodBranch =
  | "routed-ensure"
  | "routed-if-pod"
  | "record-setting"
  | "record-only-create"
  | "pass-through"
  | "message-route"
  | "utility-pod";

/** The branch that may start a pod. One, by construction of the type. */
export const POD_STARTING_BRANCH: PodBranch = "routed-ensure";

/** Which later block builds each branch — printed in the refusal so an operator knows why. */
export const BRANCH_OWNER: Readonly<Record<PodBranch, string>> = {
  "routed-ensure": "A6",
  "routed-if-pod": "A6",
  "record-setting": "A6",
  "record-only-create": "A2",
  "pass-through": "A3",
  "message-route": "A3",
  "utility-pod": "K2-utility-pod",
};

export type Route = { kind: "local" } | { kind: "branch"; branch: PodBranch };

const LOCAL: Route = { kind: "local" };
const branch = (b: PodBranch): Route => ({ kind: "branch", branch: b });

/**
 * C1.2's table, cell for cell, as data. `one-shot` on the control pod is `utility-pod` unless the
 * invocation is its from-records form (`routeFor`'s `fromRecords`).
 */
export const ROUTE_TABLE: Readonly<Record<CommandClass, Readonly<Record<Place, Route>>>> = {
  read: { control: LOCAL, "own-pod": LOCAL, "other-pod": LOCAL },
  record: { control: LOCAL, "own-pod": LOCAL, "other-pod": branch("pass-through") },
  create: {
    control: branch("record-only-create"),
    "own-pod": branch("pass-through"),
    "other-pod": branch("pass-through"),
  },
  "control-store": {
    control: LOCAL,
    "own-pod": branch("pass-through"),
    "other-pod": branch("pass-through"),
  },
  "owner-ensure": {
    control: branch("routed-ensure"),
    "own-pod": LOCAL,
    "other-pod": branch("message-route"),
  },
  "owner-if-pod": {
    control: branch("routed-if-pod"),
    "own-pod": LOCAL,
    "other-pod": branch("pass-through"),
  },
  "one-shot": { control: branch("utility-pod"), "own-pod": LOCAL, "other-pod": LOCAL },
  local: { control: LOCAL, "own-pod": LOCAL, "other-pod": LOCAL },
};

export function routeFor(cls: CommandClass, place: Place, fromRecords = false): Route {
  return cls === "one-shot" && fromRecords ? LOCAL : ROUTE_TABLE[cls][place];
}

/** Classes whose route depends on WHICH session the command is about (in an agent pod). */
export function routeDependsOnTarget(cls: CommandClass): boolean {
  return cls === "record" || cls === "owner-ensure" || cls === "owner-if-pod";
}

export type PlacementDecision =
  /** Pod mode not honoured: today's behaviour, byte-identical. */
  | { kind: "off" }
  | { kind: "local"; classification: Classification; place: Place }
  | { kind: "branch"; branch: PodBranch; classification: Classification; place: Place }
  | { kind: "refuse-unclassified"; path: string }
  | { kind: "refuse-pod-identity" }
  | { kind: "refuse-seam-sandbox" }
  | { kind: "refuse-control-pod-only"; path: string }
  /** An agent pod, a target-dependent class: the session must be resolved before deciding. */
  | { kind: "resolve-target"; classification: Classification & { kind: "classified" } };

/**
 * The placement step's pure core: verdict + pod file + argv → decision. `--help` runs nothing, so
 * it is `local` whatever the class.
 */
export function decidePlacement(params: {
  argv: readonly string[];
  verdict: ReturnType<typeof podMode>;
  podFile: AgentPodFile;
  builtInAgents: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** The resolved record id of the session the command is about, when already known. */
  resolvedTarget?: string | null;
}): PlacementDecision {
  if (params.verdict.mode === "off") {
    return { kind: "off" };
  }
  const classification = classifyArgv(params.argv, {
    builtInAgents: params.builtInAgents,
    env: params.env,
  });
  if (params.verdict.mode === "refuse") {
    return params.verdict.reason === "pod_identity_missing"
      ? decideWithoutIdentity(classification)
      : { kind: "refuse-seam-sandbox" };
  }
  if (classification.kind === "unclassified") {
    return { kind: "refuse-unclassified", path: classification.path };
  }
  return decideClassified(classification, params.podFile, params.resolvedTarget);
}

/**
 * `pod_identity_missing`: fail-closed, neither mode — except class `local` and a help request
 * (which runs nothing), so an operator can still diagnose (C1.1 amendment, 2026-11-21).
 */
function decideWithoutIdentity(classification: Classification): PlacementDecision {
  const diagnosable =
    classification.kind === "classified" &&
    (classification.class === "local" || classification.help);
  return diagnosable
    ? { kind: "local", classification, place: "control" }
    : { kind: "refuse-pod-identity" };
}

/** Help runs nothing; control-pod maintenance refuses in an agent pod (A-7). */
function earlyDecision(
  classification: Classification & { kind: "classified" },
  podFile: AgentPodFile,
): PlacementDecision | undefined {
  if (classification.help) {
    return { kind: "local", classification, place: placeOf(podFile, undefined) };
  }
  return classification.entry.controlPodOnly && podFile.kind !== "absent"
    ? { kind: "refuse-control-pod-only", path: classification.path }
    : undefined;
}

function decideClassified(
  classification: Classification & { kind: "classified" },
  podFile: AgentPodFile,
  resolvedTarget: string | null | undefined,
): PlacementDecision {
  const early = earlyDecision(classification, podFile);
  if (early) {
    return early;
  }
  const needsTarget = podFile.kind !== "absent" && routeDependsOnTarget(classification.class);
  if (needsTarget && resolvedTarget === undefined) {
    return { kind: "resolve-target", classification };
  }
  const place = placeOf(podFile, resolvedTarget ?? undefined);
  const route = routeFor(classification.class, place, classification.fromRecords);
  return route.kind === "local"
    ? { kind: "local", classification, place }
    : { kind: "branch", branch: route.branch, classification, place };
}

/** Exit code and stderr of a refusal, in the C7.2 wire format. */
export type Refusal = { exitCode: number; lines: [string, string] };

/** C7.2: the guards that fail closed exit 2 — none is a hold reason. */
export const UNCLASSIFIED_EXIT_CODE = 2;
export const POD_IDENTITY_EXIT_CODE = 2;
export const CONTROL_POD_ONLY_EXIT_CODE = 2;
/** A branch a later block builds: 2, like `unclassified_command` — a usage-level refusal. */
export const UNBUILT_BRANCH_EXIT_CODE = 2;

const POD_IDENTITY_REFUSAL: Refusal = {
  exitCode: POD_IDENTITY_EXIT_CODE,
  lines: [
    "acpx: REFUSED reason=pod_identity_missing",
    "ACPX_OWNER_PLACEMENT=pod is set on this control-role host but the pod identity (NV_POD_NAME, NV_POD_UID, NV_NODE_NAME, the service-account namespace) is incomplete; acpx refuses rather than run in either mode.",
  ],
};

const SEAM_SANDBOX_REFUSAL: Refusal = {
  exitCode: UNCLASSIFIED_EXIT_CODE,
  lines: [
    "acpx: REFUSED reason=test_seam_outside_sandbox",
    "ACPX_POD_TEST_HOME is set but the state home in use is outside it; the test seam leads only into its sandbox.",
  ],
};

function branchRefusal(decision: PlacementDecision & { kind: "branch" }): Refusal {
  const c = decision.classification;
  const path = c.kind === "classified" ? c.path : "";
  const cls = c.kind === "classified" ? c.class : "unclassified";
  return {
    exitCode: UNBUILT_BRANCH_EXIT_CODE,
    lines: [
      `acpx: REFUSED reason=pod_branch_unbuilt nothing_started=true protocol=1 branch=${decision.branch} class=${cls} place=${decision.place} path=${path === "" ? "-" : path.replaceAll(" ", ".")}`,
      `In pod mode this command takes the ${decision.branch} branch, which is not built yet (block ${BRANCH_OWNER[decision.branch]}); nothing was started.`,
    ],
  };
}

export function refusalFor(decision: PlacementDecision): Refusal | undefined {
  switch (decision.kind) {
    case "refuse-unclassified":
      return {
        exitCode: UNCLASSIFIED_EXIT_CODE,
        lines: [
          "acpx: REFUSED reason=unclassified_command",
          `The command \`${decision.path}\` has no class in acpx's command table, so it does not run in pod mode.`,
        ],
      };
    case "refuse-control-pod-only":
      return {
        exitCode: CONTROL_POD_ONLY_EXIT_CODE,
        lines: [
          "acpx: REFUSED reason=control_pod_only",
          `\`${decision.path}\` is control-pod maintenance and does not run in an agent pod.`,
        ],
      };
    case "refuse-pod-identity":
      return POD_IDENTITY_REFUSAL;
    case "refuse-seam-sandbox":
      return SEAM_SANDBOX_REFUSAL;
    case "branch":
      return branchRefusal(decision);
    default:
      return undefined;
  }
}

/**
 * The branch implementations later blocks plug in. Until a block registers its branch, the branch
 * refuses with `pod_branch_unbuilt`. A handler returns the process exit code, or `"proceed"` to run the command locally.
 */
export type BranchHandler = (
  decision: PlacementDecision & { kind: "branch" },
) => Promise<number | "proceed">;

const branchHandlers = new Map<PodBranch, BranchHandler>();

export function registerBranchHandler(name: PodBranch, handler: BranchHandler): void {
  branchHandlers.set(name, handler);
}

export function branchHandler(name: PodBranch): BranchHandler | undefined {
  return branchHandlers.get(name);
}

/** Resolves a target selector to a record id, or null when it names no session. */
export type TargetResolver = (
  classification: Classification & { kind: "classified" },
) => Promise<string | null>;

/**
 * The live placement step, called by `src/cli.ts` with the argv after `node acpx`. Returns
 * `proceed` when acpx should run as today, or the exit code it already handled the command with.
 * `loadTargetResolver` is called only in an agent pod for a target-dependent class — it loads
 * acpx's own session resolver, i.e. the heavy graph, which the control pod never pays for here.
 */
export async function runPlacementStep(params: {
  argv: readonly string[];
  builtInAgents: () => readonly string[];
  loadTargetResolver: () => Promise<TargetResolver>;
  write: (line: string) => void;
}): Promise<"proceed" | { exitCode: number }> {
  const verdict = podMode();
  if (verdict.mode === "off") {
    return "proceed";
  }
  const base = {
    argv: params.argv,
    verdict,
    podFile: thisPodFile(),
    builtInAgents: params.builtInAgents(),
  };
  let decision = decidePlacement(base);
  if (decision.kind === "resolve-target") {
    const resolve = await params.loadTargetResolver();
    decision = decidePlacement({
      ...base,
      resolvedTarget: await resolve(decision.classification),
    });
  }
  return await act(decision, params.write);
}

/** A registered handler's outcome: `"proceed"` (A6, C1.2 "answered from the record") runs today's local path. */
async function runHandler(
  decision: PlacementDecision & { kind: "branch" },
  handler: BranchHandler,
): Promise<"proceed" | { exitCode: number }> {
  const outcome = await handler(decision);
  return outcome === "proceed" ? "proceed" : { exitCode: outcome };
}

async function act(
  decision: PlacementDecision,
  write: (line: string) => void,
): Promise<"proceed" | { exitCode: number }> {
  if (decision.kind === "local" || decision.kind === "off") {
    return "proceed";
  }
  const handler = decision.kind === "branch" ? branchHandler(decision.branch) : undefined;
  if (handler && decision.kind === "branch") {
    return await runHandler(decision, handler);
  }
  // A decision with no refusal is unreachable by the type; fail closed rather than proceed.
  const refusal = refusalFor(decision) ?? {
    exitCode: UNCLASSIFIED_EXIT_CODE,
    lines: ["acpx: REFUSED reason=unclassified_command", "No placement decision."],
  };
  for (const line of refusal.lines) {
    write(line);
  }
  return { exitCode: refusal.exitCode };
}
