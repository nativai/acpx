import { proveDeathDetailed, type DeathProofDetail } from "./death-proof.js";
import { lockHostPlace, type PodRef } from "./identity.js";
import { podModeVerdictNow } from "./placement.js";
import { podStartingRefusal, refusalForCaller } from "./pod-refusal.js";

/**
 * A-16 — the ROLLBACK refusal, in one place (CONTRACTS-r4 C1.1 "When the switch is reverted"). On a
 * control-role host in LOCAL mode (the switch off), a session whose lease names an agent pod stays a
 * pod session until that pod is PROVEN gone (C3.3): `exists` and `unknown` — an API that did not answer,
 * a pod whose delete failed — answer `acpx: REFUSED reason=pod_starting … phase=turnover` (exit 75),
 * and nothing local starts or writes.
 *
 * Called from the two layers that matter (F4): the front of `sendSession`, BEFORE any socket attempt
 * (a prompt must never reach a pod-local socket path from another kernel and fail as "another pid
 * namespace", exit 1), and `connectToQueueOwner`, the single door to an owner's socket, for every
 * other entry (cancel, close, status probes, settings, background-task queries).
 * ⚠️ NO BYPASS FLAG: a switch that is off is exactly when this guard matters.
 */
export type PodTurnoverDeps = {
  prove: (pod: PodRef) => Promise<DeathProofDetail>;
  /** Does this guard apply here: a control-role host in local mode. */
  applies: () => boolean;
};

export const livePodTurnoverDeps: PodTurnoverDeps = {
  prove: async (pod) => await proveDeathDetailed(pod),
  applies: () => podModeVerdictNow().mode === "off" && lockHostPlace() === "control",
};

/**
 * What a session's lease says about its pod, for this guard. `"unreadable"` is a `pod` KEY that names no
 * pod (A-68, `QueueOwnerRecord.podUnreadable`): C3.3 cannot fetch it and answers `unknown`, so it is a
 * pod that is NOT proven gone and is refused exactly like a readable pod that exists.
 */
export type LeasePod = PodRef | "unreadable";

/** Throws the C7.2 `pod_starting … phase=turnover` refusal unless `pod` is proven gone. */
export async function refuseWhilePodNotGone(
  sessionId: string,
  pod: LeasePod,
  deps: PodTurnoverDeps = livePodTurnoverDeps,
): Promise<void> {
  if (!deps.applies()) {
    return;
  }
  const answer = pod === "unreadable" ? "unknown" : (await deps.prove(pod)).answer;
  if (answer !== "gone") {
    // A-79: the sentence promises a hold only to atrium's delivery spawns — the same helper as the routed branch's.
    throw refusalForCaller(podStartingRefusal({ phase: "turnover", wake: sessionId, sessionId }));
  }
}
