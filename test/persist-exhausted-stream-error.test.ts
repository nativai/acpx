import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isAcpJsonRpcMessage } from "../src/acp/jsonrpc.js";
import { resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
import { AllSubscriptionsExhaustedError, BridgeAuthGatedError } from "../src/errors.js";
import { attemptFailoverAndRetry, classifyFailover } from "../src/runtime/engine/failover.js";
import { defaultSessionEventLog, sessionEventActivePath } from "../src/session/event-log.js";
import { messagesLogPath } from "../src/session/messages-log.js";
import {
  buildTerminalTurnErrorMessage,
  isTerminalTurnError,
  mirrorTerminalTurnErrorToMessages,
  persistTerminalTurnError,
} from "../src/session/persist-terminal-error.js";
import { sessionBaseDir, writeSessionRecord } from "../src/session/persistence.js";
import type { SessionMessage, SessionRecord } from "../src/types.js";

// Read the mirrored terminal-error entries acpx writes to a session's
// `.messages.ndjson` sidecar (the conversation log spawner agents + the record's
// `messages` read). FIX-A mirrors a terminal turn error here — in addition to the
// `.stream.ndjson` write the UI reads — so a child that dies on a terminal error
// AND its spawner are TOLD instead of seeing silence.
async function readMirroredMessages(acpxRecordId: string): Promise<SessionMessage[]> {
  const raw = await fs.readFile(messagesLogPath(sessionBaseDir(), acpxRecordId), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionMessage);
}

// Narrow a mirrored entry to its synthetic Agent shape (content Text + the
// structured `terminal_error` marker FIX-A stamps for programmatic classification).
function asTerminalAgentEntry(message: SessionMessage): {
  text: string;
  detailCode?: string;
  outputCode?: string;
  message?: string;
} {
  assert.ok(typeof message === "object" && "Agent" in message, "entry is an Agent message");
  const agent = message.Agent;
  const first = agent.content[0];
  assert.ok(first && "Text" in first, "Agent entry carries a Text block");
  return {
    text: first.Text,
    detailCode: agent.terminal_error?.detail_code,
    outputCode: agent.terminal_error?.output_code,
    message: agent.terminal_error?.message,
  };
}

// Mirrors acpx-ui's server/streamTail.ts terminal-error derivation EXACTLY (the
// cross-repo contract this fix exists to satisfy): a stream line with NO `method`
// and an `error` object is the turn-end error; `code` is `error.data.detailCode`,
// `message` is `error.message`. If the persisted line does not satisfy this, the
// UI banner (keyed on lastError.code === 'all-subscriptions-exhausted') stays dark.
function extractLastErrorLikeAcpxUi(
  line: Record<string, unknown>,
): { code?: string; message: string } | undefined {
  if (typeof line.method === "string") {
    return undefined;
  }
  const err = line.error as
    | { code?: unknown; message?: unknown; data?: { detailCode?: unknown } }
    | undefined;
  if (err === undefined) {
    return undefined;
  }
  const detailCode =
    typeof err.data?.detailCode === "string" && err.data.detailCode.trim()
      ? err.data.detailCode.trim()
      : undefined;
  const message =
    typeof err.message === "string" && err.message.trim() ? err.message.trim() : "Turn failed";
  return detailCode ? { code: detailCode, message } : { message };
}

function startMockMessages(
  tokenToOutcome: Map<string, { status: number; util?: number }>,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const auth = req.headers.authorization ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const outcome = tokenToOutcome.get(token) ?? { status: 200, util: 0 };
      if (outcome.status === 401) {
        res.writeHead(401).end("{}");
        return;
      }
      res.writeHead(200, {
        "anthropic-ratelimit-unified-5h-utilization": String(outcome.util ?? 0),
        "anthropic-ratelimit-unified-7d-utilization": String(outcome.util ?? 0),
      });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/messages` });
    });
  });
}

function makeRecord(sessionId: string): SessionRecord {
  const now = "2026-06-04T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
    acpSessionId: sessionId,
    agentCommand: "claude",
    cwd: "/work/exhausted",
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: defaultSessionEventLog(sessionId),
    closed: false,
    title: null,
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: { session_options: { subscription: "a" } },
  } as SessionRecord;
}

// The defect this fix closes: a genuine all-subscriptions-exhausted turn must
// write its terminal JSON-RPC error — carrying detailCode "all-subscriptions-
// exhausted" — to the session `.stream.ndjson` that acpx-ui reads, not only to
// CLI stdout. Drives a REAL AllSubscriptionsExhaustedError (all subs 401), then
// runs the exact persistence the runtime chokepoint runs, and asserts the on-disk
// terminal line satisfies acpx-ui's stream-tail contract.
test("a real exhausted turn persists the terminal error to .stream.ndjson with detailCode", async () => {
  resetKnownDeadSubs();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-exhausted-"));
  const subsDir = path.join(home, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const prevHome = process.env.HOME;
  const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
  process.env.HOME = home;

  const { server, url } = await startMockMessages(
    new Map([
      ["tok-a", { status: 401 }],
      ["tok-b", { status: 401 }],
    ]),
  );
  process.env.CLAUDE_MESSAGES_ENDPOINT = url;

  try {
    for (const s of [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" },
    ]) {
      const dir = path.join(subsDir, s.id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: s.token } }),
      );
    }
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        default: "a",
        subscriptions: [
          { id: "a", label: "Sub A", configDir: path.join(subsDir, "a") },
          { id: "b", label: "Sub B", configDir: path.join(subsDir, "b") },
        ],
      }),
    );

    const record = makeRecord("rec-exhausted");
    await writeSessionRecord(record);

    // 1) Produce a GENUINE AllSubscriptionsExhaustedError (every sub dead).
    let caught: unknown;
    await assert.rejects(
      () =>
        attemptFailoverAndRetry<string>({
          record,
          loadOpts: { registryPath },
          runTurn: async () => "should-not-run",
        }),
      (err: unknown) => {
        caught = err;
        return err instanceof AllSubscriptionsExhaustedError;
      },
    );

    // 2) Run the exact persistence the runtime chokepoint runs on exhaustion.
    await persistTerminalTurnError(record, caught);

    // 3) Read the terminal line back off the session stream the UI consumes.
    const streamPath = sessionEventActivePath("rec-exhausted");
    const raw = await fs.readFile(streamPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1, "exactly one terminal error line persisted");
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;

    // Valid ACP JSON-RPC message (so listSessionEvents / the writer accept it)…
    assert.equal(isAcpJsonRpcMessage(parsed), true);
    // …a top-level error response (no `method`)…
    assert.equal("method" in parsed, false);

    // …that acpx-ui's stream-tail derivation reads as the exhausted lastError.
    const lastError = extractLastErrorLikeAcpxUi(parsed);
    assert.ok(lastError, "acpx-ui derives a lastError from the line");
    assert.equal(lastError.code, "all-subscriptions-exhausted");
    assert.match(lastError.message, /All subscriptions are exhausted or unavailable\./);

    // Belt-and-suspenders on the raw JSON-RPC shape acpx-ui parses.
    const err = parsed.error as { code: unknown; message: unknown; data: { detailCode: unknown } };
    assert.equal(typeof err.code, "number");
    assert.equal(err.data.detailCode, "all-subscriptions-exhausted");

    // FIX-A: the SAME terminal error must ALSO be mirrored into `.messages.ndjson`
    // as an agent-visible entry — so a spawner polling the child's messages.ndjson
    // is TOLD, not left reading the prompt then silence. Additive to the stream
    // write asserted above (the two files are independent).
    await mirrorTerminalTurnErrorToMessages(record, caught);
    const mirrored = await readMirroredMessages("rec-exhausted");
    assert.equal(mirrored.length, 1, "exactly one mirrored terminal-error entry");
    const entry = asTerminalAgentEntry(mirrored[0]);
    // Human-readable line a reader / UI renders.
    assert.match(entry.text, /^⚠ turn failed: /);
    assert.match(entry.text, /All subscriptions are exhausted or unavailable\./);
    // Structured detailCode retained so a spawner can classify programmatically —
    // the SAME cross-repo contract string as the stream line's data.detailCode.
    assert.equal(entry.detailCode, "all-subscriptions-exhausted");
    assert.match(entry.message ?? "", /All subscriptions are exhausted or unavailable\./);
    // The broadened, class-agnostic routing predicate recognizes this error.
    assert.equal(isTerminalTurnError(caught), true);
  } finally {
    server.close();
    process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
});

// The auth-gated bridge failure shape (claude-pty AdapterHealthError surfaced to
// acpx as a generic -32000 with data.reason/state === "auth-gated").
function authGatedError(message: string, effectiveAccount: string): Error {
  const error = new Error(message);
  (error as { acp?: { code: number; message: string; data: Record<string, unknown> } }).acp = {
    code: -32000,
    message,
    data: { reason: "auth-gated", state: "auth-gated" },
  };
  (error as { effectiveAccountMetadata?: { effectiveAccount: string } }).effectiveAccountMetadata =
    {
      effectiveAccount,
    };
  return error;
}

// S5 (persist half) + S6 (UI contract): an auth-gated bridge pool throws a
// BridgeAuthGatedError, and persistTerminalTurnError must write its terminal line
// to .stream.ndjson carrying detailCode === "auth-gated" — the EXACT value
// acpx-ui's stream-tail derivation maps to lastError.code === 'auth-gated', which
// renders the AuthGatedBanner (NOT the exhausted/quota banner). This is the
// surfacing fix that replaces the false "all subscriptions exhausted" verdict.
test("an auth-gated bridge turn persists a terminal error with detailCode 'auth-gated'", async () => {
  resetKnownDeadSubs();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-authgated-"));
  const subsDir = path.join(home, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const homePath = path.join(subsDir, "bridge-solo-home");
  const prevHome = process.env.HOME;
  process.env.HOME = home;

  try {
    // A single claude-home bridge profile (no sibling) whose login is gated.
    await fs.mkdir(path.join(homePath, ".claude"), { recursive: true });
    await fs.mkdir(subsDir, { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        version: 3,
        default: "bridge-solo",
        profiles: [
          {
            id: "bridge-solo",
            label: "bridge-solo",
            authMode: "claude-home",
            adapter: "claude-pty",
            account: "acct-bridge-solo",
            credentialSource: null,
            homePath,
          },
        ],
      }),
    );

    const record = makeRecord("rec-authgated");
    record.acpx = { session_options: { profile: "bridge-solo" } };
    await writeSessionRecord(record);

    // 1) Produce a GENUINE BridgeAuthGatedError (selected bridge gated, no sibling).
    let caught: unknown;
    await assert.rejects(
      () =>
        attemptFailoverAndRetry<string>({
          record,
          triggerError: authGatedError(
            "Interactive Claude login is required for this HOME",
            "acct-bridge-solo",
          ),
          loadOpts: { registryPath },
          runTurn: async () => "should-not-run",
        }),
      (err: unknown) => {
        caught = err;
        return err instanceof BridgeAuthGatedError;
      },
    );

    // 2) Run the exact persistence the runtime chokepoint runs.
    await persistTerminalTurnError(record, caught);

    // 3) Read the terminal line back off the session stream the UI consumes.
    const streamPath = sessionEventActivePath("rec-authgated");
    const raw = await fs.readFile(streamPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1, "exactly one terminal error line persisted");
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;

    assert.equal(isAcpJsonRpcMessage(parsed), true);
    assert.equal("method" in parsed, false);

    // S6: acpx-ui derives lastError.code === 'auth-gated' from this line.
    const lastError = extractLastErrorLikeAcpxUi(parsed);
    assert.ok(lastError, "acpx-ui derives a lastError from the line");
    assert.equal(lastError.code, "auth-gated");
    assert.match(lastError.message, /Claude bridge needs an interactive login/);

    const err = parsed.error as { code: unknown; message: unknown; data: { detailCode: unknown } };
    assert.equal(typeof err.code, "number");
    assert.equal(err.data.detailCode, "auth-gated");

    // FIX-A: the auth-gated terminal error also mirrors into `.messages.ndjson`
    // with its detailCode retained, so the spawner is TOLD (not just the UI banner).
    await mirrorTerminalTurnErrorToMessages(record, caught);
    const mirrored = await readMirroredMessages("rec-authgated");
    assert.equal(mirrored.length, 1, "exactly one mirrored terminal-error entry");
    const entry = asTerminalAgentEntry(mirrored[0]);
    assert.match(entry.text, /^⚠ turn failed: /);
    assert.equal(entry.detailCode, "auth-gated");
    assert.equal(isTerminalTurnError(caught), true);
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    await fs.rm(home, { recursive: true, force: true });
    resetKnownDeadSubs();
  }
});

// FIX-A — the turn-ending single-sub rate_limit path. A rate_limit that ends a
// turn WITHOUT failover recovery (failover disabled / no sibling / no portable
// anchor) is a terminal turn error: `classifyFailover` tags it `rate_limit`, so
// the runtime's raw-exit mirror fires on it, and `isTerminalTurnError` is true so
// the broadened failover-catch mirror fires too. Either way the child + spawner
// must find an agent-visible entry (carrying the rate_limit detailCode) in
// `.messages.ndjson`, not silence.
test("a turn-ending rate_limit is mirrored into .messages.ndjson with its detailCode", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-ratelimit-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const record = makeRecord("rec-ratelimit");
    await writeSessionRecord(record);

    // The shape a turn-ending rate_limit surfaces with: the adapter tags
    // data.errorKind = "rate_limit" (what classifyFailover keys on), and acpx's
    // wrapping carries the top-level detailCode the normalizer reads.
    const rateLimitError = new Error(
      "Usage limit reached for this subscription — resets 2026-06-04T15:00:00Z",
    ) as Error & {
      acp?: { code: number; message: string; data: Record<string, unknown> };
      detailCode?: string;
    };
    rateLimitError.acp = {
      code: -32000,
      message: rateLimitError.message,
      data: { errorKind: "rate_limit" },
    };
    rateLimitError.detailCode = "rate_limit";

    // Preconditions: this is exactly the classification the runtime routes on.
    assert.equal(classifyFailover(rateLimitError), "rate_limit");
    assert.equal(isTerminalTurnError(rateLimitError), true);

    // Run the mirror the runtime chokepoints run on a terminal turn error.
    await mirrorTerminalTurnErrorToMessages(record, rateLimitError);

    const mirrored = await readMirroredMessages("rec-ratelimit");
    assert.equal(mirrored.length, 1, "exactly one mirrored terminal-error entry");
    const entry = asTerminalAgentEntry(mirrored[0]);
    assert.match(entry.text, /^⚠ turn failed: Usage limit reached for this subscription/);
    assert.equal(entry.detailCode, "rate_limit");
    assert.match(entry.message ?? "", /Usage limit reached for this subscription/);

    // A second terminal error appends a second entry (watermark honored, no clobber).
    await mirrorTerminalTurnErrorToMessages(record, rateLimitError);
    const after = await readMirroredMessages("rec-ratelimit");
    assert.equal(after.length, 2, "second terminal error appends, not overwrites");
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
});

// FIX-A — the mirror is class-agnostic. An error carrying NO detailCode is not a
// terminal turn error for routing purposes (`isTerminalTurnError` false), but the
// message builder still yields a legible, agent-visible line — so the mirror never
// produces a blank entry even when a detailCode is absent.
test("buildTerminalTurnErrorMessage always yields a legible line; detailCode gate is honest", () => {
  const plain = new Error("something broke mid-turn");
  assert.equal(isTerminalTurnError(plain), false);
  const built = buildTerminalTurnErrorMessage(plain);
  const entry = asTerminalAgentEntry(built);
  assert.equal(entry.text, "⚠ turn failed: something broke mid-turn");
  assert.equal(entry.detailCode, undefined);
  assert.equal(entry.message, "something broke mid-turn");
});
