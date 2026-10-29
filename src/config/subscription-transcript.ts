import { randomBytes } from "node:crypto";
import { access, copyFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionRecord } from "../types.js";
import {
  chooseSubscriptionConfigDir,
  loadSubscriptionRegistry,
  subscriptionConfigDirExists,
  type SubscriptionLookupOptions,
  type SubscriptionRegistry,
} from "./subscriptions.js";
import { removeRedundantCopy, type DedupHooks } from "./transcript-dedup.js";

// Port a session's Claude transcript JSONL from one subscription's config dir to
// another, so a close+reopen on the target account resumes WITH context.
//
// The Claude conversation transcript is stored PER-ACCOUNT, keyed by
// CLAUDE_CONFIG_DIR, at <configDir>/projects/<cwdHash>/<acpSessionId>.jsonl. A
// close+reopen on a different subscription resumes against an account whose
// projects/ tree lacks that JSONL → the SDK throws "No conversation found" and
// acpx silently starts a fresh empty session (all context lost). The JSONL is
// account-agnostic in content (no oauth/org binding embedded — see CONCEPTION
// §0 / evidence.md §C), so a verbatim copy under the same acpSessionId resumes
// cleanly under the new account. This one-file copy IS the whole portability
// layer. Idempotent + overwrite-safe.

/**
 * Longest slug Claude Code emits verbatim. Past this it truncates to exactly
 * this many characters and appends `-<hash of the ORIGINAL cwd>`.
 */
const CLAUDE_SLUG_MAX_LENGTH = 200;

/**
 * Claude Code's own 32-bit string hash — `h = h * 31 + charCodeAt(i)`, kept in
 * int32 by the `| 0`. `(h << 5) - h` IS `h * 31`; it is written that way here to
 * mirror the shipped implementation exactly.
 *
 * `Act` can return -2147483648, and `Math.abs` of that is 2147483648 in JS (no
 * two's-complement overflow — JS numbers are doubles), so the suffix is always
 * positive. A port to a language with a 32-bit `abs` would break on that value.
 */
function claudeSlugOverflowHash(cwd: string): string {
  let hash = 0;
  for (let index = 0; index < cwd.length; index++) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Derive the per-cwd directory segment Claude Code uses under `projects/`.
 *
 * ⚠️ DO NOT "simplify" this back to `cwd.replace(/\//g, "-")`. That was the bug
 * (brick://ae715773): it maps the path separator and NOTHING ELSE, so for any
 * cwd containing a `.`, `_`, space, or other non-`[A-Za-z0-9-]` character acpx
 * computed a transcript path that CANNOT EXIST. A subscription switch then found
 * no source transcript, the port never ran, and the session went unpromptable
 * (before the fail-closed gate, it silently resumed with an EMPTY context).
 * It looked correct for years because for a cwd made only of `[A-Za-z0-9/-]` —
 * the overwhelming majority — the two derivations agree.
 *
 * The rule below is the SPEC, derived empirically from 34 real Claude Code
 * sessions (v2.1.237) run in dot-, punctuation- and unicode-bearing cwds under
 * isolated HOMEs, observing the directory name Claude Code actually wrote:
 * brick://ae715773 `verification/GROUND-TRUTH.md`. Every character outside
 * `[A-Za-z0-9-]` becomes one `-`; case and digits are preserved; nothing is
 * collapsed or trimmed; then, past 200 characters, truncate-and-hash.
 * `test/subscription-transcript.test.ts` pins the observed table — change this
 * function and that table goes red.
 *
 * This is the single source of truth for the layout acpx also uses in
 * `src/cli/session/runtime.ts` (claudeSubagentDir) — keep them in lockstep.
 */
export function transcriptCwdHash(cwd: string): string {
  const substituted = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  if (substituted.length <= CLAUDE_SLUG_MAX_LENGTH) {
    return substituted;
  }
  return `${substituted.slice(0, CLAUDE_SLUG_MAX_LENGTH)}-${claudeSlugOverflowHash(cwd)}`;
}

/**
 * The slug acpx computed BEFORE the fix above — separator-only substitution.
 *
 * Retained purely as a read-side fallback so sessions whose transcript acpx
 * already filed under the wrong-but-consistent name are not orphaned by the
 * switch. It is never used to WRITE: every destination path is the primary form,
 * because the primary form is the only one Claude Code itself will ever read.
 *
 * For a cwd of only `[A-Za-z0-9/-]` this returns exactly what
 * `transcriptCwdHash` returns, so the fallback is a no-op for most sessions.
 * When it does fire it is logged (`transcript-slug-legacy-hit`) — see
 * `resolveExistingTranscriptPath`.
 *
 * ⚠️ REMOVAL CRITERION — do NOT wait for the log lines to stop. They are
 * expected NEVER to appear, so silence proves nothing and an engineer waiting
 * for it waits forever. This fallback is not a migration mechanism.
 *
 * The reason is structural, not circumstantial. A legacy-form directory could
 * only exist where the legacy slug DIFFERS from the primary one AND acpx had
 * successfully WRITTEN there — but writing required first FINDING a source
 * transcript, which for exactly those cwds is what acpx could not do. Claude
 * Code always wrote the correct form; acpx only ever READ the wrong one. So the
 * set of stranded legacy directories is empty by construction, not merely empty
 * today. Measured independently: 0 of 267 live project directories contain any
 * character outside `[A-Za-z0-9-]`, with a positive control confirming the scan
 * could see a dotted name (brick://ae715773 test-engineer VERIFICATION.md).
 *
 * What it IS: cheap insurance for a case the argument above does not cover —
 * a transcript tree produced by some other acpx build or carried between boxes.
 * Removing it therefore has to rest on that structural argument (plus whatever
 * cross-box paths exist at the time), NEVER on an absence of breadcrumbs.
 */
export function legacyTranscriptCwdHash(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Absolute path to a session's transcript JSONL inside a given CLAUDE_CONFIG_DIR.
 * Layout: <configDir>/projects/<cwdHash>/<acpSessionId>.jsonl (the `<acpSessionId>/`
 * dir holding `subagents/` is a sibling and is NOT load-bearing for top-level
 * resume).
 *
 * Always the PRIMARY (Claude-Code-correct) form — this is the canonical path and
 * the only one anything writes to.
 */
export function transcriptJsonlPath(configDir: string, cwd: string, acpSessionId: string): string {
  return path.join(configDir, "projects", transcriptCwdHash(cwd), `${acpSessionId}.jsonl`);
}

/** Same path under the pre-fix slug. Read-side fallback only — never a write target. */
export function legacyTranscriptJsonlPath(
  configDir: string,
  cwd: string,
  acpSessionId: string,
): string {
  return path.join(configDir, "projects", legacyTranscriptCwdHash(cwd), `${acpSessionId}.jsonl`);
}

export type TranscriptSlugForm = "primary" | "legacy";

/**
 * Locate an EXISTING transcript for this cwd, preferring the primary slug and
 * falling back to the legacy one. Returns `undefined` when neither exists.
 *
 * A legacy hit is logged, deliberately: a silent fallback becomes permanent.
 * See `legacyTranscriptCwdHash` for why a hit here should never actually occur
 * in the wild, and why that silence is NOT the criterion for deleting it.
 */
export async function resolveExistingTranscriptPath(
  configDir: string,
  cwd: string,
  acpSessionId: string,
): Promise<{ path: string; form: TranscriptSlugForm } | undefined> {
  const primary = transcriptJsonlPath(configDir, cwd, acpSessionId);
  if (await fileExists(primary)) {
    return { path: primary, form: "primary" };
  }

  const legacy = legacyTranscriptJsonlPath(configDir, cwd, acpSessionId);
  if (legacy !== primary && (await fileExists(legacy))) {
    logLegacyTranscriptSlugHit({ acpSessionId, cwd, legacyPath: legacy, primaryPath: primary });
    return { path: legacy, form: "legacy" };
  }

  return undefined;
}

export type TranscriptRecoveryResult =
  | {
      status: "already-present";
      activeConfigDir: string;
      activePath: string;
      searchedPaths: string[];
    }
  | {
      status: "ported";
      activeConfigDir: string;
      activePath: string;
      sourceConfigDir: string;
      sourcePath: string;
      searchedPaths: string[];
      /**
       * When the destination already held a (staler / divergent) transcript that
       * was renamed aside before porting and the sidecar STILL EXISTS (it was kept),
       * its path. Absent when there was nothing to supersede, or when the sidecar
       * was proven redundant and removed (`supersededDisposition`).
       */
      supersededPath?: string;
      /**
       * What became of the renamed-aside destination (brick 81433524, D1):
       * `deleted` — a byte-prefix of the new active copy; `reduced` — the new copy's
       * prefix plus an exit block, kept byte-exactly in `exitTailPath`; `kept` — a
       * real divergence, preserved as `supersededPath`. Absent when no sidecar was made.
       */
      supersededDisposition?: "deleted" | "reduced" | "kept";
      exitTailPath?: string;
    }
  | {
      status: "missing";
      activeConfigDir: string;
      activePath: string;
      searchedPaths: string[];
    };

type TranscriptBearingRecord = Pick<SessionRecord, "cwd" | "acpSessionId" | "acpx">;

/**
 * Copy the transcript JSONL from `srcConfigDir` to `dstConfigDir` for the given
 * cwd + acpSessionId. Creates the destination `projects/<cwdHash>/` dir. If the
 * source JSONL is absent (fresh session, never prompted) this is a no-op and
 * returns `{ copied: false, reason: "no-source" }`. Overwrite-safe (copyFile
 * truncates the destination).
 */
export async function portTranscript(args: {
  srcConfigDir: string;
  dstConfigDir: string;
  cwd: string;
  acpSessionId: string;
}): Promise<{ copied: boolean; reason?: string }> {
  const src = transcriptJsonlPath(args.srcConfigDir, args.cwd, args.acpSessionId);
  const dst = transcriptJsonlPath(args.dstConfigDir, args.cwd, args.acpSessionId);
  return await copyTranscriptFile(src, dst);
}

/**
 * Copy one transcript JSONL to another absolute path. Split out from
 * `portTranscript` so the recovery path can port from a source it has ALREADY
 * located — which may sit under the legacy slug — rather than re-deriving the
 * source path from a config dir and losing that.
 */
async function copyTranscriptFile(
  srcPath: string,
  dstPath: string,
): Promise<{ copied: boolean; reason?: string }> {
  if (srcPath === dstPath) {
    return { copied: false, reason: "same-dir" };
  }

  await mkdir(path.dirname(dstPath), { recursive: true });

  try {
    await copyFile(srcPath, dstPath);
  } catch (error) {
    if (isNotFound(error)) {
      return { copied: false, reason: "no-source" };
    }
    throw error;
  }

  return { copied: true };
}

/**
 * Resolve the config dir that a cold respawn will actively use for this record.
 * This mirrors subscription auth resolution for W3's scope: explicit
 * `session_options.subscription`, else registry default, else raw ~/.claude.
 */
export function activeTranscriptConfigDir(
  record: Pick<TranscriptBearingRecord, "acpx">,
  options?: SubscriptionLookupOptions & { registry?: SubscriptionRegistry },
): string {
  const homeDir = homeDirFromLookupOptions(options);
  const registry = registryFromLookupOptions(options);
  const explicit = subscriptionIdFromRecord(record);
  const choice = chooseSubscriptionConfigDir(explicit, registry, subscriptionConfigDirExists);
  return choice.configDir ?? rawClaudeConfigDir(homeDir);
}

/**
 * Known same-HOME Claude config dirs that may contain a stranded transcript.
 * W3 intentionally stops here: no cross-HOME/account re-anchoring and no
 * profile registry schema changes.
 */
export function knownTranscriptConfigDirs(
  options?: SubscriptionLookupOptions & {
    registry?: SubscriptionRegistry;
    activeConfigDir?: string;
  },
): string[] {
  const homeDir = homeDirFromLookupOptions(options);
  const registry = registryFromLookupOptions(options);
  const dirs = [
    options?.activeConfigDir,
    ...registry.subscriptions.map((entry) => entry.configDir),
    rawClaudeConfigDir(homeDir),
  ];
  return uniqueNonEmptyPaths(dirs);
}

export async function ensureTranscriptAtActiveConfigDir(
  record: TranscriptBearingRecord,
  options?: SubscriptionLookupOptions,
): Promise<TranscriptRecoveryResult> {
  const registry = loadSubscriptionRegistry(options);
  const activeConfigDir = activeTranscriptConfigDir(record, { ...options, registry });
  return await ensureTranscriptAtConfigDir(record, activeConfigDir, { ...options, registry });
}

/**
 * Ensure the config dir a cold respawn will resume from holds the *freshest*
 * transcript segment, not merely *a* segment.
 *
 * The original implementation short-circuited on destination *existence*: if any
 * file already sat at the destination it was kept as the resume source, even when
 * it was a days-stale copy frozen at the session's last stint on that account.
 * That is the context-rollback ("thrown back in time") root cause (RCA
 * brick://08ac840f): a switch/failover back onto a previously-used subscription
 * cold-resumed its frozen segment and the model re-did settled work.
 *
 * The selection is now by content freshness: probe every candidate's last-entry
 * timestamp and pick the newest. Candidates are the destination (if present),
 * then the explicit `sourceConfigDirs` (switch source), then the same-HOME known
 * config dirs — that order is also the tie-break (prefer the destination, then
 * explicit source order), which additionally fixes the missing-destination
 * registry-order port (RCA §2.5: port the freshest sibling, not the first in
 * registry order). When the freshest source differs from an existing
 * destination, the destination is renamed aside to a `.superseded-<ISO>.jsonl`
 * sidecar before porting — a post-rollback destination is a *divergent branch*
 * with unique content, never a prefix, so it must be preserved, never truncated.
 */
export async function ensureTranscriptAtConfigDir(
  record: TranscriptBearingRecord,
  dstConfigDir: string,
  options?: SubscriptionLookupOptions & {
    registry?: SubscriptionRegistry;
    sourceConfigDirs?: string[];
    /** Test seam into the dedup primitives (writer scan root, order trace). */
    dedupHooks?: DedupHooks;
  },
): Promise<TranscriptRecoveryResult> {
  const { cwd, acpSessionId } = record;
  const activePath = transcriptJsonlPath(dstConfigDir, cwd, acpSessionId);

  const { best, destProbe, searchedPaths } = await selectFreshestTranscript(
    record,
    dstConfigDir,
    options,
  );

  // Nothing anywhere (missing destination + no source segments): unchanged.
  if (!best) {
    return { status: "missing", activeConfigDir: dstConfigDir, activePath, searchedPaths };
  }

  // The freshest segment already IS the destination — resume as-is.
  if (best.isDest) {
    return { status: "already-present", activeConfigDir: dstConfigDir, activePath, searchedPaths };
  }

  return await portFreshestIntoDestination({
    record,
    dstConfigDir,
    activePath,
    best,
    destProbe,
    searchedPaths,
    hooks: options?.dedupHooks,
  });
}

async function portFreshestIntoDestination(args: {
  record: TranscriptBearingRecord;
  dstConfigDir: string;
  activePath: string;
  best: TranscriptCandidate;
  destProbe: TranscriptCandidate | undefined;
  searchedPaths: string[];
  hooks: DedupHooks | undefined;
}): Promise<TranscriptRecoveryResult> {
  const { record, dstConfigDir, activePath, best, destProbe, searchedPaths } = args;
  const { cwd, acpSessionId } = record;
  // Port from the path we ACTUALLY found, not from a re-derivation of it: the
  // chosen source may sit under the legacy slug, and the destination is always
  // the primary form — which is what makes this a migration rather than a
  // permanent second home.
  if (best.slugForm === "legacy") {
    logLegacyTranscriptSlugHit({
      acpSessionId,
      cwd,
      legacyPath: best.jsonlPath,
      primaryPath: transcriptJsonlPath(best.configDir, cwd, acpSessionId),
    });
  }
  const placed = await placeFreshestCopy(best.jsonlPath, activePath, Boolean(destProbe));
  if (placed.status === "source-vanished") {
    // The source vanished between probe and copy. Copy-first means the destination
    // was never touched, so whatever sits there is still what a resume reads.
    return {
      status: (await fileExists(activePath)) ? "already-present" : "missing",
      activeConfigDir: dstConfigDir,
      activePath,
      searchedPaths,
    };
  }
  const superseded = placed.sidecar
    ? await disposeSupersededSidecar(placed.sidecar, activePath, args.hooks)
    : undefined;

  logTranscriptPortDecision({
    acpSessionId,
    activePath,
    chosenSource: best.jsonlPath,
    dstLastEntry: destProbe?.freshness.iso,
    srcLastEntry: best.freshness.iso,
    srcSlugForm: best.slugForm,
    sidecar: placed.sidecar,
    superseded,
  });

  return {
    status: "ported",
    activeConfigDir: dstConfigDir,
    activePath,
    sourceConfigDir: best.configDir,
    sourcePath: best.jsonlPath,
    searchedPaths,
    ...supersededResultFields(placed.sidecar, superseded),
  };
}

function supersededResultFields(
  sidecar: string | undefined,
  superseded: SupersededOutcome | undefined,
): Pick<
  Extract<TranscriptRecoveryResult, { status: "ported" }>,
  "supersededPath" | "supersededDisposition" | "exitTailPath"
> {
  if (!sidecar || !superseded) {
    return {};
  }
  return {
    ...(superseded.disposition === "kept" ? { supersededPath: sidecar } : {}),
    supersededDisposition: superseded.disposition,
    ...(superseded.exitTailPath ? { exitTailPath: superseded.exitTailPath } : {}),
  };
}

/**
 * D1 (brick 81433524) — COPY FIRST, then swap. The freshest source is copied to a
 * private temp beside the destination (`<id>.jsonl.acpx-port-<pid>-<rand>.tmp`: not
 * `*.jsonl`, so no probe or scanner ever sees it); only then is an existing
 * destination renamed aside and the temp renamed in. The destination path is empty
 * for the µs between two renames instead of for the whole copy, and a failed copy
 * (ENOSPC) leaves the destination where it was instead of renamed away.
 *
 * No fsync here on purpose: durability matters only before a REMOVAL, and the
 * primitives do it there (the witness is fdatasync'ed before any unlink). A crash
 * that loses the rename still leaves every byte in the source, which this port never
 * touches; the next connect re-ports.
 */
async function placeFreshestCopy(
  sourcePath: string,
  activePath: string,
  destinationExists: boolean,
): Promise<{ status: "placed"; sidecar?: string } | { status: "source-vanished" }> {
  await mkdir(path.dirname(activePath), { recursive: true });
  const temp = `${activePath}.acpx-port-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    await copyFile(sourcePath, temp);
    const sidecar = destinationExists
      ? await renameDestinationAside(activePath, path.basename(activePath, ".jsonl"))
      : undefined;
    await rename(temp, activePath);
    return { status: "placed", sidecar };
  } catch (error) {
    if (isNotFound(error) && !(await fileExists(temp))) {
      return { status: "source-vanished" };
    }
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

type SupersededOutcome = {
  disposition: "deleted" | "reduced" | "kept";
  reason?: string;
  bytes: number;
  exitTailPath?: string;
};

/**
 * The sidecar is PRIVATE (nobody writes by that name) and the canonical path already
 * holds the new copy, so it can be proven against the active copy right away: a
 * byte-prefix is deleted, a prefix + exit block is reduced (Option T), anything else
 * stays exactly as before — same name, same place.
 */
async function disposeSupersededSidecar(
  sidecar: string,
  activePath: string,
  hooks: DedupHooks | undefined,
): Promise<SupersededOutcome> {
  const { outcome, reasons } = await removeRedundantCopy(sidecar, activePath, {
    reducedBy: "port",
    hooks,
  });
  if (outcome.action === "removed") {
    return { disposition: "deleted", bytes: outcome.bytes };
  }
  if (outcome.action === "reduced") {
    return { disposition: "reduced", bytes: outcome.bytes, exitTailPath: outcome.tailFile };
  }
  const bytes = await stat(sidecar)
    .then((info) => info.size)
    .catch(() => 0);
  return { disposition: "kept", reason: reasons.join("+"), bytes };
}

/**
 * Probe every candidate config dir (destination first, then explicit switch
 * sources, then same-HOME known dirs) and return the freshest existing segment,
 * the destination's own probe (if it exists), and the searched source paths.
 *
 * The candidate ordering IS the tie-break: a candidate replaces the best only
 * when *strictly* newer, so equal timestamps keep whichever came first
 * (destination, then explicit source order, then registry order).
 */
export async function selectFreshestTranscript(
  record: TranscriptBearingRecord,
  dstConfigDir: string,
  options?: SubscriptionLookupOptions & {
    registry?: SubscriptionRegistry;
    sourceConfigDirs?: string[];
  },
): Promise<{
  best: TranscriptCandidate | undefined;
  destProbe: TranscriptCandidate | undefined;
  searchedPaths: string[];
  /** Every existing canonical copy probed, both slug forms, in probe order. */
  candidates: TranscriptCandidate[];
}> {
  const { cwd, acpSessionId } = record;
  const resolvedDst = path.resolve(dstConfigDir);
  const orderedConfigDirs = candidateConfigDirs(dstConfigDir, options);

  const candidates: TranscriptCandidate[] = [];
  const searchedPaths: string[] = [];
  let best: TranscriptCandidate | undefined;
  let destProbe: TranscriptCandidate | undefined;
  for (const configDir of orderedConfigDirs) {
    const probed = await probeConfigDirSlugForms({
      acpSessionId,
      configDir,
      cwd,
      isDestDir: path.resolve(configDir) === resolvedDst,
    });
    searchedPaths.push(...probed.searchedPaths);
    for (const candidate of probed.candidates) {
      candidates.push(candidate);
      if (candidate.isDest) {
        destProbe = candidate;
      }
      if (!best || isFresherCandidate(candidate, best)) {
        best = candidate;
      }
    }
  }
  return { best, destProbe, searchedPaths, candidates };
}

/**
 * D4 (brick 81433524): a candidate with NO timestamped entry at all ranks below
 * every candidate that has one. Such a file is not a conversation — it is a
 * metadata-only fragment, which only a writer that outlived the removal of its file
 * can create (Claude Code's exit re-stamp appends by PATH and creates a missing
 * file). Its mtime is "now", so under the old mtime fallback it beat the real active
 * copy at the next connect, the port renamed the active copy aside, and the session
 * resumed with no conversation. Among `none` candidates the old order still applies.
 *
 * ⚠️ DO NOT FOLD `none` BACK INTO THE MTIME FALLBACK. It looks like a simplification
 * and it re-opens exactly that fragment race for every remover (D1, D2, the verb).
 * `test/subscription-transcript.test.ts` pins it ("metadata-only fragment never
 * wins").
 */
function isFresherCandidate(candidate: TranscriptCandidate, best: TranscriptCandidate): boolean {
  const candidateHasEntry = candidate.freshness.basis !== "none";
  const bestHasEntry = best.freshness.basis !== "none";
  if (candidateHasEntry !== bestHasEntry) {
    return candidateHasEntry;
  }
  return candidate.freshness.ms > best.freshness.ms;
}

/**
 * Probe one config dir under BOTH slug forms, primary first.
 *
 * The legacy form is skipped when it is the same string as the primary — for a
 * cwd of plain `[A-Za-z0-9/-]` the two derivations agree, which is why this bug
 * was invisible for most sessions.
 *
 * A legacy file is NEVER reported as `isDest`, even inside the destination
 * config dir. That is deliberate: Claude Code reads only the primary path, so a
 * legacy-named file at the destination is not "already present" — it is a
 * stranded source. Treating it as a source is exactly what makes the next switch
 * copy it onto the primary path and migrate the session.
 */
async function probeConfigDirSlugForms(args: {
  acpSessionId: string;
  configDir: string;
  cwd: string;
  isDestDir: boolean;
}): Promise<{ candidates: TranscriptCandidate[]; searchedPaths: string[] }> {
  const { acpSessionId, configDir, cwd, isDestDir } = args;
  const primaryPath = transcriptJsonlPath(configDir, cwd, acpSessionId);
  const legacyPath = legacyTranscriptJsonlPath(configDir, cwd, acpSessionId);

  const forms: Array<{ form: TranscriptSlugForm; isDest: boolean; jsonlPath: string }> = [
    { form: "primary", isDest: isDestDir, jsonlPath: primaryPath },
  ];
  if (legacyPath !== primaryPath) {
    forms.push({ form: "legacy", isDest: false, jsonlPath: legacyPath });
  }

  const candidates: TranscriptCandidate[] = [];
  const searchedPaths: string[] = [];
  for (const entry of forms) {
    if (!entry.isDest) {
      searchedPaths.push(entry.jsonlPath);
    }
    const candidate = await probeTranscriptCandidate(
      entry.jsonlPath,
      configDir,
      entry.isDest,
      entry.form,
    );
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return { candidates, searchedPaths };
}

function candidateConfigDirs(
  dstConfigDir: string,
  options?: SubscriptionLookupOptions & {
    registry?: SubscriptionRegistry;
    sourceConfigDirs?: string[];
  },
): string[] {
  return uniqueNonEmptyPaths([
    dstConfigDir,
    ...(options?.sourceConfigDirs ?? []),
    ...knownTranscriptConfigDirs({ ...options, activeConfigDir: dstConfigDir }),
  ]);
}

async function probeTranscriptCandidate(
  jsonlPath: string,
  configDir: string,
  isDest: boolean,
  slugForm: TranscriptSlugForm,
): Promise<TranscriptCandidate | undefined> {
  if (!(await fileExists(jsonlPath))) {
    return undefined;
  }
  const freshness = await lastEntryTimestamp(jsonlPath);
  return { configDir, jsonlPath, isDest, freshness, slugForm };
}

type FreshnessProbe = {
  /** Epoch milliseconds used for comparison (content `.timestamp`, else fs mtime). */
  ms: number;
  /** Human-readable form of the chosen instant, for the observability breadcrumb. */
  iso: string;
  /**
   * Which signal supplied `ms`. `none`: the WHOLE file was scanned and holds no
   * timestamped entry (`ms` is then the mtime, used only among `none` candidates).
   * `mtime`: the scan hit its cap before finding one — today's fallback, kept.
   */
  basis: "content" | "mtime" | "none";
};

export type TranscriptCandidate = {
  configDir: string;
  jsonlPath: string;
  isDest: boolean;
  freshness: FreshnessProbe;
  /** Which slug form located this file — `legacy` is a migration source. */
  slugForm: TranscriptSlugForm;
};

const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
const TRANSCRIPT_BACKSCAN_WINDOW_BYTES = 1024 * 1024;
const TRANSCRIPT_BACKSCAN_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Freshness of a transcript JSONL, measured by CONTENT — the `.timestamp` of the
 * last complete JSONL entry — falling back to fs mtime only when unparseable.
 *
 * mtime alone is unsafe: `copyFile` stamps copy-time, so a stale-content copy
 * looks mtime-fresh (that is precisely how the rollback bug hid). Reading the
 * last real entry's timestamp compares the segments by actual conversation
 * progress instead.
 *
 * D4: the last 64 KiB first, then back in 1 MiB windows up to 16 MiB, so a single
 * huge last line no longer drops a real conversation to mtime. A file scanned to
 * byte 0 without a timestamped entry is `none` (see `isFresherCandidate`); a scan
 * that hits the 16 MiB cap first keeps today's mtime basis — never worse than
 * before for a conversation whose last line is longer than the cap.
 */
async function lastEntryTimestamp(filePath: string): Promise<FreshnessProbe> {
  const content = await contentTimestampFromTail(filePath);
  if (content.found) {
    return { ms: content.found.ms, iso: content.found.iso, basis: "content" };
  }
  const info = await stat(filePath);
  return {
    ms: info.mtimeMs,
    iso: new Date(info.mtimeMs).toISOString(),
    basis: content.exhausted ? "none" : "mtime",
  };
}

async function contentTimestampFromTail(filePath: string): Promise<{
  found?: { ms: number; iso: string };
  exhausted: boolean;
}> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let end = size;
    let carry: Buffer = Buffer.alloc(0);
    let scanned = 0;
    let windowBytes = TRANSCRIPT_TAIL_BYTES;
    while (end > 0 && scanned < TRANSCRIPT_BACKSCAN_MAX_BYTES) {
      const length = Math.min(windowBytes, end, TRANSCRIPT_BACKSCAN_MAX_BYTES - scanned);
      const start = end - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const window = splitCompleteLines(Buffer.concat([buffer, carry]), start > 0);
      carry = window.carry;
      const found = lastTimestampInLines(window.lines);
      if (found) {
        return { found, exhausted: false };
      }
      end = start;
      scanned += length;
      windowBytes = TRANSCRIPT_BACKSCAN_WINDOW_BYTES;
    }
    return { exhausted: end === 0 };
  } finally {
    await handle.close();
  }
}

/**
 * When the window did not start at byte 0, its first line is a partial (the entry
 * began before the window): keep those bytes as the carry for the next window back.
 */
function splitCompleteLines(
  chunk: Buffer,
  startsMidFile: boolean,
): { lines: string[]; carry: Buffer } {
  if (!startsMidFile) {
    return { lines: chunk.toString("utf8").split("\n"), carry: Buffer.alloc(0) };
  }
  const firstNewline = chunk.indexOf(0x0a);
  if (firstNewline < 0) {
    return { lines: [], carry: chunk };
  }
  return {
    lines: chunk
      .subarray(firstNewline + 1)
      .toString("utf8")
      .split("\n"),
    carry: chunk.subarray(0, firstNewline),
  };
}

/** Walk backwards over trailing blank / unparseable lines to the last timestamped entry. */
function lastTimestampInLines(lines: string[]): { ms: number; iso: string } | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    const parsed = timestampFromJsonlLine(line);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function timestampFromJsonlLine(line: string): { ms: number; iso: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const timestamp = (parsed as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return { ms: timestamp, iso: new Date(timestamp).toISOString() };
  }
  if (typeof timestamp === "string") {
    const ms = Date.parse(timestamp);
    if (!Number.isNaN(ms)) {
      return { ms, iso: timestamp };
    }
  }
  return undefined;
}

/**
 * Rename an existing destination transcript aside to a
 * `<acpSessionId>.superseded-<ISO>.jsonl` sidecar in the same dir, so its
 * divergent branch is preserved (never truncated) before a fresher source ports
 * over it. Uses a filesystem-safe ISO (colons replaced) and disambiguates a
 * same-instant collision. Returns the sidecar path.
 */
async function renameDestinationAside(activePath: string, acpSessionId: string): Promise<string> {
  const dir = path.dirname(activePath);
  const stamp = new Date().toISOString().replace(/:/g, "-");
  let target = path.join(dir, `${acpSessionId}.superseded-${stamp}.jsonl`);
  let suffix = 1;
  while (await fileExists(target)) {
    target = path.join(dir, `${acpSessionId}.superseded-${stamp}-${suffix}.jsonl`);
    suffix += 1;
  }
  await rename(activePath, target);
  return target;
}

/**
 * Emit one stderr breadcrumb per switch-time transcript port, so a transcript
 * movement (and especially a superseded stale destination) is visible instead of
 * silent — the previous `transcriptCopied:false` carried no reason. stderr is
 * acpx's runtime log channel (matches `logTranscriptRecovery` in reconnect.ts).
 */
function logTranscriptPortDecision(info: {
  acpSessionId: string;
  activePath: string;
  chosenSource: string;
  dstLastEntry?: string;
  srcLastEntry?: string;
  srcSlugForm: TranscriptSlugForm;
  sidecar?: string;
  superseded?: SupersededOutcome;
}): void {
  // `decision=ported-superseded` still means "a sidecar was created" and
  // `superseded=` still names it; the disposition keys say what became of it.
  const decision = info.sidecar ? "ported-superseded" : "ported";
  const superseded = info.sidecar ? ` superseded=${info.sidecar}` : "";
  process.stderr.write(
    `[acpx] transcript-port session=${info.acpSessionId} decision=${decision} ` +
      `dst=${info.activePath} chosenSource=${info.chosenSource} ` +
      `srcSlugForm=${info.srcSlugForm} ` +
      `dstLastEntry=${info.dstLastEntry ?? "none"} srcLastEntry=${info.srcLastEntry ?? "none"}` +
      `${superseded}${formatSupersededDisposition(info.superseded)}\n`,
  );
}

function formatSupersededDisposition(outcome: SupersededOutcome | undefined): string {
  if (!outcome) {
    return "";
  }
  const reason = outcome.reason ? ` supersededReason=${outcome.reason}` : "";
  const exitTail = outcome.exitTailPath ? ` exitTail=${outcome.exitTailPath}` : "";
  return (
    ` supersededDisposition=${outcome.disposition}${reason}` +
    ` supersededBytes=${outcome.bytes}${exitTail}`
  );
}

/**
 * Emit one stderr breadcrumb whenever a transcript was found ONLY under the
 * pre-fix slug (brick://ae715773).
 *
 * Rider 1 of the fix charter: an unobservable fallback becomes permanent. Same
 * `[acpx] ` stderr idiom as `logTranscriptPortDecision` above and
 * `logTranscriptRecovery` in reconnect.ts.
 *
 * ⚠️ Read a line here as a SURPRISE, not as migration progress. Per
 * `legacyTranscriptCwdHash`'s removal criterion, no stranded legacy-form
 * directory should exist on this box at all — so if one of these ever fires,
 * something outside the model that predicted zero has happened (a transcript
 * tree from another acpx build, or one carried across boxes) and is worth
 * understanding rather than merely counting. Correspondingly, the ABSENCE of
 * these lines is not evidence the fallback can be deleted.
 *
 * Grep the fleet with: `transcript-slug-legacy-hit`
 */
function logLegacyTranscriptSlugHit(info: {
  acpSessionId: string;
  cwd: string;
  legacyPath: string;
  primaryPath: string;
}): void {
  process.stderr.write(
    `[acpx] transcript-slug-legacy-hit session=${info.acpSessionId} cwd=${info.cwd} ` +
      `resolved=${info.legacyPath} primaryMissing=${info.primaryPath}\n`,
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function rawClaudeConfigDir(homeDir: string): string {
  return path.join(homeDir, ".claude");
}

function homeDirFromLookupOptions(options: SubscriptionLookupOptions | undefined): string {
  return options?.homeDir ?? os.homedir();
}

function registryFromLookupOptions(
  options: (SubscriptionLookupOptions & { registry?: SubscriptionRegistry }) | undefined,
): SubscriptionRegistry {
  return options?.registry ?? loadSubscriptionRegistry(options);
}

// Resolve the session's UNIFIED account-selection id — the id the adapter feeds
// into chooseSubscriptionConfigDir to set CLAUDE_CONFIG_DIR. The CLI folds
// `--subscription` into the unified `session_options.profile` slot for MOST
// sessions (fleet: ~1655 store the sub in `.profile` vs ~62 in `.subscription`),
// and `applyProfileAuth` (auth-env.ts) resolves a subscription-authMode profile by
// calling `applySubscriptionConfigDir` with the PROFILE id — i.e. it feeds
// `.profile` into the SAME `chooseSubscriptionConfigDir` this transcript resolver
// uses. Reading `.subscription` ALONE therefore mis-resolved the transcript dir
// for the profile-based majority (brick://07dd62c9 F#4): served-capture read the
// wrong account's transcript → served never stamped → a --floor-hard CE on a
// non-default sub was silently accepted. It ALSO latently broke
// brick://08ac840f's transcript-porting for those sessions (ported to the default
// sub dir while the adapter resumed from the profile's dir → context rollback).
// Prefer `.profile` (canonical; matches the adapter's precedence — it uses
// profileId when present). Validation is inherent: chooseSubscriptionConfigDir
// looks the id up in the subscription registry, so a non-subscription profile id
// finds no dir and falls back exactly as an unknown sub did before.
export function subscriptionIdFromRecord(
  record: Pick<TranscriptBearingRecord, "acpx">,
): string | undefined {
  const options = record.acpx?.session_options;
  return nonEmptyTrimmed(options?.profile) ?? nonEmptyTrimmed(options?.subscription);
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueNonEmptyPaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    if (!candidate) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}
