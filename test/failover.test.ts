import assert from "node:assert/strict";
import test from "node:test";
import {
  maxedThreshold,
  maxUtilization,
  pickFailoverTarget,
  type SubscriptionUsage,
} from "../src/config/subscription-usage.js";
import { classifyFailover, FAILOVER_ERROR_KINDS } from "../src/runtime/engine/failover.js";

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

test("classifyFailover string-match fallback catches 429 / usage limit", () => {
  assert.equal(classifyFailover(new Error("HTTP 429 rate limited")), "rate_limit");
  assert.equal(classifyFailover(new Error("You have hit your usage limit")), "rate_limit");
  assert.equal(classifyFailover("quota exceeded for this account"), "rate_limit");
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
