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

const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1_000;

// A weekly window shaped exactly like acpx-ui's `/api/usage/codex/quota`
// response: `resetsAt`/`resetsAtEpoch` are present on every real reading, and
// the gate's renewal check uses them.
function weeklyWindow(
  overrides: Record<string, unknown> = {},
  resetsAtMs = Date.now() + FOUR_DAYS_MS,
): Record<string, unknown> {
  return {
    windowMinutes: 10_080,
    usedPercent: 12,
    elapsed: false,
    resetsAt: new Date(resetsAtMs).toISOString(),
    resetsAtEpoch: Math.floor(resetsAtMs / 1_000),
    ...overrides,
  };
}

function quotaResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capturedAt: new Date().toISOString(),
    secondary: weeklyWindow(),
    ...overrides,
  };
}

async function assertAdmits(body: Record<string, unknown>, weeklyCapPercent = 90): Promise<void> {
  await withQuotaServer(body, async (fetchImpl) => {
    await admitCodexSubscriptionTurn({ weeklyCapPercent, fetchImpl });
  });
}

function capDetail(error: unknown): Record<string, unknown> | undefined {
  return (error as { codexSubscriptionCap?: Record<string, unknown> }).codexSubscriptionCap;
}

async function assertHolds(
  body: Record<string, unknown>,
  expected: { status: string; observationFreshness?: string },
  weeklyCapPercent = 90,
): Promise<void> {
  await withQuotaServer(body, async (fetchImpl) => {
    await assert.rejects(
      admitCodexSubscriptionTurn({ weeklyCapPercent, fetchImpl }),
      (error: unknown) => {
        assert(error instanceof Error);
        const detail = capDetail(error);
        assert.equal(detail?.status, expected.status);
        assert.equal(detail?.providerSubmitted, false);
        if (expected.observationFreshness !== undefined) {
          assert.equal(detail?.observationFreshness, expected.observationFreshness);
        }
        return true;
      },
    );
  });
}

async function withQuotaServer(
  body: Record<string, unknown>,
  run: (fetchImpl: typeof fetch) => Promise<void>,
  delayMs = 0,
): Promise<void> {
  const server = await new Promise<Server>((resolve) => {
    const created = createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(body));
      }, delayMs);
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

test("fresh local telemetry that exceeds the former two-second deadline permits", async () => {
  await withQuotaServer(
    quotaResponse(),
    async (fetchImpl) => {
      await admitCodexSubscriptionTurn({
        weeklyCapPercent: 90,
        fetchImpl,
      });
    },
    2_100,
  );
});

// ── The self-deadlock guarantees ─────────────────────────────────────────────
// The quota observation advances ONLY when an admitted Codex turn runs, so a
// gate that holds on staleness or absence can never be refreshed — it locks
// itself permanently. These four cases are the committed negative cases for that
// invariant (file header of src/runtime/engine/codex-subscription-cap.ts); each
// one FAILS against the pre-2026-09-28 code, which held on all of them.

test("a STALE below-cap observation admits — the reading cannot refresh without an admitted turn", async () => {
  // Daniel's measured case, 2026-09-28: a 4-day-old 75% reading against a 90%
  // cap blocked a subscription whose real weekly usage was 0%.
  await assertAdmits(
    quotaResponse({
      capturedAt: new Date(Date.now() - FOUR_DAYS_MS).toISOString(),
      secondary: weeklyWindow({ usedPercent: 75 }),
    }),
  );
});

test("an ELAPSED weekly window admits — the window renewed, which is the most permissive state", async () => {
  await assertAdmits(
    quotaResponse({ secondary: weeklyWindow({ usedPercent: 97, elapsed: true }) }),
  );
  // Same renewal, seen only via resetsAt: a response cached across the boundary
  // still carries the server's `elapsed: false`.
  await assertAdmits(
    quotaResponse({
      secondary: weeklyWindow({ usedPercent: 97 }, Date.now() - 60_000),
    }),
  );
});

test("an ABSENT observation admits — a box that never ran Codex must still be able to start one", async () => {
  await assertAdmits(quotaResponse({ secondary: null }));
  await assertAdmits(quotaResponse({ capturedAt: null, secondary: null }));
  await assertAdmits({});
});

// ── The cap still bites ──────────────────────────────────────────────────────

test("a FRESH at-or-over-cap observation holds", async () => {
  await assertHolds(quotaResponse({ secondary: weeklyWindow({ usedPercent: 90 }) }), {
    status: "at-cap",
    observationFreshness: "fresh",
  });
});

test("a STALE at-cap observation before its reset still holds, reported as at-cap", async () => {
  await assertHolds(
    quotaResponse({
      capturedAt: new Date(Date.now() - FOUR_DAYS_MS).toISOString(),
      secondary: weeklyWindow({ usedPercent: 99 }),
    }),
    { status: "at-cap", observationFreshness: "stale" },
  );
});

test("a STALE at-cap observation whose reset has passed admits — the hold self-heals", async () => {
  await assertAdmits(
    quotaResponse({
      capturedAt: new Date(Date.now() - FOUR_DAYS_MS).toISOString(),
      secondary: weeklyWindow({ usedPercent: 99 }, Date.now() - 60_000),
    }),
  );
});

test("an at-cap hold names the reset that clears it", async () => {
  const resetsAtMs = Date.now() + FOUR_DAYS_MS;
  const resetsAt = new Date(resetsAtMs).toISOString();
  await withQuotaServer(
    quotaResponse({ secondary: weeklyWindow({ usedPercent: 95 }, resetsAtMs) }),
    async (fetchImpl) => {
      await assert.rejects(
        admitCodexSubscriptionTurn({ weeklyCapPercent: 90, fetchImpl }),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /95\.0% weekly utilization/);
          assert(error.message.includes(resetsAt), `message must name ${resetsAt}`);
          assert.equal(capDetail(error)?.resetsAt, resetsAt);
          return true;
        },
      );
    },
  );
});

test("local telemetry read failure is a hold, and says it is an acpx-ui outage", async () => {
  await assert.rejects(
    admitCodexSubscriptionTurn({
      weeklyCapPercent: 90,
      fetchImpl: async () => {
        throw new Error("quota endpoint unavailable");
      },
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(capDetail(error)?.status, "read-failed");
      assert.equal(capDetail(error)?.providerSubmitted, false);
      assert.match(error.message, /could not be read/);
      assert.match(error.message, /acpx-ui outage, not a usage reading/);
      return true;
    },
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
