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
  if (latest.model !== undefined) {
    merged.model = latest.model;
  }
  if (latest.effort !== undefined) {
    merged.effort = latest.effort;
  }
  if (latest.auto_failover !== undefined) {
    merged.auto_failover = latest.auto_failover;
  }
  return hasSessionOptions(merged) ? merged : undefined;
}

function hasLatestDurableSessionOptions(
  latest: NonNullable<SessionAcpxState["session_options"]>,
): boolean {
  return (
    latest.model !== undefined || latest.effort !== undefined || latest.auto_failover !== undefined
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

  if (
    typeof sessionOptions.model === "string" ||
    Array.isArray(sessionOptions.allowed_tools) ||
    typeof sessionOptions.max_turns === "number" ||
    sessionOptions.system_prompt !== undefined
  ) {
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
