import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Synthetic Claude Code transcript lines with the REAL key sets, key order and
// types measured on the fleet (brick 81433524 TEST-PLAN §1; Claude Code 2.1.310).
// No real transcript bytes: every value is generated here.

export const SESSION_A = "11111111-2222-4333-8444-555555555555";
export const SESSION_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";
export const SESSION_C = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

function uuidFor(seed: string, index: number): string {
  const hex = createHash("sha256").update(`${seed}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isoAt(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + minute * 60_000).toISOString();
}

export type ConversationLine = { text: string; uuid?: string };

function userLine(sessionId: string, uuid: string, parent: string | null, minute: number) {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    promptId: `p-${uuid.slice(0, 8)}`,
    type: "user",
    message: { role: "user", content: `question ${minute}` },
    uuid,
    timestamp: isoAt(minute),
    userType: "external",
    entrypoint: "sdk-ts",
    cwd: "/work/proj",
    sessionId,
    version: "2.1.310",
    gitBranch: "main",
  });
}

function assistantLine(sessionId: string, uuid: string, parent: string, minute: number) {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    message: {
      id: `msg_${uuid.slice(0, 12)}`,
      model: "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text: `answer ${minute}` }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    requestId: `req_${uuid.slice(0, 12)}`,
    type: "assistant",
    uuid,
    timestamp: isoAt(minute),
    sessionId,
    version: "2.1.310",
    gitBranch: "main",
  });
}

function apiRequestBlob(sessionId: string, index: number) {
  return JSON.stringify({
    type: "api-request-blob",
    sessionId,
    hash: createHash("sha256").update(`blob:${index}`).digest("hex").slice(0, 16),
    message: "x".repeat(40),
  });
}

/** The resume re-append block (uuid-less, timestamp-less) Claude Code writes after a resume. */
function resumeReappend(sessionId: string, leafUuid: string): string[] {
  return [
    JSON.stringify({ type: "last-prompt", lastPrompt: "question 0", leafUuid, sessionId }),
    JSON.stringify({ type: "ai-title", aiTitle: "a synthetic title", sessionId }),
    JSON.stringify({ type: "mode", mode: "default", sessionId }),
    JSON.stringify({ type: "atis-latch", atis: true, sessionId }),
  ];
}

/**
 * P: a conversation body of `pairs` user/assistant pairs (≥ 15 → ≥ 30 lines), with
 * a parentUuid chain, an `api-request-blob` interleaved every few lines and a
 * resume re-append block after the first user line. `seed` makes uuids unique per
 * branch; `startMinute` makes later turns carry later timestamps.
 */
export function conversation(
  sessionId: string,
  options: { pairs: number; seed?: string; startMinute?: number; parent?: string | null },
): { lines: string[]; lastUuid: string } {
  const seed = options.seed ?? "main";
  const start = options.startMinute ?? 0;
  const lines: string[] = [];
  let parent: string | null = options.parent ?? null;
  for (let pair = 0; pair < options.pairs; pair++) {
    const minute = start + pair * 2;
    const userUuid = uuidFor(seed, pair * 2);
    lines.push(userLine(sessionId, userUuid, parent, minute));
    if (pair === 0 && options.parent === undefined) {
      lines.push(...resumeReappend(sessionId, userUuid));
    }
    if (pair % 3 === 1) {
      lines.push(apiRequestBlob(sessionId, pair));
    }
    const assistantUuid = uuidFor(seed, pair * 2 + 1);
    lines.push(assistantLine(sessionId, assistantUuid, userUuid, minute + 1));
    parent = assistantUuid;
  }
  return { lines, lastUuid: parent ?? "" };
}

export type ExitLineType = "last-prompt" | "cost-state" | "ai-title" | "mode" | "atis-latch";

export function exitLine(type: ExitLineType, sessionId: string, leafUuid: string): string {
  switch (type) {
    case "last-prompt":
      return JSON.stringify({ type, lastPrompt: "what is the codeword", leafUuid, sessionId });
    case "cost-state":
      return JSON.stringify({
        type,
        sessionId,
        totalCostUSD: 0.4211,
        totalAPIDuration: 81234,
        totalAPIDurationWithoutRetries: 80001,
        totalToolDuration: 1200,
        totalLinesAdded: 12,
        totalLinesRemoved: 3,
        totalDuration: 900000,
        startTime: 1790000000000,
        modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 20 } },
        hasUnknownModelCost: false,
      });
    case "ai-title":
      return JSON.stringify({ type, aiTitle: "a synthetic title", sessionId });
    case "mode":
      return JSON.stringify({ type, mode: "default", sessionId });
    default:
      return JSON.stringify({ type: "atis-latch", atis: true, sessionId });
  }
}

export function queueOperationLine(sessionId: string, minute: number): string {
  return JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: isoAt(minute),
    sessionId,
    content: "a queued prompt",
  });
}

export function jsonl(lines: string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

export async function writeFileAt(filePath: string, body: string | Uint8Array): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, body);
  return filePath;
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Age a file's mtime (and atime) by `ms` into the past. */
export async function ageFile(filePath: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await fs.utimes(filePath, when, when);
}

/** A v3 registry with subscription profiles whose config dirs are `<home>/.acpx/subscriptions/<id>`. */
export async function writeRegistry(home: string, ids: string[], defaultId: string): Promise<void> {
  const root = path.join(home, ".acpx", "subscriptions");
  for (const id of ids) {
    await fs.mkdir(path.join(root, id), { recursive: true });
  }
  const profiles = ids.map((id) => ({
    id,
    label: id,
    authMode: "subscription",
    adapter: "claude",
    account: `acct-${id}`,
    credentialSource: path.join(root, id),
  }));
  await writeFileAt(
    path.join(root, "registry.json"),
    `${JSON.stringify({ version: 3, default: defaultId, profiles }, null, 2)}\n`,
  );
}

/** A session record on disk (snake_case, as acpx writes it), bound to `profile`. */
export async function writeRecordFixture(
  home: string,
  input: {
    recordId: string;
    acpSessionId: string;
    cwd: string;
    profile: string;
    pid?: number;
    archived?: boolean;
  },
): Promise<string> {
  const { serializeSessionRecordForDisk } = await import("../src/session/persistence.js");
  const record = {
    schema: "acpx.session.v1",
    acpxRecordId: input.recordId,
    acpSessionId: input.acpSessionId,
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: input.cwd,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: "2026-10-01T00:00:00.000Z",
    lastSeq: 0,
    eventLog: {
      active_path: path.join(home, `${input.recordId}.stream.ndjson`),
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: "2026-10-01T00:00:00.000Z",
      last_write_error: null,
    },
    title: null,
    messages: [],
    updated_at: "2026-10-01T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    acpx: { session_options: { profile: input.profile } },
  };
  const dir = path.join(home, ".acpx", input.archived ? "sessions-archive" : "sessions");
  const serialized = serializeSessionRecordForDisk(
    record as unknown as Parameters<typeof serializeSessionRecordForDisk>[0],
  );
  return await writeFileAt(
    path.join(dir, `${input.recordId}.json`),
    `${JSON.stringify(serialized, null, 2)}\n`,
  );
}

/** A deterministic uuid-shaped session id for a fixture label. */
export function sessionIdFor(label: string): string {
  const hex = createHash("sha256").update(`session:${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
