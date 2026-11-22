import path from "node:path";
import { updateRecordFile } from "../session/persistence/record-file-lock.js";
import { sessionBaseDir } from "../session/persistence/session-base-dir.js";
import type { PodTerminal } from "./death-proof.js";
import type { PodRef } from "./identity.js";

/**
 * Block A4 / C3.3: when the control pod's death proof says an owner's pod is `gone`, the session
 * RECORD keeps why (`acpx.last_pod_end`). Agent-pod OOMs are invisible to the control pod's governor
 * — an `OOMKilled` pod looks like any other ended pod from here — so the terminal reason, when the API
 * server still holds the pod object (a Job keeps its pod for `ttlSecondsAfterFinished`), is the only
 * trace. A pod already absent leaves `proof: pod-gone` and no reason: nothing is left to read.
 *
 * Written through `updateRecordFile` (the record lock: re-read inside, token checked before publish) and
 * IDEMPOTENT per pod uid, so a second reader proving the same death writes nothing. It never throws:
 * a record that cannot be updated must not stop the reap that follows the proof.
 */
export type PodEnd = {
  pod: PodRef;
  proof: "pod-gone" | "pod-terminal";
  terminal?: PodTerminal;
};

export async function recordPodEnd(
  sessionId: string,
  end: PodEnd,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const file = path.join(sessionBaseDir(), `${encodeURIComponent(sessionId)}.json`);
  try {
    const { written } = await updateRecordFile(file, (current) => podEndChange(current, end, now));
    return written;
  } catch {
    return false;
  }
}

function podEndChange(
  current: string | undefined,
  end: PodEnd,
  now: () => Date,
): string | undefined {
  if (current === undefined) {
    return undefined;
  }
  const record = JSON.parse(current) as { acpx?: Record<string, unknown> };
  const acpx = record.acpx ?? {};
  if ((acpx.last_pod_end as { uid?: unknown } | undefined)?.uid === end.pod.uid) {
    return undefined;
  }
  acpx.last_pod_end = {
    at: now().toISOString(),
    pod: end.pod.name,
    uid: end.pod.uid,
    proof: end.proof,
    ...(end.terminal ? { reason: end.terminal.reason } : {}),
    ...(end.terminal?.exitCode === undefined ? {} : { exit_code: end.terminal.exitCode }),
  };
  return `${JSON.stringify({ ...record, acpx })}\n`;
}
