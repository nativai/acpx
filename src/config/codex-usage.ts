import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Codex 5-hour / weekly *subscription* quota, read passively from Codex's own
// native CLI rollout logs at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
// Each turn the ChatGPT backend's rate-limit response is persisted into an
// `event_msg`/`token_count` payload as `rate_limits`. Most token_count lines
// carry `rate_limits: null` (the slot only refreshes on a backend response);
// the freshest NON-null one is the snapshot.
//
// Ported verbatim from acpx-ui (server/codexQuota.ts) — pure fs+JSON, with the
// Express route wrapper dropped. acpx must not depend on acpx-ui, so the scanner
// is duplicated here; the on-disk rollout shape is the cross-tool contract.
// Honesty rules (encoded as `notes` + `elapsed`/`capturedAt` fields):
//   1. Point-in-time snapshot, refreshed only on Codex activity — can be stale.
//   2. Window-elapsed (now > resets_at) → the % is void; surface `elapsed`.
//   3. Account-global ChatGPT quota (limit_id "codex"), not per-acpx-session.
//   4. Not OpenAI billing.

const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/;

export type CodexQuotaWindow = {
  windowMinutes: number; // 300 (5h) | 10080 (weekly)
  usedPercent: number; // 0..100
  resetsAt: string; // ISO 8601 (from resets_at epoch seconds)
  resetsAtEpoch: number; // raw unix seconds (agent-friendly)
  elapsed: boolean; // server-computed: now > resets_at → % is void
};

export type CodexQuotaResponse = {
  source: "codex-cli-rollout";
  agent: "codex";
  generatedAt: string;
  capturedAt: string | null; // the rollout line's top-level `timestamp` (the "as of")
  ageSeconds: number | null; // generatedAt − capturedAt, in whole seconds
  planType: string | null; // 'pro' | 'plus' | …
  primary: CodexQuotaWindow | null; // 5h
  secondary: CodexQuotaWindow | null; // weekly
  rolloutPath: string | null; // diagnostic: which file the snapshot came from
  scan: { sessionsDir: string; filesScanned: number; filesWithRateLimits: number };
  notes: string[];
};

type RawWindow = {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
};

type RawRateLimits = {
  plan_type?: unknown;
  primary?: unknown;
  secondary?: unknown;
};

type Snapshot = {
  capturedAt: string;
  capturedAtMs: number;
  rateLimits: RawRateLimits;
  rolloutPath: string;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Default Codex home is `~/.codex`; the sessions store lives under it. The base
// is overridable via ACPX_CODEX_HOME (points at the `.codex` dir, mirroring the
// real Codex CLI's CODEX_HOME convention) so a tester can aim at a fixture
// store, e.g. ACPX_CODEX_HOME=/tmp/fix → /tmp/fix/sessions/YYYY/MM/DD/…
export function defaultCodexSessionsDir(): string {
  const codexHome = process.env.ACPX_CODEX_HOME
    ? path.resolve(process.env.ACPX_CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Absolute paths of `YYYY/MM/DD` day directories under `sessionsDir`, newest
// first. Names are zero-padded so a reverse lexical sort on the `Y/M/D` key is
// chronological. Missing/unreadable dirs yield an empty list (never throws).
function listDayDirsNewestFirst(sessionsDir: string): string[] {
  const days: Array<{ key: string; path: string }> = [];
  for (const year of safeReaddir(sessionsDir)) {
    if (!/^\d{4}$/.test(year)) {
      continue;
    }
    const yearDir = path.join(sessionsDir, year);
    for (const month of safeReaddir(yearDir)) {
      if (!/^\d{2}$/.test(month)) {
        continue;
      }
      const monthDir = path.join(yearDir, month);
      for (const day of safeReaddir(monthDir)) {
        if (!/^\d{2}$/.test(day)) {
          continue;
        }
        days.push({ key: `${year}/${month}/${day}`, path: path.join(monthDir, day) });
      }
    }
  }
  days.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return days.map((d) => d.path);
}

// Rollout files in `dayDir`, newest mtime first. Unstattable entries sort last.
function listRolloutFilesNewestFirst(dayDir: string): string[] {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of safeReaddir(dayDir)) {
    if (!ROLLOUT_FILE_RE.test(name)) {
      continue;
    }
    const filePath = path.join(dayDir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    files.push({ path: filePath, mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.map((f) => f.path);
}

// Pull the `rate_limits` object out of a token_count payload, or null when the
// payload is not a token_count line carrying a non-null rate_limits object.
function rateLimitsFromPayload(payload: unknown): RawRateLimits | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const p = payload as { type?: unknown; rate_limits?: unknown };
  if (p.type !== "token_count") {
    return null;
  }
  if (!p.rate_limits || typeof p.rate_limits !== "object") {
    return null;
  }
  return p.rate_limits as RawRateLimits;
}

// Parse a trimmed line of JSON into an object, or null for blank/malformed input.
function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Parse one rollout line into {capturedAt, rateLimits}, or null for any line
// that is not a well-formed `event_msg`/`token_count` carrying non-null
// rate_limits with a parseable top-level timestamp. Malformed JSON is skipped.
function parseRolloutLine(
  line: string,
): { capturedAt: string; capturedAtMs: number; rateLimits: RawRateLimits } | null {
  const record = parseJsonObject(line);
  if (!record) {
    return null;
  }
  if (record.type !== "event_msg" || typeof record.timestamp !== "string") {
    return null;
  }
  const rateLimits = rateLimitsFromPayload(record.payload);
  if (!rateLimits) {
    return null;
  }
  const capturedAtMs = Date.parse(record.timestamp);
  if (!Number.isFinite(capturedAtMs)) {
    return null;
  }
  return { capturedAt: record.timestamp, capturedAtMs, rateLimits };
}

// The non-null rate-limit snapshot with the most-recent top-level `timestamp`
// in one rollout file, or null if the file has none. Malformed lines are
// skipped. Reads the whole file (rollouts are small per-turn logs).
function snapshotFromFile(rolloutPath: string): Snapshot | null {
  let raw: string;
  try {
    raw = readFileSync(rolloutPath, "utf8");
  } catch {
    return null;
  }

  let best: Snapshot | null = null;
  for (const line of raw.split("\n")) {
    const candidate = parseRolloutLine(line);
    if (candidate && (!best || candidate.capturedAtMs > best.capturedAtMs)) {
      best = { ...candidate, rolloutPath };
    }
  }
  return best;
}

// Walk day dirs newest-first, files within each by mtime desc, and stop at the
// first file that yields a non-null snapshot (short-circuit — don't rescan all
// 200+ files per request). `filesScanned` counts files read up to and
// including the hit. Newest mtime is the freshness heuristic; the snapshot's
// own `capturedAt` is reported so consumers can judge staleness directly.
function findFreshestSnapshot(sessionsDir: string): {
  snapshot: Snapshot | null;
  filesScanned: number;
  filesWithRateLimits: number;
} {
  let filesScanned = 0;
  let filesWithRateLimits = 0;
  for (const dayDir of listDayDirsNewestFirst(sessionsDir)) {
    for (const rolloutPath of listRolloutFilesNewestFirst(dayDir)) {
      filesScanned++;
      const snapshot = snapshotFromFile(rolloutPath);
      if (snapshot) {
        filesWithRateLimits++;
        return { snapshot, filesScanned, filesWithRateLimits };
      }
    }
  }
  return { snapshot: null, filesScanned, filesWithRateLimits };
}

function buildWindow(raw: unknown, nowEpoch: number): CodexQuotaWindow | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const window = raw as RawWindow;
  const resetsAtEpoch = finiteNumber(window.resets_at);
  if (resetsAtEpoch === null || resetsAtEpoch <= 0) {
    return null; // can't anchor the reset → treat as absent
  }
  return {
    windowMinutes: finiteNumber(window.window_minutes) ?? 0,
    usedPercent: finiteNumber(window.used_percent) ?? 0,
    resetsAt: new Date(resetsAtEpoch * 1000).toISOString(),
    resetsAtEpoch,
    elapsed: nowEpoch > resetsAtEpoch,
  };
}

const ACCOUNT_GLOBAL_NOTE =
  'Account-global ChatGPT quota (limit_id "codex"), shared across all Codex sessions — not scoped to any one acpx session.';
const SNAPSHOT_NOTE =
  'Point-in-time snapshot from Codex’s own CLI rollout logs; it only refreshes when Codex makes a backend request, so it can be stale. See "capturedAt".';
const NOT_BILLING_NOTE =
  "Not OpenAI account billing; do not combine with Claude Code ccusage totals.";

export function collectCodexQuota(sessionsDir = defaultCodexSessionsDir()): CodexQuotaResponse {
  const nowMs = Date.now();
  const nowEpoch = Math.floor(nowMs / 1000);
  const { snapshot, filesScanned, filesWithRateLimits } = findFreshestSnapshot(sessionsDir);

  const notes: string[] = [SNAPSHOT_NOTE, ACCOUNT_GLOBAL_NOTE, NOT_BILLING_NOTE];

  if (!snapshot) {
    notes.push(
      `No non-null Codex rate-limit snapshot found under ${sessionsDir} — run a Codex turn to populate one.`,
    );
    return {
      source: "codex-cli-rollout",
      agent: "codex",
      generatedAt: new Date(nowMs).toISOString(),
      capturedAt: null,
      ageSeconds: null,
      planType: null,
      primary: null,
      secondary: null,
      rolloutPath: null,
      scan: { sessionsDir, filesScanned, filesWithRateLimits },
      notes,
    };
  }

  const primary = buildWindow(snapshot.rateLimits.primary, nowEpoch);
  const secondary = buildWindow(snapshot.rateLimits.secondary, nowEpoch);
  const planType =
    typeof snapshot.rateLimits.plan_type === "string" ? snapshot.rateLimits.plan_type : null;

  if (primary?.elapsed) {
    notes.push(
      "The 5-hour window already reset since this snapshot was captured (now > resets_at); its used_percent is stale — run a Codex turn to refresh.",
    );
  }
  if (secondary?.elapsed) {
    notes.push(
      "The weekly window already reset since this snapshot was captured (now > resets_at); its used_percent is stale — run a Codex turn to refresh.",
    );
  }

  return {
    source: "codex-cli-rollout",
    agent: "codex",
    generatedAt: new Date(nowMs).toISOString(),
    capturedAt: snapshot.capturedAt,
    ageSeconds: Math.max(0, Math.floor((nowMs - snapshot.capturedAtMs) / 1000)),
    planType,
    primary,
    secondary,
    rolloutPath: snapshot.rolloutPath,
    scan: { sessionsDir, filesScanned, filesWithRateLimits },
    notes,
  };
}
