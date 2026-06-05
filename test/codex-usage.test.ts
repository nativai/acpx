import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { collectCodexQuota } from "../src/config/codex-usage.js";

// Ported from acpx-ui server/codexQuota.test.ts (the source of the scanner this
// CLI's src/config/codex-usage.ts is a copy of). Validates the rollout scan,
// epoch→ISO mapping, elapsed flags, newest-wins ordering, and honesty notes.

// Clearly-historical / far-future epochs so the elapsed flags are deterministic
// regardless of when the suite runs (now is always > PAST and < FUTURE).
const PAST_EPOCH = 1_000_000_000; // 2001-09-09T01:46:40Z
const FUTURE_EPOCH = 4_102_444_800; // 2100-01-01T00:00:00Z

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "codex-usage-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// A real-shaped `event_msg`/`token_count` line carrying a rate-limit snapshot.
function snapshotLine(
  timestamp: string,
  opts: {
    planType?: string;
    primaryResets?: number;
    secondaryResets?: number;
    primaryPct?: number;
    secondaryPct?: number;
  } = {},
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 123 } },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: {
          used_percent: opts.primaryPct ?? 16,
          window_minutes: 300,
          resets_at: opts.primaryResets ?? PAST_EPOCH,
        },
        secondary: {
          used_percent: opts.secondaryPct ?? 13,
          window_minutes: 10080,
          resets_at: opts.secondaryResets ?? FUTURE_EPOCH,
        },
        credits: null,
        plan_type: opts.planType ?? "pro",
        rate_limit_reached_type: null,
      },
    },
  });
}

// A token_count line whose rate_limits slot is null (the common case — only
// refreshes on a backend response).
function nullRateLimitLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 7 } },
      rate_limits: null,
    },
  });
}

async function writeRollout(
  relDir: string,
  name: string,
  lines: string[],
  mtimeEpoch?: number,
): Promise<string> {
  const dir = join(scratch, relDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `${lines.join("\n")}\n`);
  if (mtimeEpoch !== undefined) {
    await utimes(path, mtimeEpoch, mtimeEpoch);
  }
  return path;
}

test("parses a real rate-limit snapshot: maps windows, epoch→ISO, elapsed true & false", async () => {
  await writeRollout("2026/06/02", "rollout-2026-06-02T12-45-42-aaaa.jsonl", [
    JSON.stringify({
      timestamp: "2026-06-02T12:40:00.000Z",
      type: "response_item",
      payload: { type: "message" },
    }),
    nullRateLimitLine("2026-06-02T12:50:00.000Z"),
    snapshotLine("2026-06-02T12:59:06.218Z", { primaryPct: 11, secondaryPct: 12 }),
  ]);

  const quota = collectCodexQuota(scratch);

  assert.equal(quota.source, "codex-cli-rollout");
  assert.equal(quota.agent, "codex");
  assert.equal(quota.capturedAt, "2026-06-02T12:59:06.218Z");
  assert.equal(quota.planType, "pro");
  assert.ok(typeof quota.ageSeconds === "number" && quota.ageSeconds >= 0);

  assert.ok(quota.primary);
  assert.equal(quota.primary?.windowMinutes, 300);
  assert.equal(quota.primary?.usedPercent, 11);
  assert.equal(quota.primary?.resetsAtEpoch, PAST_EPOCH);
  assert.equal(quota.primary?.resetsAt, new Date(PAST_EPOCH * 1000).toISOString());
  assert.equal(quota.primary?.elapsed, true); // 5h window already reset → % void

  assert.ok(quota.secondary);
  assert.equal(quota.secondary?.windowMinutes, 10080);
  assert.equal(quota.secondary?.usedPercent, 12);
  assert.equal(quota.secondary?.resetsAtEpoch, FUTURE_EPOCH);
  assert.equal(quota.secondary?.resetsAt, new Date(FUTURE_EPOCH * 1000).toISOString());
  assert.equal(quota.secondary?.elapsed, false);

  assert.ok(quota.rolloutPath?.endsWith("rollout-2026-06-02T12-45-42-aaaa.jsonl"));
  assert.equal(quota.scan.filesWithRateLimits, 1);
  assert.ok(quota.scan.filesScanned >= 1);
  // Honesty notes: snapshot/account-global/not-billing always, plus elapsed-5h.
  assert.ok(quota.notes.some((n) => n.includes("5-hour window already reset")));
  assert.ok(!quota.notes.some((n) => n.includes("weekly window already reset")));
  assert.ok(quota.notes.some((n) => n.includes("Account-global")));
});

test("no snapshot (only null rate_limits) → nulls + honesty note", async () => {
  await writeRollout("2026/06/02", "rollout-2026-06-02T10-00-00-bbbb.jsonl", [
    nullRateLimitLine("2026-06-02T10:00:00.000Z"),
    nullRateLimitLine("2026-06-02T10:05:00.000Z"),
  ]);

  const quota = collectCodexQuota(scratch);

  assert.equal(quota.capturedAt, null);
  assert.equal(quota.ageSeconds, null);
  assert.equal(quota.planType, null);
  assert.equal(quota.primary, null);
  assert.equal(quota.secondary, null);
  assert.equal(quota.rolloutPath, null);
  assert.equal(quota.scan.filesWithRateLimits, 0);
  assert.equal(quota.scan.filesScanned, 1);
  assert.ok(quota.notes.some((n) => n.includes("No non-null Codex rate-limit snapshot")));
});

test("empty store → nulls, filesScanned 0, never throws", async () => {
  const quota = collectCodexQuota(scratch);
  assert.equal(quota.primary, null);
  assert.equal(quota.secondary, null);
  assert.equal(quota.scan.filesScanned, 0);
  assert.equal(quota.scan.filesWithRateLimits, 0);
});

test("newest-mtime file with only null rate_limits is skipped; scan continues to the older file holding the snapshot", async () => {
  // Mirrors today's real situation: the most recently-touched session carries
  // rate_limits:null, while an earlier file holds the freshest real snapshot.
  await writeRollout(
    "2026/06/02",
    "rollout-old-snapshot.jsonl",
    [snapshotLine("2026-06-02T12:00:00.000Z")],
    1_700_000_000,
  );
  await writeRollout(
    "2026/06/02",
    "rollout-new-null.jsonl",
    [nullRateLimitLine("2026-06-02T22:00:00.000Z")],
    1_700_000_100,
  );

  const quota = collectCodexQuota(scratch);

  assert.equal(quota.capturedAt, "2026-06-02T12:00:00.000Z");
  assert.ok(quota.rolloutPath?.endsWith("rollout-old-snapshot.jsonl"));
  assert.equal(quota.scan.filesScanned, 2); // scanned the newer null file, then the older hit
  assert.equal(quota.scan.filesWithRateLimits, 1);
});

test("most-recent top-level timestamp wins within a single file", async () => {
  await writeRollout("2026/06/02", "rollout-multi.jsonl", [
    snapshotLine("2026-06-02T08:00:00.000Z", { primaryPct: 5 }),
    snapshotLine("2026-06-02T20:00:00.000Z", { primaryPct: 42 }),
    snapshotLine("2026-06-02T14:00:00.000Z", { primaryPct: 30 }),
  ]);

  const quota = collectCodexQuota(scratch);
  assert.equal(quota.capturedAt, "2026-06-02T20:00:00.000Z");
  assert.equal(quota.primary?.usedPercent, 42);
});

test("newest day directory wins over an older one", async () => {
  await writeRollout("2026/05/30", "rollout-older-day.jsonl", [
    snapshotLine("2026-05-30T12:00:00.000Z", { primaryPct: 1 }),
  ]);
  await writeRollout("2026/06/02", "rollout-newer-day.jsonl", [
    snapshotLine("2026-06-02T09:00:00.000Z", { primaryPct: 88 }),
  ]);

  const quota = collectCodexQuota(scratch);
  assert.equal(quota.capturedAt, "2026-06-02T09:00:00.000Z");
  assert.equal(quota.primary?.usedPercent, 88);
});

test("malformed lines are skipped, snapshot still found, never throws", async () => {
  await writeRollout("2026/06/02", "rollout-malformed.jsonl", [
    "{ not valid json",
    "",
    "null",
    JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }), // missing rate_limits
    snapshotLine("2026-06-02T13:00:00.000Z", { planType: "plus", secondaryResets: PAST_EPOCH }),
  ]);

  const quota = collectCodexQuota(scratch);
  assert.equal(quota.capturedAt, "2026-06-02T13:00:00.000Z");
  assert.equal(quota.planType, "plus");
  assert.equal(quota.secondary?.elapsed, true); // both windows elapsed here
  assert.ok(quota.notes.some((n) => n.includes("weekly window already reset")));
});
