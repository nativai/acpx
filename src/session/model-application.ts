import type { AcpClient, SessionCreateResult } from "../acp/client.js";
import {
  harnessIdForAgentCommand,
  resolveHarnessCapabilities,
} from "../acp/harness-capabilities.js";
import {
  assertRequestedModelSupported,
  RequestedModelUnsupportedError,
} from "../acp/model-support.js";
import { withTimeout } from "../async-control.js";
import type { SessionRecord } from "../types.js";
import { guardServedModel } from "./model-guard.js";

export async function applyRequestedModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: SessionCreateResult["models"];
  agentCommand?: string;
  timeoutMs?: number;
  /** brick://5bac5564 Layer B belt: the pin's provenance. When present and
   *  non-explicit, a Fable pin is force-redirected to the non-Fable default;
   *  absent (legacy / caller opted out) grandfathers it (HoD Q4). */
  modelSource?: string;
}): Promise<boolean> {
  const rawRequested =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!rawRequested) {
    return false;
  }
  const guarded = guardServedModel({
    requestedModel: rawRequested,
    modelSource: params.modelSource,
    availableModels: params.models?.availableModels.map((model) => model.modelId),
  });
  const requestedModel = guarded.model ?? rawRequested;
  assertRequestedModelSupported({
    requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    context: "apply",
  });
  if (!params.models) {
    return false;
  }
  if (!guarded.forced && params.models.currentModelId === requestedModel) {
    return true;
  }

  await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel),
    params.timeoutMs,
  );
  return true;
}

/**
 * THE LOUD-FAILURE GATE for a live model change acpx cannot apply (B0.2;
 * FINDINGS-opencode **D2**, row `G1-OC-04`).
 *
 * It runs BEFORE anything is persisted, and the ordering is the entire fix. On
 * OpenCode today the model is an ACP **config option** (`session/set_config_option`,
 * I1 R5/R11) — there is no `models` array and no `session/set_model` — so acpx's
 * generic path stored a `session_options.model` it can never apply, and the
 * session then became **unrecoverable**: every later connect replayed the bad
 * stored value first, so even setting the model *back* failed. A success message
 * for a value the adapter rejected is the worst of both: the user believes the
 * model changed, and the session is dead.
 *
 * The predicate is the descriptor's `canSetModelLive`, which is DERIVED from the
 * harness's mechanism AND from whether acpx routes that mechanism today
 * (`MODEL_MECHANISMS_ROUTED_BY_ACPX`). So when B3 lands the config-option apply
 * path, this gate opens on its own, with no edit here and no edit to the table.
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
