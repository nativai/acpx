import { AGENT_REGISTRY } from "../agent-registry.js";
import type { SessionAgentOptions } from "../runtime/engine/session-options.js";

export const DEFAULT_CODEX_MODEL = "gpt-5.5[xhigh]";

function hasRequestedModel(sessionOptions: SessionAgentOptions | undefined): boolean {
  return typeof sessionOptions?.model === "string" && sessionOptions.model.trim().length > 0;
}

function isBuiltInCodexCommand(agentCommand: string): boolean {
  return agentCommand.trim() === AGENT_REGISTRY.codex.trim();
}

export function withDefaultModelForNewSession(
  agentCommand: string,
  sessionOptions: SessionAgentOptions | undefined,
): SessionAgentOptions | undefined {
  if (!isBuiltInCodexCommand(agentCommand) || hasRequestedModel(sessionOptions)) {
    return sessionOptions;
  }
  return { ...sessionOptions, model: DEFAULT_CODEX_MODEL };
}
