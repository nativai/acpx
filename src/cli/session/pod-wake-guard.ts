import { lockPodIdentity } from "../../pod/identity.js";
import {
  livePodTurnoverDeps,
  type LeasePod,
  refuseWhilePodNotGone,
  type PodTurnoverDeps,
} from "../../pod/turnover-guard.js";
import {
  readQueueOwnerLeaseFile,
  type LeaseFile,
  type UnparsableShape,
} from "../queue/lease-store.js";

/**
 * A-16 on the WAKE path: reads the session's lease and applies the turnover guard
 * (`src/pod/turnover-guard.ts`, where the rule and its refusal live). A lease without a `pod` field
 * (today's, every box that never switched) proceeds untouched; one naming a pod must be proven gone.
 * A-69 (3): on a host with the pod's identity the guard holds what A-69 holds — a lease acpx cannot parse
 * (`heldLeasePod`).
 */
export type PodWakeGuardDeps = PodTurnoverDeps & {
  /**
   * The pod the session's lease names, `"unreadable"` for a `pod` key that names no pod (A-68), or
   * undefined for no lease / a lease without a `pod` key.
   */
  leasePod: (sessionId: string) => Promise<LeasePod | undefined>;
};

/**
 * What the lease says about its pod, for this guard. A parsed lease: its `pod`, or `"unreadable"` for a
 * `pod` key that names no pod (A-68). A lease acpx cannot parse (A-69), on a host WITH the pod's identity:
 * bytes that are unreadable, not JSON or not an object, and a JSON object whose `pod` key names no pod, are
 * `"unreadable"` (C3.3 answers `unknown`: refused without a request); one whose `pod` is readable names
 * that pod (proven gone or refused); one with no `pod` key is a control-pod writer's lease and is not held
 * (the 15 s rule removes it). Without the identity (never switched) an unparsable lease is no lease, as today.
 */
export function heldLeasePod(
  lease: LeaseFile,
  hasPodIdentity: boolean = lockPodIdentity() !== undefined,
): LeasePod | undefined {
  if (lease.kind === "ok") {
    return lease.record.podUnreadable ? "unreadable" : lease.record.pod;
  }
  return lease.kind === "unparsable" && hasPodIdentity ? heldUnparsablePod(lease.shape) : undefined;
}

function heldUnparsablePod(shape: UnparsableShape): LeasePod | undefined {
  if (shape.kind === "bytes" || shape.pod.kind === "unreadable") {
    return "unreadable";
  }
  return shape.pod.kind === "pod" ? shape.pod.pod : undefined;
}

const liveDeps: PodWakeGuardDeps = {
  ...livePodTurnoverDeps,
  leasePod: async (sessionId) => heldLeasePod(await readQueueOwnerLeaseFile(sessionId)),
};

/** Throws the C7.2 `pod_starting … phase=turnover` refusal; resolves when a local owner may start. */
export async function refuseWakeWhilePodNotGone(
  sessionId: string,
  deps: PodWakeGuardDeps = liveDeps,
): Promise<void> {
  if (!deps.applies()) {
    return;
  }
  const pod = await deps.leasePod(sessionId);
  if (pod !== undefined) {
    await refuseWhilePodNotGone(sessionId, pod, deps);
  }
}
