import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { admitCodexSubscriptionTurn } from "../src/runtime/engine/codex-subscription-cap.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

function quotaResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capturedAt: new Date().toISOString(),
    secondary: { windowMinutes: 10_080, usedPercent: 12, elapsed: false },
    ...overrides,
  };
}

async function withQuotaServer(
  body: Record<string, unknown>,
  run: (fetchImpl: typeof fetch) => Promise<void>,
): Promise<void> {
  const server = await new Promise<Server>((resolve) => {
    const created = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    });
    created.listen(0, "127.0.0.1", () => resolve(created));
  });
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    const nativeFetch = globalThis.fetch;
    await run(async (_input, init) => await nativeFetch(`${origin}/api/usage/codex/quota`, init));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("fresh weekly observation below the local 90% cap permits", async () => {
  await withQuotaServer(quotaResponse(), async (fetchImpl) => {
    await admitCodexSubscriptionTurn({
      weeklyCapPercent: 90,
      fetchImpl,
    });
  });
});

test("at-cap, stale, elapsed, and absent observations hold", async () => {
  const cases: Array<{ body: Record<string, unknown>; status: string }> = [
    {
      body: quotaResponse({
        secondary: { windowMinutes: 10_080, usedPercent: 90, elapsed: false },
      }),
      status: "at-cap",
    },
    { body: quotaResponse({ capturedAt: "2000-01-01T00:00:00.000Z" }), status: "stale" },
    {
      body: quotaResponse({ secondary: { windowMinutes: 10_080, usedPercent: 1, elapsed: true } }),
      status: "elapsed",
    },
    { body: quotaResponse({ secondary: null }), status: "absent" },
  ];

  for (const entry of cases) {
    await withQuotaServer(entry.body, async (fetchImpl) => {
      await assert.rejects(
        admitCodexSubscriptionTurn({ weeklyCapPercent: 90, fetchImpl }),
        (error: unknown) =>
          error instanceof Error &&
          (error as { codexSubscriptionCap?: { status?: unknown; providerSubmitted?: unknown } })
            .codexSubscriptionCap?.status === entry.status &&
          (error as { codexSubscriptionCap?: { providerSubmitted?: unknown } }).codexSubscriptionCap
            ?.providerSubmitted === false,
      );
    });
  }
});

test("local telemetry read failure is a hold", async () => {
  await assert.rejects(
    admitCodexSubscriptionTurn({
      weeklyCapPercent: 90,
      fetchImpl: async () => {
        throw new Error("quota endpoint unavailable");
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { codexSubscriptionCap?: { status?: unknown; providerSubmitted?: unknown } })
        .codexSubscriptionCap?.status === "read-failed" &&
      (error as { codexSubscriptionCap?: { providerSubmitted?: unknown } }).codexSubscriptionCap
        ?.providerSubmitted === false,
  );
});

test("Codex cap denial persists and reaches IPC before client.prompt", async () => {
  await withTempHome("acpx-codex-cap-", async (homeDir) => {
    await withQuotaServer(
      quotaResponse({ secondary: { windowMinutes: 10_080, usedPercent: 90, elapsed: false } }),
      async (fetchImpl) => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = fetchImpl;
        try {
          const record = makeSessionRecord({
            acpxRecordId: "codex-cap-session",
            acpSessionId: "codex-cap-acp-session",
            agentCommand: "node /opt/codex-acp/dist/index.js",
            cwd: homeDir,
          });
          await writeSessionRecordFile(homeDir, record);
          let promptCalls = 0;
          const client = {
            prompt: async () => {
              promptCalls += 1;
              return { stopReason: "end_turn" as const };
            },
          } as unknown as AcpClient;
          const sent: QueueOwnerMessage[] = [];
          const task: QueueTask = {
            requestId: "codex-cap-request",
            message: "must not submit",
            prompt: [{ type: "text", text: "must not submit" }],
            permissionMode: "approve-all",
            waitForCompletion: true,
            enqueuedAt: Date.now(),
            send: (message) => sent.push(message),
            close: () => {},
            codexSubscriptionCapWeeklyPercent: 90,
          };

          await runQueuedTask(record.acpxRecordId, task, { sharedClient: client });

          assert.equal(promptCalls, 0, "client.prompt must remain behind Codex cap admission");
          const terminal = sent.find((message) => message.type === "error");
          assert(terminal && terminal.type === "error");
          assert.equal(terminal.detailCode, "codex-subscription-cap");
          assert.equal(terminal.codexSubscriptionCap?.providerSubmitted, false);
          const stream = await fs.readFile(sessionEventActivePath(record.acpxRecordId), "utf8");
          const persisted = JSON.parse(stream.trim()) as {
            error?: { data?: Record<string, unknown> };
          };
          assert.equal(persisted.error?.data?.code, "codex-subscription-cap");
          assert.equal(persisted.error?.data?.providerSubmitted, false);
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
  });
});
