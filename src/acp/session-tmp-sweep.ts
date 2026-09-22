import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type LiveProcessScan, pidScanIsMeasured } from "../process-population.js";
import { resolveSessionTmpRoot } from "./session-tmp-dir.js";

/**
 * The reaper for `ACPX_SESSION_TMP` directories (SPEC.md "Reaper", brick
 * ceca191f). `/workspace` runs at 88%, so this ships WITH the feature, not
 * after it.
 *
 * ## The rule, stated once
 *
 *   1. A directory a LIVE PROCESS still references (its session id appears on
 *      some live process's command line) is retained, full stop — this is the
 *      one clause nothing below may override, mirroring
 *      `pruneOrphanHarnessConfigDirs`'s "positive ownership" discipline.
 *   2. A directory whose record lookup could not be CONFIRMED either way (the
 *      caller tried and failed, distinct from a confirmed absence) is retained
 *      — `unresolved`, never eligible for clause 4 below no matter its age.
 *   3. A CONFIRMED record decides it, fully, with no age override: OPEN ⇒
 *      retain (`openRecord`) — regardless of directory age, see the warning
 *      below; CLOSED ⇒ removed once idle past the GRACE period (default 7
 *      days), else retained (`tooYoung`).
 *   4. Only when there is NO record at all (a genuinely unclaimed directory,
 *      confirmed by a lookup that positively found nothing) does a HARD
 *      CEILING of directory age (default 30 days) apply — the disk-safety net
 *      SPEC.md asks for, for the one case that has no record to trust.
 *
 * ## ⚠️ WHY AN OPEN RECORD BEATS THE HARD CEILING, UNCONDITIONALLY (brick
 * ## ceca191f, TE finding — this was NOT the original design)
 *
 * The first shipped version put the hard ceiling BEFORE the record check, so
 * ANY directory past 30 days was removed regardless of record state —
 * including a genuinely OPEN, still-in-use session. That is exactly backwards:
 * a session's own age says nothing about whether it is still wanted, and the
 * hard ceiling exists to clean up directories NOBODY can vouch for, not to
 * second-guess a record that says otherwise. It was caught by a test-engineer
 * running the real CLI against a real, large session store on this box:
 * `session.listSessions()` (pre-existing code, not this module) OOM-crashes
 * when parsing this box's real ~1400-record store, so the CLI could only
 * complete via `workbench-exec` — which cannot see the control-plane pod's
 * session records OR live processes at all (both are per-pod). A directory
 * swept from there therefore had NO WAY to ever resolve a record, so every
 * real session fell through to `unrecognised`, and once one crossed 30 days
 * old it would have been removed unconditionally, live or not.
 *
 * The fix has two parts, both required: (a) the CALLER (`command-handlers.ts`)
 * now resolves records with a TARGETED per-candidate lookup
 * (`resolveSessionRecord`), never a full-store parse, so it no longer depends
 * on the pod being able to see the whole store, and can safely run on the
 * control plane, where live sessions' records and processes actually live;
 * (b) this module no longer lets ANY age threshold override a record it
 * actually has — the hard ceiling is scoped to the no-record case alone, and a
 * lookup that FAILED (as opposed to confirmed nothing) is retained
 * unconditionally via clause 2, never silently treated as "no record" and fed
 * to the hard ceiling.
 *
 * ## ⚠️ WHY THE LIVE-PROCESS CHECK NEEDS ONLY THE PID POPULATION
 *
 * `sessionOwnedByLiveProcess` (`process-population.ts`) has two legs: a `pid`
 * match (needs nothing) and a command-line match (world-readable — no
 * privilege). Neither leg reads `environ`, so gating this sweep on
 * `scanIsMeasured` (which additionally requires readable environments) would
 * make it refuse on any box where environments are unreadable even though the
 * command-line leg — the only one this module uses — is perfectly measured.
 * `pidScanIsMeasured` asks the narrower, correct question: "was `/proc`
 * enumerable at all?" A `LiveProcessScan` satisfies that interface structurally
 * (it is a superset of `LivePidScan`), so no separate scan is needed.
 */

/** One week. */
export const DEFAULT_SESSION_TMP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** One month — the safety-net ceiling past which a genuinely UNCLAIMED
 *  directory (no record at all) is removed. Never overrides a record the
 *  sweep actually has — see "why an open record beats the hard ceiling" above
 *  — and still subject to the live-process check. */
export const DEFAULT_SESSION_TMP_HARD_CEILING_MS = 30 * 24 * 60 * 60 * 1000;

/** A session-tmp directory's name IS the session id — no prefix, no suffix.
 *  Matching the full basename against this shape (rather than a `startsWith`
 *  hack) is what keeps the sweep's own stamp file or any stray entry out of
 *  the candidate set structurally, not by convention. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the invoking HOME's store knows about one session id, for this sweep's
 *  purposes only. `idleMs` is precomputed by the caller against its own clock —
 *  `undefined` means no usable timestamp was found, not "zero". */
export interface KnownSessionTmpRecord {
  closed: boolean;
  idleMs?: number;
}

/** Why a directory was KEPT. */
type SessionTmpRetainReason =
  | "liveProcess"
  | "openRecord"
  | "unrecognised"
  | "tooYoung"
  | "unresolved";

/** One candidate and what the rule decided, for a dry-run preview or a report. */
export interface SessionTmpCandidateReport {
  dir: string;
  sessionId: string;
  retain: boolean;
  reason: SessionTmpRetainReason | "removed" | "removeFailed" | "ageUnknown" | "unmeasured";
  dirAgeMs?: number;
}

/** What one sweep run did — every population printed, so `scanned: 0` reads as
 *  NOT RUN rather than as clean (same discipline as the harness config dir and
 *  abandoned-record sweeps this reaper runs alongside). */
export interface SessionTmpSweepResult {
  root: string;
  dryRun: boolean;
  /** Candidate directories examined. 0 means NOT RUN, never "nothing to do". */
  scanned: number;
  removed: string[];
  wouldRemove: string[];
  candidates: SessionTmpCandidateReport[];
  retained: number;
  retainedBy: {
    liveProcess: number;
    openRecord: number;
    unrecognised: number;
    tooYoung: number;
    removeFailed: number;
    /** No usable timestamp AND no readable directory stat — never guessed. */
    ageUnknown: number;
    unmeasured: number;
    /** The caller's record lookup FAILED for this id (distinct from a
     *  confirmed absence) — never eligible for the hard-ceiling clause. */
    unresolved: number;
  };
  oldestRetainedAgeMs?: number;
  /** True when the sweep REFUSED because `/proc` was not enumerable. */
  notMeasured: boolean;
}

export function sweepSessionTmpDirs(params: {
  /** Records keyed by `acpxRecordId` — the only id a session-tmp directory is
   *  ever named after (`session-tmp-dir.ts`). A CONFIRMED absence (the caller
   *  positively looked and found nothing) is the id simply not being a key
   *  here; see {@link unresolvedIds} for "the lookup itself failed", which is
   *  a DIFFERENT thing and must not be represented by omission from this map. */
  records: ReadonlyMap<string, KnownSessionTmpRecord>;
  /** Ids whose record lookup FAILED (an I/O error, not a confirmed miss) —
   *  retained unconditionally, never eligible for the hard-ceiling clause.
   *  Omit entirely (or pass an empty set) only when the caller can guarantee
   *  every lookup was either a confirmed hit or a confirmed absence. */
  unresolvedIds?: ReadonlySet<string>;
  /** The `/proc` census. Absent or unmeasured ⇒ nothing is removed. */
  liveScan?: LiveProcessScan;
  rootDir?: string;
  graceMs?: number;
  hardCeilingMs?: number;
  now?: number;
  /** CLASSIFY AND REPORT, REMOVE NOTHING — same contract as
   *  `pruneOrphanHarnessConfigDirs`'s `dryRun`. */
  dryRun?: boolean;
}): SessionTmpSweepResult {
  const root = resolveSessionTmpRoot(params.rootDir);
  const dryRun = params.dryRun === true;
  const graceMs = params.graceMs ?? DEFAULT_SESSION_TMP_GRACE_MS;
  const hardCeilingMs = params.hardCeilingMs ?? DEFAULT_SESSION_TMP_HARD_CEILING_MS;
  const now = params.now ?? Date.now();
  const unresolvedIds = params.unresolvedIds ?? new Set<string>();
  const retainedBy = {
    liveProcess: 0,
    openRecord: 0,
    unrecognised: 0,
    tooYoung: 0,
    removeFailed: 0,
    ageUnknown: 0,
    unmeasured: 0,
    unresolved: 0,
  };

  const sessionIds = findSessionTmpCandidates(root);
  if (sessionIds === undefined) {
    // The root itself could not be read — nothing was examined, nothing can be
    // concluded. Distinct from "read the root and found nothing".
    return {
      root,
      dryRun,
      scanned: 0,
      removed: [],
      wouldRemove: [],
      candidates: [],
      retained: 0,
      retainedBy,
      notMeasured: true,
    };
  }

  if (!pidScanIsMeasured(params.liveScan)) {
    return {
      root,
      dryRun,
      scanned: sessionIds.length,
      removed: [],
      wouldRemove: [],
      candidates: sessionIds.map((sessionId) => ({
        dir: join(root, sessionId),
        sessionId,
        retain: true,
        reason: "unmeasured",
      })),
      retained: sessionIds.length,
      retainedBy: { ...retainedBy, unmeasured: sessionIds.length },
      notMeasured: true,
    };
  }
  const pass = sweepCandidatePass(root, sessionIds, retainedBy, {
    records: params.records,
    unresolvedIds,
    liveScan: params.liveScan,
    now,
    graceMs,
    hardCeilingMs,
    dryRun,
  });
  return { root, dryRun, ...pass, retainedBy, notMeasured: false };
}

/**
 * The per-candidate pass — every candidate classified once, and the ONLY place
 * a removal is performed. Split out of {@link sweepSessionTmpDirs} so that
 * function reads as *root, refusals, rule* rather than as a loop (mirrors
 * `pruneOrphanHarnessConfigDirs` / `sweepCandidatePass` in
 * `harness-config-dir.ts`).
 */
function sweepCandidatePass(
  root: string,
  sessionIds: readonly string[],
  retainedBy: SessionTmpSweepResult["retainedBy"],
  ctx: {
    records: ReadonlyMap<string, KnownSessionTmpRecord>;
    unresolvedIds: ReadonlySet<string>;
    liveScan: LiveProcessScan;
    now: number;
    graceMs: number;
    hardCeilingMs: number;
    dryRun: boolean;
  },
): Omit<SessionTmpSweepResult, "root" | "dryRun" | "retainedBy" | "notMeasured"> {
  const removed: string[] = [];
  const wouldRemove: string[] = [];
  const candidates: SessionTmpCandidateReport[] = [];
  let retained = 0;
  let oldestRetainedAgeMs: number | undefined;

  for (const sessionId of sessionIds) {
    const dir = join(root, sessionId);
    const verdict = classify(dir, sessionId, ctx);
    if (verdict.dirAgeMs !== undefined && verdict.retain) {
      oldestRetainedAgeMs = Math.max(oldestRetainedAgeMs ?? 0, verdict.dirAgeMs);
    }
    if (verdict.retain) {
      retained += 1;
      retainedBy[verdict.reason] += 1;
      candidates.push({
        dir,
        sessionId,
        retain: true,
        reason: verdict.reason,
        ...ageField(verdict),
      });
      continue;
    }
    if (ctx.dryRun) {
      // ⚠️ NOT pushed into `removed` — see `HarnessConfigDirPruneResult.wouldRemove`
      // for why the two fields must never collapse into one flag-dependent field.
      wouldRemove.push(dir);
      candidates.push({ dir, sessionId, retain: false, reason: "removed", ...ageField(verdict) });
    } else if (removeDir(dir)) {
      removed.push(dir);
      candidates.push({ dir, sessionId, retain: false, reason: "removed", ...ageField(verdict) });
    } else {
      retained += 1;
      retainedBy.removeFailed += 1;
      candidates.push({
        dir,
        sessionId,
        retain: true,
        reason: "removeFailed",
        ...ageField(verdict),
      });
    }
  }

  return {
    scanned: sessionIds.length,
    removed,
    wouldRemove,
    candidates,
    retained,
    oldestRetainedAgeMs,
  };
}

function ageField(verdict: Verdict): { dirAgeMs?: number } {
  return verdict.dirAgeMs === undefined ? {} : { dirAgeMs: verdict.dirAgeMs };
}

type Verdict =
  | { retain: true; reason: SessionTmpRetainReason | "ageUnknown"; dirAgeMs?: number }
  | { retain: false; dirAgeMs: number };

function classify(
  dir: string,
  sessionId: string,
  ctx: {
    records: ReadonlyMap<string, KnownSessionTmpRecord>;
    unresolvedIds: ReadonlySet<string>;
    liveScan: LiveProcessScan;
    now: number;
    graceMs: number;
    hardCeilingMs: number;
  },
): Verdict {
  // Clause 1 — nothing below may override this.
  if (ctx.liveScan.referencedSessionIds.has(sessionId.toLowerCase())) {
    return { retain: true, reason: "liveProcess" };
  }
  const dirAgeMs = directoryAgeMs(dir, ctx.now);
  if (dirAgeMs === undefined) {
    // Unreadable stat — never guessed as either young or old.
    return { retain: true, reason: "ageUnknown" };
  }
  // Clause 2 — a FAILED lookup (not a confirmed absence) is never eligible
  // for the hard ceiling below, no matter how old the directory is.
  if (ctx.unresolvedIds.has(sessionId)) {
    return { retain: true, reason: "unresolved", dirAgeMs };
  }
  // Clause 3 — a CONFIRMED record decides it, fully, with no age override.
  const record = ctx.records.get(sessionId);
  if (record) {
    return classifyByRecord(record, dirAgeMs, ctx.graceMs);
  }
  // Clause 4 — NO record at all (confirmed absence, not a failed lookup): the
  // hard ceiling is the disk-safety net for exactly this case, and only this
  // case.
  if (dirAgeMs >= ctx.hardCeilingMs) {
    return { retain: false, dirAgeMs };
  }
  return { retain: true, reason: "unrecognised", dirAgeMs };
}

/**
 * A CONFIRMED record's own verdict — no age override, ever. Split out of
 * {@link classify} purely to keep that function's branching within budget; the
 * rule itself is unchanged: an OPEN session is never reaped by age alone (see
 * the module header "why an open record beats the hard ceiling"), and a
 * CLOSED one is removed once idle past the grace period, else retained.
 */
function classifyByRecord(
  record: KnownSessionTmpRecord,
  dirAgeMs: number,
  graceMs: number,
): Verdict {
  if (!record.closed) {
    return { retain: true, reason: "openRecord", dirAgeMs };
  }
  // Fall back to directory age when the record itself carries no usable
  // timestamp — the directory's own mtime is a sound proxy for "last touched"
  // and is already known-good at this point (`classify`'s `ageUnknown` branch
  // would have returned first if it weren't).
  const idleMs = record.idleMs ?? dirAgeMs;
  if (idleMs >= graceMs) {
    return { retain: false, dirAgeMs };
  }
  return { retain: true, reason: "tooYoung", dirAgeMs };
}

/** Age from the directory's own birthtime, falling back to mtime when the
 *  filesystem does not report a birthtime (reports it as epoch-zero). */
function directoryAgeMs(dir: string, now: number): number | undefined {
  try {
    const stat = statSync(dir);
    const birth = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    return Math.max(0, now - birth);
  } catch {
    return undefined;
  }
}

/**
 * Every directory this module could have created — an exact UUID-shaped
 * basename, nothing else. `undefined` means the root itself could not be
 * read, which is not the same fact as "the root holds nothing".
 *
 * Exported so the CALLER (`command-handlers.ts`) can enumerate the SAME
 * candidate set before building its records map — a TARGETED per-id lookup
 * needs to know which ids to look up, and duplicating this filter at the call
 * site is exactly the kind of second spelling that lets the two drift apart.
 */
export function findSessionTmpCandidates(root: string): string[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return undefined;
  }
  return entries.filter((name) => SESSION_ID_RE.test(name));
}

function removeDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** One line carrying every population, for the CLI's default (non-verbose)
 *  output — same discipline as `describeAbandonedRecordSweep` /
 *  `describeHarnessConfigDirSweep`: a census that removes things silently is
 *  the shape of every incident that motivated this whole reaper family. */
export function describeSessionTmpSweep(result: SessionTmpSweepResult): string {
  const by = result.retainedBy;
  return (
    `[acpx] session tmp sweep (${result.root}): scanned=${result.scanned} ` +
    `removed=${result.removed.length} retained=${result.retained} ` +
    `(liveProcess=${by.liveProcess} openRecord=${by.openRecord} unrecognised=${by.unrecognised} ` +
    `tooYoung=${by.tooYoung} ageUnknown=${by.ageUnknown} removeFailed=${by.removeFailed})` +
    (result.notMeasured ? " — REFUSED: /proc not measurable, nothing was removed" : "") +
    " (scanned=0 means NOT RUN, not clean)\n"
  );
}
