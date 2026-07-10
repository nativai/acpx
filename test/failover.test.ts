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

test("classifyFailover returns null for non-sub errors", () => {
  assert.equal(classifyFailover(acpError({ errorKind: "invalid_request" })), null);
  assert.equal(classifyFailover(acpError({ errorKind: "max_output_tokens" })), null);
  assert.equal(classifyFailover(new Error("model not found")), null);
  assert.equal(classifyFailover(new Error("connection timeout")), null);
  assert.equal(classifyFailover(undefined), null);
});

function usage(id: string, util: number, error?: string): SubscriptionUsage {
  return {
    id,
    label: id,
    fiveHour: { utilization: util, reset: null },
    sevenDay: { utilization: util / 2, reset: null },
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

test("pickFailoverTarget chooses lowest max-utilization (most headroom)", () => {
  const target = pickFailoverTarget([usage("a", 0.8), usage("b", 0.1), usage("c", 0.4)], {
    exclude: new Set(),
  });
  assert.equal(target?.id, "b");
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

test("pickFailoverTarget breaks ties by input (registry) order", () => {
  const target = pickFailoverTarget([usage("first", 0.2), usage("second", 0.2)], {
    exclude: new Set(),
  });
  assert.equal(target?.id, "first");
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
