import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAccountHealth, resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
import { AllSubscriptionsExhaustedError } from "../src/errors.js";
import { attemptFailoverAndRetry } from "../src/runtime/engine/failover.js";
import type { SessionRecord } from "../src/types.js";

// A mock /v1/messages endpoint: maps a sub's bearer token to a utilization
// (or 401). Lets us drive pickFailoverTarget deterministically without a real API.
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

async function withRig(
  subs: Array<{ id: string; token: string; account?: string }>,
  defaultId: string,
  run: (ctx: {
    homeDir: string;
    registryPath: string;
    profileDir: (id: string) => string;
  }) => Promise<void>,
): Promise<void> {
  resetKnownDeadSubs();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fo-"));
  const subsDir = path.join(home, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const profileDir = (id: string) => path.join(subsDir, id);
  try {
    for (const s of subs) {
      const dir = profileDir(s.id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: s.token } }),
      );
    }
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        version: 3,
        default: defaultId,
        profiles: subs.map((s) => ({
          id: s.id,
          label: s.id,
          authMode: "subscription",
          adapter: "claude",
          account: s.account ?? s.id,
          credentialSource: profileDir(s.id),
        })),
      }),
    );
    await run({ homeDir: home, registryPath, profileDir });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

function makeRecord(options: {
  profile?: string;
  subscription?: string;
  acpSessionId?: string;
  cwd?: string;
}): SessionRecord {
  return {
    acpxRecordId: "rec-fo",
    cwd: options.cwd ?? "/work/fo",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    ...(options.acpSessionId ? { acpSessionId: options.acpSessionId } : {}),
    ...(options.profile || options.subscription
      ? {
          acpx: {
            session_options: {
              ...(options.profile ? { profile: options.profile } : {}),
              ...(options.subscription ? { subscription: options.subscription } : {}),
            },
          },
        }
      : {}),
  } as SessionRecord;
}

function rateLimitError(
  message = "rate limit",
  effectiveAccount?: string,
  resetAt?: string,
): Error {
  const error = new Error(message);
  (error as { acp?: { code: number; message: string; data: Record<string, unknown> } }).acp = {
    code: -32603,
    message,
    data: {
      errorKind: "rate_limit",
      ...(resetAt ? { resetsAt: resetAt } : {}),
    },
  };
  if (effectiveAccount) {
    (
      error as { effectiveAccountMetadata?: { effectiveAccount: string } }
    ).effectiveAccountMetadata = {
      effectiveAccount,
    };
  }
  return error;
}

function rawSessionLimitError(message: string): Error {
  const error = new Error(message);
  (error as { acp?: { code: number; message: string; data: Record<string, unknown> } }).acp = {
    code: -32603,
    message,
    data: {},
  };
  return error;
}

function futureSessionLimitMessage(minutesFromNow: number): { message: string; resetIso: string } {
  const reset = new Date(Date.now() + minutesFromNow * 60_000);
  reset.setUTCSeconds(0, 0);
  const hour24 = reset.getUTCHours();
  const hour12 = hour24 % 12 || 12;
  const minute = String(reset.getUTCMinutes()).padStart(2, "0");
  const meridiem = hour24 < 12 ? "am" : "pm";
  return {
    message: `Internal error: You've hit your session limit · resets ${hour12}:${minute}${meridiem} (UTC)`,
    resetIso: reset.toISOString(),
  };
}

test("attemptFailoverAndRetry switches to a healthy sub and returns its result", async () => {
  await withRig(
    [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" },
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      // a (the failed/current sub) is 401; b is healthy.
      const { server, url } = await startMockMessages(
        new Map([
          ["tok-a", { status: 401 }],
          ["tok-b", { status: 200, util: 0.1 }],
        ]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ subscription: "a" });
        let turns = 0;
        const out = await attemptFailoverAndRetry<string>({
          record,
          loadOpts: { homeDir, registryPath },
          runTurn: async () => {
            turns += 1;
            return "200-OK";
          },
        });
        assert.equal(out.result, "200-OK");
        assert.equal(out.switchedTo, "b");
        assert.equal(turns, 1);
        assert.equal(record.acpx?.session_options?.profile, "b");
        assert.equal(record.acpx?.session_options?.subscription, undefined);
        assert.equal(record.acpx?.session_options?.account_switch?.reason, "failover");
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("attemptFailoverAndRetry switches on raw Claude session-limit text and uses textual reset time", async () => {
  await withRig(
    [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" },
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const { server, url } = await startMockMessages(
        new Map([
          ["tok-a", { status: 401 }],
          ["tok-b", { status: 200, util: 0.1 }],
        ]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ subscription: "a" });
        const { message, resetIso } = futureSessionLimitMessage(90);
        let turns = 0;
        const out = await attemptFailoverAndRetry<string>({
          record,
          triggerError: rawSessionLimitError(message),
          loadOpts: { homeDir, registryPath },
          runTurn: async () => {
            turns += 1;
            return "SESSION-LIMIT-RECOVERED";
          },
        });

        assert.equal(out.result, "SESSION-LIMIT-RECOVERED");
        assert.equal(out.switchedTo, "b");
        assert.equal(turns, 1);
        assert.equal(record.acpx?.session_options?.profile, "b");
        assert.equal((await getAccountHealth("a")).deadUntil, resetIso);
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("attemptFailoverAndRetry throws AllSubscriptionsExhaustedError and restores selection when all dead", async () => {
  await withRig(
    [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" },
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const { server, url } = await startMockMessages(
        new Map([
          ["tok-a", { status: 401 }],
          ["tok-b", { status: 401 }],
        ]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ subscription: "a" });
        let turns = 0;
        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              loadOpts: { homeDir, registryPath },
              runTurn: async () => {
                turns += 1;
                return "should-not-run";
              },
            }),
          AllSubscriptionsExhaustedError,
        );
        assert.equal(turns, 0, "no retry when nothing to fail over to");
        // Selection restored (unchanged) so a later turn re-probes.
        assert.equal(record.acpx?.session_options?.subscription, "a");
        assert.equal(record.acpx?.session_options?.account_switch, undefined);
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("attemptFailoverAndRetry preserves exhausted contract for raw Claude session-limit text", async () => {
  await withRig(
    [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" },
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const { server, url } = await startMockMessages(
        new Map([
          ["tok-a", { status: 401 }],
          ["tok-b", { status: 401 }],
        ]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ subscription: "a" });
        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              triggerError: rawSessionLimitError(
                "Internal error: You've hit your session limit · resets 11:20am (UTC)",
              ),
              loadOpts: { homeDir, registryPath },
              runTurn: async () => "should-not-run",
            }),
          (err: unknown): boolean => {
            assert.ok(err instanceof AllSubscriptionsExhaustedError);
            assert.equal(err.detailCode, "all-subscriptions-exhausted");
            return true;
          },
        );
        assert.equal(record.acpx?.session_options?.subscription, "a");
        assert.equal(record.acpx?.session_options?.account_switch, undefined);
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("stale selected profile does not exclude the physically available target", async () => {
  await withRig(
    [
      { id: "subA", token: "tok-a", account: "acct-a" },
      { id: "subB", token: "tok-b", account: "acct-b" },
    ],
    "subA",
    async ({ homeDir, registryPath, profileDir }) => {
      const { server, url } = await startMockMessages(
        new Map([["tok-b", { status: 200, util: 0.1 }]]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ profile: "subB" });
        record.acpx!.session_options!.account_switch = {
          fromProfile: "subA",
          toProfile: "subB",
          fromAccount: "acct-a",
          toAccount: "acct-b",
          effectiveAccount: "acct-a",
          effectiveProfile: "subA",
          effectiveAuthMode: "subscription",
          effectiveAnchor: profileDir("subA"),
          effectiveResolutionMethod: "path",
          reason: "failover",
          at: "2026-06-28T21:27:56.391Z",
        };

        let turns = 0;
        const out = await attemptFailoverAndRetry<string>({
          record,
          triggerError: rateLimitError("monthly spend limit", "acct-a"),
          loadOpts: { homeDir, registryPath },
          runTurn: async () => {
            turns += 1;
            return "subB-OK";
          },
        });

        assert.equal(out.result, "subB-OK");
        assert.equal(out.switchedTo, "subB");
        assert.equal(turns, 1);
        assert.equal(record.acpx?.session_options?.profile, "subB");
        assert.equal(record.acpx?.session_options?.account_switch?.effectiveAccount, "acct-a");
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("attemptFailoverAndRetry rethrows a non-failover error and restores selection", async () => {
  await withRig(
    [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" },
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const { server, url } = await startMockMessages(
        new Map([
          ["tok-a", { status: 401 }],
          ["tok-b", { status: 200, util: 0.1 }],
        ]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ subscription: "a" });
        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              loadOpts: { homeDir, registryPath },
              runTurn: async () => {
                throw new Error("model not found"); // not a failover trigger
              },
            }),
          /model not found/,
        );
        assert.equal(record.acpx?.session_options?.subscription, "a");
        assert.equal(record.acpx?.session_options?.profile, undefined);
        assert.equal(record.acpx?.session_options?.account_switch, undefined);
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("profile-pinned SDK failover rewrites the unified profile selection", async () => {
  await withRig(
    [
      { id: "subA", token: "tok-a", account: "acct-a" },
      { id: "subB", token: "tok-b", account: "acct-b" },
    ],
    "subA",
    async ({ homeDir, registryPath }) => {
      const { server, url } = await startMockMessages(
        new Map([
          ["tok-a", { status: 401 }],
          ["tok-b", { status: 200, util: 0.1 }],
        ]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ profile: "subA", subscription: "legacy-subA" });
        const out = await attemptFailoverAndRetry<string>({
          record,
          loadOpts: { homeDir, registryPath },
          runTurn: async () => "OK",
        });

        assert.equal(out.switchedTo, "subB");
        assert.equal(record.acpx?.session_options?.profile, "subB");
        assert.equal(record.acpx?.session_options?.subscription, undefined);
        assert.equal(record.acpx?.session_options?.account_switch?.fromAccount, "acct-a");
        assert.equal(record.acpx?.session_options?.account_switch?.toAccount, "acct-b");
        assert.equal(record.acpx?.session_options?.account_switch?.effectiveAccount, "acct-a");
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("retry failure marks the effective account, not the intended target account", async () => {
  await withRig(
    [
      { id: "subA", token: "tok-a", account: "acct-a" },
      { id: "subB", token: "tok-b", account: "acct-b" },
    ],
    "subA",
    async ({ homeDir, registryPath }) => {
      const { server, url } = await startMockMessages(
        new Map([["tok-b", { status: 200, util: 0.1 }]]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ profile: "subA" });
        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              loadOpts: { homeDir, registryPath },
              runTurn: async () => {
                throw rateLimitError("rate limit on still-pinned source", "acct-a");
              },
            }),
          AllSubscriptionsExhaustedError,
        );

        assert.equal((await getAccountHealth("acct-a")).deadUntil, "9999-12-31T23:59:59.999Z");
        assert.equal((await getAccountHealth("acct-b")).deadUntil, undefined);
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("no sibling profile produces an honest failover-unavailable exhaustion", async () => {
  await withRig(
    [{ id: "solo", token: "tok-solo", account: "acct-solo" }],
    "solo",
    async ({ homeDir, registryPath }) => {
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ profile: "solo" });
        const resetAt = "2099-01-01T22:00:00.000Z";
        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              triggerError: rateLimitError("rate limit", "acct-solo", resetAt),
              loadOpts: { homeDir, registryPath },
              runTurn: async () => "never",
            }),
          /failover unavailable - profile "solo" \(subscription\) has no sibling account; account "acct-solo" resets 22:00Z; effectiveAccount "acct-solo"/,
        );
        assert.equal(record.acpx?.session_options?.profile, "solo");
        assert.equal(record.acpx?.session_options?.account_switch, undefined);
      } finally {
        process.env.HOME = prevHome;
      }
    },
  );
});

// S4 — acceptance #2: an auth-gated selected bridge fails over to a HEALTHY
// sibling bridge. The turn runs on the sibling; no error is surfaced. Proves
// "auth_gated" is a real (non-null) failover trigger that still reaches a usable
// bridge while the pool has one.
// Regression for 52906cf1: account-level lock exclusion in turn-failover.
// Account-locked siblings are excluded UPSTREAM in failoverCandidates via
// isSubscriptionProfileLocked, before they ever reach pickSubscriptionSibling.
// This test exercises that upstream guarantee: sub-c (same account as the
// directly-locked sub-b) must NOT be selected; sub-d (different account, healthy)
// MUST be selected. The test goes RED if the isSubscriptionProfileLocked filter
// in failoverCandidates is defeated.
test("attemptFailoverAndRetry: account-level-locked sibling is skipped; valid sibling on different account is chosen", async () => {
  resetKnownDeadSubs();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fo-acct-lock-"));
  const subsDir = path.join(home, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const profileDir = (id: string) => path.join(subsDir, id);
  const tokenOf = (id: string) => `tok-acct-lock-${id}`;

  for (const id of ["sub-a", "sub-b", "sub-c", "sub-d"]) {
    await fs.mkdir(profileDir(id), { recursive: true });
    await fs.writeFile(
      path.join(profileDir(id), ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: tokenOf(id) } }),
    );
  }
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      version: 3,
      default: "sub-a",
      profiles: [
        {
          id: "sub-a",
          label: "sub-a",
          authMode: "subscription",
          adapter: "claude",
          account: "acct-a",
          credentialSource: profileDir("sub-a"),
        },
        {
          // sub-b is directly locked — its entire account ("acct-shared") is locked
          id: "sub-b",
          label: "sub-b",
          authMode: "subscription",
          adapter: "claude",
          account: "acct-shared",
          credentialSource: profileDir("sub-b"),
          locked: true,
        },
        {
          // sub-c shares the account of the locked sub-b → account-level locked;
          // isSubscriptionProfileLocked must exclude it from failover candidates
          id: "sub-c",
          label: "sub-c",
          authMode: "subscription",
          adapter: "claude",
          account: "acct-shared",
          credentialSource: profileDir("sub-c"),
        },
        {
          // sub-d has an independent account and is the only valid target
          id: "sub-d",
          label: "sub-d",
          authMode: "subscription",
          adapter: "claude",
          account: "acct-d",
          credentialSource: profileDir("sub-d"),
        },
      ],
    }),
  );

  const { server, url } = await startMockMessages(
    new Map([
      [tokenOf("sub-c"), { status: 200, util: 0.1 }], // headroom, but must be excluded
      [tokenOf("sub-d"), { status: 200, util: 0.2 }], // the correct target
    ]),
  );
  const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
  const prevHome = process.env.HOME;
  process.env.CLAUDE_MESSAGES_ENDPOINT = url;
  process.env.HOME = home;
  try {
    const record = makeRecord({ profile: "sub-a" });
    const out = await attemptFailoverAndRetry<string>({
      record,
      triggerError: rateLimitError("rate limit", "acct-a"),
      loadOpts: { homeDir: home, registryPath },
      runTurn: async () => "ok",
    });
    // sub-d must be selected; sub-c (account-level locked via sub-b) must not be
    assert.equal(out.switchedTo, "sub-d", "account-level-locked sub-c must not be chosen");
    assert.equal(out.result, "ok");
  } finally {
    server.close();
    if (prevEndpoint === undefined) {
      delete process.env.CLAUDE_MESSAGES_ENDPOINT;
    } else {
      process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
    }
    process.env.HOME = prevHome;
    await fs.rm(home, { recursive: true, force: true });
    resetKnownDeadSubs();
  }
});
