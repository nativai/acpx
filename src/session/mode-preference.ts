import type { SessionModelState } from "@agentclientprotocol/sdk";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import { cloneSessionAcpxState } from "./conversation-model.js";

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

  // brick://874fee67: keep the DURABLE session_options.output_style in sync with
  // the live desired_config_options.outputStyle, exactly as `effort` does above.
  // Without this the live setter writes only the live layer and the next owner
  // respawn — which rebuilds session_options from the spawn flags — silently
  // reverts the style. The style reaches Claude Code ONLY through the adapter's
  // creation settings, so that revert is a real behaviour change.
  if (normalizedConfigId === "outputStyle") {
    setSessionOptionOutputStyle(acpx, value);
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

function setSessionOptionOutputStyle(acpx: SessionAcpxState, value: string | undefined): void {
  const sessionOptions = { ...acpx.session_options };
  if (typeof value === "string") {
    sessionOptions.output_style = value;
  } else {
    delete sessionOptions.output_style;
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

/**
 * The durable session_options fields a disk-side write must be able to push past
 * a stale in-flight-turn snapshot (brick://07dd62c9).
 *
 * ⚠️ ONE list, deliberately, feeding BOTH the overlay and the has-any predicate
 * below. They are a matched pair: the predicate gates whether the overlay runs at
 * all, so a field added to the overlay alone is a silent no-op for any change
 * that touches ONLY that field — visible in exactly one state, which is the state
 * nobody writes a test for (brick://67d2fd2f is this class). Sharing the list
 * makes that divergence unrepresentable rather than merely discouraged.
 *
 * Adding a field here is the whole edit; there is no second place to update.
 */
const DURABLE_OVERLAY_FIELDS = [
  "model",
  // model_source rides alongside `model` so a provenance change carries too
  // (brick://5bac5564 Layer C).
  "model_source",
  "effort",
  // brick://874fee67: a disk-side `set outputStyle` during an in-flight turn must
  // beat the stale turn snapshot, exactly as `effort` does.
  "output_style",
  "auto_failover",
  "floor_hard",
  "auto_subscription",
  "fable_degrade_ok",
] as const satisfies ReadonlyArray<keyof DurableSessionOptions>;

function overlayDurableSessionOptionFields(
  merged: DurableSessionOptions,
  latest: DurableSessionOptions,
): void {
  for (const field of DURABLE_OVERLAY_FIELDS) {
    const value = latest[field];
    if (value !== undefined) {
      // `field` is a known key and the value came from the same slot on `latest`,
      // so the assignment is type-correct; the heterogeneous field union defeats a
      // direct typed assignment, so index via an unknown-valued view (not `any`).
      (merged as Record<string, unknown>)[field] = value;
    }
  }
}

function hasLatestDurableSessionOptions(latest: DurableSessionOptions): boolean {
  return DURABLE_OVERLAY_FIELDS.some((field) => latest[field] !== undefined);
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

/**
 * Record the per-session harness config dir this spawn wrote (brick fa2e54ec).
 *
 * ⚠️ It is REFRESHED ON EVERY SPAWN, not written once, because the directory is
 * per-spawn: the create spawn names it with a freshly minted uuid (the record id
 * does not exist until `session/new` returns), while later spawns name it with
 * the record id. A stale value would point acpx-ui at a directory that was
 * removed on close, which is a DETECTABLE error rather than a silent fallback —
 * but only if the value is kept current.
 *
 * `undefined` CLEARS the field rather than leaving the previous value: a harness
 * that stops getting a config dir must not keep advertising a path.
 */
export function setHarnessConfigDir(record: SessionRecord, dir: string | undefined): void {
  const normalized = dir?.trim();
  // ⚠️ NOTHING TO WRITE ⇒ TOUCH NOTHING (RS-14). Only opencode and pi ever get a
  // config dir, so this runs with `undefined` on every claude / claude-pty /
  // codex spawn — and those records must not gain the key, be it a value, a
  // `null` or an `{}`. An unconditional `record.acpx = clone ?? {}` would give a
  // record whose `acpx` was previously ABSENT an empty object, changing the
  // record SHAPE for three harnesses the programme requires untouched. Record
  // shape is consumed by parse, serialize, the index projection and the UI, so
  // "we added a field but it is empty for you" is still a behaviour change.
  if (!normalized && record.acpx?.harness_config_dir === undefined) {
    return;
  }
  const acpx = cloneSessionAcpxState(record.acpx) ?? {};
  if (normalized) {
    acpx.harness_config_dir = normalized;
  } else {
    // A spawn that wrote no dir CLEARS a previous value rather than leaving it:
    // a stale path that still resolves is a silent wrong answer, which is worse
    // than a miss (see AgentLifecycleSnapshot.harnessConfigDir).
    delete acpx.harness_config_dir;
  }
  record.acpx = acpx;
}

/**
 * Record — or CLEAR — the learned fact that this adapter does not implement
 * `session/set_model` (F-12, brick 2dc93747).
 *
 * ⚠️ IT IS TWO-WAY ON PURPOSE, AND THAT IS THE LOAD-BEARING HALF. Measured on
 * the rig with the adapter swapped under an identical acpx:
 *
 *   pi-acp 0.0.26 -> set model rc=0, record and current_model_id both updated
 *   pi-acp 0.0.33 -> set model rc=1, -32601 Method not found   (this is what ships)
 *
 * So the capability EXISTED, REGRESSED OUT, and is expected to RETURN in our
 * fork. A flag that could only ever subtract would make that restoration
 * INVISIBLE: the session would keep hiding a control that had started working
 * again. A successful `session/set_model` therefore clears it, on the same
 * evidence standard that set it — the adapter answering.
 *
 * ⚠️ It is also why the static descriptor must NOT be hand-edited to `false`.
 * The cell was TRUE when written and went stale; a permanent claim about a
 * capability that comes and goes with the adapter build is wrong in both
 * directions, and no version-citation discipline survives that sequence.
 *
 * The key is DELETED rather than set to `false` when clearing, so a record that
 * never learned anything is byte-identical to one that learned and recovered.
 */
export function setModelSetMethodUnsupported(record: SessionRecord, unsupported: boolean): void {
  if (!unsupported && record.acpx?.model_set_unsupported_for === undefined) {
    return; // nothing to clear — leave the record shape untouched
  }
  const acpx = cloneSessionAcpxState(record.acpx) ?? {};
  if (unsupported) {
    // The KEY, not a flag: what was learned, and which adapter it was learned on.
    acpx.model_set_unsupported_for = record.agentCommand;
  } else {
    delete acpx.model_set_unsupported_for;
  }
  record.acpx = acpx;
}

/**
 * Whether this record's LEARNED refusal still applies to the adapter it would
 * launch TODAY (F-12).
 *
 * ⚠️ A learned fact from a DIFFERENT adapter is not evidence about this one. When
 * the key does not match, the answer is "unknown" and the capability is re-probed
 * by simply trying — which is how a restored method becomes visible again.
 */
export function modelSetMethodKnownUnsupported(record: SessionRecord): boolean {
  const learnedOn = record.acpx?.model_set_unsupported_for;
  return typeof learnedOn === "string" && learnedOn === record.agentCommand;
}
