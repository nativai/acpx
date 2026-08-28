import { spawn } from "node:child_process";
import path from "node:path";
import { CopilotAcpUnsupportedError } from "../errors.js";
import {
  buildSpawnCommandOptions,
  readWindowsEnvValue,
  resolveWindowsCommand,
} from "../spawn-command-options.js";
import { type AcpClientOptions } from "../types.js";
import { basenameToken, splitCommandLine } from "./client-process.js";
import { isCodexAcpCommand } from "./codex-compat.js";

const DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const QODER_AGENT_CLOSE_AFTER_STDIN_END_MS = 750;
const GEMINI_ACP_STARTUP_TIMEOUT_MS = 15_000;
const CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = 60_000;
const GEMINI_VERSION_TIMEOUT_MS = 2_000;
const GEMINI_ACP_FLAG_VERSION = [0, 33, 0] as const;
const COPILOT_HELP_TIMEOUT_MS = 2_000;

type GeminiVersion = {
  raw: string;
  parts: [number, number, number];
};

const QODER_BENIGN_STDOUT_LINES = new Set([
  "Received interrupt signal. Cleaning up resources...",
  "Cleanup completed. Exiting...",
]);

export function resolveAgentCloseAfterStdinEndMs(agentCommand: string): number {
  const { command } = splitCommandLine(agentCommand);
  return basenameToken(command) === "qodercli"
    ? QODER_AGENT_CLOSE_AFTER_STDIN_END_MS
    : DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS;
}

export function shouldIgnoreNonJsonAgentOutputLine(
  agentCommand: string,
  trimmedLine: string,
): boolean {
  const { command } = splitCommandLine(agentCommand);
  return basenameToken(command) === "qodercli" && QODER_BENIGN_STDOUT_LINES.has(trimmedLine);
}

export function isGeminiAcpCommand(command: string, args: readonly string[]): boolean {
  return (
    basenameToken(command) === "gemini" &&
    (args.includes("--acp") || args.includes("--experimental-acp"))
  );
}

export function isClaudeAcpCommand(command: string, args: readonly string[]): boolean {
  const commandToken = basenameToken(command);
  if (commandToken === "claude-agent-acp") {
    return true;
  }
  return args.some((arg) => arg.includes("claude-agent-acp"));
}

// String-level variant of isClaudeAcpCommand for callers that hold the unsplit
// agentCommand (e.g. the model-floor served-transcript reader, which is only
// meaningful for the SDK adapter that writes the `<acpSessionId>.jsonl` with
// `assistant.message.model`).
export function isClaudeAcpAgentCommand(agentCommand: string): boolean {
  const { command, args } = splitCommandLine(agentCommand);
  return isClaudeAcpCommand(command, args);
}

// The claude-pty bridge (independent-claude-acp). Matches the bootstrapped
// built default (`node /opt/claude-pty-acp/dist/index.js`), the root shim,
// and dev overrides via ACPX_CLAUDE_PTY_ACP_COMMAND or a config.json `agents`
// entry pointing at a checkout (any path containing the repo name or the
// server script name). Deliberately does NOT overlap isClaudeAcpCommand
// ("claude-agent-acp"), so the SDK-adapter-specific handling never applies.
export function isClaudePtyAcpCommand(command: string, args: readonly string[]): boolean {
  return [command, ...args].some(
    (part) => part.includes("claude-pty-acp") || part.includes("acp-server-transcript"),
  );
}

// String-level variant for callers that hold the unsplit agentCommand
// (auth-env validation, session-create compatibility checks).
export function isClaudePtyAgentCommand(agentCommand: string): boolean {
  const { command, args } = splitCommandLine(agentCommand);
  return isClaudePtyAcpCommand(command, args);
}

export function isCopilotAcpCommand(command: string, args: readonly string[]): boolean {
  return basenameToken(command) === "copilot" && args.includes("--acp");
}

/**
 * Which `_meta` channel carries the OS primer for a given agent (CONCEPTION
 * §4.3). Routed by the substring command detectors — NOT
 * `resolveAgentNameFromCommand`, which requires an exact registry-string match
 * and would miss dev overrides / `--agent` custom commands.
 *
 *  - `system-prompt`           → claude + claude-pty (`_meta.systemPrompt {append}`)
 *  - `developer-instructions`  → codex (`_meta.codex.developerInstructions`)
 *  - `none`                    → unknown agents (inject nothing — safe)
 */
export type PrimerChannel = "system-prompt" | "developer-instructions" | "none";

export function resolvePrimerChannel(agentCommand: string): PrimerChannel {
  const { command, args } = splitCommandLine(agentCommand);
  if (isClaudeAcpCommand(command, args) || isClaudePtyAcpCommand(command, args)) {
    return "system-prompt";
  }
  if (isCodexAcpCommand(command, args)) {
    return "developer-instructions";
  }
  return "none";
}

/**
 * The canonical ADAPTER TYPE for an agent command, derived from the substring
 * command detectors (NOT `resolveAgentNameFromCommand`, which requires an exact
 * registry-string match). Two command spellings that drive the same adapter map
 * to the same kind — most notably the claude-pty bridge, whose deployed
 * `.../dist/index.js` (registry default) and `.../acp-server-transcript.mjs`
 * root shim are byte-for-byte the same program (the shim just re-exports
 * `dist/index.js`), plus any `ACPX_CLAUDE_PTY_ACP_COMMAND` / config `agents`
 * override pointing at a checkout. Returns `undefined` for a raw/unknown command
 * so callers can fall back to strict command-string identity for genuine escape
 * hatches. Used by the copy/fork agent-lock so a same-adapter copy under a
 * different command spelling is not misread as a cross-agent copy.
 */
export function acpAdapterKind(agentCommand: string): string | undefined {
  // A record can carry an empty agent_command (e.g. a never-configured stub);
  // splitCommandLine rejects an empty command, so short-circuit to unknown.
  if (!agentCommand.trim()) {
    return undefined;
  }
  const { command, args } = splitCommandLine(agentCommand);
  // claude-pty before claude: the detectors are disjoint (acp-server-transcript
  // / claude-pty-acp vs claude-agent-acp), but keep the PTY check first for
  // clarity, matching the ordering convention elsewhere.
  if (isClaudePtyAcpCommand(command, args)) {
    return "claude-pty";
  }
  if (isClaudeAcpCommand(command, args)) {
    return "claude";
  }
  if (isCodexAcpCommand(command, args)) {
    return "codex";
  }
  if (isGeminiAcpCommand(command, args)) {
    return "gemini";
  }
  if (isCopilotAcpCommand(command, args)) {
    return "copilot";
  }
  return undefined;
}

/**
 * Compose the primer `_meta` fragment for a session request (CONCEPTION §4.4).
 * The fragment OWNS `systemPrompt` / `codex.developerInstructions`, so the
 * caller must merge it AFTER `optionsMeta` to win.
 *
 * `humanSystemPrompt` is the value already routed into `optionsMeta.systemPrompt`
 * by `assignClaudeCodeSystemPrompt` (a string = `--system-prompt` replace, or
 * `{ append }` = `--append-system-prompt`).
 *
 *  - system-prompt channel: `systemPrompt = { append: PRIMER_PLUS }`, where
 *    PRIMER_PLUS = primer then (if the human passed `--append-system-prompt T`)
 *    `"\n\n---\n\n" + T` — primer FIRST (foundational, cacheable), human append
 *    LAST (most salient). A human REPLACE (string) is the power-user escape
 *    hatch (Q4): return `undefined` so the replace survives untouched and the
 *    auto-primer is skipped.
 *  - developer-instructions channel: `codex.developerInstructions = primer`
 *    (no human-append channel for codex today).
 */
export function buildPrimerSessionMeta(
  channel: PrimerChannel,
  primer: string | undefined,
  humanSystemPrompt?: unknown,
  brickContext?: string,
): Record<string, unknown> | undefined {
  if (channel === "none") {
    return undefined;
  }
  const primerText = nonEmptyString(primer);
  const brickText = nonEmptyString(brickContext);

  if (channel === "developer-instructions") {
    const developerInstructions = joinPromptFragments([primerText, brickText]);
    return developerInstructions ? { codex: { developerInstructions } } : undefined;
  }

  // system-prompt channel (claude, claude-pty).
  if (typeof humanSystemPrompt === "string" && humanSystemPrompt.length > 0) {
    // Human `--system-prompt` replace wins — skip the auto-primer and brick context (Q4/W10).
    return undefined;
  }
  const humanAppend = readAppendString(humanSystemPrompt);
  const primerPlus = joinPromptFragments([primerText, brickText, humanAppend]);
  if (!primerPlus) {
    return undefined;
  }
  return { systemPrompt: { append: primerPlus } };
}

function joinPromptFragments(parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return present.length > 0 ? present.join("\n\n---\n\n") : undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The `.append` string of a `{ append }` system-prompt value, if present. */
function readAppendString(value: unknown): string | undefined {
  if (
    !!value &&
    typeof value === "object" &&
    "append" in value &&
    typeof (value as { append: unknown }).append === "string" &&
    (value as { append: string }).append.length > 0
  ) {
    return (value as { append: string }).append;
  }
  return undefined;
}

export function isQoderAcpCommand(command: string, args: readonly string[]): boolean {
  return basenameToken(command) === "qodercli" && args.includes("--acp");
}

function hasCommandFlag(args: readonly string[], flagName: string): boolean {
  return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}

function normalizeQoderAllowedToolName(tool: string): string {
  switch (tool.trim().toLowerCase()) {
    case "bash":
    case "glob":
    case "grep":
    case "ls":
    case "read":
    case "write":
      return tool.trim().toUpperCase();
    default:
      return tool.trim();
  }
}

export function buildQoderAcpCommandArgs(
  initialArgs: readonly string[],
  options: Pick<AcpClientOptions, "sessionOptions">,
): string[] {
  const args = [...initialArgs];
  const sessionOptions = options.sessionOptions;

  if (typeof sessionOptions?.maxTurns === "number" && !hasCommandFlag(args, "--max-turns")) {
    args.push(`--max-turns=${sessionOptions.maxTurns}`);
  }

  if (
    Array.isArray(sessionOptions?.allowedTools) &&
    !hasCommandFlag(args, "--allowed-tools") &&
    !hasCommandFlag(args, "--disallowed-tools")
  ) {
    const encodedTools = sessionOptions.allowedTools.map(normalizeQoderAllowedToolName).join(",");
    args.push(`--allowed-tools=${encodedTools}`);
  }

  return args;
}

export function resolveGeminiAcpStartupTimeoutMs(): number {
  const raw = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return GEMINI_ACP_STARTUP_TIMEOUT_MS;
}

export function resolveClaudeAcpSessionCreateTimeoutMs(): number {
  const raw = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
}

function parseGeminiVersion(value: string | undefined): GeminiVersion | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  const match = normalized.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return undefined;
  }

  return {
    raw: normalized,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

function compareVersionParts(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

async function detectGeminiVersion(command: string): Promise<GeminiVersion | undefined> {
  const output = await readCommandOutput(command, ["--version"], GEMINI_VERSION_TIMEOUT_MS);
  const versionLine = output
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\d+\.\d+\.\d+/.test(line));
  return parseGeminiVersion(versionLine);
}

export async function resolveGeminiCommandArgs(
  command: string,
  args: readonly string[],
): Promise<string[]> {
  if (basenameToken(command) !== "gemini" || !args.includes("--acp")) {
    return [...args];
  }

  const version = await detectGeminiVersion(command);
  if (version && compareVersionParts(version.parts, GEMINI_ACP_FLAG_VERSION) < 0) {
    return args.map((arg) => (arg === "--acp" ? "--experimental-acp" : arg));
  }

  return [...args];
}

async function readCommandOutput(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    const child = spawn(
      command,
      [...args],
      buildSpawnCommandOptions(command, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      finish(undefined);
    });
    child.once("close", () => {
      finish(`${stdout}\n${stderr}`);
    });
  });
}

export async function buildGeminiAcpStartupTimeoutMessage(command: string): Promise<string> {
  const parts = [
    "Gemini CLI ACP startup timed out before initialize completed.",
    "This usually means the local Gemini CLI is waiting on interactive OAuth or has incompatible ACP subprocess behavior.",
  ];

  const version = await detectGeminiVersion(command);
  if (version) {
    parts.push(`Detected Gemini CLI version: ${version.raw}.`);
  }

  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    parts.push("No GEMINI_API_KEY or GOOGLE_API_KEY was set for non-interactive auth.");
  }

  parts.push("Try upgrading Gemini CLI and using API-key-based auth for non-interactive ACP runs.");
  return parts.join(" ");
}

export function buildClaudeAcpSessionCreateTimeoutMessage(): string {
  return [
    "Claude ACP session creation timed out before session/new completed.",
    "This matches the known persistent-session stall seen with some Claude Code and @agentclientprotocol/claude-agent-acp combinations.",
    "In harnessed or non-interactive runs, prefer --approve-all with nonInteractivePermissions=deny, upgrade Claude Code and the Claude ACP adapter, or use acpx claude exec as a one-shot fallback.",
  ].join(" ");
}

async function buildCopilotAcpUnsupportedMessage(command: string): Promise<string> {
  const parts = [
    "GitHub Copilot CLI ACP stdio mode is not available in the installed copilot binary.",
    "acpx copilot expects a Copilot CLI release that supports --acp --stdio.",
  ];

  const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
  if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) {
    parts.push("Detected copilot --help output without --acp support.");
  }

  parts.push(
    "Upgrade GitHub Copilot CLI to a release with ACP stdio support, or use --agent with another ACP-compatible adapter in the meantime.",
  );
  return parts.join(" ");
}

export async function ensureCopilotAcpSupport(command: string): Promise<void> {
  const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
  if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) {
    throw new CopilotAcpUnsupportedError(await buildCopilotAcpUnsupportedMessage(command), {
      retryable: false,
    });
  }
}

export function buildClaudeCodeOptionsMeta(
  options: AcpClientOptions["sessionOptions"],
): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }

  const claudeCodeOptions: Record<string, unknown> = {};
  assignClaudeCodeOptions(claudeCodeOptions, options);

  const meta: Record<string, unknown> = {};
  const claudeCode: Record<string, unknown> = {};
  if (Object.keys(claudeCodeOptions).length > 0) {
    claudeCode.options = claudeCodeOptions;
  }
  // brick://874fee67: the output style travels as its OWN `_meta.claudeCode`
  // field, a SIBLING of `options` — deliberately NOT inside
  // `claudeCode.options.settings`. The adapter drops its own `creationSettings`
  // entirely when the caller supplies `settings`, so routing the style that way
  // would silently disable the reasoning-effort pin: a regression in an
  // unrelated feature, with no error anywhere. The adapter folds this field into
  // its own creationSettings instead (design §2.3(e)).
  //
  // This is the ONLY path by which a style reaches Claude Code. The adapter
  // composes the system prompt when it builds the query, so a style that misses
  // this `_meta` does not merely arrive late — it never arrives at all until the
  // next query is built.
  if (typeof options.outputStyle === "string" && options.outputStyle.trim().length > 0) {
    claudeCode.outputStyle = options.outputStyle;
  }
  if (Object.keys(claudeCode).length > 0) {
    meta.claudeCode = claudeCode;
  }

  assignClaudeCodeSystemPrompt(meta, options.systemPrompt);

  if (Object.keys(meta).length === 0) {
    return undefined;
  }

  return meta;
}

function assignClaudeCodeOptions(
  target: Record<string, unknown>,
  options: NonNullable<AcpClientOptions["sessionOptions"]>,
): void {
  if (typeof options.model === "string" && options.model.trim().length > 0) {
    target.model = options.model;
  }
  if (Array.isArray(options.allowedTools)) {
    target.allowedTools = [...options.allowedTools];
  }
  if (typeof options.maxTurns === "number") {
    target.maxTurns = options.maxTurns;
  }
}

function assignClaudeCodeSystemPrompt(
  target: Record<string, unknown>,
  systemPrompt: NonNullable<AcpClientOptions["sessionOptions"]>["systemPrompt"],
): void {
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    target.systemPrompt = systemPrompt;
    return;
  }
  if (isAppendSystemPrompt(systemPrompt)) {
    target.systemPrompt = { append: systemPrompt.append };
  }
}

function isAppendSystemPrompt(
  value: NonNullable<AcpClientOptions["sessionOptions"]>["systemPrompt"],
): value is { append: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.append === "string" &&
    value.append.length > 0
  );
}

export function resolveClaudeCodeExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  if (readWindowsEnvValue(env, "CLAUDE_CODE_EXECUTABLE")) {
    return undefined;
  }
  const resolved = resolveWindowsCommand("claude", env);
  if (!resolved) {
    return undefined;
  }
  return path.resolve(resolved);
}
