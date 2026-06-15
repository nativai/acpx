import { isClaudeAcpCommand, isClaudePtyAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";
import { isCodexAcpCommand } from "./codex-compat.js";

export function supportsMidTurnPromptInjection(agentCommand: string): boolean {
  try {
    const { command, args } = splitCommandLine(agentCommand);
    return (
      isClaudeAcpCommand(command, args) ||
      isCodexAcpCommand(command, args) ||
      // The claude-pty bridge's interactive TUI supports native mid-turn steering, so
      // enable injection: a steer is typed straight into the running terminal rather
      // than serialized behind the active turn. (Was omitted only because this gate
      // predated the bridge; not a deliberate exclusion.)
      isClaudePtyAcpCommand(command, args)
    );
  } catch {
    return false;
  }
}
