import os from "node:os";
import path from "node:path";
import { isControlPod } from "../config/control-pod.js";
import { AcpxOperationalError } from "../errors.js";
import { PodIdentityMissingError } from "../session/persistence/identity-file-lock.js";
import { CALLER_IDENTITY_VARS } from "./caller-identity.js";
import {
  lockHostPlace,
  lockPodIdentity,
  podTestHome,
  type PodIdentity,
  type PodRef,
} from "./identity.js";
import {
  placeOf,
  podFactValue,
  podModeVerdictNow,
  readPodFileWithWitness,
  sessionKey,
  type HostFacts,
} from "./placement.js";

/**
 * Block A4 — one owner, bound to its pod (CONTRACTS-r4 C3.1, C2 "What the owner inherits", C7.2
 * `owner_outside_pod`, A-16, A-25). The pieces that decide WHERE an owner may run, WHAT its lease
 * names, and WHAT it inherits live here; the lease file itself stays in `cli/queue/lease-store.ts`.
 *
 * ⚠️ NO BYPASS FLAG anywhere in this file (the owner-entry guard is one of the two places where pod
 * mode fails closed). Test seams are the existing ones — `ACPX_POD_TEST_HOME`, `ACPX_POD_TEST_HOSTNAME`,
 * `NV_POD_*` — and are honoured only under an explicit seam, never under `NODE_TEST_CONTEXT` alone.
 */

/** The C2 version this pod's acpx speaks. Pinned equal to `ROUTED_CONTRACT_VERSION` by a test. */
export const LEASE_ROUTED_CONTRACT = 1;
/** C3.1: the owner's socket in every agent pod — outside the shared `q/` directory. */
export const POD_SOCKET_DIR = "/run/acpx/q";
export const OWNER_OUTSIDE_POD_REASON = "owner_outside_pod";
export const OWNER_OUTSIDE_POD_EXIT_CODE = 2;

function hostFacts(env: NodeJS.ProcessEnv): HostFacts {
  return { env, controlRole: isControlPod(env), homedir: os.homedir() };
}

const OWNER_ENTRY_SENTENCE =
  "In pod mode a session's owner runs only in that session's own agent pod; this process is not it, so no lease was taken and nothing was started.";

/**
 * C7.2 `acpx: REFUSED reason=owner_outside_pod session=<record id>` (exit 2): the owner entry was
 * started anywhere but in the session's own pod. A guard that fails closed — not a hold reason.
 * (C7.2, clarified 2026-11-25) Also what a flow's direct send meets in an agent pod that does not hold the session's
 * lease (`direct-send-guard.ts`): the refusal line is the same; the sentence after it names the holder.
 */
export class OwnerOutsidePodError extends AcpxOperationalError {
  readonly stderrLine: string;
  readonly exitCode = OWNER_OUTSIDE_POD_EXIT_CODE;
  readonly sessionId: string;
  constructor(sessionId: string, sentence: string = OWNER_ENTRY_SENTENCE) {
    const line = `acpx: REFUSED reason=${OWNER_OUTSIDE_POD_REASON} session=${sessionId}`;
    // ⚠️ `outputCode: "USAGE"` IS WHAT MAKES THE CLI EXIT 2 (brick 59070d68, TE F-1): the top-level handler maps a
    // thrown error through `normalizeOutputError` → `exitCodeForOutputErrorCode`, and an error that carries no code
    // is RUNTIME → exit 1 — `exitCode` above is read only by the `__queue-owner` entry. The same pair
    // (`USAGE` + a detail code, origin `cli`) is how `pod_foreign_write` and the other exit-2 refusals are shaped.
    // `test/pod-5907-flow-cli.test.ts` (the shipped `flow run`, text and json) goes red if it is dropped.
    super(`${line}\n${sentence}`, {
      outputCode: "USAGE",
      detailCode: OWNER_OUTSIDE_POD_REASON,
      origin: "cli",
    });
    this.stderrLine = line;
    this.sessionId = sessionId;
  }
}

/**
 * The OWNER-ENTRY GUARD (C1.1 / K4): called first thing by the one owner entry
 * (`runSessionQueueOwner`), so no code path that reaches an owner — a routed call, a rig, a hand-run
 * `__queue-owner` — can own a session outside its pod. In pod mode (or whenever this host is an agent
 * pod, by either witness) the owner may run only where the place file names `ag-<this session's
 * key>`; the control pod, another session's pod and a utility pod refuse. Outside pod mode and
 * outside an agent pod nothing changes — a box that never switched is byte-identical.
 */
export function assertOwnerEntryInOwnPod(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const place = lockHostPlace(env);
  const podMode = podModeVerdictNow(env).mode !== "off";
  if (!podMode && place !== "agent-pod") {
    return;
  }
  if (place === "agent-pod" && placeOf(readPodFileWithWitness(env), sessionId) === "own-pod") {
    return;
  }
  throw new OwnerOutsidePodError(sessionId);
}

/** The pod fields a lease carries (C3.1). `pod` is never absent in an agent pod (A-25). */
export type LeasePodFields = {
  pod: PodIdentity;
  placement?: "pool" | "home";
  routedContract: number;
  acpxRelease?: string;
};

function placementOf(env: NodeJS.ProcessEnv): "pool" | "home" | undefined {
  const value = podFactValue("NV_AGENT_PLACEMENT", hostFacts(env))?.trim();
  return value === "pool" || value === "home" ? value : undefined;
}

/**
 * The placement of THIS process's pod — `pool` or `home` — or undefined anywhere that is not an agent
 * pod (the control pod, a workbench, a rig) and in an agent pod that does not say (`NV_AGENT_PLACEMENT`
 * unset or not one of the two). The same fact the lease carries (`leasePodFields`), read without its
 * identity throw: the person keep (order 1) asks only "am I in a POOL pod?" and a pod that cannot
 * answer is not one, so it keeps today's behaviour.
 */
export function ownPodPlacement(env: NodeJS.ProcessEnv = process.env): "pool" | "home" | undefined {
  return lockHostPlace(env) === "agent-pod" ? placementOf(env) : undefined;
}

/** `NV_RUNTIME_RELEASES` is the C9 object `{"<tool>":"<release>"}`; the lease names acpx's. */
export function acpxReleaseOf(env: NodeJS.ProcessEnv): string | undefined {
  const raw = podFactValue("NV_RUNTIME_RELEASES", hostFacts(env));
  try {
    const release = (JSON.parse(raw ?? "null") as { acpx?: unknown } | null)?.acpx;
    return typeof release === "string" && release !== "" ? release : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pod fields for a lease written by THIS process. Outside an agent pod (the control pod, a
 * workbench, a rig) a lease carries none — today's lease, byte for byte, which is also what keeps
 * the A-16 rollback guard from reading the control pod's own lease as "an agent pod's".
 *
 * ⚠️ A-25: on a host that is an agent pod (place file or `ag-…` hostname) and cannot name its pod,
 * this THROWS `PodIdentityMissingError` — the caller must not have created the file yet. The pod
 * comes from `lockPodIdentity` (the process's own variables first, PID 1's for what it lacks, A-26)
 * and the placement and release from `podFactValue`, never `process.env` directly.
 */
export function leasePodFields(env: NodeJS.ProcessEnv = process.env): LeasePodFields | undefined {
  if (lockHostPlace(env) !== "agent-pod") {
    return undefined;
  }
  const pod = lockPodIdentity(env);
  if (!pod) {
    throw new PodIdentityMissingError();
  }
  const placement = placementOf(env);
  const acpxRelease = acpxReleaseOf(env);
  return {
    pod,
    ...(placement ? { placement } : {}),
    routedContract: LEASE_ROUTED_CONTRACT,
    ...(acpxRelease ? { acpxRelease } : {}),
  };
}

/** The pod-local socket directory (C3.1) in an agent pod; undefined elsewhere. */
export function podSocketDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (lockHostPlace(env) !== "agent-pod") {
    return undefined;
  }
  const seam = podTestHome(env);
  return seam ? path.join(seam, "run", "acpx", "q") : POD_SOCKET_DIR;
}

/**
 * `/run/acpx/q/<key>.sock` in every agent pod, both placements (C3.1). Outside it undefined, and the
 * caller keeps today's path. ⚠️ Never longer than a unix socket path may be: Node silently truncates
 * a longer one, and two sessions would then share one socket (`MAX_QUEUE_SOCKET_PATH_BYTES`).
 */
export function podSocketPath(
  sessionId: string,
  maxBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const dir = podSocketDir(env);
  if (dir === undefined) {
    return undefined;
  }
  const socket = path.join(dir, `${sessionKey(sessionId)}.sock`);
  if (Buffer.byteLength(socket) > maxBytes) {
    throw new Error(`pod-local socket path is longer than ${maxBytes} bytes: ${socket}`);
  }
  return socket;
}

/** Is `pod` this process's own pod — a lease naming it is judged by pid, as today. */
export function isOwnPod(pod: PodRef, env: NodeJS.ProcessEnv = process.env): boolean {
  return lockPodIdentity(env)?.uid === pod.uid;
}

/**
 * C2 "What the owner inherits": in pod mode the owner spawn REMOVES every `ACPX_ROUTED` /
 * `ACPX_ROUTED_*` variable and the caller's identity variables, so an owner's environment — and the
 * adapter and every command the agent runs under it — never depends on who woke it. Left in place,
 * `ACPX_ROUTED=1` would make every acpx call an agent makes from its pod a `routed_twice` refusal.
 * Outside pod mode the environment is returned as it came.
 */
export function ownerInheritedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (podModeVerdictNow(env).mode !== "pod") {
    return env;
  }
  const identity: readonly string[] = CALLER_IDENTITY_VARS;
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === "ACPX_ROUTED" || name.startsWith("ACPX_ROUTED_") || identity.includes(name)) {
      continue;
    }
    kept[name] = value;
  }
  return kept;
}
