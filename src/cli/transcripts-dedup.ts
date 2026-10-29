import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activeTranscriptConfigDir,
  transcriptJsonlPath,
} from "../config/subscription-transcript.js";
import { loadSubscriptionRegistry, type SubscriptionRegistry } from "../config/subscriptions.js";
import {
  classifyAgainstWitness,
  estimateExitTailFileBytes,
  isExitTailFileName,
  proveRedundantAndUnlink,
  readAt,
  readExitTailFile,
  reduceToExitTail,
  sessionIdFromTranscriptName,
  type DedupHooks,
  type DedupOutcome,
  type ExitTailHeader,
} from "../config/transcript-dedup.js";
import { isRecordedPidPossiblyAlive } from "../process-identity.js";
import { sessionArchiveDirFor } from "../session/archive/paths.js";
import { parseSessionRecord } from "../session/persistence.js";
import type { SessionRecord } from "../types.js";
import { readQueueOwnerLiveness } from "./queue/lease-store.js";
import { isOwnerPossiblyAlive } from "./session/session-control.js";

// `acpx transcripts dedup` / `acpx transcripts restore` (brick 81433524, CONCEPTION
// §5). The planner and apply for the duplicates that already exist on a box. The
// removals themselves are the shared proofs in `config/transcript-dedup.ts`, which
// re-verify every file through its fds right before the unlink.
//
// ⚠️ NEVER ON A SCHEDULE. This module is imported ONLY by `transcripts-command.ts`
// (dynamically, inside the action), which is registered only by
// `registerDefaultCommands`. No timer, hook or other code path may call it: the
// automatic paths (the port, the owner exit) share only the primitives.
// `test/transcripts-dedup.test.ts` pins the import graph.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL_RE = new RegExp(`^(${UUID})\\.jsonl$`);
const SIDECAR_RE = new RegExp(`^(${UUID})\\.superseded-.+\\.jsonl$`);
const PORT_TEMP_RE = new RegExp(`^(${UUID})\\.jsonl\\.acpx-port-\\d+-[0-9a-f]+\\.tmp$`);
const ACP_SESSION_ID_RE = /"acp_session_id"\s*:\s*"([^"]+)"/;

/** A copy written within this window means a writer may still be around: the id is skipped. */
export const DEDUP_RECENT_MS = 60 * 60_000;
/** A D1 port temp younger than this may belong to a port in flight: never touched. */
export const ORPHAN_TEMP_MIN_AGE_MS = 60 * 60_000;
const RECORD_HEAD_BYTES = 16 * 1024;

type CopyKind = "canonical" | "sidecar";

export type TranscriptCopy = {
  path: string;
  sessionId: string;
  kind: CopyKind;
  size: number;
  mtimeMs: number;
};

type SessionFiles = {
  sessionId: string;
  copies: TranscriptCopy[];
  temps: TranscriptCopy[];
  tailFiles: string[];
};

type ScanResult = {
  sessions: Map<string, SessionFiles>;
  existingTailFiles: { count: number; bytes: number };
};

export type KeepCategory = "active" | "branch" | "exit-block-not-eligible" | "other";
export type SkipReason = "live-owner" | "live-pid" | "recent" | "ambiguous";

export type DedupAction = {
  action: "delete" | "reduce";
  sessionId: string;
  path: string;
  bytes: number;
  witness: string;
  sha256: string;
  prefixBytes?: number;
  tailBytes?: number;
  /** Planned: the estimated size of the tail file; applied: the bytes actually written (0 if reused). */
  tailFileBytes?: number;
  tailFile?: string;
  orphanTemp?: boolean;
};

export type DedupReport = {
  mode: "apply" | "dry-run";
  box: string;
  generatedAt: string;
  ids: number;
  copies: number;
  actions: DedupAction[];
  keptByReason: Record<KeepCategory, number>;
  /** Files reported KEPT individually: apply re-verification failures and orphan temps. */
  keptFiles: Array<{ path: string; reason: string }>;
  skippedIds: Array<{ sessionId: string; reason: SkipReason }>;
  recheckFailed: number;
  existingTailFiles: { count: number; bytes: number };
};

export type DedupDeps = {
  /** Is a queue owner of this acpx record possibly alive? */
  ownerPossiblyAlive: (acpxRecordId: string) => Promise<boolean>;
};

export type DedupOptions = {
  apply: boolean;
  manifest?: string;
  sessions?: string[];
  stateHome?: string;
  userHome?: string;
  now?: () => number;
  deps?: Partial<DedupDeps>;
  /** Test seams: `afterPlan` runs between the plan and the first act; `dedup` reaches the proofs. */
  hooks?: { afterPlan?: () => Promise<void> | void; dedup?: DedupHooks };
};

export class TranscriptsUsageError extends Error {}

type Homes = { stateHome: string; userHome: string };

type DedupContext = {
  homes: Homes;
  registry: SubscriptionRegistry;
  now: () => number;
  deps: DedupDeps;
  recordIndex: RecordIndex;
};

type SessionPlan = { sessionId: string; actions: DedupAction[] };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runTranscriptsDedup(options: DedupOptions): Promise<DedupReport> {
  const manifest = applyManifest(options);
  const homes = resolveHomes(options);
  const now = options.now ?? Date.now;
  const scan = await scanTranscriptRoots(await transcriptRoots(homes));
  const groups = selectGroups(scan, options.sessions, now());
  const context = await createContext(homes, now, groups, options.deps);
  const report = emptyReport(manifest ? "apply" : "dry-run", scan, groups);
  const plans = await planGroups(groups, context, report);
  if (!manifest) {
    report.actions = plans.flatMap((plan) => plan.actions);
    return report;
  }
  const hooks = options.hooks ?? {};
  await hooks.afterPlan?.();
  await applyPlans(plans, groups, context, { manifest, hooks: hooks.dedup }, report);
  return report;
}

/** The manifest an `--apply` run writes to; undefined for a dry run. `--apply` without one is refused. */
function applyManifest(options: DedupOptions): string | undefined {
  if (!options.apply) {
    return undefined;
  }
  if (!options.manifest) {
    throw new TranscriptsUsageError(
      "acpx transcripts dedup: --apply requires --manifest <file> (nothing was changed)",
    );
  }
  return options.manifest;
}

async function createContext(
  homes: Homes,
  now: () => number,
  groups: Map<string, SessionFiles>,
  deps: Partial<DedupDeps> | undefined,
): Promise<DedupContext> {
  return {
    homes,
    registry: loadSubscriptionRegistry({ homeDir: homes.stateHome }),
    now,
    deps: { ownerPossiblyAlive: defaultOwnerPossiblyAlive, ...deps },
    recordIndex: await indexRecordFiles(new Set(groups.keys()), homes),
  };
}

function resolveHomes(options: { stateHome?: string; userHome?: string }): Homes {
  return {
    stateHome: options.stateHome ?? (process.env.ACPX_STATE_HOME || os.homedir()),
    userHome: options.userHome ?? os.homedir(),
  };
}

async function defaultOwnerPossiblyAlive(acpxRecordId: string): Promise<boolean> {
  try {
    return isOwnerPossiblyAlive(await readQueueOwnerLiveness(acpxRecordId));
  } catch {
    // Unreadable lease state is not evidence of absence.
    return true;
  }
}

function emptyReport(
  mode: DedupReport["mode"],
  scan: ScanResult,
  groups: Map<string, SessionFiles>,
): DedupReport {
  let copies = 0;
  for (const group of groups.values()) {
    copies += group.copies.length;
  }
  return {
    mode,
    box: os.hostname(),
    generatedAt: new Date().toISOString(),
    ids: groups.size,
    copies,
    actions: [],
    keptByReason: { active: 0, branch: 0, "exit-block-not-eligible": 0, other: 0 },
    keptFiles: [],
    skippedIds: [],
    recheckFailed: 0,
    existingTailFiles: scan.existingTailFiles,
  };
}

// ---------------------------------------------------------------------------
// Scan: the filesystem, not the registry (§5.2)
// ---------------------------------------------------------------------------

/**
 * Every Claude config dir on this HOME: each `~/.acpx/subscriptions/*` (registered,
 * quarantined, unregistered like `sub4`, `or-*`), its `.claude` bridge dir, and raw
 * `~/.claude`.
 */
export async function transcriptRoots(homes: Homes): Promise<string[]> {
  const subscriptions = path.join(homes.stateHome, ".acpx", "subscriptions");
  const entries = await readDirents(subscriptions);
  const roots = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [
      path.join(subscriptions, entry.name),
      path.join(subscriptions, entry.name, ".claude"),
    ]);
  roots.push(path.join(homes.userHome, ".claude"), path.join(homes.stateHome, ".claude"));
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function readDirents(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function scanTranscriptRoots(roots: string[]): Promise<ScanResult> {
  const result: ScanResult = { sessions: new Map(), existingTailFiles: { count: 0, bytes: 0 } };
  for (const root of roots) {
    const projects = path.join(root, "projects");
    for (const slug of await readDirents(projects)) {
      if (slug.isDirectory()) {
        await scanSlugDir(path.join(projects, slug.name), result);
      }
    }
  }
  return result;
}

async function scanSlugDir(dir: string, result: ScanResult): Promise<void> {
  // Depth 1 only: `<id>/subagents/` is never touched.
  for (const entry of await readDirents(dir)) {
    if (entry.isFile()) {
      await recordScannedFile(path.join(dir, entry.name), entry.name, result);
    }
  }
}

async function recordScannedFile(filePath: string, name: string, result: ScanResult) {
  if (isExitTailFileName(name)) {
    await recordTailFile(filePath, name, result);
    return;
  }
  const classified = classifyTranscriptName(name);
  const info = classified ? await fs.lstat(filePath).catch(() => undefined) : undefined;
  if (!classified || !info?.isFile()) {
    return;
  }
  const copy: TranscriptCopy = {
    path: filePath,
    sessionId: classified.sessionId,
    kind: classified.kind === "temp" ? "canonical" : classified.kind,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
  const files = filesFor(result, classified.sessionId);
  (classified.kind === "temp" ? files.temps : files.copies).push(copy);
}

async function recordTailFile(filePath: string, name: string, result: ScanResult) {
  const info = await fs.lstat(filePath).catch(() => undefined);
  result.existingTailFiles.count += 1;
  result.existingTailFiles.bytes += info?.size ?? 0;
  filesFor(result, sessionIdFromTranscriptName(name)).tailFiles.push(filePath);
}

function classifyTranscriptName(
  name: string,
): { sessionId: string; kind: CopyKind | "temp" } | undefined {
  const forms: Array<[RegExp, CopyKind | "temp"]> = [
    [CANONICAL_RE, "canonical"],
    [SIDECAR_RE, "sidecar"],
    [PORT_TEMP_RE, "temp"],
  ];
  for (const [pattern, kind] of forms) {
    const match = pattern.exec(name);
    if (match) {
      return { sessionId: match[1], kind };
    }
  }
  return undefined;
}

function filesFor(result: ScanResult, sessionId: string): SessionFiles {
  let files = result.sessions.get(sessionId);
  if (!files) {
    files = { sessionId, copies: [], temps: [], tailFiles: [] };
    result.sessions.set(sessionId, files);
  }
  return files;
}

/** Ids with something to decide: more than one copy, or an orphan port temp old enough. */
function selectGroups(
  scan: ScanResult,
  only: string[] | undefined,
  now: number,
): Map<string, SessionFiles> {
  const wanted = only && only.length > 0 ? new Set(only) : undefined;
  const groups = new Map<string, SessionFiles>();
  for (const [sessionId, files] of scan.sessions) {
    const group = wanted && !wanted.has(sessionId) ? undefined : groupWorthPlanning(files, now);
    if (group) {
      groups.set(sessionId, group);
    }
  }
  return groups;
}

function groupWorthPlanning(files: SessionFiles, now: number): SessionFiles | undefined {
  const temps = files.temps.filter((temp) => now - temp.mtimeMs >= ORPHAN_TEMP_MIN_AGE_MS);
  const worth = files.copies.length > 1 || (temps.length > 0 && files.copies.length > 0);
  return worth ? { ...files, temps } : undefined;
}

// ---------------------------------------------------------------------------
// Records → active paths, and the per-id guards (§5.3)
// ---------------------------------------------------------------------------

type SessionRecords = { records: SessionRecord[]; unparsable: boolean };

/** acp session id → the record files (hot store and archive) that carry it. */
type RecordIndex = Map<string, string[]>;

/** ONE pass over the record files; each is read only as far as its `acp_session_id`. */
async function indexRecordFiles(ids: Set<string>, homes: Homes): Promise<RecordIndex> {
  const hotDir = path.join(homes.stateHome, ".acpx", "sessions");
  const index: RecordIndex = new Map();
  for (const dir of [hotDir, sessionArchiveDirFor(hotDir)]) {
    for (const entry of await readDirents(dir)) {
      if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json") {
        await indexRecordFile(path.join(dir, entry.name), ids, index);
      }
    }
  }
  return index;
}

async function indexRecordFile(file: string, ids: Set<string>, index: RecordIndex) {
  const id = await recordSessionId(file);
  if (id !== undefined && ids.has(id)) {
    index.set(id, [...(index.get(id) ?? []), file]);
  }
}

async function recordSessionId(file: string): Promise<string | undefined> {
  const head = await readHead(file, RECORD_HEAD_BYTES);
  if (head === undefined) {
    return undefined;
  }
  const fromHead = ACP_SESSION_ID_RE.exec(head)?.[1];
  if (fromHead !== undefined) {
    return fromHead;
  }
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return ACP_SESSION_ID_RE.exec(text)?.[1];
}

/** Re-read (fresh, every call) the record files the index found for one id. */
async function loadRecords(files: string[]): Promise<SessionRecords> {
  const found: SessionRecords = { records: [], unparsable: false };
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) {
      continue;
    }
    const record = parseRecordText(text);
    if (record) {
      found.records.push(record);
    } else {
      found.unparsable = true;
    }
  }
  return found;
}

function parseRecordText(text: string): SessionRecord | null {
  try {
    return parseSessionRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

async function readHead(file: string, bytes: number): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    return (await readAt(handle, 0, bytes)).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function activePathsFor(records: SessionRecord[], context: DedupContext): Set<string> {
  const active = new Set<string>();
  for (const record of records) {
    const dir = activeTranscriptConfigDir(record, {
      registry: context.registry,
      homeDir: context.homes.userHome,
    });
    active.add(path.resolve(transcriptJsonlPath(dir, record.cwd, record.acpSessionId)));
  }
  return active;
}

async function guardReason(
  group: SessionFiles,
  found: SessionRecords,
  context: DedupContext,
): Promise<SkipReason | undefined> {
  for (const record of found.records) {
    if (await context.deps.ownerPossiblyAlive(record.acpxRecordId)) {
      return "live-owner";
    }
  }
  if (found.records.some((record) => isRecordedPidPossiblyAlive(record.pid, record.pidIdentity))) {
    return "live-pid";
  }
  if (await anyCopyRecent(group, context.now())) {
    return "recent";
  }
  const ambiguous = found.unparsable || activePathsFor(found.records, context).size > 1;
  return ambiguous ? "ambiguous" : undefined;
}

async function anyCopyRecent(group: SessionFiles, now: number): Promise<boolean> {
  for (const copy of group.copies) {
    const info = await fs.lstat(copy.path).catch(() => undefined);
    if (info && now - info.mtimeMs < DEDUP_RECENT_MS) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Planner (§5.4): greedy against the KEPT set
// ---------------------------------------------------------------------------

async function planGroups(
  groups: Map<string, SessionFiles>,
  context: DedupContext,
  report: DedupReport,
): Promise<SessionPlan[]> {
  const plans: SessionPlan[] = [];
  for (const group of groups.values()) {
    const found = await loadRecords(context.recordIndex.get(group.sessionId) ?? []);
    const skip = await guardReason(group, found, context);
    if (skip) {
      report.skippedIds.push({ sessionId: group.sessionId, reason: skip });
      continue;
    }
    plans.push(await planSession(group, activePathsFor(found.records, context), report));
  }
  return plans;
}

/**
 * ⚠️ A COPY MAY ONLY BE REMOVED AGAINST A COPY THAT IS ALREADY KEPT. Two left-behind
 * copies with DIFFERENT exit blocks are each other's exit-tail (X = P + b₁, Y = P + b₂):
 * a planner that first collected "everything superseded by something" would reduce
 * BOTH and lose P. Greedy-against-kept keeps one of them (TEST-PLAN S13 / E13).
 */
async function planSession(
  group: SessionFiles,
  activePaths: Set<string>,
  report: DedupReport,
): Promise<SessionPlan> {
  const kept = group.copies.filter((copy) => activePaths.has(path.resolve(copy.path)));
  report.keptByReason.active += kept.length;
  const actions: DedupAction[] = [];
  const rest = group.copies.filter((copy) => !activePaths.has(path.resolve(copy.path)));
  for (const copy of rankCopies(rest)) {
    const decision = await decideCopy(copy, witnessOrder(kept, activePaths));
    if ("category" in decision) {
      kept.push(copy);
      report.keptByReason[decision.category] += 1;
    } else {
      actions.push(decision);
    }
  }
  for (const temp of group.temps) {
    await planOrphanTemp(temp, witnessOrder(kept, activePaths), actions, report);
  }
  return { sessionId: group.sessionId, actions };
}

/** Large copies first, so they are already kept when the smaller ones look for a witness. */
function rankCopies(copies: TranscriptCopy[]): TranscriptCopy[] {
  return copies.toSorted(
    (a, b) =>
      b.size - a.size ||
      kindRank(a) - kindRank(b) ||
      b.mtimeMs - a.mtimeMs ||
      a.path.localeCompare(b.path),
  );
}

function kindRank(copy: TranscriptCopy): number {
  return copy.kind === "canonical" ? 0 : 1;
}

/** Prefer the active copy, then the largest canonical, then the largest sidecar. */
function witnessOrder(kept: TranscriptCopy[], activePaths: Set<string>): TranscriptCopy[] {
  const rank = (copy: TranscriptCopy) => (activePaths.has(path.resolve(copy.path)) ? 0 : 1);
  return kept.toSorted((a, b) => rank(a) - rank(b) || kindRank(a) - kindRank(b) || b.size - a.size);
}

async function decideCopy(
  copy: TranscriptCopy,
  witnesses: TranscriptCopy[],
): Promise<DedupAction | { category: KeepCategory }> {
  let reduceWith: DedupAction | undefined;
  let firstReason: string | undefined;
  for (const witness of witnesses) {
    const relation = await classifyAgainstWitness(copy.path, witness.path);
    if (relation.relation === "prefix") {
      return deleteAction(copy, witness.path, relation.sha256);
    }
    if (relation.relation === "exit-tail") {
      reduceWith ??= reduceAction(copy, witness, relation);
    } else {
      firstReason ??= relation.reason;
    }
  }
  return reduceWith ?? { category: keepCategory(firstReason) };
}

function deleteAction(copy: TranscriptCopy, witness: string, sha256: string): DedupAction {
  return {
    action: "delete",
    sessionId: copy.sessionId,
    path: copy.path,
    bytes: copy.size,
    witness,
    sha256,
  };
}

function reduceAction(
  copy: TranscriptCopy,
  witness: TranscriptCopy,
  relation: { prefixBytes: number; tailBytes: number; sha256: string },
): DedupAction {
  return {
    action: "reduce",
    sessionId: copy.sessionId,
    path: copy.path,
    bytes: copy.size,
    witness: witness.path,
    sha256: relation.sha256,
    prefixBytes: relation.prefixBytes,
    tailBytes: relation.tailBytes,
    tailFileBytes: estimateExitTailFileBytes({
      originalPath: copy.path,
      originalSize: copy.size,
      originalMtimeMs: copy.mtimeMs,
      prefixBytes: relation.prefixBytes,
      tailBytes: relation.tailBytes,
      witnessPath: witness.path,
      witnessSize: witness.size,
    }),
  };
}

function keepCategory(reason: string | undefined): KeepCategory {
  if (reason === "tail-not-exit-block:uuid" || reason === "tail-not-exit-block:too-big") {
    return "branch";
  }
  return reason?.startsWith("tail-not-exit-block:") ? "exit-block-not-eligible" : "other";
}

async function planOrphanTemp(
  temp: TranscriptCopy,
  witnesses: TranscriptCopy[],
  actions: DedupAction[],
  report: DedupReport,
): Promise<void> {
  for (const witness of witnesses) {
    const relation = await classifyAgainstWitness(temp.path, witness.path);
    if (relation.relation === "prefix") {
      actions.push({ ...deleteAction(temp, witness.path, relation.sha256), orphanTemp: true });
      return;
    }
  }
  report.keptFiles.push({ path: temp.path, reason: "orphan-temp-not-a-prefix" });
}

// ---------------------------------------------------------------------------
// Apply (§5.5): guards again per id, manifest line fsynced BEFORE each removal
// ---------------------------------------------------------------------------

async function applyPlans(
  plans: SessionPlan[],
  groups: Map<string, SessionFiles>,
  context: DedupContext,
  options: { manifest: string; hooks?: DedupHooks },
  report: DedupReport,
): Promise<void> {
  const manifest = await fs.open(options.manifest, "a", 0o600);
  try {
    for (const plan of plans) {
      const group = groups.get(plan.sessionId);
      if (plan.actions.length === 0 || !group) {
        continue;
      }
      const found = await loadRecords(context.recordIndex.get(plan.sessionId) ?? []);
      const skip = await guardReason(group, found, context);
      if (skip) {
        report.skippedIds.push({ sessionId: plan.sessionId, reason: skip });
        continue;
      }
      for (const action of plan.actions) {
        await applyAction(action, manifest, report, options.hooks);
      }
    }
  } finally {
    await manifest.close();
  }
}

async function applyAction(
  action: DedupAction,
  manifest: FileHandle,
  report: DedupReport,
  hooks: DedupHooks | undefined,
): Promise<void> {
  await appendManifest(manifest, {
    action: action.action === "delete" ? "deleted-prefix" : "reduced-exit-tail",
    path: action.path,
    bytes: action.bytes,
    sha256: action.sha256,
    witness: action.witness,
    prefix_bytes: action.prefixBytes ?? null,
    tail_file: null,
    at: new Date().toISOString(),
  });
  const outcome = await runRemoval(action, hooks);
  if (outcome.action === "kept") {
    await appendManifest(manifest, outcomeLine(action.path, "kept", { reason: outcome.reason }));
    report.recheckFailed += 1;
    report.keptFiles.push({ path: action.path, reason: outcome.reason });
    return;
  }
  const applied = appliedAction(action, outcome);
  await appendManifest(
    manifest,
    outcomeLine(action.path, outcome.action === "removed" ? "deleted" : "reduced", {
      bytes: outcome.bytes,
      sha256: outcome.sha256,
      tail_file: applied.tailFile ?? null,
    }),
  );
  report.actions.push(applied);
}

async function runRemoval(
  action: DedupAction,
  hooks: DedupHooks | undefined,
): Promise<DedupOutcome> {
  return action.action === "delete"
    ? await proveRedundantAndUnlink(action.path, action.witness, { allowEqual: true, hooks })
    : await reduceToExitTail(action.path, action.witness, {
        reducedBy: "transcripts-dedup",
        hooks,
      });
}

function appliedAction(action: DedupAction, outcome: DedupOutcome): DedupAction {
  if (outcome.action !== "reduced") {
    return { ...action, bytes: outcome.action === "removed" ? outcome.bytes : action.bytes };
  }
  return {
    ...action,
    bytes: outcome.bytes,
    sha256: outcome.sha256,
    prefixBytes: outcome.prefixBytes,
    tailFile: outcome.tailFile,
    tailFileBytes: outcome.reusedTailFile ? 0 : outcome.tailFileBytes,
  };
}

function outcomeLine(
  filePath: string,
  outcome: "deleted" | "reduced" | "kept",
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { outcome, path: filePath, ...fields, at: new Date().toISOString() };
}

async function appendManifest(manifest: FileHandle, line: Record<string, unknown>): Promise<void> {
  await manifest.write(`${JSON.stringify(line)}\n`);
  await manifest.sync();
}

// ---------------------------------------------------------------------------
// Totals and rendering (§5.6)
// ---------------------------------------------------------------------------

export type DedupTotals = {
  ids: number;
  copies: number;
  deleted: number;
  deletedBytes: number;
  reduced: number;
  reducedBytes: number;
  tailFiles: number;
  tailFileBytes: number;
  freedBytes: number;
  skipped: Record<SkipReason, number>;
  recheckFailed: number;
};

export function dedupTotals(report: DedupReport): DedupTotals {
  const deleted = report.actions.filter((action) => action.action === "delete");
  const reduced = report.actions.filter((action) => action.action === "reduce");
  const sum = (actions: DedupAction[], pick: (action: DedupAction) => number) =>
    actions.reduce((total, action) => total + pick(action), 0);
  const tailFileBytes = sum(reduced, (action) => action.tailFileBytes ?? 0);
  const skipped: Record<SkipReason, number> = {
    "live-owner": 0,
    "live-pid": 0,
    recent: 0,
    ambiguous: 0,
  };
  for (const entry of report.skippedIds) {
    skipped[entry.reason] += 1;
  }
  const deletedBytes = sum(deleted, (action) => action.bytes);
  const reducedBytes = sum(reduced, (action) => action.bytes);
  return {
    ids: report.ids,
    copies: report.copies,
    deleted: deleted.length,
    deletedBytes,
    reduced: reduced.length,
    reducedBytes,
    tailFiles: reduced.filter((action) => (action.tailFileBytes ?? 0) > 0).length,
    tailFileBytes,
    freedBytes: deletedBytes + reducedBytes - tailFileBytes,
    skipped,
    recheckFailed: report.recheckFailed,
  };
}

/** The machine-quotable last line the fleet clean-up quotes. */
export function formatDedupFinalLine(report: DedupReport): string {
  const t = dedupTotals(report);
  const k = report.keptByReason;
  const gib = (t.freedBytes / 1024 ** 3).toFixed(2);
  return (
    `transcripts dedup ${report.mode === "apply" ? "APPLIED" : "DRY-RUN"} box=${report.box} ` +
    `ids=${t.ids} copies=${t.copies} | deleted=${t.deleted}/${t.deletedBytes}B ` +
    `reduced=${t.reduced}/${t.reducedBytes}B tail-files=${t.tailFiles}/${t.tailFileBytes}B ` +
    `freed=${t.freedBytes}B (${gib} GiB) | kept: active=${k.active} branch=${k.branch} ` +
    `exit-block-not-eligible=${k["exit-block-not-eligible"]} other=${k.other} | skipped-ids: ` +
    `live-owner=${t.skipped["live-owner"]} live-pid=${t.skipped["live-pid"]} ` +
    `recent=${t.skipped.recent} ambiguous=${t.skipped.ambiguous} | recheck-failed=${t.recheckFailed}`
  );
}

function formatActionLine(action: DedupAction, applied: boolean): string {
  if (action.action === "delete") {
    return (
      `${applied ? "DELETED" : "WOULD-DELETE"}  prefix     ${action.bytes}  ${action.path}  ` +
      `witness=${action.witness}`
    );
  }
  const file = action.tailFile ? `  file=${action.tailFile}` : "";
  return (
    `${applied ? "REDUCED" : "WOULD-REDUCE"}  exit-tail  ${action.bytes}  ${action.path}  ` +
    `witness=${action.witness}  tail=${action.tailBytes ?? 0}B${file}`
  );
}

export function renderDedupText(report: DedupReport): string {
  const applied = report.mode === "apply";
  const lines = [
    ...report.actions.map((action) => formatActionLine(action, applied)),
    ...report.keptFiles.map((file) => `KEPT ${file.path} reason=${file.reason}`),
    formatDedupFinalLine(report),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderDedupJson(report: DedupReport): string {
  const t = dedupTotals(report);
  return `${JSON.stringify({
    mode: report.mode,
    box: report.box,
    generated_at: report.generatedAt,
    totals: {
      ids: t.ids,
      copies: t.copies,
      deleted: t.deleted,
      deleted_bytes: t.deletedBytes,
      reduced: t.reduced,
      reduced_bytes: t.reducedBytes,
      tail_files: t.tailFiles,
      tail_file_bytes: t.tailFileBytes,
      freed_bytes: t.freedBytes,
      recheck_failed: t.recheckFailed,
      existing_tail_files: report.existingTailFiles.count,
      existing_tail_file_bytes: report.existingTailFiles.bytes,
    },
    actions: report.actions.map((action) => ({
      action: action.action,
      path: action.path,
      bytes: action.bytes,
      witness: action.witness,
      sha256: action.sha256,
      ...(action.prefixBytes === undefined ? {} : { prefix_bytes: action.prefixBytes }),
      ...(action.tailFile ? { tail_file: action.tailFile } : {}),
    })),
    kept_by_reason: report.keptByReason,
    kept_files: report.keptFiles,
    skipped_ids: report.skippedIds.map((entry) => ({
      session_id: entry.sessionId,
      reason: entry.reason,
    })),
  })}\n`;
}

export function renderDedupQuiet(report: DedupReport): string {
  const t = dedupTotals(report);
  return `${t.deleted} ${t.reduced} ${t.freedBytes} ${t.recheckFailed}\n`;
}

// ---------------------------------------------------------------------------
// Restore (§4.3): rebuild the original bit for bit from any copy whose first
// `prefix_bytes` hash to `prefix_sha256` — or, transitively, from another tail file
// ---------------------------------------------------------------------------

export class TranscriptRestoreError extends Error {
  constructor(
    readonly code:
      | "target-exists"
      | "witness-not-found"
      | "result-hash-mismatch"
      | "header-invalid",
    message: string,
  ) {
    super(message);
  }
}

export type RestoreResult = {
  restored: string;
  bytes: number;
  sha256: string;
  /** The file whose prefix was used, or the tail file it was reconstructed from. */
  witness: string;
  transitive: boolean;
};

type PrefixSource =
  | { kind: "file"; path: string }
  | { kind: "rebuilt"; bytes: Buffer; from: string };

type SessionFileIndex = { copies: string[]; tailFiles: string[] };

export async function restoreExitTail(
  tailFile: string,
  options: { to?: string; stateHome?: string; userHome?: string } = {},
): Promise<RestoreResult> {
  let parsed: { header: ExitTailHeader; tail: Buffer };
  try {
    parsed = await readExitTailFile(tailFile);
  } catch (error) {
    throw new TranscriptRestoreError("header-invalid", (error as Error).message);
  }
  const { header, tail } = parsed;
  const target = path.resolve(options.to ?? header.original_path);
  if (await pathExists(target)) {
    throw new TranscriptRestoreError("target-exists", `${target} exists; refusing to overwrite`);
  }
  const index = await indexSessionFiles(header, tailFile, resolveHomes(options));
  const source = await findPrefixSource(header, index, new Set([path.resolve(tailFile)]));
  if (!source) {
    throw new TranscriptRestoreError(
      "witness-not-found",
      `no copy of ${header.session_id} holds the ${header.prefix_bytes}-byte prefix (witness-not-found)`,
    );
  }
  await writeRestored(target, source, header, tail);
  return {
    restored: target,
    bytes: header.original_size,
    sha256: header.original_sha256,
    witness: source.kind === "file" ? source.path : source.from,
    transitive: source.kind === "rebuilt",
  };
}

async function indexSessionFiles(
  header: ExitTailHeader,
  tailFile: string,
  homes: Homes,
): Promise<SessionFileIndex> {
  const scan = await scanTranscriptRoots(await transcriptRoots(homes));
  const files = scan.sessions.get(header.session_id);
  const copies = new Set<string>([header.witness_path]);
  for (const copy of files?.copies ?? []) {
    copies.add(copy.path);
  }
  const tailFiles = new Set<string>(files?.tailFiles ?? []);
  // The tail file's own dir, even outside the scanned roots.
  for (const entry of await readDirents(path.dirname(tailFile))) {
    collectSiblingFile(
      path.join(path.dirname(tailFile), entry.name),
      entry,
      header.session_id,
      copies,
      tailFiles,
    );
  }
  return { copies: [...copies], tailFiles: [...tailFiles].map((file) => path.resolve(file)) };
}

function collectSiblingFile(
  filePath: string,
  entry: Dirent,
  sessionId: string,
  copies: Set<string>,
  tailFiles: Set<string>,
): void {
  if (!entry.isFile() || sessionIdFromTranscriptName(entry.name) !== sessionId) {
    return;
  }
  if (isExitTailFileName(entry.name)) {
    tailFiles.add(filePath);
  } else if (CANONICAL_RE.test(entry.name) || SIDECAR_RE.test(entry.name)) {
    copies.add(filePath);
  }
}

async function findPrefixSource(
  header: ExitTailHeader,
  index: SessionFileIndex,
  visited: Set<string>,
): Promise<PrefixSource | undefined> {
  for (const copy of index.copies) {
    if (await prefixMatches(copy, header)) {
      return { kind: "file", path: copy };
    }
  }
  for (const other of index.tailFiles) {
    if (visited.has(other)) {
      continue;
    }
    visited.add(other);
    const rebuilt = await rebuildInMemory(other, index, visited);
    if (rebuilt && bufferPrefixMatches(rebuilt, header)) {
      return { kind: "rebuilt", bytes: rebuilt, from: other };
    }
  }
  return undefined;
}

/** Transitive step: rebuild ANOTHER tail file's original in memory (each at most once). */
async function rebuildInMemory(
  tailFile: string,
  index: SessionFileIndex,
  visited: Set<string>,
): Promise<Buffer | undefined> {
  const parsed = await readExitTailFile(tailFile).catch(() => undefined);
  if (!parsed) {
    return undefined;
  }
  const source = await findPrefixSource(parsed.header, index, visited);
  if (!source) {
    return undefined;
  }
  const prefix =
    source.kind === "rebuilt"
      ? source.bytes.subarray(0, parsed.header.prefix_bytes)
      : await readPrefix(source.path, parsed.header.prefix_bytes);
  const rebuilt = Buffer.concat([prefix, parsed.tail]);
  return sha256(rebuilt) === parsed.header.original_sha256 ? rebuilt : undefined;
}

async function prefixMatches(filePath: string, header: ExitTailHeader): Promise<boolean> {
  const info = await fs.stat(filePath).catch(() => undefined);
  if (!info?.isFile() || info.size < header.prefix_bytes) {
    return false;
  }
  return (await hashPrefix(filePath, header.prefix_bytes)) === header.prefix_sha256;
}

function bufferPrefixMatches(bytes: Buffer, header: ExitTailHeader): boolean {
  return (
    bytes.length >= header.prefix_bytes &&
    sha256(bytes.subarray(0, header.prefix_bytes)) === header.prefix_sha256
  );
}

async function hashPrefix(filePath: string, length: number): Promise<string> {
  const hash = createHash("sha256");
  await forEachChunk(filePath, length, (chunk) => {
    hash.update(chunk);
  });
  return hash.digest("hex");
}

async function readPrefix(filePath: string, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    return await readAt(handle, 0, length);
  } finally {
    await handle.close();
  }
}

async function forEachChunk(
  filePath: string,
  length: number,
  onChunk: (chunk: Buffer) => Promise<void> | void,
): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    for (let offset = 0; offset < length; offset += 1024 * 1024) {
      await onChunk(await readAt(handle, offset, Math.min(1024 * 1024, length - offset)));
    }
  } finally {
    await handle.close();
  }
}

async function writeRestored(
  target: string,
  source: PrefixSource,
  header: ExitTailHeader,
  tail: Buffer,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.acpx-restore-${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeRestoredTemp(temp, source, header, tail);
    try {
      await fs.link(temp, target);
    } catch (error) {
      const exists = (error as { code?: unknown }).code === "EEXIST";
      throw exists
        ? new TranscriptRestoreError("target-exists", `${target} exists; refusing to overwrite`)
        : error;
    }
    const mtime = new Date(header.original_mtime_ms);
    await fs.utimes(target, mtime, mtime);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function writeRestoredTemp(
  temp: string,
  source: PrefixSource,
  header: ExitTailHeader,
  tail: Buffer,
): Promise<void> {
  const handle = await fs.open(temp, "wx", 0o600);
  const hash = createHash("sha256");
  let written = 0;
  const write = async (chunk: Buffer) => {
    hash.update(chunk);
    written += chunk.length;
    await handle.write(chunk);
  };
  try {
    if (source.kind === "file") {
      await forEachChunk(source.path, header.prefix_bytes, write);
    } else {
      await write(source.bytes.subarray(0, header.prefix_bytes));
    }
    await write(tail);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (written !== header.original_size || hash.digest("hex") !== header.original_sha256) {
    throw new TranscriptRestoreError(
      "result-hash-mismatch",
      `the rebuilt bytes do not match original_sha256 (result-hash-mismatch); nothing was written`,
    );
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}
