/**
 * UMQ K4 (CONTRACTS §2.1) — the member layout of a batch prompt, carried as
 * `params._meta["acpx/batch"]` on the ONE `session/prompt` a batch becomes. Block ranges index
 * `params.prompt` as sent; consumers read the STREAM copy of the frame (== the wire copy, R13).
 */
export type AcpxBatchMeta = {
  v: 1;
  envelope: { first: number; count: number };
  members: Array<{ messageId: string; requestId: string; first: number; count: number }>;
  /** Only on a split part (CONCEPTION §22.1): 1-based inclusive positions in the original batch. */
  split?: BatchSplitPart;
};

export type BatchSplitPart = { total: number; from: number; to: number };

export const ACPX_BATCH_META_KEY = "acpx/batch";

/** The same layout with every range moved by `offset` blocks (a turn-context block prepended). */
export function shiftBatchMeta(meta: AcpxBatchMeta, offset: number): AcpxBatchMeta {
  if (offset === 0) {
    return meta;
  }
  return {
    ...meta,
    envelope: { ...meta.envelope, first: meta.envelope.first + offset },
    members: meta.members.map((member) => ({ ...member, first: member.first + offset })),
  };
}
