import { SessionArchivedError, SessionNotFoundError } from "../../errors.js";
import {
  isArchivedRecord,
  isoNow,
  listSessions,
  resolveSessionRecord,
  writeSessionRecordAuthorizingParent,
} from "../../session/persistence.js";
import type { SessionRecord } from "../../types.js";
import { descendantRecords, readSessionOwnerStatus } from "./session-control.js";

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
   */
  wasForkEdge: boolean;
  /** Queue-owner classification at the moment of the move, so a caller can see it
   *  re-parented a session whose owner is live. */
  ownerState: string;
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
 * ⚠️ ADVISORY ONLY. Nothing in the graph depends on this: it annotates `moved[]`
 * and the dry-run preview so an operator can see decision 1 (an explicit parent
 * beats a derived fork edge) actually happening. acpx cannot import acpx-ui's
 * module, so if that rule changes this annotation goes stale — a wrong label, never
 * a wrong write. The rule itself lives in `acpx-ui/shared/lineage.ts`.
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
  allRecords: SessionRecord[],
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
  if (
    !parent.crossBox &&
    descendantRecords(record.acpxRecordId, allRecords).some(
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

async function selectTargets(
  target: SetParentTarget,
  allRecords: SessionRecord[],
): Promise<SessionRecord[]> {
  if (target.kind === "session") {
    try {
      return [await resolveSessionRecord(target.sessionId)];
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        throw new SetParentRefusalError(
          "SESSION_NOT_FOUND",
          `no session matches: ${target.sessionId}`,
        );
      }
      throw error;
    }
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
  // OPEN DIRECT children only: never transitive (a grandchild keeps its own
  // parent), and never closed (a handover moves live work; a closed child is
  // re-parentable one at a time via --session-id).
  return allRecords.filter(
    (record) => record.parentSessionId === oldParent.acpxRecordId && record.closed !== true,
  );
}

// The branches below ARE the envelope's absent-vs-present contract; inlining them
// keeps the whole emitted shape readable in one place.
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
 */
async function persistReparentedRecord(
  record: SessionRecord,
  refuse: (record: SessionRecord, code: SetParentRefusalCode, reason: string) => void,
): Promise<boolean> {
  try {
    await writeSessionRecordAuthorizingParent(record);
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
  const allRecords = await listSessions();
  const parent = await resolveNewParent(options.parent);
  const targets = await selectTargets(options.target, allRecords);

  const warnings: string[] = [];
  // Allowed, not refused: the board hides closed sessions as tiles but walks
  // THROUGH them when resolving a root, so the subtree still resolves — and
  // refusing would block the legitimate repair "put this child back under its
  // real, now-closed parent".
  if (parent.record?.closed === true) {
    warnings.push("new parent is closed");
  }

  const nameById = new Map(allRecords.map((r) => [r.acpxRecordId, r.name]));
  const nameOf = (sessionId: string): string | undefined => nameById.get(sessionId);

  const outcome = await moveTargets(targets, parent, allRecords, {
    single: options.target.kind === "session",
    dryRun,
    nameOf,
  });
  warnings.push(...outcome.warnings);

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
    skipped: outcome.skipped,
    warnings,
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
};

async function moveTargets(
  targets: SessionRecord[],
  parent: { acpxRecordId: string; sessionUrl?: string; crossBox: boolean },
  allRecords: SessionRecord[],
  context: MoveContext,
): Promise<{
  moved: SetParentMovedSession[];
  skipped: SetParentSkippedSession[];
  warnings: string[];
}> {
  const moved: SetParentMovedSession[] = [];
  const skipped: SetParentSkippedSession[] = [];
  const warnings: string[] = [];
  const now = isoNow();

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

  for (const record of targets) {
    const refusal = refusalForChild(record, parent, allRecords);
    if (refusal) {
      refuse(record, refusal.code, refusal.reason);
      continue;
    }
    const ownerState = (await readSessionOwnerStatus(record.acpxRecordId)).classification;
    const entry = applyParentToRecord(record, parent, now, ownerState, context.nameOf);
    if (!context.dryRun && !(await persistReparentedRecord(record, refuse))) {
      continue;
    }
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

  return { moved, skipped, warnings };
}
