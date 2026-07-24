import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  consumeAutoSubscriptionSelection,
  resolveAutoSubscription,
} from "../src/runtime/engine/auto-subscription.js";

const CLAUDE_AGENT = "node /opt/claude-agent-acp/dist/index.js";
const FABLE = "claude-fable-5";

type FableOutcome = "available" | "exhausted";
type ProbeHit = { model: string; token: string };

// Mock /v1/messages branching on the request-body model: haiku → healthy 5h/7d,
// claude-fable-5 → the sub's configured outcome. Records hits so we can assert a
// non-Fable spawn never fable-probes.
function startMockMessages(
  fableByToken: Map<string, FableOutcome>,
  hits: ProbeHit[],
  haikuDelayMs = 0,
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
          res.writeHead(fableByToken.get(token) === "available" ? 200 : 429).end("{}");
          return;
        }
        // Haiku (unified usage) probe — optionally delayed to make the OVERALL
        // select time out while the (fast) fable probe still completes.
        const sendHaiku = () =>
          res
            .writeHead(200, {
              "anthropic-ratelimit-unified-5h-utilization": "0.1",
              "anthropic-ratelimit-unified-7d-utilization": "0.1",
            })
            .end("{}");
        if (haikuDelayMs > 0) {
          setTimeout(sendHaiku, haikuDelayMs);
        } else {
          sendHaiku();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/messages` });
    });
  });
}

// A GET /api/oauth/usage mock that always 403s (no user:profile scope), so the
// fable state degrades to the 1-token probe this rig drives. WITHOUT this, the new
// pollFableUsage() would hit the LIVE api.anthropic.com with the rig's fake tokens
// — a rate-limit-budget breach whose 429 also poisons the module-global back-off
// and flakes the suite (brick://a319745e VERIFICATION). Deterministic 403 ⇒ no
// back-off ever set.
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

let rigCounter = 0;

async function withRig(
  subs: Array<{ id: string; fable: FableOutcome }>,
  run: (ctx: {
    lookupOptions: { homeDir: string; registryPath: string };
    hits: ProbeHit[];
  }) => Promise<void>,
  options: { haikuDelayMs?: number } = {},
): Promise<void> {
  rigCounter += 1;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-autofable-"));
  const subsDir = path.join(home, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const configDir = (id: string) => path.join(subsDir, id);
  const tokenOf = (id: string) => `tok-${rigCounter}-${id}`;
  const fableByToken = new Map<string, FableOutcome>();
  const hits: ProbeHit[] = [];
  const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
  const prevUsage = process.env.CLAUDE_OAUTH_USAGE_ENDPOINT;
  const prevSessionUrl = process.env.ACPX_SESSION_URL;
  try {
    await fs.mkdir(subsDir, { recursive: true });
    for (const sub of subs) {
      await fs.mkdir(configDir(sub.id), { recursive: true });
      await fs.writeFile(
        path.join(configDir(sub.id), ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: tokenOf(sub.id) } }),
      );
      fableByToken.set(tokenOf(sub.id), sub.fable);
    }
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        version: 3,
        default: subs[0].id,
        profiles: subs.map((sub) => ({
          id: sub.id,
          label: sub.id,
          authMode: "subscription",
          adapter: "claude",
          account: sub.id,
          credentialSource: configDir(sub.id),
        })),
      }),
    );
    const { server, url } = await startMockMessages(fableByToken, hits, options.haikuDelayMs ?? 0);
    const usageServer = await startAlways403Usage();
    process.env.CLAUDE_MESSAGES_ENDPOINT = url;
    process.env.CLAUDE_OAUTH_USAGE_ENDPOINT = usageServer.url;
    delete process.env.ACPX_SESSION_URL;
    try {
      await run({ lookupOptions: { homeDir: home, registryPath }, hits });
    } finally {
      server.close();
      usageServer.server.close();
    }
  } finally {
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
    if (prevSessionUrl === undefined) {
      delete process.env.ACPX_SESSION_URL;
    } else {
      process.env.ACPX_SESSION_URL = prevSessionUrl;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("fable spawn, all subs fable-exhausted → reason 'all-fable-exhausted' + tally, falls back", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted" },
      { id: "b", fable: "exhausted" },
      { id: "c", fable: "exhausted" },
    ],
    async ({ lookupOptions }) => {
      const picked = await resolveAutoSubscription(CLAUDE_AGENT, lookupOptions, { model: FABLE });
      assert.equal(picked, undefined, "no fable-available sub → fall back to default");
      const summary = consumeAutoSubscriptionSelection();
      assert.equal(summary?.reason, "all-fable-exhausted");
      assert.equal(summary?.fellBack, true);
      assert.deepEqual(summary?.fable, { available: 0, exhausted: 3, probed: true });
    },
  );
});

test("fable spawn steers to the fable-AVAILABLE sub (not a fable-exhausted one)", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted" },
      { id: "b", fable: "available" },
    ],
    async ({ lookupOptions }) => {
      const picked = await resolveAutoSubscription(CLAUDE_AGENT, lookupOptions, { model: FABLE });
      assert.equal(picked, "b", "must pick the fable-available sub");
      const summary = consumeAutoSubscriptionSelection();
      assert.equal(summary?.picked, "b");
      assert.deepEqual(summary?.fable, { available: 1, exhausted: 1, probed: true });
    },
  );
});

test("non-Fable spawn: no fable probe, no fable tally", async () => {
  await withRig(
    [
      { id: "a", fable: "exhausted" },
      { id: "b", fable: "exhausted" },
    ],
    async ({ lookupOptions, hits }) => {
      const picked = await resolveAutoSubscription(CLAUDE_AGENT, lookupOptions, { model: "opus" });
      assert.ok(picked === "a" || picked === "b", "picks a healthy sub");
      const summary = consumeAutoSubscriptionSelection();
      assert.equal(summary?.fable, undefined, "no fable tally on a non-Fable spawn");
      assert.equal(
        hits.some((h) => h.model === FABLE),
        false,
        "non-Fable spawn must never issue a claude-fable-5 probe",
      );
    },
  );
});

test("completed fable probe survives an outer-deadline TIMEOUT → still 'all-fable-exhausted'", async () => {
  const prev = process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS;
  process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS = "200"; // force the outer deadline to fire
  try {
    await withRig(
      [
        { id: "a", fable: "exhausted" },
        { id: "b", fable: "exhausted" },
      ],
      async ({ lookupOptions }) => {
        // Usage (haiku) is delayed 900ms so selectLocal loses the 200ms deadline
        // race, but the fast fable probe completes → its verdict must NOT be
        // discarded as a generic 'timeout'.
        const picked = await resolveAutoSubscription(CLAUDE_AGENT, lookupOptions, { model: FABLE });
        assert.equal(picked, undefined, "no pick (usage timed out) → default binding");
        const summary = consumeAutoSubscriptionSelection();
        assert.equal(summary?.reason, "all-fable-exhausted", "not degraded to 'timeout'");
        assert.deepEqual(summary?.fable, { available: 0, exhausted: 2, probed: true });
      },
      { haikuDelayMs: 900 },
    );
  } finally {
    if (prev === undefined) {
      delete process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS;
    } else {
      process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS = prev;
    }
  }
});
