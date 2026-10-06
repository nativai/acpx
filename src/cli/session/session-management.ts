import { existsSync } from "node:fs";
import path from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  AcpClient,
  type SessionCreateResult,
  type SessionForkResult,
  type SessionLoadResult,
} from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import {
  assertForkAtIndexHonoured,
  resolveEffectiveForkIndex,
} from "../../acp/harness-capabilities.js";
import { readTransientAdvertisement } from "../../acp/transient-advertisement.js";
import { withInterrupt, withTimeout } from "../../async-control.js";
import { AcpxOperationalError } from "../../errors.js";
import { bindDefaultAccountToSessionOptionsAsync } from "../../runtime/engine/default-account-binding.js";
import { applyLifecycleSnapshotToRecord } from "../../runtime/engine/lifecycle.js";
import { persistSessionOptions } from "../../runtime/engine/session-options.js";
import {
  persistAndApplyRequestedEffort,
  persistRequestedOutputStyle,
} from "../../session/config-option-application.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { createSessionConversation } from "../../session/conversation-model.js";
import { withDefaultModelForNewSession } from "../../session/default-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import {
  setCurrentModelId,
  setDesiredModelId,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import {
  advertisedAfterModelApply,
  applyRequestedModelIfAdvertised,
  type ModelApplyOutcome,
  modesAfterModelApply,
} from "../../session/model-application.js";
import {
  mirrorModelGuardToMessages,
  stampModelGuardBreadcrumb,
} from "../../session/model-guard.js";
import { reportOperatorDiagnostic } from "../../session/operator-diagnostic.js";
import {
  availableOutputStyles,
  findAdvertisedOutputStyleOption,
  stampAppliedOutputStyle,
  withSupportedOutputStyleOnly,
} from "../../session/output-style.js";
import { persistSessionOwnerOptions } from "../../session/owner-options.js";
import {
  absolutePath,
  isoNow,
  mintSeatRowBestEffort,
  normalizeName,
  readSeatStore,
  resolveSessionRecord,
  seatBrickLinkFromRef,
  seatFromStore,
  SeatRowMissingError,
  sessionBaseDir,
  sessionRecordFileName,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
  type SeatBrickLink,
  type SeatRecord,
} from "../../session/persistence.js";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import { explainSeatRowMissing } from "../../session/seat-backfill.js";
import { withBrickCache } from "../../session/seat-brick.js";
import type { SessionRecord } from "../../types.js";
import { resolveSessionBrickContext } from "./brick-link.js";
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "./contracts.js";
import type {
  AgentOutputStyleListOptions,
  AgentOutputStyleListResult,
  SessionCreateOptions,
  SessionCreateWithClientResult,
  SessionListOptions,
  SessionListResult,
} from "./contracts.js";

// brick://5bac5564 Layer B belt inputs — the pin + its provenance from the create
// options, spread into applyRequestedModelIfAdvertised. Extracted so the resume /
// fork call sites stay under the lint complexity budget.
function modelApplyParamsFromOptions(options: SessionCreateOptions): {
  requestedModel: string | undefined;
  reasoningEffort: string | undefined;
  modelSource: string | undefined;
} {
  return {
    requestedModel: options.sessionOptions?.model,
    reasoningEffort: options.sessionOptions?.reasoningEffort,
    modelSource: options.sessionOptions?.modelSource,
  };
}

// brick://5bac5564 Layer B: when the resolution-tier guard rewrote an implicit Fable,
// return the {blocked, forcedTo} pair for the loud breadcrumb + messages mirror. The
// pre-guard provenance of a guard-forced spawn/copy is deterministically "inherited"
// (the guard only fires when a Fable value arrived via inheritance; an explicit Fable
// is preserved and "default" never yields Fable) — stamped by the caller.
function spawnGuardForcedInfo(
  sessionOptions: SessionCreateOptions["sessionOptions"],
): { blocked: string; forcedTo: string } | undefined {
  if (sessionOptions?.modelSource !== "guard-forced") {
    return undefined;
  }
  const blocked = sessionOptions.modelGuardBlocked;
  const forcedTo = sessionOptions.model;
  return blocked && forcedTo ? { blocked, forcedTo } : undefined;
}

/**
 * The seat fields a NEWLY CREATED record carries (D11, brick b64dfbb3).
 *
 * Two shapes, and the difference between them is the whole of D11:
 *
 * - **no `--seat` (the default, unchanged):** mint a fresh seat, `holderOrdinal: 1`,
 *   `holderActive: true`. B1's behaviour byte for byte.
 * - **`--seat <ref>`:** join that seat **PREPARED BUT NOT ACTIVE** —
 *   `holderActive: false` and **NO `holderOrdinal` AT ALL**.
 *
 * ⚠️ THE ABSENT ORDINAL IS LOAD-BEARING, NOT AN OMISSION. The ordinal is drawn from
 * the seat's stored `next_ordinal` counter at ACTIVATION (§2.7 phase 2.4), inside the
 * one hold that also moves the pointer — so allocating one here would burn a number
 * for a holder that may never be activated, and Daniel's guarantee is that a number
 * is never RE-ISSUED. The activation heal relies on the absence directly: its branch
 * is *"`N` still lacks a `holderOrdinal` ⇒ allocate a fresh one"*, which is how a
 * crash between the counter write and the successor write is repaired. C2's
 * *absence is a value* makes a missing field persist as missing, so this survives
 * the round trip rather than being defaulted back to 1 by a reader.
 *
 * ⚠️ AND IT MUST NOT BE ACTIVE. Preparation is cheap and non-exclusive; ACTIVATION is
 * exclusive. Two *prepared* holders on one seat is a supported state — a succession
 * creates the successor while the predecessor is still active — and only `activate`
 * may set the flag.
 */
function seatFieldsForCreate(
  joinSeatId: string | undefined,
): Pick<SessionRecord, "seatId" | "holderOrdinal" | "holderActive"> {
  if (joinSeatId === undefined) {
    return { seatId: crypto.randomUUID(), holderOrdinal: 1, holderActive: true };
  }
  return { seatId: joinSeatId, holderActive: false };
}

/**
 * 🛑 `--seat` ON A FORK OR COPY IS REFUSED LOUDLY — never ignored, never honoured.
 *
 * Daniel, 2026-09-22 (topic 1, binding): **every fork mints a new seat, no
 * exceptions** — including byways and template spawns. A fork is a divergent copy of
 * a transcript; letting it join an existing seat would make two sessions with
 * different histories claim the same identity, which is the mis-seating D11's whole
 * asymmetry exists to prevent.
 *
 * ⚠️ **CURRENTLY UNREACHABLE THROUGH THE CLI, BY CONSTRUCTION — AND KEPT DELIBERATELY**
 * (finding F4). `seatId` reaches the create options only from the `sessions new` builder
 * and `forkFromSessionId` only from the `copy` builder — two separate object literals —
 * so nothing sets both today, and what actually refuses `sessions copy --seat` is
 * commander rejecting an unregistered option. This guard is defence-in-depth for the
 * in-process/library path.
 *
 * 🛑 **REGISTERING `--seat` ON `copy` IS DELIBERATELY NOT DONE, AND THE REASON IS FAILURE
 * MODES RATHER THAN MESSAGE QUALITY.** Today the refusal is STRUCTURAL: the parser does
 * not know the flag on that verb, so `copy --seat` cannot reach any code — **a
 * parser-level barrier cannot regress silently.** Register it and the barrier becomes a
 * RUNTIME CHECK, and if that check ever regresses, `copy --seat X` **silently joins a
 * seat** — violating Daniel's binding ruling that every fork mints a new seat, and
 * reproducing exactly the defect the restored G2/path-2 row exists to catch. A better
 * message is worth having; it is not worth that price.
 *
 * ⇒ **SEQUENCED, NOT REJECTED.** Now that this guard is actually tested (below), the UX
 * improvement becomes a *safe* follow-up with a real test behind it, rather than a swap
 * that promotes an untested path to load-bearing. A later block's to take, with the AP13
 * row updated in the same change.
 *
 * 🛑 IT IS TESTED DIRECTLY, because it has to be: no CLI invocation can reach it, and the
 * AP13 row that looks like its test is actually asserting the flag registration.
 * `seat-creation-paths.test.ts` carries both — one row pinned to commander's
 * unknown-option wording so the protection cannot change hands silently, and one driving
 * this function through `createSession` with both fields set.
 *
 * ⚠️ WHY A THROW AND NOT A SILENT IGNORE. The mint seam is shared between the normal
 * and fork/copy paths, so the tempting `seatId ?? randomUUID()` would honour the flag
 * on a fork; the tempting "fix" is to drop the flag on that path instead. **Both are
 * wrong in the same way**: the operator asked for something the system will not do,
 * and neither variant tells them. A silently-ignored flag leaves them believing the
 * session joined a seat it did not, which is a wrong belief about identity — exactly
 * the class that never surfaces as an error.
 */
function refuseSeatJoinOnForkPath(options: SessionCreateOptions): void {
  if (options.seatId === undefined || options.forkFromSessionId === undefined) {
    return;
  }
  throw new Error(
    `--seat cannot be combined with a fork or copy: every fork mints a NEW seat, no ` +
      `exceptions (Daniel, 2026-09-22). Requested seat ${JSON.stringify(options.seatId)} ` +
      `for a session forked from ${JSON.stringify(options.forkFromSessionId)}. A forked ` +
      `session is a divergent copy of a transcript; if you want a holder in that seat, ` +
      `create one with \`sessions new --seat\` instead of copying an existing session.`,
  );
}

/**
 * `-s` names a SEAT AT CREATION (D-IDENTITY, brick 61dc1302, AC-ID4). On a join the seat
 * already exists and already has its name, so the flag has no seat to name: REFUSED, with
 * the verb that does rename a seat — never accepted and ignored, which would leave the
 * operator believing they had named something.
 */
function refuseSeatNameOnJoin(options: SessionCreateOptions): void {
  if (options.seatId === undefined || normalizeName(options.seatName) === undefined) {
    return;
  }
  throw new Error(
    `-s/--name cannot be combined with --seat: ${JSON.stringify(options.seatId)} already has ` +
      `its name, and -s names a seat only when \`sessions new\` creates one. Rename an ` +
      `existing seat with \`acpx seats rename\`.`,
  );
}

/**
 * The remaining `--seat` refusals, all BEFORE any write (D11).
 *
 * 🛑 **THE SEAT MUST ALREADY EXIST — JOINING NEVER MINTS ONE AS A SIDE EFFECT.** That
 * is the refusal that matters most here: a typo'd seat id which silently created the
 * seat it named would produce a seat nobody meant, holding a session that believes it
 * belongs there, and nothing downstream could tell — a mis-seated session is a wrong
 * identity that every later block inherits, with no signature to detect and no re-run
 * that repairs it. `seatFromStore` distinguishes the three states for us: a
 * `MalformedSeatRowError` propagates as itself, because "present but unreadable" must
 * never be reported as "no such seat" — a caller told the latter goes on to create one.
 *
 * ⚠️ NOT CHECKED HERE, AND STATED RATHER THAN QUIETLY SKIPPED: B1 ruling 4's *all
 * holders of a seat share one kind*. Checking it needs an enumeration of the seat's
 * existing holders — a scan for `seatId === s` over the index — and the seat record
 * deliberately carries no holder list (the field set is closed at seven). That scan is
 * the one the seat store exists to remove from hot paths, and the protocol confines it
 * to the heal path. It is also unreachable today: the only two kinds are `session` and
 * the `subagent` shadow record, and `runtime.ts`'s subagent path is never CLI-driven,
 * so no `--seat` can reach it. ⇒ deferred deliberately, with the cost named; it wants
 * a ruling on where the holder enumeration is allowed to live, not a scan added here
 * on my own judgement.
 */
async function refuseUnjoinableSeat(
  joinSeatId: string | undefined,
): Promise<SeatRecord | undefined> {
  if (joinSeatId === undefined) {
    return undefined;
  }
  const store = await readSeatStore(sessionBaseDir());
  const seat = seatFromStore(store, joinSeatId);
  if (!seat) {
    // AP17 — THE REFUSAL DIAGNOSES. The shared message names the cause and the remedy, and
    // the remedy follows the ORIGIN (brick `bf454a2c`): a seat id some record carries
    // PREDATES the store or lost its row write (B10's backfill population) and is sent to
    // the backfill; an id no record carries is a typo and is told to check the id.
    throw new Error(
      `${await explainSeatRowMissing(new SeatRowMissingError(joinSeatId, store.storePath))} ` +
        `Joining NEVER creates a seat as a side effect — a mistyped id that minted the seat ` +
        `it named would leave a session sitting in a seat nobody meant, and nothing ` +
        `downstream can tell that apart from a session in the right one. Omit --seat to mint ` +
        `a fresh seat for this session.`,
    );
  }
  if (seat.closedAt !== null && seat.closedAt !== undefined) {
    // `detailCode: "SEAT_CLOSED"` — the SAME code `seat-activate.ts`'s
    // `SeatActivationRefusalError` uses for the identical fact ("this seat is
    // closed"). Overrule (L0, 2026-09-29): a code-less refusal forces callers to
    // match on PROSE, and this programme has twice ruled that callers branch on
    // CODES. `SEAT_CLOSED` is right here because the condition IS the same fact
    // `seat-activate.ts` already reports under it — and the COMMAND, not the
    // message, is what says which entry point refused: this is create-into-seat,
    // that is activation, which is F4's discrimination requirement.
    throw new AcpxOperationalError(
      `seat ${JSON.stringify(joinSeatId)} was closed at ${seat.closedAt} — the seat is ` +
        `abolished and takes no further holders. This is not the same as the seat being ` +
        `vacant: a vacant seat (no active holder) still accepts one.`,
      { outputCode: "RUNTIME", detailCode: "SEAT_CLOSED", origin: "runtime" },
    );
  }
  // Returned (rather than re-read by the caller) so the ONE store read taken here
  // is also what `resolveJoinedSeatBrickMetadata` reconciles against — a second,
  // independent read could race a concurrent `seats set-brick` and compare the
  // explicit flag against a seat that already moved.
  return seat;
}

/**
 * F2 (brick `3dff714d`) — the brick-reconciliation half of joining a seat,
 * ruled in `DECISIONS.md` (b) and its AMENDMENT (the join path's complete
 * truth table, added after the independent test-engineer measured three
 * states the original three-leg ruling never addressed). **Seven rows, not
 * three** — implement all seven, not the shape that reads as "the fix":
 *
 * | seat `brick_id` | spawner's flag      | outcome                                    |
 * |---|---|---|
 * | `B` | `--brick B` (agrees) | accept, no diagnostic — idempotent            |
 * | `B` | `--brick A`, A≠B     | REFUSE at the origin                          |
 * | `B` | `--no-brick`         | REFUSE at the origin — same family (S4c)      |
 * | `B` | none                 | holder gets `B` — seat wins, spawner ignored  |
 * | absent | `--brick A`       | accept, holder gets `A` — the SEAT IS NOT WRITTEN |
 * | absent | `--no-brick`      | accept, holder gets nothing — agrees w/ seat  |
 * | absent | none              | holder gets the SPAWNER's ambient brick — **today's behaviour, preserved** |
 *
 * 🛑 **S4a — WHY THE LAST ROW IS NOT A BUG LEFT IN.** By F1, brick-less seats
 * are the DOMINANT population right now (every seat minted before this fix,
 * and every fresh seat minted with no `--brick`). A strict "the seat wins,
 * period" reading would make every ordinary handover spawn into one of those
 * seats **silently lose its brick link** — worse than the measured defect, on
 * the common path. Absence means UNKNOWN here, not "none" — this codebase has
 * already settled that twice on this exact surface (`mintSeatRow`'s
 * `brickId: undefined` is omitted, never an empty string; the sibling
 * `parentSeatId` field's own comment: *"absent means unknown, never no
 * seat"*) — so a brick-less seat is not an authority asserting "none", and
 * there is nothing for a holder to disagree with. `--seat` must never WRITE
 * the seat as a side effect of this fallback (joining never mints, D11); a
 * legacy seat's absence is healed by `acpx seats backfill`, not by a spawn —
 * **true only as of item (d) in this same change** (`seat-backfill.ts`'s
 * `planSeatRow`), which derives `brick_id` from the active holder's own
 * `metadata.brick`. Before (d), `backfill` mints the row and leaves
 * `brick_id` absent — a THIRD site of F1's pattern, not a pre-existing
 * remedy; that gap is the reason (d) exists at all.
 *
 * `childMetadata` here is `buildSessionStartOptions`'s FULLY INHERITANCE-
 * APPLIED value — i.e. it already carries the spawner's ambient brick when
 * nothing was said explicitly, which is exactly the "absent seat, none" row's
 * answer and exactly what the "seat HAS a brick" rows must OVERRIDE.
 * `explicitBrickFlag` is the one signal `childMetadata` cannot provide:
 * whether the operator SAID something (`string` = `--brick <uuid>`, `false` =
 * `--no-brick`) or said nothing at all (`undefined`).
 */
/**
 * Invariant (i), brick `9984c510`: PROPAGATE THE REF WITH ITS STATE — nothing
 * lost, nothing laundered. A holder joining a seat whose link is UNVALIDATED
 * must not end up holding something indistinguishable from a validated one.
 * `metadata` is `Record<string,string>` only, so the state rides a SECOND
 * string key: `brick_validation: "validated" | "unvalidated"`.
 *
 * 🛑 **WRITTEN WHENEVER THE REF IS, FOR BOTH STATES — NEVER OMITTED FOR
 * "VALIDATED".** A first cut omitted the key for the validated case (mirroring
 * the on-disk `brick_id_validated` sibling's own omit-unless-needed shape) and
 * that is a REJECTED design, not a style choice: on the seat row, ABSENCE
 * means UNVALIDATED (ii); on the holder, an omit-when-validated shape would
 * have made absence mean the OPPOSITE — validated. Every pre-fix holder
 * record carries no such key at all, so that shape would read the ENTIRE
 * existing population as validated-by-assumption, which is exactly what this
 * brick exists to stop — moved one hop, from the seat onto the holder.
 * Writing the word unconditionally makes ABSENCE MEAN UNKNOWN on BOTH sides —
 * no link at all, or a holder that predates this brick — never "validated".
 *
 * 🛑 **A WORD, NOT A BOOLEAN-STRING.** `"false"` is a non-empty string and
 * therefore TRUTHY — a consumer writing `if (md.brick_validation)` would read
 * the one value that means "do not trust this" as true. `"validated"` /
 * `"unvalidated"` are both truthy, so a careless truthiness check tells a
 * reader nothing and an explicit string comparison is forced by construction.
 *
 * ⚠️ **SNAKE_CASE, NOT CAMEL — MEASURED, NOT A STYLE CHOICE.** A first cut
 * wrote `brickValidated` and `assertPersistedKeyPolicy` (`persisted-key-
 * policy.ts`) rejected the whole spawn at write time with "Persisted key
 * policy violation (expected snake_case keys): metadata.brickValidated" —
 * the policy walks EVERY persisted key, `metadata` included, with no
 * exemption for this field. Caught by actually running the CLI, not by
 * typecheck (metadata values are plain strings either way).
 *
 * 🔑 **A WORD HERE, A REAL BOOLEAN ON THE SEAT (`seat-store.ts`'s
 * `SeatBrickLink.validated`) — DELIBERATE, NOT AN INCONSISTENCY TO
 * HARMONISE.** The seat's field is a typed JSON `boolean`, read only by
 * EQUALITY and REJECTED when malformed, so it carries no truthy-string trap;
 * `metadata` has no such protection — it is `Record<string,string>`, where
 * `"false"` is truthy. Collapsing the SEAT side to a word would be harmless;
 * collapsing THIS side to a boolean-string reintroduces the exact trap this
 * comment opens with.
 */
function metadataWithSeatBrickLink(
  childMetadata: Record<string, string> | undefined,
  link: SeatBrickLink,
): Record<string, string> | undefined {
  // Drops any stale `brick_validation` the child might already carry (no legitimate source for
  // one before the seat's link is applied) — and spells the pair through the ONE helper.
  return withBrickCache(childMetadata, link) ?? {};
}

/**
 * Brick `9984c510`, TE Finding 2 / Gap B — the MINT path's own twin of
 * {@link metadataWithSeatBrickLink}, which only `resolveJoinedSeatBrickMetadata`
 * (the JOIN path) called. Measured gap: a real `sessions new --brick <uuid>
 * --metadata brick_validation=validated` on the DEGRADED leg left the seat
 * correctly `brick_id_validated=false` while the FOUNDING holder's own record
 * said `{"brick_validation":"validated"}` — the forged word survived because
 * nothing on this path ever strips it, and the identical forgery on the JOIN
 * path is already overridden. Same input, two write paths, opposite outcomes.
 *
 * Fixes BOTH halves in one call, applied to `options.metadata` BEFORE the
 * record literal is built (mirroring exactly where the join path reassigns
 * `options.metadata`), so there is one strip/write site per path, not two:
 *
 * 1. **STRIP.** `metadataWithSeatBrickLink`'s own docstring already states
 *    the principle ("no legitimate source for one before the link is
 *    applied") — this path skipped it; apply it here too, independent of
 *    whether a link exists at all (a forged word with NO ref is equally
 *    nonsensical, and `link` being `undefined` must not leave it standing).
 * 2. **WRITE WHEN KNOWN.** Ratified: the word is "always written when the
 *    state is known", precisely so absence means UNKNOWN everywhere. The
 *    mint path DOES know — `link` is derived from the same resolver leg the
 *    seat's own `brick_id_validated` comes from — so withholding it here
 *    created exactly the asymmetry the ruling forbids: a joining holder gets
 *    the word, the founding holder never does, and the degraded leg
 *    overwhelmingly hits the FOUNDING spawn in production.
 *
 * `link === undefined` ⇒ no brick at all for this mint; strip only, and
 * collapse back to `undefined` (never a stray `{}`) when nothing is left —
 * the same omit-when-empty convention `withoutBrickMetadata` already uses
 * one function over.
 */
function metadataWithMintTimeBrickState(
  childMetadata: Record<string, string> | undefined,
  link: SeatBrickLink | undefined,
): Record<string, string> | undefined {
  if (link !== undefined) {
    return metadataWithSeatBrickLink(childMetadata, link);
  }
  const { brick_validation: _stale, ...rest } = childMetadata ?? {};
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function resolveJoinedSeatBrickMetadata(
  childMetadata: Record<string, string> | undefined,
  explicitBrickFlag: string | false | undefined,
  joinedSeatId: string,
  seatBrickId: SeatBrickLink | undefined,
): Record<string, string> | undefined {
  if (seatBrickId === undefined) {
    // The seat is BRICK-LESS: absence is UNKNOWN, not "none" (S4a). Nothing to
    // override — `childMetadata` already carries the right answer for all
    // three sub-rows (explicit --brick, explicit --no-brick, or the ambient
    // ACPX_SESSION_URL fallback), and the seat is left byte-unwritten.
    return childMetadata;
  }
  if (explicitBrickFlag === false) {
    // S4c — `--no-brick` against a seat that CARRIES a brick is an explicit
    // instruction contradicting the canonical field, same refusal family as a
    // disagreeing --brick: asking for a holder that disagrees with its own
    // seat is incoherent under C4.
    throw new AcpxOperationalError(
      `--no-brick disagrees with seat ${JSON.stringify(joinedSeatId)}'s brick ` +
        `${JSON.stringify(seatBrickId.ref)}. The SEAT's brick_id is canonical (CONCEPTION C4) — a ` +
        `spawn cannot silently unlink it. Either spawn a fresh, unlinked seat (no --seat, no --from), ` +
        `or run \`acpx seats set-brick ${joinedSeatId} --unset\` first and re-spawn.`,
      { outputCode: "USAGE", detailCode: "SEAT_BRICK_MISMATCH", origin: "runtime" },
    );
  }
  if (typeof explicitBrickFlag === "string") {
    const explicit = explicitBrickFlag.trim();
    if (explicit !== seatBrickId.ref) {
      throw new AcpxOperationalError(
        `--brick ${JSON.stringify(explicit)} disagrees with seat ${JSON.stringify(joinedSeatId)}'s ` +
          `brick ${JSON.stringify(seatBrickId.ref)}. The SEAT's brick_id is canonical (CONCEPTION C4) — ` +
          `a spawn cannot silently re-point it. Either run \`acpx seats set-brick ${joinedSeatId} ` +
          `${explicit}\` first and re-spawn, or drop --brick to join under the seat's own brick.`,
        { outputCode: "USAGE", detailCode: "SEAT_BRICK_MISMATCH", origin: "runtime" },
      );
    }
    // X === Y: accept, no diagnostic — idempotent restatement.
    return metadataWithSeatBrickLink(childMetadata, seatBrickId);
  }
  // No flag at all, seat HAS a brick: the seat wins SILENTLY, overriding
  // whatever ambient value `childMetadata` carried — this is the leg that
  // fired in Daniel's measured F2 run (a real handover spawn never carries
  // `--brick`).
  return metadataWithSeatBrickLink(childMetadata, seatBrickId);
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
async function createSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
): Promise<SessionRecord> {
  const cwd = absolutePath(options.cwd);
  // BEFORE ANY WRITE, AND BEFORE THE AGENT IS EVEN STARTED (D11). A refusal that
  // fired after `client.start()` would leave a spawned adapter behind for a request
  // that was never going to be honoured.
  refuseSeatJoinOnForkPath(options);
  refuseSeatNameOnJoin(options);
  const joinedSeat = await refuseUnjoinableSeat(options.seatId);
  if (joinedSeat) {
    // F2 fix (brick 3dff714d, DECISIONS.md (b) + AMENDMENT) — reconcile
    // BEFORE anything is created, same guarantee as the refusals just above.
    // `options.seatId` is only set on the join path, so a fresh mint never
    // reaches this branch and keeps its existing withInheritedBrick-derived
    // metadata untouched.
    options = {
      ...options,
      metadata: resolveJoinedSeatBrickMetadata(
        options.metadata,
        options.explicitBrickFlag,
        joinedSeat.seatId,
        joinedSeat.brickId,
      ),
    };
  } else {
    // Brick `9984c510`, TE Finding 2 / Gap B — the MINT path's twin of the
    // join branch above. `joinedSeat === undefined` here means this spawn
    // mints a fresh seat (`sessions new` with no `--seat`, or any copy/fork
    // — `refuseSeatJoinOnForkPath` above already guarantees fork never joins),
    // so the founding holder's own metadata must get the SAME strip-forged /
    // write-when-known treatment the join path gets, applied BEFORE the
    // record literal is built from `options.metadata` below.
    options = {
      ...options,
      metadata: metadataWithMintTimeBrickState(
        options.metadata,
        seatBrickLinkFromRef(options.metadata?.brick, options.explicitBrickFlagValidated === true),
      ),
    };
  }
  if (options.recordId) {
    // A plain existence check — it must not open the spawn ledger (that took the box-wide
    // SQLite write lock on every session creation, brick 750d674d).
    if (existsSync(path.join(sessionBaseDir(), sessionRecordFileName(options.recordId)))) {
      throw new Error(
        "record-id destination already exists; refusing to create another ACP session",
      );
    }
  }
  await withTimeout(client.start(), options.timeoutMs);
  let sessionId: string;
  let acpSessionId: string;
  let agentSessionId: string | undefined;
  let sessionResult: SessionCreateResult | SessionLoadResult | SessionForkResult;
  let sessionModels: SessionCreateResult["models"];
  let modelApply: ModelApplyOutcome = { applied: false };
  let deferForkModel: string | undefined;
  let effectiveSessionOptions = options.sessionOptions;
  let forkContext:
    | {
        sourceRecord: SessionRecord;
        forkAtMessageIndex: number;
        requestedForkAtMessageIndex?: number;
        messages: SessionRecord["messages"];
      }
    | undefined;

  if (options.resumeSessionId) {
    const resumed = await resumeSessionRecordWithClient(client, options, cwd);
    sessionId = resumed.sessionId;
    acpSessionId = resumed.acpSessionId;
    agentSessionId = resumed.agentSessionId;
    sessionResult = resumed.sessionResult;
    sessionModels = resumed.sessionModels;
    modelApply = resumed.modelApply;
  } else if (options.forkFromSessionId) {
    const forked = await forkSessionRecordWithClient(client, options, cwd);
    sessionId = forked.sessionId;
    acpSessionId = forked.acpSessionId;
    agentSessionId = forked.agentSessionId;
    sessionResult = forked.sessionResult;
    sessionModels = forked.sessionModels;
    modelApply = forked.modelApply;
    deferForkModel = forked.deferForkModel;
    forkContext = forked.forkContext;
  } else {
    effectiveSessionOptions = withDefaultModelForNewSession(
      options.agentCommand,
      options.sessionOptions,
    );
    const createdSession = await withTimeout(client.createSession(cwd), options.timeoutMs);
    sessionId = createdSession.sessionId;
    acpSessionId = sessionId;
    agentSessionId = normalizeRuntimeSessionId(createdSession.agentSessionId);
    sessionResult = createdSession;
    sessionModels = createdSession.models;
    modelApply = await applyRequestedModelIfAdvertised({
      client,
      sessionId,
      requestedModel: effectiveSessionOptions?.model,
      reasoningEffort: effectiveSessionOptions?.reasoningEffort,
      modelSource: effectiveSessionOptions?.modelSource,
      models: sessionModels,
      advertisedConfigOptions: createdSession.configOptions,
      agentCommand: options.agentCommand,
      timeoutMs: options.timeoutMs,
    });
  }
  if (modelApply.effectiveModelId !== undefined && effectiveSessionOptions !== undefined) {
    effectiveSessionOptions = { ...effectiveSessionOptions, model: modelApply.effectiveModelId };
  }
  const requestedModelApplied = modelApply.applied;
  // ⚠️ THE POST-MODEL RE-READ (CONCEPTION §5.2). Everything below that asks
  // "what does this session advertise?" must ask it of the advertisement that
  // exists AFTER the model was applied, never of the `session/new` snapshot.
  //
  // A per-model ladder advertises the `effort` option ONLY when the
  // currently-selected model reasons, so at `session/new` under a non-reasoning
  // default it is ABSENT. Read the snapshot and `--reasoning-effort` silently never fires —
  // and, because `session/set_config_option` answers with a refreshed
  // advertisement, the corrected reading costs no extra round-trip.
  //
  // ⚠️ DO NOT "simplify" this to `modelApply.refreshedConfigOptions` alone. A
  // `set-model` harness returns nothing to re-read, so `undefined` there means
  // "keep the snapshot", not "nothing is advertised" — collapsing the two would
  // delete claude's working depth path. Test:
  // `test/model-application.test.ts` → "a set-model harness keeps the
  // session/new advertisement".
  const advertisedAfterModel = advertisedAfterModelApply(modelApply, sessionResult.configOptions);

  const lifecycle = client.getAgentLifecycleSnapshot();
  const now = isoNow();
  const conversation = createSessionConversation(now);
  const desiredConfigOptions = cloneDesiredConfigOptions(options.desiredConfigOptions);
  if (forkContext) {
    conversation.messages = structuredClone(forkContext.messages);
  }
  // Hoisted out of the record literal so the SEAT ID is in hand before either write —
  // D13a needs the row written first, and it cannot name its holder without both ids.
  const seatFields = seatFieldsForCreate(options.seatId);
  const record: SessionRecord = {
    schema: "acpx.session.v1",
    acpxRecordId: options.recordId ?? sessionId,
    acpSessionId,
    agentSessionId,
    agentName: options.agentName,
    agentCommand: options.agentCommand,
    cwd,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: defaultSessionEventLog(options.recordId ?? sessionId),
    closed: false,
    closedAt: undefined,
    pid: lifecycle.running ? lifecycle.pid : undefined,
    agentStartedAt: lifecycle.startedAt,
    protocolVersion: client.initializeResult?.protocolVersion,
    agentCapabilities: client.initializeResult?.agentCapabilities,
    ...conversation,
    acpx: desiredConfigOptions ? { desired_config_options: desiredConfigOptions } : {},
    // SEATS (brick 5ad22d5d, D-B1-6/D-B1-7; join added by B2/D11, brick b64dfbb3).
    // This literal is the SHARED seam for BOTH the normal-create path AND the
    // fork/copy path (forkContext is set above when options.forkFromSessionId was
    // given) — which is what lets one edit cover seat-creation paths 1 and 2.
    //
    // 🛑 AND THAT SHARED SEAM IS EXACTLY THE TRAP D11 WARNS ABOUT. The naive
    // version of the join — `seatId: options.seatId ?? crypto.randomUUID()` — reads
    // like the obvious edit and would let `sessions copy --seat X` (and a fork)
    // SILENTLY JOIN a seat, violating Daniel's topic-1 ruling that every fork mints
    // a new seat, NO EXCEPTIONS (2026-09-22). `refuseSeatJoinOnForkPath` above has
    // already thrown for that combination, so by here the join is known legitimate:
    // a silently-ignored flag and a silently-honoured one are both worse than an
    // error, and this is the line where the difference is decided.
    //
    // A fork therefore still NEVER inherits the source's seat — it mints, exactly as
    // before. The default is unchanged byte for byte when `--seat` is absent.
    ...seatFields,
    ...(forkContext
      ? {
          kind: "session" as const,
          forkedFromSessionId: forkContext.sourceRecord.acpxRecordId,
          // EFFECTIVE, not requested — see resolveForkSourceContext.
          forkedAtMessageIndex: forkContext.forkAtMessageIndex,
          ...(forkContext.requestedForkAtMessageIndex === undefined
            ? {}
            : { forkedAtMessageIndexRequested: forkContext.requestedForkAtMessageIndex }),
        }
      : {}),
    ...(options.parentSessionId
      ? {
          kind: "session" as const,
          parentSessionId: options.parentSessionId,
          // Persist the parent's FULL url when we were given one. Without this the
          // record keeps only the bare uuid, and a CROSS-BOX parent becomes
          // unidentifiable the moment the spawn ends: the id resolves against
          // whichever box happens to read it. (brick://c6e3618b)
          ...(options.parentSessionUrl?.trim()
            ? { parentSessionUrl: options.parentSessionUrl.trim() }
            : {}),
          // Mirrors parentSessionUrl immediately above, for the seat sibling
          // (C3/D-B1-9): captured once at creation from the parent record then
          // in hand (same-box only — see ResolvedParentSession.seatId in
          // command-handlers.ts), used to compose ACPX_PARENT_SEAT_URL on
          // every subsequent spawn of THIS record.
          ...(options.parentSeatId?.trim() ? { parentSeatId: options.parentSeatId.trim() } : {}),
        }
      : {}),
    ...(options.metadata && Object.keys(options.metadata).length > 0
      ? { metadata: { ...options.metadata } }
      : {}),
  };

  if (record.metadata?.spawn_key) {
    record.metadata.spawn_state = "pending";
  }

  // NOTE: the config-dir channel (brick fa2e54ec) is written by
  // applyLifecycleSnapshotToRecord itself, from the snapshot — deliberately NOT
  // by a second call here. It must be refreshed at EVERY spawn, and routing it
  // through the snapshot means a new spawn site cannot forget it.
  applyLifecycleSnapshotToRecord(record, lifecycle);
  // brick://874fee67 F3 — strip a style this agent does not support BEFORE the
  // first write. Every later write (persist, validate, stamp) reads this same
  // filtered value, so the "no write on an unsupported agent" rule cannot be
  // missed by one site while another honours it. All three creation branches
  // above (new / copy-fork / resume) funnel through here.
  effectiveSessionOptions = withSupportedOutputStyleOnly(
    effectiveSessionOptions,
    advertisedAfterModel,
  );
  persistSessionOptions(record, effectiveSessionOptions);
  persistSessionOwnerOptions(record, options);
  // Capture the POST-MODEL advertisement, not the `session/new` one: the record's
  // `acpx.config_options` is what `resolveHarnessCapabilities` narrows the
  // declared descriptor with, so storing the stale snapshot would show the depth
  // control as unavailable on a session that had just been pinned to a reasoning
  // model — the exact confusion the re-read exists to remove.
  applyConfigOptionsToRecord(record, { configOptions: advertisedAfterModel });
  await persistAndApplyRequestedEffort({
    client,
    sessionId,
    record,
    reasoningEffort: effectiveSessionOptions?.reasoningEffort,
    advertised: advertisedAfterModel,
    // POST-model, for exactly the reason stated three lines above about config
    // options — and this is the field where getting it wrong was measurable:
    // for a `mode`-mechanism harness the ACP mode advertisement IS the depth
    // ladder and pi's is per model, so `sessionResult.modes` projected every
    // request onto pi's DEFAULT model's ladder. See `modesAfterModelApply`.
    modes: modesAfterModelApply(sessionResult.modes, advertisedAfterModel),
    agentCommand: options.agentCommand,
    modelId: effectiveSessionOptions?.model,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
  // brick://874fee67: validate + persist the requested style. NOTE there is no
  // apply step and that is deliberate (R-6 #1) — the style already reached the
  // adapter in the creation `_meta`, which is what the query was BUILT with, so
  // it is in force from turn 1. This is the advertised-gated validation + write.
  persistRequestedOutputStyle({
    record,
    outputStyle: effectiveSessionOptions?.outputStyle,
    advertised: advertisedAfterModel,
    agentLabel: options.agentName ?? options.agentCommand,
  });
  // brick://874fee67 turn-boundary spec §3: stamp what the query we just built
  // was handed — AFTER the create/resume/fork succeeded, and UNCONDITIONALLY
  // (including for the default). Skip it and `outputStyleChangePending` reads a
  // brand-new unstyled session as already-pending, recycling its owner on the
  // first turn for nothing.
  stampAppliedOutputStyle(record, effectiveSessionOptions?.outputStyle);
  syncAdvertisedModelState(record, sessionModels);
  if (requestedModelApplied) {
    setCurrentModelId(record, effectiveSessionOptions?.model);
  }
  // Durable Claude fork: the creation-time set_model was skipped (the durable id
  // is not adapter-registered yet). Persist the inherited source model onto the
  // record so the UI shows it immediately (current_model_id) and the open-time
  // replay applies it on the first proper resume (desired via session_options.model,
  // read by getDesiredModelId). Runs after syncAdvertisedModelState so it is not
  // clobbered by the advertised default. Fork brick 29efbe0c.
  if (deferForkModel) {
    setDesiredModelId(record, deferForkModel);
    setCurrentModelId(record, deferForkModel);
  }

  // A fork inherits the source's (truncated) conversation in
  // `conversation.messages`. acpx-ui renders a session's conversation from the
  // messages-log sidecar (`<id>.messages.ndjson`, pointed at by `messages_log`)
  // — its record/fork-prepend fallback runs through hydrateSessionMessages, and
  // a normal session always carries that sidecar. A plain checkpoint write
  // leaves `messages_log` undefined and never writes the sidecar, so the fork
  // is stored differently from every other session (inline-only) and the UI
  // shows an empty page. Flush the inherited messages through the boundary
  // writer so the fork's `messages_log` is populated (count == forkAtMessageIndex,
  // matching the truncated Claude resume transcript) and the sidecar exists —
  // making the fork store identically to its parent. FW-10 fork UI-empty fix.
  const guardForced = spawnGuardForcedInfo(effectiveSessionOptions);
  if (guardForced) {
    stampModelGuardBreadcrumb(record, { ...guardForced, source: "inherited", at: now });
    if (options.verbose) {
      process.stderr.write(
        `[acpx] model-guard session=${record.acpxRecordId} implicit Fable "${guardForced.blocked}" blocked → forced ${guardForced.forcedTo}\n`,
      );
    }
  }

  // 🛑 THE RECORD IS WRITTEN FIRST, AND THE SEAT ROW IS MINTED AFTER IT. THAT ORDER IS
  // RULED, NOT PREFERRED — and it is the REVERSE of what this site did until the ruling of
  // 2026-09-28 (SEAT-STORE.md item 8, the third RULED paragraph).
  //
  // ⚠️ WHAT THE INVERTED COMMENT HERE USED TO SAY, AND WHY IT WAS WRONG: it invoked D13a
  // — *"record-first leaves a session carrying a seatId with NO ROW … silent and
  // permanent"* — and forbade exactly this move *"for tidiness"*. D13a's price was set
  // BEFORE AP17 made that state loud and B10 made it repairable, and nobody re-checked it
  // (the repricing pass, J1). **A row-less record is now the legitimate, AP17-diagnosed,
  // B10-repaired state.** So the only thing D13a's ordering still bought was an inert
  // orphan row — at the cost below, which is fatal.
  //
  // 🔑 WHY ROW-FIRST WAS A DEFECT: the mint takes the `index.json` lock, and the record write
  // then went through the box-wide SQLite outbox, so a mint that SUCCEEDED could make the
  // following record write fail `outbox-busy` after its full 4 s budget — **no session at
  // all.** Item 8 forbids creation depending on the store **by error OR BY SIDE EFFECT**, and
  // a catch around a call that SUCCEEDS is never invoked — so only the ordering could cover it.
  // The outbox is gone from ordinary record writes (they take the per-record file lock only;
  // the spawn ledger opens for `metadata.spawn_key` records alone), so that contention no longer
  // exists; the record-first ordering stays because a row-less record is the legitimate,
  // AP17-diagnosed, B10-repaired state and a row-first orphan buys nothing.
  if (forkContext) {
    await writeSessionRecordAtBoundary(record);
  } else {
    await writeSessionRecord(record);
  }
  // 🛑 BELOW BOTH LEGS OF THE BRANCH ABOVE, DELIBERATELY. The fork leg writes through
  // `writeSessionRecordAtBoundary` and the plain leg through `writeSessionRecord`; a mint
  // placed under only one of them leaves `sessions copy`/fork on the old ordering — and it
  // would look done, because the row still appears for `sessions new`.
  // Only the FRESH-MINT path mints: `--seat` joined an existing row, and joining must
  // never mint one (D13).
  if (options.seatId === undefined && seatFields.seatId !== undefined) {
    // 🛑 BEST-EFFORT AND LOUD (ratification item 8) — A STORE FAILURE MUST NOT FAIL THE
    // SPAWN. Fail-closed here would be a bootstrap trap: every recovery path on these
    // boxes runs through creating an agent session, so a corrupt store that stops
    // `sessions new` stops its own repair. The `seat_id` STAYS on the record — it is what
    // makes the session repairable by the backfill and what keeps its children's
    // `parent_seat_id` chain from being orphaned.
    const minted = await mintSeatRowBestEffort(sessionBaseDir(), {
      seatId: seatFields.seatId,
      holderId: record.acpxRecordId,
      name: normalizeName(options.seatName),
      createdAt: now,
      // F1 fix (brick 3dff714d, DECISIONS.md) — the SEAT's brick_id is now
      // written at mint time, from the same resolved value the holder's own
      // `metadata.brick` already carries (set above by
      // `withInheritedBrick`/`applyBrickFlag`). The holder's copy stays the
      // derived projection; this is the canonical write C4 designates the seat
      // row as needing, which nothing wrote before this fix.
      //
      // THE HINGE, brick `9984c510` — `options.explicitBrickFlagValidated` is
      // the ONE signal that traces back to `resolveBrickFlagRef`'s own leg
      // (healthy vs degraded): `true` only when an explicit `--brick` was
      // actually RESOLVED by `brick show`. Every other source of
      // `metadata.brick` here — no flag at all (ambient parent inheritance)
      // — never ran a resolution THIS spawn, so it defaults to `false`,
      // never validated-by-assumption (invariant (ii)'s spirit, carried
      // forward to the write side).
      brickId: seatBrickLinkFromRef(
        options.metadata?.brick,
        options.explicitBrickFlagValidated === true,
      ),
    });
    if (!minted.minted) {
      // BOTH LEGS — stderr AND the session stream (the ruling's "never a silent catch"),
      // through the single writer that also serves path 3 and the divergence line.
      await reportOperatorDiagnostic(record, minted.diagnostic);
    }
  }
  if (guardForced) {
    // Best-effort mirror (pushes the warning message + boundary-writes the sidecar)
    // — a write failure must never fail the spawn.
    await mirrorModelGuardToMessages(record, guardForced).catch(() => {});
  }
  return record;
}

function cloneDesiredConfigOptions(
  desiredConfigOptions: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!desiredConfigOptions || Object.keys(desiredConfigOptions).length === 0) {
    return undefined;
  }
  return { ...desiredConfigOptions };
}

type CreatedSessionState = {
  sessionId: string;
  acpSessionId: string;
  agentSessionId: string | undefined;
  sessionResult: SessionCreateResult | SessionLoadResult | SessionForkResult;
  sessionModels: SessionCreateResult["models"];
  modelApply: ModelApplyOutcome;
};

type ForkedSessionState = CreatedSessionState & {
  // Set when the eager creation-time set_model was skipped for a durable Claude
  // fork; the source model to persist onto the record for open-time replay.
  deferForkModel?: string;
  forkContext: {
    sourceRecord: SessionRecord;
    forkAtMessageIndex: number;
    requestedForkAtMessageIndex?: number;
    messages: SessionRecord["messages"];
  };
};

type ForkSourceContext = {
  sourceRecord: SessionRecord;
  /** The index the fork ACTUALLY lands on — what the record persists. */
  forkAtMessageIndex: number;
  /** The index that was ASKED for, present only when it differs from the above. */
  requestedForkAtMessageIndex?: number;
};

async function resumeSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<CreatedSessionState> {
  if (!options.resumeSessionId) {
    throw new Error("resumeSessionId is required");
  }
  const resumeMethod = client.supportsResumeSession()
    ? "session/resume"
    : client.supportsLoadSession()
      ? "session/load"
      : undefined;
  if (!resumeMethod) {
    throw new Error(
      `Agent command "${options.agentCommand}" does not support session/resume or session/load; cannot resume session ${options.resumeSessionId}`,
    );
  }

  try {
    const resumedSession = await withTimeout(
      resumeMethod === "session/resume"
        ? client.resumeSession(options.resumeSessionId, cwd)
        : client.loadSession(options.resumeSessionId, cwd),
      options.timeoutMs,
    );
    const sessionModels = resumedSession.models;
    return {
      sessionId: options.resumeSessionId,
      acpSessionId: options.resumeSessionId,
      agentSessionId: normalizeRuntimeSessionId(resumedSession.agentSessionId),
      sessionResult: resumedSession,
      sessionModels,
      modelApply: await applyRequestedModelIfAdvertised({
        client,
        sessionId: options.resumeSessionId,
        ...modelApplyParamsFromOptions(options),
        models: sessionModels,
        advertisedConfigOptions: resumedSession.configOptions,
        agentCommand: options.agentCommand,
        timeoutMs: options.timeoutMs,
      }),
    };
  } catch (error) {
    throw new Error(
      `Failed to resume ACP session ${options.resumeSessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

async function resolveForkSourceContext(options: SessionCreateOptions): Promise<ForkSourceContext> {
  if (!options.forkFromSessionId) {
    throw new Error("forkFromSessionId is required");
  }

  const sourceRecord = await resolveSessionRecord(options.forkFromSessionId);
  if (sourceRecord.kind === "subagent") {
    throw new Error("Cannot copy a subagent session");
  }

  // THE CHOKE POINT both the CLI verb and acpx-ui's create route reach, which is
  // why the refusal lives here rather than only in the handler: a truncating fork
  // a harness will not perform is refused before any record exists.
  assertForkAtIndexHonoured(options.agentCommand, options.forkAtMessageIndex);

  const requested = options.forkAtMessageIndex ?? sourceRecord.messages.length;
  if (requested < 0 || requested > sourceRecord.messages.length) {
    throw new Error(`--at-index out of range (0-${sourceRecord.messages.length})`);
  }

  // ⚠️ THE RECORD CARRIES THE EFFECTIVE INDEX, NOT THE REQUESTED ONE, and this
  // is a CORRECTION of shipped behaviour, not a new field's default. Before B0.2
  // this function returned the request and `session-management` persisted it as
  // `forkedAtMessageIndex` — so on codex, whose rollback is TURN-granular
  // (2 acpx messages = 1 turn, rounding down), an ODD index already produced a
  // record asserting a truncation the adapter did not perform. The lie shipped;
  // it is not being introduced. Correcting the field every consumer ALREADY
  // reads fixes the display everywhere at once, which is why `requested` is the
  // new field rather than `effective`.
  //
  // It also truncates the cloned message list at the same boundary
  // (`messages.slice(0, forkAtMessageIndex)` in the caller), so the record's own
  // message COUNT agrees with the index it reports — the ground truth
  // `G1-FRK-01` checks the record against.
  const forkAtMessageIndex =
    options.forkAtMessageIndex === undefined
      ? requested
      : resolveEffectiveForkIndex(options.agentCommand, requested);

  return {
    sourceRecord,
    forkAtMessageIndex,
    // Populated ONLY on a mismatch, so the common case stays byte-identical to
    // baseline and the field's mere presence means "these two differ".
    ...(forkAtMessageIndex === requested ? {} : { requestedForkAtMessageIndex: requested }),
  };
}

// Decide how a fork's model gets applied. Durable Claude forks return an
// SDK-materialized transcript id the adapter has never registered (only the
// random fork id from unstable_forkSession is). Driving `set_model` on it at
// creation aborts the whole copy ("Session not found"). So for those we skip the
// eager apply and defer the source model onto the record, letting the open-time
// replay path (getDesiredModelId → replayDesiredModel) apply it on the first
// proper resume — when the durable id IS registered. Every other fork (codex/pty,
// or a Claude fork where no durable substitution ran) keeps the eager apply: its
// returned id is already registered. Fork brick 29efbe0c.
async function resolveForkModelApplication(
  client: AcpClient,
  options: SessionCreateOptions,
  forkedSession: SessionCreateResult | SessionForkResult,
  sessionModels: SessionCreateResult["models"],
): Promise<{ modelApply: ModelApplyOutcome; deferForkModel: string | undefined }> {
  // Only forkSession (forkAtMessageIndex > 0) can carry the marker; the
  // createSession branch (index 0) is a fresh empty session.
  const durableClaudeForkApplied =
    "durableClaudeForkApplied" in forkedSession && forkedSession.durableClaudeForkApplied === true;
  if (durableClaudeForkApplied) {
    // `sessionOptions.model` is the canonical model acpx already resolved for the
    // copy (via copySessionOptionsWithOverride); the record setters normalize it,
    // and it is the value the open-time replay + adapter model resolution agree on.
    return { modelApply: { applied: false }, deferForkModel: options.sessionOptions?.model };
  }
  return {
    modelApply: await applyRequestedModelIfAdvertised({
      client,
      sessionId: forkedSession.sessionId,
      ...modelApplyParamsFromOptions(options),
      models: sessionModels,
      advertisedConfigOptions: forkedSession.configOptions,
      agentCommand: options.agentCommand,
      timeoutMs: options.timeoutMs,
    }),
    deferForkModel: undefined,
  };
}

async function forkSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<ForkedSessionState> {
  const { sourceRecord, forkAtMessageIndex, requestedForkAtMessageIndex } =
    await resolveForkSourceContext(options);

  if (!client.supportsForkSession()) {
    throw new Error(
      `Agent command "${options.agentCommand}" does not advertise sessionCapabilities.fork; cannot copy session ${sourceRecord.acpxRecordId}`,
    );
  }

  try {
    const forkedSession =
      forkAtMessageIndex === 0
        ? await withTimeout(client.createSession(cwd), options.timeoutMs)
        : await withTimeout(
            client.forkSession(sourceRecord.acpSessionId, cwd, {
              atIndex: options.forkAtMessageIndex,
              sourceCwd: sourceRecord.cwd,
              sourceMessages: sourceRecord.messages,
              suppressReplayUpdates: true,
            }),
            options.timeoutMs,
          );
    const sessionModels = forkedSession.models;
    const agentSessionId = normalizeRuntimeSessionId(forkedSession.agentSessionId);
    const { modelApply, deferForkModel } = await resolveForkModelApplication(
      client,
      options,
      forkedSession,
      sessionModels,
    );
    return {
      sessionId: forkedSession.sessionId,
      acpSessionId: forkedSession.sessionId,
      agentSessionId,
      sessionResult: forkedSession,
      sessionModels,
      modelApply,
      deferForkModel,
      forkContext: {
        sourceRecord,
        forkAtMessageIndex,
        ...(requestedForkAtMessageIndex === undefined ? {} : { requestedForkAtMessageIndex }),
        // Truncated at the EFFECTIVE boundary, so the record's own message count
        // agrees with the index it reports (row `G1-FRK-01`).
        messages: sourceRecord.messages.slice(0, forkAtMessageIndex),
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to copy ACP session ${sourceRecord.acpSessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

// Build the best-effort sessionContext for the first (creation) spawn. The ?? null chains mirror
// the sessionContext shape in queue-owner-runtime.ts / connected-session.ts (trivial field-mapping).
// eslint-disable-next-line complexity -- ?? null field-mapping; cannot simplify without losing null safety
async function creationSessionContext(options: SessionCreateOptions) {
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
  };
}

export async function createSessionWithClient(
  options: SessionCreateOptions,
): Promise<SessionCreateWithClientResult> {
  const effectiveOptions: SessionCreateOptions = {
    ...options,
    sessionOptions: await bindDefaultAccountToSessionOptionsAsync(
      options.sessionOptions,
      options.agentCommand,
    ),
  };
  const client = new AcpClient({
    agentCommand: effectiveOptions.agentCommand,
    cwd: absolutePath(effectiveOptions.cwd),
    mcpServers: effectiveOptions.mcpServers,
    permissionMode: effectiveOptions.permissionMode,
    nonInteractivePermissions: effectiveOptions.nonInteractivePermissions,
    permissionPolicy: effectiveOptions.permissionPolicy,
    authCredentials: effectiveOptions.authCredentials,
    authPolicy: effectiveOptions.authPolicy,
    terminal: effectiveOptions.terminal,
    verbose: effectiveOptions.verbose,
    sessionOptions: effectiveOptions.sessionOptions,
    // The CREATION spawn must resolve CLAUDE_CONFIG_DIR from the chosen
    // subscription, exactly like the prompt/recover/keepwarm spawns do
    // (connected-session.ts / runtime.ts). Without this the first turn ignores
    // `--subscription` and falls through to the registry default. The record
    // does not exist yet, so the id is sourced from sessionOptions; the other
    // sessionContext fields are best-effort (each is guarded independently in
    // buildAgentEnvironment, so a null acpxRecordId only skips ACPX_SESSION_URL
    // on this one spawn — it is set on the next spawn from the persisted record).
    sessionContext: await creationSessionContext(effectiveOptions),
  });

  try {
    const record = await withInterrupt(
      async () => await createSessionRecordWithClient(client, effectiveOptions),
      async () => {
        await client.close();
      },
    );

    return {
      record,
      client,
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * brick://874fee67 §4.2 #40 — enumerate the output styles an agent offers.
 *
 * Exists for acpx-ui's CREATE dialog, which must offer a style before any
 * session exists. Two paths, both cheap:
 *
 * - **With a session id** — read the record's own advertised `config_options`.
 *   No process spawned at all.
 * - **Without one** — open a transient ACP session, read what the adapter
 *   advertises from the `initialize` handshake, and close. **No prompt is ever
 *   sent**: the handshake carries `available_output_styles` before any turn, so
 *   this costs no tokens and needs no auth. It also returns CUSTOM and house
 *   styles, which no filesystem scan could produce for the built-ins — which is
 *   why this asks the harness rather than reading `output-styles/` directories.
 *
 * ⚠️ NO RECORD IS WRITTEN on the transient path. The session is opened purely to
 * read the advertisement and is closed in a `finally`.
 */
export async function listAgentOutputStyles(
  options: AgentOutputStyleListOptions,
): Promise<AgentOutputStyleListResult> {
  if (options.sessionId) {
    const record = await resolveSessionRecord(options.sessionId);
    return outputStyleListFromAdvertised(record.acpx?.config_options);
  }

  // The transient open/read/close is shared with the Claude model-advertisement
  // probe (brick ebfe4c3c) — one implementation of the measured no-prompt path.
  const { configOptions } = await readTransientAdvertisement({
    agentCommand: options.agentCommand,
    cwd: options.cwd,
    mcpServers: options.mcpServers,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    verbose: options.verbose,
    timeoutMs: options.timeoutMs,
  });
  return outputStyleListFromAdvertised(configOptions);
}

function outputStyleListFromAdvertised(
  advertised: SessionConfigOption[] | undefined,
): AgentOutputStyleListResult {
  const option = findAdvertisedOutputStyleOption(advertised);
  if (!option) {
    // Not advertised = genuinely unsupported by this agent (codex lands here with
    // no special-casing). Distinct from "advertised but we know no values".
    return { supported: false, current: undefined, available: [] };
  }
  return {
    supported: true,
    current: typeof option.currentValue === "string" ? option.currentValue : undefined,
    available: availableOutputStyles(advertised),
  };
}

export async function createSession(options: SessionCreateOptions): Promise<SessionRecord> {
  const { record, client } = await createSessionWithClient(options);
  try {
    return record;
  } finally {
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await writeSessionRecord(record);
  }
}

export async function listAgentSessions(options: SessionListOptions): Promise<SessionListResult> {
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    verbose: options.verbose,
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        if (!client.supportsListSessions()) {
          return undefined;
        }

        const cwd = options.filterCwd ? absolutePath(options.filterCwd) : undefined;
        const response = await withTimeout(
          client.listSessions({
            ...(cwd ? { cwd } : {}),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }),
          options.timeoutMs,
        );

        return {
          _meta: response._meta,
          source: "agent",
          sessions: response.sessions,
          cursor: options.cursor,
          cwd,
          nextCursor: response.nextCursor,
        };
      },
      async () => {
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export { DEFAULT_QUEUE_OWNER_TTL_MS };
