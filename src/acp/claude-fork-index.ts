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
  subtype?: string;
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
  /**
   * brick://4d6cb66d — the source record's runtime message-window length
   * (`sourceRecord.messages.length`, capped at MAX_RUNTIME_MESSAGES=200).
   *
   * THE INDEX SPACES MUST NOT BE CONFUSED: `--at-index` is range-checked against
   * the record's message list, which is a TAIL WINDOW of the conversation, while
   * the transcript walk below reconstructs indices from the START of the JSONL.
   * On any session whose transcript holds more messages than the window cap
   * (long-lived sessions; measured 1064 transcript slots vs window 200 on the
   * brick's specimen) the two diverge by the dropped prefix and the resolved cut
   * lands ~5x too early — on a compacted session typically BEFORE the last
   * compaction boundary, where Claude Code's resume-at refuses with the
   * unclassified `-32603 Internal error` (the user-visible "internal error").
   *
   * When the window length is known and SMALLER than the transcript's
   * reconstructed count, forkAtIndex is therefore treated as a WINDOW index and
   * remapped onto the tail: transcript target = total - window + (forkAtIndex-1).
   * Tail alignment is 1:1 because the record window IS the conversation's tail
   * (verified against the brick's specimen: the record's last message and the
   * transcript's last real user entry are the same prompt). Without window info
   * the legacy absolute semantics apply (short sessions, where the spaces
   * coincide anyway).
   */
  recordMessageTotal?: number;
}): Promise<string | undefined> {
  if (args.forkAtIndex < 0) {
    return undefined;
  }

  const content = await readClaudeTranscript(args.cwd, args.acpSessionId, args.subscriptionId);
  if (content === undefined) {
    return undefined;
  }

  const resolved = resolveClaudeForkCut(content, args.forkAtIndex, args.recordMessageTotal);
  return resolved.uuid;
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

type ResolvedClaudeForkCut = {
  uuid: string | undefined;
  /** Reconstructed transcript message count (the absolute index space's size). */
  transcriptMessageTotal: number;
  /** The transcript-space position the requested cut resolved to. */
  cutPosition: number;
  /** Position of the first message after the LAST compaction boundary, when the transcript has one. */
  firstPostCompactionPosition: number | undefined;
};

/**
 * Resolve WHERE in the transcript a `--at-index k` cut sits, and whether Claude
 * Code can resume from there at all.
 *
 * Returns the uuid of the last INCLUDED message (record index k-1 — the cut
 * boundary sits before message k), or `undefined` when no entry maps to that
 * position. Throws when the position is provably unreachable for Claude Code's
 * resume-at: anything at or before the last `compact_boundary` is compacted
 * away, and Claude Code reconstructs the resume chain from the transcript tail,
 * which stops at that boundary — so such a cut can never materialize and would
 * surface as the unclassified `-32603 Internal error`.
 */
export function resolveClaudeForkCut(
  content: string,
  forkAtIndex: number,
  recordMessageTotal: number | undefined,
): ResolvedClaudeForkCut {
  const { uuidBySlot, transcriptMessageTotal, firstPostCompactionPosition } =
    indexClaudeTranscript(content);
  const requestedCutPosition = resolveTranscriptCutPosition(
    forkAtIndex,
    recordMessageTotal,
    transcriptMessageTotal,
  );
  const cutPosition = clampToResolvableTranscriptPosition(
    requestedCutPosition,
    recordMessageTotal,
    transcriptMessageTotal,
    uuidBySlot,
  );

  if (firstPostCompactionPosition !== undefined && cutPosition < firstPostCompactionPosition) {
    throw new Error(
      `Cannot fork at --at-index ${forkAtIndex}: that point lies before the session's last context compaction, so Claude Code can no longer resume from it. Fork at a later point in the conversation, or copy the whole session (no cut).`,
    );
  }

  return {
    uuid: uuidBySlot.get(cutPosition),
    transcriptMessageTotal,
    cutPosition,
    firstPostCompactionPosition,
  };
}

/**
 * brick://24dba400 — a delivery arriving while a turn is in progress (e.g. a
 * `send-message.sh` relay landing mid-turn) gets its own entry in the acpx
 * session record, but Claude Code doesn't open a fresh top-level turn for it
 * (measured shape: a `type:"attachment"` queued-command JSONL row, invisible
 * to `isIndexableClaudeRecord`'s `type === "user" | "assistant"` check — not
 * the tool_result-content guess this was first suspected to be). The record
 * and transcript counts diverge monotonically from the first such delivery
 * onward, so `recordMessageTotal` (the record's own message-window length)
 * can legitimately exceed `transcriptMessageTotal` on exactly the sessions
 * that receive frequent child status updates (`hod-*`/orchestrator-style).
 *
 * When that's the known cause of the gap, a legacy-absolute `forkAtIndex`
 * that was perfectly valid in record space can resolve past the transcript's
 * own reconstructed bounds. Clamp DOWN to the nearest slot Claude Code can
 * actually resume from — per the "clamp, don't crash, never later" principle
 * this codebase already applies one layer up (acpx-ui's record-cut
 * translator) — instead of surfacing `undefined` and crashing the copy.
 *
 * Deliberately scoped to the case where `recordMessageTotal` is known AND
 * exceeds `transcriptMessageTotal`: that's the one situation where the gap is
 * attributable to this mechanism rather than to a genuinely out-of-range
 * request (no window info, or a `forkAtIndex` past even the record's own
 * length) — which must keep resolving to nothing, not to an invented cut.
 *
 * `uuidBySlot` is NOT guaranteed dense: two real user entries with nothing
 * indexable between them (transcript starts mid-turn, or both are queued
 * "attachment" deliveries) leave the slot between them unset. So this walks
 * backward for the nearest populated slot rather than assuming
 * `transcriptMessageTotal - 1` itself is populated.
 */
function clampToResolvableTranscriptPosition(
  requestedCutPosition: number,
  recordMessageTotal: number | undefined,
  transcriptMessageTotal: number,
  uuidBySlot: Map<number, string>,
): number {
  if (
    !isKnownRecordTotalDiverging(recordMessageTotal, transcriptMessageTotal) ||
    !Number.isFinite(requestedCutPosition) ||
    requestedCutPosition < transcriptMessageTotal
  ) {
    return requestedCutPosition;
  }

  for (let position = transcriptMessageTotal - 1; position >= 0; position -= 1) {
    if (uuidBySlot.has(position)) {
      return position;
    }
  }
  // No resolvable slot at all (e.g. an empty transcript) — fall through
  // unclamped so the caller's existing "no uuid" handling applies unchanged.
  return requestedCutPosition;
}

/** recordMessageTotal is a real, known message count and genuinely exceeds
 * what the transcript reconstructs — the specific divergence this clamps. */
function isKnownRecordTotalDiverging(
  recordMessageTotal: number | undefined,
  transcriptMessageTotal: number,
): boolean {
  return (
    typeof recordMessageTotal === "number" &&
    Number.isFinite(recordMessageTotal) &&
    recordMessageTotal > 0 &&
    recordMessageTotal > transcriptMessageTotal
  );
}

function indexClaudeTranscript(content: string): {
  uuidBySlot: Map<number, string>;
  transcriptMessageTotal: number;
  firstPostCompactionPosition: number | undefined;
} {
  // Single pass: assign reconstructed indices (user starts at 0 / steps by 2 on
  // each real user entry, assistant entries fill the odd slot), remember each
  // entry's uuid by index, and note where the last compaction boundary sits.
  const uuidBySlot = new Map<number, string>();
  let acpxIndex = -1;
  let topSlot = -1;
  let firstPostCompactionPosition: number | undefined;

  for (const line of content.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const record = parseClaudeJsonlRecord(line);
    if (!record) {
      continue;
    }
    if (isCompactionBoundary(record)) {
      // The boundary itself carries no uuid; the first slot AFTER it is the
      // earliest one Claude Code's tail-reconstructed resume chain can reach.
      firstPostCompactionPosition = topSlot + 1;
      continue;
    }
    if (!isIndexableClaudeRecord(record)) {
      continue;
    }

    const indexed = indexClaudeRecord(record, acpxIndex);
    if (!indexed) {
      continue;
    }
    acpxIndex = indexed.nextAcpxIndex;
    topSlot = Math.max(topSlot, indexed.recordAcpxIndex);
    // First entry per slot wins: for an agent turn spanning several assistant
    // entries, the turn-leading entry is the resume boundary Claude Code sees.
    if (!uuidBySlot.has(indexed.recordAcpxIndex)) {
      uuidBySlot.set(indexed.recordAcpxIndex, record.uuid);
    }
  }

  return {
    uuidBySlot,
    transcriptMessageTotal: topSlot + 1,
    firstPostCompactionPosition,
  };
}

function resolveTranscriptCutPosition(
  forkAtIndex: number,
  recordMessageTotal: number | undefined,
  transcriptMessageTotal: number,
): number {
  if (
    typeof recordMessageTotal === "number" &&
    Number.isFinite(recordMessageTotal) &&
    recordMessageTotal > 0 &&
    transcriptMessageTotal > recordMessageTotal
  ) {
    // Window semantics: forkAtIndex counts from the conversation tail.
    return transcriptMessageTotal - recordMessageTotal + (forkAtIndex - 1);
  }
  // Legacy absolute semantics (no window info, or the transcript IS the window).
  return forkAtIndex - 1;
}

function isCompactionBoundary(record: ClaudeJsonlRecord): boolean {
  return record.type === "system" && record.subtype === "compact_boundary";
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
