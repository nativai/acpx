import { parseSessionIdFromUrl, resolveExplicitSessionRecord } from "../cli/session-selector.js";
import { resolveSessionRecord } from "../session/persistence.js";
import type { TargetSelector } from "./command-classes.js";

/**
 * Resolve a command's target selector to the session's RECORD id with acpx's own resolver — the same
 * one the command itself would use (record id, ACP id or unique suffix; a seat to its active holder).
 * ⚠️ HEAVY: loaded by dynamic import only, and only where the route depends on the target (an agent
 * pod). `null`: the selector names no session acpx can resolve — never "own session".
 */
export async function resolveTargetRecordId(
  target: TargetSelector | undefined,
): Promise<string | null> {
  if (!target) {
    return null;
  }
  try {
    const record = await resolveSelector(target);
    return record?.acpxRecordId || null;
  } catch {
    return null;
  }
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
