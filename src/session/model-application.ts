import type { AcpClient, SessionCreateResult } from "../acp/client.js";
import { assertRequestedModelSupported } from "../acp/model-support.js";
import { withTimeout } from "../async-control.js";
import type { SessionRecord } from "../types.js";

export async function applyRequestedModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: SessionCreateResult["models"];
  agentCommand?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const requestedModel =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!requestedModel) {
    return false;
  }
  assertRequestedModelSupported({
    requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    context: "apply",
  });
  if (!params.models) {
    return false;
  }
  if (params.models.currentModelId === requestedModel) {
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
