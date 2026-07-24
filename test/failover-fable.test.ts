import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
import { AllSubscriptionsExhaustedError, FableShareExhaustedError } from "../src/errors.js";
import { attemptFailoverAndRetry } from "../src/runtime/engine/failover.js";
import type { SessionRecord } from "../src/types.js";

const FABLE = "claude-fable-5";

// A GET /api/oauth/usage mock that always 403s (no user:profile scope), so the
// fable state degrades to the 1-token probe these tests drive. Keeps the suite off
// the live endpoint (brick://a319745e RATE-LIMIT BUDGET: never poll in tests).
function startAlways403Usage(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(403).end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/api/oauth/usage` });
    });
  });
}

// Per-sub fable outcome: 200 (available), 429 (clean exhausted), or 500 (probe
// error → UNKNOWN). Haiku always answers 200 healthy so the sub is a viable
// non-fable failover target; only the fable dimension varies.
type FableOutcome = "available" | "exhausted" | "error";

type ProbeHit = { model: string; token: string };

// Mock /v1/messages that branches on the request-body model: haiku → healthy
// 5h/7d, claude-fable-5 → the sub's configured fable outcome. Records every hit so
// a test can assert the fable probe never fired for a non-Fable session.
function startMockMessages(
  fableByToken: Map<string, FableOutcome>,
  unifiedByToken: Map<string, number>,
  hits: ProbeHit[],
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let model = "";
        try {
          model = (JSON.parse(body) as { model?: string }).model ?? "";
        } catch {
          model = "";
        }
        hits.push({ model, token });
        if (model === FABLE) {
          const outcome = fableByToken.get(token) ?? "exhausted";
          if (outcome === "available") {
            res.writeHead(200).end("{}");
          } else if (outcome === "error") {
            res.writeHead(500).end("{}");
          } else {
            res.writeHead(429).end("{}");
          }
          return;
        }
        // Haiku unified usage probe. Default 0.1 (healthy → eligible failover
        // target); a high value models a genuinely 5h-maxed account.
        const util = String(unifiedByToken.get(token) ?? 0.1);
        res
          .writeHead(200, {
            "anthropic-ratelimit-unified-5h-utilization": util,
            "anthropic-ratelimit-unified-7d-utilization": util,
          })
          .end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/messages` });
    });
  });
}

let rigCounter = 0;

async function withRig(
  subs: Array<{ id: string; fable: FableOutcome; unified?: number }>,
  defaultId: string,
  run: (ctx: {
    homeDir: string;
    registryPath: string;
    hits: ProbeHit[];
    tokenOf: (id: string) => string;
  }) => Promise<void>,
): Promise<void> {
  resetKnownDeadSubs();
  rigCounter += 1;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fofable-"));
  const subsDir = path.join(home, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const profileDir = (id: string) => path.join(subsDir, id);
  const tokenOf = (id: string) => `tok-${rigCounter}-${id}`;
  const fableByToken = new Map<string, FableOutcome>();
  const unifiedByToken = new Map<string, number>();
  const hits: ProbeHit[] = [];
  try {
    for (const sub of subs) {
      await fs.mkdir(profileDir(sub.id), { recursive: true });
      await fs.writeFile(
        path.join(profileDir(sub.id), ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: tokenOf(sub.id) } }),
      );
      fableByToken.set(tokenOf(sub.id), sub.fable);
      if (sub.unified !== undefined) {
        unifiedByToken.set(tokenOf(sub.id), sub.unified);
      }
    }
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        version: 3,
        default: defaultId,
        profiles: subs.map((sub) => ({
          id: sub.id,
          label: sub.id,
          authMode: "subscription",
          adapter: "claude",
          account: sub.id,
          credentialSource: profileDir(sub.id),
        })),
      }),
    );
    const { server, url } = await startMockMessages(fableByToken, unifiedByToken, hits);
    // /api/oauth/usage always 403s here (no user:profile scope) so the fable state
    // DEGRADES to the 1-token probe these tests already mock — the pre-poll path.
    // Pinned to a mock so the suite NEVER touches the live usage endpoint.
    const usageServer = await startAlways403Usage();
    const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
    const prevUsage = process.env.CLAUDE_OAUTH_USAGE_ENDPOINT;
    const prevHome = process.env.HOME;
    process.env.CLAUDE_MESSAGES_ENDPOINT = url;
    process.env.CLAUDE_OAUTH_USAGE_ENDPOINT = usageServer.url;
    process.env.HOME = home;
    try {
      await run({ homeDir: home, registryPath, hits, tokenOf });
    } finally {
      server.close();
      usageServer.server.close();
      if (prevEndpoint === undefined) {
        delete process.env.CLAUDE_MESSAGES_ENDPOINT;
      } else {
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
      }
      if (prevUsage === undefined) {
        delete process.env.CLAUDE_OAUTH_USAGE_ENDPOINT;
      } else {
        process.env.CLAUDE_OAUTH_USAGE_ENDPOINT = prevUsage;
      }
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    resetKnownDeadSubs();
  }
}

function sessionRecord(subscription: string, model: string): SessionRecord {
  return {
    acpxRecordId: "rec-fable",
    cwd: "/work/fable",
    agentCommand: "claude",
    acpx: { session_options: { subscription, model } },
  } as SessionRecord;
}

function rateLimitError(effectiveAccount?: string): Error {
  const error = new Error("rate limit");
  (error as { acp?: { code: number; message: string; data: Record<string, unknown> } }).acp = {
    code: -32603,
    message: "rate limit",
    data: { errorKind: "rate_limit" },
  };
  if (effectiveAccount) {
    (
      error as { effectiveAccountMetadata?: { effectiveAccount: string } }
    ).effectiveAccountMetadata = { effectiveAccount };
  }
  return error;
}

test("AC6: Fable session, all subs fable-429 → FableShareExhaustedError, NO thrash", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted" },
      { id: "b", fable: "exhausted" },
      { id: "c", fable: "exhausted" },
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const record = sessionRecord("a", FABLE);
      let turns = 0;
      await assert.rejects(
        () =>
          attemptFailoverAndRetry<string>({
            record,
            triggerError: rateLimitError("a"),
            loadOpts: { homeDir, registryPath },
            runTurn: async () => {
              turns += 1;
              return "should-not-run";
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof FableShareExhaustedError);
          assert.equal(err.detailCode, "fable-share-exhausted");
          return true;
        },
      );
      // The short-circuit fires off the fable probe — the loop never ran a turn.
      assert.equal(turns, 0, "no full-turn thrash through every sub");
      // Selection unchanged → auto-recovery.
      assert.equal(record.acpx?.session_options?.subscription, "a");
    },
  );
});

test("AC8: a fable probe ERROR is UNKNOWN — degrades to trying that sub, no false terminal", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted" }, // current/failed sub: cleanly exhausted
      { id: "b", fable: "error" }, // probe errored → UNKNOWN, must be tried
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const record = sessionRecord("a", FABLE);
      let turns = 0;
      const out = await attemptFailoverAndRetry<string>({
        record,
        triggerError: rateLimitError("a"),
        loadOpts: { homeDir, registryPath },
        runTurn: async () => {
          turns += 1;
          return "200-OK";
        },
      });
      // b (unknown) was tried and its real turn succeeded — no false terminal.
      assert.equal(out.result, "200-OK");
      assert.equal(out.switchedTo, "b");
      assert.equal(turns, 1);
    },
  );
});

test("boundary: fable-available subset exhausts mid-loop → converted to FableShareExhaustedError", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted" }, // current/failed
      { id: "b", fable: "available" }, // available at probe time…
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const record = sessionRecord("a", FABLE);
      let turns = 0;
      await assert.rejects(
        () =>
          attemptFailoverAndRetry<string>({
            record,
            triggerError: rateLimitError("a"),
            loadOpts: { homeDir, registryPath },
            // …but its real turn also hits the fable limit.
            runTurn: async () => {
              turns += 1;
              throw rateLimitError("b");
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof FableShareExhaustedError);
          return true;
        },
      );
      assert.equal(turns, 1, "b (the only fable-available sub) was tried exactly once");
    },
  );
});

test("distinctness: a NON-Fable session never fable-probes (byte-identical failover)", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted" },
      { id: "b", fable: "exhausted" },
    ],
    "a",
    async ({ homeDir, registryPath, hits }) => {
      const record = sessionRecord("a", "opus");
      let turns = 0;
      // b is healthy on haiku → normal failover succeeds; the fable dimension of
      // both subs is irrelevant and must never be consulted for a non-Fable model.
      const out = await attemptFailoverAndRetry<string>({
        record,
        triggerError: rateLimitError("a"),
        loadOpts: { homeDir, registryPath },
        runTurn: async () => {
          turns += 1;
          return "200-OK";
        },
      });
      assert.equal(out.result, "200-OK");
      assert.equal(out.switchedTo, "b");
      assert.equal(turns, 1);
      assert.equal(
        hits.some((h) => h.model === FABLE),
        false,
        "a non-Fable session must never issue a claude-fable-5 probe",
      );
    },
  );
});

test("discrimination (a): all fable-429 + unified HEALTHY ⇒ FableShareExhaustedError w/ evidence", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted", unified: 0.25 }, // can still serve non-fable
      { id: "b", fable: "exhausted", unified: 0.08 },
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const record = sessionRecord("a", FABLE);
      await assert.rejects(
        () =>
          attemptFailoverAndRetry<string>({
            record,
            triggerError: rateLimitError("a"),
            loadOpts: { homeDir, registryPath },
            runTurn: async () => "should-not-run",
          }),
        (err: unknown) => {
          assert.ok(err instanceof FableShareExhaustedError);
          // the "unified healthy" claim is EVIDENCED by the numbers just read
          assert.match(err.message, /unified 5h \d+%\/7d \d+% — healthy/);
          assert.match(err.message, /fable 429 on 2\/2 subs/);
          return true;
        },
      );
    },
  );
});

test("discrimination (b): all fable-429 + unified ALSO maxed ⇒ generic exhaustion, NOT fable-share", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted", unified: 0.99 }, // whole account maxed
      { id: "b", fable: "exhausted", unified: 0.99 },
    ],
    "a",
    async ({ homeDir, registryPath }) => {
      const record = sessionRecord("a", FABLE);
      let turns = 0;
      await assert.rejects(
        () =>
          attemptFailoverAndRetry<string>({
            record,
            triggerError: rateLimitError("a"),
            loadOpts: { homeDir, registryPath },
            runTurn: async () => {
              turns += 1;
              return "should-not-run";
            },
          }),
        (err: unknown) => {
          // Must NOT mislabel a genuinely-maxed account as the fable-share cap.
          assert.ok(!(err instanceof FableShareExhaustedError));
          assert.ok(err instanceof AllSubscriptionsExhaustedError);
          return true;
        },
      );
      assert.equal(turns, 0, "nothing eligible → no thrash");
    },
  );
});
