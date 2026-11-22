import {
  NoSessionError,
  parseSessionIdFromUrl,
  resolveExplicitSessionRecord,
} from "../cli/session-selector.js";
import { SessionNotFoundError, SessionResolutionError } from "../errors.js";
import { resolveSessionRecord } from "../session/persistence.js";
import type { TargetSelector } from "./command-classes.js";

/**
 * WHY a target is not a session id (A-52, C6.2): the three answers atrium's gate tells apart.
 *   not-found  no session matches — `SessionNotFoundError`, a seat's `NoSessionError`, or no selector at all
 *              (`target-unresolved`: the one reason K5 renders as the control pod's "Session not found");
 *   ambiguous  the resolver will not choose between two records — `SessionResolutionError`; `message` is its OWN
 *              sentence (`Session id is ambiguous: <v>` / `Multiple sessions match id: <v>`), never a copy
 *              (`target-ambiguous`);
 *   failed     anything else — a store or I/O error, or a selector acpx refuses as usage (a URL naming both
 *              `?seat=` and `?session=`): `message` is the error's; never a not-found (`target-lookup-failed`).
 */
export type TargetError = { kind: "not-found" | "ambiguous" | "failed"; message?: string };

export type TargetOutcome =
  | { recordId: string; error?: undefined }
  | { recordId: null; error: TargetError };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorOutcome(error: unknown): TargetError {
  if (error instanceof SessionNotFoundError || error instanceof NoSessionError) {
    return { kind: "not-found" };
  }
  if (error instanceof SessionResolutionError) {
    return { kind: "ambiguous", message: error.message };
  }
  return { kind: "failed", message: messageOf(error) };
}

/**
 * Resolve a command's target selector to the session's RECORD id with acpx's own resolver — the same
 * one the command itself would use (record id, ACP id or unique suffix; a seat to its active holder) —
 * and, when it names none, WHY (`TargetError`).
 * ⚠️ HEAVY: loaded by dynamic import only, and only where the route depends on the target (an agent
 * pod). The error is NEVER swallowed into "not found": only a miss is one (A-52).
 */
export async function resolveTargetOutcome(
  target: TargetSelector | undefined,
): Promise<TargetOutcome> {
  if (!target) {
    return { recordId: null, error: { kind: "not-found" } };
  }
  try {
    const record = await resolveSelector(target);
    return record?.acpxRecordId
      ? { recordId: record.acpxRecordId }
      : { recordId: null, error: { kind: "not-found" } };
  } catch (error) {
    return { recordId: null, error: errorOutcome(error) };
  }
}

/** The record id, or `null` for every other outcome: what the routed path and an older atrium read. */
export async function resolveTargetRecordId(
  target: TargetSelector | undefined,
): Promise<string | null> {
  return (await resolveTargetOutcome(target)).recordId;
}

async function resolveSelector(target: TargetSelector) {
  if (target.via === "operand") {
    return await resolveSessionRecord(target.value);
  }
  switch (target.flag) {
    case "--seat":
      return await resolveExplicitSessionRecord({ seat: target.value });
    case "--session-url":
      return await resolveExplicitSessionRecord({ sessionUrl: target.value });
    case "--session": {
      // `people`'s `--session <id|url>`; elsewhere `-s/--session <name>` is refused by the command.
      const fromUrl = parseSessionIdFromUrl(target.value);
      return await resolveSessionRecord(fromUrl ?? target.value);
    }
    default:
      return await resolveExplicitSessionRecord({ sessionId: target.value });
  }
}
