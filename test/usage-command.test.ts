import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSingleSelector,
  describeUsageError,
  formatUsageResult,
  type ClaudeUsageResult,
  type CodexUsageResult,
} from "../src/cli/usage-command.js";
import type { SubscriptionUsage } from "../src/config/subscription-usage.js";
import {
  AcpxOperationalError,
  SessionNotFoundError,
  SessionResolutionError,
  SubscriptionUnknownError,
} from "../src/errors.js";

// Pure formatting/error/selector seams of `acpx usage`. The I/O-bound resolution
// (record-first agent classification, the live probe) is covered by the
// real-backend self-test + the independent test-engineer; here we pin the
// output shapes and the documented edge behavior.

const claudeResult: ClaudeUsageResult = {
  kind: "claude-subscription",
  session: { id: "abc-123", name: "my-session", agent: "claude" },
  subscription: { id: "sub2", label: "Subscription 2 (rename me)" },
  source: "session-record",
  fiveHour: { utilization: 0.31, percentUsed: 31, reset: "2026-06-05T13:50:00.000Z" },
  sevenDay: { utilization: 0.35, percentUsed: 35, reset: "2026-06-09T12:00:00.000Z" },
};

test("claude json round-trips the result object verbatim", () => {
  assert.deepEqual(JSON.parse(formatUsageResult(claudeResult, "json").trim()), claudeResult);
});

test("claude quiet emits bare id\\t5h\\t7d numbers (no % sign)", () => {
  assert.equal(formatUsageResult(claudeResult, "quiet"), "sub2\t31.0\t35.0\n");
});

test("claude text is one readable line with sub, both windows, session + source", () => {
  const text = formatUsageResult(claudeResult, "text");
  assert.match(text, /^usage: sub2 \(Subscription 2 \(rename me\)\)/);
  assert.match(text, /5h 31\.0% \(resets 2026-06-05T13:50:00\.000Z\)/);
  assert.match(text, /7d 35\.0% \(resets 2026-06-09T12:00:00\.000Z\)/);
  assert.match(text, /\[session: my-session · source: session-record\]/);
});

test("claude with a probe/sub-removed error renders ERROR in text and dashes in quiet", () => {
  const errored: ClaudeUsageResult = {
    kind: "claude-subscription",
    session: { id: "abc", name: null, agent: "claude" },
    subscription: { id: "subX", label: "subX" },
    source: "session-record",
    fiveHour: null,
    sevenDay: null,
    error: 'subscription "subX" not in registry',
  };
  assert.match(formatUsageResult(errored, "text"), /ERROR: subscription "subX" not in registry/);
  assert.equal(formatUsageResult(errored, "quiet"), "subX\t-\t-\n");
});

test("claude with no session record labels the absence in text", () => {
  const noSession: ClaudeUsageResult = {
    ...claudeResult,
    session: null,
    source: "registry-default-no-session",
  };
  assert.match(
    formatUsageResult(noSession, "text"),
    /\[source: registry-default-no-session · no active session record\]/,
  );
});

const codexResult: CodexUsageResult = {
  kind: "codex-quota",
  session: { id: "cdx-1", name: "Codex-One", agent: "codex" },
  source: "codex-cli-rollout",
  scope: "account-global",
  planType: "pro",
  capturedAt: "2026-06-02T12:59:06.218Z",
  ageSeconds: 90,
  fiveHour: {
    usedPercent: 11,
    resetsAt: "2026-06-02T16:06:02.000Z",
    windowMinutes: 300,
    elapsed: true,
  },
  weekly: {
    usedPercent: 12,
    resetsAt: "2026-06-07T21:19:00.000Z",
    windowMinutes: 10080,
    elapsed: false,
  },
  notes: ["note"],
};

test("codex json round-trips and never carries a subscription id or claude window", () => {
  const parsed = JSON.parse(formatUsageResult(codexResult, "json").trim());
  assert.deepEqual(parsed, codexResult);
  assert.equal(parsed.scope, "account-global");
  assert.equal("subscription" in parsed, false);
});

test("codex quiet emits codex\\t5h\\tweekly bare numbers", () => {
  assert.equal(formatUsageResult(codexResult, "quiet"), "codex\t11.0\t12.0\n");
});

test("codex text marks the elapsed window and is account-global", () => {
  const text = formatUsageResult(codexResult, "text");
  assert.match(text, /codex quota \(account-global\)/);
  assert.match(text, /5h 11\.0% \(elapsed\)/);
  assert.match(text, /weekly 12\.0%/);
  assert.match(text, /snapshot 1m old/);
});

test("codex with no snapshot yet renders the run-a-turn hint", () => {
  const empty: CodexUsageResult = {
    ...codexResult,
    capturedAt: null,
    ageSeconds: null,
    fiveHour: null,
    weekly: null,
  };
  assert.match(formatUsageResult(empty, "text"), /no snapshot yet — run a Codex turn/);
  assert.equal(formatUsageResult(empty, "quiet"), "codex\t-\t-\n");
});

test("not-applicable renders the message in text and agent dashes in quiet", () => {
  const na = {
    kind: "not-applicable" as const,
    session: { id: "g-1", name: "gem", agent: "gemini" },
    message: 'Agent "gemini" has no CLI-exposed limit usage.',
  };
  assert.equal(formatUsageResult(na, "text"), 'Agent "gemini" has no CLI-exposed limit usage.\n');
  assert.equal(formatUsageResult(na, "quiet"), "gemini\tn/a\tn/a\n");
});

const allSubs: SubscriptionUsage[] = [
  {
    id: "sub1",
    label: "Subscription 1",
    fiveHour: { utilization: 0.02, reset: "2026-06-05T13:50:00.000Z" },
    sevenDay: { utilization: 0.94, reset: "2026-06-08T03:00:00.000Z" },
  },
];

test("--all json wraps the array under kind, and the array is the subscriptions usage shape", () => {
  const parsed = JSON.parse(
    formatUsageResult({ kind: "all-subscriptions", subscriptions: allSubs }, "json").trim(),
  );
  assert.equal(parsed.kind, "all-subscriptions");
  assert.deepEqual(parsed.subscriptions, allSubs);
});

test("--all quiet keeps the existing subscriptions-usage map (with % sign)", () => {
  // Distinct from single-session quiet, which is bare — documented in TEST-PLAN.
  assert.equal(
    formatUsageResult({ kind: "all-subscriptions", subscriptions: allSubs }, "quiet"),
    "sub1\t2.0%\t94.0%\n",
  );
});

test("describeUsageError: not-found → NO_SESSION, separate json vs text message", () => {
  const info = describeUsageError(new SessionNotFoundError("xyz"));
  assert.equal(info.jsonError, "session not found");
  assert.equal(info.textMessage, "session not found: xyz");
  assert.equal(info.outputCode, "NO_SESSION");
});

test("describeUsageError: unknown subscription + ambiguous → USAGE", () => {
  assert.equal(describeUsageError(new SubscriptionUnknownError("nope")).outputCode, "USAGE");
  assert.equal(describeUsageError(new SessionResolutionError("ambiguous")).outputCode, "USAGE");
});

test("describeUsageError: generic AcpxOperationalError keeps its outputCode (default RUNTIME)", () => {
  assert.equal(describeUsageError(new AcpxOperationalError("boom")).outputCode, "RUNTIME");
  assert.equal(
    describeUsageError(new AcpxOperationalError("x", { outputCode: "USAGE" })).outputCode,
    "USAGE",
  );
});

test("describeUsageError rethrows non-operational errors for the top-level handler", () => {
  assert.throws(() => describeUsageError(new Error("unexpected")), /unexpected/);
});

test("assertSingleSelector allows zero or one selector, rejects combinations", () => {
  assert.doesNotThrow(() => assertSingleSelector({}));
  assert.doesNotThrow(() => assertSingleSelector({ session: "x" }));
  assert.doesNotThrow(() => assertSingleSelector({ subscription: "y" }));
  assert.doesNotThrow(() => assertSingleSelector({ all: true }));
  assert.throws(() => assertSingleSelector({ session: "x", all: true }), /only one of/);
  assert.throws(() => assertSingleSelector({ session: "x", subscription: "y" }), /only one of/);
  assert.throws(() => assertSingleSelector({ subscription: "y", all: true }), /only one of/);
});
