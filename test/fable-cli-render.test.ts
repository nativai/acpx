import assert from "node:assert/strict";
import test from "node:test";
import {
  formatFable,
  renderSubscriptionsUsageQuiet,
  renderUsageText,
} from "../src/cli/subscriptions-command.js";
import type { SubscriptionUsage } from "../src/config/subscription-usage.js";

function usage(over: Partial<SubscriptionUsage> & { id: string }): SubscriptionUsage {
  return { label: over.id, fiveHour: null, sevenDay: null, ...over };
}

test("formatFable: not probed / error / exhausted / available / utilization", () => {
  assert.equal(formatFable(usage({ id: "s" })), "fable -");
  assert.equal(
    formatFable(
      usage({
        id: "s",
        fable: { available: false, utilization: null, reset: null, error: "network error" },
      }),
    ),
    "fable ? (network error)",
  );
  // probe-429 → honest point-in-time "throttled (probe)", NOT a permanent verdict
  assert.equal(
    formatFable(usage({ id: "s", fable: { available: false, utilization: null, reset: null } })),
    "fable throttled (probe)",
  );
  // throttled + known allocation → secondary share suffix inside the same parens
  assert.equal(
    formatFable(
      usage({
        id: "s",
        fable: { available: false, utilization: null, reset: null },
        fallback: { percentage: 0.5, availability: "available" },
      }),
    ),
    "fable throttled (probe; share 50%)",
  );
  assert.equal(
    formatFable(usage({ id: "s", fable: { available: true, utilization: null, reset: null } })),
    "fable available",
  );
  assert.equal(
    formatFable(usage({ id: "s", fable: { available: true, utilization: 0.42, reset: null } })),
    "fable 42.0%",
  );
});

test("renderUsageText: header names fable and each row carries a fable cell", () => {
  const out = renderUsageText([
    usage({
      id: "sub6",
      label: "work-6",
      fiveHour: { utilization: 0.25, reset: null },
      sevenDay: { utilization: 0.08, reset: null },
      fable: { available: false, utilization: null, reset: null },
    }),
  ]);
  assert.match(out, /Subscription usage \(5h \/ 7d \/ fable\):/);
  assert.match(out, /point-in-time claude-fable-5 probe.*flaps/);
  assert.match(out, /fable throttled \(probe\)/);
  assert.match(out, /5h 25\.0%/);
});

test("renderSubscriptionsUsageQuiet: appends fable:<state> field per line", () => {
  const out = renderSubscriptionsUsageQuiet([
    usage({
      id: "a",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.2, reset: null },
      fable: { available: true, utilization: null, reset: null },
    }),
    usage({
      id: "b",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.2, reset: null },
      fable: { available: false, utilization: null, reset: null },
    }),
    usage({
      id: "c",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.2, reset: null },
    }),
  ]);
  assert.match(out, /^a\t10\.0%\t20\.0%\tfable:ok$/m);
  assert.match(out, /^b\t10\.0%\t20\.0%\tfable:throttled$/m);
  assert.match(out, /^c\t10\.0%\t20\.0%\tfable:-$/m);
});
