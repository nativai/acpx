// R-CONSUMED (brick e09628a1, CONCEPTION §3) — the incremental half of the ONE rule that decides whether a
// Codex model CONSUMED a delivered message before its turn was cut. Pure, no I/O.
//
// The queue owner feeds every INBOUND ACP message to `observe`, in wire order, and registers each delivery
// immediately BEFORE its prompt is sent. acpx-ui runs the same rule in batch over the stored stream
// (`server/delivery-consumption.ts` there). The two are bound by
// `test/fixtures/delivery-consumption.fixture.json`, vendored byte-identically into acpx-ui: both suites run
// every vector, and a one-sided edit reds a suite.
//
// The rule:
//   - a MODEL-OUTPUT frame is a `session/update` whose `sessionUpdate` is `agent_message_chunk` (except the
//     literal "Context compacted."), `agent_thought_chunk`, or `tool_call`;
//   - a COMPLETION frame is a `session/update` `usage_update` carrying `_meta.acpxUsage` — codex-acp emits
//     exactly one per completed model request, after that request's tools resolved;
//   - a completion COUNTS only if a model-output frame lies between it and the previous counted completion
//     (or the registration, for the first);
//   - consumed iff counted >= need: 2 for a steer (codex folds a steer into the NEXT request, so the first
//     completion may be the request already in flight when it arrived), 1 for a main prompt.
//
// ⚠️ DO NOT COUNT `tool_call_update` AS OUTPUT, and do not drop the gating "because the census agreed
// without it". Compaction clusters and error-path token counts are completions with no model output before
// them; counting them turns a genuinely cut steer into a false "delivered" (fixture vectors N3, N4, N5, N8).
// The rule may only ever err toward "cut", which keeps today's outcome-unknown label.
//
// ⚠️ DO NOT TURN A FLIP INTO A TERMINAL. Consumption only changes what a CUT writes; a consumed message stays
// in flight until its turn ends (KD-10: `done` means "the turn that carried it has ended, safe to close").

export const CONSUMED_BEFORE_CUT = "consumed_before_cut" as const;
export const CONSUMED_BEFORE_CUT_INFERRED = "consumed_before_cut_inferred" as const;
export const CONSUMED_BEFORE_CUT_BACKFILL = "consumed_before_cut_backfill" as const;

export const COMPACTION_NOTICE_TEXT = "Context compacted.";

export type ConsumptionKind = "main" | "steer";

export const CONSUMPTION_NEED: Readonly<Record<ConsumptionKind, number>> = { steer: 2, main: 1 };

export type ConsumptionFrameClass = "output" | "completion" | "other";

const OUTPUT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call"]);

type SessionUpdate = {
  sessionUpdate?: unknown;
  content?: { text?: unknown };
  _meta?: { acpxUsage?: unknown };
};

function sessionUpdateOf(message: unknown): SessionUpdate | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const frame = message as { method?: unknown; params?: { update?: SessionUpdate } };
  return frame.method === "session/update" ? frame.params?.update : undefined;
}

function isModelOutput(update: SessionUpdate): boolean {
  const kind = update.sessionUpdate;
  if (typeof kind !== "string" || !OUTPUT_UPDATES.has(kind)) {
    return false;
  }
  return !(kind === "agent_message_chunk" && update.content?.text === COMPACTION_NOTICE_TEXT);
}

export function classifyConsumptionFrame(message: unknown): ConsumptionFrameClass {
  const update = sessionUpdateOf(message);
  if (!update) {
    return "other";
  }
  if (update.sessionUpdate === "usage_update") {
    return update._meta?.acpxUsage ? "completion" : "other";
  }
  return isModelOutput(update) ? "output" : "other";
}

export type ConsumptionEvidence = {
  kind: ConsumptionKind;
  counted: number;
  need: number;
  /** Every completion observed since registration, counted or not. */
  completionCount: number;
};

type Tracked = ConsumptionEvidence & { outputSinceMark: boolean };

export class ConsumptionTracker {
  private readonly tracked = new Map<string, Tracked>();
  private readonly onConsumed: ((messageId: string) => void) | undefined;

  constructor(options: { onConsumed?: (messageId: string) => void } = {}) {
    this.onConsumed = options.onConsumed;
  }

  /**
   * Start counting for `messageId` from now. Idempotent: a main prompt re-sent by a retry keeps its first
   * registration, because an earlier attempt's consumption is real (CONCEPTION §13 E4).
   */
  register(messageId: string, kind: ConsumptionKind): void {
    if (this.tracked.has(messageId)) {
      return;
    }
    this.tracked.set(messageId, {
      kind,
      counted: 0,
      need: CONSUMPTION_NEED[kind],
      completionCount: 0,
      outputSinceMark: false,
    });
  }

  observe(message: unknown): void {
    const cls = classifyConsumptionFrame(message);
    if (cls === "other" || this.tracked.size === 0) {
      return;
    }
    for (const [messageId, entry] of this.tracked) {
      if (cls === "output") {
        entry.outputSinceMark = true;
        continue;
      }
      entry.completionCount += 1;
      if (!entry.outputSinceMark) {
        continue;
      }
      entry.counted += 1;
      entry.outputSinceMark = false;
      if (entry.counted === entry.need) {
        this.onConsumed?.(messageId);
      }
    }
  }

  isConsumed(messageId: string): boolean {
    const entry = this.tracked.get(messageId);
    return entry !== undefined && entry.counted >= entry.need;
  }

  kindOf(messageId: string): ConsumptionKind | undefined {
    return this.tracked.get(messageId)?.kind;
  }

  evidence(messageId: string): ConsumptionEvidence | undefined {
    const entry = this.tracked.get(messageId);
    if (!entry) {
      return undefined;
    }
    return {
      kind: entry.kind,
      counted: entry.counted,
      need: entry.need,
      completionCount: entry.completionCount,
    };
  }

  /** Stop counting for a message whose terminal is written. */
  release(messageId: string): void {
    this.tracked.delete(messageId);
  }
}
