import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SessionAgentContent,
  SessionMessage,
  SessionToolResult,
  SessionToolResultContent,
  SessionUserContent,
} from "./types.js";

// ─── Raw JSONL shapes ──────────────────────────────────────────────────────────

interface RawContentBlock {
  type: string;
  // text block
  text?: string;
  // thinking block
  thinking?: string;
  signature?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result block
  tool_use_id?: string;
  content?: string | RawContentBlock[];
  is_error?: boolean;
}

interface RawJsonlEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | RawContentBlock[];
  };
}

// ─── Normalisation helpers ─────────────────────────────────────────────────────

function normalizeContentBlocks(raw: string | RawContentBlock[] | undefined): RawContentBlock[] {
  if (raw == null) {
    return [];
  }
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  return raw;
}

function toolResultContentToSessionContent(
  raw: string | RawContentBlock[] | undefined,
): SessionToolResultContent {
  const blocks = normalizeContentBlocks(raw);
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      return { Text: block.text };
    }
  }
  return { Text: typeof raw === "string" ? raw : JSON.stringify(raw ?? "") };
}

// ─── Core conversion ───────────────────────────────────────────────────────────

/**
 * Convert Claude Code's raw JSONL transcript to ACPX SessionMessage[].
 *
 * Each JSONL entry is a tree node linked by uuid/parentUuid. Consecutive
 * assistant entries contribute to the same Agent turn. User entries whose
 * content is entirely tool_result blocks are merged into the preceding Agent
 * turn's tool_results rather than creating a new User message.
 */
export function parseClaudeJsonlToMessages(content: string): SessionMessage[] {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const entries: RawJsonlEntry[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed as RawJsonlEntry);
      }
    } catch {
      // skip malformed lines
    }
  }

  return entriesToMessages(entries);
}

function entriesToMessages(entries: RawJsonlEntry[]): SessionMessage[] {
  const messages: SessionMessage[] = [];
  let openAgent: {
    content: SessionAgentContent[];
    tool_results: Record<string, SessionToolResult>;
  } | null = null;

  const flushAgent = (): void => {
    if (!openAgent) {
      return;
    }
    if (openAgent.content.length > 0 || Object.keys(openAgent.tool_results).length > 0) {
      messages.push({
        Agent: { content: openAgent.content, tool_results: openAgent.tool_results },
      });
    }
    openAgent = null;
  };

  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") {
      continue;
    }

    const blocks = normalizeContentBlocks(entry.message?.content);

    if (entry.type === "user") {
      const textBlocks = blocks.filter((b) => b.type === "text");
      const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");

      // Pure tool-result entry — merge into open (or new) agent turn
      if (toolResultBlocks.length > 0 && textBlocks.length === 0) {
        if (!openAgent) {
          openAgent = { content: [], tool_results: {} };
        }
        for (const tr of toolResultBlocks) {
          if (typeof tr.tool_use_id !== "string") {
            continue;
          }
          openAgent.tool_results[tr.tool_use_id] = {
            tool_use_id: tr.tool_use_id,
            tool_name: "",
            is_error: tr.is_error ?? false,
            content: toolResultContentToSessionContent(tr.content),
          };
        }
        continue;
      }

      // Real user text — flush any open agent turn first
      flushAgent();

      const userContent: SessionUserContent[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          userContent.push({ Text: block.text });
        }
      }

      if (userContent.length > 0) {
        messages.push({
          User: {
            id: entry.uuid ?? crypto.randomUUID(),
            content: userContent,
          },
        });
      }

      // Handle any interleaved tool_results in a mixed user entry
      if (toolResultBlocks.length > 0) {
        const lastMsg = messages.at(-1);
        if (lastMsg && typeof lastMsg === "object" && "Agent" in lastMsg) {
          for (const tr of toolResultBlocks) {
            if (typeof tr.tool_use_id !== "string") {
              continue;
            }
            lastMsg.Agent.tool_results[tr.tool_use_id] = {
              tool_use_id: tr.tool_use_id,
              tool_name: "",
              is_error: tr.is_error ?? false,
              content: toolResultContentToSessionContent(tr.content),
            };
          }
        }
      }
    } else {
      // assistant entry — accumulate into open agent turn
      if (!openAgent) {
        openAgent = { content: [], tool_results: {} };
      }
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          openAgent.content.push({ Text: block.text });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          openAgent.content.push({
            Thinking: {
              text: block.thinking,
              signature: typeof block.signature === "string" ? block.signature : undefined,
            },
          });
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          openAgent.content.push({
            ToolUse: {
              id: block.id,
              name: typeof block.name === "string" ? block.name : "",
              raw_input: block.input !== undefined ? JSON.stringify(block.input) : "{}",
              input: block.input ?? {},
              is_input_complete: true,
            },
          });
        }
      }
    }
  }

  flushAgent();
  return messages;
}

// ─── Real-time JSONL tailer ────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 300;
const FILE_APPEAR_TIMEOUT_MS = 30_000;

export type JsonlTailerCallback = (newMessages: SessionMessage[]) => void;

/**
 * Tails a Claude Code subagent JSONL file in near-real-time.
 *
 * Starts polling after `teammate_spawned`. The file may not exist yet —
 * we wait up to FILE_APPEAR_TIMEOUT_MS for it to appear, then poll every
 * POLL_INTERVAL_MS for new lines. Each batch of new lines is parsed into
 * SessionMessages and delivered to the callback.
 *
 * Returns a `stop()` function; call it on task_completed/failed/stopped
 * to do a final drain and cease polling.
 */
export function tailClaudeSubagentJsonl(
  jsonlDir: string,
  rawAgentId: string,
  onNewMessages: JsonlTailerCallback,
): { stop: () => Promise<void> } {
  const filePath = path.join(jsonlDir, `agent-${rawAgentId}.jsonl`);
  let stopped = false;
  let bytesRead = 0;
  let pendingLines: RawJsonlEntry[] = [];

  const readNewLines = async (): Promise<void> => {
    let content: string;
    try {
      const buf = await fs.readFile(filePath);
      // Only read bytes we haven't seen yet
      const newBytes = buf.slice(bytesRead);
      if (newBytes.length === 0) {
        return;
      }
      bytesRead += newBytes.length;
      content = newBytes.toString("utf8");
    } catch {
      return; // file doesn't exist yet or read error — try again next tick
    }

    const newLines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of newLines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          pendingLines.push(parsed as RawJsonlEntry);
        }
      } catch {
        // skip malformed
      }
    }

    if (pendingLines.length === 0) {
      return;
    }

    const messages = entriesToMessages(pendingLines);
    pendingLines = [];
    if (messages.length > 0) {
      onNewMessages(messages);
    }
  };

  // Poll loop
  const poll = async (): Promise<void> => {
    const deadline = Date.now() + FILE_APPEAR_TIMEOUT_MS;
    while (!stopped) {
      await readNewLines();
      if (stopped) {
        break;
      }
      // If file hasn't appeared yet and deadline passed, stop waiting
      if (bytesRead === 0 && Date.now() > deadline) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  const pollPromise = poll();

  const stop = async (): Promise<void> => {
    stopped = true;
    await pollPromise;
    // Final drain — read anything written since last poll
    await readNewLines();
    if (pendingLines.length > 0) {
      const messages = entriesToMessages(pendingLines);
      pendingLines = [];
      if (messages.length > 0) {
        onNewMessages(messages);
      }
    }
  };

  return { stop };
}

// ─── One-shot read helper ──────────────────────────────────────────────────────

/**
 * Read and parse a complete Claude Code subagent JSONL file.
 * Returns [] if the file doesn't exist or can't be parsed.
 */
export async function readClaudeSubagentTranscript(
  jsonlDir: string,
  rawAgentId: string,
): Promise<SessionMessage[]> {
  const filePath = path.join(jsonlDir, `agent-${rawAgentId}.jsonl`);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return parseClaudeJsonlToMessages(content);
}
