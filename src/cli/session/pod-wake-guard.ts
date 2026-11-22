import type { PodRef } from "../../pod/identity.js";
import {
  livePodTurnoverDeps,
  refuseWhilePodNotGone,
  type PodTurnoverDeps,
} from "../../pod/turnover-guard.js";
import { readQueueOwnerRecord } from "../queue/lease-store.js";

/**
 * A-16 on the WAKE path: reads the session's lease and applies the turnover guard
 * (`src/pod/turnover-guard.ts`, where the rule and its refusal live). A lease without a `pod` field
 * (today's, every box that never switched) proceeds untouched; one naming a pod must be proven gone.
 */
export type PodWakeGuardDeps = PodTurnoverDeps & {
  /** The pod the session's lease names, or undefined for no lease / a lease without `pod`. */
  leasePod: (sessionId: string) => Promise<PodRef | undefined>;
};

const liveDeps: PodWakeGuardDeps = {
  ...livePodTurnoverDeps,
  leasePod: async (sessionId) => (await readQueueOwnerRecord(sessionId))?.pod,
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
