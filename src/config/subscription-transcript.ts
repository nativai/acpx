import { access, copyFile, mkdir, open, rename, stat } from "node:fs/promises";
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
 * Derive the per-cwd directory segment Claude uses under `projects/`. This is
 * the single source of truth for the layout acpx already hard-codes in
 * `src/cli/session/runtime.ts` (claudeSubagentDir) — keep them in lockstep.
 */
export function transcriptCwdHash(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Absolute path to a session's transcript JSONL inside a given CLAUDE_CONFIG_DIR.
 * Layout: <configDir>/projects/<cwdHash>/<acpSessionId>.jsonl (the `<acpSessionId>/`
 * dir holding `subagents/` is a sibling and is NOT load-bearing for top-level
 * resume).
 */
export function transcriptJsonlPath(configDir: string, cwd: string, acpSessionId: string): string {
  return path.join(configDir, "projects", transcriptCwdHash(cwd), `${acpSessionId}.jsonl`);
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
       * was renamed aside before porting, the path of that preserved sidecar.
       * Absent when the destination was missing (nothing to supersede).
       */
      supersededPath?: string;
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

  if (src === dst) {
    return { copied: false, reason: "same-dir" };
  }

  await mkdir(path.dirname(dst), { recursive: true });

  try {
    await copyFile(src, dst);
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

  // A source is fresher. Preserve any existing (staler / divergent) destination
  // aside before overwriting it, then port the freshest source in.
  const supersededPath = destProbe
    ? await renameDestinationAside(activePath, acpSessionId)
    : undefined;

  const ported = await portTranscript({
    srcConfigDir: best.configDir,
    dstConfigDir,
    cwd,
    acpSessionId,
  });
  if (!ported.copied && !(await fileExists(activePath))) {
    // Source vanished between probe and copy — the aside sidecar (if any) still
    // preserves the destination's branch; report missing so callers can react.
    return { status: "missing", activeConfigDir: dstConfigDir, activePath, searchedPaths };
  }

  logTranscriptPortDecision({
    acpSessionId,
    activePath,
    chosenSource: best.jsonlPath,
    dstLastEntry: destProbe?.freshness.iso,
    srcLastEntry: best.freshness.iso,
    supersededPath,
  });

  return {
    status: "ported",
    activeConfigDir: dstConfigDir,
    activePath,
    sourceConfigDir: best.configDir,
    sourcePath: best.jsonlPath,
    searchedPaths,
    supersededPath,
  };
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
async function selectFreshestTranscript(
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
}> {
  const { cwd, acpSessionId } = record;
  const resolvedDst = path.resolve(dstConfigDir);
  const orderedConfigDirs = candidateConfigDirs(dstConfigDir, options);

  const searchedPaths: string[] = [];
  let best: TranscriptCandidate | undefined;
  let destProbe: TranscriptCandidate | undefined;
  for (const configDir of orderedConfigDirs) {
    const isDest = path.resolve(configDir) === resolvedDst;
    const jsonlPath = transcriptJsonlPath(configDir, cwd, acpSessionId);
    if (!isDest) {
      searchedPaths.push(jsonlPath);
    }
    const candidate = await probeTranscriptCandidate(jsonlPath, configDir, isDest);
    if (!candidate) {
      continue;
    }
    if (isDest) {
      destProbe = candidate;
    }
    if (!best || candidate.freshness.ms > best.freshness.ms) {
      best = candidate;
    }
  }
  return { best, destProbe, searchedPaths };
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
): Promise<TranscriptCandidate | undefined> {
  if (!(await fileExists(jsonlPath))) {
    return undefined;
  }
  const freshness = await lastEntryTimestamp(jsonlPath);
  return { configDir, jsonlPath, isDest, freshness };
}

type FreshnessProbe = {
  /** Epoch milliseconds used for comparison (content `.timestamp`, else fs mtime). */
  ms: number;
  /** Human-readable form of the chosen instant, for the observability breadcrumb. */
  iso: string;
  /** Which signal supplied `ms`. */
  basis: "content" | "mtime";
};

type TranscriptCandidate = {
  configDir: string;
  jsonlPath: string;
  isDest: boolean;
  freshness: FreshnessProbe;
};

const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/**
 * Freshness of a transcript JSONL, measured by CONTENT — the `.timestamp` of the
 * last complete JSONL entry — falling back to fs mtime only when unparseable.
 *
 * mtime alone is unsafe: `copyFile` stamps copy-time, so a stale-content copy
 * looks mtime-fresh (that is precisely how the rollback bug hid). Reading the
 * last real entry's timestamp compares the segments by actual conversation
 * progress instead.
 */
async function lastEntryTimestamp(filePath: string): Promise<FreshnessProbe> {
  const content = await contentTimestampFromTail(filePath);
  if (content) {
    return { ms: content.ms, iso: content.iso, basis: "content" };
  }
  const info = await stat(filePath);
  return { ms: info.mtimeMs, iso: new Date(info.mtimeMs).toISOString(), basis: "mtime" };
}

async function contentTimestampFromTail(
  filePath: string,
): Promise<{ ms: number; iso: string } | undefined> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return undefined;
    }
    const readLen = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const start = size - readLen;
    const buffer = Buffer.alloc(readLen);
    await handle.read(buffer, 0, readLen, start);
    let text = buffer.toString("utf8");
    // If the window did not start at byte 0 its first line is a truncated
    // partial (the entry began before the window) — drop it.
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    const lines = text.split("\n");
    // Walk backwards over trailing blank / unparseable lines to the last real entry.
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
  } finally {
    await handle.close();
  }
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
  supersededPath?: string;
}): void {
  const decision = info.supersededPath ? "ported-superseded" : "ported";
  const superseded = info.supersededPath ? ` superseded=${info.supersededPath}` : "";
  process.stderr.write(
    `[acpx] transcript-port session=${info.acpSessionId} decision=${decision} ` +
      `dst=${info.activePath} chosenSource=${info.chosenSource} ` +
      `dstLastEntry=${info.dstLastEntry ?? "none"} srcLastEntry=${info.srcLastEntry ?? "none"}` +
      `${superseded}\n`,
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

function subscriptionIdFromRecord(
  record: Pick<TranscriptBearingRecord, "acpx">,
): string | undefined {
  const subscription = record.acpx?.session_options?.subscription;
  if (typeof subscription !== "string") {
    return undefined;
  }
  const trimmed = subscription.trim();
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
