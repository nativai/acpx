import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getSubscriptionsFableState,
  getSubscriptionsUsage,
  getSubscriptionsUsageWithFable,
  isFableModel,
} from "../src/config/subscription-usage.js";
import type { SubscriptionEntry } from "../src/config/subscriptions.js";

// getSubscriptions{Usage,FableState} cache by subscription id for 5 minutes, so
// each seeded sub needs a distinct id or one test's reading leaks into the next.
let uidCounter = 0;
function uid(tag: string): string {
  uidCounter += 1;
  return `${tag}-${uidCounter}`;
}

type ProbeHit = { model: string; token: string };

type ModelOutcome = {
  /** HTTP status to return (default 200). */
  status?: number;
  /** 5h utilization header (haiku 200 only). */
  util5h?: number;
  /** 7d utilization header (haiku 200 only). */
  util7h?: number;
  /** unified-fallback-percentage header (haiku 200 only). */
  fallbackPct?: number;
  /** unified-fallback availability header (haiku 200 only). */
  fallbackAvail?: string;
};

// A mock /v1/messages keyed by (token → model → outcome). Reads the request body
// so it can return DIFFERENT results for the haiku probe vs the claude-fable-5
// probe on the SAME token — the whole point of the fable dimension. Records every
// hit so a test can assert which models were probed (AC2: non-Fable pays nothing).
function startMockMessages(
  outcomes: Map<string, Map<string, ModelOutcome>>,
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
        const outcome = outcomes.get(token)?.get(model);
        if (!outcome) {
          res.writeHead(500).end("{}");
          return;
        }
        const status = outcome.status ?? 200;
        if (status !== 200) {
          res.writeHead(status).end("{}");
          return;
        }
        const headers: Record<string, string> = {};
        if (outcome.util5h !== undefined) {
          headers["anthropic-ratelimit-unified-5h-utilization"] = String(outcome.util5h);
        }
        if (outcome.util7h !== undefined) {
          headers["anthropic-ratelimit-unified-7d-utilization"] = String(outcome.util7h);
        }
        if (outcome.fallbackPct !== undefined) {
          headers["anthropic-ratelimit-unified-fallback-percentage"] = String(outcome.fallbackPct);
        }
        if (outcome.fallbackAvail !== undefined) {
          headers["anthropic-ratelimit-unified-fallback"] = outcome.fallbackAvail;
        }
        res.writeHead(200, headers).end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/messages` });
    });
  });
}

const HAIKU = "claude-haiku-4-5-20251001";
const FABLE = "claude-fable-5";

type SubSpec = { id: string; outcomes: Map<string, ModelOutcome> };

async function withProbeRig(
  subs: SubSpec[],
  run: (ctx: { entries: SubscriptionEntry[]; hits: ProbeHit[] }) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fable-"));
  const outcomes = new Map<string, Map<string, ModelOutcome>>();
  const entries: SubscriptionEntry[] = [];
  for (const sub of subs) {
    const configDir = path.join(home, sub.id);
    await fs.mkdir(configDir, { recursive: true });
    const token = `token-${sub.id}`;
    await fs.writeFile(
      path.join(configDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    );
    outcomes.set(token, sub.outcomes);
    entries.push({ id: sub.id, label: sub.id, configDir, account: sub.id });
  }
  const hits: ProbeHit[] = [];
  const { server, url } = await startMockMessages(outcomes, hits);
  const prev = process.env.CLAUDE_MESSAGES_ENDPOINT;
  process.env.CLAUDE_MESSAGES_ENDPOINT = url;
  try {
    await run({ entries, hits });
  } finally {
    server.close();
    if (prev === undefined) {
      delete process.env.CLAUDE_MESSAGES_ENDPOINT;
    } else {
      process.env.CLAUDE_MESSAGES_ENDPOINT = prev;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("isFableModel: alias, full id, bracketed variant, case-insensitive", () => {
  assert.equal(isFableModel("fable"), true);
  assert.equal(isFableModel("claude-fable-5"), true);
  assert.equal(isFableModel("claude-fable-5[1m]"), true);
  assert.equal(isFableModel("CLAUDE-FABLE-5"), true);
  assert.equal(isFableModel("opus"), false);
  assert.equal(isFableModel("claude-haiku-4-5-20251001"), false);
  assert.equal(isFableModel(undefined), false);
  assert.equal(isFableModel(null), false);
  assert.equal(isFableModel(""), false);
});

test("fable probe: HTTP 200 → available (no error), clean state cached", async () => {
  const id = uid("avail");
  await withProbeRig(
    [{ id, outcomes: new Map([[FABLE, { status: 200 }]]) }],
    async ({ entries }) => {
      const state = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(state?.available, true);
      assert.equal(state?.error, undefined);
      assert.equal(state?.utilization, null); // no util header confirmed yet
      assert.equal(state?.reset, null);
    },
  );
});

test("fable probe: HTTP 429 → clean exhaustion (available:false, NO error)", async () => {
  const id = uid("exhausted");
  await withProbeRig(
    [{ id, outcomes: new Map([[FABLE, { status: 429 }]]) }],
    async ({ entries }) => {
      const state = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(state?.available, false);
      assert.equal(state?.error, undefined); // a clean 429 is NOT an error
    },
  );
});

test("fable probe: HTTP 401 → error set (unknown, not exhausted)", async () => {
  const id = uid("auth");
  await withProbeRig(
    [{ id, outcomes: new Map([[FABLE, { status: 401 }]]) }],
    async ({ entries }) => {
      const state = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(state?.available, false);
      assert.match(state?.error ?? "", /authentication failed/);
    },
  );
});

test("fable probe: missing credentials → error (never a false exhaustion)", async () => {
  const id = uid("nocreds");
  // Build an entry pointing at a dir with no .credentials.json.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fable-nc-"));
  const entries: SubscriptionEntry[] = [
    { id, label: id, configDir: path.join(home, "missing"), account: id },
  ];
  try {
    const state = (await getSubscriptionsFableState(entries)).get(id);
    assert.equal(state?.available, false);
    assert.match(state?.error ?? "", /no credentials/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("getSubscriptionsUsageWithFable: stitches fable onto usage + free fallback allocation", async () => {
  const id = uid("stitch");
  await withProbeRig(
    [
      {
        id,
        outcomes: new Map([
          [
            HAIKU,
            {
              status: 200,
              util5h: 0.25,
              util7h: 0.08,
              fallbackPct: 0.5,
              fallbackAvail: "available",
            },
          ],
          [FABLE, { status: 429 }],
        ]),
      },
    ],
    async ({ entries }) => {
      const [usage] = await getSubscriptionsUsageWithFable(entries);
      // fable dimension stitched on
      assert.equal(usage.fable?.available, false);
      // free fallback ALLOCATION read from the haiku 200 (no extra request)
      assert.equal(usage.fallback?.percentage, 0.5);
      assert.equal(usage.fallback?.availability, "available");
      // existing 5h/7d untouched
      assert.equal(usage.fiveHour?.utilization, 0.25);
      assert.equal(usage.sevenDay?.utilization, 0.08);
    },
  );
});

test("getSubscriptionsUsage (no fable): issues NO claude-fable-5 request (AC2 gate)", async () => {
  const id = uid("nofable");
  await withProbeRig(
    [
      {
        id,
        outcomes: new Map([
          [HAIKU, { status: 200, util5h: 0.1, util7h: 0.1 }],
          [FABLE, { status: 429 }],
        ]),
      },
    ],
    async ({ entries, hits }) => {
      await getSubscriptionsUsage(entries);
      assert.equal(
        hits.some((h) => h.model === FABLE),
        false,
        "plain usage probe must never issue a claude-fable-5 request",
      );
      assert.equal(
        hits.some((h) => h.model === HAIKU),
        true,
      );
    },
  );
});
