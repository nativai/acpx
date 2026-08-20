import { open } from "node:fs/promises";
import { isClaudeAcpAgentCommand } from "../acp/agent-command.js";
import {
  activeTranscriptConfigDir,
  resolveExistingTranscriptPath,
} from "../config/subscription-transcript.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { effortRank, normalizeEffortLevelForModel } from "./config-option-application.js";
import { isoNow } from "./persistence.js";

// ─── Model-family comparison ────────────────────────────────────────────────
//
// acpx has NO model-rank system (verified: the only model-family logic is
// `isFableModel`, a substring check). A pinned model is EXACT — the floor is
// "served == pinned" — and the harness only ever downgrades (never silently
// serves a MORE expensive model), so "served family ≠ pinned family" is exactly
// "below floor". We compare FAMILIES (fable / opus / sonnet / haiku) so an alias
// pin ("fable") matches its served full id ("claude-fable-5"), mirroring how
// `isFableModel` already treats "fable" as a substring family.

const KNOWN_MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
const MODEL_CONTEXT_HINT_PATTERN = /\[\d+m\]$/i;

/**
 * Normalize a model id/alias to a comparable family token. Returns a known
 * family (`fable`/`opus`/`sonnet`/`haiku`) when the id contains it, else the
 * lowercased, context-hint-stripped id so two spellings of an unknown model
 * still compare by equality.
 */
export function modelFamily(modelId: string | null | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim().toLowerCase().replace(MODEL_CONTEXT_HINT_PATTERN, "");
  if (normalized.length === 0) {
    return undefined;
  }
  for (const family of KNOWN_MODEL_FAMILIES) {
    if (normalized.includes(family)) {
      return family;
    }
  }
  return normalized;
}

/** True when the served model is the SAME family as the pinned model. */
export function servedModelMatchesFloor(
  pinnedModel: string | undefined,
  servedModel: string | undefined,
): boolean {
  const pinned = modelFamily(pinnedModel);
  const served = modelFamily(servedModel);
  if (pinned === undefined || served === undefined) {
    return false;
  }
  return pinned === served;
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
 * follows model, §1/§9): a model-family mismatch is below-floor regardless of
 * effort. When the model is at floor, an OPTIONALLY-supplied served effort (only
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
