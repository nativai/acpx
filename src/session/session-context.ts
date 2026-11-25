import { resolveOsChoiceForCreate } from "../acp/atrium-os.js";
import type { AgentSessionContext } from "../acp/auth-env.js";
import { resolveAndEnsureAgentFolder } from "../cli/session/agent-folder.js";
import { resolveSessionBrickContext } from "../cli/session/brick-link.js";
import type { RunOnceOptions, SessionCreateOptions } from "../cli/session/contracts.js";
import type { SessionRecord } from "../types.js";
import { normalizeName, sessionBaseDir } from "./persistence.js";
import { principalContextFields } from "./persistence/principal.js";
import { readSeatStore, seatFromStore } from "./persistence/seat-store.js";
import {
  seatNameIsGeneric,
  seatNamingForRecord,
  withVerifiedSeatAutoName,
} from "./seat-display-name.js";

/**
 * The `sessionContext` a RECORD-backed spawn hands its client — every field of `AgentSessionContext`,
 * present, `null` for "nothing". ⚠️ The `-?` is the guard (spec P3a §6, C12): add a field to
 * `AgentSessionContext` and `sessionContextFromRecord` below stops compiling until it sets it. That is
 * what retired the four hand-copied literals (owner, prompt turn, connected session ×2), where a new
 * field had to be remembered four times and the forgotten copy only showed up at runtime.
 * `test/session-context.test.ts` pins the shape against a copy of the old literal.
 */
export type RecordSessionContext = {
  [K in keyof AgentSessionContext]-?: Exclude<AgentSessionContext[K], undefined>;
};

/**
 * THE record-backed context builder (P3a §6). Callers: the queue owner's shared client, the prompt-turn
 * client, `withConnectedSession` (both its `createClient` hook and its own `AcpClient`).
 * `reasoningEffort` is the prompt turn's per-invocation override (the other callers pass none).
 */
// eslint-disable-next-line complexity -- ?? null field-mapping; each chain is load-bearing null safety
export async function sessionContextFromRecord(
  record: SessionRecord,
  opts: { reasoningEffort?: string | null } = {},
): Promise<RecordSessionContext> {
  const seatNaming = await seatNamingForRecord(record);
  const { brick, brickPath } = await resolveSessionBrickContext(record);
  const agentFolders = resolveAndEnsureAgentFolder(record, brickPath);
  return {
    acpxRecordId: record.acpxRecordId,
    sessionName: seatNaming.seatName ?? null,
    seatNameGeneric: seatNaming.generic,
    parentSessionId: record.parentSessionId ?? null,
    parentSessionUrl: record.parentSessionUrl ?? null,
    brick,
    brickPath,
    agentFolder: agentFolders?.agentFolder ?? null,
    seatFolder: agentFolders?.seatFolder ?? null,
    subscriptionId: record.acpx?.session_options?.subscription ?? null,
    profileId: record.acpx?.session_options?.profile ?? null,
    reasoningEffort: opts.reasoningEffort ?? null,
    seatId: record.seatId ?? null,
    seatOrdinal: record.holderOrdinal ?? null,
    parentSeatId: record.parentSeatId ?? null,
    ...principalContextFields(record.metadata),
    osChoice: record.metadata?.atrium_os ?? null,
    osPrimerError: record.metadata?.atrium_os_primer_error ?? null,
  };
}

/** The transient CREATION spawn's context: no record exists yet (moved from session-management.ts). */
// eslint-disable-next-line complexity -- ?? null field-mapping; cannot simplify without losing null safety
export async function creationSessionContext(
  options: SessionCreateOptions,
): Promise<AgentSessionContext> {
  // No record yet, so no record seatId — but a JOIN names its seat (`options.seatId`), and
  // that seat's brick is the one this spawn must carry, not the spawner's ambient value
  // `options.metadata` holds until `createSessionRecordWithClient` reconciles it.
  const { brick, brickPath } = await resolveSessionBrickContext({
    seatId: options.seatId,
    metadata: options.metadata,
  });
  return {
    acpxRecordId: "",
    sessionName: normalizeName(options.seatName) ?? null,
    parentSessionId: options.parentSessionId ?? null,
    // The full parent URL (real host) reaches the bridge at session/new AND becomes
    // ACPX_PARENT_SESSION_URL for this spawn. It is also persisted onto the record
    // (brick://c6e3618b), so later recover/keepwarm spawns reload the real host
    // instead of re-deriving one against the LOCAL base URL — which silently
    // re-hosts a cross-box parent onto this box. (FW-19)
    parentSessionUrl: options.parentSessionUrl ?? null,
    // SEATS (C3/D-B1-9). This session's OWN seatId is deliberately NOT set
    // here: it does not exist yet at this point (minted inside
    // createSessionRecordWithClient's record literal, which runs AFTER this
    // context is built) — same reasoning as acpxRecordId:"" above; it is set
    // from the persisted record on the NEXT spawn. The PARENT's seat id is
    // already resolvable at this point (same-box parent, resolved before
    // createSession was called — see ResolvedParentSession.seatId in
    // command-handlers.ts), so it is available even on this transient spawn,
    // mirroring parentSessionUrl immediately above.
    parentSeatId: options.parentSeatId ?? null,
    brick,
    brickPath,
    agentFolder: null,
    subscriptionId: options.sessionOptions?.subscription ?? null,
    profileId: options.sessionOptions?.profile ?? null,
    // The creation precedence (§2) has already resolved the choice into the metadata the record is
    // born with, so the creation spawn reads it from there.
    osChoice: options.metadata?.atrium_os ?? null,
    seatNameGeneric: await creationSeatNameGeneric(options),
  };
}

/**
 * Brick fac2128a §4.2 — the creation spawn's `seatNameGeneric`. A fresh mint judges the name it is about
 * to store (`-s`, trimmed exactly as the mint trims it) against the metadata the record is born with.
 *
 * 🛑 A JOIN (`options.seatId` — `--seat`, a `--from`/handover successor) READS THE JOINED SEAT. Its
 * `seatName` is ALWAYS absent (`-s` is refused on a join), so the mint rule's "no name ⇒ generic" would
 * mark every named seat's successor generic and its agent would rename a seat a person named. An
 * unreadable store or a missing row answers `false` (fail safe).
 */
async function creationSeatNameGeneric(options: SessionCreateOptions): Promise<boolean> {
  // The marker is judged exactly as the create will store it (`withVerifiedSeatAutoName`, also run by
  // `reconcileSeatAndBrickForCreate`): this context is built BEFORE that reconcile, so reading the raw
  // caller value here would miss a marker the create keeps after its trim (TE finding F6).
  const holderFor = (storedName: string | undefined) => ({
    metadata: withVerifiedSeatAutoName(options.metadata, storedName),
  });
  if (options.seatId === undefined) {
    const name = normalizeName(options.seatName);
    return seatNameIsGeneric({ name }, holderFor(name));
  }
  try {
    const seat = seatFromStore(await readSeatStore(sessionBaseDir()), options.seatId);
    return seat ? seatNameIsGeneric(seat, holderFor(seat.name)) : false;
  } catch {
    return false;
  }
}

/** Creation rules 4/5 for a record-less one-shot (it never refuses: no `--os` on exec). */
function execOsChoice(): string | null {
  const os = resolveOsChoiceForCreate({ creation: "exec" });
  if (!os.ok) {
    return null;
  }
  for (const warning of os.warnings) {
    process.stderr.write(`${warning}\n`);
  }
  return os.choice ?? null;
}

/**
 * `acpx exec`'s context: a one-shot with no record (moved from runtime.ts `runOnce`). It has no
 * parent and no source, so its OS is creation rules 4/5 — the caller's `$ATRIUM_OS`, else default.
 */
export function execSessionContext(options: RunOnceOptions): AgentSessionContext {
  return {
    osChoice: execOsChoice(),
    acpxRecordId: "",
    sessionName: null,
    subscriptionId: options.sessionOptions?.subscription ?? null,
    profileId: options.sessionOptions?.profile ?? null,
    reasoningEffort: options.sessionOptions?.reasoningEffort ?? null,
    // A one-shot has no seat, so nothing for its agent to name.
    seatNameGeneric: false,
  };
}
