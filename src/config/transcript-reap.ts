import fs from "node:fs/promises";
import type { SessionRecord } from "../types.js";
import {
  activeTranscriptConfigDir,
  selectFreshestTranscript,
  transcriptJsonlPath,
  type TranscriptCandidate,
} from "./subscription-transcript.js";
import {
  loadSubscriptionRegistry,
  type SubscriptionLookupOptions,
  type SubscriptionRegistry,
} from "./subscriptions.js";
import { removeRedundantCopy, type DedupHooks } from "./transcript-dedup.js";

// D2 (brick 81433524, CONCEPTION §2.4) — the copy a session LEFT in another
// subscription is removed at queue-owner exit, never at the port.
//
// ⚠️ DO NOT MOVE THIS INTO THE PORT, OR BEHIND A TIMER. At every switch-time port
// the OLD adapter is still alive (F5), and Claude Code appends its exit block by
// PATH when it exits (F6, F10) — so deleting its file there makes the exit re-stamp
// RECREATE the path as a metadata-only fragment, which used to win the next
// selection on mtime (F12) and resumed the session with no conversation. Only the
// owner's exit, after its process group is proven empty and while it still holds
// the lease, knows no writer of this session is left. The caller
// (`reapTranscriptsAtOwnerExit`) runs that group step first.

/** A left-behind copy must have been silent this long (mtime) before the reap touches it. */
export const OWNER_EXIT_REAP_QUIET_MS = 10 * 60_000;
/** Per-exit budget: the rest waits for the next exit or `acpx transcripts dedup`. */
export const OWNER_EXIT_REAP_BUDGET = { wallMs: 5_000, bytes: 2 * 1024 * 1024 * 1024 };

export type TranscriptReapFile = {
  action: "deleted" | "reduced";
  path: string;
  bytes: number;
  witness: string;
  tailFile?: string;
  tailFileBytes?: number;
};

export type TranscriptReapSummary = {
  session: string;
  active: string;
  files: TranscriptReapFile[];
  keptReasons: Record<string, number>;
  skipped: string[];
};

type ReapRecord = Pick<SessionRecord, "cwd" | "acpSessionId" | "acpx">;

export async function reapLeftBehindTranscripts(params: {
  record: ReapRecord;
  lookup?: SubscriptionLookupOptions & { registry?: SubscriptionRegistry };
  quietMs?: number;
  budget?: { wallMs: number; bytes: number };
  now?: () => number;
  hooks?: DedupHooks;
}): Promise<TranscriptReapSummary> {
  const { record } = params;
  const registry = params.lookup?.registry ?? loadSubscriptionRegistry(params.lookup);
  const lookup = { ...params.lookup, registry };
  const activeDir = activeTranscriptConfigDir(record, lookup);
  const active = transcriptJsonlPath(activeDir, record.cwd, record.acpSessionId);
  const summary: TranscriptReapSummary = {
    session: record.acpSessionId,
    active,
    files: [],
    keptReasons: {},
    skipped: [],
  };
  const selection = await selectFreshestTranscript(record, activeDir, lookup);
  const leftBehind = selection.candidates.filter((candidate) => !candidate.isDest);
  if (!selection.best?.isDest) {
    // A pending switch, a resolver disagreement, or an active copy that is not the
    // freshest (DIVERGENCE §4): the state is inconsistent, so nothing is removed.
    if (leftBehind.length > 0) {
      summary.skipped.push("not-freshest");
    }
    return summary;
  }
  await reapCandidates(leftBehind, summary, params);
  return summary;
}

type ReapLimits = {
  budget: { wallMs: number; bytes: number };
  quietMs: number;
  startedAt: number;
  now: () => number;
  hooks?: DedupHooks;
};

async function reapCandidates(
  leftBehind: TranscriptCandidate[],
  summary: TranscriptReapSummary,
  params: {
    quietMs?: number;
    budget?: { wallMs: number; bytes: number };
    now?: () => number;
    hooks?: DedupHooks;
  },
): Promise<void> {
  const now = params.now ?? Date.now;
  const limits: ReapLimits = {
    budget: params.budget ?? OWNER_EXIT_REAP_BUDGET,
    quietMs: params.quietMs ?? OWNER_EXIT_REAP_QUIET_MS,
    startedAt: now(),
    now,
    hooks: params.hooks,
  };
  let comparedBytes = 0;
  for (const candidate of leftBehind) {
    const step = await reapCandidate(candidate.jsonlPath, summary, comparedBytes, limits);
    if (step === "stop") {
      return;
    }
    comparedBytes += step;
  }
}

/** One left-behind copy; returns the bytes it compared, or `stop` when the budget is spent. */
async function reapCandidate(
  copyPath: string,
  summary: TranscriptReapSummary,
  comparedBytes: number,
  limits: ReapLimits,
): Promise<number | "stop"> {
  const info = await fs.stat(copyPath).catch(() => undefined);
  if (!info) {
    return 0;
  }
  const verdict = reapVerdict(info, comparedBytes, limits.now(), limits);
  if (verdict === "budget") {
    summary.skipped.push("budget");
    return "stop";
  }
  if (verdict === "recent") {
    countKept(summary, "recent");
    return 0;
  }
  await reapOne(copyPath, summary, limits.hooks);
  return info.size;
}

function reapVerdict(
  info: { size: number; mtimeMs: number },
  comparedBytes: number,
  now: number,
  limits: ReapLimits,
): "budget" | "recent" | "reap" {
  if (now - limits.startedAt >= limits.budget.wallMs) {
    return "budget";
  }
  if (comparedBytes + info.size > limits.budget.bytes) {
    return "budget";
  }
  return now - info.mtimeMs < limits.quietMs ? "recent" : "reap";
}

async function reapOne(
  copyPath: string,
  summary: TranscriptReapSummary,
  hooks: DedupHooks | undefined,
): Promise<void> {
  const { outcome, reasons } = await removeRedundantCopy(copyPath, summary.active, {
    reducedBy: "owner-exit",
    hooks,
  });
  if (outcome.action === "kept") {
    countKept(summary, reasons.join("+") || outcome.reason);
    return;
  }
  summary.files.push(
    outcome.action === "removed"
      ? { action: "deleted", path: copyPath, bytes: outcome.bytes, witness: summary.active }
      : {
          action: "reduced",
          path: copyPath,
          bytes: outcome.bytes,
          witness: summary.active,
          tailFile: outcome.tailFile,
          tailFileBytes: outcome.reusedTailFile ? 0 : outcome.tailFileBytes,
        },
  );
}

function countKept(summary: TranscriptReapSummary, reason: string): void {
  summary.keptReasons[reason] = (summary.keptReasons[reason] ?? 0) + 1;
}

/**
 * The owner.log lines (CONCEPTION §2.9). One summary per exit that found anything
 * to decide; one line per removed file. Grep the fleet with `transcript-reap`.
 */
export function formatTranscriptReapLines(summary: TranscriptReapSummary): string[] {
  const kept = Object.values(summary.keptReasons).reduce((sum, count) => sum + count, 0);
  if (summary.files.length === 0 && kept === 0 && summary.skipped.length === 0) {
    return [];
  }
  const deleted = summary.files.filter((file) => file.action === "deleted");
  const reduced = summary.files.filter((file) => file.action === "reduced");
  const removedBytes = summary.files.reduce((sum, file) => sum + file.bytes, 0);
  const tailBytes = reduced.reduce((sum, file) => sum + (file.tailFileBytes ?? 0), 0);
  const keptReasons = Object.entries(summary.keptReasons)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
  const lines = [
    `[acpx] transcript-reap session=${summary.session} active=${summary.active} ` +
      `deleted=${deleted.length} reduced=${reduced.length} freedBytes=${removedBytes - tailBytes} ` +
      `tailBytes=${tailBytes} kept=${kept} keptReasons=${keptReasons || "none"} ` +
      `skipped=${summary.skipped.join(",") || "none"}\n`,
  ];
  for (const file of summary.files) {
    const tail = file.tailFile ? ` tail=${file.tailFile}` : "";
    lines.push(
      `[acpx] transcript-reap-file action=${file.action} path=${file.path} bytes=${file.bytes} ` +
        `witness=${file.witness}${tail}\n`,
    );
  }
  return lines;
}
