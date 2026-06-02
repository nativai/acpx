import { isClaudeAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";
import { isCodexAcpCommand } from "./codex-compat.js";

export function supportsMidTurnPromptInjection(agentCommand: string): boolean {
  try {
    const { command, args } = splitCommandLine(agentCommand);
    return isClaudeAcpCommand(command, args) || isCodexAcpCommand(command, args);
  } catch {
    return false;
  }
}
