import type { Command } from "commander";
import { SessionNotFoundError } from "../errors.js";
import { describeAbandonedRecordSweep } from "../session/abandoned-record-sweep.js";
import {
  SEAT_STORE_FILE,
  SEAT_STORE_NO_CHANGE,
  SeatStoreUnwritableError,
  MalformedSeatRowError,
  isoNow,
  listSessionIndexEntries,
  parseSeatRefOrThrow,
  readSeatStore,
  resolveSessionRecord,
  seatBrickLinkFromRef,
  seatFromStore,
  seatRowMissingMessage,
  seatStorePath,
  seatStoreUnhealthyMessage,
  sessionBaseDir,
  withSeatStoreWrite,
  type SeatBrickLink,
  type SeatRecord,
  type SeatStore,
} from "../session/persistence.js";
import type { SessionIndexEntry } from "../session/persistence/index.js";
import {
  countStaleSeatIndexEntries,
  runSeatBackfill,
  type SeatBackfillReport,
} from "../session/seat-backfill.js";
import type { OutputFormat } from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";
import { BRICK_UUID_RE } from "./session/brick-link.js";

/**
 * `acpx seats set-brick` / `rename` / `delete` — **B2b, brick 03bc080b** — plus
 * `acpx seats close` — **B2c, brick 4a17c8b5.**
 *
 * ## Why these live here rather than at their callers
 *
 * Three ratified decisions each assign a seat-store WRITE to code on the acpx-ui
 * side — `brick attach` sets a seat's `brick_id` (C4), the UI renames a seat (E10),
 * and the byway sweep deletes a seat row (§3.7) — while `SEAT-STORE.md`
 * ratification item 2 makes **acpx the store's only writer**. The programme owner's
 * ruling resolves the conflict the same way session lifecycle is already resolved:
 * acpx owns the mutation and exposes it as a CLI verb, and acpx-ui-side callers
 * invoke `acpx` by path exactly as they already do. So every write below goes
 * through the one exported helper (`withSeatStoreWrite`) under the `index.json`
 * lock. **There is no second writer, no second lock and no direct `fs` write to
 * `seats.json` anywhere in this file.**
 *
 * ## 🛑 A `seats` NAMESPACE NEEDS TWO REGISTRATIONS, IN THE SAME COMMIT
 *
 * `registerSeatsCommand` below, **and** `"seats"` in `TOP_LEVEL_VERBS`
 * (`src/cli-core.ts`). Register only here and `configurePublicCli` absorbs the
 * token as an AGENT NAME: rc 4 "No acpx session found" in a session-free cwd, and a
 * **real prompt delivery to whatever agent owns the cwd's session** in a
 * session-bearing one (OS brick `2e3f50b5`). `test/top-level-verbs.test.ts`
 * enumerates what `registerDefaultCommands` registers and goes red — in both
 * directions — if the two halves disagree.
 *
 * Registered **top-level only**, not per-agent (unlike `sessions` / `subscriptions`
 * / `profiles`): the seat store is one agent-agnostic file in `SESSIONS_DIR`, so
 * `acpx claude seats delete` would be meaningless. This matches `agents`, `models`,
 * `providers` and `config`.
 *
 * ## 🛑 `rename` WRITES THE SEAT ROW ONLY — ruling A (L0, 2026-09-29T13:40:20Z)
 *
 * The brief and `MASTER-PLAN` both said to "keep the write-both discipline for
 * `name` during phase (i)". **Both predate Cluster A and both are wrong**, and the
 * code says so louder than either document: `applyPersistedLifecycleForWrite`
 * (`repository.ts:674-685`) sets `record.name = persistedLifecycle.name` on every
 * preserving write, and `WriteAuthoritativeFields` (`repository.ts:378`) carries
 * `parent` and `seatHolder` and **no `name` flag** — so a `seats rename` that wrote
 * the session record would be a *silent no-op*: exit 0, correct-looking output,
 * nothing changed. Making it work would need a third authority flag plus a
 * preservation bypass in the repo's most safety-critical write path, for a field
 * Daniel has already ruled is leaving the session record entirely
 * (2026-09-28T08:30:25Z — *"sessions don't have names"*).
 *
 * **The stale record copy is a CONTEMPLATED STATE, not a defect** — C2 phase (i)
 * has the two sides disagreeing deliberately, *with the seat winning*. `RN2′` in
 * `test/seats-mutation-verbs.test.ts` asserts the holder's record is UNCHANGED —
 * the contemplated state proven rather than tolerated.
 *
 * ## 🛑 `close` KEEPS THE ROW; `delete` REMOVES IT — the one thing a writer must
 * never collapse
 *
 * `close` writes `closed_at` and **touches no other field** (ratification item 2,
 * `SEAT-STORE.md`). `delete` removes the row entirely. A writer that folded the two
 * together would destroy the only thing `closed_at` records — that the seat's
 * abolition is on a KEPT row, not that the row is gone. **`seats delete` on a
 * closed seat still SUCCEEDS** (§1.1 below is `set-brick` / `rename` / `delete`, not
 * `close`'s own scope) — B2b's header already states this and it remains correct:
 * the byway sweep's caller is `delete`, and a seat that was abolished is exactly the
 * population whose rows become collectable.
 *
 * ## The three B2b verbs on a CLOSED seat — all three SUCCEED (sub-HoD ruling,
 * B2c PLAN.md §1)
 *
 * `set-brick` / `rename` / `delete` add **no** closed-seat refusal. `close` KEEPS
 * the row precisely so a closed seat's record stays correctable and attributable —
 * a misnamed seat discovered after abolition would otherwise be permanently
 * unfixable, and `brick attach`'s real caller cannot interpret a seat-lifecycle
 * refusal. Each of the three still asserts `closed_at` is BYTE-UNCHANGED after its
 * write — the standing guard that the `{...row, field}` spread never drops or moves
 * the key.
 *
 * ## `acpx seats list` / `show` — B2d, brick `88186acd` — and `reopen` — R7,
 * brick `d43db3b6`, built in the SAME lane at the programme owner's discretion
 *
 * Two read-only verbs plus the seat lifecycle's other timestamp writer.
 *
 * 🛑 **THE TWO-ENCODINGS RULE, measured live on devbox-staging 2026-09-30: a
 * seat row's `active_holder_id` does NOT reliably say who is active.** A row
 * BACKFILLED before brick `eca085bb` carries `null` once its sole holder is
 * closed (AC11 (c) — the active-only narrowing, since reversed: a backfill now
 * keeps the closed holder as the seat's holder and fills such a null on the next
 * run); a LIVE-MINTED row whose holder is then closed KEEPS the closed session's
 * id — nothing writes the row on a holder's own close (ratification item 5, by
 * design). So `null` and a closed id are two encodings of the SAME fact on a
 * store not yet re-backfilled, and a reader that trusted the raw pointer would
 * report a CLOSED session as the active holder on every live-minted seat. `list`/`show` never render
 * `active_holder_id` directly — they derive the holder's state from the
 * HOLDER'S OWN RECORD via `vetActiveHolder` (already shipped for `close`,
 * reused rather than re-derived), rendering `null` and a closed pointer
 * IDENTICALLY as "nobody home", and a pointer with no record on disk at all
 * (brick `6cb4f4dc`) as "holder record missing" — rendered honestly, not
 * repaired.
 *
 * `reopen` sets `closed_at` back to `null` and **touches nothing else** —
 * `active_holder_id` and `next_ordinal` are UNCHANGED, because re-opening is
 * NOT a succession (Daniel's symmetry: reopen the seat, reopen the holder
 * session, and you are back where you were — which only works if the seat verb
 * never touches a session record). No eighth field: a reopened seat is
 * indistinguishable on the row from one never closed (accepted deliberately —
 * Daniel asked for symmetry, not an audit trail).
 *
 * ## `set-brick --unset` — F3 fix, brick `3dff714d`, DECISIONS.md (c)
 *
 * **No longer true as of this fix: "once set, brick_id cannot be cleared by any
 * verb in B2b."** F1/(a) of the same brick makes `sessions new --brick` write the
 * seat's `brick_id` at MINT time, so after that fix every fresh seat carries one —
 * "unclearable" stopped being an edge case the moment it became universal. The
 * code comment `server/seatMutations.ts:259` that documented the gap (*"No
 * `--unset` exists … so the detach path must never call this"*) was an
 * implementation constraint recorded as such, not a design argument for
 * write-once; this verb is the fix, and wiring acpx-ui's `brick detach` to call
 * it is this lane's own follow-up, tracked separately if it does not land in the
 * same band.
 *
 * ## What this file deliberately does NOT do
 *
 * - **No short-ref resolution.** See `parseBrickIdOrThrow`.
 * - **No `--at` / timestamp argument on `close`.** The written value is always a
 *   clock read taken INSIDE the write hold — never a caller-supplied or
 *   caller-influenced value. Unrepresentable, not merely refused.
 * - **`reopen` never re-points `active_holder_id` and never mints a new
 *   holder.** It is the named inverse of `close` alone, not a general field
 *   setter — see R7 item 1 (brick `d43db3b6`).
 */

type SeatMutationRefusalCode =
  | "SEAT_REF_INVALID"
  | "BRICK_REF_INVALID"
  | "SEAT_NAME_INVALID"
  | "SEAT_FAVORITE_FLAG_INVALID"
  | "SEAT_BRICK_ARGS_INVALID"
  | "SEAT_ROW_MISSING"
  | "SEAT_ROW_MALFORMED"
  | "SEAT_STORE_UNWRITABLE"
  | "SEAT_STORE_UNHEALTHY"
  | "SEAT_HOLDER_OPEN"
  | "SEAT_HOLDER_CHANGED";

/** Refusals carry a code so a caller can render them without matching on prose —
 * the shape `SeatActivationRefusalError` already uses on the succession verb. */
export class SeatMutationRefusalError extends Error {
  constructor(
    readonly code: SeatMutationRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "SeatMutationRefusalError";
  }
}

/**
 * The seat reference, validated AT THE ORIGIN and nowhere else (D8).
 *
 * `parseSeatRefOrThrow` throws a plain `Error`; it is wrapped here so the refusal
 * carries a code, and its message is kept VERBATIM because that message is the one
 * that names the seat-id form. ⚠️ Its text must stay distinguishable from
 * `parseBrickIdOrThrow`'s: `set-brick` takes two refs and a refusal that could have
 * come from either argument is green whichever mechanism fired — B2's AP13 defect
 * exactly. The two messages share no substring beyond ordinary English, and the
 * codes differ.
 */
function parseSeatIdOrThrow(value: string): string {
  try {
    return parseSeatRefOrThrow("Seat id", value);
  } catch (error) {
    throw new SeatMutationRefusalError(
      "SEAT_REF_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * The brick reference — **a FULL uuid, and this NEVER shells out to the `brick` CLI.**
 *
 * `src/acp/brick-context.ts:11` resolves a short brick ref by running the `brick`
 * CLI on a 3 s timeout against a command measured at ~9 s on a loaded box, so the
 * resolution fails the CALLER rather than the ref. `brick attach` — the real caller
 * (C4) — already holds the resolved uuid, so there is nothing to resolve here.
 *
 * ⚠️ `BRICK_UUID_RE` is reused rather than re-declared, but `isBrickUuid` is NOT:
 * that predicate trims and lowercases before testing, and a repair at the origin is
 * precisely what makes the layers downstream disagree about whether a value is
 * absent, malformed or valid (the D8 rationale on `parseSeatRefOrThrow`). **Rejected,
 * never repaired** — the value written is byte-identical to the value accepted.
 */
function parseBrickIdOrThrow(value: string): string {
  if (BRICK_UUID_RE.test(value)) {
    return value;
  }
  throw new SeatMutationRefusalError(
    "BRICK_REF_INVALID",
    `Brick id must be a FULL brick uuid in lowercase, got ${JSON.stringify(value)}. ` +
      `A short brick ref is NOT resolved here: resolving one means running the \`brick\` CLI, ` +
      `which is measured at ~9 s on a loaded box against a 3 s timeout, so the resolution ` +
      `would fail this command rather than the ref. Pass the full uuid — \`brick attach\`, ` +
      `this verb's caller, already holds it.`,
  );
}

/**
 * The seat name — **rejected, never repaired**, mirroring D8's origin rule.
 *
 * A name that had to be trimmed to be accepted would be stored differently from how
 * it was submitted, which is the same collapse `parseSeatRefOrThrow` exists to
 * prevent, one field over. A control character would additionally break every
 * line-oriented rendering of the store downstream.
 */
function parseSeatNameOrThrow(value: string): string {
  // BY CODE UNIT, NOT BY REGEX, for two reasons that both matter. oxlint
  // `no-control-regex` rejects the character class outright — and spelling that class
  // as literal bytes to dodge the rule would make this SOURCE FILE binary to `grep`,
  // which then returns exit 1 and NO output for every later search of it, warning
  // nobody. This form is greppable, lint-clean, and leaves every non-ASCII name
  // (`Büro`) perfectly valid.
  let hasControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      hasControlCharacter = true;
      break;
    }
  }
  if (value.length > 0 && value.trim() === value && !hasControlCharacter) {
    return value;
  }
  throw new SeatMutationRefusalError(
    "SEAT_NAME_INVALID",
    `Seat name must be non-empty, free of leading and trailing whitespace, and free of ` +
      `control characters, got ${JSON.stringify(value)}. It is rejected rather than ` +
      `repaired — never trimmed, never coerced: a value stored differently from the way it ` +
      `was submitted is what makes the layers downstream disagree about it.`,
  );
}

/**
 * 🛑 THE WRITE REFUSAL, TAKEN INSIDE THE HOLD AND BEFORE THE ROW LOOKUP.
 *
 * `withSeatStoreWrite` already refuses to write over an unhealthy file — but its
 * guard runs AFTER the mutator returns, and by then `seatFromStore` would have
 * thrown `SeatStoreUnhealthyError` instead. For a *mutation* verb that is the wrong
 * error: the operative fact is that the write is refused, and
 * `SeatStoreUnwritableError`'s message carries the unhealthy-file remedy **plus**
 * the "refusing to write" preamble and the file path. Same error type, same
 * message, raised at the point that makes it answer the caller's question.
 *
 * ⚠️ What it must never become is "seat not found": that is F1's defect — a
 * present-and-corrupt store answering ABSENT, which sends an operator to a backfill
 * that refuses to run against a malformed store.
 */
function refuseUnwritableStore(store: SeatStore, sessionDir: string): void {
  if (store.fileState === "malformed" || store.fileState === "unreadable") {
    throw new SeatStoreUnwritableError(seatStorePath(sessionDir), store.fileState);
  }
}

/**
 * The READ-path twin of `refuseUnwritableStore`.
 *
 * `SeatStoreUnwritableError`'s message opens "refusing to WRITE the seat store" —
 * correct for `close`/`rename`/etc., actively wrong for `list`/`show`, which never
 * write anything. Same underlying fact (F1: an unhealthy FILE must never read as an
 * empty or absent store), worded for the verb that is actually refusing.
 */
function refuseUnhealthyStoreForRead(store: SeatStore): void {
  if (store.fileState === "malformed" || store.fileState === "unreadable") {
    throw new SeatMutationRefusalError(
      "SEAT_STORE_UNHEALTHY",
      seatStoreUnhealthyMessage(store.fileState),
    );
  }
}

/**
 * The row, or a refusal that names the cause and the remedy (AP17).
 *
 * `seatFromStore` throws `MalformedSeatRowError` for a row that is PRESENT and
 * unreadable, and that is deliberately not caught here — it is mapped to its own
 * refusal code by `renderSeatRefusal`, because "present but unreadable" and "absent"
 * demand different actions and must never share a message.
 */
function requireSeatRow(store: SeatStore, seatId: string): SeatRecord {
  const row = seatFromStore(store, seatId);
  if (!row) {
    throw new SeatMutationRefusalError("SEAT_ROW_MISSING", seatRowMissingMessage(seatId));
  }
  return row;
}

/**
 * The refusal for a seat whose OWN row is present and unreadable.
 *
 * 🛑 IT NAMES THE REMEDY, NOT JUST THE CONDITION — the standard
 * `seatStoreUnhealthyMessage` sets, and the reason F1 exists: a refusal that states a
 * condition and leaves the operator to guess is one step from a refusal that
 * prescribes the wrong repair. It also says that only THESE rows are corrupt, so
 * nobody goes off to audit a file whose other rows are fine.
 *
 * ⚠️ DELIBERATELY SHARES NO MARKER WITH `seatRowMissingMessage`. That message's
 * remedy is `RUN THE SEAT BACKFILL`; this one's is `QUARANTINE a copy`, and the
 * backfill is explicitly NOT the fix here — it refuses to run against a corrupt store
 * and cannot repair a row. Two refusals about "the row is not usable" that shared a
 * substring would be green whichever fired, which is B2's AP13 defect.
 */
function seatRowsMalformedMessage(seatIds: readonly string[]): string {
  const subject = seatIds.map((seatId) => JSON.stringify(seatId)).join(", ");
  return (
    `seat ${subject} is PRESENT in ${SEAT_STORE_FILE} and its row is MALFORMED, so this ` +
    `delete REFUSES it instead of removing it: the store's one writer re-emits unreadable ` +
    `rows verbatim as a data-loss defence, and such a row may still be hand-recoverable. ` +
    `Only the named row is corrupt — every other row in the file read fine, so there is no ` +
    `need to audit the whole store. Repair: QUARANTINE a copy of ${SEAT_STORE_FILE} ` +
    `(${SEAT_STORE_FILE}.corrupt-<timestamp>, and KEEP it), hand-repair or hand-remove the ` +
    `named row, then run the seat backfill for anything left without a row. Do not delete ` +
    `the store to clear this.`
  );
}

/** The errors a seat mutation may legitimately refuse with, normalised to one shape. */
function asSeatRefusal(error: unknown): SeatMutationRefusalError | undefined {
  if (error instanceof SeatMutationRefusalError) {
    return error;
  }
  if (error instanceof MalformedSeatRowError) {
    return new SeatMutationRefusalError(
      "SEAT_ROW_MALFORMED",
      seatRowsMalformedMessage([error.seatId]),
    );
  }
  if (error instanceof SeatStoreUnwritableError) {
    return new SeatMutationRefusalError("SEAT_STORE_UNWRITABLE", error.message);
  }
  return undefined;
}

/**
 * Run one seat mutation, rendering its refusals.
 *
 * Anything that is not a seat refusal is RETHROWN — a mutation verb that swallowed
 * an unexpected error would report success for a write that never happened.
 */
async function runSeatMutation(
  verb: string,
  format: OutputFormat,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const refusal = asSeatRefusal(error);
    if (!refusal) {
      throw error;
    }
    if (!emitJsonResult(format, { ok: false, code: refusal.code, error: refusal.message })) {
      if (format !== "quiet") {
        process.stderr.write(`seats ${verb}: ${refusal.code}: ${refusal.message}\n`);
      }
    }
    process.exitCode = 1;
  }
}

// ─── set-brick ───────────────────────────────────────────────────────────────

/**
 * The positional `[brick]` and `--unset` are mutually exclusive, and exactly one
 * must be given — same idiom as `parseSeatFavoriteFlag`'s `--on`/`--off`, one
 * argument over. `undefined` back from this means "clear the field", never
 * "nothing was requested" — that case is already refused here.
 */
function parseSeatBrickArgs(
  brickRef: string | undefined,
  unset: boolean | undefined,
  validated: boolean | undefined,
): string | undefined {
  if (unset === true) {
    if (brickRef !== undefined) {
      throw new SeatMutationRefusalError(
        "SEAT_BRICK_ARGS_INVALID",
        `pass either a brick uuid or --unset, not both (got brick ${JSON.stringify(brickRef)} and --unset).`,
      );
    }
    if (validated === true) {
      throw new SeatMutationRefusalError(
        "SEAT_BRICK_ARGS_INVALID",
        "--validated has nothing to assert against --unset — it clears both brick_id and " +
          "brick_id_validated, there is no ref to have validated.",
      );
    }
    return undefined;
  }
  if (brickRef === undefined) {
    throw new SeatMutationRefusalError(
      "SEAT_BRICK_ARGS_INVALID",
      "pass a brick uuid, or --unset to clear the seat's brick_id.",
    );
  }
  return parseBrickIdOrThrow(brickRef);
}

/** `seats set-brick`'s JSON payload, pulled out to keep the mutation function
 * under the complexity budget — additive brickIdValidated/previousBrickIdValidated
 * siblings, same shape as `seats show`'s payload. */
function setBrickJsonPayload(
  seatId: string,
  brickId: SeatBrickLink | undefined,
  previousBrickId: SeatBrickLink | undefined,
): Record<string, unknown> {
  return {
    ok: true,
    action: brickId === undefined ? "seat_brick_unset" : "seat_brick_set",
    seatId,
    brickId: brickId?.ref ?? null,
    brickIdValidated: brickId ? brickId.validated : null,
    previousBrickId: previousBrickId?.ref ?? null,
    previousBrickIdValidated: previousBrickId ? previousBrickId.validated : null,
  };
}

async function handleSeatsSetBrick(
  seatRef: string,
  brickRef: string | undefined,
  flags: { unset?: boolean; validated?: boolean },
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("set-brick", format, async () => {
    const seatId = parseSeatIdOrThrow(seatRef);
    // F3 fix (brick `3dff714d`, DECISIONS.md (c)) — `undefined` for `--unset`, a
    // full uuid otherwise. Both legs write through the SAME spread below, so
    // `--unset` is not a second code path that could drift from the set path's
    // field discipline.
    const resolvedRef = parseSeatBrickArgs(brickRef, flags.unset, flags.validated);
    // Brick `9984c510`, ruling (B2′) — THIS VERB NEVER RESOLVES; THE CALLER
    // ASSERTS. `seats set-brick` performs no `brick show` call — shape only,
    // via `parseBrickIdOrThrow` — so on its own it cannot tell a real brick
    // from a typo, exactly the defect this brick exists to fix. `brick attach`
    // (acpx-ui) HAS already established existence before shelling out to this
    // verb, and asserts that with `--validated`; a bare operator invocation has
    // not, and DEFAULTS TO UNVALIDATED. `--unset` clears both keys (`brickId`
    // becomes `undefined` entirely — there is no sibling to independently omit).
    const brickId = seatBrickLinkFromRef(resolvedRef, flags.validated === true);
    const sessionDir = sessionBaseDir();
    const previousBrickId = await withSeatStoreWrite(sessionDir, (store) => {
      refuseUnwritableStore(store, sessionDir);
      const row = requireSeatRow(store, seatId);
      const seats = new Map(store.seats);
      // SPREAD the fresh row — `closed_at` is `null`, never absent, on every row, and
      // the parse leg rejects a row missing the key as malformed (D8). Rebuilding the
      // row field-by-field is how that key goes missing.
      seats.set(seatId, { ...row, brickId });
      return { mutation: { kind: "write", seats } as const, result: row.brickId };
    });
    if (emitJsonResult(format, setBrickJsonPayload(seatId, brickId, previousBrickId))) {
      return;
    }
    if (format === "quiet") {
      return;
    }
    process.stdout.write(
      `seat ${seatId}: brick_id = ${renderSeatBrickLinkText(brickId)}` +
        `${previousBrickId === undefined ? "" : ` (was ${renderSeatBrickLinkText(previousBrickId)})`}\n`,
    );
  });
}

// ─── rename ──────────────────────────────────────────────────────────────────

async function handleSeatsRename(
  seatRef: string,
  nameRef: string,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("rename", format, async () => {
    const seatId = parseSeatIdOrThrow(seatRef);
    const name = parseSeatNameOrThrow(nameRef);
    const sessionDir = sessionBaseDir();
    const renamed = await withSeatStoreWrite(sessionDir, (store) => {
      refuseUnwritableStore(store, sessionDir);
      const row = requireSeatRow(store, seatId);
      const seats = new Map(store.seats);
      // 🛑 THE SEAT ROW, AND NOTHING ELSE. No session record is read, resolved or
      // written anywhere on this path — see the ruling-A note in this file's header.
      // `RN3′` goes RED the moment a holder-record write is added here.
      seats.set(seatId, { ...row, name });
      return {
        mutation: { kind: "write", seats } as const,
        result: { previousName: row.name, activeHolderId: row.activeHolderId },
      };
    });
    if (
      emitJsonResult(format, {
        ok: true,
        action: "seat_renamed",
        seatId,
        name,
        previousName: renamed.previousName ?? null,
        activeHolderId: renamed.activeHolderId,
        // Stated in the payload, not only in prose: a caller reading this verb's JSON
        // must not infer that the holder's record moved with it.
        holderRecordUntouched: true,
      })
    ) {
      return;
    }
    if (format === "quiet") {
      return;
    }
    // PRINTED ON THE TEXT PATH ONLY — a scripted caller's `--format json` payload
    // must never gain a prose line, which `test/seats-mutation-verbs.test.ts` row
    // RN11 asserts.
    process.stdout.write(`seat ${seatId}: name = ${JSON.stringify(name)}\n`);
  });
}

// ─── favorite ────────────────────────────────────────────────────────────────

/**
 * `acpx seats favorite <seat> --on|--off` — Daniel's D-STAR ruling
 * (2026-09-30T22:00:23Z, relayed `Bricks/693ed2a9-.../` 22:09:40Z): *"the star
 * actually belongs to the seat and not to the session."* Writes the SEAT ROW
 * ONLY, under the index lock, through the one writer — `rename`'s single-hold
 * shape exactly, because a star has no holder state to vet either (no
 * `vetActiveHolder` phase like `close`'s).
 *
 * acpx-ui's star toggle CALLS this verb (J5) rather than writing any record,
 * exactly as `seats rename` is already called from there.
 */
function parseSeatFavoriteFlag(flags: { on?: boolean; off?: boolean }): boolean {
  if (flags.on === true && flags.off === true) {
    throw new SeatMutationRefusalError(
      "SEAT_FAVORITE_FLAG_INVALID",
      "pass exactly one of --on or --off, not both.",
    );
  }
  if (flags.on !== true && flags.off !== true) {
    throw new SeatMutationRefusalError(
      "SEAT_FAVORITE_FLAG_INVALID",
      "pass exactly one of --on or --off.",
    );
  }
  return flags.on === true;
}

type SeatFavoriteResult =
  | { readonly kind: "no-change"; readonly favorite: boolean }
  | { readonly kind: "changed"; readonly favorite: boolean };

async function handleSeatsFavorite(
  seatRef: string,
  flags: { on?: boolean; off?: boolean },
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("favorite", format, async () => {
    const seatId = parseSeatIdOrThrow(seatRef);
    const favorite = parseSeatFavoriteFlag(flags);
    const sessionDir = sessionBaseDir();
    const result = await withSeatStoreWrite<SeatFavoriteResult>(sessionDir, (store) => {
      refuseUnwritableStore(store, sessionDir);
      const row = requireSeatRow(store, seatId);
      if (row.favorite === favorite) {
        return { mutation: SEAT_STORE_NO_CHANGE, result: { kind: "no-change", favorite } };
      }
      const seats = new Map(store.seats);
      // SPREAD the fresh row — this touches `favorite` and nothing else, same
      // discipline `set-brick`/`rename`/`close` all follow.
      seats.set(seatId, { ...row, favorite });
      return {
        mutation: { kind: "write", seats } as const,
        result: { kind: "changed", favorite },
      };
    });
    renderSeatFavorite(format, seatId, result);
  });
}

function renderSeatFavorite(
  format: OutputFormat,
  seatId: string,
  result: SeatFavoriteResult,
): void {
  if (
    emitJsonResult(format, {
      ok: true,
      action: result.kind === "no-change" ? "seat_favorite_no_change" : "seat_favorite_set",
      seatId,
      favorite: result.favorite,
      changed: result.kind === "changed",
    })
  ) {
    return;
  }
  if (format === "quiet") {
    return;
  }
  process.stdout.write(`seat ${seatId}: favorite = ${result.favorite}\n`);
}

// ─── delete ──────────────────────────────────────────────────────────────────

/**
 * A PER-ID REPORT, because this verb's outcome is not one verdict.
 *
 * 🛑 A CORRUPT ROW MUST NOT VETO UNRELATED WORK (sub-HoD ruling, 2026-09-29). The
 * caller is a synchronous 5-minute sweep over a changing population: refusing the
 * whole batch because one id's row is unreadable would wedge every other seat the
 * sweep found, forever, on a condition only a human can clear. So the good ids are
 * deleted and WRITTEN, the absent ones are no-op'd, the malformed ones are refused and
 * NAMED — and the exit code is non-zero so nothing reads a partial run as a clean one.
 *
 * ⚠️ WHY A NON-ZERO RC IS SAFE HERE, stated because "partial success at rc 1" is
 * normally an ambiguous shape: a caller that ignores the report and simply retries the
 * whole batch is CORRECT, because delete is idempotent — the already-deleted ids come
 * back as `absent` no-ops. Retrying costs a rewrite and changes nothing else.
 */
export type SeatDeleteOutcome = { deleted: string[]; absent: string[]; malformed: string[] };

/**
 * Remove N rows in ONE hold.
 *
 * ⚠️ THE NEXT STATE IS BUILT FROM `store.seats`, WHICH BY DEFINITION EXCLUDES THE
 * MALFORMED ROWS — and that is fine ONLY because `withSeatStoreWrite` re-emits
 * `store.unparsedRows` verbatim on the way out (`seat-store.ts:210-218`, the
 * data-loss defence). Do not hand this function a map you assembled from anywhere
 * else, and do not reach around the helper to write: either would silently DELETE
 * every malformed row the store is carrying. Row `D7` is exactly this.
 *
 * EXPORTED FOR ONE REASON: it is the only non-trivial mutator in this file, and the
 * AP11 bound — one `seats.json` read, at most one write, and NOTHING else inside the
 * hold — is measured by running THIS function under an fs spy
 * (`test/seats-mutation-verbs.test.ts`, row H1). A test that re-implemented the
 * mutator would be measuring its own copy. `set-brick` and `rename` mutate by a
 * single spread and add no I/O of their own.
 */
export function buildSeatDeletion(
  store: SeatStore,
  seatIds: readonly string[],
): {
  seats: Map<string, SeatRecord>;
  outcome: SeatDeleteOutcome;
} {
  const seats = new Map(store.seats);
  const outcome: SeatDeleteOutcome = { deleted: [], absent: [], malformed: [] };
  for (const seatId of seatIds) {
    // `seatFromStore` stays the ONE place the three states are discriminated —
    // absent / malformed / present never share a value, and re-deriving that here
    // from `store.malformedSeatIds` would be a second copy of the rule. The catch is
    // narrow and per id, which is what makes the partial report possible.
    let row: SeatRecord | undefined;
    try {
      row = seatFromStore(store, seatId);
    } catch (error) {
      if (!(error instanceof MalformedSeatRowError)) {
        throw error;
      }
      // NOT deleted, and NOT reported as absent. The helper re-emits unreadable rows
      // verbatim on the way out, so this row survives the write either way — the
      // report exists so the caller is told rather than left to infer it from a
      // count that does not add up.
      outcome.malformed.push(seatId);
      continue;
    }
    if (!row) {
      outcome.absent.push(seatId);
      continue;
    }
    seats.delete(seatId);
    outcome.deleted.push(seatId);
  }
  return { seats, outcome };
}

async function handleSeatsDelete(
  seatRefs: string[],
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("delete", format, async () => {
    // EVERY ref validated before the hold is taken: a malformed ref is the caller's
    // mistake and must not cost a lock acquisition, let alone a partial write.
    //
    // 🔑 AND DE-DUPLICATED BEFORE THE HOLD, WHICH IS A REPORTING FIX, NOT A SAFETY ONE.
    // The store always ended correct — every lookup runs against the UNMUTATED store
    // read at the top of the hold, so a repeated id simply re-reads as present. What it
    // corrupted was the COUNT: `acpx seats delete <A> <A>` reported `deleted: [A, A]`
    // for one row removed, and the sweep's wiring may well log that number. A
    // machine-readable payload that over-reports is worse than a slow one.
    // `Set` preserves first-insertion order, so the report still reads in the order the
    // caller passed. (Found by the independent test-engineer on the real binary.)
    const seatIds = [...new Set(seatRefs.map((ref) => parseSeatIdOrThrow(ref)))];
    const sessionDir = sessionBaseDir();
    const outcome = await withSeatStoreWrite(sessionDir, (store) => {
      refuseUnwritableStore(store, sessionDir);
      const { seats, outcome: result } = buildSeatDeletion(store, seatIds);
      if (result.deleted.length === 0) {
        // 🛑 `SEAT_STORE_NO_CHANGE`, NOT "write the store back unchanged". Writing an
        // unchanged store is an O(all seats) rewrite that changes nothing — and on an
        // ABSENT store it would CREATE the file, so a sweep that finds nothing to do
        // would mint a seat store on a box that has none. This verb's caller is a
        // 5-minute periodic sweep: finding nothing is its normal steady state.
        return { mutation: SEAT_STORE_NO_CHANGE, result };
      }
      return { mutation: { kind: "write", seats } as const, result };
    });
    renderSeatDelete(format, outcome);
  });
}

function renderSeatDelete(format: OutputFormat, outcome: SeatDeleteOutcome): void {
  const refused = outcome.malformed.length > 0;
  const message = refused ? seatRowsMalformedMessage(outcome.malformed) : undefined;
  renderSeatDeleteReport(format, outcome, message);
  if (refused) {
    // The rc is the only signal a caller that reads nothing else will see, and a
    // partial run must never read as a clean one.
    process.exitCode = 1;
  }
}

function renderSeatDeleteReport(
  format: OutputFormat,
  outcome: SeatDeleteOutcome,
  message: string | undefined,
): void {
  if (
    emitJsonResult(format, {
      // ONE object carrying the WHOLE per-id report, refusal included. A caller must
      // not have to correlate an `ok:false` envelope with a separate success payload
      // to learn which ids were actually deleted.
      ok: message === undefined,
      action: "seats_deleted",
      ...(message === undefined ? {} : { code: "SEAT_ROW_MALFORMED", error: message }),
      deleted: outcome.deleted,
      absent: outcome.absent,
      malformed: outcome.malformed,
      storeWritten: outcome.deleted.length > 0,
    })
  ) {
    return;
  }
  if (format === "quiet") {
    return;
  }
  for (const seatId of outcome.deleted) {
    process.stdout.write(`seat ${seatId}: row deleted\n`);
  }
  for (const seatId of outcome.absent) {
    // A NOTICE, NOT A REFUSAL, and the asymmetry with `set-brick`/`rename` is
    // deliberate: `delete`'s caller sweeps a changing population every 5 minutes, so a
    // missing row is its steady state, while a targeted `set-brick`/`rename` against a
    // missing row means the caller is wrong.
    process.stdout.write(`seat ${seatId}: no row — nothing to delete\n`);
  }
  if (message !== undefined) {
    process.stderr.write(`seats delete: SEAT_ROW_MALFORMED: ${message}\n`);
  }
}

function renderVerifyText(sessionDir: string, stale: number): string {
  return (
    `seat index verify: ${stale} stale index ${stale === 1 ? "entry" : "entries"} ` +
    `(record carries seat_id, index entry lacks seatId) in ${sessionDir}\n`
  );
}

/** The counts every run prints, dry or applied, in the ruling's own headline order:
 * N seats / M index entries / K errors. */
function headlineLines(report: SeatBackfillReport): string[] {
  const repaired =
    report.rowsRepaired > 0 ? ` (row-less seats repaired: ${report.rowsRepaired})` : "";
  return [
    `seat backfill (${report.apply ? "applied" : "DRY RUN — nothing was written"}) — ${report.sessionDir}`,
    `  records scanned:      ${report.recordsScanned}`,
    `  seats:                ${report.seats}${repaired}`,
    `  records seated:       ${report.recordsSeated}`,
    `  index entries:        ${report.indexEntries}`,
    // D-STAR item 3: existing seat rows whose favorite disagreed with "any
    // holder's favorite" and were (or, on a dry run, would be) corrected. `0` on
    // every run after the fleet's first migrating pass — AC4.
    `  favorites migrated:   ${report.favoritesMigrated}`,
    // (d′), brick `9984c510`: existing seat rows whose brick_id was ABSENT and
    // were (or, on a dry run, would be) filled from their holder's own link —
    // open or closed — marked UNVALIDATED. `0` once every absent link has been
    // filled once.
    `  brick links filled:   ${report.brickLinksFilled}`,
    // D-SEAT-HOLD, brick `eca085bb`: existing seat rows with a null holder pointer
    // that were (or, on a dry run, would be) pointed at the seat's holder. `0` once
    // every such row has been filled once.
    `  holders filled:       ${report.activeHoldersFilled}`,
    `  errors:               ${report.errors.length}`,
  ];
}

function detailLines(report: SeatBackfillReport): string[] {
  const lines: string[] = [];
  if (report.recordsWithoutIndexEntry > 0) {
    // ⚠️ "left to reconcile" WAS WRONG AND IS CORRECTED. The index writes this run
    // performs reconcile membership themselves, so these records DO get an entry —
    // the run now makes sure it is a correct one rather than a stale projection
    // taken before the record was seated. Worth the operator's attention, but it is
    // not work deferred to anybody.
    lines.push(
      `  records that had no index entry (entry written from the seated record): ${report.recordsWithoutIndexEntry}`,
    );
  }
  if (report.backupSuffix !== undefined) {
    lines.push(`  rollback copies:      ${report.backups.length} × *${report.backupSuffix}`);
  }
  if (report.staleIndexEntries > 0 || report.apply) {
    lines.push(`  stale index entries:  ${report.staleIndexEntries}`);
  }
  for (const error of report.errors) {
    lines.push(`  ✗ ${error.file} [${error.stage}] ${error.code ?? ""} ${error.message}`);
  }
  lines.push(`  elapsed:              ${report.elapsedMs} ms`);
  // 🛑 THE NOTES ARE PRINTED ON EVERY RUN, DRY OR APPLIED, AND ARE NOT SUPPRESSIBLE.
  // Each states a RULED outcome that the counts above cannot express, and an absence
  // is indistinguishable from an oversight: an operator who is not told that
  // `parent_seat_id` is deliberately unset meets a GAP and files a defect, and one
  // who is not told the run is re-runnable "repairs" an interrupted store by hand.
  // Printed verbatim from `SEAT_BACKFILL_NOTES`, which the acceptance row asserts
  // against — so a line deleted here goes RED rather than quietly disappearing.
  for (const note of report.notes) {
    lines.push(`  · ${note}`);
  }
  return lines;
}

function renderText(report: SeatBackfillReport): string {
  const lines = [
    // The sweep FIRST, because it runs first — the log order is the run order.
    describeAbandonedRecordSweep(report.sweep)
      .replace(/^\[acpx] /, "")
      .trimEnd(),
    ...headlineLines(report),
    ...detailLines(report),
  ];
  return `${lines.join("\n")}\n`;
}

async function handleSeatsBackfill(
  command: Command,
  config: ResolvedAcpxConfig,
  flags: { apply?: boolean; verify?: boolean },
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const sessionDir = sessionBaseDir();
  const apply = flags.apply === true;
  const verify = flags.verify === true;

  // `--verify` ALONE is the standalone counter B12b runs per box: read-only, no
  // plan, no refusal on a sick store. With `--apply` it measures the result, which
  // is the acceptance the brick asks for ("after --apply, zero index entries whose
  // record carries seat_id but whose entry lacks it").
  if (verify && !apply) {
    const stale = await countStaleSeatIndexEntries(sessionDir);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ sessionDir, staleIndexEntries: stale })}\n`);
      return;
    }
    if (format === "quiet") {
      process.stdout.write(`${stale}\n`);
      return;
    }
    process.stdout.write(renderVerifyText(sessionDir, stale));
    return;
  }

  const report = await runSeatBackfill({ sessionDir, apply });
  if (verify) {
    report.staleIndexEntries = await countStaleSeatIndexEntries(sessionDir);
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${report.seats} ${report.indexEntries} ${report.errors.length}\n`);
    return;
  }
  process.stdout.write(renderText(report));
}

// ─── close ───────────────────────────────────────────────────────────────────

/**
 * 🛑 THE ONE STRUCTURAL PROBLEM IN THIS VERB, AND WHY IT IS THREE PHASES —
 * `withSeatStoreWrite`'s `mutate` is SYNCHRONOUS BY DESIGN (`seat-store.ts:584-597`:
 * *"`mutate` RETURNS A VALUE, NEVER A PROMISE, AND THAT IS THE BOUND"*), so it cannot
 * `await` a session-record read. Resolving whether the seat's active holder is open
 * needs exactly that — an async record read — so it cannot happen inside the hold,
 * and a naive read-then-close has a real race: between an unlocked read and the
 * hold, an activation can point a LIVE holder at the seat, and we would close a seat
 * with a live holder.
 *
 * The shape below is copied from `seat-activate.ts`, which already solves this for
 * the same reason (phase 0.1 reads unlocked; phase 2 re-checks `closedAt` fresh
 * inside its own hold):
 *
 *   A (no lock) — read the row, note `active_holder_id` (`H₀`)
 *   B (no lock) — if `H₀ !== null`, resolve its record and decide open / not-open
 *   C (HOLD)    — re-read the row FRESH and decide via `decideSeatClose`, in order:
 *                 ① already closed ⇒ no-op · ② `active_holder_id` moved since A ⇒
 *                 refuse (the vetted holder is not the current one) · ③ the vetted
 *                 holder was open ⇒ refuse · ④ otherwise write
 *
 * Both re-checks in C read the FRESH row — never a value captured before the lock
 * (`withSeatStoreWrite`'s second hard rule).
 */
export type SeatCloseDecision =
  | { readonly kind: "already-closed" }
  | { readonly kind: "holder-changed" }
  | { readonly kind: "holder-open" }
  | { readonly kind: "close" };

/**
 * The CAS decision, extracted as a PURE, EXPORTED function — the same precedent
 * `buildSeatDeletion` sets, and for the same one reason: `SEAT_HOLDER_CHANGED`'s
 * refused state needs an interleaving no single-process CLI row can enter
 * deterministically, and a two-process race is a flaky test, not a test. So a row
 * calls this function directly — the product's own decision function — rather than
 * racing two processes or re-implementing the decision as a second copy.
 *
 * Makes no I/O of its own: `freshRow` MUST already be the row read INSIDE the hold
 * (phase C), and `vettedHolder` MUST already be resolved in the unlocked phase B.
 */
export function decideSeatClose(
  freshRow: SeatRecord,
  vettedHolder: { readonly id: string | null; readonly open: boolean },
): SeatCloseDecision {
  if (freshRow.closedAt !== null && freshRow.closedAt !== undefined) {
    return { kind: "already-closed" };
  }
  if (freshRow.activeHolderId !== vettedHolder.id) {
    return { kind: "holder-changed" };
  }
  if (vettedHolder.open) {
    return { kind: "holder-open" };
  }
  return { kind: "close" };
}

/**
 * Phase B — resolve `holderId`'s record (unlocked) and decide open / not-open.
 *
 * `null` (nobody home) trivially vets as not-open: there is no holder to close
 * first (AC16 ii). A DANGLING pointer — the record cannot be resolved at all —
 * ALSO vets as not-open: refusing would make the seat permanently uncloseable, with
 * no action the operator can take. Judgment call, flagged in PLAN.md §2.2's table.
 */
async function vetActiveHolder(
  holderId: string | null,
): Promise<{ id: string | null; open: boolean; dangling: boolean }> {
  if (holderId === null) {
    return { id: null, open: false, dangling: false };
  }
  try {
    const record = await resolveSessionRecord(holderId);
    // `record.closed` is `boolean | undefined` — anything other than `true` is open,
    // matching `seat-activate.ts`'s successor/predecessor checks elsewhere in this
    // programme (`successor.closed === true`).
    return { id: holderId, open: record.closed !== true, dangling: false };
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return { id: holderId, open: false, dangling: true };
    }
    throw error;
  }
}

/**
 * 🔑 EXPORTED FOR ONE REASON — the same precedent `buildSeatDeletion` sets
 * (`seats-command.ts:446-452`): so a test row can measure the PRODUCT's own
 * message rather than a hand-written paraphrase. A row that reimplemented this
 * string in the test file would pass with the product deleted — see CL4's
 * former "control" block, which did exactly that and was corrected for it.
 */
export function seatHolderOpenMessage(seatId: string, holderId: string): string {
  return (
    `seat ${JSON.stringify(seatId)} refuses to close: its active holder ` +
    `${JSON.stringify(holderId)} is still open per its own record. Close the holder ` +
    // `--session-id`, NOT a bare positional: `sessions close`'s positional `[name]`
    // resolves by SESSION NAME, not by record id (`session-selector.ts`), so a
    // remedy naming the bare id here would be advice that does not work.
    `first (\`acpx sessions close --session-id ${holderId}\`), then retry ` +
    `\`acpx seats close ${seatId}\`. A VACANT seat (no active holder) closes ` +
    `without this step.`
  );
}

/**
 * ⚠️ CORRECTED (independent TE finding F2, 2026-09-29) — this comment used to
 * claim ~~"DELIBERATELY SHARES NO SUBSTRING WITH `seatHolderOpenMessage`, NOR
 * WITH `seatRowMissingMessage` / `seatRowsMalformedMessage` / the
 * unwritable-store message"~~. **That guarantee never held.** Measured: three
 * shared substrings ≥12 chars, longest 56 (the `acpx seats close <seat>`
 * remedy, the `seat "<id>" ` opener, and `": its active holder "`).
 *
 * **The TRUE, narrower guarantee, and why sharing THIS text is correct rather than
 * an oversight:** both refusals come from the SAME command, so an operator needs
 * the same next step from either, and forcing the remedy text apart would make one
 * of the two messages actively worse advice. **The two refusals are discriminated
 * by their CODE (`SEAT_HOLDER_OPEN` vs `SEAT_HOLDER_CHANGED`), never by prose.**
 * What is NOT shared, and what any prose assertion must use if it asserts on text
 * at all: `SEAT_HOLDER_OPEN` alone names the HOLDER ID and directs at `sessions
 * close`; this message alone says "was not closed" / "changed while this close was
 * evaluating it". 🛑 NEVER assert on `/seats close/` or `/active holder/` —
 * measured shared, so a row using either is green whichever refusal fired (B2's
 * AP13 defect, one field over).
 */
function seatHolderChangedMessage(seatId: string): string {
  return (
    `seat ${JSON.stringify(seatId)} was not closed: its active holder changed while ` +
    `this close was evaluating it — a concurrent activation or handover won. Nothing ` +
    `has been written. Re-run \`acpx seats close ${seatId}\` to evaluate the seat's ` +
    `current state.`
  );
}

type SeatCloseResult =
  | { readonly kind: "already-closed"; readonly closedAt: string }
  | {
      readonly kind: "closed";
      readonly closedAt: string;
      readonly holderUnresolvable: string | undefined;
    };

async function handleSeatsClose(
  seatRef: string,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("close", format, async () => {
    const seatId = parseSeatIdOrThrow(seatRef);
    const sessionDir = sessionBaseDir();

    // PHASE A — unlocked read. Also the FIRST row lookup, so a malformed/unwritable
    // store or a missing/malformed row is refused right here, before any async
    // holder resolution — never as a bare "seat not found" (F1's defect).
    const preflightStore = await readSeatStore(sessionDir);
    refuseUnwritableStore(preflightStore, sessionDir);
    const preflightRow = requireSeatRow(preflightStore, seatId);

    // PHASE B — unlocked, async. The record read `mutate` structurally cannot do.
    const vetted = await vetActiveHolder(preflightRow.activeHolderId);

    // PHASE C — THE HOLD. Re-read fresh; decide via the pure, exported function.
    // ⚠️ THE RETURN TYPE IS ANNOTATED EXPLICITLY: without it, TypeScript narrows `T`
    // in `withSeatStoreWrite<T>` per-branch from the switch's individual return
    // statements rather than widening to `SeatCloseResult`, and the branches
    // disagree on `result.kind`'s literal type.
    const result = await withSeatStoreWrite<SeatCloseResult>(sessionDir, (store) => {
      refuseUnwritableStore(store, sessionDir);
      const freshRow = requireSeatRow(store, seatId);
      const decision = decideSeatClose(freshRow, { id: vetted.id, open: vetted.open });
      switch (decision.kind) {
        case "already-closed": {
          const outcome: SeatCloseResult = {
            kind: "already-closed",
            // `freshRow.closedAt` is a string here by construction of this branch.
            closedAt: freshRow.closedAt as string,
          };
          return { mutation: SEAT_STORE_NO_CHANGE, result: outcome };
        }
        case "holder-changed":
          throw new SeatMutationRefusalError(
            "SEAT_HOLDER_CHANGED",
            seatHolderChangedMessage(seatId),
          );
        case "holder-open":
          throw new SeatMutationRefusalError(
            "SEAT_HOLDER_OPEN",
            // `vetted.id` is non-null here: "holder-open" only returns when
            // `vettedHolder.open` is true, which `decideSeatClose` never sets for a
            // `null` holder.
            seatHolderOpenMessage(seatId, vetted.id as string),
          );
        case "close": {
          // 🛑 THE CLOCK READ IS TAKEN HERE, INSIDE THE HOLD — never a value passed
          // in, never a value computed in phase A or B (AC16, SEAT-STORE.md item 2).
          const closedAt = isoNow();
          const seats = new Map(store.seats);
          // SPREAD the fresh row — `close` touches `closed_at` and NOTHING else.
          seats.set(seatId, { ...freshRow, closedAt });
          const outcome: SeatCloseResult = {
            kind: "closed",
            closedAt,
            holderUnresolvable: vetted.dangling ? (vetted.id ?? undefined) : undefined,
          };
          return { mutation: { kind: "write", seats } as const, result: outcome };
        }
        default: {
          // Exhaustive over `SeatCloseDecision["kind"]` — the compiler proves it
          // (typecheck's control-flow analysis), but the linter's simpler analysis
          // cannot, so this satisfies `consistent-return` without weakening the type.
          const unreachable: never = decision;
          throw new Error(`unreachable seat close decision: ${JSON.stringify(unreachable)}`);
        }
      }
    });
    renderSeatClose(format, seatId, result);
  });
}

function renderSeatClose(format: OutputFormat, seatId: string, result: SeatCloseResult): void {
  if (
    emitJsonResult(format, {
      ok: true,
      action: result.kind === "already-closed" ? "seat_close_no_change" : "seat_closed",
      seatId,
      closedAt: result.closedAt,
      changed: result.kind === "closed",
      ...(result.kind === "closed" && result.holderUnresolvable !== undefined
        ? { holderUnresolvable: result.holderUnresolvable }
        : {}),
    })
  ) {
    return;
  }
  if (format === "quiet") {
    return;
  }
  if (result.kind === "already-closed") {
    process.stdout.write(
      `seat ${seatId}: already closed at ${result.closedAt} — no change (rc 0)\n`,
    );
    return;
  }
  process.stdout.write(`seat ${seatId}: closed at ${result.closedAt}\n`);
  if (result.holderUnresolvable !== undefined) {
    process.stdout.write(
      `note: the seat's active holder ${result.holderUnresolvable} record was not ` +
        `resolvable — closing anyway, since there is no holder to close first.\n`,
    );
  }
}

// ─── reopen ──────────────────────────────────────────────────────────────────

/**
 * R7 (brick `d43db3b6`, ruled 2026-09-30T15:2xZ) — the named inverse of `close`.
 *
 * 🛑 **NO ASYNC PRE-PHASE, UNLIKE `close`.** `close` needs phases A/B to vet the
 * active holder before its hold because a race exists — an activation could point a
 * LIVE holder at the seat between an unlocked read and the hold. `reopen` has no
 * such race: it never reads or writes anything about the holder at all (R7 item 2 —
 * "the seat verb never touches a session record"), so there is nothing to vet and
 * this verb's shape is `rename`'s single-hold pattern, not `close`'s three-phase one.
 */
export type SeatReopenDecision = { readonly kind: "already-open" } | { readonly kind: "reopen" };

/**
 * The pure decision, extracted for the same reason `decideSeatClose` is: a direct
 * unit row exercises both branches without spawning a process.
 */
export function decideSeatReopen(freshRow: SeatRecord): SeatReopenDecision {
  if (freshRow.closedAt === null || freshRow.closedAt === undefined) {
    return { kind: "already-open" };
  }
  return { kind: "reopen" };
}

type SeatReopenResult =
  | { readonly kind: "already-open"; readonly activeHolderId: string | null }
  | { readonly kind: "reopened"; readonly activeHolderId: string | null };

async function handleSeatsReopen(
  seatRef: string,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("reopen", format, async () => {
    const seatId = parseSeatIdOrThrow(seatRef);
    const sessionDir = sessionBaseDir();
    const result = await withSeatStoreWrite<SeatReopenResult>(sessionDir, (store) => {
      refuseUnwritableStore(store, sessionDir);
      const row = requireSeatRow(store, seatId);
      const decision = decideSeatReopen(row);
      if (decision.kind === "already-open") {
        return {
          mutation: SEAT_STORE_NO_CHANGE,
          result: { kind: "already-open", activeHolderId: row.activeHolderId },
        };
      }
      const seats = new Map(store.seats);
      // SPREAD the fresh row — reopen touches `closed_at` and NOTHING else.
      // `active_holder_id` and `next_ordinal` are UNCHANGED: re-opening is not a
      // succession (R7 item 2). This is the whole of Daniel's symmetry — reopen the
      // seat, reopen the holder session, and the pointer is exactly where it was.
      seats.set(seatId, { ...row, closedAt: null });
      return {
        mutation: { kind: "write", seats } as const,
        result: { kind: "reopened", activeHolderId: row.activeHolderId },
      };
    });
    renderSeatReopen(format, seatId, result);
  });
}

function renderSeatReopen(format: OutputFormat, seatId: string, result: SeatReopenResult): void {
  if (
    emitJsonResult(format, {
      ok: true,
      action: result.kind === "already-open" ? "seat_reopen_no_change" : "seat_reopened",
      seatId,
      changed: result.kind === "reopened",
      activeHolderId: result.activeHolderId,
    })
  ) {
    return;
  }
  if (format === "quiet") {
    return;
  }
  if (result.kind === "already-open") {
    process.stdout.write(`seat ${seatId}: already open — no change (rc 0)\n`);
    return;
  }
  process.stdout.write(
    `seat ${seatId}: reopened. active_holder_id is UNCHANGED (${
      result.activeHolderId ?? "null — nobody home"
    }) — re-opening is not a succession.\n`,
  );
}

// ─── show / list — the read surface (B2d, brick 88186acd) ────────────────────

/**
 * THE TWO-ENCODINGS RULE. Thin wrapper over the ALREADY-SHIPPED `vetActiveHolder`
 * (used by `close` since B2c) — not re-derived, reused: the same function that
 * decides whether `close` may proceed is the one that decides what `show`/`list`
 * render, so the two can never disagree about what "the holder is open" means.
 *
 * `vacant` and `closed` render IDENTICALLY as "nobody home" (measured on
 * devbox-staging: a backfilled row's `null` and a live-minted row's closed pointer
 * are the SAME fact, encoded two different ways — see this file's header).
 * `record-missing` is the third, distinct state (brick `6cb4f4dc`: the row outlives
 * its holder's record) and is rendered honestly rather than folded into either.
 */
type ActiveHolderState =
  | { readonly kind: "vacant" }
  | { readonly kind: "active"; readonly holderId: string }
  | { readonly kind: "closed"; readonly holderId: string }
  | { readonly kind: "record-missing"; readonly holderId: string };

async function resolveActiveHolderState(activeHolderId: string | null): Promise<ActiveHolderState> {
  const vetted = await vetActiveHolder(activeHolderId);
  if (vetted.id === null) {
    return { kind: "vacant" };
  }
  if (vetted.dangling) {
    return { kind: "record-missing", holderId: vetted.id };
  }
  return vetted.open
    ? { kind: "active", holderId: vetted.id }
    : { kind: "closed", holderId: vetted.id };
}

/** Text rendering — `vacant` and `closed` collapse to ONE string on purpose. */
function renderActiveHolderText(state: ActiveHolderState): string {
  switch (state.kind) {
    case "vacant":
    case "closed":
      return "nobody home";
    case "active":
      return state.holderId;
    case "record-missing":
      return `${state.holderId} (holder record missing)`;
    default: {
      // Exhaustive over `ActiveHolderState["kind"]` — the compiler proves it, the
      // linter's simpler analysis cannot (same shape as `decideSeatClose`'s switch).
      const unreachable: never = state;
      throw new Error(`unreachable active holder state: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** JSON rendering — same collapse as the text form, `vacant`/`closed` both
 * report `state: "nobody-home"`; `closed` additionally carries the id it
 * resolved (for diagnosis), `vacant` carries none because there is none. */
function activeHolderJson(state: ActiveHolderState): { state: string; id: string | null } {
  switch (state.kind) {
    case "vacant":
      return { state: "nobody-home", id: null };
    case "closed":
      return { state: "nobody-home", id: state.holderId };
    case "active":
      return { state: "active", id: state.holderId };
    case "record-missing":
      return { state: "holder-record-missing", id: state.holderId };
    default: {
      const unreachable: never = state;
      throw new Error(`unreachable active holder state: ${JSON.stringify(unreachable)}`);
    }
  }
}

type SeatHolderSummary = {
  readonly id: string;
  readonly ordinal: number | undefined;
  /** `undefined` means the record could not be resolved — reported, not inferred. */
  readonly open: boolean | undefined;
};

/**
 * Every session-index entry naming this seat, each resolved via its OWN record —
 * never the `holderActive` mirror, which is succession-bookkeeping (D-B1-14), not
 * an open/closed fact, and can diverge from it (the whole reason
 * `observeMirrorDivergence` exists on the activation path).
 */
async function listSeatHolders(seatId: string): Promise<SeatHolderSummary[]> {
  const entries: SessionIndexEntry[] = await listSessionIndexEntries();
  const holders: SeatHolderSummary[] = [];
  for (const entry of entries) {
    if (entry.seatId !== seatId) {
      continue;
    }
    let open: boolean | undefined;
    try {
      const record = await resolveSessionRecord(entry.acpxRecordId);
      open = record.closed !== true;
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) {
        throw error;
      }
      open = undefined;
    }
    holders.push({ id: entry.acpxRecordId, ordinal: entry.holderOrdinal, open });
  }
  holders.sort(
    (a, b) => (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER),
  );
  return holders;
}

async function handleSeatsShow(
  seatRef: string,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("show", format, async () => {
    const seatId = parseSeatIdOrThrow(seatRef);
    const sessionDir = sessionBaseDir();
    const store = await readSeatStore(sessionDir);
    refuseUnhealthyStoreForRead(store);
    const row = requireSeatRow(store, seatId);
    const holderState = await resolveActiveHolderState(row.activeHolderId);
    const holders = await listSeatHolders(seatId);
    renderSeatShow(format, row, holderState, holders);
  });
}

function seatShowJsonPayload(
  row: SeatRecord,
  holderState: ActiveHolderState,
  holders: readonly SeatHolderSummary[],
): Record<string, unknown> {
  return {
    ok: true,
    seatId: row.seatId,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    nextOrdinal: row.nextOrdinal,
    name: row.name ?? null,
    brickId: row.brickId?.ref ?? null,
    // Brick `9984c510` — ADDITIVE: `brickId` keeps its existing shape (a bare
    // ref or `null`) for every pre-existing consumer; the validation state
    // rides a NEW sibling key so nothing that already reads `brickId` breaks.
    brickIdValidated: row.brickId ? row.brickId.validated : null,
    // The RAW pointer, exactly as stored — for an operator diagnosing the store
    // itself. Never used above to decide what "active" means; see `activeHolder`.
    activeHolderIdRaw: row.activeHolderId,
    activeHolder: activeHolderJson(holderState),
    holders: holders.map((holder) => ({
      id: holder.id,
      ordinal: holder.ordinal ?? null,
      open: holder.open ?? null,
    })),
  };
}

function describeHolderOpenState(open: boolean | undefined): string {
  if (open === undefined) {
    return "record missing";
  }
  return open ? "open" : "closed";
}

function renderSeatShowText(
  row: SeatRecord,
  holderState: ActiveHolderState,
  holders: readonly SeatHolderSummary[],
): void {
  process.stdout.write(`seat ${row.seatId}\n`);
  process.stdout.write(`  name:          ${row.name ?? "(unnamed)"}\n`);
  process.stdout.write(`  created_at:    ${row.createdAt}\n`);
  process.stdout.write(`  closed_at:     ${row.closedAt ?? "(open)"}\n`);
  process.stdout.write(`  next_ordinal:  ${row.nextOrdinal}\n`);
  process.stdout.write(`  brick_id:      ${renderSeatBrickLinkText(row.brickId)}\n`);
  process.stdout.write(`  active holder: ${renderActiveHolderText(holderState)}\n`);
  process.stdout.write(`  holders (${holders.length}):\n`);
  for (const holder of holders) {
    process.stdout.write(
      `    #${holder.ordinal ?? "?"}  ${holder.id}  ${describeHolderOpenState(holder.open)}\n`,
    );
  }
}

/** Shared text rendering for a seat's brick link — brick `9984c510`. Unvalidated
 * must be UNMISSABLE; validated and absent stay byte-identical to before this
 * brick existed, so an operator reading past rows notices nothing new. */
function renderSeatBrickLinkText(link: SeatBrickLink | undefined): string {
  if (!link) {
    return "(none)";
  }
  return link.validated ? link.ref : `${link.ref} ⚠ UNVALIDATED`;
}

function renderSeatShow(
  format: OutputFormat,
  row: SeatRecord,
  holderState: ActiveHolderState,
  holders: readonly SeatHolderSummary[],
): void {
  if (emitJsonResult(format, seatShowJsonPayload(row, holderState, holders))) {
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${row.seatId}\n`);
    return;
  }
  renderSeatShowText(row, holderState, holders);
}

/**
 * 🛑 SIX COLUMNS, WIDENED FROM FIVE 2026-09-30T16:17:04Z (the programme owner, on
 * the TE's V3 finding) — `brickId` joins the cut. The relation this programme moved
 * from the session onto the seat is the brick link, so an operator's read surface
 * that could not answer "which seat holds brick X" was missing exactly that. C2's
 * absence-is-a-value rule, which already governs `name`, now governs this field too
 * — see `renderSeatList`'s JSON branch for what that means in practice.
 */
type SeatListRow = {
  readonly seatId: string;
  readonly name: string | undefined;
  readonly brickId: SeatBrickLink | undefined;
  readonly closed: boolean;
  readonly holderCount: number;
  readonly holderState: ActiveHolderState;
};

/** One pass over the index — never one scan PER SEAT, which would be O(seats ×
 * index size) on a box-sized store. */
async function countHoldersBySeat(): Promise<Map<string, number>> {
  const entries = await listSessionIndexEntries();
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.seatId === undefined) {
      continue;
    }
    counts.set(entry.seatId, (counts.get(entry.seatId) ?? 0) + 1);
  }
  return counts;
}

async function handleSeatsList(
  command: Command,
  config: ResolvedAcpxConfig,
  flags: { closed?: boolean; open?: boolean },
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("list", format, async () => {
    const sessionDir = sessionBaseDir();
    const store = await readSeatStore(sessionDir);
    refuseUnhealthyStoreForRead(store);
    const filter = seatListFilterFlags(flags);
    const counts = await countHoldersBySeat();
    const rows: SeatListRow[] = [];
    for (const [seatId, row] of store.seats) {
      const closed = row.closedAt !== null && row.closedAt !== undefined;
      if (!includeSeatInList(closed, filter)) {
        continue;
      }
      rows.push(await buildSeatListRow(seatId, row, closed, counts.get(seatId) ?? 0));
    }
    rows.sort((a, b) => a.seatId.localeCompare(b.seatId));
    renderSeatList(format, rows, store.malformedSeatIds);
  });
}

/** `--closed` and `--open` TOGETHER mean "no filtering" — see the verb's own
 * help text for why that is not treated as a conflict to refuse. */
function seatListFilterFlags(flags: { closed?: boolean; open?: boolean }): {
  onlyClosed: boolean;
  onlyOpen: boolean;
} {
  return {
    onlyClosed: flags.closed === true && flags.open !== true,
    onlyOpen: flags.open === true && flags.closed !== true,
  };
}

function includeSeatInList(
  closed: boolean,
  filter: { onlyClosed: boolean; onlyOpen: boolean },
): boolean {
  if (filter.onlyClosed) {
    return closed;
  }
  if (filter.onlyOpen) {
    return !closed;
  }
  return true;
}

async function buildSeatListRow(
  seatId: string,
  row: SeatRecord,
  closed: boolean,
  holderCount: number,
): Promise<SeatListRow> {
  const holderState = await resolveActiveHolderState(row.activeHolderId);
  return { seatId, name: row.name, brickId: row.brickId, closed, holderCount, holderState };
}

function seatListRowJson(row: SeatListRow): Record<string, unknown> {
  return {
    seatId: row.seatId,
    name: row.name ?? null,
    // ALWAYS PRESENT, `null` when unset — never absent (C2's absence-is-a-value
    // rule, widened onto this field 2026-09-30). A key that disappears when empty
    // forces every consumer to distinguish "absent" from "null".
    brickId: row.brickId?.ref ?? null,
    // Brick `9984c510` — ADDITIVE sibling, same shape as `seats show`'s payload.
    brickIdValidated: row.brickId ? row.brickId.validated : null,
    closed: row.closed,
    holderCount: row.holderCount,
    activeHolder: activeHolderJson(row.holderState),
  };
}

function seatListRowText(row: SeatListRow): string {
  return (
    `${row.seatId}  ${row.name ?? "(unnamed)"}  brick=${seatListBrickText(row.brickId)}  ` +
    `active=${renderActiveHolderText(row.holderState)}  holders=${row.holderCount}  ` +
    `${row.closed ? "CLOSED" : "open"}\n`
  );
}

/** The list view's compact brick rendering — an 8-char prefix, same as before
 * brick `9984c510` when validated; marked when not, so a column scan does not
 * have to open each seat individually to notice an unvalidated link. */
function seatListBrickText(link: SeatBrickLink | undefined): string {
  if (!link) {
    return "-";
  }
  const short = link.ref.slice(0, 8);
  return link.validated ? short : `${short}⚠`;
}

function renderSeatList(
  format: OutputFormat,
  rows: readonly SeatListRow[],
  malformedSeatIds: readonly string[],
): void {
  if (
    emitJsonResult(format, {
      ok: true,
      seats: rows.map(seatListRowJson),
      malformed: malformedSeatIds,
    })
  ) {
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${rows.length}\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(seatListRowText(row));
  }
  for (const seatId of malformedSeatIds) {
    process.stderr.write(
      `seat ${seatId}: row MALFORMED — not listed; see \`acpx seats show ${seatId}\`\n`,
    );
  }
}

// ─── registration ────────────────────────────────────────────────────────────

/**
 * ⚠️ TWO REGISTRATIONS. This one, and `"seats"` in `TOP_LEVEL_VERBS`
 * (`src/cli-core.ts`) — IN THE SAME COMMIT. See this file's header for what
 * happens when only one lands.
 *
 * 🛑 **ONE REGISTRAR, EIGHT SUBCOMMANDS — AND THIS IS A TWICE-MERGED FILE, SO READ
 * THAT AS A CONSTRAINT RATHER THAN A DESCRIPTION.** B2b (`set-brick`, `rename`,
 * `delete`), B10 (`backfill`), B2c (`close`) and B2d (`list`, `show`, `reopen`) each
 * created or extended this file, all exporting/registering under the SAME SYMBOL.
 * The union is semantic, not textual: resolving that add/add by keeping either side
 * produces a binary that compiles, starts and answers **with the other side's verbs
 * silently missing** — and nothing in the type system can see it.
 *
 * ⚠️ **B2c's merge added a SECOND failure shape the first union did not have.** Git
 * interleaved `backfill` and `close` so their shared tail lines (`.option("--format
 * …")`, `.addHelpText("after", …)`) sat OUTSIDE the conflict markers — a keep-both
 * that leaves that tail shared yields ONE chain wearing the other's options and help
 * text. Each verb below is therefore a COMPLETE, SEPARATE `seatsCommand.command(…)`
 * chain, and that separation is load-bearing rather than stylistic.
 *
 * The other two collision points announce themselves, which is why the care belongs
 * here: a duplicated call to this function makes commander 14 THROW at CLI setup
 * (`cannot add command 'seats' as already have command 'seats'`), breaking every
 * `acpx` invocation rather than just `acpx seats`; and a duplicated `"seats"` in
 * `TOP_LEVEL_VERBS` is inert, because it is a `Set`. Both were measured, not assumed.
 *
 * `test/seat-backfill.test.ts` L16a pins a four-name floor and L16b pins the
 * single registration (a floor, not an exact count — it predates `close` and B2d
 * and does not need to enumerate every verb to do its job).
 */
export function registerSeatsCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const seatsCommand = parent.command("seats").description(
    // ⚠️ NAMES EVERY VERB. This string is the only place an operator discovers
    // what exists, so a merge that keeps one lane's wording silently un-advertises
    // the other lane's verbs while every verb still works.
    "The seat store (~/.acpx/sessions/seats.json): set a seat's brick, rename a seat, " +
      "star/un-star a seat, close or reopen a seat, delete seat rows, list/show seats, and " +
      "backfill seats for sessions that predate the store. acpx owns every write to this " +
      "store; call these verbs rather than writing the file.",
  );

  seatsCommand
    .command("set-brick")
    .description(
      "Point a seat at a brick — the write behind `brick attach` — or clear it with --unset",
    )
    .argument("<seat>", "The seat, by id (a lowercase UUID)")
    .argument(
      "[brick]",
      "The brick, by FULL uuid — short refs are rejected, never resolved. Omit with --unset",
    )
    .option("--unset", "Clear the seat's brick_id instead of setting one")
    .option(
      "--validated",
      "Assert the ref was already confirmed to resolve (the CALLER's claim, e.g. `brick " +
        "attach` resolving it before shelling out here) — write brick_id_validated=true " +
        "instead of the default false. This verb itself never calls `brick show`. Not " +
        "valid with --unset.",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
A SHORT BRICK REF IS REJECTED, NOT RESOLVED.
  Resolving one means running the \`brick\` CLI, measured at ~9 s on a loaded box
  against a 3 s timeout — so the resolution would fail this command rather than
  the ref. \`brick attach\` already holds the full uuid.

THIS VERB NEVER VALIDATES THE REF ITSELF — brick_id_validated DEFAULTS TO false.
  A full uuid is checked for SHAPE only. Pass --validated when the caller already
  confirmed the brick exists (brick 9984c510); omit it for a bare operator set.

PASS EXACTLY ONE OF <brick> OR --unset. Neither, or both, is refused
  (SEAT_BRICK_ARGS_INVALID) before anything is written.
`,
    )
    .action(async function (
      this: Command,
      seat: string,
      brick: string | undefined,
      flags: { unset?: boolean; validated?: boolean },
    ) {
      await handleSeatsSetBrick(seat, brick, flags, this, config);
    });

  seatsCommand
    .command("rename")
    .description("Set a seat's name. Writes the SEAT ROW ONLY — never a holder's record")
    .argument("<seat>", "The seat, by id (a lowercase UUID)")
    .argument("<name>", "The new name — taken byte-identical; rejected, never trimmed")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
🛑 THIS WRITES THE SEAT ROW AND NOTHING ELSE.
  The seat record is the authority for the name; a holder's copy is a derived
  projection.

  Writing the holder's record instead would be a SILENT NO-OP: every preserving
  record write restores \`name\` from the on-disk value, and there is no \`name\`
  authority flag to bypass it.
`,
    )
    .action(async function (this: Command, seat: string, name: string) {
      await handleSeatsRename(seat, name, this, config);
    });

  seatsCommand
    .command("favorite")
    .description(
      "Star or un-star a seat. Writes the SEAT ROW ONLY, under the index lock — " +
        "the star belongs to the seat, not any session (Daniel's D-STAR ruling)",
    )
    .argument("<seat>", "The seat, by id (a lowercase UUID)")
    .option("--on", "Star the seat")
    .option("--off", "Un-star the seat")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
EXACTLY ONE OF --on / --off IS REQUIRED. Passing both, or neither, is refused.

IDEMPOTENT. Setting a seat to the value it already holds is a no-op — \`changed:
  false\` in the JSON payload, not an error, and the row is not rewritten.

THE STAR BELONGS TO THE SEAT, NOT ANY SESSION (Daniel's ruling D-STAR,
  2026-09-30). A starred seat's ACTIVE holder is refused archival by
  \`acpx sessions archive\`; a RETIRED holder of the same seat is not — there is
  no "what if the only starred holder gets archived", because the star does not
  live on a holder any more.
`,
    )
    .action(async function (this: Command, seat: string, flags: { on?: boolean; off?: boolean }) {
      await handleSeatsFavorite(seat, flags, this, config);
    });

  seatsCommand
    .command("delete")
    .description("Remove seat rows. Variadic: one invocation, one hold, N rows")
    .argument("<seats...>", "One or more seats, by id (lowercase UUIDs)")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
DELETE IS NOT CLOSE. This REMOVES the row; \`acpx seats close\` KEEPS the row and
  stamps \`closed_at\` — collapsing the two would destroy the only thing
  \`closed_at\` records. Deleting a CLOSED seat succeeds, which is what the byway
  sweep needs.

A SEAT WITH NO ROW IS A NO-OP, NOT A REFUSAL (exit 0). The caller is a periodic
  sweep over a changing population; a missing row is its steady state. Nothing is
  written in that case — an absent store is not created.

A SEAT WHOSE OWN ROW IS MALFORMED IS REFUSED, AND ONLY THAT SEAT. The good ids in
  the same invocation are still deleted and written; the malformed ones are named
  with their repair, and the exit code is 1 so a partial run never reads as clean.
  Retrying the whole batch is safe — delete is idempotent.


VARIADIC ON PURPOSE. The sweep is a synchronous batch loop, so one invocation per
  swept seat would fork a process per row and multiply lock contention against a
  store whose every write is O(all seats).
`,
    )
    .action(async function (this: Command, seats: string[]) {
      await handleSeatsDelete(seats, this, config);
    });

  seatsCommand
    .command("backfill")
    .description(
      "Mint a seat for every hot-tier session record that lacks one: the seat_id onto the " +
        "record, the seat field group onto its index entry, and one row per distinct seat in " +
        "seats.json. DRY RUN BY DEFAULT — --apply is the only writer.",
    )
    .option("--apply", "Write. Without it this is a dry run that touches nothing.")
    .option(
      "--verify",
      "Count index entries whose record carries seat_id but whose entry lacks seatId. Alone: a read-only count. With --apply: measured after the run.",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
WHAT IT WRITES, PER RECORD, IN THIS ORDER — and the order is the point.
  1. the RECORD      seat_id + holder_ordinal + holder_active
  2. the INDEX ENTRY the same field group, through the shared projection helper
  3. the SEAT ROW    one row per distinct seat_id, through the single writer
  An index entry therefore never claims a seat the record lacks — and a record whose
  write fails takes its own index and row legs with it, rather than half-landing.

🛑 RUN THIS ON A QUIET BOX. B12a FORBIDS backfilling while sessions are live, and
  this is a precondition rather than advice. The index lock PROCEEDS UNLOCKED after
  ~2 s of contention by design (ratified); concurrent writers were measured losing
  writes from 8 upward — with every contender exiting 0 and empty stderr, so THE
  LOSS IS SILENT. This run holds that contention for minutes, against the one
  artefact in the design that cannot be rebuilt from anything.

IDEMPOTENT, AND SAFE TO RE-RUN IF YOU INTERRUPT IT. A second --apply reports 0 and
leaves seats.json byte-identical. A dry run writes nothing at all. Records that
already carry a seat, and index entries that already agree with their record, are
left BYTE-IDENTICAL.
  On a box-sized store this takes MINUTES — it is not hung. If you do kill it, every
  file is written temp-file-plus-rename, so nothing is left half-written; re-run it
  and it completes the remainder. Do not repair an interrupted store by hand.

parent_seat_id IS DELIBERATELY NOT SET by this verb (ruled 2026-09-29). That is
  incompleteness, not a defect: both sides undefined AGREE, so nothing diverges and
  routing keys on seat_id regardless. Leaving it unset is recoverable by a later
  pass; setting it WRONG across every record would not be, and seats.json is the one
  artefact in the design that cannot be rebuilt from anything.

ROLLBACK. --apply first copies the index, seats.json and every record it is about to
touch aside as <file>.bak-mig-<TS>. Restoring those copies over the originals returns
the store to its exact pre-apply state.

IT REFUSES rather than overwriting:
  - a seats.json that exists and does not parse, or cannot be read. It CANNOT repair
    corruption; quarantine the file first (the error prints the step).
  - an index.json that exists and fails readSessionIndex's all-or-nothing contract.
Neither refusal writes anything, including the rollback copies.

NO EXCLUSIONS. Template and subagent records get seats too.

THE ABANDONED-RECORD SWEEP RUNS FIRST and is REPORT-ONLY here — it names the open
records with no live owner; closing one is \`sessions close\`'s job, not this verb's.
`,
    )
    .action(async function (this: Command, flags: { apply?: boolean; verify?: boolean }) {
      await handleSeatsBackfill(this, config, flags);
    });

  seatsCommand
    .command("close")
    .description("Deliberately close a seat — the seat is abolished, and the row is KEPT")
    .argument("<seat>", "The seat, by id (a lowercase UUID)")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
CLOSE IS NOT DELETE. This KEEPS the row and stamps \`closed_at\` with a clock read
  taken inside the write; \`acpx seats delete\` removes the row entirely. There is
  NO --at / timestamp argument: a caller-supplied close time is unrepresentable,
  never merely refused.

REFUSES if the seat's active holder is still open per its own record — close the
  holder first (\`acpx sessions close --session-id <holder>\`). A VACANT seat (no
  active holder) closes without that step.

IDEMPOTENT. A second close on an already-closed seat is a no-op with a notice and
  exit 0 — not an error, and the timestamp does not move.

ONCE CLOSED, A SEAT REFUSES \`acpx sessions activate\` and refuses create-into-seat,
  UNTIL REOPENED. \`acpx seats reopen <seat>\` clears \`closed_at\` back to null and
  touches nothing else — see \`acpx seats reopen --help\`.
`,
    )
    .action(async function (this: Command, seat: string) {
      await handleSeatsClose(seat, this, config);
    });

  seatsCommand
    .command("reopen")
    .description("Reverse a close — clears `closed_at`, touches nothing else")
    .argument("<seat>", "The seat, by id (a lowercase UUID)")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
THE NAMED INVERSE OF \`close\`, AND NOTHING WIDER. Sets \`closed_at\` back to null.
  \`active_holder_id\` and \`next_ordinal\` are UNCHANGED — re-opening is not a
  succession, and this verb never reads or writes a session record. Daniel's
  symmetry: reopen the seat, reopen the holder session, and the pointer is
  exactly where it was.

IDEMPOTENT. Reopening a seat that is not closed is a no-op with a notice and
  exit 0 — not an error.

NO EIGHTH FIELD. A reopened seat is indistinguishable on the row from one never
  closed — there is no \`reopened_at\` trace. Accepted deliberately: the ask was
  symmetry with session close/reopen, not an audit trail.

NEVER AUTOMATIC. No verb, sweep or backfill reopens a seat on its own — this is
  the only writer of \`closed_at\` back to null anywhere in the product.
`,
    )
    .action(async function (this: Command, seat: string) {
      await handleSeatsReopen(seat, this, config);
    });

  seatsCommand
    .command("show")
    .description("Show one seat's row and its holders")
    .argument("<seat>", "The seat, by id (a lowercase UUID)")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
THE ACTIVE HOLDER IS DERIVED, NEVER THE ROW'S RAW POINTER. \`active_holder_id\`
  alone cannot say who is active: every backfilled row carries \`null\` once its
  sole holder is closed, while a live-minted row whose holder is later closed
  KEEPS the closed session's id — two encodings of the same fact. This verb
  resolves the pointer against the holder's OWN record and renders a null
  pointer and a closed pointer IDENTICALLY as "nobody home"; a pointer naming a
  record that no longer exists on disk renders as "holder record missing"
  rather than being folded into either of the other two.

HOLDERS ARE LISTED FROM THE SESSION INDEX, each resolved via its own record —
  not the \`holder_active\` mirror, which is succession bookkeeping and can
  diverge from the record's own open/closed fact.

READ-ONLY. Never writes \`seats.json\`; a malformed row or a malformed/unreadable
  store is reported as such, never repaired, and a missing row is a DISTINCT
  message from a missing seat id (run the seat backfill for the former).
`,
    )
    .action(async function (this: Command, seat: string) {
      await handleSeatsShow(seat, this, config);
    });

  seatsCommand
    .command("list")
    .description("List every seat row: id, name, brick, active holder, holder count, closed marker")
    .option("--closed", "Only closed seats")
    .option("--open", "Only open (not-closed) seats")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
SAME TWO-ENCODINGS RULE AS \`show\`: the active holder column is derived from the
  holder's own record, never the row's raw \`active_holder_id\` — see
  \`acpx seats show --help\`.

--closed AND --open TOGETHER list everything (no filtering) — passing both is
  not a refusal, since a caller building the flag from two independent booleans
  should not have to special-case "neither" vs "both" meaning the same thing.

READ-ONLY, one pass over the store and one pass over the session index — never
  a scan per seat. A malformed/unreadable STORE refuses (SEAT_STORE_UNHEALTHY);
  a seat whose own ROW is malformed is named on stderr and excluded from the
  listing rather than silently dropped.
`,
    )
    .action(async function (this: Command, flags: { closed?: boolean; open?: boolean }) {
      await handleSeatsList(this, config, flags);
    });
}
