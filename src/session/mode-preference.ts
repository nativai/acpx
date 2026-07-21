import type { SessionModelState } from "@agentclientprotocol/sdk";
import type { SessionAcpxState, SessionRecord } from "../types.js";

function ensureAcpxState(state: SessionAcpxState | undefined): SessionAcpxState {
  return state ?? {};
}

export function normalizeModeId(modeId: string | undefined): string | undefined {
  if (typeof modeId !== "string") {
    return undefined;
  }
  const trimmed = modeId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const trimmed = modelId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getDesiredModeId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModeId(state?.desired_mode_id);
}

export function getDesiredConfigOptions(
  state: SessionAcpxState | undefined,
): Record<string, string> {
  const desired = state?.desired_config_options;
  if (!desired) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(desired).flatMap(([configId, value]) => {
      const normalizedConfigId = normalizeModeId(configId);
      return normalizedConfigId && typeof value === "string" ? [[normalizedConfigId, value]] : [];
    }),
  );
}

export function setDesiredModeId(record: SessionRecord, modeId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModeId(modeId);

  if (normalized) {
    acpx.desired_mode_id = normalized;
  } else {
    delete acpx.desired_mode_id;
  }

  record.acpx = acpx;
}

export function setDesiredConfigOption(
  record: SessionRecord,
  configId: string,
  value: string | undefined,
): void {
  const normalizedConfigId = normalizeModeId(configId);
  if (!normalizedConfigId || normalizedConfigId === "mode" || normalizedConfigId === "model") {
    return;
  }

  const acpx = ensureAcpxState(record.acpx);
  const desired = { ...acpx.desired_config_options };

  if (typeof value === "string") {
    desired[normalizedConfigId] = value;
  } else {
    delete desired[normalizedConfigId];
  }

  if (Object.keys(desired).length > 0) {
    acpx.desired_config_options = desired;
  } else {
    delete acpx.desired_config_options;
  }

  if (normalizedConfigId === "effort") {
    setSessionOptionEffort(acpx, value);
  }

  record.acpx = acpx;
}

function setSessionOptionEffort(acpx: SessionAcpxState, value: string | undefined): void {
  const sessionOptions = { ...acpx.session_options };
  if (typeof value === "string") {
    sessionOptions.effort = value;
  } else {
    delete sessionOptions.effort;
  }

  if (hasSessionOptions(sessionOptions)) {
    acpx.session_options = sessionOptions;
  } else {
    delete acpx.session_options;
  }
}

function hasSessionOptions(options: NonNullable<SessionAcpxState["session_options"]>): boolean {
  return Object.values(options).some((value) => value !== undefined);
}

export function mergeLatestDurableAcpxPreferences(
  pending: SessionAcpxState | undefined,
  latest: SessionAcpxState | undefined,
): SessionAcpxState | undefined {
  const latestState = cloneAcpxStateForPreferenceMerge(latest);
  if (!latestState) {
    return cloneAcpxStateForPreferenceMerge(pending);
  }

  const merged = cloneAcpxStateForPreferenceMerge(pending) ?? {};

  // Runtime turn/checkpoint writers can race with `acpx set ...`. Keep durable
  // intent from the store so a stale turn snapshot does not erase replay input.
  if (latestState.desired_mode_id !== undefined) {
    merged.desired_mode_id = latestState.desired_mode_id;
  }
  if (latestState.desired_config_options) {
    merged.desired_config_options = {
      ...merged.desired_config_options,
      ...latestState.desired_config_options,
    };
  }

  const sessionOptions = mergeLatestDurableSessionOptions(
    merged.session_options,
    latestState.session_options,
  );
  if (sessionOptions) {
    merged.session_options = sessionOptions;
  }

  return merged;
}

function cloneAcpxStateForPreferenceMerge(
  state: SessionAcpxState | undefined,
): SessionAcpxState | undefined {
  return state ? structuredClone(state) : undefined;
}

function mergeLatestDurableSessionOptions(
  pending: SessionAcpxState["session_options"],
  latest: SessionAcpxState["session_options"],
): SessionAcpxState["session_options"] {
  if (!latest) {
    return pending;
  }
  if (!hasLatestDurableSessionOptions(latest)) {
    return pending;
  }

  const merged = { ...pending };
  // Overlay each durable field from the latest disk state (brick://07dd62c9): a
  // disk-side change (set model / policy toggle) during an in-flight turn must win
  // over the stale turn snapshot. model_source rides alongside `model` so a
  // provenance change carries too (brick://5bac5564 Layer C).
  overlayDurableSessionOptionFields(merged, latest);
  return hasSessionOptions(merged) ? merged : undefined;
}

type DurableSessionOptions = NonNullable<SessionAcpxState["session_options"]>;

function overlayDurableSessionOptionFields(
  merged: DurableSessionOptions,
  latest: DurableSessionOptions,
): void {
  if (latest.model !== undefined) {
    merged.model = latest.model;
  }
  if (latest.model_source !== undefined) {
    merged.model_source = latest.model_source;
  }
  if (latest.effort !== undefined) {
    merged.effort = latest.effort;
  }
  if (latest.auto_failover !== undefined) {
    merged.auto_failover = latest.auto_failover;
  }
  if (latest.floor_hard !== undefined) {
    merged.floor_hard = latest.floor_hard;
  }
  if (latest.auto_subscription !== undefined) {
    merged.auto_subscription = latest.auto_subscription;
  }
  if (latest.fable_degrade_ok !== undefined) {
    merged.fable_degrade_ok = latest.fable_degrade_ok;
  }
}

function hasLatestDurableSessionOptions(
  latest: NonNullable<SessionAcpxState["session_options"]>,
): boolean {
  return (
    latest.model !== undefined ||
    latest.model_source !== undefined ||
    latest.effort !== undefined ||
    latest.auto_failover !== undefined ||
    latest.floor_hard !== undefined ||
    latest.auto_subscription !== undefined ||
    latest.fable_degrade_ok !== undefined
  );
}

export function getDesiredModelId(state: SessionAcpxState | undefined): string | undefined {
  return normalizeModelId(state?.session_options?.model);
}

export function setDesiredModelId(record: SessionRecord, modelId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(modelId);
  const sessionOptions = { ...acpx.session_options };

  if (normalized) {
    sessionOptions.model = normalized;
  } else {
    delete sessionOptions.model;
  }

  // Keep session_options iff ANY field remains (brick://07dd62c9): the old
  // hand-rolled guard checked only model/allowed_tools/max_turns/system_prompt, so
  // clearing the model dropped the WHOLE block — silently discarding floor_hard /
  // auto_failover / effort / subscription / profile / breadcrumbs. hasSessionOptions
  // is the complete Object.values check and mirrors persist/merge emptiness logic.
  if (hasSessionOptions(sessionOptions)) {
    acpx.session_options = sessionOptions;
  } else {
    delete acpx.session_options;
  }

  record.acpx = acpx;
}

// brick://5bac5564 Layer C: set/clear the flat-string model provenance alongside
// `session_options.model`. Mirrors setDesiredModelId's emptiness discipline so a
// cleared source never resurrects (or strands) the session_options block.
export function setDesiredModelSource(record: SessionRecord, source: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(source);
  const sessionOptions = { ...acpx.session_options };

  if (normalized) {
    sessionOptions.model_source = normalized;
  } else {
    delete sessionOptions.model_source;
  }

  if (hasSessionOptions(sessionOptions)) {
    acpx.session_options = sessionOptions;
  } else {
    delete acpx.session_options;
  }

  record.acpx = acpx;
}

export function setCurrentModelId(record: SessionRecord, modelId: string | undefined): void {
  const acpx = ensureAcpxState(record.acpx);
  const normalized = normalizeModelId(modelId);

  if (normalized) {
    acpx.current_model_id = normalized;
  } else {
    delete acpx.current_model_id;
  }

  record.acpx = acpx;
}

export function syncAdvertisedModelState(
  record: SessionRecord,
  models: SessionModelState | undefined,
): void {
  if (!models) {
    return;
  }

  const acpx = ensureAcpxState(record.acpx);
  acpx.current_model_id = models.currentModelId;
  acpx.available_models = models.availableModels.map((model) => model.modelId);
  record.acpx = acpx;
}
