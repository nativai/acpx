import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
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
  subs: Array<{ id: string; token: string }>,
  defaultId: string,
  run: (ctx: { registryPath: string }) => Promise<void>,
): Promise<void> {
  resetKnownDeadSubs();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fo-"));
  const subsDir = path.join(home, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  try {
    for (const s of subs) {
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
        default: defaultId,
        subscriptions: subs.map((s) => ({
          id: s.id,
          label: s.id,
          configDir: path.join(subsDir, s.id),
        })),
      }),
    );
    await run({ registryPath });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

function makeRecord(sessionsDir: string, subscription?: string): SessionRecord {
  return {
    acpxRecordId: "rec-fo",
    cwd: "/work/fo",
    agentCommand: "claude",
    ...(subscription ? { acpx: { session_options: { subscription } } } : {}),
  } as SessionRecord;
}

test("attemptFailoverAndRetry switches to a healthy sub and returns its result", async () => {
  await withRig(
    [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" },
    ],
    "a",
    async ({ registryPath }) => {
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
      process.env.HOME = path.dirname(path.dirname(path.dirname(registryPath)));
      try {
        const record = makeRecord("", "a");
        let turns = 0;
        const out = await attemptFailoverAndRetry<string>({
          record,
          loadOpts: { registryPath },
          runTurn: async () => {
            turns += 1;
            return "200-OK";
          },
        });
        assert.equal(out.result, "200-OK");
        assert.equal(out.switchedTo, "b");
        assert.equal(turns, 1);
        assert.equal(record.acpx?.session_options?.subscription, "b");
        assert.equal(record.acpx?.session_options?.subscription_switch?.reason, "failover");
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
    async ({ registryPath }) => {
      const { server, url } = await startMockMessages(
        new Map([
          ["tok-a", { status: 401 }],
          ["tok-b", { status: 401 }],
        ]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = path.dirname(path.dirname(path.dirname(registryPath)));
      try {
        const record = makeRecord("", "a");
        let turns = 0;
        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              loadOpts: { registryPath },
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
        assert.equal(record.acpx?.session_options?.subscription_switch, undefined);
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});

test("attemptFailoverAndRetry rethrows a non-failover error from the retried turn", async () => {
  await withRig(
    [
      { id: "a", token: "tok-a" },
      { id: "b", token: "tok-b" },
    ],
    "a",
    async ({ registryPath }) => {
      const { server, url } = await startMockMessages(
        new Map([
          ["tok-a", { status: 401 }],
          ["tok-b", { status: 200, util: 0.1 }],
        ]),
      );
      const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
      const prevHome = process.env.HOME;
      process.env.CLAUDE_MESSAGES_ENDPOINT = url;
      process.env.HOME = path.dirname(path.dirname(path.dirname(registryPath)));
      try {
        const record = makeRecord("", "a");
        await assert.rejects(
          () =>
            attemptFailoverAndRetry<string>({
              record,
              loadOpts: { registryPath },
              runTurn: async () => {
                throw new Error("model not found"); // not a failover trigger
              },
            }),
          /model not found/,
        );
      } finally {
        server.close();
        process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
        process.env.HOME = prevHome;
      }
    },
  );
});
