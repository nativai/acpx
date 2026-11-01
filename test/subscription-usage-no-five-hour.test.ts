import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderUsageText } from "../src/cli/subscriptions-command.js";
import {
  countEligibleFailoverTargets,
  getSubscriptionsUsage,
  pickFailoverTarget,
  projectAccountSubscriptionUsage,
  subscriptionEligibilityVerdict,
  type SubscriptionUsage,
} from "../src/config/subscription-usage.js";
import type { SubscriptionEntry } from "../src/config/subscriptions.js";
import { removeTempHome } from "./temp-home.js";

// brick 01f8824e: Anthropic is removing the 5-hour limit. A switched account's
// probe returns the unified 7d headers and NO 5h-* headers; such an account has
// no 5h limit (`noFiveHourLimit: true`) and must not read as `usage-error`.

const RESET_7D = 1793858400;
const RESET_5H = 1793800000;

// Exactly the header set measured on a switched account (CONTRACT.md, sub3).
const NO_5H_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-unified-7d-reset": String(RESET_7D),
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.09",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-reset": String(RESET_7D),
  "anthropic-ratelimit-unified-status": "allowed",
};

// The not-yet-switched shape (sub8): the same plus the 5h window.
const WITH_5H_HEADERS: Record<string, string> = {
  ...NO_5H_HEADERS,
  "anthropic-ratelimit-unified-5h-reset": String(RESET_5H),
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.31",
  "anthropic-ratelimit-unified-fallback": "available",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
};

// The usage cache is keyed by subscription id for 5 minutes, so every rig sub
// gets a distinct id.
let uidCounter = 0;
function uid(tag: string): string {
  uidCounter += 1;
  return `no5h-${tag}-${uidCounter}`;
}

function startMock(
  headersByToken: Map<string, Record<string, string>>,
  hits: string[],
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      req.resume();
      req.on("end", () => {
        hits.push(token);
        res.writeHead(200, headersByToken.get(token) ?? {}).end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1/messages` });
    });
  });
}

async function withProbeRig(
  subs: Array<{ id: string; headers: Record<string, string>; account?: string }>,
  run: (ctx: { entries: SubscriptionEntry[]; hits: string[] }) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-no5h-"));
  const headersByToken = new Map<string, Record<string, string>>();
  const entries: SubscriptionEntry[] = [];
  for (const sub of subs) {
    const configDir = path.join(home, sub.id);
    await fs.mkdir(configDir, { recursive: true });
    const token = `token-${sub.id}`;
    await fs.writeFile(
      path.join(configDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
    );
    headersByToken.set(token, sub.headers);
    entries.push({ id: sub.id, label: sub.id, configDir, account: sub.account ?? sub.id });
  }
  const hits: string[] = [];
  const { server, url } = await startMock(headersByToken, hits);
  const prev = {
    endpoint: process.env.CLAUDE_MESSAGES_ENDPOINT,
    stateHome: process.env.ACPX_STATE_HOME,
  };
  process.env.CLAUDE_MESSAGES_ENDPOINT = url;
  process.env.ACPX_STATE_HOME = home;
  try {
    await run({ entries, hits });
  } finally {
    server.close();
    for (const [key, value] of [
      ["CLAUDE_MESSAGES_ENDPOINT", prev.endpoint],
      ["ACPX_STATE_HOME", prev.stateHome],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await removeTempHome(home);
  }
}

function usage(overrides: Partial<SubscriptionUsage>): SubscriptionUsage {
  return {
    id: "u",
    label: "u",
    fiveHour: null,
    sevenDay: null,
    effectiveWeeklyCeiling: 0.9,
    weeklyCeilingSource: "built-in",
    weeklyCeilingHard: true,
    ...overrides,
  };
}

const RESET_7D_ISO = new Date(RESET_7D * 1000).toISOString();

function noFiveHour(id: string, sevenDayUtil: number): SubscriptionUsage {
  return usage({
    id,
    label: id,
    sevenDay: { utilization: sevenDayUtil, reset: RESET_7D_ISO },
    noFiveHourLimit: true,
  });
}

// ── The probe parser (usageFromResponse) — both header shapes ───────────────

test("probe: a 7d-only reading sets noFiveHourLimit and is eligible on 7d alone", async () => {
  const id = uid("switched");
  await withProbeRig([{ id, headers: NO_5H_HEADERS }], async ({ entries }) => {
    const [reading] = await getSubscriptionsUsage(entries, true);
    assert.equal(reading?.error, undefined);
    assert.equal(reading?.fiveHour, null);
    assert.deepEqual(reading?.sevenDay, { utilization: 0.09, reset: RESET_7D_ISO });
    assert.equal(reading?.noFiveHourLimit, true);
    assert.equal(reading?.eligibility?.reason, null);
    assert.equal(reading?.eligibility?.vendorAvailable, true);
    assert.equal(reading?.eligibility?.automationEligible, true);
    // The flag is part of the JSON surface acpx-ui parses.
    assert.match(JSON.stringify(reading), /"noFiveHourLimit":true/);
  });
});

test("probe: a reading WITH the 5h window behaves exactly as before (no flag)", async () => {
  const id = uid("legacy");
  await withProbeRig([{ id, headers: WITH_5H_HEADERS }], async ({ entries }) => {
    const [reading] = await getSubscriptionsUsage(entries, true);
    assert.equal(reading?.error, undefined);
    assert.deepEqual(reading?.fiveHour, {
      utilization: 0.31,
      reset: new Date(RESET_5H * 1000).toISOString(),
    });
    assert.equal(reading?.noFiveHourLimit, undefined);
    assert.equal("noFiveHourLimit" in (reading ?? {}), false);
    assert.equal(reading?.eligibility?.reason, null);
    assert.equal(reading?.eligibility?.vendorAvailable, true);
  });
});

test("probe: a 200 with NO rate-limit headers stays an error and never carries the flag", async () => {
  const id = uid("bare");
  await withProbeRig([{ id, headers: {} }], async ({ entries }) => {
    const [reading] = await getSubscriptionsUsage(entries, true);
    assert.equal(reading?.error, "upstream response missing rate-limit headers");
    assert.equal(reading?.noFiveHourLimit, undefined);
    assert.equal(reading?.eligibility?.reason, "usage-error");
    assert.equal(reading?.eligibility?.vendorAvailable, false);
  });
});

test("probe: the cached reading keeps the flag it was read with", async () => {
  const id = uid("cache");
  await withProbeRig([{ id, headers: NO_5H_HEADERS }], async ({ entries, hits }) => {
    await getSubscriptionsUsage(entries, true);
    const [cached] = await getSubscriptionsUsage(entries);
    assert.equal(hits.length, 1, "second read must be served from the cache");
    assert.equal(cached?.cacheStatus, "cached");
    assert.equal(cached?.noFiveHourLimit, true);
    assert.equal(cached?.eligibility?.reason, null);
  });
});

// ── The eligibility verdict ─────────────────────────────────────────────────

test("verdict: no-5h at 7d=1 is provider-exhausted on the 7d window", () => {
  const verdict = subscriptionEligibilityVerdict(noFiveHour("x", 1), 0.98);
  assert.equal(verdict.reason, "provider-exhausted");
  assert.equal(verdict.vendorAvailable, false);
  assert.equal(verdict.constrainingWindow, "seven-day");
  assert.equal(verdict.nextAutomationEligibleAt, RESET_7D_ISO);
  assert.equal(verdict.nextEligibilitySource, "weekly-reset");
});

test("verdict: no-5h above the weekly ceiling is weekly-ceiling, still vendor-available", () => {
  const verdict = subscriptionEligibilityVerdict(noFiveHour("x", 0.93), 0.98);
  assert.equal(verdict.reason, "weekly-ceiling");
  assert.equal(verdict.vendorAvailable, true);
  assert.equal(verdict.constrainingWindow, "seven-day");
});

// The committed negative case: "unknown" is never silently promoted to "no limit".
test("verdict NEGATIVE: fiveHour null WITHOUT the flag stays usage-error", () => {
  const unknown = usage({ sevenDay: { utilization: 0.1, reset: RESET_7D_ISO } });
  const verdict = subscriptionEligibilityVerdict(unknown, 0.98);
  assert.equal(verdict.reason, "usage-error");
  assert.equal(verdict.vendorAvailable, false);
  assert.equal(verdict.automationEligible, false);
});

test("verdict NEGATIVE: the flag without a 7d window is still usage-error", () => {
  const verdict = subscriptionEligibilityVerdict(usage({ noFiveHourLimit: true }), 0.98);
  assert.equal(verdict.reason, "usage-error");
  assert.equal(verdict.vendorAvailable, false);
});

// ── Failover / auto-selection pick ──────────────────────────────────────────

test("pick: a no-5h account with 7d headroom is picked over a 5h-full one", () => {
  const full = usage({
    id: "full",
    fiveHour: { utilization: 0.99, reset: null },
    sevenDay: { utilization: 0.1, reset: RESET_7D_ISO },
  });
  const usages = [full, noFiveHour("open", 0.2)];
  assert.equal(pickFailoverTarget(usages, { exclude: new Set(), threshold: 0.98 })?.id, "open");
  assert.equal(countEligibleFailoverTargets(usages, { exclude: new Set(), threshold: 0.98 }), 1);
});

test("pick: no-5h accounts at the weekly ceiling or provider-exhausted are not picked", () => {
  const usages = [noFiveHour("ceiling", 0.95), noFiveHour("exhausted", 1)];
  assert.equal(pickFailoverTarget(usages, { exclude: new Set(), threshold: 0.98 }), undefined);
});

test("pick NEGATIVE: the same account WITHOUT the flag is not picked", () => {
  const unknown = usage({ id: "unknown", sevenDay: { utilization: 0.2, reset: RESET_7D_ISO } });
  assert.equal(pickFailoverTarget([unknown], { exclude: new Set() }), undefined);
});

// ── Account aggregation (aliases sharing one account) ───────────────────────

function alias(id: string, overrides: Partial<SubscriptionUsage>): SubscriptionUsage {
  return usage({ id, label: id, account: "acct", ...overrides });
}

test("aggregation: the flag survives when every successful alias carries it", () => {
  const projected = projectAccountSubscriptionUsage([
    alias("a", { sevenDay: { utilization: 0.2, reset: RESET_7D_ISO }, noFiveHourLimit: true }),
    alias("b", { sevenDay: { utilization: 0.4, reset: RESET_7D_ISO }, noFiveHourLimit: true }),
    alias("c", { error: "HTTP 500" }),
  ]);
  for (const entry of projected) {
    assert.equal(entry.noFiveHourLimit, true, entry.id);
    assert.equal(entry.sevenDay?.utilization, 0.4, entry.id);
  }
  assert.equal(projected[0]?.eligibility?.reason, null);
  assert.equal(projected[2]?.eligibility?.reason, "usage-error", "alias-local error stays");
});

test("aggregation NEGATIVE: an alias reading null 5h WITHOUT the flag drops it (unknown)", () => {
  const projected = projectAccountSubscriptionUsage([
    alias("a", { sevenDay: { utilization: 0.2, reset: RESET_7D_ISO }, noFiveHourLimit: true }),
    alias("b", { sevenDay: { utilization: 0.2, reset: RESET_7D_ISO } }),
  ]);
  for (const entry of projected) {
    assert.equal(entry.noFiveHourLimit, undefined, entry.id);
    assert.equal(entry.eligibility?.reason, "usage-error", entry.id);
  }
});

test("aggregation: an alias that still reads a 5h window wins — the flag is dropped", () => {
  const projected = projectAccountSubscriptionUsage([
    alias("a", { sevenDay: { utilization: 0.2, reset: RESET_7D_ISO }, noFiveHourLimit: true }),
    alias("b", {
      fiveHour: { utilization: 0.5, reset: null },
      sevenDay: { utilization: 0.2, reset: RESET_7D_ISO },
    }),
  ]);
  for (const entry of projected) {
    assert.equal(entry.noFiveHourLimit, undefined, entry.id);
    assert.equal(entry.fiveHour?.utilization, 0.5, entry.id);
  }
});

// ── CLI text output ─────────────────────────────────────────────────────────

test("text output: a no-5h account reads `5h no limit`; an unknown 5h still reads `5h -`", () => {
  const text = renderUsageText([
    noFiveHour("open", 0.2),
    usage({ id: "unknown", label: "unknown", sevenDay: { utilization: 0.2, reset: null } }),
  ]);
  assert.match(text, /open\topen\t5h no limit\t7d 20\.0%/);
  assert.match(text, /unknown\tunknown\t5h -\t7d 20\.0%/);
});
