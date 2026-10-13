import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { resolveAcpxUiInternalOrigin } from "../src/acp/acpx-ui-internal-origin.js";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { resolveNoticeDeliveryOrigin } from "../src/cli/session/notice-delivery.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import {
  admitCodexSubscriptionTurn,
  resolveCodexQuotaOrigin,
} from "../src/runtime/engine/codex-subscription-cap.js";
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
        // brick://c028c10e — ⚠️ CLEARING THE ENV SEAM IS LOAD-BEARING HERE, unlike in
        // every other row in this file. This row drives the PRODUCTION call path
        // (`runQueuedTask` → `admitCodexSubscriptionTurn` with no `fetchImpl`) and
        // controls the quota read by patching `globalThis.fetch`. The seam cannot
        // tell a patched global from the real one, so it is consulted first — and
        // `scripts/run-tests.mjs` sets it run-wide, so its canned below-cap value
        // admitted the very turn this row exists to prove is BLOCKED. Any future row
        // that controls the read by patching the global rather than passing
        // `fetchImpl` needs this same opt-out.
        const realQuotaEnv = process.env.ACPX_TEST_CODEX_QUOTA_JSON;
        delete process.env.ACPX_TEST_CODEX_QUOTA_JSON;
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
          if (realQuotaEnv === undefined) {
            delete process.env.ACPX_TEST_CODEX_QUOTA_JSON;
          } else {
            process.env.ACPX_TEST_CODEX_QUOTA_JSON = realQuotaEnv;
          }
        }
      },
    );
  });
});

// ── The ACPX_TEST_CODEX_QUOTA_JSON seam ──────────────────────────────────────
// brick://c028c10e. The seam exists because CHILD PROCESSES in the suite reach this
// gate (a test spawns a real CLI, which takes a Codex turn) and nothing can be
// injected across a process boundary. It replaced an HTTP fixture server on a
// hardcoded 127.0.0.1:3456 — also real acpx-ui's port — which made two concurrent
// suite runs impossible and killed whichever lane took the heavy-gate mutex.
//
// `scripts/run-tests.mjs` sets it for the whole run, so these rows run WITH a
// below-cap value already in the environment. They pin the three properties that
// keep a test backdoor from eating the tests around it:
//   1. an explicitly injected `fetchImpl` always wins over it — this is what every
//      other row in this file relies on, and checking the env first silently turned
//      five HOLD rows into admits;
//   2. it is an INPUT, not a skip: an at-cap canned value still holds;
//   3. anything that does not parse as a usable observation is ignored, falling
//      through to the real read rather than admitting on a malformed value.

async function withQuotaEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const original = process.env.ACPX_TEST_CODEX_QUOTA_JSON;
  if (value === undefined) {
    delete process.env.ACPX_TEST_CODEX_QUOTA_JSON;
  } else {
    process.env.ACPX_TEST_CODEX_QUOTA_JSON = value;
  }
  try {
    await run();
  } finally {
    if (original === undefined) {
      delete process.env.ACPX_TEST_CODEX_QUOTA_JSON;
    } else {
      process.env.ACPX_TEST_CODEX_QUOTA_JSON = original;
    }
  }
}

// Fails the real read, WITHOUT using the `fetchImpl` parameter — so the env seam is
// still consulted and we can prove what it does. A test that passed `fetchImpl`
// here would be measuring the precedence rule instead.
async function withUnreachableQuotaEndpoint(run: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("quota endpoint unreachable");
  };
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("an injected fetchImpl always wins over ACPX_TEST_CODEX_QUOTA_JSON", async () => {
  // The env says 0% used; the injected response says 97%. The hold proves the
  // injection is not shadowed — the property every other row in this file needs.
  await withQuotaEnv(JSON.stringify(quotaResponse()), async () => {
    await assertHolds(quotaResponse({ secondary: weeklyWindow({ usedPercent: 97 }) }), {
      status: "at-cap",
    });
  });
});

test("a usable ACPX_TEST_CODEX_QUOTA_JSON observation replaces the endpoint read", async () => {
  await withUnreachableQuotaEndpoint(async () => {
    await withQuotaEnv(JSON.stringify(quotaResponse()), async () => {
      // Admitting while the endpoint throws is only possible via the canned value.
      await admitCodexSubscriptionTurn({ weeklyCapPercent: 90 });
    });
  });
});

test("an at-cap ACPX_TEST_CODEX_QUOTA_JSON observation still HOLDS — the seam is an input, not a skip", async () => {
  await withUnreachableQuotaEndpoint(async () => {
    await withQuotaEnv(
      JSON.stringify(quotaResponse({ secondary: weeklyWindow({ usedPercent: 97 }) })),
      async () => {
        await assert.rejects(
          admitCodexSubscriptionTurn({ weeklyCapPercent: 90 }),
          (error: unknown) => {
            assert.equal(capDetail(error)?.status, "at-cap");
            return true;
          },
        );
      },
    );
  });
});

// An unusable value must NOT admit. It falls through to the real read, which here
// fails — so the gate holds `read-failed`, exactly as if the variable were absent.
for (const [label, value] of [
  ["unparseable JSON", "{not json"],
  ["valid JSON of the wrong shape", JSON.stringify({ nope: true })],
  ["a weekly window that fails validation", JSON.stringify(quotaResponse({ secondary: {} }))],
  ["an empty value", ""],
] as const) {
  test(`ACPX_TEST_CODEX_QUOTA_JSON is ignored for ${label} and the real read is used`, async () => {
    await withUnreachableQuotaEndpoint(async () => {
      await withQuotaEnv(value, async () => {
        await assert.rejects(
          admitCodexSubscriptionTurn({ weeklyCapPercent: 90 }),
          (error: unknown) => {
            assert.equal(capDetail(error)?.status, "read-failed");
            return true;
          },
        );
      });
    });
  });
}

// ── Where the quota read goes (brick cfcfa0de) ───────────────────────────────
// The read used to be hard-wired to `http://127.0.0.1:3456`. On the workbench and on
// agent pods nothing listens there, the read fails, and an unreadable endpoint HOLDS —
// every Codex turn refused. Each row asserts on the URL the injected `fetchImpl`
// RECEIVES, so the origin is measured on the request itself, not on a helper's return.

const LOOPBACK_QUOTA_URL = "http://127.0.0.1:3456/api/usage/codex/quota";
const BOX_NAMESPACE_FILE = "dev-devbox\n";
const BOX_SERVICE_QUOTA_URL =
  "http://dev-server.dev-devbox.svc.cluster.local:3456/api/usage/codex/quota";

async function quotaUrlRequested(params: {
  env?: NodeJS.ProcessEnv;
  originSources?: { namespaceFile?: string; resolvConf?: string };
}): Promise<string> {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify(quotaResponse()), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await admitCodexSubscriptionTurn({ weeklyCapPercent: 90, fetchImpl, ...params });
  assert.equal(urls.length, 1, "exactly one quota read per admission");
  return urls[0];
}

test("quota origin rung 1: a set ACPX_UI_INTERNAL_URL is where the read goes — NOT the loopback", async () => {
  const url = await quotaUrlRequested({
    env: { ACPX_UI_INTERNAL_URL: "http://dev-server.dev-other.svc.cluster.local:3456" },
    originSources: { namespaceFile: BOX_NAMESPACE_FILE },
  });
  assert.equal(url, "http://dev-server.dev-other.svc.cluster.local:3456/api/usage/codex/quota");
  assert.notEqual(url, LOOPBACK_QUOTA_URL);
});

test("quota origin rung 1: padding and trailing slashes are normalised away", async () => {
  const url = await quotaUrlRequested({
    env: { ACPX_UI_INTERNAL_URL: "  http://127.0.0.1:3004///  " },
    originSources: {},
  });
  assert.equal(url, "http://127.0.0.1:3004/api/usage/codex/quota");
});

test("quota origin: a set-but-EMPTY ACPX_UI_INTERNAL_URL yields no ladder origin, so the read falls back to loopback", async () => {
  for (const blank of ["", "   "]) {
    const url = await quotaUrlRequested({
      env: { ACPX_UI_INTERNAL_URL: blank },
      // A namespace IS available: empty is authoritative in the shared ladder, so it must
      // NOT fall through to the Service — only the quota's own loopback rung catches it.
      originSources: { namespaceFile: BOX_NAMESPACE_FILE },
    });
    assert.equal(url, LOOPBACK_QUOTA_URL, `blank ${JSON.stringify(blank)}`);
  }
});

test("quota origin rung 2: unset + service-account namespace → this box's cluster-internal Service", async () => {
  const url = await quotaUrlRequested({
    env: {},
    originSources: { namespaceFile: BOX_NAMESPACE_FILE },
  });
  assert.equal(url, BOX_SERVICE_QUOTA_URL);
  assert.notEqual(url, LOOPBACK_QUOTA_URL);
});

test("quota origin rung 2: unset + resolv.conf only → the Service of the search-domain namespace", async () => {
  const url = await quotaUrlRequested({
    env: {},
    originSources: {
      resolvConf: "nameserver 10.0.0.10\nsearch dev-konsiq.svc.cluster.local svc.cluster.local\n",
    },
  });
  assert.equal(url, "http://dev-server.dev-konsiq.svc.cluster.local:3456/api/usage/codex/quota");
});

test("quota origin: nothing resolvable → the same-pod loopback (the quota read's own final rung)", async () => {
  assert.equal(await quotaUrlRequested({ env: {}, originSources: {} }), LOOPBACK_QUOTA_URL);
  assert.equal(
    await quotaUrlRequested({ env: {}, originSources: { resolvConf: "search example.com\n" } }),
    LOOPBACK_QUOTA_URL,
  );
});

test("quota origin: with no env injected, the read honours process.env.ACPX_UI_INTERNAL_URL", async () => {
  // The production call path passes no `env` (`runQueuedTask`), so this is the row that
  // proves the variable a pod or a devN rig sets actually reaches the request.
  const original = process.env.ACPX_UI_INTERNAL_URL;
  process.env.ACPX_UI_INTERNAL_URL = "http://127.0.0.1:3007/";
  try {
    const url = await quotaUrlRequested({});
    assert.equal(url, "http://127.0.0.1:3007/api/usage/codex/quota");
    assert.notEqual(url, LOOPBACK_QUOTA_URL);
  } finally {
    if (original === undefined) {
      delete process.env.ACPX_UI_INTERNAL_URL;
    } else {
      process.env.ACPX_UI_INTERNAL_URL = original;
    }
  }
});

test("one ladder: notice delivery and the quota read resolve through the same function", () => {
  assert.equal(resolveNoticeDeliveryOrigin, resolveAcpxUiInternalOrigin);
  // …and the quota read differs from it ONLY by the loopback rung.
  assert.equal(
    resolveCodexQuotaOrigin({}, { namespaceFile: BOX_NAMESPACE_FILE }),
    resolveAcpxUiInternalOrigin({}, { namespaceFile: BOX_NAMESPACE_FILE }),
  );
  assert.equal(resolveAcpxUiInternalOrigin({}, {}), undefined);
  assert.equal(resolveCodexQuotaOrigin({}, {}), "http://127.0.0.1:3456");
});
