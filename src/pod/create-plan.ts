import { AcpxOperationalError } from "../errors.js";
import { podMode, thisPodFile } from "./placement.js";

/**
 * C1.3 — the create plan (CONTRACTS-r4 C1.3, block A2, brick 569497cb).
 *
 * In pod mode every create form writes a record and nothing else; the record is "sleeping"
 * (`acpSessionId: ""`, `acpx.sleeping`) and `acpx.sleeping` carries what the first wake — in the
 * session's own pod — must do. `plan: 1` versions that shape; a reader that meets another version
 * refuses (CONTRACTS rule 1) and never guesses.
 *
 * ⚠️ EVERY FIELD HERE MUST SURVIVE `cloneSessionAcpxState` AND THE RECORD PARSER. Both used to copy
 * `since` and `fork.from` only, so a `fork.cut` written at create would have been dropped by the first
 * re-base — and the wake would then fork the WHOLE source, silently. They now go through
 * {@link cloneSleepingPlan} / {@link parseSleepingPlan}; `test/pod-create-plan.test.ts` holds both.
 */

export const CREATE_PLAN_VERSION = 1 as const;

export type SleepingForkCut = {
  /** How many of the source's messages the copy inherits (= `forkedAtMessageIndex`). */
  message_index: number;
  /** The absolute cut in the source's history (`--at-log-index`), when one was given. */
  log_index?: number;
  /** Fingerprint of the last inherited entry — what `--expect-entry` checks. */
  expect_entry?: string;
  /** `"<kind>:<value>"` — what the harness needs to cut its own transcript (see {@link HarnessAnchor}). */
  harness_anchor?: string;
};

export type SleepingFork = {
  from: string;
  /** Absent = the whole source, read at the wake (today's template rule). */
  cut?: SleepingForkCut;
  byway?: true;
};

export type SleepingPlanState = {
  since: string;
  /** Version of this shape; absent = the pre-plan shape (`{since, fork?: {from}}`). */
  plan?: number;
  fork?: SleepingFork;
};

// ─── the anchor ────────────────────────────────────────────────────────────────────────────────

/**
 * C1.3 amendment A-15 (CONTRACTS-r4):
 * `harness_anchor` names its kind, `"<kind>:<value>"`. Version 1 knows ONE kind, `claude-uuid` — the
 * Claude transcript entry uuid the copy's context ends at, computed from files at create
 * (`reports/CUT-PINNING.md`, brick 569497cb). A reader that does not know the kind refuses
 * (`FORK_ANCHOR_UNSUPPORTED`); it never falls back to a cut of its own, because the fallback (pi's
 * positional index) is silently wrong on steered sessions.
 */
export const HARNESS_ANCHOR_KINDS = ["claude-uuid"] as const;
export type HarnessAnchorKind = (typeof HARNESS_ANCHOR_KINDS)[number];
export type HarnessAnchor = { kind: HarnessAnchorKind; value: string };

export const FORK_ANCHOR_UNSUPPORTED = "FORK_ANCHOR_UNSUPPORTED";
export const FORK_SOURCE_SLEEPING = "FORK_SOURCE_SLEEPING";
export const FORK_SOURCE_GONE = "FORK_SOURCE_GONE";
export const FORK_ANCHOR_MISSING = "FORK_ANCHOR_MISSING";
export const CREATE_PLAN_UNSUPPORTED = "CREATE_PLAN_UNSUPPORTED";

export function encodeHarnessAnchor(anchor: HarnessAnchor): string {
  return `${anchor.kind}:${anchor.value}`;
}

/** The anchor, or a `FORK_ANCHOR_UNSUPPORTED` refusal for a kind (or a shape) this build does not know. */
export function decodeHarnessAnchor(raw: string): HarnessAnchor {
  const at = raw.indexOf(":");
  const kind = at > 0 ? raw.slice(0, at) : "";
  const value = at > 0 ? raw.slice(at + 1) : "";
  if (!(HARNESS_ANCHOR_KINDS as readonly string[]).includes(kind) || value.length === 0) {
    throw new CreatePlanError(
      FORK_ANCHOR_UNSUPPORTED,
      `this acpx does not know the fork anchor ${JSON.stringify(raw)} (known kinds: ${HARNESS_ANCHOR_KINDS.join(", ")})`,
    );
  }
  return { kind: kind as HarnessAnchorKind, value };
}

/** A named refusal of the plan — its message starts with the code, so a reader of any wrapper finds it. */
export class CreatePlanError extends AcpxOperationalError {
  constructor(code: string, message: string) {
    super(`${code}: ${message}`, { outputCode: "RUNTIME", detailCode: code, origin: "runtime" });
    this.name = "CreatePlanError";
  }
}

/**
 * C1.3 amendment A-15: a cut whose source is sleeping is refused at create — the source has
 * no transcript, so no anchor can exist, and its own plan has not run.
 */
export function forkSourceSleepingError(sourceId: string): CreatePlanError {
  return new CreatePlanError(
    FORK_SOURCE_SLEEPING,
    `cannot cut a fork of ${sourceId}: it is sleeping (it has never run), so there is no conversation to cut yet`,
  );
}

/** Refuse a plan version this build does not know (CONTRACTS rule 1). Absent and 1 are known. */
export function assertKnownPlanVersion(plan: SleepingPlanState, recordId: string): void {
  if (plan.plan !== undefined && plan.plan !== CREATE_PLAN_VERSION) {
    throw new CreatePlanError(
      CREATE_PLAN_UNSUPPORTED,
      `session ${recordId} was created with create plan version ${plan.plan}; this acpx knows version ${CREATE_PLAN_VERSION}`,
    );
  }
}

// ─── parse and clone ──────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCut(value: unknown): SleepingForkCut | undefined {
  const raw = asRecord(value);
  const messageIndex = raw ? nonNegativeInteger(raw.message_index) : undefined;
  if (!raw || messageIndex === undefined) {
    return undefined;
  }
  const logIndex = nonNegativeInteger(raw.log_index);
  const expectEntry = nonEmptyString(raw.expect_entry);
  const anchor = nonEmptyString(raw.harness_anchor);
  return {
    message_index: messageIndex,
    ...(logIndex === undefined ? {} : { log_index: logIndex }),
    ...(expectEntry === undefined ? {} : { expect_entry: expectEntry }),
    ...(anchor === undefined ? {} : { harness_anchor: anchor }),
  };
}

/**
 * `acpx.sleeping` as read from disk: kept only when well-formed (a damaged value reads as "not
 * sleeping", as before). ⚠️ A `fork.cut` that is present but malformed must NOT degrade to "no cut"
 * — that would fork the whole source. It is kept as an unusable plan (version -1) so the wake refuses.
 */
export function parseSleepingPlan(value: unknown): SleepingPlanState | undefined {
  const raw = asRecord(value);
  const since = raw ? nonEmptyString(raw.since) : undefined;
  if (!raw || since === undefined) {
    return undefined;
  }
  const fork = parseFork(raw.fork);
  const plan = parsePlanVersion(raw.plan, fork?.cutDamaged === true);
  return {
    since,
    ...(plan === undefined ? {} : { plan }),
    ...(fork ? { fork: fork.fork } : {}),
  };
}

/** The version as written; -1 (unknown to every reader) for a non-integer or a damaged cut. */
function parsePlanVersion(value: unknown, cutDamaged: boolean): number | undefined {
  if (cutDamaged) {
    return -1;
  }
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) ? value : -1;
}

function parseFork(value: unknown): { fork: SleepingFork; cutDamaged: boolean } | undefined {
  const fork = asRecord(value);
  const from = fork ? nonEmptyString(fork.from) : undefined;
  if (!fork || from === undefined) {
    return undefined;
  }
  const cut = fork.cut === undefined ? undefined : parseCut(fork.cut);
  return {
    fork: {
      from,
      ...(cut ? { cut } : {}),
      ...(fork.byway === true ? { byway: true as const } : {}),
    },
    cutDamaged: fork.cut !== undefined && cut === undefined,
  };
}

/** A deep copy of every field — the turn path's re-base must keep the whole plan. */
export function cloneSleepingPlan(
  plan: SleepingPlanState | undefined,
): SleepingPlanState | undefined {
  if (!plan) {
    return undefined;
  }
  return {
    since: plan.since,
    ...(plan.plan === undefined ? {} : { plan: plan.plan }),
    ...(plan.fork
      ? {
          fork: {
            from: plan.fork.from,
            ...(plan.fork.cut ? { cut: { ...plan.fork.cut } } : {}),
            ...(plan.fork.byway ? { byway: true as const } : {}),
          },
        }
      : {}),
  };
}

/** The plan a pod-mode create writes. */
export function buildSleepingPlan(params: {
  since: string;
  forkFrom?: string;
  cut?: SleepingForkCut;
  byway?: boolean;
}): SleepingPlanState {
  return {
    since: params.since,
    plan: CREATE_PLAN_VERSION,
    ...(params.forkFrom
      ? {
          fork: {
            from: params.forkFrom,
            ...(params.cut ? { cut: params.cut } : {}),
            ...(params.byway ? { byway: true as const } : {}),
          },
        }
      : {}),
  };
}

// ─── where creates are record-only (C1.1, A1's placement) ─────────────────────────────────────

/**
 * Is this create record-only? — pod mode (C1.1), on the CONTROL pod: A1's own answer
 * (`src/pod/placement.ts`), never a second reading of the switch. A create passed through from an
 * agent pod arrives here on the control pod too (C6.2), so the control pod is the only place that
 * writes a new record; in an agent pod A1's placement step passes every create through before acpx
 * gets this far.
 */
export function isRecordOnlyCreate(): boolean {
  return podMode().mode === "pod" && thisPodFile().kind === "absent";
}

// ─── capacity at create (C1.3, C7.2) ──────────────────────────────────────────────────────────

/**
 * C1.3: a record-only create is never refused for room. The one refusal is the box's waiting line
 * (`acpx: REFUSED reason=agent_cap … why=waiting-line`, C7.2): sessions waiting for a pod above
 * 2 × the cap. That number comes from the broker (`GET /v1/agents`, A9 / [D2]), which does not
 * exist yet — so this seam answers "no refusal" until it does.
 */
export type WaitingLineRefusal = { live: number; cap: number; box: string };

export async function waitingLineRefusal(): Promise<WaitingLineRefusal | undefined> {
  return undefined;
}

/**
 * The C7.2 line for that one refusal — exit 75 (`CAPACITY`), line 1 the machine token, line 2 one
 * sentence; nothing was created. Typed here because the reason `agent_cap` joins acpx's capacity
 * reasons with C7.2's own block, not with A2.
 */
export function waitingLineRefusalError(refusal: WaitingLineRefusal): AcpxOperationalError {
  const token =
    `acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 retry_after_s=60 ` +
    `live=${refusal.live} cap=${refusal.cap} box=${refusal.box} why=waiting-line`;
  return new AcpxOperationalError(
    `${token}\nThe box's line of sessions waiting for a pod is full; nothing was created — try again in a minute.`,
    { outputCode: "CAPACITY", detailCode: "agent-cap", origin: "cli", retryable: true },
  );
}

/** C1.3 — the create gate in pod mode: never "no room", only the waiting line. */
export async function admitRecordOnlyCreate(): Promise<void> {
  const refusal = await waitingLineRefusal();
  if (refusal) {
    throw waitingLineRefusalError(refusal);
  }
}
