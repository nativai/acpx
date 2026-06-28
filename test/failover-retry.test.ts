import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAccountHealth, resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { AllSubscriptionsExhaustedError, BridgeAuthGatedError } from "../src/errors.js";
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

async function withHomeRig(
  homes: Array<{ id: string; account: string }>,
  defaultId: string,
  run: (ctx: {
    homeDir: string;
    registryPath: string;
    claudeAnchor: (id: string) => string;
  }) => Promise<void>,
): Promise<void> {
  resetKnownDeadSubs();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fo-home-"));
  const registryPath = path.join(home, ".acpx", "subscriptions", "registry.json");
  const homePath = (id: string) => path.join(home, "homes", id);
  const claudeAnchor = (id: string) => path.join(homePath(id), ".claude");
  try {
    for (const profile of homes) {
      await fs.mkdir(claudeAnchor(profile.id), { recursive: true });
    }
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        version: 3,
        default: defaultId,
        profiles: homes.map((profile) => ({
          id: profile.id,
          label: profile.id,
          authMode: "claude-home",
          adapter: "claude-pty",
          account: profile.account,
          credentialSource: null,
          homePath: homePath(profile.id),
        })),
      }),
    );
    await run({ homeDir: home, registryPath, claudeAnchor });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    resetKnownDeadSubs();
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
    agentCommand: "claude",
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

// The auth-gated bridge failure shape: a claude-pty AdapterHealthError carried to
// acpx as a generic RequestError on the catch-all code -32000 with
// data.reason/state === "auth-gated" (claude-pty-acp acp-server-transcript.mjs).
function authGatedError(
  message = "Interactive Claude login is required for this HOME",
  effectiveAccount?: string,
): Error {
  const error = new Error(message);
  (error as { acp?: { code: number; message: string; data: Record<string, unknown> } }).acp = {
    code: -32000,
    message,
    data: { reason: "auth-gated", state: "auth-gated" },
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

test("claude-home sibling failover ports the transcript across HOME anchors", async () => {
  await withHomeRig(
    [
      { id: "homeA", account: "acct-a" },
      { id: "homeB", account: "acct-b" },
    ],
    "homeA",
    async ({ homeDir, registryPath, claudeAnchor }) => {
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        const cwd = path.join(homeDir, "work");
        const acpSessionId = "claude-home-session";
        const record = makeRecord({
          profile: "homeA",
          acpSessionId,
          cwd,
        });
        const src = transcriptJsonlPath(claudeAnchor("homeA"), cwd, acpSessionId);
        await fs.mkdir(path.dirname(src), { recursive: true });
        await fs.writeFile(src, "remember: bridge context survives\n");

        const out = await attemptFailoverAndRetry<string>({
          record,
          loadOpts: { homeDir, registryPath },
          runTurn: async () => "HOME-OK",
        });

        assert.equal(out.switchedTo, "homeB");
        assert.equal(record.acpx?.session_options?.profile, "homeB");
        assert.equal(record.acpx?.session_options?.account_switch?.toAccount, "acct-b");
        const dst = transcriptJsonlPath(claudeAnchor("homeB"), cwd, acpSessionId);
        assert.equal(await fs.readFile(dst, "utf8"), "remember: bridge context survives\n");
      } finally {
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
test("S4: auth-gated bridge fails over to a healthy sibling bridge and the turn runs", async () => {
  await withHomeRig(
    [
      { id: "bridge2", account: "acct-b2" },
      { id: "bridge1", account: "acct-b1" },
    ],
    "bridge2",
    async ({ homeDir, registryPath, claudeAnchor }) => {
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        const cwd = path.join(homeDir, "work");
        const acpSessionId = "bridge-failover-session";
        const record = makeRecord({ profile: "bridge2", acpSessionId, cwd });
        // Seed the selected bridge's transcript so the failover ports it across.
        const src = transcriptJsonlPath(claudeAnchor("bridge2"), cwd, acpSessionId);
        await fs.mkdir(path.dirname(src), { recursive: true });
        await fs.writeFile(src, "bridge context\n");

        let turns = 0;
        const out = await attemptFailoverAndRetry<string>({
          record,
          triggerError: authGatedError(
            "Interactive Claude login is required for this HOME",
            "acct-b2",
          ),
          loadOpts: { homeDir, registryPath },
          runTurn: async () => {
            turns += 1;
            return "BRIDGE-OK";
          },
        });

        assert.equal(out.result, "BRIDGE-OK");
        assert.equal(out.switchedTo, "bridge1");
        assert.equal(turns, 1);
        assert.equal(record.acpx?.session_options?.profile, "bridge1");
      } finally {
        process.env.HOME = prevHome;
      }
    },
  );
});

// S3 — short, bounded TTL for a non-quota (auth-gated) dead-mark. The selected
// bridge is marked dead at now+~60s, NEVER the process-lifetime sentinel
// (9999-…). Because activeDeadUntil() treats a past deadUntil as "not dead", this
// auto-recovers in ~1 min with no acpx-ui restart (fixes defect D). Solo bridge
// (no sibling) so the turn exhausts immediately into a BridgeAuthGatedError (S5).
test("S3+S5: auth-gated dead-mark uses a ~60s TTL (not the sentinel) and throws BridgeAuthGatedError", async () => {
  await withHomeRig(
    [{ id: "solo", account: "acct-solo" }],
    "solo",
    async ({ homeDir, registryPath }) => {
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        const record = makeRecord({ profile: "solo" });
        const before = Date.now();
        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              triggerError: authGatedError(
                "Interactive Claude login is required for this HOME",
                "acct-solo",
              ),
              loadOpts: { homeDir, registryPath },
              runTurn: async () => "never",
            }),
          BridgeAuthGatedError,
        );
        const after = Date.now();

        const health = await getAccountHealth("acct-solo");
        assert.ok(health.deadUntil, "the auth-gated account was marked dead");
        assert.notEqual(
          health.deadUntil,
          "9999-12-31T23:59:59.999Z",
          "NOT the process-lifetime sentinel",
        );
        const deadMs = Date.parse(health.deadUntil);
        // deadUntil ≈ now + 60s (bounded by the call window).
        assert.ok(
          deadMs >= before + 60_000 && deadMs <= after + 60_000,
          `deadUntil ${health.deadUntil} should be ~now+60s`,
        );
        // Selection restored so a later turn (post-login) re-probes and recovers.
        assert.equal(record.acpx?.session_options?.profile, "solo");
        assert.equal(record.acpx?.session_options?.account_switch, undefined);
      } finally {
        process.env.HOME = prevHome;
      }
    },
  );
});

// S5 — acceptance #1: when the selected bridge AND its sibling are both
// auth-gated, the pool exhausts into a BridgeAuthGatedError (keyed on the INITIAL
// trigger), NOT a false AllSubscriptionsExhaustedError. Failover IS attempted
// (the sibling is tried) before exhausting — proving honest surfacing, not a
// quota lie. Both accounts carry the short non-quota TTL.
test("S5: both bridges auth-gated → BridgeAuthGatedError (not AllSubscriptionsExhaustedError), both short-TTL'd", async () => {
  await withHomeRig(
    [
      { id: "bridge2", account: "acct-b2" },
      { id: "bridge1", account: "acct-b1" },
    ],
    "bridge2",
    async ({ homeDir, registryPath, claudeAnchor }) => {
      const prevHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        const cwd = path.join(homeDir, "work");
        const acpSessionId = "both-gated-session";
        const record = makeRecord({ profile: "bridge2", acpSessionId, cwd });
        const src = transcriptJsonlPath(claudeAnchor("bridge2"), cwd, acpSessionId);
        await fs.mkdir(path.dirname(src), { recursive: true });
        await fs.writeFile(src, "bridge context\n");

        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              triggerError: authGatedError(
                "Interactive Claude login is required for this HOME",
                "acct-b2",
              ),
              loadOpts: { homeDir, registryPath },
              // The sibling is tried, but its login is gated too.
              runTurn: async () => {
                throw authGatedError(
                  "Interactive Claude login is required for this HOME",
                  "acct-b1",
                );
              },
            }),
          (err: unknown) => {
            assert.ok(err instanceof BridgeAuthGatedError, "throws BridgeAuthGatedError");
            assert.ok(!(err instanceof AllSubscriptionsExhaustedError), "NOT exhausted/quota");
            return true;
          },
        );

        // Both bridge accounts marked dead on the short TTL, not the sentinel.
        for (const account of ["acct-b2", "acct-b1"]) {
          const health = await getAccountHealth(account);
          assert.ok(health.deadUntil, `${account} marked dead`);
          assert.notEqual(health.deadUntil, "9999-12-31T23:59:59.999Z", `${account} not sentinel`);
        }
        // Selection restored to the original bridge for a later re-probe.
        assert.equal(record.acpx?.session_options?.profile, "bridge2");
      } finally {
        process.env.HOME = prevHome;
      }
    },
  );
});
