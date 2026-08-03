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
          // A clean exhaustion is a 429 that CARRIES unified rate-limit headers;
          // a BARE 429 is the request-shape gate and means UNKNOWN, not exhausted.
          const available = fableByToken.get(token) === "available";
          res
            .writeHead(available ? 200 : 429, {
              "anthropic-ratelimit-unified-7d_oi-utilization": available ? "0.4" : "1",
            })
            .end("{}");
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
  const prevEnv = {
    CLAUDE_MESSAGES_ENDPOINT: process.env.CLAUDE_MESSAGES_ENDPOINT,
    ACPX_SESSION_URL: process.env.ACPX_SESSION_URL,
    // Pin the persisted fable snapshot to this rig — the module refuses the real
    // home under test, and fixture values must never reach the live store.
    ACPX_FABLE_SNAPSHOT_DIR: process.env.ACPX_FABLE_SNAPSHOT_DIR,
    // This rig drives the probe directly; the local activity gate would only add
    // a session-index read it does not exercise.
    ACPX_FABLE_ACTIVITY_GATE: process.env.ACPX_FABLE_ACTIVITY_GATE,
  };
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
    process.env.CLAUDE_MESSAGES_ENDPOINT = url;
    process.env.ACPX_FABLE_SNAPSHOT_DIR = path.join(home, "usage-fable");
    process.env.ACPX_FABLE_ACTIVITY_GATE = "0";
    delete process.env.ACPX_SESSION_URL;
    try {
      await run({ lookupOptions: { homeDir: home, registryPath }, hits });
    } finally {
      server.close();
    }
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
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

// AC5 (brick://1badc6f1): with truthful probes and every sub showing headroom the
// tally must report N/N available — the observable that proves the fleet is no
// longer reading a shape-gated 429 as fleet-wide Fable exhaustion.
test("fable spawn, ALL subs available → tally N/N, no 'all-fable-exhausted' fallback", async () => {
  await withRig(
    [
      { id: "a", fable: "available" },
      { id: "b", fable: "available" },
      { id: "c", fable: "available" },
    ],
    async ({ lookupOptions }) => {
      const picked = await resolveAutoSubscription(CLAUDE_AGENT, lookupOptions, { model: FABLE });
      assert.ok(picked !== undefined, "a fable-available sub must be picked, not the fallback");
      const summary = consumeAutoSubscriptionSelection();
      assert.notEqual(summary?.reason, "all-fable-exhausted");
      assert.equal(summary?.fellBack, false);
      assert.deepEqual(summary?.fable, { available: 3, exhausted: 0, probed: true });
    },
  );
});
