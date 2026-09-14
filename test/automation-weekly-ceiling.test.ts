import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import {
  getSubscriptionsUsage,
  projectAccountSubscriptionUsage,
  subscriptionEligibilityVerdict,
  type SubscriptionUsage,
} from "../src/config/subscription-usage.js";
import { loadSubscriptionRegistry } from "../src/config/subscriptions.js";
import { AutomationCapacityReservedError, SubscriptionLockedError } from "../src/errors.js";
import { textPrompt } from "../src/prompt-content.js";
import { resolveAutoSubscription } from "../src/runtime/engine/auto-subscription.js";
import {
  attemptFailoverAndRetry,
  enforceAutomationWeeklyCeilingBeforeTurn,
  enforceSubscriptionLockBeforeTurn,
  selectSubscriptionBeforeTurn,
} from "../src/runtime/engine/failover.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import type { PromptInput, SessionRecord } from "../src/types.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

const CLAUDE_AGENT = "node /opt/claude-agent-acp/dist/index.js";
let uniqueId = 0;

type ProbeOutcome = {
  fiveHour?: number;
  sevenDay?: number;
  fiveHourReset?: number | null;
  sevenDayReset?: number | null;
  status?: number;
};

type ProfileSpec = {
  id: string;
  account: string;
  outcome: ProbeOutcome;
  locked?: true;
};

type PolicyDocument = {
  defaultAutoWeeklyCeiling?: number;
  accounts?: Record<string, { autoWeeklyCeiling: number }>;
};

type CeilingRig = {
  lookup: { homeDir: string; registryPath: string };
  record: (
    profile: string,
    options?: { autoFailover?: boolean; autoSubscription?: boolean },
  ) => SessionRecord;
  setOutcome: (profile: string, outcome: ProbeOutcome) => void;
  probeCount: (profile: string) => number;
};

function startProbeServer(
  outcomes: Map<string, ProbeOutcome>,
  counts: Map<string, number>,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
      counts.set(token, (counts.get(token) ?? 0) + 1);
      const outcome = outcomes.get(token);
      if (!outcome || (outcome.status !== undefined && outcome.status !== 200)) {
        response.writeHead(outcome?.status ?? 500).end("{}");
        return;
      }
      const headers: Record<string, string> = {};
      if (outcome.fiveHour !== undefined) {
        headers["anthropic-ratelimit-unified-5h-utilization"] = String(outcome.fiveHour);
        if (typeof outcome.fiveHourReset === "number") {
          headers["anthropic-ratelimit-unified-5h-reset"] = String(outcome.fiveHourReset);
        }
      }
      if (outcome.sevenDay !== undefined) {
        headers["anthropic-ratelimit-unified-7d-utilization"] = String(outcome.sevenDay);
        if (outcome.sevenDayReset !== null) {
          headers["anthropic-ratelimit-unified-7d-reset"] = String(
            outcome.sevenDayReset ?? 1_893_456_000,
          );
        }
      }
      response.writeHead(200, headers).end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1/messages` });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withCeilingRig(
  rawSpecs: ProfileSpec[],
  policy: PolicyDocument | undefined,
  run: (rig: CeilingRig) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-weekly-ceiling-"));
  uniqueId += 1;
  const suffix = `-${uniqueId}`;
  const specs = rawSpecs.map((spec) => ({ ...spec, id: `${spec.id}${suffix}` }));
  const subsDir = path.join(homeDir, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const tokenFor = (profile: string) => `token-${profile}`;
  const outcomes = new Map(specs.map((spec) => [tokenFor(spec.id), spec.outcome]));
  const counts = new Map<string, number>();
  const { server, url } = await startProbeServer(outcomes, counts);
  const previous = {
    endpoint: process.env.CLAUDE_MESSAGES_ENDPOINT,
    stateHome: process.env.ACPX_STATE_HOME,
    autoSelect: process.env.ACPX_SUBSCRIPTION_AUTO_SELECT,
    weekly: process.env.ACPX_SUBSCRIPTION_WEEKLY_THRESHOLD,
  };
  process.env.CLAUDE_MESSAGES_ENDPOINT = url;
  process.env.ACPX_STATE_HOME = homeDir;
  delete process.env.ACPX_SUBSCRIPTION_AUTO_SELECT;
  delete process.env.ACPX_SUBSCRIPTION_WEEKLY_THRESHOLD;
  try {
    await fs.mkdir(subsDir, { recursive: true });
    for (const spec of specs) {
      const configDir = path.join(subsDir, spec.id);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: tokenFor(spec.id) } }),
      );
    }
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        version: 3,
        default: specs[0]?.id,
        ...(policy !== undefined ? { subscriptionPolicy: policy } : {}),
        profiles: specs.map((spec) => ({
          id: spec.id,
          label: spec.id,
          authMode: "subscription",
          adapter: "claude",
          account: spec.account,
          credentialSource: path.join(subsDir, spec.id),
          ...(spec.locked === true ? { locked: true } : {}),
        })),
      }),
      { mode: 0o600 },
    );
    const byBaseId = (profile: string) => {
      const found = specs.find((spec) => spec.id === `${profile}${suffix}`);
      assert(found, `profile ${profile} exists`);
      return found;
    };
    await run({
      lookup: { homeDir, registryPath },
      record: (profile, options = {}) =>
        makeSessionRecord({
          acpxRecordId: `record-${profile}${suffix}`,
          acpSessionId: `acp-${profile}${suffix}`,
          agentCommand: CLAUDE_AGENT,
          cwd: path.join(homeDir, "work"),
          acpx: {
            session_options: {
              profile: byBaseId(profile).id,
              ...(options.autoFailover !== undefined
                ? { auto_failover: options.autoFailover }
                : {}),
              ...(options.autoSubscription !== undefined
                ? { auto_subscription: options.autoSubscription }
                : {}),
            },
          },
        }),
      setOutcome: (profile, outcome) => {
        outcomes.set(tokenFor(byBaseId(profile).id), outcome);
      },
      probeCount: (profile) => counts.get(tokenFor(byBaseId(profile).id)) ?? 0,
    });
  } finally {
    await closeServer(server);
    if (previous.endpoint === undefined) {
      delete process.env.CLAUDE_MESSAGES_ENDPOINT;
    } else {
      process.env.CLAUDE_MESSAGES_ENDPOINT = previous.endpoint;
    }
    if (previous.stateHome === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous.stateHome;
    }
    if (previous.autoSelect === undefined) {
      delete process.env.ACPX_SUBSCRIPTION_AUTO_SELECT;
    } else {
      process.env.ACPX_SUBSCRIPTION_AUTO_SELECT = previous.autoSelect;
    }
    if (previous.weekly === undefined) {
      delete process.env.ACPX_SUBSCRIPTION_WEEKLY_THRESHOLD;
    } else {
      process.env.ACPX_SUBSCRIPTION_WEEKLY_THRESHOLD = previous.weekly;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function usage(overrides: Partial<SubscriptionUsage> = {}): SubscriptionUsage {
  return {
    id: "sub",
    label: "Sub",
    account: "acct",
    fiveHour: { utilization: 0.1, reset: null },
    sevenDay: { utilization: 0.1, reset: null },
    effectiveWeeklyCeiling: 0.9,
    weeklyCeilingSource: "account",
    weeklyCeilingHard: true,
    ...overrides,
  };
}

async function withAdvancedClock<T>(advanceMs: number, run: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + advanceMs;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

function makeSharedClient(
  prompt: (sessionId: string, input: PromptInput | string) => Promise<PromptResponse>,
): AcpClient {
  return {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: () => {},
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt,
  } as unknown as AcpClient;
}

function promptText(input: PromptInput | string): string {
  if (typeof input === "string") {
    return input;
  }
  return input
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

function makeQueueTask(
  text: string,
  sent: QueueOwnerMessage[],
  onClose: () => void = () => {},
): QueueTask {
  return {
    requestId: `request-${text.toLowerCase()}`,
    message: text,
    prompt: textPrompt(text),
    permissionMode: "approve-all",
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send: (message) => sent.push(message),
    close: onClose,
  };
}

function userTexts(messages: SessionRecord["messages"]): string[] {
  return messages.flatMap((message) => {
    if (typeof message !== "object" || message === null || !("User" in message)) {
      return [];
    }
    return message.User.content.flatMap((block) => ("Text" in block ? [block.Text] : []));
  });
}

test("shared verdict distinguishes exact reserve/provider boundaries and uncertainty", () => {
  assert.equal(
    subscriptionEligibilityVerdict(usage({ sevenDay: { utilization: 0.8999, reset: null } }))
      .automationEligible,
    true,
  );
  assert.deepEqual(
    subscriptionEligibilityVerdict(usage({ sevenDay: { utilization: 0.9, reset: null } })),
    {
      accountId: "acct",
      accountLabel: "Sub",
      vendorAvailable: true,
      automationEligible: false,
      effectiveWeeklyCeiling: 0.9,
      reservedPercent: 10,
      weeklyCeilingSource: "account",
      hardCeiling: true,
      weeklyUsageKnown: true,
      usageFetchedAt: null,
      usageCacheStatus: "unknown",
      reason: "weekly-ceiling",
      constrainingWindow: "seven-day",
    },
  );
  assert.equal(
    subscriptionEligibilityVerdict(
      usage({
        sevenDay: { utilization: 0.9999, reset: null },
        effectiveWeeklyCeiling: 1,
      }),
    ).automationEligible,
    true,
  );
  assert.equal(
    subscriptionEligibilityVerdict(
      usage({ sevenDay: { utilization: 1, reset: null }, effectiveWeeklyCeiling: 1 }),
    ).reason,
    "provider-exhausted",
  );
  const unknown = subscriptionEligibilityVerdict(usage({ sevenDay: null }));
  assert.equal(unknown.automationEligible, true);
  assert.equal(unknown.weeklyUsageKnown, false);
  assert.equal(unknown.reason, null);
  const weeklyKnownWithoutFiveHour = subscriptionEligibilityVerdict(
    usage({ fiveHour: null, sevenDay: { utilization: 0.9, reset: null } }),
  );
  assert.equal(weeklyKnownWithoutFiveHour.reason, "weekly-ceiling");
  assert.equal(weeklyKnownWithoutFiveHour.weeklyUsageKnown, true);
});

test("provider exhaustion waits for the later reset when both windows are full", () => {
  const verdict = subscriptionEligibilityVerdict(
    usage({
      fiveHour: { utilization: 1, reset: "2030-01-01T00:00:00.000Z" },
      sevenDay: { utilization: 1, reset: "2030-01-03T00:00:00.000Z" },
      effectiveWeeklyCeiling: 1,
    }),
  );
  assert.equal(verdict.reason, "provider-exhausted");
  assert.equal(verdict.constrainingWindow, "seven-day");
  assert.equal(verdict.nextAutomationEligibleAt, "2030-01-03T00:00:00.000Z");
  assert.equal(verdict.nextEligibilitySource, "weekly-reset");

  const fiveHourLater = subscriptionEligibilityVerdict(
    usage({
      fiveHour: { utilization: 1, reset: "2030-01-05T00:00:00.000Z" },
      sevenDay: { utilization: 1, reset: "2030-01-03T00:00:00.000Z" },
      effectiveWeeklyCeiling: 1,
    }),
  );
  assert.equal(fiveHourLater.constrainingWindow, "five-hour");
  assert.equal(fiveHourLater.nextAutomationEligibleAt, "2030-01-05T00:00:00.000Z");
  assert.equal(fiveHourLater.nextEligibilitySource, "five-hour-reset");

  const resetUnknown = subscriptionEligibilityVerdict(
    usage({
      fiveHour: { utilization: 1, reset: "2030-01-01T00:00:00.000Z" },
      sevenDay: { utilization: 1, reset: null },
      effectiveWeeklyCeiling: 1,
    }),
  );
  assert.equal(resetUnknown.constrainingWindow, "seven-day");
  assert.equal(resetUnknown.nextAutomationEligibleAt, undefined);
});

test("account aggregation uses a conservative reset on equal-utilization alias ties", () => {
  const base = usage({ id: "a", label: "A", account: "shared" });
  const later = projectAccountSubscriptionUsage([
    { ...base, id: "a", sevenDay: { utilization: 0.8, reset: "2030-01-01T00:00:00.000Z" } },
    { ...base, id: "b", sevenDay: { utilization: 0.8, reset: "2030-01-03T00:00:00.000Z" } },
  ]);
  assert.deepEqual(
    later.map((entry) => entry.sevenDay?.reset),
    ["2030-01-03T00:00:00.000Z", "2030-01-03T00:00:00.000Z"],
  );

  const unknown = projectAccountSubscriptionUsage([
    { ...base, id: "a", sevenDay: { utilization: 0.8, reset: "2030-01-01T00:00:00.000Z" } },
    { ...base, id: "b", sevenDay: { utilization: 0.8, reset: null } },
  ]);
  assert.deepEqual(
    unknown.map((entry) => entry.sevenDay?.reset),
    [null, null],
  );
});

test("locked reason has precedence while vendor availability remains independently visible", () => {
  const verdict = subscriptionEligibilityVerdict(
    usage({ locked: true, sevenDay: { utilization: 1, reset: null } }),
  );
  assert.equal(verdict.reason, "locked");
  assert.equal(verdict.vendorAvailable, false);
  assert.equal(verdict.automationEligible, false);
});

test("account aliases normalize to one effective ceiling", async () => {
  await withCeilingRig(
    [
      { id: "alias-a", account: "shared", outcome: { fiveHour: 0.1, sevenDay: 0.9 } },
      { id: "alias-b", account: "shared", outcome: { fiveHour: 0.1, sevenDay: 0.1 } },
    ],
    { defaultAutoWeeklyCeiling: 1, accounts: { shared: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup }) => {
      const registry = loadSubscriptionRegistry(lookup);
      assert.deepEqual(
        registry.subscriptions.map((entry) => [
          entry.account,
          entry.effectiveWeeklyCeiling,
          entry.weeklyCeilingSource,
        ]),
        [
          ["shared", 0.9, "account"],
          ["shared", 0.9, "account"],
        ],
      );
      const usages = await getSubscriptionsUsage(registry.subscriptions, true);
      assert.equal(usages[0]?.account, "shared");
      assert.equal(usages[0]?.eligibility?.vendorAvailable, true);
      assert.equal(usages[0]?.eligibility?.automationEligible, false);
      assert.equal(usages[0]?.eligibility?.reason, "weekly-ceiling");
      assert.equal(usages[0]?.eligibility?.effectiveWeeklyCeiling, 0.9);
      assert.equal(usages[0]?.eligibility?.usageCacheStatus, "fresh");
      assert.equal(usages[1]?.sevenDay?.utilization, 0.9);
      assert.equal(usages[1]?.eligibility?.automationEligible, false);
      assert.equal(usages[1]?.eligibility?.reason, "weekly-ceiling");
    },
  );
});

test("creation auto-pick cannot bypass an at-ceiling account through a low alias", async () => {
  await withCeilingRig(
    [
      { id: "high", account: "shared", outcome: { fiveHour: 0.1, sevenDay: 0.9 } },
      { id: "low", account: "shared", outcome: { fiveHour: 0.1, sevenDay: 0.1 } },
    ],
    { accounts: { shared: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup }) => {
      assert.equal(await resolveAutoSubscription(CLAUDE_AGENT, lookup), undefined);
    },
  );
});

test("current low alias is hard-blocked by its account sibling's at-ceiling reading", async () => {
  await withCeilingRig(
    [
      { id: "high", account: "shared", outcome: { fiveHour: 0.1, sevenDay: 0.9 } },
      { id: "low", account: "shared", outcome: { fiveHour: 0.1, sevenDay: 0.1 } },
    ],
    { accounts: { shared: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record }) => {
      await assert.rejects(
        enforceAutomationWeeklyCeilingBeforeTurn(record("low"), lookup),
        AutomationCapacityReservedError,
      );
    },
  );
});

test("proactive selection excludes a sibling alias of the current account", async () => {
  await withCeilingRig(
    [
      { id: "current", account: "shared", outcome: { fiveHour: 0.1, sevenDay: 0.9 } },
      { id: "alias", account: "shared", outcome: { fiveHour: 0.1, sevenDay: 0.1 } },
      { id: "other", account: "other", outcome: { fiveHour: 0.1, sevenDay: 0.2 } },
    ],
    { defaultAutoWeeklyCeiling: 1, accounts: { shared: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record }) => {
      const session = record("current");
      const selection = await selectSubscriptionBeforeTurn(session, lookup);
      assert.match(selection.switchedTo ?? "", /^other-/u);
      assert.doesNotMatch(selection.switchedTo ?? "", /^alias-/u);
    },
  );
});

test("creation auto-pick applies account ceilings and selects the eligible dedicated account", async () => {
  await withCeilingRig(
    [
      { id: "reserve", account: "reserve", outcome: { fiveHour: 0.1, sevenDay: 0.9 } },
      { id: "dedicated", account: "dedicated", outcome: { fiveHour: 0.1, sevenDay: 0.95 } },
    ],
    { defaultAutoWeeklyCeiling: 1, accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup }) => {
      const picked = await resolveAutoSubscription(CLAUDE_AGENT, lookup);
      assert.match(picked ?? "", /^dedicated-/u);
    },
  );
});

test("reactive failover applies the same ceiling verdict", async () => {
  resetKnownDeadSubs();
  try {
    await withCeilingRig(
      [
        { id: "failed", account: "failed", outcome: { fiveHour: 1, sevenDay: 0.2 } },
        { id: "reserve", account: "reserve", outcome: { fiveHour: 0.1, sevenDay: 0.9 } },
        { id: "dedicated", account: "dedicated", outcome: { fiveHour: 0.1, sevenDay: 0.95 } },
      ],
      { defaultAutoWeeklyCeiling: 1, accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
      async ({ lookup, record }) => {
        let turnInvocations = 0;
        const outcome = await attemptFailoverAndRetry({
          record: record("failed"),
          triggerError: new Error("HTTP 429 rate limited"),
          loadOpts: lookup,
          runTurn: async () => {
            turnInvocations += 1;
            return "served";
          },
        });
        assert.match(outcome.switchedTo, /^dedicated-/u);
        assert.equal(outcome.result, "served");
        assert.equal(turnInvocations, 1);
      },
    );
  } finally {
    resetKnownDeadSubs();
  }
});

test("absent policy retains the legacy soft hold at the 0.90 boundary", async () => {
  await withCeilingRig(
    [{ id: "current", account: "reserve", outcome: { fiveHour: 0.1, sevenDay: 0.9 } }],
    undefined,
    async ({ lookup, record }) => {
      const session = record("current");
      assert.deepEqual(await selectSubscriptionBeforeTurn(session, lookup), {});
      const result = await enforceAutomationWeeklyCeilingBeforeTurn(session, lookup);
      assert.equal(result.verdict?.weeklyCeilingSource, "built-in");
      assert.equal(result.verdict?.hardCeiling, false);
      assert.equal(result.verdict?.reason, "weekly-ceiling");
    },
  );
});

test("configured reserve parks before provider invocation when no target exists", async () => {
  await withCeilingRig(
    [{ id: "current", account: "reserve", outcome: { fiveHour: 0.1, sevenDay: 0.9 } }],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record }) => {
      const session = record("current");
      let providerInvocations = 0;
      await selectSubscriptionBeforeTurn(session, lookup);
      await assert.rejects(
        async () => {
          await enforceAutomationWeeklyCeilingBeforeTurn(session, lookup);
          providerInvocations += 1;
        },
        (error: unknown) =>
          error instanceof AutomationCapacityReservedError &&
          error.detailCode === "automation-capacity-reserved" &&
          error.retryable === true,
      );
      assert.equal(providerInvocations, 0);
    },
  );
});

test("runQueuedTask emits reserved terminal before the real client prompt seam", async () => {
  await withCeilingRig(
    [
      {
        id: "current",
        account: "reserve",
        outcome: { fiveHour: 0.1, sevenDay: 0.9, sevenDayReset: 2_000_000_000 },
      },
      {
        id: "waiting",
        account: "alternate",
        outcome: {
          fiveHour: 0.98,
          fiveHourReset: 1_900_000_000,
          sevenDay: 0.2,
          sevenDayReset: 2_100_000_000,
        },
      },
    ],
    {
      defaultAutoWeeklyCeiling: 1,
      accounts: { reserve: { autoWeeklyCeiling: 0.9 } },
    },
    async ({ lookup, record }) => {
      const session = record("current");
      await writeSessionRecordFile(lookup.homeDir, session);
      let promptInvocations = 0;
      const sharedClient = makeSharedClient(async () => {
        promptInvocations += 1;
        return { stopReason: "end_turn" as const };
      });
      const sent: QueueOwnerMessage[] = [];
      let closes = 0;
      const task = makeQueueTask("must not reach provider", sent, () => {
        closes += 1;
      });

      await runQueuedTask(session.acpxRecordId, task, { sharedClient });

      assert.equal(promptInvocations, 0, "client.prompt must remain behind the hard guard");
      assert.equal(closes, 1);
      const terminal = sent.find((message) => message.type === "error");
      assert(terminal && terminal.type === "error");
      assert.equal(terminal.detailCode, "automation-capacity-reserved");
      assert.equal(terminal.retryable, true);
      assert.equal(terminal.automationCapacityReserved?.providerSubmitted, false);
      const stream = await fs.readFile(sessionEventActivePath(session.acpxRecordId), "utf8");
      const persisted = JSON.parse(stream.trim()) as {
        error?: { data?: Record<string, unknown> };
      };
      const data = persisted.error?.data;
      assert(data);
      const profile = session.acpx?.session_options?.profile;
      assert(profile);
      const alternate = loadSubscriptionRegistry(lookup).subscriptions.find(
        (entry) => entry.account === "alternate",
      );
      assert(alternate);
      assert.match(String(data.timestamp), /^\d{4}-\d{2}-\d{2}T/u);
      assert.match(String(data.lastCheckedAt), /^\d{4}-\d{2}-\d{2}T/u);
      assert.deepEqual(data, {
        acpxCode: "RUNTIME",
        detailCode: "automation-capacity-reserved",
        origin: "runtime",
        retryable: true,
        timestamp: data.timestamp,
        sessionId: session.acpxRecordId,
        code: "automation-capacity-reserved",
        accountId: "reserve",
        accountLabel: profile,
        weeklyPercentUsed: 90,
        effectiveWeeklyCeiling: 0.9,
        reservedPercent: 10,
        providerSubmitted: false,
        lastCheckedAt: data.lastCheckedAt,
        weeklyResetAt: new Date(2_000_000_000 * 1000).toISOString(),
        nextAutomationEligibleAt: new Date(1_900_000_000 * 1000).toISOString(),
        nextEligibilityAccountId: "alternate",
        nextEligibilityAccountLabel: alternate.label,
        nextEligibilitySource: "five-hour-reset",
      });
    },
  );
});

test("no-wait reserved refusal terminalizes the correlated delivery exactly once", async () => {
  await withCeilingRig(
    [
      {
        id: "current",
        account: "reserve",
        outcome: { fiveHour: 0.1, sevenDay: 0.9, sevenDayReset: 2_000_000_000 },
      },
    ],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record }) => {
      const session = record("current");
      await writeSessionRecordFile(lookup.homeDir, session);
      let promptInvocations = 0;
      const sharedClient = makeSharedClient(async () => {
        promptInvocations += 1;
        return { stopReason: "end_turn" as const };
      });
      const sent: QueueOwnerMessage[] = [];
      let closes = 0;
      const task = makeQueueTask("park this delivery", sent, () => {
        closes += 1;
      });
      const messageId = "2b9f51a0-7e77-4c7e-a6d9-8e5d06d2cb47";
      task.waitForCompletion = false;
      task.messageId = messageId;

      await runQueuedTask(session.acpxRecordId, task, { sharedClient });

      assert.equal(promptInvocations, 0, "client.prompt must remain behind the hard guard");
      assert.equal(sent.length, 0, "no-wait tasks have no socket terminal waiter");
      assert.equal(task.terminalWritten, true);
      assert.equal(closes, 1);

      type StreamMessage = {
        method?: unknown;
        error?: { data?: { detailCode?: unknown; providerSubmitted?: unknown } };
        params?: {
          messageId?: unknown;
          phase?: unknown;
          error?: { code?: unknown; message?: unknown; detailCode?: unknown };
        };
      };
      const stream = await fs.readFile(sessionEventActivePath(session.acpxRecordId), "utf8");
      const messages = stream
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as StreamMessage);
      const topLevelTerminals = messages.filter(
        (message) =>
          message.method === undefined &&
          message.error?.data?.detailCode === "automation-capacity-reserved",
      );
      assert.equal(topLevelTerminals.length, 1);
      assert.equal(topLevelTerminals[0]?.error?.data?.providerSubmitted, false);

      const deliveryTerminals = messages.filter(
        (message) =>
          message.method === "acpx/delivery" &&
          message.params?.messageId === messageId &&
          message.params.phase === "failed",
      );
      assert.equal(deliveryTerminals.length, 1);
      const deliveryError = deliveryTerminals[0]?.params?.error;
      assert.equal(deliveryError?.detailCode, "automation-capacity-reserved");
      assert.equal(typeof deliveryError?.code, "number");
      assert.equal(typeof deliveryError?.message, "string");

      type FoldedDelivery = {
        status: "delivering" | "failed";
        failureCode?: string;
      };
      const folded = messages.reduce<FoldedDelivery>(
        (state, message) => {
          if (
            message.method !== "acpx/delivery" ||
            message.params?.messageId !== messageId ||
            message.params.phase !== "failed"
          ) {
            return state;
          }
          const detailCode = message.params.error?.detailCode;
          return {
            status: "failed",
            ...(typeof detailCode === "string" ? { failureCode: detailCode } : {}),
          };
        },
        { status: "delivering" },
      );
      assert.deepEqual(folded, {
        status: "failed",
        failureCode: "automation-capacity-reserved",
      });
    },
  );
});

test("manual pin and global kill switch both override hard admission", async () => {
  await withCeilingRig(
    [{ id: "current", account: "reserve", outcome: { fiveHour: 0.1, sevenDay: 0.95 } }],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record }) => {
      assert.deepEqual(
        await enforceAutomationWeeklyCeilingBeforeTurn(
          record("current", { autoFailover: false }),
          lookup,
        ),
        {},
      );
      assert.deepEqual(
        await enforceAutomationWeeklyCeilingBeforeTurn(
          record("current", { autoSubscription: false }),
          lookup,
        ),
        {},
      );
      process.env.ACPX_SUBSCRIPTION_AUTO_SELECT = "false";
      assert.deepEqual(
        await enforceAutomationWeeklyCeilingBeforeTurn(record("current"), lookup),
        {},
      );
    },
  );
});

test("locked current profile wins before configured weekly reserve", async () => {
  await withCeilingRig(
    [
      {
        id: "current",
        account: "reserve",
        locked: true,
        outcome: { fiveHour: 0.1, sevenDay: 0.95 },
      },
    ],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record }) => {
      await assert.rejects(
        enforceSubscriptionLockBeforeTurn(record("current", { autoFailover: false }), lookup),
        SubscriptionLockedError,
      );
    },
  );
});

test("known 100% weekly use is provider exhaustion, not reserved capacity", async () => {
  await withCeilingRig(
    [{ id: "current", account: "dedicated", outcome: { fiveHour: 0.1, sevenDay: 1 } }],
    { accounts: { dedicated: { autoWeeklyCeiling: 1 } } },
    async ({ lookup, record }) => {
      const result = await enforceAutomationWeeklyCeilingBeforeTurn(record("current"), lookup);
      assert.equal(result.verdict?.reason, "provider-exhausted");
      assert.equal(result.verdict?.automationEligible, false);
    },
  );
});

test("exact provider exhaustion records NEW before reactive exhaustion; OLD is never retried", async () => {
  await withCeilingRig(
    [{ id: "current", account: "dedicated", outcome: { fiveHour: 0.1, sevenDay: 1 } }],
    { accounts: { dedicated: { autoWeeklyCeiling: 1 } } },
    async ({ lookup, record }) => {
      const session = record("current");
      session.messages.push({ User: { id: "old", content: [{ Text: "OLD" }] } });
      await writeSessionRecordFile(lookup.homeDir, session);
      const submitted: string[] = [];
      const sharedClient = makeSharedClient(async (_sessionId, input) => {
        submitted.push(promptText(input));
        throw {
          acp: {
            code: -32603,
            message: "provider weekly limit",
            data: { errorKind: "rate_limit" },
          },
        };
      });
      const sent: QueueOwnerMessage[] = [];

      await runQueuedTask(session.acpxRecordId, makeQueueTask("NEW", sent), { sharedClient });

      assert.deepEqual(submitted, ["NEW"]);
      const terminal = sent.find((message) => message.type === "error");
      assert(terminal && terminal.type === "error");
      assert.equal(terminal.detailCode, "all-subscriptions-exhausted");
      const stored = await resolveSessionRecord(session.acpxRecordId);
      const texts = userTexts(stored.messages);
      assert.equal(texts.filter((text) => text === "NEW").length, 1);
      assert.equal(texts.at(-1), "NEW");
      assert.equal(texts.includes("OLD"), true);
    },
  );
});

test("probe uncertainty is exposed but never treated as a known ceiling", async () => {
  await withCeilingRig(
    [{ id: "current", account: "reserve", outcome: { status: 500 } }],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record }) => {
      const result = await enforceAutomationWeeklyCeilingBeforeTurn(record("current"), lookup);
      assert.equal(result.verdict?.reason, "usage-error");
      assert.equal(result.verdict?.weeklyUsageKnown, false);
    },
  );
});

test("a successfully measured weekly ceiling parks even when the five-hour header is absent", async () => {
  await withCeilingRig(
    [{ id: "current", account: "reserve", outcome: { sevenDay: 0.9 } }],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record }) => {
      await assert.rejects(
        enforceAutomationWeeklyCeilingBeforeTurn(record("current"), lookup),
        AutomationCapacityReservedError,
      );
    },
  );
});

test("near-ceiling cached reading is refreshed and stale-below cannot submit", async () => {
  await withCeilingRig(
    [{ id: "current", account: "reserve", outcome: { fiveHour: 0.1, sevenDay: 0.89 } }],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record, setOutcome, probeCount }) => {
      const registry = loadSubscriptionRegistry(lookup);
      const first = await getSubscriptionsUsage(registry.subscriptions, false);
      assert.equal(first[0]?.cacheStatus, "fresh");
      assert.equal(probeCount("current"), 1);
      setOutcome("current", { fiveHour: 0.1, sevenDay: 0.9 });
      let providerInvocations = 0;
      await assert.rejects(
        withAdvancedClock(31_000, async () => {
          await enforceAutomationWeeklyCeilingBeforeTurn(record("current"), lookup);
          providerInvocations += 1;
        }),
        AutomationCapacityReservedError,
      );
      assert.equal(probeCount("current"), 2);
      assert.equal(providerInvocations, 0);
    },
  );
});

test("a millisecond-fresh near-ceiling cache hit is not redundantly reprobed", async () => {
  await withCeilingRig(
    [{ id: "current", account: "reserve", outcome: { fiveHour: 0.1, sevenDay: 0.89 } }],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, record, probeCount }) => {
      const registry = loadSubscriptionRegistry(lookup);
      await getSubscriptionsUsage(registry.subscriptions, false);
      await enforceAutomationWeeklyCeilingBeforeTurn(record("current"), lookup);
      assert.equal(probeCount("current"), 1);
    },
  );
});

test("near-ceiling cached prospective target is refreshed before auto-pick", async () => {
  await withCeilingRig(
    [{ id: "reserve", account: "reserve", outcome: { fiveHour: 0.1, sevenDay: 0.89 } }],
    { accounts: { reserve: { autoWeeklyCeiling: 0.9 } } },
    async ({ lookup, setOutcome, probeCount }) => {
      const registry = loadSubscriptionRegistry(lookup);
      await getSubscriptionsUsage(registry.subscriptions, false);
      setOutcome("reserve", { fiveHour: 0.1, sevenDay: 0.9 });
      const picked = await withAdvancedClock(31_000, async () =>
        resolveAutoSubscription(CLAUDE_AGENT, lookup),
      );
      assert.equal(picked, undefined);
      assert.equal(probeCount("reserve"), 2);
    },
  );
});

test("automatic current reserve switches to an eligible 1.00 account", async () => {
  await withCeilingRig(
    [
      { id: "reserve", account: "reserve-account", outcome: { fiveHour: 0.1, sevenDay: 0.9 } },
      { id: "dedicated", account: "dedicated-account", outcome: { fiveHour: 0.1, sevenDay: 0.95 } },
    ],
    {
      defaultAutoWeeklyCeiling: 1,
      accounts: { "reserve-account": { autoWeeklyCeiling: 0.9 } },
    },
    async ({ lookup, record }) => {
      const session = record("reserve");
      session.messages.push({
        Agent: { content: [{ Text: "prior answer" }], tool_results: {} },
      });
      const registry = loadSubscriptionRegistry(lookup);
      const source = registry.subscriptions.find((entry) => entry.account === "reserve-account");
      const target = registry.subscriptions.find((entry) => entry.account === "dedicated-account");
      assert(source && target && session.acpSessionId);
      const sourceTranscript = transcriptJsonlPath(
        source.configDir,
        session.cwd,
        session.acpSessionId,
      );
      await fs.mkdir(path.dirname(sourceTranscript), { recursive: true });
      await fs.writeFile(
        sourceTranscript,
        '{"type":"assistant","timestamp":"2026-09-13T00:00:00.000Z","text":"context"}\n',
      );
      const selection = await selectSubscriptionBeforeTurn(session, lookup);
      assert.match(selection.switchedTo ?? "", /^dedicated-/u);
      assert.equal(session.acpx?.session_options?.profile, selection.switchedTo);
      assert.equal(session.acpx?.session_options?.account_switch?.reason, "selection");
      const targetTranscript = transcriptJsonlPath(
        target.configDir,
        session.cwd,
        session.acpSessionId,
      );
      assert.match(await fs.readFile(targetTranscript, "utf8"), /context/u);
    },
  );
});
