import {
  classifyArgv,
  type Classification,
  type CommandClass,
  type OutputMode,
} from "./command-classes.js";
import { ownTargetRecordId } from "./own-target.js";
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
 *   utility-pod        a one-shot run (A10): from records where possible, else the box's utility pod (A-7)
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
  "utility-pod": "A10",
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

type DecisionCore =
  | { kind: "local"; classification: Classification; place: Place }
  | { kind: "branch"; branch: PodBranch; classification: Classification; place: Place }
  | { kind: "refuse-unclassified"; path: string }
  | { kind: "refuse-pod-identity" }
  | { kind: "refuse-pod-place" }
  | { kind: "refuse-seam-sandbox" }
  | { kind: "refuse-control-pod-only"; path: string };

export type PlacementDecision =
  /** Pod mode not honoured: today's behaviour, byte-identical. */
  | { kind: "off" }
  /** `output`: how the command prints — a refusal carries the same in JSON mode (C7.2, F3). */
  | (DecisionCore & { output: OutputMode });

/**
 * In an agent pod, the record id of the session the command is about IF it is this pod's session,
 * else null. Called only where the route depends on it, after everything else is decided (F2).
 */
export type OwnTarget = (classification: Classification & { kind: "classified" }) => string | null;

/**
 * The placement step's pure core: verdict + pod file + argv → decision. `--help` runs nothing, so
 * it is `local` whatever the class.
 */
export function decidePlacement(params: {
  argv: readonly string[];
  verdict: ReturnType<typeof podMode>;
  podFile: AgentPodFile;
  builtInAgents: readonly string[];
  /** Absent: no session counts as this pod's own (the safe side: pass-through). */
  ownTarget?: OwnTarget;
}): PlacementDecision {
  if (params.verdict.mode === "off") {
    return { kind: "off" };
  }
  const classification = classifyArgv(params.argv, { builtInAgents: params.builtInAgents });
  const output = classification.output;
  // ⚠️ ORDER (D1, TE2 round 4): a missing place file under `ag-…` is named BEFORE a missing identity.
  // With both missing the operator must be pointed at the place mount (the contract table's
  // `pod_place_missing`), not at the identity. Both refuse, exit 2, nothing written — only the
  // reason differs. The seam-sandbox refusal stays first: it is a test guard, not a diagnosis. Pinned
  // by `test/pod-placement-facts.test.ts` "D1: …" (each order of the two missing pieces).
  if (params.verdict.mode === "refuse" && params.verdict.reason === "test_seam_outside_sandbox") {
    return { kind: "refuse-seam-sandbox", output };
  }
  if (params.podFile.kind === "place-missing") {
    return { ...decideWithoutPlace(classification), output };
  }
  if (params.verdict.mode === "refuse") {
    return { ...decideWithoutIdentity(classification), output };
  }
  if (classification.kind === "unclassified") {
    return { kind: "refuse-unclassified", path: classification.path, output };
  }
  return { ...decideClassified(classification, params.podFile, params.ownTarget), output };
}

/**
 * `pod_identity_missing`: fail-closed, neither mode — except class `local` and a help request
 * (which runs nothing), so an operator can still diagnose (C1.1 amendment, 2026-11-21).
 */
function decideWithoutIdentity(classification: Classification): DecisionCore {
  const diagnosable =
    classification.kind === "classified" &&
    (classification.class === "local" || classification.help);
  return diagnosable
    ? { kind: "local", classification, place: "control" }
    : { kind: "refuse-pod-identity" };
}

/**
 * `pod_place_missing` (A-28): the kernel hostname says agent pod and the place file is missing,
 * empty or unreadable — an agent pod that cannot say WHICH. Every command that is not class `local`
 * refuses (never local mode, never the control pod's place); class `local` and a help request run,
 * as for the identity refusal, so an operator can still diagnose.
 */
function decideWithoutPlace(classification: Classification): DecisionCore {
  const diagnosable =
    classification.kind === "classified" &&
    (classification.class === "local" || classification.help);
  return diagnosable
    ? { kind: "local", classification, place: "other-pod" }
    : { kind: "refuse-pod-place" };
}

/** Help runs nothing; control-pod maintenance refuses in an agent pod (A-7). */
function earlyDecision(
  classification: Classification & { kind: "classified" },
  podFile: AgentPodFile,
): DecisionCore | undefined {
  if (classification.help) {
    return { kind: "local", classification, place: placeOf(podFile, undefined) };
  }
  return classification.controlPodOnly && podFile.kind !== "absent"
    ? { kind: "refuse-control-pod-only", path: classification.path }
    : undefined;
}

function decideClassified(
  classification: Classification & { kind: "classified" },
  podFile: AgentPodFile,
  ownTarget: OwnTarget | undefined,
): DecisionCore {
  const early = earlyDecision(classification, podFile);
  if (early) {
    return early;
  }
  // F2: the target is looked at LAST, and only where the route depends on it.
  const needsTarget = podFile.kind !== "absent" && routeDependsOnTarget(classification.class);
  const target = needsTarget ? (ownTarget?.(classification) ?? undefined) : undefined;
  const place = placeOf(podFile, target);
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
export const POD_PLACE_EXIT_CODE = 2;
/** A branch a later block builds: 2, like `unclassified_command` — a usage-level refusal. */
export const UNBUILT_BRANCH_EXIT_CODE = 2;

const POD_IDENTITY_REFUSAL: Refusal = {
  exitCode: POD_IDENTITY_EXIT_CODE,
  lines: [
    "acpx: REFUSED reason=pod_identity_missing",
    "ACPX_OWNER_PLACEMENT=pod is set on this control-role host but the pod identity (NV_POD_NAME, NV_POD_UID, NV_NODE_NAME, the service-account namespace) is incomplete; acpx refuses rather than run in either mode.",
  ],
};

const POD_PLACE_REFUSAL: Refusal = {
  exitCode: POD_PLACE_EXIT_CODE,
  lines: [
    "acpx: REFUSED reason=pod_place_missing",
    "This host's kernel hostname says it is an agent pod (ag-…) but its place file (/home/node/.nv-agent) is missing, empty or unreadable, so acpx cannot say which pod it is; it refuses rather than run in either mode.",
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
    case "refuse-pod-place":
      return POD_PLACE_REFUSAL;
    case "refuse-seam-sandbox":
      return SEAM_SANDBOX_REFUSAL;
    case "branch":
      return branchRefusal(decision);
    default:
      return undefined;
  }
}

/**
 * C7.2 "JSON mode carries the same in `error.data`" (F3): the JSON-RPC error object acpx's json
 * formatter writes (`buildJsonRpcErrorResponse`, `src/acp/jsonrpc-error.ts`; exit 2 is `USAGE`,
 * code -32602), built here because that formatter is the heavy graph. `error.data` carries the
 * token line and every `key=value` of it (`reason`, `branch`, `nothing_started`, …).
 */
export function refusalJson(refusal: Refusal): string {
  const tokenLine = refusal.lines[0];
  const fields: Record<string, string | number | boolean> = {};
  for (const pair of tokenLine.replace(/^acpx: REFUSED /u, "").split(" ")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const raw = pair.slice(eq + 1);
      fields[pair.slice(0, eq)] = raw === "true" ? true : /^\d+$/u.test(raw) ? Number(raw) : raw;
    }
  }
  const reason = String(fields.reason ?? "");
  return JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32602,
      message: refusal.lines.join("\n"),
      data: {
        acpxCode: "USAGE",
        detailCode: reason.replaceAll("_", "-"),
        origin: "cli",
        retryable: false,
        tokenLine,
        ...fields,
      },
    },
  });
}

/**
 * The branch implementations later blocks plug in. Until a block registers its branch, the branch
 * refuses with `pod_branch_unbuilt`. A handler returns the process exit code, or `"proceed"` to run the command locally.
 */
export type BranchHandler = (
  decision: PlacementDecision & { kind: "branch" },
  context: BranchContext,
) => Promise<number | "proceed">;

/**
 * What a branch handler is handed beyond the decision (brick 7eb9686f): the argv the decision was
 * made on — the pass-through forwards acpx's arguments verbatim (C6.2) — and the same line writers
 * the refusals use.
 */
export type BranchContext = {
  argv: readonly string[];
  write: (line: string) => void;
  writeStdout: (line: string) => void;
};

const branchHandlers = new Map<PodBranch, BranchHandler>();

export function registerBranchHandler(name: PodBranch, handler: BranchHandler): void {
  branchHandlers.set(name, handler);
}

export function branchHandler(name: PodBranch): BranchHandler | undefined {
  return branchHandlers.get(name);
}

/**
 * The live placement step, called by `src/cli.ts` with the argv after `node acpx`. Returns
 * `proceed` when acpx should run as today, or the exit code it already handled the command with.
 * Nothing here loads the heavy graph or writes a file: in an agent pod the own-session check reads
 * `seats.json` / `index.json` silently (`own-target.ts`, F2).
 */
export async function runPlacementStep(params: {
  argv: readonly string[];
  builtInAgents: () => readonly string[];
  write: (line: string) => void;
  writeStdout?: (line: string) => void;
}): Promise<"proceed" | { exitCode: number }> {
  const verdict = podMode();
  if (verdict.mode === "off") {
    return "proceed";
  }
  const podFile = thisPodFile();
  const decision = decidePlacement({
    argv: params.argv,
    verdict,
    podFile,
    builtInAgents: params.builtInAgents(),
    ownTarget: (c) =>
      podFile.kind === "pod"
        ? ownTargetRecordId(c.target, podFile.name, undefined, {
            path: c.path,
            conflict: c.targetConflict,
          })
        : null,
  });
  return await act(decision, params.argv, params.write, params.writeStdout ?? params.write);
}

/** A registered handler's outcome: `"proceed"` (A6, C1.2 "answered from the record") runs today's local path. */
async function runHandler(
  decision: PlacementDecision & { kind: "branch" },
  handler: BranchHandler,
  context: BranchContext,
): Promise<"proceed" | { exitCode: number }> {
  const outcome = await handler(decision, context);
  return outcome === "proceed" ? "proceed" : { exitCode: outcome };
}

async function act(
  decision: PlacementDecision,
  argv: readonly string[],
  write: (line: string) => void,
  writeStdout: (line: string) => void,
): Promise<"proceed" | { exitCode: number }> {
  if (decision.kind === "local" || decision.kind === "off") {
    return "proceed";
  }
  const handler = decision.kind === "branch" ? branchHandler(decision.branch) : undefined;
  if (handler && decision.kind === "branch") {
    return await runHandler(decision, handler, { argv, write, writeStdout });
  }
  // A decision with no refusal is unreachable by the type; fail closed rather than proceed.
  const refusal = refusalFor(decision) ?? {
    exitCode: UNCLASSIFIED_EXIT_CODE,
    lines: ["acpx: REFUSED reason=unclassified_command", "No placement decision."] as [
      string,
      string,
    ],
  };
  emitRefusal(refusal, decision.output, write, writeStdout);
  return { exitCode: refusal.exitCode };
}

/**
 * Text: both lines on stderr. JSON: the error object on stdout AND line 1 on stderr for a
 * stderr-only reader (as CapacityRefusedError does). `--json-strict`: machine-clean stderr.
 */
function emitRefusal(
  refusal: Refusal,
  output: OutputMode,
  write: (line: string) => void,
  writeStdout: (line: string) => void,
): void {
  if (output !== "text") {
    writeStdout(refusalJson(refusal));
  }
  const stderr = output === "text" ? refusal.lines : output === "json" ? [refusal.lines[0]] : [];
  for (const line of stderr) {
    write(line);
  }
}
