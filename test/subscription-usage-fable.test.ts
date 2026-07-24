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

// The /api/oauth/usage outcome for a sub's token. Default (omitted) is 403 —
// "no user:profile scope" — so the fable state DEGRADES to the 1-token probe and
// the messages-endpoint outcomes drive the assertion, exactly as before the poll.
type UsageOutcome = {
  /** HTTP status to return (default 200 when `data` is set, else 403). */
  status?: number;
  /** The response body `data` array on a 200. */
  data?: unknown[];
  /** Retry-After header (seconds) on a 429. */
  retryAfter?: number;
};

// A mock GET /api/oauth/usage keyed by token. Records every token that hit it so a
// test can assert the poll replaced (or, on degrade, did NOT replace) the probe.
function startMockUsage(
  outcomes: Map<string, UsageOutcome>,
  hits: string[],
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      hits.push(token);
      const outcome = outcomes.get(token) ?? { status: 403 };
      const status = outcome.status ?? (outcome.data !== undefined ? 200 : 403);
      if (status === 200) {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: outcome.data ?? [] }));
        return;
      }
      const headers: Record<string, string> = {};
      if (status === 429 && outcome.retryAfter !== undefined) {
        headers["retry-after"] = String(outcome.retryAfter);
      }
      res.writeHead(status, headers).end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/api/oauth/usage` });
    });
  });
}

// A weekly_scoped Fable window shaped per the FINDINGS §7 ground-truth schema
// (brick://e0a1d05f): `kind`, `percent` (0..1), `resets_at` (epoch s), `is_enabled`,
// `scope.model.display_name`. `resets_at` defaults to the FINDINGS sample epoch.
function fableWeekly(percent: number, resetsAt = 1753441140): Record<string, unknown> {
  return {
    kind: "weekly_scoped",
    percent,
    resets_at: resetsAt,
    is_enabled: true,
    scope: { model: { display_name: "Fable 5" } },
  };
}

const HAIKU = "claude-haiku-4-5-20251001";
const FABLE = "claude-fable-5";

type SubSpec = { id: string; outcomes: Map<string, ModelOutcome>; usage?: UsageOutcome };

async function withProbeRig(
  subs: SubSpec[],
  run: (ctx: {
    entries: SubscriptionEntry[];
    hits: ProbeHit[];
    usageHits: string[];
  }) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fable-"));
  const outcomes = new Map<string, Map<string, ModelOutcome>>();
  const usageOutcomes = new Map<string, UsageOutcome>();
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
    if (sub.usage !== undefined) {
      usageOutcomes.set(token, sub.usage);
    }
    entries.push({ id: sub.id, label: sub.id, configDir, account: sub.id });
  }
  const hits: ProbeHit[] = [];
  const usageHits: string[] = [];
  const { server, url } = await startMockMessages(outcomes, hits);
  const { server: usageServer, url: usageUrl } = await startMockUsage(usageOutcomes, usageHits);
  const prev = process.env.CLAUDE_MESSAGES_ENDPOINT;
  const prevUsage = process.env.CLAUDE_OAUTH_USAGE_ENDPOINT;
  process.env.CLAUDE_MESSAGES_ENDPOINT = url;
  process.env.CLAUDE_OAUTH_USAGE_ENDPOINT = usageUrl;
  try {
    await run({ entries, hits, usageHits });
  } finally {
    server.close();
    usageServer.close();
    if (prev === undefined) {
      delete process.env.CLAUDE_MESSAGES_ENDPOINT;
    } else {
      process.env.CLAUDE_MESSAGES_ENDPOINT = prev;
    }
    if (prevUsage === undefined) {
      delete process.env.CLAUDE_OAUTH_USAGE_ENDPOINT;
    } else {
      process.env.CLAUDE_OAUTH_USAGE_ENDPOINT = prevUsage;
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

// ---- DEGRADE path: usage default is 403 (no user:profile scope), so the fable
// state falls back to the 1-token claude-fable-5 probe — the pre-poll behavior,
// preserved for sub1/4/6 until they are re-provisioned (brick://a319745e). ----

test("degrade (403 no-scope) → probe HTTP 200 → available (no error), clean state cached", async () => {
  const id = uid("avail");
  await withProbeRig(
    [{ id, outcomes: new Map([[FABLE, { status: 200 }]]) }],
    async ({ entries }) => {
      const state = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(state?.available, true);
      assert.equal(state?.error, undefined);
      assert.equal(state?.utilization, null); // probe carries no real % (poll does)
      assert.equal(state?.reset, null);
    },
  );
});

test("degrade (403 no-scope) → probe HTTP 429 → clean exhaustion (available:false, NO error)", async () => {
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

test("degrade (403 no-scope) → probe HTTP 401 → error set (unknown, not exhausted)", async () => {
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

test("fable state: missing credentials → error (never a false exhaustion)", async () => {
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

// ---- POLL path: /api/oauth/usage 200 with a weekly_scoped Fable window is the
// PRIMARY source — real %, real reset, and it REPLACES the 1-token probe. ----

test("poll 200 (Fable window) → real utilization + reset, and NO fable probe issued", async () => {
  const id = uid("poll200");
  await withProbeRig(
    [
      {
        id,
        // A fable probe outcome exists but must NOT be reached — the poll serves.
        outcomes: new Map([[FABLE, { status: 429 }]]),
        usage: {
          data: [
            { kind: "five_hour", percent: 0.24, resets_at: 1753437600, is_enabled: true },
            { kind: "seven_day", percent: 0.46, resets_at: 1753441140, is_enabled: true },
            fableWeekly(0.3),
          ],
        },
      },
    ],
    async ({ entries, hits, usageHits }) => {
      const state = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(state?.available, true); // 0.30 < 1 ⇒ headroom
      assert.equal(state?.error, undefined);
      assert.equal(state?.utilization, 0.3); // REAL % from the weekly_scoped window
      assert.equal(state?.reset, new Date(1753441140 * 1000).toISOString());
      // the poll replaced the probe: usage endpoint hit, claude-fable-5 NOT
      assert.equal(usageHits.length, 1);
      assert.equal(
        hits.some((h) => h.model === FABLE),
        false,
        "a served poll must not fall back to the 1-token fable probe",
      );
    },
  );
});

test("poll 200 (Fable window at 100%) → available:false (clean exhaustion, no error)", async () => {
  const id = uid("pollmaxed");
  await withProbeRig(
    [{ id, outcomes: new Map(), usage: { data: [fableWeekly(1)] } }],
    async ({ entries }) => {
      const state = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(state?.available, false);
      assert.equal(state?.error, undefined);
      assert.equal(state?.utilization, 1);
    },
  );
});

test("poll 200 (no Fable window) → available:true, utilization/reset null (absence ≠ exhausted)", async () => {
  const id = uid("pollnowin");
  await withProbeRig(
    [
      {
        id,
        outcomes: new Map(),
        usage: {
          data: [{ kind: "five_hour", percent: 0.5, resets_at: 1753437600, is_enabled: true }],
        },
      },
    ],
    async ({ entries }) => {
      const state = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(state?.available, true);
      assert.equal(state?.utilization, null);
      assert.equal(state?.reset, null);
      assert.equal(state?.error, undefined);
    },
  );
});

test("poll caches for the window: a second read issues NO further usage call", async () => {
  const id = uid("pollcache");
  await withProbeRig(
    [{ id, outcomes: new Map(), usage: { data: [fableWeekly(0.42)] } }],
    async ({ entries, usageHits }) => {
      const first = (await getSubscriptionsFableState(entries)).get(id);
      const second = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(first?.utilization, 0.42);
      assert.equal(second?.utilization, 0.42);
      assert.equal(usageHits.length, 1, "second read must be served from cache");
    },
  );
});

test("forceRefresh re-polls (outside any back-off)", async () => {
  const id = uid("pollforce");
  await withProbeRig(
    [{ id, outcomes: new Map(), usage: { data: [fableWeekly(0.5)] } }],
    async ({ entries, usageHits }) => {
      await getSubscriptionsFableState(entries);
      await getSubscriptionsFableState(entries, true); // forceRefresh
      assert.equal(usageHits.length, 2, "forceRefresh must issue a fresh poll");
    },
  );
});

test("poll 429 (Retry-After) → degrades to probe AND back-off blocks a forced re-poll", async () => {
  const id = uid("poll429");
  await withProbeRig(
    [
      {
        id,
        // degrade target: a 200 fable probe so the degraded state is `available`
        outcomes: new Map([[FABLE, { status: 200 }]]),
        usage: { status: 429, retryAfter: 3578 },
      },
    ],
    async ({ entries, hits, usageHits }) => {
      const first = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(first?.available, true); // degraded to the probe
      assert.equal(usageHits.length, 1);
      assert.equal(
        hits.some((h) => h.model === FABLE),
        true,
        "a 429 poll with no cache degrades to the 1-token probe",
      );
      // forceRefresh must NOT re-poll inside the Retry-After window (rate-limit budget)
      await getSubscriptionsFableState(entries, true);
      assert.equal(usageHits.length, 1, "back-off must block a forced re-poll");
    },
  );
});

test("poll picks the weekly_scoped Fable window, not five_hour / a non-Fable weekly", async () => {
  const id = uid("pollpick");
  await withProbeRig(
    [
      {
        id,
        outcomes: new Map(),
        usage: {
          data: [
            { kind: "five_hour", percent: 0.9, resets_at: 1753437600, is_enabled: true },
            {
              kind: "weekly_scoped",
              percent: 0.99,
              resets_at: 1753400000,
              is_enabled: true,
              scope: { model: { display_name: "Opus 4.8" } },
            },
            fableWeekly(0.12, 1753441140),
          ],
        },
      },
    ],
    async ({ entries }) => {
      const state = (await getSubscriptionsFableState(entries)).get(id);
      assert.equal(state?.utilization, 0.12); // the Fable weekly window, not 0.9 / 0.99
      assert.equal(state?.reset, new Date(1753441140 * 1000).toISOString());
    },
  );
});
