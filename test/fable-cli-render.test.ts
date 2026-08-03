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
  // Real exhaustion with no readable window (older/odd response).
  assert.equal(
    formatFable(usage({ id: "s", fable: { available: false, utilization: null, reset: null } })),
    "fable exhausted",
  );
  // A cleanly-EXHAUSTED sub still shows its percentage — the case where the
  // number matters most (the old early-return dropped it).
  assert.equal(
    formatFable(
      usage({
        id: "s",
        fable: { available: false, utilization: 1, reset: "2026-08-06T07:00:00.000Z" },
      }),
    ),
    "fable exhausted (100.0%, resets 2026-08-06T07:00:00.000Z)",
  );
  assert.equal(
    formatFable(usage({ id: "s", fable: { available: true, utilization: null, reset: null } })),
    "fable available",
  );
  assert.equal(
    formatFable(usage({ id: "s", fable: { available: true, utilization: 0.42, reset: null } })),
    "fable 42.0%",
  );
  assert.equal(
    formatFable(
      usage({
        id: "s",
        fable: { available: true, utilization: 0.33, reset: "2026-08-06T07:00:00.000Z" },
      }),
    ),
    "fable 33.0%, resets 2026-08-06T07:00:00.000Z",
  );
});

test("renderUsageText: header names fable + the snapshot contract, rows carry a fable cell", () => {
  const out = renderUsageText([
    usage({
      id: "sub6",
      label: "work-6",
      fiveHour: { utilization: 0.25, reset: null },
      sevenDay: { utilization: 0.08, reset: null },
      fable: { available: true, utilization: 0.33, reset: null },
    }),
  ]);
  assert.match(out, /Subscription usage \(5h \/ 7d \/ fable\):/);
  // The advisory "flaps near its boundary" doctrine is obsolete — the probe is
  // truthful now; the header states the snapshot's freshness contract instead.
  assert.doesNotMatch(out, /flaps/);
  assert.match(out, /at most 2h old.*--reprobe/);
  assert.match(out, /fable 33\.0%/);
  assert.match(out, /5h 25\.0%/);
});

test("renderSubscriptionsUsageQuiet: appends fable:<state> field per line", () => {
  const out = renderSubscriptionsUsageQuiet([
    usage({
      id: "a",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.2, reset: null },
      fable: { available: true, utilization: 0.1, reset: null },
    }),
    usage({
      id: "b",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.2, reset: null },
      fable: { available: false, utilization: 1, reset: null },
    }),
    usage({
      id: "c",
      fiveHour: { utilization: 0.1, reset: null },
      sevenDay: { utilization: 0.2, reset: null },
    }),
  ]);
  assert.match(out, /^a\t10\.0%\t20\.0%\tfable:ok$/m);
  assert.match(out, /^b\t10\.0%\t20\.0%\tfable:exhausted$/m);
  assert.match(out, /^c\t10\.0%\t20\.0%\tfable:-$/m);
});
