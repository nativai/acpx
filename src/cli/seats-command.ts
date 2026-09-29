import type { Command } from "commander";
import { SessionNotFoundError } from "../errors.js";
import {
  SEAT_STORE_FILE,
  SEAT_STORE_NO_CHANGE,
  SeatStoreUnwritableError,
  MalformedSeatRowError,
  isoNow,
  parseSeatRefOrThrow,
  readSeatStore,
  resolveSessionRecord,
  seatFromStore,
  seatRowMissingMessage,
  seatStorePath,
  sessionBaseDir,
  withSeatStoreWrite,
  type SeatRecord,
  type SeatStore,
} from "../session/persistence.js";
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
 * ⚠️ **THE ACCEPTED COST, STATED SO IT IS NOT DISCOVERED:** until B7b makes readers
 * read the seat, a `seats rename` **appears to do nothing** in the rail, the board,
 * the chat header and Fleet — all four still label a session from its record. That
 * is a contemplated state, not a defect (C2 phase (i) has the two sides disagreeing
 * *with the seat winning*), it expires with B7b, and the verb says so in its own
 * output rather than leaving the operator to wonder. `RN2′` in
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
 * ## What this file deliberately does NOT do
 *
 * - **No `--unset` on `set-brick`.** No caller needs it (`brick attach` always
 *   sets), so it would ship as an untested path. Consequence: once set, `brick_id`
 *   cannot be cleared by any verb in B2b.
 * - **No short-ref resolution.** See `parseBrickIdOrThrow`.
 * - **No re-open verb.** Nothing in the record asks for one, and `close` is
 *   deliberately the only writer of a `closed_at` **timestamp** anywhere in the
 *   product (SEAT-STORE.md item 2, AC16). Once closed, a seat stays closed as far
 *   as any shipped verb is concerned.
 * - **No `--at` / timestamp argument on `close`.** The written value is always a
 *   clock read taken INSIDE the write hold — never a caller-supplied or
 *   caller-influenced value. Unrepresentable, not merely refused.
 */

type SeatMutationRefusalCode =
  | "SEAT_REF_INVALID"
  | "BRICK_REF_INVALID"
  | "SEAT_NAME_INVALID"
  | "SEAT_ROW_MISSING"
  | "SEAT_ROW_MALFORMED"
  | "SEAT_STORE_UNWRITABLE"
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

async function handleSeatsSetBrick(
  seatRef: string,
  brickRef: string,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  await runSeatMutation("set-brick", format, async () => {
    const seatId = parseSeatIdOrThrow(seatRef);
    const brickId = parseBrickIdOrThrow(brickRef);
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
    if (
      emitJsonResult(format, {
        ok: true,
        action: "seat_brick_set",
        seatId,
        brickId,
        previousBrickId: previousBrickId ?? null,
      })
    ) {
      return;
    }
    if (format === "quiet") {
      return;
    }
    process.stdout.write(
      `seat ${seatId}: brick_id = ${brickId}` +
        `${previousBrickId === undefined ? "" : ` (was ${previousBrickId})`}\n`,
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
    process.stdout.write(`seat ${seatId}: name = ${JSON.stringify(name)}\n`);
    // ⚠️ PRINTED EVERY TIME, DELIBERATELY, AND ON THE TEXT PATH ONLY — a scripted
    // caller's `--format json` payload must never gain a prose line, which
    // `test/seats-mutation-verbs.test.ts` row RN11 asserts. The seat is the authority
    // for the name and no reader reads it yet, so this rename is invisible in every
    // surface an operator is looking at while they run it; saying so beats having them
    // conclude the verb is broken.
    //
    // 🛑 EXPIRY CONDITION — DELETE THIS NOTICE WHEN **B7b (brick 693ed2a9)** MAKES
    // READERS READ THE SEAT, and not before. It is stated here rather than in a
    // document so whoever next edits this function meets it; B7b's brief carries
    // "delete the rename notice" as an explicit deliverable.
    process.stdout.write(
      `note: the seat is the authority for its name, and until readers read the seat ` +
        `(B7b) the rail, board, chat header and Fleet still label a session from its own ` +
        `record — so this rename will not be visible there yet.\n`,
    );
  });
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

// ─── registration ────────────────────────────────────────────────────────────

/**
 * ⚠️ TWO REGISTRATIONS. This one, and `"seats"` in `TOP_LEVEL_VERBS`
 * (`src/cli-core.ts`) — IN THE SAME COMMIT. See this file's header for what
 * happens when only one lands.
 */
export function registerSeatsCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const seatsCommand = parent
    .command("seats")
    .description(
      "Mutate the seat store (~/.acpx/sessions/seats.json): set a seat's brick, rename a " +
        "seat, close a seat, delete seat rows. acpx owns every write to this store; call " +
        "these verbs rather than writing the file.",
    );

  seatsCommand
    .command("set-brick")
    .description("Point a seat at a brick — the write behind `brick attach`")
    .argument("<seat>", "The seat, by id (a lowercase UUID)")
    .argument("<brick>", "The brick, by FULL uuid — short refs are rejected, never resolved")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
A SHORT BRICK REF IS REJECTED, NOT RESOLVED.
  Resolving one means running the \`brick\` CLI, measured at ~9 s on a loaded box
  against a 3 s timeout — so the resolution would fail this command rather than
  the ref. \`brick attach\` already holds the full uuid.

THERE IS NO --unset. Once set, \`brick_id\` is not cleared by any verb in B2b.
`,
    )
    .action(async function (this: Command, seat: string, brick: string) {
      await handleSeatsSetBrick(seat, brick, this, config);
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
🛑 THIS WRITES THE SEAT ROW AND NOTHING ELSE, AND YOU WILL NOT SEE IT YET.
  The seat record is the authority for the name; a holder's copy is a derived
  projection. Until B7b makes readers read the seat, the rail, the board, the chat
  header and Fleet all still label a session from its OWN record — so a rename is
  correct, durable, and invisible in those four surfaces until then.

  Writing the holder's record instead would be a SILENT NO-OP: every preserving
  record write restores \`name\` from the on-disk value, and there is no \`name\`
  authority flag to bypass it.
`,
    )
    .action(async function (this: Command, seat: string, name: string) {
      await handleSeatsRename(seat, name, this, config);
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

ONCE CLOSED, A SEAT REFUSES \`acpx sessions activate\` and refuses create-into-seat.
  THERE IS NO RE-OPEN VERB: nothing in this CLI ever clears \`closed_at\` back to
  null.
`,
    )
    .action(async function (this: Command, seat: string) {
      await handleSeatsClose(seat, this, config);
    });
}
