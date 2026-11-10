import { isPromptInput } from "../prompt-content.js";
import type { PromptInput } from "../types.js";
import type { PromptFlags } from "./flags.js";
import { type MemberTaskOptions, parseMemberTaskOptions } from "./queue/messages.js";

/**
 * UMQ K3 (CONTRACTS §1.2) — one member of `prompt --batch-file`: its own message id (its wire
 * `messageId` and `QueueTask.messageId`), its ACP blocks with atrium's per-member header already in
 * them, and — for a routed agent prompt's member only — its own task options.
 */
export type BatchFileMember = {
  messageId: string;
  prompt: PromptInput;
  options?: MemberTaskOptions;
};

/** A `--batch-file` refusal: exit 2, `acpx: --batch-file <rule>` on stderr, nothing submitted. */
export class BatchFileUsageError extends Error {
  constructor(rule: string) {
    super(`--batch-file ${rule}`);
    this.name = "BatchFileUsageError";
  }
}

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The flag combinations `--batch-file` refuses (CONTRACTS §1.1). */
export function assertBatchFileFlags(flags: PromptFlags, promptParts: readonly string[]): void {
  if (flags.wait !== false) {
    throw new BatchFileUsageError("requires --no-wait");
  }
  const conflicts: Array<[boolean, string]> = [
    [promptParts.join(" ").trim().length > 0, "positional prompt text"],
    [flags.file !== undefined, "--file"],
    [flags.messageId !== undefined, "--message-id"],
    [flags.seat !== undefined, "--seat"],
  ];
  for (const [present, what] of conflicts) {
    if (present) {
      throw new BatchFileUsageError(`cannot be combined with ${what}`);
    }
  }
}

/** Batch file v1: `{"v":1,"messages":[{messageId, prompt, options?}, …]}`, delivery order, ≥ 1. */
export function parseBatchFile(source: string): BatchFileMember[] {
  const seen = new Set<string>();
  return parseBatchBody(source).map((raw: unknown, index) => {
    const member = parseMember(raw, index);
    if (seen.has(member.messageId)) {
      throw new BatchFileUsageError(`messages[${index}]: duplicate messageId ${member.messageId}`);
    }
    seen.add(member.messageId);
    return member;
  });
}

function parseBatchBody(source: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new BatchFileUsageError("body is not JSON");
  }
  if (!isObject(parsed)) {
    throw new BatchFileUsageError("body must be an object");
  }
  if (parsed.v !== 1) {
    throw new BatchFileUsageError(
      `version ${JSON.stringify(parsed.v ?? null)} is not supported (v: 1)`,
    );
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new BatchFileUsageError("messages must be a non-empty array");
  }
  return parsed.messages as unknown[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMember(raw: unknown, index: number): BatchFileMember {
  const at = `messages[${index}]`;
  if (!isObject(raw)) {
    throw new BatchFileUsageError(`${at}: must be an object`);
  }
  if (typeof raw.messageId !== "string" || !LOWERCASE_UUID.test(raw.messageId)) {
    throw new BatchFileUsageError(`${at}: messageId must be a lowercase UUID`);
  }
  if (!isPromptInput(raw.prompt) || raw.prompt.length === 0) {
    throw new BatchFileUsageError(`${at}: prompt must be a non-empty array of ACP content blocks`);
  }
  const options = parseMemberTaskOptions(raw.options);
  if (options === null) {
    throw new BatchFileUsageError(`${at}: options are invalid`);
  }
  return {
    messageId: raw.messageId,
    prompt: raw.prompt,
    ...(options !== undefined ? { options } : {}),
  };
}
