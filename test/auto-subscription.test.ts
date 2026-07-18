import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  countEligibleFailoverTargets,
  pickFailoverTarget,
  type SubscriptionUsage,
} from "../src/config/subscription-usage.js";
import {
  consumeAutoSubscriptionSelection,
  isAutoSubscriptionSentinel,
  resolveAutoSubscription,
} from "../src/runtime/engine/auto-subscription.js";
import {
  bindDefaultAccountToSessionOptions,
  bindDefaultAccountToSessionOptionsAsync,
  bindRecordToDefaultAccount,
} from "../src/runtime/engine/default-account-binding.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const CLAUDE_AGENT = "node /opt/claude-agent-acp/dist/index.js";
const CODEX_AGENT = "npx -y @agentclientprotocol/codex-acp";

// getSubscriptionsUsage caches a successful probe by subscription id for 5
// minutes, so every seeded sub across every test needs a distinct id or one
// test's reading would leak into the next. A monotonic counter guarantees that.
let uidCounter = 0;
function uid(tag: string): string {
  uidCounter += 1;
  return `${tag}-${uidCounter}`;
}

type SubOutcome = {
  /** 5h utilization fraction; omit to send no 5h header (→ ineligible). */
  util5h?: number;
  /** 7d utilization fraction. */
  util7h?: number;
  /** 7d reset, epoch seconds — smaller = sooner (the primary tie-break key). */
  reset7d?: number;
  /** HTTP status to return (default 200); 401 models an auth failure. */
  status?: number;
  /** Response delay in ms — used to exercise the selection timeout. */
  delayMs?: number;
};

type SubSpec = {
  id: string;
  account?: string;
  locked?: true;
  /** Skip writing .credentials.json → probe reports a "no credentials" error. */
  noCredentials?: boolean;
  outcome: SubOutcome;
};

// A mock /v1/messages endpoint keyed by bearer token → rate-limit outcome, so the
// REAL getSubscriptionsUsage probe round-trips without hitting Anthropic. This is
// the actual selection path (no mock of the selector itself).
function startMockMessages(
  tokenToOutcome: Map<string, SubOutcome>,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const outcome = tokenToOutcome.get(token);
      if (!outcome || (outcome.status && outcome.status !== 200)) {
        res.writeHead(outcome?.status ?? 500).end("{}");
        return;
      }
      const headers: Record<string, string> = {};
      if (outcome.util5h !== undefined) {
        headers["anthropic-ratelimit-unified-5h-utilization"] = String(outcome.util5h);
      }
      if (outcome.util7h !== undefined) {
        headers["anthropic-ratelimit-unified-7d-utilization"] = String(outcome.util7h);
      }
      if (outcome.reset7d !== undefined) {
        headers["anthropic-ratelimit-unified-7d-reset"] = String(outcome.reset7d);
      }
      const send = () => {
        res.writeHead(200, headers);
        res.end("{}");
      };
      if (outcome.delayMs) {
        setTimeout(send, outcome.delayMs);
      } else {
        send();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/messages` });
    });
  });
}

type AutoRigContext = {
  lookupOptions: { homeDir: string; registryPath: string };
  configDir: (id: string) => string;
};

// Seed a v3 registry + per-sub credentials, point the probe at a mock messages
// server, and clear ACPX_SESSION_URL so the cross-HOME diagnostic is inert unless
// a test opts in. Restores CLAUDE_MESSAGES_ENDPOINT / ACPX_SESSION_URL after.
async function withAutoRig(
  subs: SubSpec[],
  run: (ctx: AutoRigContext) => Promise<void>,
  registryOptions: { defaultId?: string } = {},
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-auto-"));
  const subsDir = path.join(home, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const configDir = (id: string) => path.join(subsDir, id);
  const tokenOf = (id: string) => `token-${id}`;
  const tokenToOutcome = new Map<string, SubOutcome>();
  for (const sub of subs) {
    tokenToOutcome.set(tokenOf(sub.id), sub.outcome);
  }
  const { server, url } = await startMockMessages(tokenToOutcome);
  const prevEndpoint = process.env.CLAUDE_MESSAGES_ENDPOINT;
  const prevSessionUrl = process.env.ACPX_SESSION_URL;
  process.env.CLAUDE_MESSAGES_ENDPOINT = url;
  delete process.env.ACPX_SESSION_URL;
  try {
    await fs.mkdir(subsDir, { recursive: true });
    for (const sub of subs) {
      await fs.mkdir(configDir(sub.id), { recursive: true });
      if (!sub.noCredentials) {
        await fs.writeFile(
          path.join(configDir(sub.id), ".credentials.json"),
          JSON.stringify({ claudeAiOauth: { accessToken: tokenOf(sub.id) } }),
        );
      }
    }
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        version: 3,
        ...(registryOptions.defaultId ? { default: registryOptions.defaultId } : {}),
        profiles: subs.map((sub) => ({
          id: sub.id,
          label: sub.id,
          authMode: "subscription",
          adapter: "claude",
          account: sub.account ?? sub.id,
          credentialSource: configDir(sub.id),
          ...(sub.locked ? { locked: true } : {}),
        })),
      }),
    );
    await run({ lookupOptions: { homeDir: home, registryPath }, configDir });
  } finally {
    server.close();
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

function usage(over: Partial<SubscriptionUsage> & { id: string }): SubscriptionUsage {
  return {
    label: over.id,
    fiveHour: null,
    sevenDay: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Sentinel + pure selector
// ---------------------------------------------------------------------------

test("isAutoSubscriptionSentinel matches auto case/space-insensitively, not ids", () => {
  assert.equal(isAutoSubscriptionSentinel("auto"), true);
  assert.equal(isAutoSubscriptionSentinel("  AUTO "), true);
  assert.equal(isAutoSubscriptionSentinel("Auto"), true);
  assert.equal(isAutoSubscriptionSentinel("work-1"), false);
  assert.equal(isAutoSubscriptionSentinel(""), false);
  assert.equal(isAutoSubscriptionSentinel(undefined), false);
});

test("selector: among 5h-headroom subs, soonest 7d reset wins (§10.1)", () => {
  const usages = [
    usage({
      id: "a",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.4, reset: "2026-07-18T05:00:00.000Z" },
    }),
    usage({
      id: "b",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.4, reset: "2026-07-18T02:00:00.000Z" },
    }),
  ];
  assert.equal(pickFailoverTarget(usages, { exclude: new Set() })?.id, "b");
});

test("selector: a 5h-maxed sub is skipped for one with headroom (§10.2)", () => {
  const usages = [
    usage({
      id: "maxed",
      fiveHour: { utilization: 0.99, reset: null },
      sevenDay: { utilization: 0.1, reset: "2026-07-18T02:00:00.000Z" },
    }),
    usage({
      id: "ok",
      fiveHour: { utilization: 0.2, reset: null },
      sevenDay: { utilization: 0.5, reset: "2026-07-18T09:00:00.000Z" },
    }),
  ];
  assert.equal(pickFailoverTarget(usages, { exclude: new Set() })?.id, "ok");
});

test("selector: excluded (account-locked) id is never picked even if best (§10.3/§10.4)", () => {
  const usages = [
    usage({
      id: "best",
      fiveHour: { utilization: 0.05, reset: null },
      sevenDay: { utilization: 0.05, reset: "2026-07-18T01:00:00.000Z" },
    }),
    usage({
      id: "other",
      fiveHour: { utilization: 0.2, reset: null },
      sevenDay: { utilization: 0.3, reset: "2026-07-18T03:00:00.000Z" },
    }),
  ];
  assert.equal(pickFailoverTarget(usages, { exclude: new Set(["best"]) })?.id, "other");
});

test("selector: deterministic tie-break on registry index (§10.8)", () => {
  const usages = [
    usage({
      id: "first",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.3, reset: "2026-07-18T02:00:00.000Z" },
    }),
    usage({
      id: "second",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.3, reset: "2026-07-18T02:00:00.000Z" },
    }),
  ];
  for (let i = 0; i < 5; i += 1) {
    assert.equal(pickFailoverTarget(usages, { exclude: new Set() })?.id, "first");
  }
});

test("countEligibleFailoverTargets counts only headroom, unexcluded, unlocked, error-free", () => {
  const usages = [
    usage({
      id: "ok",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.2, reset: null },
    }),
    usage({ id: "maxed", fiveHour: { utilization: 0.99, reset: null }, sevenDay: null }),
    usage({
      id: "locked",
      locked: true,
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: null,
    }),
    usage({ id: "err", error: "boom", fiveHour: null, sevenDay: null }),
    usage({ id: "excl", fiveHour: { utilization: 0.1, reset: null }, sevenDay: null }),
  ];
  assert.equal(countEligibleFailoverTargets(usages, { exclude: new Set(["excl"]) }), 1);
});

// ---------------------------------------------------------------------------
// resolveAutoSubscription — end-to-end (real probe round-trip)
// ---------------------------------------------------------------------------

test("resolveAutoSubscription picks soonest-7d among headroom subs, emits summary (§10.1)", async () => {
  const soon = uid("soon");
  const late = uid("late");
  await withAutoRig(
    [
      { id: late, outcome: { util5h: 0.1, util7h: 0.4, reset7d: 5_000 } },
      { id: soon, outcome: { util5h: 0.1, util7h: 0.4, reset7d: 2_000 } },
    ],
    async (ctx) => {
      const picked = await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions);
      assert.equal(picked, soon);
      const summary = consumeAutoSubscriptionSelection();
      assert.equal(summary?.mode, "auto");
      assert.equal(summary?.picked, soon);
      assert.equal(summary?.reason, "soonest-7d-reset");
      assert.equal(summary?.fellBack, false);
      assert.equal(summary?.eligible, 2);
      assert.equal(summary?.candidatesConsidered, 2);
    },
  );
});

test("resolveAutoSubscription hops past a 5h-maxed sub (§10.2)", async () => {
  const maxed = uid("maxed");
  const ok = uid("ok");
  await withAutoRig(
    [
      { id: maxed, outcome: { util5h: 0.99, util7h: 0.1, reset7d: 1_000 } },
      { id: ok, outcome: { util5h: 0.2, util7h: 0.5, reset7d: 9_000 } },
    ],
    async (ctx) => {
      assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), ok);
    },
  );
});

test("resolveAutoSubscription never picks a directly-locked sub (§10.3)", async () => {
  const locked = uid("locked");
  const open = uid("open");
  await withAutoRig(
    [
      { id: locked, locked: true, outcome: { util5h: 0.01, util7h: 0.01, reset7d: 1_000 } },
      { id: open, outcome: { util5h: 0.5, util7h: 0.6, reset7d: 9_000 } },
    ],
    async (ctx) => {
      assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), open);
    },
  );
});

test("resolveAutoSubscription excludes an account-locked sibling (DIR-2, §10.4)", async () => {
  const acct = uid("acct");
  const lockedSibling = uid("locked-sib");
  const openSibling = uid("open-sib");
  await withAutoRig(
    [
      // lockedSibling is the strategy-optimal one but its account is locked via itself;
      // openSibling shares the account and must be excluded too.
      {
        id: lockedSibling,
        account: acct,
        locked: true,
        outcome: { util5h: 0.01, util7h: 0.01, reset7d: 1_000 },
      },
      { id: openSibling, account: acct, outcome: { util5h: 0.02, util7h: 0.02, reset7d: 2_000 } },
      { id: uid("independent"), outcome: { util5h: 0.4, util7h: 0.5, reset7d: 9_000 } },
    ],
    async (ctx) => {
      const picked = await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions);
      assert.notEqual(picked, lockedSibling);
      assert.notEqual(picked, openSibling);
    },
  );
});

test("resolveAutoSubscription returns undefined when all locked (§10.5)", async () => {
  await withAutoRig(
    [
      { id: uid("l"), locked: true, outcome: { util5h: 0.1, util7h: 0.1, reset7d: 1_000 } },
      { id: uid("l"), locked: true, outcome: { util5h: 0.1, util7h: 0.1, reset7d: 2_000 } },
    ],
    async (ctx) => {
      assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), undefined);
      const summary = consumeAutoSubscriptionSelection();
      assert.equal(summary?.fellBack, true);
      assert.equal(summary?.reason, "all-locked");
    },
  );
});

test("resolveAutoSubscription returns undefined when all 5h-maxed (§10.6)", async () => {
  await withAutoRig(
    [
      { id: uid("m"), outcome: { util5h: 0.99, util7h: 0.1, reset7d: 1_000 } },
      { id: uid("m"), outcome: { util5h: 0.985, util7h: 0.1, reset7d: 2_000 } },
    ],
    async (ctx) => {
      assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), undefined);
      assert.equal(consumeAutoSubscriptionSelection()?.reason, "all-5h-maxed");
    },
  );
});

test("resolveAutoSubscription returns undefined when every probe errors (§10.7)", async () => {
  await withAutoRig(
    [
      { id: uid("e"), outcome: { status: 401 } },
      { id: uid("e"), noCredentials: true, outcome: { util5h: 0.1 } },
    ],
    async (ctx) => {
      assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), undefined);
      assert.equal(consumeAutoSubscriptionSelection()?.reason, "all-probe-error");
    },
  );
});

test("resolveAutoSubscription is a no-op for a non-claude adapter (§10.10)", async () => {
  await withAutoRig(
    [{ id: uid("c"), outcome: { util5h: 0.1, util7h: 0.1, reset7d: 1_000 } }],
    async (ctx) => {
      assert.equal(await resolveAutoSubscription(CODEX_AGENT, ctx.lookupOptions), undefined);
      // No auto ran → nothing captured.
      assert.equal(consumeAutoSubscriptionSelection(), undefined);
    },
  );
});

test("resolveAutoSubscription returns undefined on an empty registry, never throws", async () => {
  await withAutoRig([], async (ctx) => {
    assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), undefined);
    assert.equal(consumeAutoSubscriptionSelection()?.reason, "empty-registry");
  });
});

test("resolveAutoSubscription times out to undefined against a slow probe (§10.11)", async () => {
  const prevTimeout = process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS;
  process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS = "40";
  try {
    await withAutoRig(
      [{ id: uid("slow"), outcome: { util5h: 0.1, util7h: 0.1, reset7d: 1_000, delayMs: 400 } }],
      async (ctx) => {
        assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), undefined);
        assert.equal(consumeAutoSubscriptionSelection()?.reason, "timeout");
      },
    );
  } finally {
    if (prevTimeout === undefined) {
      delete process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS;
    } else {
      process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS = prevTimeout;
    }
  }
});

// ---------------------------------------------------------------------------
// Cross-HOME divergence diagnostic (§5) — pure diagnostic, never affects the pick
// ---------------------------------------------------------------------------

function startMockUi(body: unknown, status = 200): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

test("cross-HOME: a diverging acpx-ui lock view warns but does not change the pick (§5)", async () => {
  const open = uid("open");
  await withAutoRig(
    [{ id: open, outcome: { util5h: 0.1, util7h: 0.2, reset7d: 1_000 } }],
    async (ctx) => {
      // acpx-ui claims `open` is locked; local registry has it unlocked → divergence.
      const ui = await startMockUi([{ id: open, locked: true }]);
      process.env.ACPX_SESSION_URL = `${ui.origin}/?session=abc`;
      try {
        const picked = await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions);
        // Pick is unchanged — the diagnostic never feeds selection.
        assert.equal(picked, open);
        assert.equal(consumeAutoSubscriptionSelection()?.divergedFromUi, true);
      } finally {
        ui.server.close();
        delete process.env.ACPX_SESSION_URL;
      }
    },
  );
});

test("cross-HOME: a matching acpx-ui lock view reports no divergence", async () => {
  const open = uid("open");
  await withAutoRig(
    [{ id: open, outcome: { util5h: 0.1, util7h: 0.2, reset7d: 1_000 } }],
    async (ctx) => {
      const ui = await startMockUi([{ id: open, locked: false }]);
      process.env.ACPX_SESSION_URL = `${ui.origin}/?session=abc`;
      try {
        assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), open);
        assert.equal(consumeAutoSubscriptionSelection()?.divergedFromUi, undefined);
      } finally {
        ui.server.close();
        delete process.env.ACPX_SESSION_URL;
      }
    },
  );
});

test("cross-HOME: an acpx-ui error is silently skipped, pick unaffected (§5)", async () => {
  const open = uid("open");
  await withAutoRig(
    [{ id: open, outcome: { util5h: 0.1, util7h: 0.2, reset7d: 1_000 } }],
    async (ctx) => {
      const ui = await startMockUi("boom", 500);
      process.env.ACPX_SESSION_URL = `${ui.origin}/?session=abc`;
      try {
        assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), open);
        assert.equal(consumeAutoSubscriptionSelection()?.divergedFromUi, undefined);
      } finally {
        ui.server.close();
        delete process.env.ACPX_SESSION_URL;
      }
    },
  );
});

test("cross-HOME: malformed acpx-ui body is silently skipped", async () => {
  const open = uid("open");
  await withAutoRig(
    [{ id: open, outcome: { util5h: 0.1, util7h: 0.2, reset7d: 1_000 } }],
    async (ctx) => {
      const ui = await startMockUi({ not: "a usage array" });
      process.env.ACPX_SESSION_URL = `${ui.origin}/?session=abc`;
      try {
        assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, ctx.lookupOptions), open);
        assert.equal(consumeAutoSubscriptionSelection()?.divergedFromUi, undefined);
      } finally {
        ui.server.close();
        delete process.env.ACPX_SESSION_URL;
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Binding seam — bindDefaultAccountToSessionOptionsAsync (integration §10.12–16)
// ---------------------------------------------------------------------------

test("async binder resolves auto to a concrete profile id, never the literal auto (§10.12)", async () => {
  const pick = uid("pick");
  await withAutoRig(
    [{ id: pick, outcome: { util5h: 0.1, util7h: 0.2, reset7d: 1_000 } }],
    async (ctx) => {
      const out = await bindDefaultAccountToSessionOptionsAsync(
        { subscription: "auto", model: "opus" },
        CLAUDE_AGENT,
        ctx.lookupOptions,
      );
      assert.equal(out?.profile, pick);
      assert.equal(out?.subscription, undefined);
      assert.equal(out?.model, "opus");
      consumeAutoSubscriptionSelection();
    },
  );
});

test("async binder: auto in the unified profile slot resolves the same way", async () => {
  const pick = uid("pick");
  await withAutoRig(
    [{ id: pick, outcome: { util5h: 0.1, util7h: 0.2, reset7d: 1_000 } }],
    async (ctx) => {
      const out = await bindDefaultAccountToSessionOptionsAsync(
        { profile: "auto" },
        CLAUDE_AGENT,
        ctx.lookupOptions,
      );
      assert.equal(out?.profile, pick);
      consumeAutoSubscriptionSelection();
    },
  );
});

test("async binder: an explicit concrete selection never triggers auto (§10.13)", async () => {
  const favored = uid("favored");
  const chosen = uid("chosen");
  await withAutoRig(
    [
      { id: favored, outcome: { util5h: 0.01, util7h: 0.01, reset7d: 1_000 } },
      { id: chosen, outcome: { util5h: 0.5, util7h: 0.5, reset7d: 9_000 } },
    ],
    async (ctx) => {
      const out = await bindDefaultAccountToSessionOptionsAsync(
        { profile: chosen },
        CLAUDE_AGENT,
        ctx.lookupOptions,
      );
      assert.equal(out?.profile, chosen);
      // auto never ran → no capture.
      assert.equal(consumeAutoSubscriptionSelection(), undefined);
    },
  );
});

test("async binder: auto with an empty registry falls back without throwing (§10.14)", async () => {
  await withAutoRig([], async (ctx) => {
    const out = await bindDefaultAccountToSessionOptionsAsync(
      { subscription: "auto", model: "sonnet" },
      CLAUDE_AGENT,
      ctx.lookupOptions,
    );
    // No default, empty registry → auto stripped, nothing bound, model preserved.
    assert.deepEqual(out, { model: "sonnet" });
    consumeAutoSubscriptionSelection();
  });
});

test("async binder: auto with an unreachable probe falls back to the registry default (§10.15)", async () => {
  const prevTimeout = process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS;
  process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS = "40";
  const def = uid("def");
  try {
    await withAutoRig(
      [{ id: def, outcome: { util5h: 0.1, util7h: 0.1, reset7d: 1_000, delayMs: 400 } }],
      async (ctx) => {
        const out = await bindDefaultAccountToSessionOptionsAsync(
          { subscription: "auto" },
          CLAUDE_AGENT,
          ctx.lookupOptions,
        );
        // Timeout → fallback to the registry default binding (the default id).
        assert.equal(out?.profile, def);
        consumeAutoSubscriptionSelection();
      },
      { defaultId: def },
    );
  } finally {
    if (prevTimeout === undefined) {
      delete process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS;
    } else {
      process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS = prevTimeout;
    }
  }
});

test("regression: a non-auto spawn binds byte-identically to the sync path (§10 regression)", async () => {
  await withAutoRig([], async (ctx) => {
    const input = { model: "opus" };
    const asyncOut = await bindDefaultAccountToSessionOptionsAsync(
      { ...input },
      CLAUDE_AGENT,
      ctx.lookupOptions,
    );
    const syncOut = bindDefaultAccountToSessionOptions(
      { ...input },
      CLAUDE_AGENT,
      ctx.lookupOptions,
    );
    assert.deepEqual(asyncOut, syncOut);
    assert.deepEqual(asyncOut, input);
    // No auto sentinel → no selection captured.
    assert.equal(consumeAutoSubscriptionSelection(), undefined);
  });
});

// ---------------------------------------------------------------------------
// Resume / rebind never re-picks (§10.16 + defense-in-depth)
// ---------------------------------------------------------------------------

test("resume: a record already bound to a concrete profile is not re-picked (§10.16)", async () => {
  await withAutoRig(
    [{ id: uid("x"), outcome: { util5h: 0.1, util7h: 0.1, reset7d: 1_000 } }],
    async (ctx) => {
      const record = makeSessionRecord({
        acpxRecordId: "rec",
        acpSessionId: "acp",
        agentCommand: CLAUDE_AGENT,
        cwd: "/tmp/p",
        acpx: { session_options: { profile: "work-fixed" } },
      });
      assert.equal(bindRecordToDefaultAccount(record, ctx.lookupOptions), false);
      assert.equal(record.acpx?.session_options?.profile, "work-fixed");
    },
  );
});

test("resume: a stray literal auto on a record is stripped, never re-picked (defense-in-depth)", async () => {
  await withAutoRig(
    [{ id: uid("y"), outcome: { util5h: 0.1, util7h: 0.1, reset7d: 1_000 } }],
    async (ctx) => {
      const record = makeSessionRecord({
        acpxRecordId: "rec",
        acpSessionId: "acp",
        agentCommand: CLAUDE_AGENT,
        cwd: "/tmp/p",
        acpx: { session_options: { profile: "auto", model: "opus" } },
      });
      assert.equal(bindRecordToDefaultAccount(record, ctx.lookupOptions), true);
      // No default in this registry → auto stripped, no concrete account bound,
      // and crucially NOT resolved to a picked id (resume must not re-select).
      assert.equal(record.acpx?.session_options?.profile, undefined);
      assert.equal(record.acpx?.session_options?.subscription, undefined);
      assert.equal(record.acpx?.session_options?.model, "opus");
    },
  );
});
