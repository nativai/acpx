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
        res
          .writeHead(200, {
            "anthropic-ratelimit-unified-5h-utilization": "0.1",
            "anthropic-ratelimit-unified-7d-utilization": "0.1",
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
  subs: Array<{ id: string; fable: FableOutcome }>,
  run: (ctx: {
    lookupOptions: { homeDir: string; registryPath: string };
    hits: ProbeHit[];
  }) => Promise<void>,
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
    const { server, url } = await startMockMessages(fableByToken, hits);
    process.env.CLAUDE_MESSAGES_ENDPOINT = url;
    delete process.env.ACPX_SESSION_URL;
    try {
      await run({ lookupOptions: { homeDir: home, registryPath }, hits });
    } finally {
      server.close();
    }
  } finally {
    if (prevEndpoint === undefined) {
      delete process.env.CLAUDE_MESSAGES_ENDPOINT;
    } else {
      process.env.CLAUDE_MESSAGES_ENDPOINT = prevEndpoint;
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
