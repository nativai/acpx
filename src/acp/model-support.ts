import type { SessionModelState } from "@agentclientprotocol/sdk";
import { isClaudeAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";

export class RequestedModelUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestedModelUnsupportedError";
  }
}

// A trailing `[Nm]` (e.g. `sonnet[1m]`, `opus[1m]`) is a context-window MODIFIER on a
// base model, not a distinct model id. The adapter resolves it away before matching
// (claude-agent-acp resolveModelPreference / MODEL_CONTEXT_HINT_PATTERN), so it advertises
// only base names. Mirror that stripping here so the acpx gate is never stricter than the
// agent it guards — otherwise a `[1m]`-pinned model throws on replay even though the
// adapter would accept it.
const MODEL_CONTEXT_HINT_PATTERN = /\[\d+m\]$/i;

function stripModelContextHint(modelId: string): string {
  return modelId.replace(MODEL_CONTEXT_HINT_PATTERN, "");
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
  // Accept the requested model if EITHER its exact id OR its context-hint-stripped base
  // (`sonnet[1m]` -> `sonnet`) is advertised. The original alias is still what gets forwarded
  // to setSessionModel by the callers; the adapter re-resolves the hint. A genuinely-unknown
  // model (no advertised base, e.g. `gpt-9`) still throws.
  if (
    !advertised.has(params.requestedModel) &&
    !advertised.has(stripModelContextHint(params.requestedModel))
  ) {
    const action = params.context === "replay" ? "replay saved model" : "apply --model";
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise that model. Available models: ${formatAvailableModelIds(params.models)}.`,
    );
  }
}
