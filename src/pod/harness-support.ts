/**
 * A-39 (brick b69eeecf): the terminal harness `claude-pty` is NOT in phase 1 — a pod hosts claude, codex
 * and pi only. This is the predicate every pod path asks BEFORE it asks the broker for anything.
 *
 * ⚠️ WHY A PREDICATE OF ITS OWN, NOT `acpAdapterKind`: that classifier has no `claude-pty` kind (brick
 * 19461b95), so a real record's harness reads as UNDEFINED there — which refused it only by accident (an
 * unknown harness is `harness_unsupported`). This one names it, so the refusal stays a decision if
 * the classifier ever learns the kind. LIGHT MODULE: no imports (the placement step loads it).
 *
 * Same test atrium applies (acpx-ui `shared/agentType.ts`): the repo name or the script name as a path
 * segment — a real record's command is `node /opt/claude-pty-acp/dist/index.js`.
 */
const CLAUDE_PTY_ACP_COMMAND = /(?:^|[\s/])claude-pty-acp(?:@|[\s/]|$)/;
const ACP_SERVER_TRANSCRIPT_COMMAND = /(?:^|[\s/])acp-server-transcript(?:@|[\s/.]|$)/;

export function isClaudePtyCommand(agentCommand: string | undefined): boolean {
  const command = (agentCommand ?? "").trim();
  // The bare name is the agent id acpx used to register (a config `agents` override may spell it so).
  return (
    command === "claude-pty" ||
    CLAUDE_PTY_ACP_COMMAND.test(command) ||
    ACP_SERVER_TRANSCRIPT_COMMAND.test(command)
  );
}

/**
 * The agent command a command line names: `--agent <cmd>`, else the positional agent's registry command,
 * else the config's default agent — `undefined` when it cannot be resolved. ⚠️ HEAVY (dynamic imports
 * only, so this module stays light): config and the agent registry.
 */
export async function invocationAgentCommand(
  agent: string | undefined,
  argv: readonly string[],
): Promise<string | undefined> {
  const { flagValue } = await import("./utility-branch.js");
  const override = flagValue(argv, "--agent")?.trim();
  if (override) {
    return override;
  }
  try {
    const [{ loadResolvedConfig }, registry] = await Promise.all([
      import("../cli/config.js"),
      import("../agent-registry.js"),
    ]);
    const config = await loadResolvedConfig(flagValue(argv, "--cwd") ?? process.cwd());
    return registry.resolveAgentCommand(
      agent ?? config.defaultAgent ?? registry.DEFAULT_AGENT_NAME,
      config.agents,
    );
  } catch {
    return undefined;
  }
}
