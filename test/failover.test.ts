import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  maxedThreshold,
  maxUtilization,
  pickFailoverTarget,
  type SubscriptionUsage,
  type SubscriptionUsageWindow,
} from "../src/config/subscription-usage.js";
import {
  AllSubscriptionsExhaustedError,
  AllSubscriptionsLockedError,
  SubscriptionLockedError,
} from "../src/errors.js";
import {
  classifyFailover,
  enforceSubscriptionLockBeforeTurn,
  FAILOVER_ERROR_KINDS,
} from "../src/runtime/engine/failover.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Risk 4: pin the failover error-kind contract so any change is a deliberate,
// reviewed edit (acpx cannot import the SDK union directly — see failover.ts).
test("FAILOVER_ERROR_KINDS pins the adapter errorKind contract", () => {
  assert.deepEqual(Object.values(FAILOVER_ERROR_KINDS).toSorted(), [
    "authentication_failed",
    "billing_error",
    "rate_limit",
  ]);
});

function acpError(data: Record<string, unknown>, code = -32603, message = "turn failed"): unknown {
  return { acp: { code, message, data } };
}

test("classifyFailover reads data.errorKind = rate_limit", () => {
  assert.equal(classifyFailover(acpError({ errorKind: "rate_limit" })), "rate_limit");
});

test("classifyFailover reads data.errorKind = authentication_failed", () => {
  assert.equal(classifyFailover(acpError({ errorKind: "authentication_failed" })), "auth_failed");
});

test("classifyFailover treats billing_error as a failover trigger", () => {
  assert.equal(classifyFailover(acpError({ errorKind: "billing_error" })), "billing");
});

test("classifyFailover maps the auth-required ACP code (-32000) to auth_failed", () => {
  assert.equal(
    classifyFailover({ acp: { code: -32000, message: "Please run /login", data: {} } }),
    "auth_failed",
  );
});

// S1 — THE CRUX. A claude-pty bridge whose stored Claude login expired throws a
// generic AdapterHealthError on the catch-all code -32000 carrying
// data.reason/state === "auth-gated". This MUST classify as "auth_gated" (a
// distinct, non-quota trigger), NOT "auth_failed" — otherwise it rides the
// subscription failover+dead-mark machinery and collapses to a false exhaustion.
test("S1: classifyFailover maps an auth-gated bridge health error (-32000 + reason/state) to auth_gated", () => {
  // Direct payload shape.
  assert.equal(
    classifyFailover({
      code: -32000,
      message: "Interactive Claude login is required for this HOME",
      data: { reason: "auth-gated", state: "auth-gated" },
    }),
    "auth_gated",
  );
  // Real path: the adapter error reaches acpx nested under `.acp`.
  assert.equal(
    classifyFailover({
      acp: {
        code: -32000,
        message: "Interactive Claude login is required for this HOME",
        data: { reason: "auth-gated", state: "auth-gated", health: { canAcceptPrompt: false } },
      },
    }),
    "auth_gated",
  );
});

test("S1: auth-gated detection fires on reason alone and on state alone", () => {
  assert.equal(
    classifyFailover({
      acp: { code: -32000, message: "login required", data: { reason: "auth-gated" } },
    }),
    "auth_gated",
  );
  assert.equal(
    classifyFailover({
      acp: { code: -32000, message: "login required", data: { state: "auth-gated" } },
    }),
    "auth_gated",
  );
});

// S2 — regression. A real subscription 401 carries -32000 with NO auth-gated
// data, so it must stay "auth_failed" (this pins the carve-out: auth-gated is
// detected ahead of the -32000 rule, but the -32000 rule itself is unchanged).
test("S2: a plain -32000 (no auth-gated data) still classifies as auth_failed, not auth_gated", () => {
  assert.equal(
    classifyFailover({
      acp: { code: -32000, message: "Please run /login", data: { reason: "other" } },
    }),
    "auth_failed",
  );
});

// S2 — regression. errorKind classification wins ahead of any auth-gated data,
// so a rate-limit that also happens to carry an auth-gated hint stays rate_limit.
test("S2: errorKind (rate_limit) still wins even if auth-gated data is also present", () => {
  assert.equal(
    classifyFailover({
      acp: {
        code: -32603,
        message: "rate limited",
        data: { errorKind: "rate_limit", state: "auth-gated" },
      },
    }),
    "rate_limit",
  );
});

test("classifyFailover string-match fallback catches 429 / usage limit", () => {
  assert.equal(classifyFailover(new Error("HTTP 429 rate limited")), "rate_limit");
  assert.equal(classifyFailover(new Error("You have hit your usage limit")), "rate_limit");
  assert.equal(classifyFailover("quota exceeded for this account"), "rate_limit");
});

test("classifyFailover string-match fallback catches raw Claude session limit text", () => {
  const message = "Internal error: You've hit your session limit · resets 11:20am (UTC)";
  assert.equal(classifyFailover(new Error(message)), "rate_limit");
  assert.equal(classifyFailover({ acp: { code: -32603, message, data: {} } }), "rate_limit");
});

test("classifyFailover string-match catches subscription-limit phrasings with NO errorKind", () => {
  for (const m of [
    "Internal error: You've hit your weekly limit · resets 12pm (UTC)",
    "Internal error: You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
    "Internal error: You've hit your limit · resets Jul 7, 12pm (UTC)",
    "The subscription is out of usage",
    "Your credit balance is too low",
  ]) {
    assert.equal(classifyFailover(new Error(m)), "rate_limit", m);
    assert.equal(
      classifyFailover({ acp: { code: -32603, message: m, data: {} } }),
      "rate_limit",
      m,
    );
  }
});

test("classifyFailover does NOT over-match generic 'limit' text", () => {
  assert.equal(classifyFailover(new Error("output exceeds the character limit")), null);
  assert.equal(classifyFailover(new Error("tool call limit reached for this turn")), null);
});

test("classifyFailover returns null for non-sub errors", () => {
  assert.equal(classifyFailover(acpError({ errorKind: "invalid_request" })), null);
  assert.equal(classifyFailover(acpError({ errorKind: "max_output_tokens" })), null);
  assert.equal(classifyFailover(new Error("model not found")), null);
  assert.equal(classifyFailover(new Error("connection timeout")), null);
  assert.equal(classifyFailover(undefined), null);
});

function usage(
  id: string,
  util: number,
  error?: string,
  opts?: {
    sevenDayReset?: string;
    fiveHour?: SubscriptionUsageWindow | null;
    sevenDay?: SubscriptionUsageWindow | null;
  },
): SubscriptionUsage {
  return {
    id,
    label: id,
    fiveHour: opts?.fiveHour !== undefined ? opts.fiveHour : { utilization: util, reset: null },
    sevenDay:
      opts?.sevenDay !== undefined
        ? opts.sevenDay
        : { utilization: util / 2, reset: opts?.sevenDayReset ?? null },
    ...(error ? { error } : {}),
  };
}

test("maxUtilization picks the higher of the two windows", () => {
  assert.equal(
    maxUtilization({
      id: "x",
      label: "x",
      fiveHour: { utilization: 0.3, reset: null },
      sevenDay: { utilization: 0.7, reset: null },
    }),
    0.7,
  );
});

test("pickFailoverTarget picks the soonest 7d reset among eligible subs", () => {
  // Worked example from the brief (threshold 0.98):
  //   A: 5h=0.5, 7d=0.9, reset=2026-07-17T00:00:00Z
  //   B: 5h=0.99 → INELIGIBLE (5h maxed)
  //   C: 5h=0.3, 7d=0.4, reset=2026-07-18T00:00:00Z
  //   D: 5h=0.7, 7d=0.2, reset=2026-07-16T18:00:00Z  ← soonest reset wins
  const a = usage("a", 0, undefined, {
    fiveHour: { utilization: 0.5, reset: null },
    sevenDay: { utilization: 0.9, reset: "2026-07-17T00:00:00Z" },
  });
  const b = usage("b", 0, undefined, {
    fiveHour: { utilization: 0.99, reset: null },
    sevenDay: { utilization: 0.1, reset: "2026-07-16T12:00:00Z" },
  });
  const c = usage("c", 0, undefined, {
    fiveHour: { utilization: 0.3, reset: null },
    sevenDay: { utilization: 0.4, reset: "2026-07-18T00:00:00Z" },
  });
  const d = usage("d", 0, undefined, {
    fiveHour: { utilization: 0.7, reset: null },
    sevenDay: { utilization: 0.2, reset: "2026-07-16T18:00:00Z" },
  });
  const target = pickFailoverTarget([a, b, c, d], { exclude: new Set(), threshold: 0.98 });
  // D has the soonest reset (07-16 18:00) despite not having the most 5h headroom
  assert.equal(target?.id, "d");
});

test("pickFailoverTarget excludes tried subs", () => {
  const target = pickFailoverTarget([usage("a", 0.1), usage("b", 0.2)], {
    exclude: new Set(["a"]),
  });
  assert.equal(target?.id, "b");
});

test("pickFailoverTarget skips probe-error (401/probe-fail) subs", () => {
  const target = pickFailoverTarget([usage("dead", 0, "auth failed"), usage("ok", 0.5)], {
    exclude: new Set(),
  });
  assert.equal(target?.id, "ok");
});

test("pickFailoverTarget skips user-locked subs", () => {
  const target = pickFailoverTarget([{ ...usage("locked", 0.1), locked: true }, usage("ok", 0.5)], {
    exclude: new Set(),
  });
  assert.equal(target?.id, "ok");
});

test("pickFailoverTarget skips subs at/above the maxed threshold", () => {
  const target = pickFailoverTarget([usage("maxed", 0.99), usage("ok", 0.5)], {
    exclude: new Set(),
    threshold: 0.98,
  });
  assert.equal(target?.id, "ok");
});

test("pickFailoverTarget returns undefined when nothing qualifies (exhausted)", () => {
  const target = pickFailoverTarget([usage("dead", 0, "401"), usage("maxed", 0.99)], {
    exclude: new Set(),
    threshold: 0.98,
  });
  assert.equal(target, undefined);
});

test("pickFailoverTarget breaks ties by input (registry) order when 7d-reset and headroom are equal", () => {
  // Both have the same 7d reset (null → +Infinity) and same 7d utilization;
  // tertiary tiebreak is registry order — "first" (index 0) wins.
  const target = pickFailoverTarget([usage("first", 0.2), usage("second", 0.2)], {
    exclude: new Set(),
  });
  assert.equal(target?.id, "first");
});

// ── Regression matrix: 5h eligibility gate ────────────────────────────────

test("pickFailoverTarget: 5h-maxed sub is excluded even if its 7d reset is soonest", () => {
  const maxed5h = usage("maxed-5h", 0, undefined, {
    fiveHour: { utilization: 0.99, reset: null },
    sevenDay: { utilization: 0.0, reset: "2026-07-16T00:00:00Z" }, // soonest reset
  });
  const eligible = usage("eligible", 0, undefined, {
    fiveHour: { utilization: 0.5, reset: null },
    sevenDay: { utilization: 0.5, reset: "2026-07-20T00:00:00Z" },
  });
  const target = pickFailoverTarget([maxed5h, eligible], { exclude: new Set(), threshold: 0.98 });
  assert.equal(target?.id, "eligible");
});

test("pickFailoverTarget: sub with fiveHour === null is excluded (5h header absent)", () => {
  const noFiveHour = usage("no-5h", 0, undefined, { fiveHour: null });
  const eligible = usage("eligible", 0.3);
  const target = pickFailoverTarget([noFiveHour, eligible], {
    exclude: new Set(),
    threshold: 0.98,
  });
  assert.equal(target?.id, "eligible");
});

test("pickFailoverTarget: high 7d utilization alone does NOT exclude a sub", () => {
  // 7d utilization at 0.95 but 5h utilization fine — still eligible (< maxedThreshold 0.98)
  const highSevenDay = usage("high-7d", 0, undefined, {
    fiveHour: { utilization: 0.4, reset: null },
    sevenDay: { utilization: 0.95, reset: null },
  });
  const target = pickFailoverTarget([highSevenDay], { exclude: new Set(), threshold: 0.98 });
  assert.equal(target?.id, "high-7d");
});

// ── Regression matrix: 7d exhaustion gate (brick://8021102c) ──────────────

test("pickFailoverTarget: weekly-dead (7d=1.0) sub is INELIGIBLE even with fresh 5h", () => {
  // A sub whose 5h just reset (0.10) but 7d is fully exhausted (1.0) must be
  // rejected — picking it would cause 429s on the weekly-maxed account.
  const weeklyDead = usage("weekly-dead", 0, undefined, {
    fiveHour: { utilization: 0.1, reset: null },
    sevenDay: { utilization: 1.0, reset: "2026-07-21T08:00:00Z" },
  });
  const target = pickFailoverTarget([weeklyDead], { exclude: new Set(), threshold: 0.7 });
  assert.equal(target, undefined);
});

test("pickFailoverTarget: moderate 7d (0.75) is still ELIGIBLE — only weekly-dead rejected", () => {
  // 7d at 0.75 is not exhausted (< maxedThreshold 0.98), so the sub remains eligible.
  const moderate7d = usage("moderate-7d", 0, undefined, {
    fiveHour: { utilization: 0.1, reset: null },
    sevenDay: { utilization: 0.75, reset: null },
  });
  const target = pickFailoverTarget([moderate7d], { exclude: new Set(), threshold: 0.7 });
  assert.equal(target?.id, "moderate-7d");
});

test("pickFailoverTarget: healthy sub wins over 7d-maxed sub with soonest reset", () => {
  // The 7d-maxed sub has a SOONER weekly reset, so the old selector could pick it.
  // With the 7d gate it must be excluded and the healthy sub selected instead.
  const weeklyMaxedSoonReset = usage("maxed-soon", 0, undefined, {
    fiveHour: { utilization: 0.1, reset: null },
    sevenDay: { utilization: 1.0, reset: "2026-07-21T06:00:00Z" }, // soonest
  });
  const healthySub = usage("healthy", 0, undefined, {
    fiveHour: { utilization: 0.1, reset: null },
    sevenDay: { utilization: 0.3, reset: "2026-07-22T00:00:00Z" }, // later reset
  });
  const target = pickFailoverTarget([weeklyMaxedSoonReset, healthySub], {
    exclude: new Set(),
    threshold: 0.7,
  });
  assert.equal(target?.id, "healthy");
});

// ── Regression matrix: soonest-7d-reset ordering ──────────────────────────

test("pickFailoverTarget: soonest 7d reset wins even when that sub lacks most 5h headroom", () => {
  // soonest-reset sub (D) has less 5h headroom than others — reset is still primary
  const c = usage("c", 0, undefined, {
    fiveHour: { utilization: 0.3, reset: null },
    sevenDay: { utilization: 0.4, reset: "2026-07-18T00:00:00Z" },
  });
  const d = usage("d", 0, undefined, {
    fiveHour: { utilization: 0.7, reset: null }, // less 5h headroom than c
    sevenDay: { utilization: 0.2, reset: "2026-07-16T18:00:00Z" }, // soonest
  });
  const a = usage("a", 0, undefined, {
    fiveHour: { utilization: 0.5, reset: null },
    sevenDay: { utilization: 0.9, reset: "2026-07-17T00:00:00Z" },
  });
  const target = pickFailoverTarget([a, c, d], { exclude: new Set(), threshold: 0.98 });
  assert.equal(target?.id, "d");
});

// ── Regression matrix: tiebreaks ──────────────────────────────────────────

test("pickFailoverTarget: equal 7d resets → lower 7d utilization wins", () => {
  const sameReset = "2026-07-17T00:00:00Z";
  const hi = usage("hi-util", 0, undefined, {
    fiveHour: { utilization: 0.3, reset: null },
    sevenDay: { utilization: 0.8, reset: sameReset },
  });
  const lo = usage("lo-util", 0, undefined, {
    fiveHour: { utilization: 0.3, reset: null },
    sevenDay: { utilization: 0.2, reset: sameReset },
  });
  const target = pickFailoverTarget([hi, lo], { exclude: new Set(), threshold: 0.98 });
  assert.equal(target?.id, "lo-util");
});

test("pickFailoverTarget: sevenDay.reset === null sorts after any known reset", () => {
  const knownReset = usage("known", 0, undefined, {
    fiveHour: { utilization: 0.3, reset: null },
    sevenDay: { utilization: 0.1, reset: "2026-07-20T00:00:00Z" },
  });
  const nullReset = usage("null-reset", 0, undefined, {
    fiveHour: { utilization: 0.3, reset: null },
    sevenDay: { utilization: 0.1, reset: null }, // no known reset → +Infinity
  });
  const target = pickFailoverTarget([nullReset, knownReset], {
    exclude: new Set(),
    threshold: 0.98,
  });
  assert.equal(target?.id, "known");
});

test("pickFailoverTarget: all-unknown-7d-reset still applies lower-util tiebreak (NaN guard)", () => {
  // All subs have sevenDay.reset === null → sevenDayResetKey returns +Infinity for
  // both. Infinity - Infinity = NaN, which used to bypass the secondary tiebreak
  // (NaN !== 0 is true → returned NaN instead of falling through). The NaN guard
  // ensures the lower-util tiebreak still fires.
  const hi = usage("hi-util", 0, undefined, {
    fiveHour: { utilization: 0.3, reset: null },
    sevenDay: { utilization: 0.8, reset: null }, // unknown reset → +Infinity
  });
  const lo = usage("lo-util", 0, undefined, {
    fiveHour: { utilization: 0.3, reset: null },
    sevenDay: { utilization: 0.2, reset: null }, // unknown reset → +Infinity
  });
  const target = pickFailoverTarget([hi, lo], { exclude: new Set(), threshold: 0.98 });
  assert.equal(target?.id, "lo-util");
});

// ── Regression matrix: no eligible → undefined ────────────────────────────

test("pickFailoverTarget: all 5h-maxed/errored/locked → undefined", () => {
  const all = [
    usage("maxed", 0, undefined, { fiveHour: { utilization: 0.99, reset: null } }),
    usage("errored", 0.1, "probe fail"),
    { ...usage("locked", 0.1), locked: true as const },
    usage("no-5h", 0.1, undefined, { fiveHour: null }),
  ];
  const target = pickFailoverTarget(all, { exclude: new Set(), threshold: 0.98 });
  assert.equal(target, undefined);
});

test("maxedThreshold defaults to 0.98 and honors the env override", () => {
  const prev = process.env.ACPX_SUBSCRIPTION_MAXED_THRESHOLD;
  try {
    delete process.env.ACPX_SUBSCRIPTION_MAXED_THRESHOLD;
    assert.equal(maxedThreshold(), 0.98);
    process.env.ACPX_SUBSCRIPTION_MAXED_THRESHOLD = "0.9";
    assert.equal(maxedThreshold(), 0.9);
    process.env.ACPX_SUBSCRIPTION_MAXED_THRESHOLD = "bogus";
    assert.equal(maxedThreshold(), 0.98);
  } finally {
    if (prev === undefined) {
      delete process.env.ACPX_SUBSCRIPTION_MAXED_THRESHOLD;
    } else {
      process.env.ACPX_SUBSCRIPTION_MAXED_THRESHOLD = prev;
    }
  }
});

async function withLockedProfileRegistry(
  profiles: Array<Record<string, unknown>>,
  run: (lookupOptions: { homeDir: string; registryPath: string }) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-lock-failover-"));
  try {
    const registryPath = path.join(homeDir, ".acpx", "subscriptions", "registry.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify({ version: 3, default: "sub1", profiles }, null, 2),
    );
    await run({ homeDir, registryPath });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function lockTestProfile(id: string, locked = false): Record<string, unknown> {
  return {
    id,
    label: id,
    authMode: "subscription",
    adapter: "claude",
    account: id,
    credentialSource: `/tmp/${id}`,
    ...(locked ? { locked: true } : {}),
  };
}

test("enforceSubscriptionLockBeforeTurn blocks locked current subscription when auto-failover is off", async () => {
  await withLockedProfileRegistry(
    [lockTestProfile("sub1", true), lockTestProfile("sub2")],
    async (lookupOptions) => {
      const record = makeSessionRecord({
        acpxRecordId: "rec",
        acpSessionId: "acp",
        agentCommand: "node claude-agent.js",
        cwd: "/tmp/project",
        acpx: { session_options: { profile: "sub1", auto_failover: false } },
      });
      await assert.rejects(
        enforceSubscriptionLockBeforeTurn(record, lookupOptions),
        (error) =>
          error instanceof SubscriptionLockedError && error.detailCode === "subscription-locked",
      );
    },
  );
});

test("enforceSubscriptionLockBeforeTurn uses lock-specific all-locked error when no unlocked sibling exists", async () => {
  await withLockedProfileRegistry([lockTestProfile("sub1", true)], async (lookupOptions) => {
    const record = makeSessionRecord({
      acpxRecordId: "rec",
      acpSessionId: "acp",
      agentCommand: "node claude-agent.js",
      cwd: "/tmp/project",
      acpx: { session_options: { profile: "sub1" } },
    });
    await assert.rejects(
      enforceSubscriptionLockBeforeTurn(record, lookupOptions),
      (error) =>
        error instanceof AllSubscriptionsLockedError &&
        error.detailCode === "all-subscriptions-locked",
    );
  });
});

test("enforceSubscriptionLockBeforeTurn preserves exhausted semantics when unlocked sibling is unusable", async () => {
  await withLockedProfileRegistry(
    [lockTestProfile("sub1", true), lockTestProfile("sub2")],
    async (lookupOptions) => {
      const record = makeSessionRecord({
        acpxRecordId: "rec",
        acpSessionId: "acp",
        agentCommand: "node claude-agent.js",
        cwd: "/tmp/project",
        acpx: { session_options: { profile: "sub1" } },
      });
      await assert.rejects(
        enforceSubscriptionLockBeforeTurn(record, lookupOptions),
        (error) =>
          error instanceof AllSubscriptionsExhaustedError &&
          error.detailCode === "all-subscriptions-exhausted",
      );
    },
  );
});
