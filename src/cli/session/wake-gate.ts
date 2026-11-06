import type { SenderRole, WakeAdmissionRequest, WakeTarget } from "../../capacity/admission.js";
import { seatDisplayName } from "../../session/seat-display-name.js";
import type { SessionRecord } from "../../types.js";
import { readQueueOwnerState } from "../queue/lease-store.js";

/**
 * The wake gate's glue (brick 2b3b259f, CONCEPTION §3.1): where `sendSession` and
 * `acpx capacity admit-wake` meet `admitWake` (`capacity/admission.ts`).
 */

export function wakeTargetOf(record: SessionRecord): WakeTarget {
  return {
    id: record.acpxRecordId,
    agentCommand: record.agentCommand,
    ...(record.seatId ? { seatId: record.seatId } : {}),
    ...(record.holderActive === undefined ? {} : { holderActive: record.holderActive }),
    ...(record.holderOrdinal === undefined ? {} : { holderOrdinal: record.holderOrdinal }),
    ...(record.lastPromptAt ? { lastPromptAt: record.lastPromptAt } : {}),
  };
}

/**
 * May an owner be running or STARTING for this session? Then a send submits to it (or waits on it,
 * or fails on a wedged one) and never cold-starts here, so it is never gated (§3.1 table). The same
 * judgement `sendSession` gives a not-yet-accepting lease (`leaseIsAliveForStartup`): anything but a
 * provably gone or recoverable owner. Side-effect-free — it never removes a lease.
 */
export async function ownerMayBeRunning(sessionId: string): Promise<boolean> {
  const state = await readQueueOwnerState(sessionId);
  return state.alive !== false && !state.recoverable;
}

/** The caller's own record id — the sender of an agent's `acpx prompt`, for the decision log. */
export function callerSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.ACPX_SESSION_RECORD_ID?.trim();
  if (id) {
    return id;
  }
  const match = /[?&]session=([^&#]+)/u.exec(env.ACPX_SESSION_URL ?? "");
  return match ? decodeURIComponent(match[1]) : undefined;
}

export type WakeRequestOptions = {
  readonly verb: WakeAdmissionRequest["verb"];
  readonly flagClass?: WakeAdmissionRequest["flagClass"];
  readonly sender?: string;
  readonly senderRole?: SenderRole;
  readonly crossBox?: boolean;
  readonly closedWithMessageId?: boolean;
};

export function wakeRequestFor(
  record: SessionRecord,
  options: WakeRequestOptions,
): WakeAdmissionRequest {
  return {
    ...options,
    target: wakeTargetOf(record),
    seatName: () => seatDisplayName(record),
  };
}

/** One per `sendSession`: the pre-check before any record write, the fall-through before a spawn. */
export type SendWakeGate = {
  beforePersist(): Promise<void>;
  beforeSpawn(): Promise<void>;
};

/**
 * Two call points, ONE decision per send (§3.1). `beforePersist` asks only when no owner may be
 * running — a refusal there leaves the record untouched (G1). `beforeSpawn` asks only if
 * `beforePersist` did not, i.e. for an owner that vanished between the lease read and the submit; a
 * refusal at that point has re-persisted the (inert, identical) owner options — documented, no
 * rollback (§14 R6).
 *
 * ⚠️ DO NOT DROP `beforeSpawn` AS REDUNDANT. The lease read and the submit are not atomic: an owner
 * that was live at the read and released before the submit falls through to the cold spawn, and
 * without the second call point that spawn is ungated — the probe-then-submit race of the v1
 * capacity review. Row "fall-through: an owner live at the pre-check but gone at submit is gated
 * before the spawn" in test/capacity-wake.test.ts.
 */
export function createSendWakeGate(
  record: SessionRecord,
  options: { readonly messageId?: string },
): SendWakeGate {
  let asked = false;
  const ask = async () => {
    asked = true;
    const { admitWake } = await import("../../capacity/admission.js");
    const decision = await admitWake(
      wakeRequestFor(record, {
        verb: "prompt",
        sender: callerSessionId(),
        closedWithMessageId: record.closed === true && options.messageId !== undefined,
      }),
    );
    if (decision.decision === "refused") {
      throw decision.error;
    }
  };
  return {
    async beforePersist() {
      if (!(await ownerMayBeRunning(record.acpxRecordId))) {
        await ask();
      }
    },
    async beforeSpawn() {
      if (!asked) {
        await ask();
      }
    },
  };
}
