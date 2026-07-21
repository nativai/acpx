import type { AcpClient, SessionCreateResult } from "../acp/client.js";
import { assertRequestedModelSupported } from "../acp/model-support.js";
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
