import { proveDeathDetailed, type DeathProofDetail } from "../../pod/death-proof.js";
import { lockHostPlace, type PodRef } from "../../pod/identity.js";
import { podModeVerdictNow } from "../../pod/placement.js";
import { podStartingRefusal } from "../../pod/pod-refusal.js";
import { readQueueOwnerRecord } from "../queue/lease-store.js";

/**
 * A-16 — the ROLLBACK guard, on the control pod in LOCAL mode (the switch off). A revert changes where
 * new owners start; it does not turn a living pod's session into a local one. So before a wake may
 * start a LOCAL owner, a lease that names an agent pod must be PROVEN gone (C3.3):
 *
 *   no lease, or a lease without `pod`  → proceed — today's behaviour, byte for byte (a box that
 *                                          never switched has no `pod` field anywhere)
 *   lease names a pod, proof `gone`     → proceed (the stale lease is then reaped by its proof)
 *   lease names a pod, `exists`/`unknown` → `acpx: REFUSED reason=pod_starting … phase=turnover`
 *                                          (exit 75, retry_after_s=3); NO local owner starts, and
 *                                          nothing on the control pod writes a file the pod owns.
 *
 * `unknown` holds the message as "alive" everywhere (C3.3), and so does a pod whose delete FAILED: it
 * still exists, so the proof says so, and the session stays a pod session until it is really gone.
 * ⚠️ NO BYPASS FLAG: a switch that is off is exactly when this guard matters.
 */
export type PodWakeGuardDeps = {
  /** The pod the session's lease names, or undefined for no lease / a lease without `pod`. */
  leasePod: (sessionId: string) => Promise<PodRef | undefined>;
  prove: (pod: PodRef) => Promise<DeathProofDetail>;
  /** Does this guard apply here: a control-role host in local mode. */
  applies: () => boolean;
};

const liveDeps: PodWakeGuardDeps = {
  leasePod: async (sessionId) => (await readQueueOwnerRecord(sessionId))?.pod,
  prove: async (pod) => await proveDeathDetailed(pod),
  applies: () => podModeVerdictNow().mode === "off" && lockHostPlace() === "control",
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
  if (pod === undefined) {
    return;
  }
  if ((await deps.prove(pod)).answer !== "gone") {
    throw podStartingRefusal({ phase: "turnover", wake: sessionId, sessionId });
  }
}
