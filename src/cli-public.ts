import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import type { ResolvedAcpxConfig } from "./cli/config.js";

type AgentTokenScan = {
  token?: string;
  hasAgentOverride: boolean;
};

type ConfigurePublicCliOptions = {
  program: Command;
  argv: string[];
  config: ResolvedAcpxConfig;
  requestedJsonStrict: boolean;
  topLevelVerbs: ReadonlySet<string>;
  listBuiltInAgents: (agents: ResolvedAcpxConfig["agents"]) => string[];
  detectAgentToken: (argv: string[]) => AgentTokenScan;
  registerAgentCommand: (program: Command, agentName: string, config: ResolvedAcpxConfig) => void;
  registerDefaultCommands: (program: Command, config: ResolvedAcpxConfig) => void;
  handlePromptAction: (command: Command, promptParts: string[]) => Promise<void>;
};

export function configurePublicCli(options: ConfigurePublicCliOptions): void {
  const builtInAgents = options.listBuiltInAgents(options.config.agents);

  for (const agentName of builtInAgents) {
    options.registerAgentCommand(options.program, agentName, options.config);
  }

  options.registerDefaultCommands(options.program, options.config);

  const scan = options.detectAgentToken(options.argv);
  if (
    !scan.hasAgentOverride &&
    scan.token &&
    !options.topLevelVerbs.has(scan.token) &&
    !builtInAgents.includes(scan.token)
  ) {
    options.registerAgentCommand(options.program, scan.token, options.config);
  }

  options.program.argument("[prompt...]", "Prompt text").action(async function (
    this: Command,
    promptParts: string[],
  ) {
    if (promptParts.length === 0 && process.stdin.isTTY) {
      if (options.requestedJsonStrict) {
        throw new InvalidArgumentError(
          "Prompt is required (pass as argument, --file, or pipe via stdin)",
        );
      }
      this.outputHelp();
      return;
    }

    await options.handlePromptAction(this, promptParts);
  });

  options.program.addHelpText(
    "after",
    `
Examples:
  acpx pi --session-id <id> "review recent changes"
  acpx openclaw exec "summarize active session state"
  acpx codex sessions new
  acpx codex --session-id <id> "fix the tests"
  acpx codex prompt --session-id <id> "fix the tests"
  acpx codex --session-id <id> --no-wait "queue follow-up task"
  acpx codex exec "what does this repo do"
  acpx codex cancel --session-id <id>
  acpx codex set-mode plan --session-id <id>
  acpx codex set model 'gpt-5.6-sol[high]' --session-id <id>
  acpx codex sessions
  acpx codex sessions new --name backend
  acpx codex sessions close --session-id <id>
  acpx codex status --session-id <id>
  acpx config show
  acpx config init
  acpx --ttl 30 codex --session-id <id> "investigate flaky tests"
  acpx claude --session-id <id> "refactor auth"
  acpx --agent ./my-custom-server "do something"`,
  );
}
