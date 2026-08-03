import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchFableSnapshot, readFableSnapshot } from "../src/config/fable-snapshot.js";
import {
  getSubscriptionsFableState,
  getSubscriptionsUsage,
  getSubscriptionsUsageWithFable,
  isFableModel,
  stampFableRealTurnExhausted,
} from "../src/config/subscription-usage.js";
import type { SubscriptionEntry } from "../src/config/subscriptions.js";

// The haiku half still caches by subscription id for 5 minutes, so each seeded
// sub needs a distinct id or one test's reading leaks into the next. The FABLE
// half is keyed by ACCOUNT in a per-rig ACPX_FABLE_SNAPSHOT_DIR, so it is already
// isolated — but distinct ids keep the two halves aligned.
let uidCounter = 0;
function uid(tag: string): string {
  uidCounter += 1;
  return `${tag}-${uidCounter}`;
}

type ProbeHit = { model: string; token: string; system: string | undefined };

type ModelOutcome = {
  /** HTTP status to return (default 200). */
  status?: number;
  /** 5h utilization header (haiku 200 only). */
  util5h?: number;
  /** 7d utilization header (haiku 200 only). */
  util7h?: number;
  /** unified-fallback-percentage header (haiku 200 only). */
  fallbackPct?: number;
  /** unified-fallback availability string (haiku 200 only). */
  fallbackAvail?: string;
  /** anthropic-ratelimit-unified-7d_oi-utilization — the REAL Fable weekly share. */
  fableUtil?: number;
  /** anthropic-ratelimit-unified-7d_oi-reset (epoch seconds). */
  fableReset?: number;
  /** anthropic-ratelimit-unified-7d_oi-status ("allowed", …). */
  fableStatus?: string;
  /** Hold the response open this long — lets a test ask again mid-probe. */
  delayMs?: number;
  /** Drop the connection instead of answering (network-error fixture). */
  destroy?: true;
};

// A mock /v1/messages keyed by (token → model → outcome). Reads the request body
// so it can return DIFFERENT results for the haiku probe vs the claude-fable-5
// probe on the SAME token — the whole point of the fable dimension — and so a
// test can assert the CC system prefix actually rides on the fable probe.
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
        let system: string | undefined;
        try {
          const parsed = JSON.parse(body) as {
            model?: string;
            system?: Array<{ text?: string }>;
          };
          model = parsed.model ?? "";
          system = parsed.system?.[0]?.text;
        } catch {
          model = "";
        }
        hits.push({ model, token, system });
        const outcome = outcomes.get(token)?.get(model);
        if (!outcome) {
          res.writeHead(500).end("{}");
          return;
        }
        if (outcome.destroy) {
          req.destroy();
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
        if (outcome.fableUtil !== undefined) {
          headers["anthropic-ratelimit-unified-7d_oi-utilization"] = String(outcome.fableUtil);
        }
        if (outcome.fableReset !== undefined) {
          headers["anthropic-ratelimit-unified-7d_oi-reset"] = String(outcome.fableReset);
        }
        if (outcome.fableStatus !== undefined) {
          headers["anthropic-ratelimit-unified-7d_oi-status"] = outcome.fableStatus;
        }
        const send = () => res.writeHead(outcome.status ?? 200, headers).end("{}");
        if (outcome.delayMs) {
          setTimeout(send, outcome.delayMs);
        } else {
          send();
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

const HAIKU = "claude-haiku-4-5-20251001";
const FABLE = "claude-fable-5";
const CC_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
/** A weekly reset that is always in the future, so a served reading is never
 *  stale-by-reset just because the suite is run on a later date. */
const FUTURE_RESET = Math.floor(Date.now() / 1000) + 3 * 86_400;
/** A CC-shaped fable 200 carrying the real weekly window, as measured live. */
const FABLE_200 = (util: number, reset = FUTURE_RESET): ModelOutcome => ({
  status: 200,
  fableUtil: util,
  fableReset: reset,
  fableStatus: "allowed",
});
/** A 429 that DOES carry unified headers — real exhaustion. */
const FABLE_429_EXHAUSTED: ModelOutcome = {
  status: 429,
  fableUtil: 1,
  fableReset: FUTURE_RESET,
  fableStatus: "rejected",
};
const HOUR_MS = 60 * 60_000;
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}
/** A BARE 429 — the request-shape gate. UNKNOWN, never clean exhaustion. */
const FABLE_429_BARE: ModelOutcome = { status: 429 };

type SubSpec = { id: string; outcomes: Map<string, ModelOutcome> };

type RigContext = {
  entries: SubscriptionEntry[];
  hits: ProbeHit[];
  /** The rig's isolated state home — its sessions index + registry live here. */
  home: string;
  /** Seed a fable-model session index entry so the activity gate can fire. */
  seedFableActivity: (opts: { account: string; profile: string; at: Date }) => Promise<void>;
};

// Every fable read resolves its snapshot from ACPX_FABLE_SNAPSHOT_DIR and its
// session index / profile registry from ACPX_STATE_HOME — both pinned to a
// throwaway dir here. WITHOUT that, `pnpm test` would write fixture values into
// the live /home/node/.acpx store that real agents read (the snapshot module's
// real-home guard refuses that outright under NODE_TEST_CONTEXT).
async function withProbeRig(subs: SubSpec[], run: (ctx: RigContext) => Promise<void>) {
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
  const prev = {
    endpoint: process.env.CLAUDE_MESSAGES_ENDPOINT,
    snapshotDir: process.env.ACPX_FABLE_SNAPSHOT_DIR,
    stateHome: process.env.ACPX_STATE_HOME,
  };
  process.env.CLAUDE_MESSAGES_ENDPOINT = url;
  process.env.ACPX_FABLE_SNAPSHOT_DIR = path.join(home, "usage-fable");
  process.env.ACPX_STATE_HOME = home;

  const seedFableActivity = async (opts: { account: string; profile: string; at: Date }) => {
    const sessionsDir = path.join(home, ".acpx", "sessions");
    const subsDir = path.join(home, ".acpx", "subscriptions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(subsDir, { recursive: true });
    await fs.writeFile(
      path.join(subsDir, "registry.json"),
      JSON.stringify({
        version: 3,
        default: opts.profile,
        profiles: [
          {
            id: opts.profile,
            label: opts.profile,
            authMode: "subscription",
            adapter: "claude",
            account: opts.account,
            credentialSource: path.join(subsDir, opts.profile),
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(sessionsDir, "index.json"),
      JSON.stringify({
        schema: "acpx.session-index.v1",
        files: ["s1.json"],
        entries: [
          {
            file: "s1.json",
            acpxRecordId: "s1",
            acpSessionId: "s1",
            agentCommand: "node /opt/claude-agent-acp/dist/index.js",
            cwd: "/workspace",
            closed: false,
            lastUsedAt: opts.at.toISOString(),
            lastWriteAt: opts.at.toISOString(),
            sessionModel: "fable",
            profile: opts.profile,
          },
        ],
      }),
    );
  };

  try {
    await run({ entries, hits, home, seedFableActivity });
  } finally {
    server.close();
    for (const [key, value] of [
      ["CLAUDE_MESSAGES_ENDPOINT", prev.endpoint],
      ["ACPX_FABLE_SNAPSHOT_DIR", prev.snapshotDir],
      ["ACPX_STATE_HOME", prev.stateHome],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

function fableHits(hits: ProbeHit[]): ProbeHit[] {
  return hits.filter((hit) => hit.model === FABLE);
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

// ── Probe shape + classification ────────────────────────────────────────────

test("the fable probe carries the Claude-Code system prefix (the shape gate)", async () => {
  const id = uid("shape");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.33)]]) }], async (ctx) => {
    await getSubscriptionsFableState(ctx.entries);
    const [probe] = fableHits(ctx.hits);
    assert.equal(probe?.system, CC_SYSTEM_PREFIX);
  });
});

test("200 → available + REAL 7d_oi utilization/reset, persisted to the snapshot", async () => {
  const id = uid("real200");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.33)]]) }], async (ctx) => {
    const state = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(state?.available, true);
    assert.equal(state?.error, undefined);
    assert.equal(state?.utilization, 0.33);
    assert.equal(state?.reset, new Date(FUTURE_RESET * 1000).toISOString());
    assert.ok(state?.fetchedAt);

    const snapshot = await readFableSnapshot(id);
    assert.equal(snapshot?.utilization, 0.33);
    assert.equal(snapshot?.status, "allowed");
    assert.equal(snapshot?.available, true);
    assert.equal(snapshot?.fetchedAt, state?.fetchedAt);
  });
});

test("200 availability comes from res.ok ALONE — an unexpected status string cannot park it", async () => {
  const id = uid("okwins");
  await withProbeRig(
    [{ id, outcomes: new Map([[FABLE, { ...FABLE_200(0.7), fableStatus: "allowed_warning" }]]) }],
    async (ctx) => {
      const state = (await getSubscriptionsFableState(ctx.entries)).get(id);
      assert.equal(state?.available, true);
      assert.equal(state?.utilization, 0.7);
    },
  );
});

test("429 WITH unified headers → clean exhaustion (available:false, NO error, % kept)", async () => {
  const id = uid("exhausted");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_429_EXHAUSTED]]) }], async (ctx) => {
    const state = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(state?.available, false);
    assert.equal(state?.error, undefined);
    assert.equal(state?.utilization, 1);
  });
});

test("BARE 429 (shape gate) → UNKNOWN (error set), never a clean exhaustion", async () => {
  const id = uid("bare429");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_429_BARE]]) }], async (ctx) => {
    const state = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(state?.available, false);
    assert.match(state?.error ?? "", /request-shape gate/);
    // UNKNOWN is never persisted, so the next ask re-probes rather than inheriting it.
    assert.equal((await readFableSnapshot(id))?.fetchedAt, undefined);
  });
});

test("network error → UNKNOWN (error set), nothing persisted", async () => {
  const id = uid("neterr");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, { destroy: true }]]) }], async (ctx) => {
    const state = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(state?.available, false);
    assert.notEqual(state?.error, undefined);
    assert.equal((await readFableSnapshot(id))?.fetchedAt, undefined);
  });
});

test("HTTP 401 → error set (unknown, not exhausted)", async () => {
  const id = uid("auth");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, { status: 401 }]]) }], async (ctx) => {
    const state = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(state?.available, false);
    assert.match(state?.error ?? "", /authentication failed/);
  });
});

test("fable state: missing credentials → error (never a false exhaustion)", async () => {
  const id = uid("nocreds");
  await withProbeRig([{ id, outcomes: new Map() }], async (ctx) => {
    const entries: SubscriptionEntry[] = [
      { id, label: id, configDir: path.join(ctx.home, "missing"), account: id },
    ];
    const state = (await getSubscriptionsFableState(entries)).get(id);
    assert.equal(state?.available, false);
    assert.match(state?.error ?? "", /no credentials/);
  });
});

// ── Freshness / gating ──────────────────────────────────────────────────────

test("AC2: a fresh snapshot is served with NO outbound fable probe", async () => {
  const id = uid("fresh");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.21)]]) }], async (ctx) => {
    const first = (await getSubscriptionsFableState(ctx.entries)).get(id);
    const second = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(fableHits(ctx.hits).length, 1, "second read must serve the snapshot");
    assert.equal(second?.utilization, 0.21);
    assert.equal(second?.fetchedAt, first?.fetchedAt, "fetchedAt must not advance");
  });
});

test("a reading older than the 2h cap is stale and re-probes", async () => {
  const id = uid("maxage");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.5)]]) }], async (ctx) => {
    await getSubscriptionsFableState(ctx.entries);
    // Age the reading past the cap; age the attempt so the min-interval guard is
    // not what decides the outcome.
    await patchFableSnapshot(id, {
      fetchedAt: isoAgo(3 * HOUR_MS),
      lastProbeAttemptAt: isoAgo(3 * HOUR_MS),
    });
    await getSubscriptionsFableState(ctx.entries);
    assert.equal(fableHits(ctx.hits).length, 2);
  });
});

test("a reading whose reset has passed is stale and re-probes", async () => {
  const id = uid("reset");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.5)]]) }], async (ctx) => {
    await getSubscriptionsFableState(ctx.entries);
    await patchFableSnapshot(id, {
      resetsAt: isoAgo(60_000),
      lastProbeAttemptAt: isoAgo(HOUR_MS),
    });
    await getSubscriptionsFableState(ctx.entries);
    assert.equal(fableHits(ctx.hits).length, 2);
  });
});

test("local fable activity since the reading makes it stale (gate keys off .profile)", async () => {
  const id = uid("activity");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.4)]]) }], async (ctx) => {
    await getSubscriptionsFableState(ctx.entries);
    assert.equal(fableHits(ctx.hits).length, 1);
    // Reading taken an hour ago; a fable session on this ACCOUNT wrote since —
    // reached through the registry's profiles[].account, because the index entry
    // carries a PROFILE id and never an account.
    await patchFableSnapshot(id, {
      fetchedAt: isoAgo(HOUR_MS),
      lastProbeAttemptAt: isoAgo(HOUR_MS),
    });
    await ctx.seedFableActivity({
      account: id,
      profile: `profile-${id}`,
      at: new Date(Date.now() - 60_000),
    });
    await getSubscriptionsFableState(ctx.entries);
    assert.equal(fableHits(ctx.hits).length, 2, "activity must invalidate the reading");
  });
});

test("activity on ANOTHER account does not invalidate this one", async () => {
  const id = uid("otheracct");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.4)]]) }], async (ctx) => {
    await getSubscriptionsFableState(ctx.entries);
    await patchFableSnapshot(id, {
      fetchedAt: isoAgo(HOUR_MS),
      lastProbeAttemptAt: isoAgo(HOUR_MS),
    });
    await ctx.seedFableActivity({
      account: "someone-else",
      profile: `profile-${id}`,
      at: new Date(Date.now() - 60_000),
    });
    await getSubscriptionsFableState(ctx.entries);
    assert.equal(fableHits(ctx.hits).length, 1);
  });
});

test("the activity gate can be switched off", async () => {
  const id = uid("gateoff");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.4)]]) }], async (ctx) => {
    await getSubscriptionsFableState(ctx.entries);
    await patchFableSnapshot(id, {
      fetchedAt: isoAgo(HOUR_MS),
      lastProbeAttemptAt: isoAgo(HOUR_MS),
    });
    await ctx.seedFableActivity({
      account: id,
      profile: `profile-${id}`,
      at: new Date(Date.now() - 60_000),
    });
    process.env.ACPX_FABLE_ACTIVITY_GATE = "0";
    try {
      await getSubscriptionsFableState(ctx.entries);
    } finally {
      delete process.env.ACPX_FABLE_ACTIVITY_GATE;
    }
    assert.equal(fableHits(ctx.hits).length, 1, "gate off ⇒ activity does not invalidate");
  });
});

test("the gated min-interval blocks a re-probe and serves the last reading instead", async () => {
  const id = uid("mininterval");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.4)]]) }], async (ctx) => {
    await getSubscriptionsFableState(ctx.entries);
    // Stale by the 2h cap, but the last attempt was 1 minute ago — inside the
    // 5-minute gated interval, so the ask collapses onto the existing reading.
    await patchFableSnapshot(id, {
      fetchedAt: isoAgo(3 * HOUR_MS),
      lastProbeAttemptAt: isoAgo(60_000),
    });
    const state = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(fableHits(ctx.hits).length, 1);
    assert.equal(state?.utilization, 0.4);
  });
});

test("force bypasses freshness but still honors the 30s burst guard", async () => {
  const id = uid("force");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.6)]]) }], async (ctx) => {
    await getSubscriptionsFableState(ctx.entries);
    assert.equal(fableHits(ctx.hits).length, 1);
    // Snapshot is FRESH; force re-probes it anyway (attempt aged past 30s).
    await patchFableSnapshot(id, { lastProbeAttemptAt: isoAgo(60_000) });
    await getSubscriptionsFableState(ctx.entries, "force");
    assert.equal(fableHits(ctx.hits).length, 2, "force must bypass the freshness gate");
    // A second force inside 30s collapses onto the reading just taken.
    const state = (await getSubscriptionsFableState(ctx.entries, "force")).get(id);
    assert.equal(fableHits(ctx.hits).length, 2, "burst collapse");
    assert.equal(state?.utilization, 0.6);
  });
});

test("the attempt stamp is claimed BEFORE the probe — an ask mid-flight does not re-probe", async () => {
  const id = uid("burst");
  await withProbeRig(
    [{ id, outcomes: new Map([[FABLE, { ...FABLE_200(0.15), delayMs: 300 }]]) }],
    async (ctx) => {
      const inFlight = getSubscriptionsFableState(ctx.entries);
      await new Promise((resolve) => setTimeout(resolve, 80));
      // The claim is already on disk even though no result exists yet — a second
      // asker must collapse onto it. Stamped WITH the result instead, the whole
      // request window would stay open for everyone to fire into.
      assert.ok((await readFableSnapshot(id))?.lastProbeAttemptAt);
      const second = (await getSubscriptionsFableState(ctx.entries)).get(id);
      assert.equal(fableHits(ctx.hits).length, 1, "the claim-first stamp must collapse the burst");
      assert.match(second?.error ?? "", /rate-limited/);
      await inFlight;
    },
  );
});

// ── Real-turn exhaustion stamp ──────────────────────────────────────────────

test("a real-turn stamp reports unavailable without advancing fetchedAt, and expires", async () => {
  const id = uid("stamp");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.2)]]) }], async (ctx) => {
    const fresh = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(fresh?.available, true);

    await stampFableRealTurnExhausted(ctx.entries);
    const snapshot = await readFableSnapshot(id);
    assert.ok(snapshot?.exhaustedStampAt);
    assert.equal(snapshot?.fetchedAt, fresh?.fetchedAt, "the stamp must not advance fetchedAt");
    assert.equal(snapshot?.utilization, 0.2, "the stamp must not touch utilization");

    const stamped = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(stamped?.available, false);
    assert.equal(fableHits(ctx.hits).length, 1, "the stamp is served, not re-probed");

    // Past its 10-minute TTL the stamp is ignored and the normal rules resume —
    // it must never become a box-wide sticky false negative for the full 2h cap.
    await patchFableSnapshot(id, { exhaustedStampAt: isoAgo(30 * 60_000) });
    const expired = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(expired?.available, true, "an expired stamp must not stick");
  });
});

test("a fresh reading supersedes an older real-turn stamp", async () => {
  const id = uid("stampclear");
  await withProbeRig([{ id, outcomes: new Map([[FABLE, FABLE_200(0.2)]]) }], async (ctx) => {
    await stampFableRealTurnExhausted(ctx.entries);
    await patchFableSnapshot(id, { exhaustedStampAt: isoAgo(30 * 60_000) });
    const state = (await getSubscriptionsFableState(ctx.entries)).get(id);
    assert.equal(state?.available, true);
    assert.equal((await readFableSnapshot(id))?.exhaustedStampAt, undefined);
  });
});

// ── Stitching + the non-fable cost gate ─────────────────────────────────────

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
          [FABLE, FABLE_200(0.11)],
        ]),
      },
    ],
    async (ctx) => {
      const [usage] = await getSubscriptionsUsageWithFable(ctx.entries);
      assert.equal(usage.fable?.available, true);
      assert.equal(usage.fable?.utilization, 0.11);
      // free fallback ALLOCATION read from the haiku 200 (no extra request)
      assert.equal(usage.fallback?.percentage, 0.5);
      assert.equal(usage.fallback?.availability, "available");
      // existing 5h/7d untouched
      assert.equal(usage.fiveHour?.utilization, 0.25);
      assert.equal(usage.sevenDay?.utilization, 0.08);
    },
  );
});

test("getSubscriptionsUsage (no fable): issues NO claude-fable-5 request (cost gate)", async () => {
  const id = uid("nofable");
  await withProbeRig(
    [
      {
        id,
        outcomes: new Map([
          [HAIKU, { status: 200, util5h: 0.1, util7h: 0.1 }],
          [FABLE, FABLE_200(0.1)],
        ]),
      },
    ],
    async (ctx) => {
      await getSubscriptionsUsage(ctx.entries);
      assert.equal(fableHits(ctx.hits).length, 0);
      assert.equal(
        ctx.hits.some((hit) => hit.model === HAIKU),
        true,
      );
    },
  );
});
