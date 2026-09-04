import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { SessionCreateResult } from "../acp/client.js";
import {
  acpxRoutesModelMechanism,
  harnessIdForAgentCommand,
  modelMechanismForAgentCommand,
  resolveHarnessCapabilities,
} from "../acp/harness-capabilities.js";
import {
  assertRequestedModelSupported,
  RequestedModelUnsupportedError,
} from "../acp/model-support.js";
import { withTimeout } from "../async-control.js";
import type { SessionRecord } from "../types.js";
import { selectableConfigOptionValues } from "./config-option-application.js";
import { guardServedModel } from "./model-guard.js";

/** The ACP config-option id a `config-option` harness carries its model on (I1 R5). */
export const MODEL_CONFIG_OPTION_ID = "model";

/**
 * Minimal client surface, so the dispatcher is unit-testable with a stub and so
 * each arm's dependency is visible. `AcpClient` satisfies it structurally.
 */
export interface ModelApplyClient {
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ configOptions?: SessionConfigOption[] }>;
}

/**
 * What applying a model produced.
 *
 * `refreshedConfigOptions` is **the post-model re-read** (CONCEPTION §5.2 —
 * "the single easiest thing in the whole program to get subtly wrong"). OpenCode
 * advertises the `effort` option **only when the currently-selected model
 * reasons**, and at `session/new` with the default model it is absent (I1 R8).
 * `session/set_config_option` answers with a REFRESHED advertisement, so the
 * options that describe the session after the model change come back on this
 * field for free — no second round-trip, and no snapshot to go stale.
 *
 * ⚠️ It is `undefined` for every other mechanism, and that is not a gap:
 * `session/set_model` returns nothing to re-read, and the caller must then keep
 * using the `session/new` advertisement. A caller that treats `undefined` as
 * "no options advertised" would delete claude's working depth path.
 */
export interface ModelApplyOutcome {
  applied: boolean;
  refreshedConfigOptions?: SessionConfigOption[];
}

interface ModelApplyParams {
  client: ModelApplyClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: SessionCreateResult["models"];
  agentCommand?: string;
  timeoutMs?: number;
  /** brick://5bac5564 Layer B belt: the pin's provenance. When present and
   *  non-explicit, a Fable pin is force-redirected to the non-Fable default;
   *  absent (legacy / caller opted out) grandfathers it (HoD Q4). */
  modelSource?: string;
  /**
   * The session's advertised config options. Required only by the
   * `config-option` arm, which validates the requested id against the advertised
   * `model` option before sending anything — the guard that keeps FINDINGS-opencode
   * D2 (a stored value acpx can never apply) from returning by a new door.
   */
  advertisedConfigOptions?: SessionConfigOption[];
  /**
   * Whether this is the FIRST application or a REPLAY onto a reconnected session.
   * It only shapes the error wording — the DISPATCH is identical, deliberately.
   *
   * ⚠️ THIS PARAMETER EXISTS BECAUSE APPLY AND REPLAY DIVERGED ONCE AND IT COST A
   * SILENT BRICK (F-9). B3 gave the APPLY path a config-option arm and left the
   * REPLAY path on the generic check, so `acpx opencode set model` reported
   * success, persisted the pin, and then every later turn died in
   * `assertRequestedModelSupported` — WITH rc=0, so only the empty content showed
   * it. Two code paths asking the same question two ways is what made that
   * possible; they are ONE function now so they cannot answer differently again.
   */
  context?: "apply" | "replay";
}

/**
 * Apply a requested model to a live ACP session, dispatching on the harness's
 * MODEL MECHANISM rather than assuming there is only one.
 *
 * Before B3 this function assumed `set-model`: it called
 * `assertRequestedModelSupported` unconditionally, which throws when `models` is
 * undefined — OpenCode's exact shape (no ACP `models` array, no
 * `session/set_model`; the model is a config option, I1 R5/R11). That is why
 * `acpx opencode set model` reported success and then bricked the session
 * unrecoverably (FINDINGS-opencode D2): acpx persisted a value it replays on
 * every reconnect through a path that can never apply it.
 *
 * The `config-option` arm routes to `session/set_config_option` — **the path
 * `mode` already takes successfully today** (`acpx opencode set mode plan`
 * works, D2's own contrast). It is not a new mechanism; it is the existing one,
 * reached for the axis that needed it.
 *
 * ⚠️ An agent command the descriptor does not classify keeps the generic
 * `set-model` path. Answering with a neighbouring harness's mechanism would send
 * a `session/set_config_option` to an adapter that never advertised one.
 */
export async function applyRequestedModelIfAdvertised(
  params: ModelApplyParams,
): Promise<ModelApplyOutcome> {
  const rawRequested =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!rawRequested) {
    return { applied: false };
  }
  const guarded = guardServedModel({
    requestedModel: rawRequested,
    modelSource: params.modelSource,
    availableModels: params.models?.availableModels.map((model) => model.modelId),
  });
  const requestedModel = guarded.model ?? rawRequested;

  if (routesModelAsConfigOption(params.agentCommand)) {
    return await applyModelAsConfigOption(params, requestedModel);
  }
  return await applyModelAsSetModel(params, requestedModel, guarded.forced);
}

/**
 * Whether this agent command's model reaches the harness as a config option AND
 * acpx routes that mechanism. Both terms are required: the descriptor states
 * what the harness needs, the routing list states what acpx has a branch for,
 * and the derived capability is their AND.
 */
function routesModelAsConfigOption(agentCommand: string | undefined): boolean {
  const mechanism = modelMechanismForAgentCommand(agentCommand);
  return mechanism === "config-option" && acpxRoutesModelMechanism(mechanism);
}

/** The pre-B3 generic path, unchanged: claude, claude-pty, codex and pi. */
async function applyModelAsSetModel(
  params: ModelApplyParams,
  requestedModel: string,
  guardForced: boolean,
): Promise<ModelApplyOutcome> {
  assertRequestedModelSupported({
    requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    context: params.context ?? "apply",
  });
  if (!params.models) {
    return { applied: false };
  }
  if (!guardForced && params.models.currentModelId === requestedModel) {
    return { applied: true };
  }
  await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel),
    params.timeoutMs,
  );
  // ⚠️ Deliberately NO `refreshedConfigOptions`. `session/set_model` returns
  // nothing to re-read, so the caller must keep the `session/new` advertisement —
  // see `advertisedAfterModelApply`.
  return { applied: true };
}

/**
 * The advertisement to use AFTER a model was applied — the post-model re-read,
 * in one place so the rule cannot be got wrong at one call site out of four.
 *
 * ⚠️ `undefined` refreshed options means "this mechanism had nothing to re-read",
 * NOT "nothing is advertised". Collapsing the two deletes claude's and
 * claude-pty's working depth path, which is why this is a named function rather
 * than a `??` repeated at each site.
 */
export function advertisedAfterModelApply(
  outcome: ModelApplyOutcome,
  sessionNewAdvertisement: SessionConfigOption[] | undefined,
): SessionConfigOption[] | undefined {
  return outcome.refreshedConfigOptions ?? sessionNewAdvertisement;
}

/**
 * The `config-option` arm: validate against the advertised `model` option, then
 * `session/set_config_option`, and hand the refreshed advertisement back.
 *
 * ⚠️ The validation is the load-bearing half, not the send. OpenCode resolves a
 * model against its BUNDLED catalogue and rejects an unknown slug **locally,
 * before any network call** (I1 R6) — so an unvalidated send fails at the
 * adapter with an unusable error (`{"name":"UnknownError"}`, the real cause only
 * in its debug log, I1 "Useless user-facing errors"), and acpx would already
 * have persisted the value. Refusing here means nothing is written and the
 * session stays usable, which is the whole point of D2's fix.
 *
 * An id that is genuinely wanted but not in the bundled catalogue is reached by
 * PROVISIONING it — `provider.openrouter.models.<id>` in the per-session
 * `opencode.json` — after which it IS advertised and this check passes. The
 * check is therefore not a ceiling on "any OpenRouter model"; it is the thing
 * that makes an unprovisioned slug fail honestly instead of silently.
 */
async function applyModelAsConfigOption(
  params: ModelApplyParams,
  requestedModel: string,
): Promise<ModelApplyOutcome> {
  const option = (params.advertisedConfigOptions ?? []).find(
    (entry) => entry.id === MODEL_CONFIG_OPTION_ID,
  );
  if (!option || option.type !== "select") {
    throw new RequestedModelUnsupportedError(
      `Cannot apply --model "${requestedModel}": this agent selects its model through ` +
        `session/set_config_option, but it advertised no selectable "${MODEL_CONFIG_OPTION_ID}" ` +
        `config option for this session. Nothing was written — the session is unchanged.`,
    );
  }
  const advertised = selectableConfigOptionValues(option);
  if (!advertised.has(requestedModel)) {
    throw new RequestedModelUnsupportedError(
      `Cannot apply --model "${requestedModel}": the agent did not advertise that model ` +
        `(${advertised.size} advertised). This harness resolves models against its own bundled ` +
        `catalogue and rejects an unknown id locally, so acpx refuses before persisting one it ` +
        `could never apply. Nothing was written — the session is unchanged.`,
    );
  }
  if (option.currentValue === requestedModel) {
    return { applied: true };
  }
  const response = await withTimeout(
    params.client.setSessionConfigOption(params.sessionId, MODEL_CONFIG_OPTION_ID, requestedModel),
    params.timeoutMs,
  );
  return { applied: true, refreshedConfigOptions: response.configOptions };
}

/**
 * THE LOUD-FAILURE GATE for a live model change acpx cannot apply (B0.2;
 * FINDINGS-opencode **D2**, row `G1-OC-04`).
 *
 * It runs BEFORE anything is persisted, and the ordering is the entire fix. On
 * OpenCode the model is an ACP **config option** (`session/set_config_option`,
 * I1 R5/R11) — there is no `models` array and no `session/set_model` — so acpx's
 * generic path stored a `session_options.model` it could never apply, and the
 * session then became **unrecoverable**: every later connect replayed the bad
 * stored value first, so even setting the model *back* failed. A success message
 * for a value the adapter rejected is the worst of both: the user believes the
 * model changed, and the session is dead.
 *
 * The predicate is the descriptor's `canSetModelLive`, which is DERIVED from the
 * harness's mechanism AND from whether acpx routes that mechanism today
 * (`MODEL_MECHANISMS_ROUTED_BY_ACPX`). B3 landed the config-option apply path
 * and the list entry in one commit, so this gate opened on its own — with no
 * edit here and no edit to the table. That is the derivation working, and it is
 * why neither this function nor `HARNESS_FACTS` was touched to achieve it.
 *
 * ⚠️ It refuses only for a harness the descriptor KNOWS. An unrecognised agent
 * command falls through to the pre-existing advertised-models check below — the
 * gate must not start refusing model changes on adapters it has never classified.
 */
export function assertLiveModelChangeRoutable(record: SessionRecord): void {
  const harness = harnessIdForAgentCommand(record.agentCommand);
  if (harness === undefined) {
    return;
  }
  // Pass the session's own advertisement so the answer can only NARROW, never
  // widen — the descriptor's stated one-way property.
  const advertised = record.acpx?.config_options;
  const capabilities = resolveHarnessCapabilities(
    harness,
    advertised ? { configOptions: advertised } : undefined,
  );
  if (capabilities.canSetModelLive) {
    return;
  }
  throw new RequestedModelUnsupportedError(
    `Cannot set the model on this ${harness} session: ` +
      `${capabilities.liveModelChangeReason ?? "acpx has no live model path for this harness."} ` +
      `Nothing was written — the session is unchanged and still usable.`,
  );
}

export function assertRecordModelSupported(params: {
  record: SessionRecord;
  requestedModel: string;
  context?: "apply" | "replay";
}): void {
  // A config-option harness carries no ACP `models` array at all, so the
  // advertised-models check below is not the gate for it — its gate is the
  // advertised `model` config option, checked inside the apply arm against a
  // LIVE advertisement. Re-checking here against `acpx.available_models` (which
  // a config-option session never populates) could only ever produce a false
  // refusal on replay, which is D2's failure mode wearing the fix's clothes.
  if (modelMechanismForAgentCommand(params.record.agentCommand) === "config-option") {
    return;
  }
  const availableModels = params.record.acpx?.available_models;
  if (!availableModels || availableModels.length === 0) {
    return;
  }
  const models = {
    currentModelId: params.record.acpx?.current_model_id ?? "",
    availableModels: availableModels.map((modelId) => ({ modelId, name: modelId })),
  };
  assertRequestedModelSupported({
    requestedModel: params.requestedModel,
    models,
    agentCommand: params.record.agentCommand,
    context: params.context ?? "apply",
  });
}
