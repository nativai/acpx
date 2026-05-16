import type { SessionModelState } from "@agentclientprotocol/sdk";
import { isClaudeAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";

export class RequestedModelUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestedModelUnsupportedError";
  }
}

export function supportsLegacyClaudeCodeModelMetadata(agentCommand: string | undefined): boolean {
  if (!agentCommand) {
    return false;
  }
  const { command, args } = splitCommandLine(agentCommand);
  return isClaudeAcpCommand(command, args);
}

export function formatAvailableModelIds(models: SessionModelState | undefined): string {
  const ids =
    models?.availableModels
      .map((model) => model.modelId.trim())
      .filter((modelId) => modelId.length > 0) ?? [];
  return ids.length > 0 ? ids.join(", ") : "none advertised";
}

export function assertRequestedModelSupported(params: {
  requestedModel: string;
  models: SessionModelState | undefined;
  agentCommand?: string;
  context: "apply" | "replay";
}): void {
  if (!params.models) {
    if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) {
      return;
    }
    const action = params.context === "replay" ? "replay saved model" : "apply --model";
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise model support. Generic model selection requires ACP models plus session/set_model support, or an adapter-specific startup model flag.`,
    );
  }

  const advertised = new Set(params.models.availableModels.map((model) => model.modelId));
  if (!advertised.has(params.requestedModel)) {
    const action = params.context === "replay" ? "replay saved model" : "apply --model";
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise that model. Available models: ${formatAvailableModelIds(params.models)}.`,
    );
  }
}
