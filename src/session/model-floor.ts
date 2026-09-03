import { open } from "node:fs/promises";
import { isClaudeAcpAgentCommand } from "../acp/agent-command.js";
import {
  activeTranscriptConfigDir,
  resolveExistingTranscriptPath,
} from "../config/subscription-transcript.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { effortRank, normalizeEffortLevelForModel } from "./config-option-application.js";
import { isoNow } from "./persistence.js";

// ─── Served-model vs pinned floor ───────────────────────────────────────────
//
// acpx has NO model-rank system, and deliberately does not gain one here. This
// check answers ONE question — "is the served id the model that was pinned?" —
// and never "is it better or worse", because nothing in acpx can ground that
// ordering: the adapter advertises models without a rank, and cost is not
// capability (Fable is the most expensive model; Opus 5 is the SDK's own
// "Default (recommended)").
//
// ⚠️ DO NOT "fix" this by adding a capability ladder so an "upgrade" passes. It
// looks like the obvious improvement and it is the bug, twice over:
//   * a hand-written ladder rots on every model release — silently, and in the
//     direction that REFUSES real turns under `--floor-hard`; and
//   * it would make acpx silently accept a session served the most expensive
//     model it never asked for. That is measured, not hypothetical: session
//     b80f2910 (2026-09-01) was pinned `sonnet` and served `claude-fable-5-1`.
//     Today that is at least recorded. Trading a mislabel for an invisible cost
//     event is the worse deal.
// `test/model-floor-served-id.test.ts` R6 goes red if that acceptance is added.
//
// CORRECTION (brick 8a54201e, 2026-09-03) — this comment used to assert that
// "the harness only ever downgrades (never silently serves a MORE expensive
// model), so 'served family ≠ pinned family' is exactly 'below floor'". That is
// FALSE; the b80f2910 record above falsifies it. The `below-floor` status is
// therefore WIDER than its name: it means "off pin", direction unknown.
//
// Satisfaction has exactly two clauses:
//   * an ALIAS pin (`fable`/`opus`/`sonnet`/`haiku`) is a FAMILY-level request,
//     so any served id in that family satisfies it. This must stay loose, and
//     the reason is measured: the same `fable` alias resolved to
//     `claude-fable-5` on adapter 0.3.219 and to `claude-fable-5-1` on 0.3.257,
//     both on the wire within one day (brick 99ff393b, probe c5). Exact-matching
//     aliases would refuse real turns fleet-wide.
//   * a CONCRETE pin is EXACT — the user named a generation, so a different
//     generation of the same family is off pin. Only a DATED SNAPSHOT of that
//     same id refines it (`claude-haiku-4-5` → `claude-haiku-4-5-20251001`).
//
// ⚠️ KNOWN LIMIT — the concrete clause recognises ONE canonical spelling, and
// that is deliberate. An independent test-engineer enumerated three id shapes it
// reads as off-pin which a human would call the same model (brick 8a54201e
// verification §B, cases X1/X4/X5/X11):
//   * a REVERSE snapshot — a dated pin served the undated id
//     (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`);
//   * a PROVIDER-PREFIXED served id — `us.anthropic.claude-opus-4-5-…-v1:0`
//     (Bedrock) or `anthropic/claude-opus-5` (Vertex). Claude Code genuinely
//     supports those deployment modes; this box is simply not one of them;
//   * a date PLUS an extra component — `claude-opus-4-5-20251101-v2`.
// DO NOT widen the rule to cover them without a measured symptom. Every one
// needs a CONCRETE pin (11 of 2813 live records, devbox 2026-09-03) AND a
// non-canonical spelling, and is consequence-free while `--floor-hard` is on 0
// records — a false alarm writes a breadcrumb, it does not refuse a turn. The
// reasoning is the same one that rejects the capability ladder above: no
// measured symptom, real blast radius, so record the limit rather than widen the
// rule for cases nobody has hit. What would change this: hard mode being adopted
// TOGETHER with a concrete pin.

const KNOWN_MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
const MODEL_CONTEXT_HINT_PATTERN = /\[\d+m\]$/i;
// ⚠️ The date SHAPE is load-bearing — do not relax this to "any component".
// `served.startsWith(pinned + "-")` alone re-admits `claude-fable-5` served as
// `claude-fable-5-1`: a generation bump wearing a snapshot's shape, i.e. exactly
// the silent upgrade this file refuses to make above, through the back door.
// R4 (snapshot must pass) and R4c (generation bump must be caught) pin both
// directions, so the asymmetry stays a decision rather than a side effect.
const MODEL_SNAPSHOT_SUFFIX_PATTERN = /^\d{8}$/;

/** Lowercase + trim a model id and strip its `[Nm]` context hint. */
function normalizeModelId(modelId: string | null | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim().toLowerCase().replace(MODEL_CONTEXT_HINT_PATTERN, "");
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalize a model id/alias to a comparable family token. Returns a known
 * family (`fable`/`opus`/`sonnet`/`haiku`) when the id contains it, else the
 * lowercased, context-hint-stripped id so two spellings of an unknown model
 * still compare by equality.
 */
export function modelFamily(modelId: string | null | undefined): string | undefined {
  const normalized = normalizeModelId(modelId);
  if (normalized === undefined) {
    return undefined;
  }
  for (const family of KNOWN_MODEL_FAMILIES) {
    if (normalized.includes(family)) {
      return family;
    }
  }
  return normalized;
}

/** True when the pin is a bare family token (`fable`), not a concrete model id. */
function isFamilyAliasPin(normalizedPin: string): boolean {
  return (KNOWN_MODEL_FAMILIES as readonly string[]).includes(normalizedPin);
}

/**
 * True when the served model SATISFIES the pinned floor: an alias pin is met by
 * any served id of that family; a concrete pin is met only by itself or by a
 * dated snapshot of itself. See the two clauses documented above.
 */
export function servedModelMatchesFloor(
  pinnedModel: string | undefined,
  servedModel: string | undefined,
): boolean {
  const pinned = normalizeModelId(pinnedModel);
  const served = normalizeModelId(servedModel);
  if (pinned === undefined || served === undefined) {
    return false;
  }
  if (isFamilyAliasPin(pinned)) {
    return modelFamily(served) === pinned;
  }
  if (served === pinned) {
    return true;
  }
  if (!served.startsWith(`${pinned}-`)) {
    return false;
  }
  return MODEL_SNAPSHOT_SUFFIX_PATTERN.test(served.slice(pinned.length + 1));
}

// ─── Effort derivation (effort follows model) ───────────────────────────────

/**
 * The effort a pinned intent EFFECTIVELY becomes under the served model — e.g.
 * a `max` pin served on sonnet is authored down to `high`. Derived (not an
 * independent observation), used only to populate the served block's `effort`.
 */
export function deriveServedEffort(
  pinnedEffort: string | undefined,
  servedModel: string | undefined,
): string | undefined {
  if (!pinnedEffort) {
    return undefined;
  }
  return normalizeEffortLevelForModel(pinnedEffort, servedModel) ?? pinnedEffort;
}

// ─── Floor evaluation ───────────────────────────────────────────────────────

export type ModelFloorStatus = "at-floor" | "below-floor" | "unknown";

export type ModelFloorEvaluation = {
  status: ModelFloorStatus;
  /** Which axis failed when below-floor (model-first; effort follows). */
  reason?: "model" | "effort";
  pinnedModel: string;
  pinnedEffort: string | undefined;
  servedModel: string | undefined;
  servedEffort: string | undefined;
};

/**
 * Compare a served model+effort against the pinned floor. MODEL-FIRST (effort
 * follows model, §1/§9): a served model that does not satisfy the pin is
 * below-floor regardless of effort — and note `below-floor` names "off pin",
 * NOT a proven downgrade (see the correction at the top of this file).
 * When the model is at floor, an OPTIONALLY-supplied served effort (only
 * `$CLAUDE_EFFORT`, self-readable — the acpx runtime does not have it) below the
 * pinned effort is also below-floor. An unreadable served model ⇒ `unknown`
 * (the caller decides: non-hard accepts, hard fails closed only when it must).
 */
export function evaluateModelFloor(params: {
  pinnedModel: string;
  pinnedEffort?: string;
  servedModel: string | undefined;
  servedEffort?: string;
}): ModelFloorEvaluation {
  const base = {
    pinnedModel: params.pinnedModel,
    pinnedEffort: params.pinnedEffort,
    servedModel: params.servedModel,
    servedEffort: params.servedEffort,
  };
  if (params.servedModel === undefined) {
    return { ...base, status: "unknown" };
  }
  if (!servedModelMatchesFloor(params.pinnedModel, params.servedModel)) {
    return { ...base, status: "below-floor", reason: "model" };
  }
  const pinnedRank = effortRank(params.pinnedEffort);
  const servedRank = effortRank(params.servedEffort);
  if (pinnedRank !== undefined && servedRank !== undefined && servedRank < pinnedRank) {
    return { ...base, status: "below-floor", reason: "effort" };
  }
  return { ...base, status: "at-floor" };
}

// ─── Record accessors (pins + policy) ───────────────────────────────────────

/** The durable pinned model floor (`session_options.model`), or undefined. */
export function pinnedModelFloor(record: SessionRecord): string | undefined {
  const model = record.acpx?.session_options?.model;
  return typeof model === "string" && model.trim().length > 0 ? model : undefined;
}

/** The durable pinned effort intent, or undefined. */
export function pinnedEffortFloor(record: SessionRecord): string | undefined {
  return (
    record.acpx?.desired_config_options?.effort ?? record.acpx?.session_options?.effort ?? undefined
  );
}

/** Whether `--floor-hard` is active for this session. */
export function floorHardEnabled(record: SessionRecord): boolean {
  return record.acpx?.session_options?.floor_hard === true;
}

// ─── Served-model transcript read ───────────────────────────────────────────

const SERVED_TAIL_BYTES = 128 * 1024;

/**
 * Read the model of the LAST `assistant` entry in the session's active Claude
 * transcript JSONL — the authoritative served model for the most recent turn.
 * No-ops (returns undefined) for non-Claude adapters (only claude-agent-acp
 * writes `<acpSessionId>.jsonl` with `assistant.message.model`) and when the
 * transcript is absent/unreadable. Best-effort: never throws.
 */
export async function readLastServedModel(record: SessionRecord): Promise<string | undefined> {
  if (!isClaudeAcpAgentCommand(record.agentCommand)) {
    return undefined;
  }
  let configDir: string;
  try {
    configDir = activeTranscriptConfigDir(record);
  } catch {
    return undefined;
  }
  const resolved = await resolveExistingTranscriptPath(configDir, record.cwd, record.acpSessionId);
  if (!resolved) {
    return undefined;
  }
  return await readLastAssistantModelFromJsonl(resolved.path);
}

async function readLastAssistantModelFromJsonl(filePath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return undefined;
    }
    const readLen = Math.min(size, SERVED_TAIL_BYTES);
    const start = size - readLen;
    const buffer = Buffer.alloc(readLen);
    await handle.read(buffer, 0, readLen, start);
    let text = buffer.toString("utf8");
    // Drop a leading partial line when the window did not start at byte 0.
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const model = assistantModelFromJsonlLine(lines[i].trim());
      if (model) {
        return model;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  if (!line) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function assistantModelFromJsonlLine(line: string): string | undefined {
  const entry = parseJsonObject(line);
  if (!entry || entry.type !== "assistant") {
    return undefined;
  }
  const message = entry.message;
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  const model = (message as { model?: unknown }).model;
  return typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;
}

// ─── Record stamping (served block + breadcrumbs) ───────────────────────────

function ensureAcpx(record: SessionRecord): SessionAcpxState {
  if (!record.acpx) {
    record.acpx = {};
  }
  return record.acpx;
}

/** Stamp the per-turn served block. The desired pin is never touched. */
export function setServedState(
  record: SessionRecord,
  served: { model?: string; effort?: string; source?: string; at?: string },
): void {
  const acpx = ensureAcpx(record);
  acpx.served = {
    ...(served.model ? { model: served.model } : {}),
    ...(served.effort ? { effort: served.effort } : {}),
    ...(served.source ? { source: served.source } : {}),
    at: served.at ?? isoNow(),
  };
}

/** Stamp the below-floor audit breadcrumb. Pin unchanged. */
export function stampServedBelowFloor(
  record: SessionRecord,
  evaluation: ModelFloorEvaluation,
): void {
  const acpx = ensureAcpx(record);
  acpx.served_below_floor = {
    ...(evaluation.servedModel ? { served_model: evaluation.servedModel } : {}),
    ...(evaluation.servedEffort ? { served_effort: evaluation.servedEffort } : {}),
    pinned_model: evaluation.pinnedModel,
    ...(evaluation.pinnedEffort ? { pinned_effort: evaluation.pinnedEffort } : {}),
    at: isoNow(),
  };
}

/** Set the parked state (hard mode, bounded-retry exhausted). */
export function setFloorParked(record: SessionRecord, observedModel: string | undefined): void {
  const acpx = ensureAcpx(record);
  acpx.floor_parked = {
    at: isoNow(),
    reason: "model-floor-unmet",
    ...(observedModel ? { observed_model: observedModel } : {}),
  };
}

/**
 * Clear both floor breadcrumbs on an at-floor serve (auto-recover). Returns true
 * when something was cleared (a recovery just happened), so the caller can log /
 * notify the parent that the session is back at floor.
 */
export function clearFloorBreadcrumbs(record: SessionRecord): boolean {
  const acpx = record.acpx;
  if (!acpx) {
    return false;
  }
  const had = acpx.served_below_floor !== undefined || acpx.floor_parked !== undefined;
  delete acpx.served_below_floor;
  delete acpx.floor_parked;
  return had;
}

/** True when a below-floor episode is already open (for notification debounce). */
export function belowFloorEpisodeOpen(record: SessionRecord): boolean {
  return record.acpx?.served_below_floor !== undefined;
}

/**
 * Read the served model from the transcript and stamp the per-turn served block
 * (model + derived effort) onto the record. Returns the served model (or
 * undefined when unreadable / non-Claude — the served block is then left as-is).
 * Deliberately does NOT touch the desired pin.
 */
export async function captureServedState(record: SessionRecord): Promise<string | undefined> {
  const servedModel = await readLastServedModel(record);
  if (!servedModel) {
    return undefined;
  }
  const servedEffort = deriveServedEffort(pinnedEffortFloor(record), servedModel);
  setServedState(record, {
    model: servedModel,
    effort: servedEffort,
    source: "claude-transcript",
  });
  return servedModel;
}
