import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  /**
   * Set ONLY on a DAMAGED plan (`plan: -1`): the value exactly as it was on disk. The record serializer
   * writes THIS back instead of the (deliberately empty) parsed view, so a refused wake never rewrites a
   * damaged plan — the evidence of what was wrong survives, valid fields included (TE R2-F2).
   */
  unreadable?: { raw: unknown };
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
export const CREATE_REPLAY_MISMATCH = "CREATE_REPLAY_MISMATCH";

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
  constructor(code: string, message: string, outputCode: "RUNTIME" | "USAGE" = "RUNTIME") {
    super(`${code}: ${message}`, {
      outputCode,
      detailCode: code,
      origin: outputCode === "USAGE" ? "cli" : "runtime",
    });
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

/** An optional field: absent is fine, PRESENT but invalid is `undefined` — the whole cut is then damaged. */
type Optional<T> = { value?: T } | undefined;

function optionalField<T>(
  raw: Record<string, unknown>,
  key: string,
  parse: (value: unknown) => T | undefined,
): Optional<T> {
  if (raw[key] === undefined) {
    return {};
  }
  const value = parse(raw[key]);
  return value === undefined ? undefined : { value };
}

/**
 * ⚠️ FAIL CLOSED (TE finding M-1). A `log_index`, `expect_entry` or `harness_anchor` that is present but
 * not a valid value — a number where a string belongs, an empty string — must damage the WHOLE cut, never
 * be dropped: dropping `harness_anchor` made a Claude cut read as unanchored and wake BY POSITION (the wrong
 * cut after a later compaction), and dropping `expect_entry` silently disabled the only check a moved Pi
 * cut has. A damaged cut makes the plan unknown (`parseSleepingPlan`), and the wake refuses it by name.
 * Test: `test/pod-create-plan.test.ts` → "a DAMAGED cut".
 */
function parseCut(value: unknown): SleepingForkCut | undefined {
  const raw = asRecord(value);
  const messageIndex = raw ? nonNegativeInteger(raw.message_index) : undefined;
  if (!raw || messageIndex === undefined) {
    return undefined;
  }
  const optional = parseOptionalCutFields(raw);
  return optional ? { message_index: messageIndex, ...optional } : undefined;
}

/** `log_index`, `expect_entry`, `harness_anchor`: each absent or valid; any present-but-invalid → undefined. */
function parseOptionalCutFields(
  raw: Record<string, unknown>,
): Omit<SleepingForkCut, "message_index"> | undefined {
  const logIndex = optionalField(raw, "log_index", nonNegativeInteger);
  const expectEntry = optionalField(raw, "expect_entry", nonEmptyString);
  const anchor = optionalField(raw, "harness_anchor", nonEmptyString);
  if (!logIndex || !expectEntry || !anchor) {
    return undefined;
  }
  return {
    ...(logIndex.value === undefined ? {} : { log_index: logIndex.value }),
    ...(expectEntry.value === undefined ? {} : { expect_entry: expectEntry.value }),
    ...(anchor.value === undefined ? {} : { harness_anchor: anchor.value }),
  };
}

/**
 * `acpx.sleeping` as read from disk: kept only when well-formed (a damaged value reads as "not
 * sleeping", as before).
 *
 * ⚠️ ONE RULE FOR EVERY FIELD THE PLAN KNOWS — PRESENT AND INVALID MEANS DAMAGED, never dropped (TE
 * findings M-1, R2-F1). The fields: `plan`, `fork`, `fork.from`, `fork.cut`, `fork.byway`,
 * `cut.message_index`, `cut.log_index`, `cut.expect_entry`, `cut.harness_anchor`. Dropping one reads the
 * record as something it is not — a cut without its anchor wakes BY POSITION, a fork without its `from`
 * wakes as a FRESH agent with no context. A damaged plan is kept as an unusable one (`plan: -1`, nothing
 * executable) so the wake refuses it by name, and it carries its raw value so it is never written back
 * changed. Unknown EXTRA fields are ignored (CONTRACTS rule 2). `since` is the one required field of the
 * K7 shape: without it the value is not a sleeping mark at all.
 */
export function parseSleepingPlan(value: unknown): SleepingPlanState | undefined {
  const raw = asRecord(value);
  const since = raw ? nonEmptyString(raw.since) : undefined;
  if (!raw || since === undefined) {
    return undefined;
  }
  const plan = parsePlanVersion(raw.plan);
  const fork = parseFork(raw.fork);
  if (plan === DAMAGED || fork === DAMAGED) {
    return { since, plan: -1, unreadable: { raw: structuredClone(raw) } };
  }
  return {
    since,
    ...(plan === undefined ? {} : { plan }),
    ...(fork === undefined ? {} : { fork }),
  };
}

/**
 * R3-F1 — an `acpx.sleeping` that is PRESENT on a record that NEVER RAN (`acp_session_id ""`) but is not a
 * valid mark at all (`since` invalid, or not an object): a damaged plan like every other, not "not
 * sleeping". Read as "not sleeping" the record fails at the wake with a misleading reconnect error and
 * the refused wake erases the value. `since` is only a display time here, so an invalid one reads `""`.
 * On a record with a real session id the old K7 reading stays (`parse.ts` `assignSleeping`).
 */
export function damagedSleepingPlan(raw: unknown): SleepingPlanState {
  const since = asRecord(raw) ? nonEmptyString(asRecord(raw)?.since) : undefined;
  return { since: since ?? "", plan: -1, unreadable: { raw: structuredClone(raw) } };
}

const DAMAGED = Symbol("damaged");

/** Absent, an integer, or DAMAGED (a non-integer, `null`, …). */
function parsePlanVersion(value: unknown): number | undefined | typeof DAMAGED {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) ? value : DAMAGED;
}

/** Absent, a valid fork, or DAMAGED: a non-object, a missing/invalid `from`, a damaged `cut`, a `byway` that is not `true`. */
function parseFork(value: unknown): SleepingFork | undefined | typeof DAMAGED {
  if (value === undefined) {
    return undefined;
  }
  const fork = asRecord(value);
  const from = fork ? nonEmptyString(fork.from) : undefined;
  if (!fork || from === undefined || !validByway(fork.byway)) {
    return DAMAGED;
  }
  const cut = parseForkCut(fork.cut);
  return cut === DAMAGED ? DAMAGED : forkOf(from, cut, fork.byway === true);
}

function forkOf(from: string, cut: SleepingForkCut | undefined, byway: boolean): SleepingFork {
  return {
    from,
    ...(cut ? { cut } : {}),
    ...(byway ? { byway: true as const } : {}),
  };
}

/** `fork.byway` is written only as `true`: absent or `true` is valid, anything else is damage. */
function validByway(value: unknown): boolean {
  return value === undefined || value === true;
}

/** Absent, a valid cut, or DAMAGED (present but not a well-formed cut). */
function parseForkCut(value: unknown): SleepingForkCut | undefined | typeof DAMAGED {
  return value === undefined ? undefined : (parseCut(value) ?? DAMAGED);
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
    ...(plan.unreadable ? { unreadable: { raw: structuredClone(plan.unreadable.raw) } } : {}),
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

// ─── C6.2 at most once: a replay must be the identical request (TE finding M-2) ───────────────

/**
 * The fingerprint of a create's request — its whole argv, hashed. It is written into the record's
 * metadata (`created_by_request`) in the create's own write, beside `created_by_call`, and compared on
 * every replay. A replay is a retry of the SAME call, so its argv is identical by construction (atrium
 * re-runs the argv it first ran); anything else — another cut, an added `--prompt`, another template or
 * source — is a different request that must not be answered with the first record.
 *
 * ⚠️ A FILE-VALUED ARGUMENT IS ITS BYTES, NOT ITS PATH (TE R2-F4). `fileDigests` maps each such argument's
 * path to the sha256 of its content AT REQUEST TIME, and the fingerprint hashes that instead of the path:
 * the same bytes at another path (a pass-through writes a per-attempt temp file) are an identical request,
 * different bytes behind the same path are not. Today the only such argument of a create is
 * `sessions import <archive>`; the rule is for every file-valued argument a create takes.
 */
export function createRequestFingerprint(
  argv: readonly string[],
  fileDigests: Readonly<Record<string, string>> = {},
): string {
  const request = argv.map((arg) =>
    Object.hasOwn(fileDigests, arg) ? `file-sha256:${fileDigests[arg]}` : arg,
  );
  return createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
}

/** The sha256 of each named file's bytes, keyed by the path as it appears in the argv. */
export async function fileArgumentDigests(
  paths: readonly string[],
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const filePath of paths) {
    digests[filePath] = createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
  }
  return digests;
}

/** A replay (same `--record-id`, same `--created-by-call`) whose request is not the one the record holds. */
export function createReplayMismatchError(recordId: string): AcpxOperationalError {
  return new CreatePlanError(
    CREATE_REPLAY_MISMATCH,
    `record ${recordId} was created by this call id with a different request; a replay must be the ` +
      "identical request, so nothing was written and the first answer is not returned for it",
    "USAGE",
  );
}
