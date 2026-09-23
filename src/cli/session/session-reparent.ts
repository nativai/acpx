import { SessionArchivedError, SessionNotFoundError } from "../../errors.js";
import {
  isArchivedRecord,
  isoNow,
  listSessionIndexEntries,
  overlaySessionIndexEntries,
  resolveSessionRecord,
  sessionBaseDir,
  sessionRecordFileName,
  toSessionIndexEntry,
  writeSessionRecordAuthorizingParent,
  writeSessionRecordAuthorizingParentWithoutIndex,
} from "../../session/persistence.js";
import type { SessionIndexEntryOverlay } from "../../session/persistence.js";
import type { SessionIndexEntry } from "../../session/persistence/index.js";
import type { SessionRecord } from "../../types.js";
import { descendantRecords, readOwnerStatusForRecord } from "./session-control.js";

/**
 * Every refusal `sessions set-parent` can produce, by name. The string IS the
 * contract — it is emitted as `code` in `--format json` and asserted by the
 * refusal tests — so a caller can branch on the reason without parsing prose.
 *
 * `USAGE` is decided at the CLI layer (flag combinations); the rest are decided
 * here, against the session graph.
 */
export type SetParentRefusalCode =
  | "SESSION_NOT_FOUND"
  | "PARENT_NOT_FOUND"
  | "PARENT_SELF"
  | "PARENT_CYCLE"
  | "SUBAGENT_PARENT_IMMUTABLE"
  | "SESSION_ARCHIVED"
  | "PARENT_DETACH_UNSUPPORTED";

/**
 * A refusal that aborts the WHOLE command: the target could not be resolved, the
 * proposed parent could not be resolved, or an explicit `--session-id` names a
 * session that must not be re-parented.
 *
 * ⚠️ Under `--children-of` the same conditions are evaluated PER CHILD and become
 * `skipped` entries instead — a handover must not fail wholesale because one child
 * is odd. Only target/parent resolution aborts a batch.
 */
export class SetParentRefusalError extends Error {
  constructor(
    readonly code: SetParentRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "SetParentRefusalError";
  }
}

export type SetParentMovedSession = {
  acpxRecordId: string;
  name?: string;
  previousParentSessionId?: string;
  previousParentSessionUrl?: string;
  /** Display name of the previous parent, when it resolves locally — for the text
   *  renderer, which must show WHAT a child is being moved off, not just an id. */
  previousParentName?: string;
  parentSetAt: string;
  spawnedBySessionId?: string;
  /**
   * True when this child's GRAPH edge came from `forkedFromSessionId` before the
   * move — i.e. the re-parent overrode a fork edge. Decision 1 is the one
   * behaviour a user can be surprised by, so it is reported rather than left to
   * `--help`.
   *
   * ⚠️ ADVISORY, AND MEASURED WRONG IN AT LEAST ONE SHAPE. It is a hand-written
   * mirror of a rule that lives in another repo (`acpx-ui/shared/lineage.ts`), so
   * it can disagree with the real edge: verified by the test-engineer on a BYWAY
   * carrying a fork source, where this reported `false` while `relations` held a
   * genuine fork edge. **The move itself was fully correct in every case** — this
   * field labels, it never decides. Do not read it as the edge.
   */
  wasForkEdge: boolean;
  /** Queue-owner classification at the moment of the move, so a caller can see it
   *  re-parented a session whose owner is live. */
  ownerState: string;
  /**
   * Present ONLY when this child's two stores disagreed at selection time — i.e. an
   * interrupted re-parent that this run finishes (or, under `--dry-run`, WOULD
   * finish). Carries the two values that disagreed, so the heal is auditable
   * afterwards rather than indistinguishable from an ordinary move.
   *
   * Set by BOTH target forms. `--children-of` sets it on the heal branch;
   * `--session-id` sets it whenever the named session's index entry disagrees with
   * its record — that path is where the `diverged` advice sends an operator, so it
   * is the one most likely to be repairing a split, and it must not describe the
   * same repair differently from the batch path.
   */
  healedStoreDivergence?: { recordParentSessionId?: string; indexParentSessionId?: string };
};

/**
 * A child whose RECORD and INDEX ENTRY disagree about its parent, reported instead
 * of moved. See `selectTargets` for the three-branch rule and why this branch
 * refuses rather than guessing. (brick c99f9994 F4)
 */
export type SetParentDivergedSession = {
  acpxRecordId: string;
  name?: string;
  recordParentSessionId?: string;
  indexParentSessionId?: string;
  reason: string;
};

export type SetParentSkippedSession = {
  acpxRecordId: string;
  name?: string;
  code: SetParentRefusalCode;
  reason: string;
};

export type SetParentResult = {
  ok: true;
  dryRun: boolean;
  parent: { acpxRecordId: string; sessionUrl?: string; crossBox: boolean; name?: string };
  /**
   * ⚠️ AN ARRAY, ALWAYS — a batch of one is still a batch, so a caller never
   * branches on which target flag was passed. (acpx-ui `97ff3eac` is the live
   * specimen of an alarm firing on a complete success because a `moved` field was
   * read as a scalar.)
   */
  moved: SetParentMovedSession[];
  skipped: SetParentSkippedSession[];
  /**
   * ⚠️ THE POINT OF THIS ARRAY IS THAT `ok:true` MUST NEVER AGAIN BE THE WHOLE
   * STORY. A child torn across the two stores used to appear in NEITHER `moved` NOR
   * `skipped` — a clean success over a split store, with nothing for an operator to
   * pull on. It is the only part of the F4 repair that helps someone whose store is
   * ALREADY split, because it needs no re-run to have gone right.
   */
  diverged: SetParentDivergedSession[];
  warnings: string[];
};

export type SetParentTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "children-of"; parentSessionId: string };

export type SetParentOptions = {
  target: SetParentTarget;
  /** The new parent, already resolved from flags by the CLI layer. `url` is
   *  present only when `--parent-session-url` was given (FW-19 cross-box form). */
  parent: { id: string; url?: string };
  dryRun?: boolean;
};

/**
 * Mirror of branch 3 ("fork") of acpx-ui's `shared/lineage.ts` `resolveLineage`,
 * on the `relations` surface, evaluated against the record as it stands BEFORE
 * the move.
 *
 * ⚠️ ADVISORY ONLY, AND IT HAS ALREADY BEEN MEASURED WRONG. Nothing in the graph
 * depends on this: it annotates `moved[]` and the dry-run preview so an operator
 * can see decision 1 (an explicit parent beats a derived fork edge) actually
 * happening. acpx cannot import acpx-ui's module, so when that rule moves this
 * annotation goes stale — a wrong label, never a wrong write.
 *
 * Confirmed stale for a **byway carrying a fork source**: this returns `false`
 * while `relations` holds a genuine fork edge (test-engineer, brick c99f9994 §6.1).
 * The re-parent was correct in every measured case. **Do not "fix" it by making
 * the CLI authoritative about edges** — the rule belongs in
 * `acpx-ui/shared/lineage.ts` and this is a courtesy label; the honest repair is to
 * keep saying so, which the `--help` text and the dry-run footnote both now do.
 */
function hadForkEdge(record: SessionRecord): boolean {
  // A byway's graph edge is deliberately its parent spawn edge, not its fork
  // (DIVERGENCE 2 in that module); and an already-re-parented record resolved
  // through branch 1, so its edge was not a fork either.
  if (record.parentSetAt || record.metadata?.byway === "1") {
    return false;
  }
  // Branch 2 on the relations surface needs BOTH templateSource and a parent.
  if (record.metadata?.template_source && record.parentSessionId) {
    return false;
  }
  return record.forkedFromSessionId !== undefined;
}

function refusalForChild(
  record: SessionRecord,
  parent: { acpxRecordId: string; crossBox: boolean },
  graph: SessionIndexEntry[],
): { code: SetParentRefusalCode; reason: string } | undefined {
  // Subagents are Task-tool children of a PROCESS: they die with their turn, and
  // `parentSessionId` is their RETENTION ANCHOR (`archive/retention.ts` anchorIdFor),
  // so re-parenting one silently moves what its archival is anchored to. Excluded
  // by default; an escape hatch is cheap to add later, opening it is not undoable.
  if (record.kind === "subagent") {
    return {
      code: "SUBAGENT_PARENT_IMMUTABLE",
      reason: "Task-tool subagent; parent is its retention anchor",
    };
  }
  if (isArchivedRecord(record)) {
    return { code: "SESSION_ARCHIVED", reason: "session is archived; restore it first" };
  }
  if (record.acpxRecordId === parent.acpxRecordId) {
    return { code: "PARENT_SELF", reason: "a session cannot be its own parent" };
  }
  // A→B→A is one typo away and produces a graph with no root. Every known walker
  // carries a `seen` guard so it will not hang — it silently renders a subtree as
  // UNREACHABLE, which is worse than an error. The walk is already written and the
  // index is already loaded, so the check is cheap.
  //
  // ⚠️ Skipped for a CROSS-BOX parent (resolved by url, absent locally): the remote
  // graph is unwalkable from here, and no cycle is constructible through this verb
  // on one box.
  //
  // The walk runs over INDEX ENTRIES, not records: it reads `parentSessionId` only,
  // and the entry's parent is exactly what the F4 selection already trusts
  // (`selectChildrenOf`). Hydrating 1,600 records to answer it cost 4.2–13.4 s
  // (brick 853d9f38 §3.2).
  if (
    !parent.crossBox &&
    descendantRecords(record.acpxRecordId, graph).some(
      (descendant) => descendant.acpxRecordId === parent.acpxRecordId,
    )
  ) {
    return {
      code: "PARENT_CYCLE",
      reason: "proposed parent is a descendant of this session",
    };
  }
  return undefined;
}

/**
 * Resolve the new parent. A local id wins; a `--parent-session-url` whose id does
 * not resolve locally is the FW-19 cross-box case and is accepted as linkage-only.
 * A bare `--parent-id` that resolves to nothing cannot identify a cross-box session
 * and is a refusal.
 */
async function resolveNewParent(parent: { id: string; url?: string }): Promise<{
  acpxRecordId: string;
  sessionUrl?: string;
  crossBox: boolean;
  record?: SessionRecord;
}> {
  try {
    const record = await resolveSessionRecord(parent.id);
    return {
      acpxRecordId: record.acpxRecordId,
      ...(parent.url ? { sessionUrl: parent.url } : {}),
      crossBox: false,
      record,
    };
  } catch (error) {
    if (error instanceof SessionNotFoundError && parent.url) {
      return { acpxRecordId: parent.id, sessionUrl: parent.url, crossBox: true };
    }
    if (error instanceof SessionNotFoundError) {
      throw new SetParentRefusalError(
        "PARENT_NOT_FOUND",
        `--parent-id refers to unknown session: ${parent.id}`,
      );
    }
    throw error;
  }
}

/** The two values that disagreed when a child was torn across the two stores. */
type StoreDivergence = { recordParentSessionId?: string; indexParentSessionId?: string };

type ChildSelection = {
  targets: SessionRecord[];
  /** Torn children this run refuses to move — reported, never guessed at. */
  diverged: SetParentDivergedSession[];
  /** acpxRecordId → the two disagreeing values, for children we DO move (the heal). */
  healed: Map<string, StoreDivergence>;
  /**
   * Children the INDEX names but whose record would not load — reported as
   * `skipped/SESSION_NOT_FOUND` rather than dropped.
   *
   * ⚠️ THE PRE-853d9f38 CODE DROPPED THESE IN SILENCE, and that silence is the
   * defect F4 was about: `listSessions()` filters out an entry whose record fails
   * to parse, so such a child appeared in NEITHER `moved` NOR `skipped` and the run
   * said `ok:true`. Selecting from the index makes it visible; the outcome for the
   * child is the same (not moved), the report is not.
   */
  unresolved: SetParentSkippedSession[];
};

async function selectTargets(
  target: SetParentTarget,
  entries: SessionIndexEntry[],
  newParentId: string,
): Promise<ChildSelection> {
  if (target.kind === "session") {
    let record: SessionRecord;
    try {
      record = await resolveSessionRecord(target.sessionId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        throw new SetParentRefusalError(
          "SESSION_NOT_FOUND",
          `no session matches: ${target.sessionId}`,
        );
      }
      throw error;
    }
    // ⚠️ THE EXPLICIT PATH MUST REPORT A SPLIT IT REPAIRS, EXACTLY AS THE BATCH
    // PATH DOES. `--session-id` is where the `diverged` advice SENDS an operator
    // ("re-assert it explicitly with --session-id"), so this is the run most likely
    // to be resolving a torn store — and it used to report
    // `healedStoreDivergence: null` while demonstrably fixing one, i.e. the two
    // paths described the same repair differently.
    //
    // Unlike `--children-of` there is no three-branch choice here: the operator
    // named this session AND this parent, so it always moves. The only question is
    // whether the two stores disagreed on the way in.
    return {
      targets: [record],
      diverged: [],
      healed: divergenceForOne(record, indexParents(entries)),
      unresolved: [],
    };
  }
  // ⚠️ `--children-of` REQUIRES A LOCAL SESSION, and this resolve is why. It
  // enumerates the local index, so a non-resolving id would otherwise match zero
  // children and exit 0 — making a TYPO and "A has no children" the same answer.
  // That is precisely the difference between a handover that correctly moved
  // nothing and one that silently moved nothing.
  let oldParent: SessionRecord;
  try {
    oldParent = await resolveSessionRecord(target.parentSessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw new SetParentRefusalError(
        "SESSION_NOT_FOUND",
        `--children-of refers to unknown session: ${target.parentSessionId}`,
      );
    }
    throw error;
  }
  return await selectChildrenOf(oldParent.acpxRecordId, newParentId, entries);
}

/**
 * The one-target equivalent of `selectChildrenOf`'s heal detection.
 *
 * `has()` rather than a value comparison against `undefined`: a session with NO index
 * entry at all is absent from the map, and `undefined !== "old-parent"` would report
 * it as a split.
 *
 * ⚠️ THAT GUARD IS DEFENSIVE AND IS NOT COVERED BY A TEST — said plainly because I
 * tried to cover it and could not. Dropping it leaves the suite green, and the
 * reason is that the case cannot be constructed: BOTH index reads on this path
 * (`listSessions()` and `listSessionIndexEntries()`) reconcile the index before
 * returning, so every record file on disk has an entry by the time this runs. An
 * archived record does resolve without one, but is refused before anything is
 * emitted. Keep the guard — it costs nothing and is correct — but do NOT read it as
 * load-bearing, and do not add a test that appears to pin it: a fixture built
 * through the normal path always has the entry, so such a test would pass either way.
 */
function divergenceForOne(
  record: SessionRecord,
  indexParentById: Map<string, string | undefined>,
): ChildSelection["healed"] {
  const healed: ChildSelection["healed"] = new Map();
  if (!indexParentById.has(record.acpxRecordId)) {
    return healed;
  }
  const indexParent = indexParentById.get(record.acpxRecordId);
  if (indexParent !== record.parentSessionId) {
    healed.set(record.acpxRecordId, divergenceOf(record.parentSessionId, indexParent));
  }
  return healed;
}

/** acpxRecordId → the parent the INDEX ENTRY names, which can differ from the record. */
function indexParents(entries: SessionIndexEntry[]): Map<string, string | undefined> {
  return new Map(entries.map((entry) => [entry.acpxRecordId, entry.parentSessionId]));
}

/**
 * Which children `--children-of <OLD>` acts on.
 *
 * ⚠️ THE PREDICATE READS THE INDEX ENTRY AS WELL AS THE RECORD, AND THAT IS THE WHOLE
 * F4 REPAIR. A child whose record write landed and whose index update did not (a kill
 * between the two) used to be enumerated from `listSessions()` — a hybrid: membership
 * from the index, every FIELD from the record — and simply failed the predicate. It
 * appeared in neither `moved` nor `skipped`, the run said `ok:true`, and the
 * documented "just re-run it, the operation is idempotent" did not touch it.
 *
 * 🛑 CANDIDATES COME FROM THE INDEX ENTRIES; THE RECORD IS LOADED PER CANDIDATE. Do
 * NOT "simplify" this back to a scan over `listSessions()`: that hydrates EVERY
 * record in the store to answer a question about a handful of them — measured at
 * 4.2–13.4 s over 1,600 records, 60–80 % of the whole command, against 35–115 ms for
 * the entries (brick 853d9f38 §3.2). And do NOT go the other way either: an index
 * ENTRY is a projection and must never reach a write path — `applyParentToRecord`
 * mutates what it is given and `writeSessionRecordAuthorizingParent` serializes the
 * WHOLE record, so a projected entry there truncates the session file on disk.
 * Selection from entries, records loaded per target, records written back.
 *
 * Three branches, over open direct children the INDEX names under OLD:
 *   record == OLD                  → ordinary move.
 *   record == the REQUESTED NEW    → HEAL. The record already arrived; finish the
 *                                    interrupted index write. Idempotent by nature.
 *   record == a THIRD session      → DIVERGED. Report, do NOT move.
 *
 * ⚠️ WHY THE THIRD BRANCH REFUSES INSTEAD OF MOVING, and do not "simplify" it into a
 * flat union: the record naming a third session means this child has ALREADY been
 * deliberately moved somewhere else, and only its stale index still calls it OLD.
 * Moving it would silently override a completed re-parent — F4's own failure mode
 * wearing a different hat. Nothing here can tell whether the operator means the
 * record or the index, and picking one silently is how F4 was born.
 *
 * ⚠️ AND WHY `record == OLD, index == something else` IS NOT SELECTED — the next
 * reader will want to re-add the record half of the union, so here is the argument
 * rather than the conclusion. That state is UNREACHABLE, for two independent reasons.
 * (1) ORDER: every writer of this pair writes the RECORD first and the INDEX second
 * (acpx `repository.ts` persistRecordFile → updateSessionIndexForRecordWrite;
 * acpx-ui's parent PATCH writeFileSync+rename → updateSessionIndexUnderLock), the
 * index-only writers touch `closed`/`favorite` only, and the reconcile derives
 * entries FROM records — so a tear can only run index-BEHIND-record. (2) STRONGER,
 * and the one that survives a new writer appearing: `preserveParentLinkageForPersist`
 * (`repository.ts`) re-reads the parent group from DISK immediately before every
 * serialize, and the entry is projected from that same post-preserve record — so no
 * index snapshot can ever carry a parent the record did not hold at that instant.
 * The index can only lag TOWARD a value the record actually had. **That holds only
 * while nothing assigns a parent outside record construction and this verb — the
 * condition `preserveParentLinkageForPersist` states, and it expires with a new
 * parent writer.** Re-run that grep before adding one.
 */
async function selectChildrenOf(
  oldParentId: string,
  newParentId: string,
  entries: SessionIndexEntry[],
): Promise<ChildSelection> {
  const targets: SessionRecord[] = [];
  const diverged: SetParentDivergedSession[] = [];
  const healed: ChildSelection["healed"] = new Map();
  const unresolved: SetParentSkippedSession[] = [];

  for (const entry of entries) {
    // OPEN DIRECT children only: never transitive (a grandchild keeps its own
    // parent), and never closed (a handover moves live work; a closed child is
    // re-parentable one at a time via --session-id).
    //
    // `entry.closed` is EXACT, not an approximation of the record: the projection
    // writes `record.closed === true`, the parser requires a boolean, and the
    // predicate it replaces was `record.closed === true` — the same coercion on both
    // sides. It is also re-checked against the loaded record in `childOutcome`.
    if (entry.closed || entry.parentSessionId !== oldParentId) {
      continue;
    }
    const outcome = await childOutcome(entry, oldParentId, newParentId);
    if (outcome.kind === "target") {
      targets.push(outcome.record);
      if (outcome.healed) {
        healed.set(outcome.record.acpxRecordId, outcome.healed);
      }
    } else if (outcome.kind === "diverged") {
      diverged.push(outcome.entry);
    } else if (outcome.kind === "unresolved") {
      unresolved.push(outcome.entry);
    }
  }
  return { targets, diverged, healed, unresolved };
}

type ChildOutcome =
  | { kind: "target"; record: SessionRecord; healed?: StoreDivergence }
  | { kind: "diverged"; entry: SetParentDivergedSession }
  | { kind: "unresolved"; entry: SetParentSkippedSession }
  | { kind: "ignore" };

/**
 * One candidate's fate: load its record, then run the three-branch rule against it.
 * Split out of `selectChildrenOf` so the loop reads as a dispatch and this reads as
 * the decision — and so neither one is branchy enough to hide a case.
 */
async function childOutcome(
  entry: SessionIndexEntry,
  oldParentId: string,
  newParentId: string,
): Promise<ChildOutcome> {
  let record: SessionRecord;
  try {
    record = await resolveSessionRecord(entry.acpxRecordId);
  } catch (error) {
    if (!(error instanceof SessionNotFoundError)) {
      throw error;
    }
    // An index row whose record will not load. Nothing to move — but it is
    // REPORTED rather than dropped in silence; see ChildSelection.unresolved.
    return {
      kind: "unresolved",
      entry: {
        acpxRecordId: entry.acpxRecordId,
        ...(entry.name ? { name: entry.name } : {}),
        code: "SESSION_NOT_FOUND",
        reason: "the index names this child but its record could not be read",
      },
    };
  }
  // The record is the authority on `closed` and we now hold it: a child that
  // closed between the index read and this load is not live work and is not moved.
  if (record.closed === true) {
    return { kind: "ignore" };
  }
  const indexParent = entry.parentSessionId;
  const verdict = classifyChild(record, oldParentId, newParentId, indexParent);
  if (verdict === "diverged") {
    return { kind: "diverged", entry: divergedEntryFor(record, indexParent) };
  }
  if (verdict === "heal") {
    return {
      kind: "target",
      record,
      healed: divergenceOf(record.parentSessionId, indexParent),
    };
  }
  // `ignore` cannot occur here — it needs BOTH parents to differ from OLD, and the
  // caller already matched the index half — but it is a verdict of the shared rule,
  // so it is answered rather than folded into `move`.
  return verdict === "move" ? { kind: "target", record } : { kind: "ignore" };
}

function divergedEntryFor(
  record: SessionRecord,
  indexParent: string | undefined,
): SetParentDivergedSession {
  return {
    acpxRecordId: record.acpxRecordId,
    ...(record.name ? { name: record.name } : {}),
    ...divergenceOf(record.parentSessionId, indexParent),
    reason:
      "record and index entry disagree about this session's parent, and the record names a third session — re-assert it explicitly with --session-id if you want it moved",
  };
}

function divergedWarning(entry: SetParentDivergedSession): string {
  return `${entry.name ?? entry.acpxRecordId} is SPLIT across the two stores (record: ${entry.recordParentSessionId ?? "none"}, index: ${entry.indexParentSessionId ?? "none"}) and was NOT moved`;
}

function divergenceOf(
  recordParentSessionId: string | undefined,
  indexParentSessionId: string | undefined,
): { recordParentSessionId?: string; indexParentSessionId?: string } {
  return {
    ...(recordParentSessionId ? { recordParentSessionId } : {}),
    ...(indexParentSessionId ? { indexParentSessionId } : {}),
  };
}

/**
 * Stamp the heal onto the moved entry and say so out loud. A healed child must not
 * read as an ordinary move — that silence is the whole of F4.
 *
 * ⚠️ THE TENSE IS CONDITIONAL ON THE MODE, AND THAT IS NOT STYLE. This message used
 * to say "this run rewrote both" unconditionally — printed by a run that also says
 * "DRY RUN — no changes written", to an operator mid-handover, about a store it had
 * not touched. `--dry-run` exists precisely so someone can look without having
 * acted; a preview claiming it already wrote destroys that.
 */
function noteHealedDivergence(
  entry: SetParentMovedSession,
  divergence: { recordParentSessionId?: string; indexParentSessionId?: string } | undefined,
  dryRun: boolean,
): string[] {
  if (!divergence) {
    return [];
  }
  entry.healedStoreDivergence = divergence;
  const outcome = dryRun ? "this run WOULD rewrite both" : "this run rewrote both";
  return [
    `${entry.name ?? entry.acpxRecordId} was SPLIT across the two stores (record: ${divergence.recordParentSessionId ?? "none"}, index: ${divergence.indexParentSessionId ?? "none"}) — ${outcome}`,
  ];
}

/** The three-branch rule of `selectChildrenOf`, as one decision. */
function classifyChild(
  record: SessionRecord,
  oldParentId: string,
  newParentId: string,
  indexParent: string | undefined,
): "move" | "heal" | "diverged" | "ignore" {
  const recordParent = record.parentSessionId;
  if (recordParent !== oldParentId && indexParent !== oldParentId) {
    return "ignore";
  }
  if (recordParent === oldParentId) {
    return "move";
  }
  return recordParent === newParentId ? "heal" : "diverged";
}

// eslint-disable-next-line complexity -- explicit optional-field projection
function applyParentToRecord(
  record: SessionRecord,
  parent: { acpxRecordId: string; sessionUrl?: string },
  now: string,
  ownerState: string,
  nameOf: (sessionId: string) => string | undefined,
): SetParentMovedSession {
  const previousParentSessionId = record.parentSessionId;
  const previousParentSessionUrl = record.parentSessionUrl;
  const wasForkEdge = hadForkEdge(record);

  // WRITE-ONCE provenance: captured from the parent as it stands immediately
  // before the FIRST re-parent, so after A→B→C it still reads A. Absent stays
  // absent when the session had no parent — that absence MEANS "was a root" and
  // must not be back-filled with a sentinel.
  if (record.spawnedBySessionId === undefined && previousParentSessionId !== undefined) {
    record.spawnedBySessionId = previousParentSessionId;
  }
  record.parentSessionId = parent.acpxRecordId;
  // Cleared, not merged, when the new parent is same-box: a stale cross-box url
  // left behind would keep pointing at the wrong host.
  record.parentSessionUrl = parent.sessionUrl;
  record.parentSetAt = now;

  return {
    acpxRecordId: record.acpxRecordId,
    ...(record.name ? { name: record.name } : {}),
    ...(previousParentSessionId ? { previousParentSessionId } : {}),
    ...(previousParentSessionUrl ? { previousParentSessionUrl } : {}),
    ...(previousParentSessionId && nameOf(previousParentSessionId)
      ? { previousParentName: nameOf(previousParentSessionId) }
      : {}),
    parentSetAt: now,
    ...(record.spawnedBySessionId ? { spawnedBySessionId: record.spawnedBySessionId } : {}),
    wasForkEdge,
    ownerState,
  };
}

/**
 * The write. Returns false when the record was refused instead of written.
 *
 * ⚠️ `writeSessionRecordAuthorizingParent`, NOT `writeSessionRecord`. The plain
 * write read-preserves the parent linkage from disk and would put the OLD parent
 * straight back — exit 0, correct-looking output, nothing changed.
 *
 * `batched` picks the sibling that writes no index update, because the caller then
 * owns that half (`indexOverlayBatch`). ⚠️ The two must stay in step: batching the
 * record write without flushing the overlay leaves every moved child torn across
 * the two stores until someone re-runs the command.
 */
async function persistReparentedRecord(
  record: SessionRecord,
  refuse: (record: SessionRecord, code: SetParentRefusalCode, reason: string) => void,
  batched: boolean,
): Promise<boolean> {
  try {
    await (batched
      ? writeSessionRecordAuthorizingParentWithoutIndex(record)
      : writeSessionRecordAuthorizingParent(record));
    return true;
  } catch (error) {
    // The write guard is the authority on archived records; catch its throw and
    // render it as a named refusal rather than letting a stack trace out.
    if (error instanceof SessionArchivedError) {
      refuse(record, "SESSION_ARCHIVED", "session is archived; restore it first");
      return false;
    }
    throw error;
  }
}

/**
 * Re-parent one session, or every open direct child of a session, onto a new
 * parent — the write half of an agent handover.
 *
 * ⚠️ THIS MOVES THE SESSION GRAPH ONLY. It does NOT redirect a running child's
 * reports: `$ACPX_PARENT_SESSION_URL` is composed at PROCESS SPAWN TIME and is
 * frozen in that child's process env until its queue owner respawns. The
 * `agent-handover` skill's message-redirect covers the live turn; that division of
 * labour is deliberate.
 */
export async function setSessionParent(options: SetParentOptions): Promise<SetParentResult> {
  const dryRun = options.dryRun === true;
  // ONE index read serves selection, the name map and the cycle walk. Records are
  // loaded per TARGET (see `selectChildrenOf`), never for the store.
  const entries = await listSessionIndexEntries();
  const parent = await resolveNewParent(options.parent);
  const selection = await selectTargets(options.target, entries, parent.acpxRecordId);

  const warnings: string[] = [];
  // Allowed, not refused: the board hides closed sessions as tiles but walks
  // THROUGH them when resolving a root, so the subtree still resolves — and
  // refusing would block the legitimate repair "put this child back under its
  // real, now-closed parent".
  if (parent.record?.closed === true) {
    warnings.push("new parent is closed");
  }

  const nameById = new Map(entries.map((entry) => [entry.acpxRecordId, entry.name]));
  const nameOf = (sessionId: string): string | undefined => nameById.get(sessionId);

  const outcome = await moveTargets(selection.targets, parent, entries, {
    single: options.target.kind === "session",
    dryRun,
    nameOf,
    healed: selection.healed,
  });
  warnings.push(...outcome.warnings);
  warnings.push(...selection.diverged.map(divergedWarning));

  return {
    ok: true,
    dryRun,
    parent: {
      acpxRecordId: parent.acpxRecordId,
      ...(parent.sessionUrl ? { sessionUrl: parent.sessionUrl } : {}),
      crossBox: parent.crossBox,
      ...(parent.record?.name ? { name: parent.record.name } : {}),
    },
    moved: outcome.moved,
    // Unresolvable index rows join the per-child refusals: both are "named, not
    // moved, and said so out loud".
    skipped: [...outcome.skipped, ...selection.unresolved],
    diverged: selection.diverged,
    warnings,
  };
}

/**
 * How many children may have their records written before the index is brought
 * level. **Derived, not chosen** — and the derivation is the whole justification,
 * so do not "round it up" without redoing it.
 *
 * Batching widens the window in which a moved child's record says NEW while its
 * index entry still says OLD. The system already states its tolerance for that
 * exact disagreement: `SCALAR_FLUSH_INTERVAL_MS = 5_000` (`index-update-queue.ts`)
 * — a throttled scalar write may leave the two stores disagreeing for up to 5 s.
 * At a measured ≈41 ms p90 per child (record write + record resolve, on a box at
 * load 35-39, i.e. already pessimistic) the bound is CHUNK × 41 ms ≤ 5,000 ms →
 * CHUNK ≤ 122. 100 leaves headroom: ≈4.1 s worst case, ≈1.4 s at the median.
 *
 * It also caps the crash-torn set at ≤100 rather than ≤N, and caps how long the
 * board renders a moved child under its old parent.
 *
 * ⚠️ AT A REALISTIC HANDOVER SIZE THIS NEVER FIRES (20 < 100) — one flush, exactly
 * as if there were no bound. It is insurance for pathological N, not a tuning knob.
 */
const INDEX_FLUSH_CHUNK = 100;

/** Accumulates the index half of a batch re-parent and flushes it under one lock. */
type IndexOverlayBatch = {
  /**
   * Whether the record write must SKIP its own index update, because this batch
   * owns it. One flag, read by both halves, so "wrote the record without an index
   * update" and "accumulated an overlay for it" cannot disagree — the pair that
   * would silently leave every moved child torn.
   */
  batched: boolean;
  /** Record a written child's new parent linkage; flushes when CHUNK is reached. */
  add: (record: SessionRecord) => Promise<void>;
  /** Write whatever is accumulated. Idempotent; a no-op when nothing is pending. */
  flush: () => Promise<void>;
};

/**
 * The parent-linkage half of `--children-of`, as an overlay batch.
 *
 * ⚠️ THE FIELD GROUP HERE MUST MATCH THE ONE THE RECORD WRITE IS AUTHORITATIVE FOR
 * — `preserveParentLinkageForPersist`'s four fields. Overlay fewer and the index
 * keeps a stale member of the group; overlay more and this command starts
 * asserting fields it is not the authority on, which is exactly the whole-entry
 * behaviour that reverts a concurrent close.
 *
 * `parentSessionUrl` is included even when it is `undefined`, and that is the
 * point: a same-box parent must CLEAR a previous cross-box url rather than leave
 * it pointing at the wrong host (`applyParentToRecord` does the same on the
 * record). `overlaySessionIndexEntries` documents that an explicit undefined
 * clears.
 */
function indexOverlayBatch(enabled: boolean): IndexOverlayBatch {
  const pending = new Map<string, SessionIndexEntryOverlay>();
  const flush = async (): Promise<void> => {
    if (pending.size === 0) {
      return;
    }
    const batch = new Map(pending);
    pending.clear();
    await overlaySessionIndexEntries(sessionBaseDir(), batch);
  };
  return {
    batched: enabled,
    add: async (record: SessionRecord): Promise<void> => {
      if (!enabled) {
        return;
      }
      const file = sessionRecordFileName(record.acpxRecordId);
      pending.set(file, {
        fields: {
          parentSessionId: record.parentSessionId,
          parentSessionUrl: record.parentSessionUrl,
          parentSetAt: record.parentSetAt,
          spawnedBySessionId: record.spawnedBySessionId,
        },
        // A child whose record the index has not caught up with yet still needs its
        // row; the record is in hand, so build it from that.
        fallback: toSessionIndexEntry(record, file),
      });
      if (pending.size >= INDEX_FLUSH_CHUNK) {
        await flush();
      }
    },
    flush,
  };
}

type MoveContext = {
  /** An explicit single target has nothing to skip TO, so every per-child refusal
   *  becomes the WHOLE command's refusal. Under --children-of the same conditions
   *  are reported under `skipped` and the batch continues — a handover must not
   *  fail wholesale because one child is odd. */
  single: boolean;
  dryRun: boolean;
  nameOf: (sessionId: string) => string | undefined;
  /** Children whose two stores disagreed and that this run is healing. */
  healed: ChildSelection["healed"];
};

async function moveTargets(
  targets: SessionRecord[],
  parent: { acpxRecordId: string; sessionUrl?: string; crossBox: boolean },
  graph: SessionIndexEntry[],
  context: MoveContext,
): Promise<{
  moved: SetParentMovedSession[];
  skipped: SetParentSkippedSession[];
  warnings: string[];
}> {
  const moved: SetParentMovedSession[] = [];
  const skipped: SetParentSkippedSession[] = [];
  const warnings: string[] = [];

  const refuse = (record: SessionRecord, code: SetParentRefusalCode, reason: string): void => {
    if (context.single) {
      throw new SetParentRefusalError(code, reason);
    }
    skipped.push({
      acpxRecordId: record.acpxRecordId,
      ...(record.name ? { name: record.name } : {}),
      code,
      reason,
    });
  };

  // The single-target path keeps its IMMEDIATE per-record index write: one child is
  // not a batch, and `test/session-reparent.test.ts` pins that write against the
  // coalescing queue. `--dry-run` writes nothing at all, by either half.
  const overlay = indexOverlayBatch(!context.single && !context.dryRun);

  try {
    await moveEach(targets, parent, graph, context, { moved, skipped, warnings, refuse, overlay });
  } finally {
    // 🛑 IN A `finally`, NOT AFTER THE LOOP, and not on `beforeExit` (which
    // `SIGKILL` and `process.exit()` skip). A child whose record is already
    // committed must get its index entry even when a later child throws —
    // otherwise the throw, not the crash, is what leaves the store torn.
    await overlay.flush();
  }

  return { moved, skipped, warnings };
}

type MoveAccumulators = {
  moved: SetParentMovedSession[];
  skipped: SetParentSkippedSession[];
  warnings: string[];
  refuse: (record: SessionRecord, code: SetParentRefusalCode, reason: string) => void;
  overlay: IndexOverlayBatch;
};

async function moveEach(
  targets: SessionRecord[],
  parent: { acpxRecordId: string; sessionUrl?: string; crossBox: boolean },
  graph: SessionIndexEntry[],
  context: MoveContext,
  out: MoveAccumulators,
): Promise<void> {
  const { moved, warnings, refuse, overlay } = out;
  const now = isoNow();
  for (const record of targets) {
    const refusal = refusalForChild(record, parent, graph);
    if (refusal) {
      refuse(record, refusal.code, refusal.reason);
      continue;
    }
    // …ForRecord, not `readSessionOwnerStatus(id)`: the record in hand was already
    // read once by the selection, and the id form would read it a second time and
    // throw the result away.
    const ownerState = (await readOwnerStatusForRecord(record)).classification;
    const entry = applyParentToRecord(record, parent, now, ownerState, context.nameOf);
    warnings.push(
      ...noteHealedDivergence(entry, context.healed.get(record.acpxRecordId), context.dryRun),
    );
    if (!context.dryRun && !(await persistReparentedRecord(record, refuse, overlay.batched))) {
      continue;
    }
    // The record is committed; the index half is the overlay's, flushed by CHUNK
    // and once in the caller's `finally`. A no-op for a single target or a dry run.
    await overlay.add(record);
    // `Facets/user-facing-via-acpx-ui/FACET.md` gates the user-facing facet on
    // `unless_env="ACPX_PARENT_SESSION_URL"`, so a session that HAD no parent loses
    // its ability to hand work to Daniel once its owner next respawns. A genuine
    // behaviour loss with no in-scope remedy — surfaced at the moment the thing is
    // done, because nobody reads `--help` then.
    if (!entry.previousParentSessionId) {
      warnings.push(
        `${entry.name ?? entry.acpxRecordId} had no parent: adopting it strips its user-facing acpx-ui facet when its owner next respawns`,
      );
    }
    moved.push(entry);
  }
}
