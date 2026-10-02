import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  MalformedSeatRowError,
  SeatStoreUnhealthyError,
  seatStoreUnhealthyMessage,
  SeatStoreUnwritableError,
  migrateSeatFavorite,
  parseSeatStore,
  readSeatStore,
  SEAT_RECORD_FIELD_PLAN,
  SEAT_STORE_FILE,
  SEAT_STORE_NO_CHANGE,
  type SeatRecord,
  seatFromStore,
  seatStorePath,
  withSeatStoreWrite,
} from "../src/session/persistence/seat-store.js";
import { withTempDir } from "./runtime-test-helpers.js";

// The seat store — `~/.acpx/sessions/seats.json`, the AUTHORITY for which holder
// sits in which seat (brick b64dfbb3 / B2; SEAT-STORE.md, ratified 2026-09-28).
//
// These rows defend four properties, in descending order of what they cost if
// they break: the field set stays CLOSED AT SEVEN; the critical section cannot
// acquire a third operation; absent / malformed / present are three states that
// never collapse into two; and a write is atomic and total.

function seat(overrides: Partial<SeatRecord> = {}): SeatRecord {
  return {
    seatId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-09-28T00:00:00.000Z",
    activeHolderId: "holder-a",
    nextOrdinal: 2,
    closedAt: null,
    name: undefined,
    brickId: undefined,
    favorite: false,
    ...overrides,
  };
}

async function readRaw(dir: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await fs.readFile(seatStorePath(dir), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
}

// ─── 1 · THE CLOSED SET — eight fields, and the falsifier for a ninth ────────

test("the seat record field set is CLOSED AT EIGHT — a ninth field fails this row", () => {
  // 🛑 THIS ROW IS THE FALSIFIER FOR "the record carries eight fields". Widened
  // from seven to eight 2026-09-30 for `favorite` alone — Daniel's D-STAR ruling
  // REOPENED the closed seven-field set for this ONE additive field, which is his
  // decision and NOT a precedent for a ninth. Two ninth-field proposals were
  // already made and withdrawn before this widening (`holder_count`, struck by
  // Daniel; `mirror_divergences`, withdrawn 2026-09-28T13:30Z), so this remains a
  // live pressure. The compiler forces the PLAN to be exhaustive over
  // `SeatRecord`; this row forces the COUNT, which the compiler cannot:
  // registering a new field would satisfy the `satisfies` and still red here,
  // which is exactly the review moment that should happen.
  assert.deepEqual(Object.keys(SEAT_RECORD_FIELD_PLAN).toSorted(), [
    "activeHolderId",
    "brickId",
    "closedAt",
    "createdAt",
    "favorite",
    "name",
    "nextOrdinal",
    "seatId",
  ]);
  assert.equal(Object.keys(SEAT_RECORD_FIELD_PLAN).length, 8);
});

test("a fully-populated seat round-trips through disk with all eight fields intact", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const full = seat({
      activeHolderId: "holder-b",
      nextOrdinal: 5,
      closedAt: "2026-09-28T01:00:00.000Z",
      name: "the seat's label",
      // Brick `9984c510`: TYPE change on the existing slot, not a ninth
      // field — `validated: true` exercises BOTH keys the sibling writes.
      brickId: { ref: "b64dfbb3-e6df-4805-aef3-90951d937fb9", validated: true },
      favorite: true,
    });
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[full.seatId, full]]) },
      result: undefined,
    }));

    // Asserted through a REAL re-read from disk, not against the in-memory
    // object: the failure this store is most exposed to is a field that survives
    // the mutator and is dropped by one leg of the snake_case carrier, and that
    // is green under any in-memory comparison.
    const store = await readSeatStore(dir);
    assert.deepEqual(seatFromStore(store, full.seatId), full);

    // …and the ON-DISK SPELLING is snake_case, per the ratified item 4. If this
    // drifts to camelCase, every other reader of the store breaks at runtime
    // while every test that compares parsed objects stays green.
    //
    // NINE on-disk keys, not eight — brick `9984c510` adds `brick_id_validated`
    // as a SIBLING persisted key for the existing `brickId` slot, same shape as
    // the existing `name`/`brick_id` omit-when-absent pair, one key over. The
    // CLOSED-AT-EIGHT row above is untouched: it pins the in-MEMORY
    // `SeatRecord` field COUNT, and this brick changed `brickId`'s TYPE, not
    // the field set — this list is the PERSISTED spelling, which was always a
    // free-to-grow projection of that fixed set (`favorite` alone already
    // persists as one key per in-memory field, so a new in-memory field here
    // would have added one; what's different this time is a type carrying TWO
    // on-disk keys for ONE in-memory field).
    const raw = await readRaw(dir);
    assert.deepEqual(Object.keys(raw[full.seatId]).toSorted(), [
      "active_holder_id",
      "brick_id",
      "brick_id_validated",
      "closed_at",
      "created_at",
      "favorite",
      "name",
      "next_ordinal",
      "seat_id",
    ]);
  });
});

// ─── 1a · `favorite` — D-STAR: always written, absence tolerated on READ ─────

test("an EXPLICIT favorite (true or false) is always written, never omitted", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const bare = seat({ favorite: false });
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[bare.seatId, bare]]) },
      result: undefined,
    }));
    const raw = await readRaw(dir);
    assert.ok(
      Object.keys(raw[bare.seatId]).includes("favorite"),
      "an explicit false must not be omitted — it is a migrated answer, not an absence",
    );
    assert.equal(raw[bare.seatId].favorite, false);
  });
});

test("an UNDEFINED favorite (not yet migrated) is OMITTED on write — same shape as name/brick_id", async () => {
  // 🛑 THE OTHER HALF OF THE TRI-STATE FIX. Once `favorite` could be `undefined`
  // in memory (a row read pre-migration and never explicitly set), a write that
  // round-trips it must not manufacture an explicit `false` on disk — that would
  // silently "migrate" every seat the moment ANY OTHER seat in the store is
  // written, without ever running the migration's own logic.
  await withTempDir("acpx-seat-store-", async (dir) => {
    const bare = seat({ favorite: undefined });
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[bare.seatId, bare]]) },
      result: undefined,
    }));
    const raw = await readRaw(dir);
    assert.ok(
      !Object.hasOwn(raw[bare.seatId] as object, "favorite"),
      "an undefined favorite was written as a value instead of omitted",
    );
    const reread = await readSeatStore(dir);
    assert.equal(seatFromStore(reread, bare.seatId)?.favorite, undefined);
  });
});

test("a row written before `favorite` existed reads back as `undefined` — NOT malformed, NOT coerced to `false`", async () => {
  // 🛑 THE TRI-STATE IS THE POINT (L0, 2026-09-30T23:39Z, brick `6adabe72`). A
  // first cut coerced absence to `false`, which collapses "not yet migrated" and
  // "explicitly un-starred" into the same value — the archiver's guard then reads
  // an already-starred, not-yet-migrated seat as un-starred and silently drops its
  // protection. `undefined` is the only answer that keeps the two facts apart.
  await withTempDir("acpx-seat-store-", async (dir) => {
    const seatId = "22222222-2222-4222-8222-222222222222";
    const preMigration = {
      seat_id: seatId,
      created_at: "2026-01-01T00:00:00.000Z",
      active_holder_id: null,
      next_ordinal: 1,
      closed_at: null,
      // no `favorite` key at all — every seat on the fleet, pre-D-STAR.
    };
    await fs.writeFile(
      seatStorePath(dir),
      `${JSON.stringify({ [seatId]: preMigration })}\n`,
      "utf8",
    );
    const store = await readSeatStore(dir);
    assert.deepEqual(
      store.malformedSeatIds,
      [],
      "absence of `favorite` must not read as malformed",
    );
    assert.equal(seatFromStore(store, seatId)?.favorite, undefined);
  });
});

test("a PRESENT but wrong-typed favorite still makes the row malformed (D8 strictness)", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const seatId = "33333333-3333-4333-8333-333333333333";
    const bad = {
      seat_id: seatId,
      created_at: "2026-01-01T00:00:00.000Z",
      active_holder_id: null,
      next_ordinal: 1,
      closed_at: null,
      favorite: "yes",
    };
    await fs.writeFile(seatStorePath(dir), `${JSON.stringify({ [seatId]: bad })}\n`, "utf8");
    const store = await readSeatStore(dir);
    assert.deepEqual(store.malformedSeatIds, [seatId]);
  });
});

// ─── 1b · `migrateSeatFavorite` — D-STAR item 3, the one-time migration ──────

test("migrateSeatFavorite flips favorite and touches NOTHING else on the row", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const row = seat({
      favorite: false,
      name: "untouched",
      brickId: { ref: "untouched-brick", validated: false },
    });
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[row.seatId, row]]) },
      result: undefined,
    }));

    const outcome = await migrateSeatFavorite(dir, row.seatId, true);
    assert.equal(outcome, "migrated");

    const store = await readSeatStore(dir);
    assert.deepEqual(seatFromStore(store, row.seatId), { ...row, favorite: true });
  });
});

test("migrateSeatFavorite is a NO-OP once the value already agrees — AC4's re-run", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const row = seat({ favorite: true });
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[row.seatId, row]]) },
      result: undefined,
    }));

    // POSITIVE CONTROL: the counter can see a change when there is one.
    assert.equal(await migrateSeatFavorite(dir, row.seatId, false), "migrated");
    // THE RE-RUN: asking for the value it already holds touches zero rows.
    assert.equal(await migrateSeatFavorite(dir, row.seatId, false), "unchanged");

    const before = await fs.readFile(seatStorePath(dir), "utf8");
    assert.equal(await migrateSeatFavorite(dir, row.seatId, false), "unchanged");
    const after = await fs.readFile(seatStorePath(dir), "utf8");
    assert.equal(after, before, "an unchanged migration must not rewrite the store at all");
  });
});

test("migrateSeatFavorite on a seat with NO ROW is a no-op — backfillSeatRow mints it instead", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    assert.equal(
      await migrateSeatFavorite(dir, "44444444-4444-4444-8444-444444444444", true),
      "no-row",
    );
    const store = await readSeatStore(dir);
    assert.equal(store.fileState, "absent", "a no-op migration must not create the store file");
  });
});

test("migrateSeatFavorite THROWS on a malformed row rather than silently skipping it", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const seatId = "55555555-5555-4555-8555-555555555555";
    await fs.writeFile(
      seatStorePath(dir),
      `${JSON.stringify({ [seatId]: { seat_id: seatId } })}\n`,
      "utf8",
    );
    await assert.rejects(
      migrateSeatFavorite(dir, seatId, true),
      (error: unknown) => error instanceof MalformedSeatRowError && error.seatId === seatId,
    );
  });
});

test("an unset `name`/`brick_id` is OMITTED on disk, not written as null", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const bare = seat();
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[bare.seatId, bare]]) },
      result: undefined,
    }));
    const raw = await readRaw(dir);
    const keys = Object.keys(raw[bare.seatId]);
    assert.ok(!keys.includes("name"), "an unset name was written as a value");
    assert.ok(!keys.includes("brick_id"));
    // Brick `9984c510`: the sibling travels WITH the ref, never independently
    // of it — an absent `brickId` must omit BOTH on-disk keys together.
    assert.ok(!keys.includes("brick_id_validated"));
    // But the two MEANINGFUL nulls are written, because null is a value there:
    // `active_holder_id: null` is "vacant" and must be distinguishable from
    // a field nobody wrote.
    assert.equal(raw[bare.seatId].closed_at, null);
    assert.ok(Object.keys(raw[bare.seatId]).includes("active_holder_id"));
  });
});

test("a vacant seat stores active_holder_id as an explicit null and reads back as null", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const vacant = seat({ activeHolderId: null });
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[vacant.seatId, vacant]]) },
      result: undefined,
    }));
    const store = await readSeatStore(dir);
    assert.equal(seatFromStore(store, vacant.seatId)?.activeHolderId, null);
  });
});

// ─── 2 · ABSENT / MALFORMED / PRESENT are three states (D8) ──────────────────

test("a missing store file is an EMPTY store, not an error", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const store = await readSeatStore(dir);
    assert.equal(store.seats.size, 0);
    assert.deepEqual(store.malformedSeatIds, []);
    assert.equal(seatFromStore(store, "no-such-seat"), undefined);
  });
});

test("a MALFORMED row throws and is NOT reported as absent — the states must not collapse", () => {
  // Every one of these is a row that is PRESENT and unreadable. Reporting any of
  // them as "no such seat" would send a caller to create a seat on top of a row
  // that is still there.
  const cases: Record<string, string> = {
    "missing next_ordinal":
      '{"s":{"seat_id":"s","created_at":"t","active_holder_id":null,"closed_at":null}}',
    "wrong-typed active_holder_id":
      '{"s":{"seat_id":"s","created_at":"t","active_holder_id":7,"next_ordinal":1,"closed_at":null}}',
    "next_ordinal below 1":
      '{"s":{"seat_id":"s","created_at":"t","active_holder_id":null,"next_ordinal":0,"closed_at":null}}',
    "non-integer next_ordinal":
      '{"s":{"seat_id":"s","created_at":"t","active_holder_id":null,"next_ordinal":1.5,"closed_at":null}}',
    "wrong-typed name":
      '{"s":{"seat_id":"s","created_at":"t","active_holder_id":null,"next_ordinal":1,"closed_at":null,"name":3}}',
    "closed_at omitted entirely":
      '{"s":{"seat_id":"s","created_at":"t","active_holder_id":null,"next_ordinal":1}}',
    "key disagrees with seat_id":
      '{"s":{"seat_id":"other","created_at":"t","active_holder_id":null,"next_ordinal":1,"closed_at":null}}',
    "row is not an object": '{"s":"not-a-row"}',
    "row is null": '{"s":null}',
    // Brick `9984c510` — D8 applies to `brick_id_validated` exactly as it
    // does to every other field. THE SUBSTITUTION THIS CASE EXISTS TO CATCH:
    // a reader that silently dropped a non-boolean value here would read
    // this row as a LEGAL one — `brick_id` present, state key absent reads
    // as UNVALIDATED by invariant (ii) — instead of a CORRUPT one. That
    // wrong answer is indistinguishable from a legitimate "legacy row" and
    // would never surface as corruption, which is exactly the failure mode
    // "malformed collapsing into absent" already names one field over.
    "wrong-typed brick_id_validated":
      '{"s":{"seat_id":"s","created_at":"t","active_holder_id":null,"next_ordinal":1,"closed_at":null,"brick_id":"1a5845c3-a832-4370-b564-8ec5286bff79","brick_id_validated":"yes"}}',
  };
  for (const [label, payload] of Object.entries(cases)) {
    const store = parseSeatStore(payload);
    assert.deepEqual(store.malformedSeatIds, ["s"], `${label}: not recorded as malformed`);
    assert.equal(store.seats.size, 0, `${label}: a malformed row was accepted`);
    assert.throws(
      () => seatFromStore(store, "s"),
      MalformedSeatRowError,
      `${label}: a malformed row read as ABSENT instead of throwing`,
    );
  }
});

// Brick `9984c510` — THE POSITIVE CONTROL for the "wrong-typed
// brick_id_validated" case above, same fixture shape with a GENUINE boolean
// in place of the corrupt value. Without this, the negative row proves only
// that an instrument returns malformed for SOMETHING — never that it is
// pointed at the field under test. A row that read EVERY seat as malformed
// unconditionally would also pass the negative case above; it would fail
// this one.
test("the identical fixture with a GENUINE boolean brick_id_validated parses cleanly — the positive control for the malformed case above", () => {
  const store = parseSeatStore(
    '{"s":{"seat_id":"s","created_at":"t","active_holder_id":null,"next_ordinal":1,"closed_at":null,' +
      '"brick_id":"1a5845c3-a832-4370-b564-8ec5286bff79","brick_id_validated":false}}',
  );
  assert.deepEqual(store.malformedSeatIds, [], "a genuine boolean must not be rejected");
  const row = seatFromStore(store, "s");
  assert.deepEqual(row?.brickId, {
    ref: "1a5845c3-a832-4370-b564-8ec5286bff79",
    validated: false,
  });
});

test("a malformed row does not take down the seats beside it", () => {
  const store = parseSeatStore(
    '{"bad":{"seat_id":"bad"},' +
      '"good":{"seat_id":"good","created_at":"t","active_holder_id":"h","next_ordinal":3,"closed_at":null}}',
  );
  assert.deepEqual(store.malformedSeatIds, ["bad"]);
  assert.equal(seatFromStore(store, "good")?.nextOrdinal, 3);
});

test("F1 · an unparseable FILE reports fileState MALFORMED and must NOT read as absent", () => {
  // 🛑 THE DEFECT THIS ROW EXISTS FOR (F1, found by the test-engineer). A corrupt store
  // used to return a plain empty store with zero malformed ids, so a lookup found the
  // seat in NEITHER collection and answered ABSENT — and the refusal then told an
  // operator whose file was present and corrupt to "run the backfill", which CANNOT
  // repair corruption and refuses to run against a malformed store. That is not an
  // unhelpful message; it is a confident instruction to do the wrong thing.
  //
  // `malformedSeatIds` is legitimately EMPTY here — there are no rows to attribute —
  // which is exactly why the FILE's state has to travel separately.
  for (const payload of ["not json at all", "[]", "null", '"a string"', "42"]) {
    const store = parseSeatStore(payload);
    assert.equal(store.seats.size, 0, payload);
    assert.deepEqual(store.malformedSeatIds, [], payload);
    assert.equal(store.fileState, "malformed", `${payload}: file state not reported`);
    assert.throws(
      () => seatFromStore(store, "any-seat"),
      SeatStoreUnhealthyError,
      `${payload}: a corrupt store answered ABSENT for a seat it simply cannot read`,
    );
  }
});

test("F1 · the three FILE states are three answers, not one — and the remedies differ", () => {
  // The paired row: a MISSING file is genuinely absent and must NOT throw, or the fix
  // for F1 would have broken the ordinary empty-box case.
  assert.equal(parseSeatStore("{}").fileState, "ok");
  assert.equal(seatFromStore(parseSeatStore("{}"), "nope"), undefined);

  // …and the remedies are different text, because "run the backfill" is right for an
  // absent ROW and wrong for a corrupt FILE.
  const malformed = seatStoreUnhealthyMessage("malformed");
  assert.match(malformed, /quarantine/i, "the malformed remedy does not say to quarantine");
  assert.match(malformed, /corrupt-<timestamp>/, "it does not give the quarantine name");
  assert.match(
    malformed,
    /refuses to run against a malformed store/i,
    "it does not say the backfill alone is NOT the remedy",
  );
  const unreadable = seatStoreUnhealthyMessage("unreadable");
  assert.match(unreadable, /repair the filesystem/i);
  assert.doesNotMatch(
    unreadable,
    /quarantine/i,
    "quarantining is the MALFORMED remedy; an unreadable file is a filesystem problem",
  );
});

test("F1 · the writer still refuses over an unhealthy file, naming the real repair", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    await fs.writeFile(seatStorePath(dir), "{ this is not json", "utf8");
    await assert.rejects(
      () =>
        withSeatStoreWrite(dir, () => ({
          mutation: { kind: "write", seats: new Map() },
          result: undefined,
        })),
      (error: unknown) =>
        error instanceof SeatStoreUnwritableError &&
        error.fileState === "malformed" &&
        /quarantine/i.test(error.message),
      "the writer overwrote a corrupt store, or refused without naming the repair",
    );
    // …and the corrupt bytes are STILL THERE. A corrupt file may hold hand-recoverable
    // rows, so the writer must never clear it to make itself work.
    assert.match(await fs.readFile(seatStorePath(dir), "utf8"), /this is not json/);
  });
});

// ─── 3 · AP11 — the critical section cannot acquire a third operation ────────

// 🛑 THE STRUCTURAL HALF, AS A COMPILE-TIME ASSERTION THAT LIVES IN THE SUITE.
//
// The phase-2 bound is enforced by `mutate` returning a VALUE, never a Promise:
// a caller cannot `await` a convenient extra read inside the hold because it does
// not compile. That guarantee is invisible to any runtime test, so it is asserted
// here as a type. **Make `mutate` async and this file stops compiling** — which
// is the falsifier, and it cannot rot, because it is checked on every build.
type MutateFn = Parameters<typeof withSeatStoreWrite<number>>[1];
type MutateResult = ReturnType<MutateFn>;
const mutateMustNotBeAsync: MutateResult extends Promise<unknown> ? never : true = true;

test("AP11 · the mutate callback is synchronous by TYPE — async work cannot be added inside the hold", () => {
  // The assertion above is the real check (it is a compile error if violated).
  // This row exists so the property is VISIBLE in the suite's output rather than
  // only in the type checker, and so a reader deleting the type alias as "unused"
  // meets a named test.
  assert.equal(mutateMustNotBeAsync, true);
  // ⚠️ THE LIMIT, STATED: this closes asynchronous work absolutely and synchronous
  // work only by making it a deliberate act (a `readFileSync` inside `mutate`
  // would still compile). Every ordinary path is closed because all of this
  // codebase's I/O is async. The row below covers the consequence that matters.
});

test("AP11 · a seat-store write touches NO session record file", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    // Two record files, one of which the activation would legitimately write in
    // its OTHER phases — the point of the row is that it cannot happen inside the
    // hold.
    const recordPaths = [path.join(dir, "holder-a.json"), path.join(dir, "holder-b.json")];
    for (const recordPath of recordPaths) {
      await fs.writeFile(recordPath, '{"untouched":true}\n', "utf8");
    }
    const before = await Promise.all(
      recordPaths.map(async (p) => ({
        stat: await fs.stat(p),
        body: await fs.readFile(p, "utf8"),
      })),
    );

    const written = seat();
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[written.seatId, written]]) },
      result: undefined,
    }));

    for (const [i, recordPath] of recordPaths.entries()) {
      assert.equal(
        await fs.readFile(recordPath, "utf8"),
        before[i].body,
        "a record file's CONTENT changed during a seat-store write — record I/O has entered the hold",
      );
      assert.equal(
        (await fs.stat(recordPath)).mtimeMs,
        before[i].stat.mtimeMs,
        "a record file was rewritten during a seat-store write",
      );
    }
    // Positive control: the store itself DID get written, so the row above is not
    // passing because nothing happened at all.
    assert.equal((await readSeatStore(dir)).seats.size, 1, "the store write itself did not happen");
  });
});

test("a `no-change` mutation writes nothing at all — not even an empty file", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const observed = await withSeatStoreWrite(dir, (store) => ({
      mutation: SEAT_STORE_NO_CHANGE,
      result: store.seats.size,
    }));
    assert.equal(observed, 0);
    await assert.rejects(
      () => fs.access(seatStorePath(dir)),
      "a no-change mutation created the store file",
    );
  });
});

test("a write leaves no .tmp file behind — the rename is the publish", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const written = seat();
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[written.seatId, written]]) },
      result: undefined,
    }));
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "a temp file survived the write");
    assert.deepEqual(await fs.readdir(dir), [SEAT_STORE_FILE]);
  });
});

// ─── 4 · the counter under one hold (the AP4 precursor) ─────────────────────

test("two concurrent read-increment-write cycles do NOT both read the same next_ordinal", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const initial = seat({ nextOrdinal: 1 });
    await withSeatStoreWrite(dir, () => ({
      mutation: { kind: "write", seats: new Map([[initial.seatId, initial]]) },
      result: undefined,
    }));

    // The shape `persistTemplateMark` ships and the activation copies: the read,
    // the increment and the write are all inside ONE hold. If the read-increment
    // were moved outside the hold, both cycles would observe `1` and the counter
    // would end at 2 instead of 3.
    const takeOrdinal = () =>
      withSeatStoreWrite(dir, (store) => {
        const row = seatFromStore(store, initial.seatId);
        assert.ok(row);
        const taken = row.nextOrdinal;
        const next = new Map(store.seats);
        next.set(row.seatId, { ...row, nextOrdinal: taken + 1 });
        return { mutation: { kind: "write" as const, seats: next }, result: taken };
      });

    const [first, second] = await Promise.all([takeOrdinal(), takeOrdinal()]);
    assert.notEqual(
      first,
      second,
      "two concurrent cycles read the SAME ordinal — the read-increment is not inside the hold",
    );
    assert.deepEqual(
      [first, second].toSorted((a, b) => a - b),
      [1, 2],
    );
    const after = await readSeatStore(dir);
    assert.equal(
      seatFromStore(after, initial.seatId)?.nextOrdinal,
      3,
      "the counter did not advance exactly once per cycle",
    );
  });
});
