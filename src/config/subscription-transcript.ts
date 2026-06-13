import { access, copyFile, mkdir } from "node:fs/promises";
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

export async function ensureTranscriptAtConfigDir(
  record: TranscriptBearingRecord,
  dstConfigDir: string,
  options?: SubscriptionLookupOptions & {
    registry?: SubscriptionRegistry;
    sourceConfigDirs?: string[];
  },
): Promise<TranscriptRecoveryResult> {
  const activePath = transcriptJsonlPath(dstConfigDir, record.cwd, record.acpSessionId);
  if (await fileExists(activePath)) {
    return {
      status: "already-present",
      activeConfigDir: dstConfigDir,
      activePath,
      searchedPaths: [],
    };
  }

  const sourceConfigDirs = uniqueNonEmptyPaths([
    ...(options?.sourceConfigDirs ?? []),
    ...knownTranscriptConfigDirs({ ...options, activeConfigDir: dstConfigDir }),
  ]);
  const searchedPaths: string[] = [];
  for (const sourceConfigDir of sourceConfigDirs) {
    const ported = await tryPortTranscriptFromConfigDir({
      record,
      sourceConfigDir,
      dstConfigDir,
      activePath,
      searchedPaths,
    });
    if (ported) {
      return ported;
    }
  }

  return {
    status: "missing",
    activeConfigDir: dstConfigDir,
    activePath,
    searchedPaths,
  };
}

async function tryPortTranscriptFromConfigDir(args: {
  record: TranscriptBearingRecord;
  sourceConfigDir: string;
  dstConfigDir: string;
  activePath: string;
  searchedPaths: string[];
}): Promise<Extract<TranscriptRecoveryResult, { status: "ported" }> | undefined> {
  const sourcePath = transcriptJsonlPath(
    args.sourceConfigDir,
    args.record.cwd,
    args.record.acpSessionId,
  );
  if (sourcePath === args.activePath) {
    return undefined;
  }
  args.searchedPaths.push(sourcePath);
  if (!(await fileExists(sourcePath))) {
    return undefined;
  }
  const result = await portTranscript({
    srcConfigDir: args.sourceConfigDir,
    dstConfigDir: args.dstConfigDir,
    cwd: args.record.cwd,
    acpSessionId: args.record.acpSessionId,
  });
  if (!result.copied && !(await fileExists(args.activePath))) {
    return undefined;
  }
  return {
    status: "ported",
    activeConfigDir: args.dstConfigDir,
    activePath: args.activePath,
    sourceConfigDir: args.sourceConfigDir,
    sourcePath,
    searchedPaths: args.searchedPaths,
  };
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
