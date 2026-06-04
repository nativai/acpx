import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isAcpJsonRpcMessage } from "../src/acp/jsonrpc.js";
import { resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
import { AllSubscriptionsExhaustedError } from "../src/errors.js";
import { attemptFailoverAndRetry } from "../src/runtime/engine/failover.js";
import { defaultSessionEventLog, sessionEventActivePath } from "../src/session/event-log.js";
import { persistTerminalTurnError } from "../src/session/persist-terminal-error.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

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
