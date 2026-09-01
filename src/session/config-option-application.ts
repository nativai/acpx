import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { withTimeout } from "../async-control.js";
import type { SessionRecord } from "../types.js";
import { applyConfigOptionsToRecord } from "./config-options.js";
import { getDesiredConfigOptions, setDesiredConfigOption } from "./mode-preference.js";
import { assertOutputStyleAdvertised, OUTPUT_STYLE_CONFIG_ID } from "./output-style.js";

/** Minimal client surface so this is unit-testable with a stub. */
export interface ConfigOptionApplyClient {
  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ configOptions?: SessionConfigOption[] }>;
}

/** Whether the advertised option set includes a given config id (e.g. `effort`). */
export function advertisesConfigOption(
  advertised: SessionConfigOption[] | undefined,
  configId: string,
): boolean {
  return (advertised ?? []).some((option) => option.id === configId);
}

// Effort ids are adapter-defined strings, but acpx deliberately knows the
// comparable ordered levels so inherited/requested values can be safely mapped
// across model vocabularies. `default` is intentionally not on the scale: when a
// source value cannot be placed here, fall back to the child model's advertised
// default/current effort instead of guessing.
const ORDERED_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_LEVEL_RANKS = new Map<string, number>(
  ORDERED_EFFORT_LEVELS.map((level, index) => [level, index]),
);

/**
 * Ordinal rank of an effort level on the shared `low<medium<high<xhigh<max`
 * ladder, or undefined for an unknown/opaque value (e.g. `default`). The single
 * source of truth for effort ordering — the model-floor check reuses it so a
 * "served effort ≥ pinned effort" comparison never re-hardcodes the ladder.
 */
export function effortRank(level: string | undefined): number | undefined {
  if (typeof level !== "string") {
    return undefined;
  }
  return EFFORT_LEVEL_RANKS.get(level.trim());
}
const SONNET_CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high"]);
const HAIKU_CLAUDE_EFFORT_LEVELS = new Set(["high"]);

export function normalizeEffortLevelForAdvertisedOption(
  requestedLevel: string,
  option: SessionConfigOption,
  modelId?: string,
): string | undefined {
  if (option.type !== "select") {
    return undefined;
  }
  const supported = effortLevelsForModel(modelId) ?? selectableValues(option);
  const requested = requestedLevel.trim();
  if (requested === "default" && supported.has(requested)) {
    return requested;
  }
  const requestedRank = EFFORT_LEVEL_RANKS.get(requested);
  if (requestedRank === undefined) {
    return advertisedDefaultEffort(option, supported, modelId);
  }
  if (supported.has(requested)) {
    return requested;
  }
  return (
    nearestSupportedEffort(requestedRank, supported) ??
    advertisedDefaultEffort(option, supported, modelId)
  );
}

export function normalizeEffortLevelForModel(
  requestedLevel: string,
  modelId: string | undefined,
): string | undefined {
  const supported = effortLevelsForModel(modelId);
  if (!supported) {
    return undefined;
  }
  const requested = requestedLevel.trim();
  if (requested === "default" && supported.has(requested)) {
    return requested;
  }
  const requestedRank = EFFORT_LEVEL_RANKS.get(requested);
  if (requestedRank === undefined) {
    return modelDefaultEffort(modelId, supported);
  }
  if (supported.has(requested)) {
    return requested;
  }
  return nearestSupportedEffort(requestedRank, supported) ?? modelDefaultEffort(modelId, supported);
}

// Apply one config option to the live session when it is advertised, the value
// can be normalized to a supported value, and it differs from the current value
// — otherwise skip (never error: "layer on top, never break"). Returns the
// normalized value plus the set-response (for record capture) or undefined when
// skipped.
type ConfigOptionApplyResult = {
  value: string;
  response?: { configOptions?: SessionConfigOption[] };
};

type ConfigOptionApplyParams = {
  client: ConfigOptionApplyClient;
  sessionId: string;
  configId: string;
  value: string;
  advertised: SessionConfigOption[];
  modelId?: string;
  timeoutMs?: number;
  verbose?: boolean;
};

async function applyConfigOptionIfAdvertised(
  params: ConfigOptionApplyParams,
): Promise<ConfigOptionApplyResult | undefined> {
  const option = params.advertised.find((entry) => entry.id === params.configId);
  if (!option || option.type !== "select") {
    return undefined; // not advertised, or not a selectable option (e.g. codex effort)
  }
  const value = supportedConfigOptionValue(params.configId, params.value, option, params.modelId);
  if (!value) {
    if (params.verbose) {
      process.stderr.write(
        `[acpx] config option ${params.configId}=${params.value} is not an advertised level for this model; skipping\n`,
      );
    }
    return undefined; // model-coupled level unsupported → skip
  }
  if (params.verbose && value !== params.value) {
    process.stderr.write(
      `[acpx] config option ${params.configId}=${params.value} is not advertised for this model; applying ${value}\n`,
    );
  }
  if (option.currentValue === value) {
    return { value }; // already at the normalized value
  }
  const response = await setConfigOptionWithEffortFallback(params, option, value);
  return { value: response.value, response: response.response };
}

async function setConfigOptionWithEffortFallback(
  params: ConfigOptionApplyParams,
  option: SessionConfigOption,
  value: string,
): Promise<ConfigOptionApplyResult> {
  try {
    const response = await withTimeout(
      params.client.setSessionConfigOption(params.sessionId, params.configId, value),
      params.timeoutMs,
    );
    return { value, response };
  } catch (error) {
    if (params.configId !== "effort") {
      throw error;
    }
    return rejectedEffortFallback(option, params.modelId, value, params.verbose);
  }
}

function rejectedEffortFallback(
  option: SessionConfigOption,
  modelId: string | undefined,
  value: string,
  verbose: boolean | undefined,
): ConfigOptionApplyResult {
  const fallback = advertisedDefaultEffort(
    option,
    effortLevelsForModel(modelId) ?? selectableValues(option),
    modelId,
  );
  if (verbose) {
    process.stderr.write(
      `[acpx] config option effort=${value} was rejected by the agent; keeping ${fallback ?? "default"}\n`,
    );
  }
  return { value: fallback ?? value };
}

/**
 * Apply the record's desired config options (e.g. `effort`) to the live ACP
 * session at creation — the config-option analogue of
 * `applyRequestedModelIfAdvertised`. It is `replayDesiredConfigOptions`
 * (reconnect.ts) run at creation against the create-result's advertised options,
 * plus the advertised-value guard above. The set-response's refreshed options are
 * captured back onto the record.
 *
 * NOTE: the deployed claude-agent-acp (0.39.0) rebuilds the advertised `effort`
 * `currentValue` from the global settings default on every response, so the live
 * snapshot may NOT reflect the just-applied per-session level — the durable
 * signal is `acpx.desired_config_options.effort`, written by the caller.
 */
export async function applyRequestedConfigOptionsIfAdvertised(params: {
  client: ConfigOptionApplyClient;
  sessionId: string;
  record: SessionRecord;
  advertised: SessionConfigOption[] | undefined;
  modelId?: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  const desired = getDesiredConfigOptions(params.record.acpx);
  const advertised = params.advertised ?? [];

  for (const [configId, value] of Object.entries(desired)) {
    const result = await applyConfigOptionIfAdvertised({
      client: params.client,
      sessionId: params.sessionId,
      configId,
      value,
      advertised,
      modelId: params.modelId,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    if (!result) {
      continue;
    }
    if (configId === "effort" && result.value !== value) {
      setDesiredConfigOption(params.record, "effort", result.value);
    }
    if (result.response) {
      applyConfigOptionsToRecord(params.record, result.response);
    }
  }
}

/**
 * Creation-site entry point for the `--reasoning-effort` spawn flag on the
 * record-backed paths (`sessions new`/`ensure`, persistent `prompt`). Persists
 * the requested level as the durable intent (`acpx.desired_config_options.effort`)
 * and applies it live before the first prompt — but ONLY when the session
 * advertises an `effort` option, so a non-claude agent (e.g. codex) never gains
 * an effort field and the flag is a silent no-op there (the CLI emits the
 * user-facing "ignored" warning).
 */
export async function persistAndApplyRequestedEffort(params: {
  client: ConfigOptionApplyClient;
  sessionId: string;
  record: SessionRecord;
  reasoningEffort: string | undefined;
  advertised: SessionConfigOption[] | undefined;
  modelId?: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.reasoningEffort || !advertisesConfigOption(params.advertised, "effort")) {
    return;
  }
  setDesiredConfigOption(params.record, "effort", params.reasoningEffort);
  await applyRequestedConfigOptionsIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    record: params.record,
    advertised: params.advertised,
    modelId: params.modelId,
    timeoutMs: params.timeoutMs,
    verbose: params.verbose,
  });
}

/**
 * Creation-site entry point for the `--output-style` spawn flag (brick://874fee67).
 *
 * ⚠️ NOT "persistAndApply" — and the missing half is the R-6 inversion, not an
 * omission. `persistAndApplyRequestedEffort` performs a creation-time apply
 * round-trip precisely BECAUSE the adapter applies effort to the live SDK query.
 * Output style is already in force from the creation settings the query was
 * BUILT with (it travelled in the session/new `_meta`), so there is nothing left
 * to apply — and applying it would be the forbidden move. Do not "restore" an
 * apply call here, and do not fix a perceived gap by making the adapter apply.
 *
 * What IS kept from the effort sibling, and why each matters:
 * - the `advertisesConfigOption` GATE — this gate IS the honest degradation. On
 *   an agent with no output-style concept (codex) the flag writes NOTHING and
 *   errors nothing; the CLI has already warned on stderr. Dropping it would
 *   persist a style for a session that can never honour one.
 * - the PERSIST via `setDesiredConfigOption`, which writes the live
 *   `desired_config_options.outputStyle` and, through the mode-preference sync,
 *   the durable `session_options.output_style` a respawn re-applies.
 *
 * Validation happens here rather than at the adapter because Claude Code accepts
 * ANY string as a style name and echoes it back as active — so an unvalidated
 * typo produces a session that reports a style it does not have.
 */
export function persistRequestedOutputStyle(params: {
  record: SessionRecord;
  outputStyle: string | undefined;
  advertised: SessionConfigOption[] | undefined;
  agentLabel: string;
}): void {
  if (!params.outputStyle) {
    return;
  }
  if (!advertisesConfigOption(params.advertised, OUTPUT_STYLE_CONFIG_ID)) {
    // Silent no-op by design (the CLI emits the user-facing "ignored" warning).
    return;
  }
  assertOutputStyleAdvertised(params.advertised, params.outputStyle, params.agentLabel);
  setDesiredConfigOption(params.record, OUTPUT_STYLE_CONFIG_ID, params.outputStyle);
}

/**
 * `exec` variant — the one-shot path has no persisted record, so this applies
 * the effort live to the ephemeral session for the single turn (no persistence).
 * Same advertised/supported/differing guard, so codex `exec` is a no-op.
 */
export async function applyExecReasoningEffort(params: {
  client: ConfigOptionApplyClient;
  sessionId: string;
  reasoningEffort: string | undefined;
  advertised: SessionConfigOption[] | undefined;
  modelId?: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.reasoningEffort) {
    return;
  }
  await applyConfigOptionIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    configId: "effort",
    value: params.reasoningEffort,
    advertised: params.advertised ?? [],
    modelId: params.modelId,
    timeoutMs: params.timeoutMs,
    verbose: params.verbose,
  });
}

function selectableValues(option: SessionConfigOption): Set<string> {
  const values = new Set<string>();
  if (option.type !== "select") {
    return values;
  }
  // Defense-in-depth (de290ae4): a malformed/older adapter can advertise a
  // `type:"select"` option with `options` absent — `for…of` over undefined would
  // throw the raw "… is not iterable" TypeError (the exact symptom class from the
  // codex version-skew crash). Treat a missing list as "no selectable values".
  for (const entry of option.options ?? []) {
    if ("value" in entry) {
      values.add(entry.value);
    } else {
      for (const grouped of entry.options ?? []) {
        values.add(grouped.value);
      }
    }
  }
  return values;
}

function supportedConfigOptionValue(
  configId: string,
  requestedValue: string,
  option: SessionConfigOption,
  modelId: string | undefined,
): string | undefined {
  if (configId === "effort") {
    return normalizeEffortLevelForAdvertisedOption(requestedValue, option, modelId);
  }
  return selectableValues(option).has(requestedValue) ? requestedValue : undefined;
}

function nearestSupportedEffort(
  requestedRank: number,
  supported: ReadonlySet<string>,
): string | undefined {
  let best: { value: string; rank: number; distance: number } | undefined;
  for (const value of supported) {
    const rank = EFFORT_LEVEL_RANKS.get(value);
    if (rank === undefined) {
      continue;
    }
    const distance = Math.abs(rank - requestedRank);
    if (isBetterEffortMatch(distance, rank, best)) {
      best = { value, rank, distance };
    }
  }
  return best?.value;
}

function isBetterEffortMatch(
  distance: number,
  rank: number,
  best: { rank: number; distance: number } | undefined,
): boolean {
  if (!best || distance < best.distance) {
    return true;
  }
  // If two supported levels are equally near, prefer the lower effort. That is
  // deterministic and avoids silently exceeding the requested intensity.
  return distance === best.distance && rank < best.rank;
}

function advertisedDefaultEffort(
  option: SessionConfigOption,
  supported: ReadonlySet<string>,
  modelId: string | undefined,
): string | undefined {
  if (option.type !== "select") {
    return undefined;
  }
  const current = typeof option.currentValue === "string" ? option.currentValue.trim() : "";
  if (current && supported.has(current)) {
    return current;
  }
  const modelDefault = modelDefaultEffort(modelId, supported);
  if (modelDefault) {
    return modelDefault;
  }
  if (supported.has("default")) {
    return "default";
  }
  return [...supported][0];
}

function effortLevelsForModel(modelId: string | undefined): ReadonlySet<string> | undefined {
  const model = modelId?.trim().toLowerCase();
  if (!model) {
    return undefined;
  }
  // The Claude adapter may report stale/broad effort lists in session/new. The
  // follow-up session/set_config_option call is stricter: sonnet accepts the
  // compact low/medium/high set, while haiku currently advertises broad levels
  // but rejects effort mutation outright. Keep haiku at its advertised default
  // `high` so spawn-time effort never aborts the child session.
  if (model.includes("haiku")) {
    return HAIKU_CLAUDE_EFFORT_LEVELS;
  }
  if (model.includes("sonnet")) {
    return SONNET_CLAUDE_EFFORT_LEVELS;
  }
  return undefined;
}

function modelDefaultEffort(
  modelId: string | undefined,
  supported: ReadonlySet<string>,
): string | undefined {
  const model = modelId?.trim().toLowerCase();
  if (!model) {
    return undefined;
  }
  if ((model.includes("sonnet") || model.includes("haiku")) && supported.has("high")) {
    return "high";
  }
  return undefined;
}
