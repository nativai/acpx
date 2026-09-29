import type { Command } from "commander";
import {
  SEAT_STORE_NO_CHANGE,
  SeatStoreUnwritableError,
  MalformedSeatRowError,
  parseSeatRefOrThrow,
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
 * `acpx seats set-brick` / `rename` / `delete` — **B2b, brick 03bc080b.**
 *
 * ## Why these three live here rather than at their callers
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
 * ## What this file deliberately does NOT do
 *
 * - **Nothing here writes `closed_at`.** Seat *closure* is B2c's verb. `delete`
 *   REMOVES the row; close KEEPS it and stamps it, and a writer that collapses the
 *   two destroys the only thing `closed_at` records (ratification item 2). The
 *   three verbs are otherwise indifferent to the field: they preserve it by
 *   spreading the fresh row.
 * - **No closed-seat refusal.** Item 2 places a closed seat's refusals on
 *   `activate` and create-into-seat, not here — and until B2c lands nothing in the
 *   product can write a closure, so such a refusal would have a structurally
 *   unreachable refused state. Consequence, stated loudly: **`seats delete` on a
 *   closed seat SUCCEEDS**, which is correct and is what the byway sweep needs.
 * - **No `--unset` on `set-brick`.** No caller needs it (`brick attach` always
 *   sets), so it would ship as an untested path. Consequence: once set, `brick_id`
 *   cannot be cleared by any verb in B2b.
 * - **No short-ref resolution.** See `parseBrickIdOrThrow`.
 */

type SeatMutationRefusalCode =
  | "SEAT_REF_INVALID"
  | "BRICK_REF_INVALID"
  | "SEAT_NAME_INVALID"
  | "SEAT_ROW_MISSING"
  | "SEAT_ROW_MALFORMED"
  | "SEAT_STORE_UNWRITABLE";

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

/** The errors a seat mutation may legitimately refuse with, normalised to one shape. */
function asSeatRefusal(error: unknown): SeatMutationRefusalError | undefined {
  if (error instanceof SeatMutationRefusalError) {
    return error;
  }
  if (error instanceof MalformedSeatRowError) {
    return new SeatMutationRefusalError("SEAT_ROW_MALFORMED", error.message);
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
    // ⚠️ PRINTED EVERY TIME, DELIBERATELY. The seat is the authority for the name and
    // no reader reads it yet, so this rename is invisible in every surface an operator
    // is looking at while they run it. Saying so beats having them conclude the verb
    // is broken. Delete this line when B7b lands — not before.
    process.stdout.write(
      `note: the seat is the authority for its name, and until readers read the seat ` +
        `(B7b) the rail, board, chat header and Fleet still label a session from its own ` +
        `record — so this rename will not be visible there yet.\n`,
    );
  });
}

// ─── delete ──────────────────────────────────────────────────────────────────

export type SeatDeleteOutcome = { deleted: string[]; absent: string[] };

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
  const outcome: SeatDeleteOutcome = { deleted: [], absent: [] };
  for (const seatId of seatIds) {
    // Throws for a row that is present and unreadable: `delete` refuses rather than
    // dropping it, because the helper carries unparsed rows across a write by design
    // and a row nobody can read may still be hand-recoverable.
    const row = seatFromStore(store, seatId);
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
    const seatIds = seatRefs.map((ref) => parseSeatIdOrThrow(ref));
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
  if (
    emitJsonResult(format, {
      ok: true,
      action: "seats_deleted",
      deleted: outcome.deleted,
      absent: outcome.absent,
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
        "seat, delete seat rows. acpx owns every write to this store; call these verbs " +
        "rather than writing the file.",
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
DELETE IS NOT CLOSE. This REMOVES the row; closing a seat KEEPS the row and stamps
  \`closed_at\`, and nothing here ever writes that field — a writer that collapsed
  the two would destroy the only thing \`closed_at\` records. Deleting a CLOSED
  seat succeeds, which is what the byway sweep needs.

A SEAT WITH NO ROW IS A NO-OP, NOT A REFUSAL (exit 0). The caller is a periodic
  sweep over a changing population; a missing row is its steady state. Nothing is
  written in that case — an absent store is not created.

VARIADIC ON PURPOSE. The sweep is a synchronous batch loop, so one invocation per
  swept seat would fork a process per row and multiply lock contention against a
  store whose every write is O(all seats).
`,
    )
    .action(async function (this: Command, seats: string[]) {
      await handleSeatsDelete(seats, this, config);
    });
}
