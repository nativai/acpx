import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveExistingTranscriptPath,
  transcriptJsonlPath,
} from "../config/subscription-transcript.js";
import { chooseSubscriptionConfigDir, loadSubscriptionRegistry } from "../config/subscriptions.js";
import { splitCommandLine } from "./client-process.js";

type ClaudeJsonlRecord = {
  type?: string;
  uuid?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: {
    content?: unknown;
  };
};

type ClaudeForkSessionModule = {
  forkSession: (
    sessionId: string,
    options?: {
      dir?: string;
      upToMessageId?: string;
    },
  ) => Promise<{
    sessionId?: unknown;
  }>;
};

export async function resolveClaudeUuidForAcpxIndex(args: {
  cwd: string;
  acpSessionId: string;
  forkAtIndex: number;
  subscriptionId?: string;
}): Promise<string | undefined> {
  if (args.forkAtIndex < 0) {
    return undefined;
  }

  const content = await readClaudeTranscript(args.cwd, args.acpSessionId, args.subscriptionId);
  if (content === undefined) {
    return undefined;
  }

  return lastClaudeUuidBeforeAcpxIndex(content, args.forkAtIndex - 1);
}

async function readClaudeTranscript(
  cwd: string,
  acpSessionId: string,
  subscriptionId: string | undefined,
): Promise<string | undefined> {
  const configDir = resolveClaudeConfigDir(subscriptionId);
  const resolved = await resolveExistingTranscriptPath(configDir, cwd, acpSessionId);
  if (!resolved) {
    return undefined;
  }
  try {
    return await fs.readFile(resolved.path, "utf8");
  } catch {
    return undefined;
  }
}

export async function materializeClaudeForkSession(args: {
  agentCommand: string;
  cwd: string;
  sourceCwd: string;
  sourceAcpSessionId: string;
  subscriptionId?: string;
  upToMessageId?: string;
}): Promise<string | undefined> {
  const sdk = await loadClaudeForkSessionModule(args.agentCommand);
  if (!sdk) {
    return undefined;
  }

  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = resolveClaudeConfigDir(args.subscriptionId);
  process.env.CLAUDE_CONFIG_DIR = configDir;
  let cleanupStagedTranscript: () => Promise<void> = async () => {};
  try {
    cleanupStagedTranscript = await stageClaudeSourceTranscriptForDestination({
      configDir,
      sourceCwd: args.sourceCwd,
      destinationCwd: args.cwd,
      sourceAcpSessionId: args.sourceAcpSessionId,
    });
    const result = await sdk.forkSession(args.sourceAcpSessionId, {
      dir: args.cwd,
      ...(args.upToMessageId ? { upToMessageId: args.upToMessageId } : {}),
    });
    return typeof result.sessionId === "string" && result.sessionId.length > 0
      ? result.sessionId
      : undefined;
  } finally {
    try {
      await cleanupStagedTranscript();
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      }
    }
  }
}

async function stageClaudeSourceTranscriptForDestination(args: {
  configDir: string;
  sourceCwd: string;
  destinationCwd: string;
  sourceAcpSessionId: string;
}): Promise<() => Promise<void>> {
  if (path.resolve(args.sourceCwd) === path.resolve(args.destinationCwd)) {
    return async () => {};
  }

  // Source may still sit under the pre-fix slug (brick://ae715773); fall back to
  // the primary path when neither exists so the readFile below fails naming the
  // canonical location. The DESTINATION is always primary — Claude Code is about
  // to read it, and it reads only that form.
  const resolvedSource = await resolveExistingTranscriptPath(
    args.configDir,
    args.sourceCwd,
    args.sourceAcpSessionId,
  );
  const sourcePath =
    resolvedSource?.path ??
    transcriptJsonlPath(args.configDir, args.sourceCwd, args.sourceAcpSessionId);
  const destinationPath = transcriptJsonlPath(
    args.configDir,
    args.destinationCwd,
    args.sourceAcpSessionId,
  );
  if (sourcePath === destinationPath) {
    return async () => {};
  }

  const sourceContent = await fs.readFile(sourcePath, "utf8");
  const existingDestinationContent = await readOptionalFile(destinationPath);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, sourceContent, "utf8");

  return async () => {
    if (existingDestinationContent === undefined) {
      await fs.unlink(destinationPath).catch((error: unknown) => {
        if (!isNotFoundError(error)) {
          throw error;
        }
      });
      return;
    }
    await fs.writeFile(destinationPath, existingDestinationContent, "utf8");
  };
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

export function resolveClaudeConfigDir(subscriptionId: string | undefined): string {
  const registry = loadSubscriptionRegistry();
  const choice = chooseSubscriptionConfigDir(subscriptionId, registry);
  return choice.configDir ?? path.join(os.homedir(), ".claude");
}

async function loadClaudeForkSessionModule(
  agentCommand: string,
): Promise<ClaudeForkSessionModule | undefined> {
  for (const specifier of claudeSdkModuleCandidates(agentCommand)) {
    try {
      const loaded: unknown = await import(specifier);
      const module = asClaudeForkSessionModule(loaded);
      if (module) {
        return module;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function claudeSdkModuleCandidates(agentCommand: string): string[] {
  const candidates = new Set<string>();
  const packageName = "@anthropic-ai/claude-agent-sdk";
  candidates.add(packageName);

  const { command, args } = splitCommandLine(agentCommand);
  const entrypoint = command === "node" && args[0] ? args[0] : command;
  const packageRoot = inferClaudeAgentPackageRoot(entrypoint);
  if (packageRoot) {
    candidates.add(
      pathToFileURL(
        path.join(packageRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"),
      ).href,
    );
  }

  candidates.add(
    pathToFileURL("/opt/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs").href,
  );

  return [...candidates];
}

function inferClaudeAgentPackageRoot(entrypoint: string): string | undefined {
  if (!path.isAbsolute(entrypoint)) {
    return undefined;
  }

  if (
    path.basename(entrypoint) === "index.js" &&
    path.basename(path.dirname(entrypoint)) === "dist"
  ) {
    return path.dirname(path.dirname(entrypoint));
  }

  return undefined;
}

function asClaudeForkSessionModule(value: unknown): ClaudeForkSessionModule | undefined {
  if (!isRecord(value) || typeof value.forkSession !== "function") {
    return undefined;
  }

  return value as ClaudeForkSessionModule;
}

function lastClaudeUuidBeforeAcpxIndex(
  content: string,
  targetAcpxIndex: number,
): string | undefined {
  let acpxIndex = -1;
  let lastUuid: string | undefined;

  for (const line of content.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const record = parseClaudeJsonlRecord(line);
    if (!record || !isIndexableClaudeRecord(record)) {
      continue;
    }

    const indexed = indexClaudeRecord(record, acpxIndex);
    if (!indexed) {
      continue;
    }
    acpxIndex = indexed.nextAcpxIndex;

    if (indexed.recordAcpxIndex > targetAcpxIndex) {
      break;
    }
    lastUuid = record.uuid;
  }

  return lastUuid;
}

function indexClaudeRecord(
  record: ClaudeJsonlRecord,
  currentAcpxIndex: number,
): { nextAcpxIndex: number; recordAcpxIndex: number } | undefined {
  if (isRealUserRecord(record)) {
    const nextAcpxIndex = currentAcpxIndex < 0 ? 0 : currentAcpxIndex + 2;
    return { nextAcpxIndex, recordAcpxIndex: nextAcpxIndex };
  }
  if (currentAcpxIndex < 0) {
    return undefined;
  }
  return { nextAcpxIndex: currentAcpxIndex, recordAcpxIndex: currentAcpxIndex + 1 };
}

function parseClaudeJsonlRecord(line: string): ClaudeJsonlRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? (parsed as ClaudeJsonlRecord) : undefined;
  } catch {
    return undefined;
  }
}

function isIndexableClaudeRecord(record: ClaudeJsonlRecord): record is ClaudeJsonlRecord & {
  type: "user" | "assistant";
  uuid: string;
} {
  return (
    (record.type === "user" || record.type === "assistant") &&
    typeof record.uuid === "string" &&
    record.uuid.length > 0 &&
    record.isMeta !== true &&
    record.isSidechain !== true &&
    record.isCompactSummary !== true
  );
}

function isRealUserRecord(record: ClaudeJsonlRecord): boolean {
  return record.type === "user" && !hasToolResultContent(record) && !isSlashCommandRecord(record);
}

function hasToolResultContent(record: ClaudeJsonlRecord): boolean {
  const content = record.message?.content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((entry) => isRecord(entry) && entry.type === "tool_result");
}

function isSlashCommandRecord(record: ClaudeJsonlRecord): boolean {
  const content = record.message?.content;
  if (typeof content !== "string") {
    return false;
  }
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<local-command-stdout>") ||
    trimmed.startsWith("<local-command-stderr>") ||
    trimmed.startsWith("<command-message>")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
