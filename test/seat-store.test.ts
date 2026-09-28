import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  MalformedSeatRowError,
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
    ...overrides,
  };
}

async function readRaw(dir: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await fs.readFile(seatStorePath(dir), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
}

// ─── 1 · THE CLOSED SET — seven fields, and the falsifier for an eighth ──────

test("the seat record field set is CLOSED AT SEVEN — an eighth field fails this row", () => {
  // 🛑 THIS ROW IS THE FALSIFIER FOR "the record carries seven fields". Two
  // eighth-field proposals have already been made and withdrawn (`holder_count`,
  // struck by Daniel; `mirror_divergences`, withdrawn 2026-09-28T13:30Z), so this
  // is a live pressure and not a hypothetical. The compiler forces the PLAN to be
  // exhaustive over `SeatRecord`; this row forces the COUNT, which the compiler
  // cannot: registering a new field would satisfy the `satisfies` and still red
  // here, which is exactly the review moment that should happen.
  assert.deepEqual(Object.keys(SEAT_RECORD_FIELD_PLAN).toSorted(), [
    "activeHolderId",
    "brickId",
    "closedAt",
    "createdAt",
    "name",
    "nextOrdinal",
    "seatId",
  ]);
  assert.equal(Object.keys(SEAT_RECORD_FIELD_PLAN).length, 7);
});

test("a fully-populated seat round-trips through disk with all seven fields intact", async () => {
  await withTempDir("acpx-seat-store-", async (dir) => {
    const full = seat({
      activeHolderId: "holder-b",
      nextOrdinal: 5,
      closedAt: "2026-09-28T01:00:00.000Z",
      name: "the seat's label",
      brickId: "b64dfbb3-e6df-4805-aef3-90951d937fb9",
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
    const raw = await readRaw(dir);
    assert.deepEqual(Object.keys(raw[full.seatId]).toSorted(), [
      "active_holder_id",
      "brick_id",
      "closed_at",
      "created_at",
      "name",
      "next_ordinal",
      "seat_id",
    ]);
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
    // But the two MEANINGFUL nulls are written, because null is a value there:
    // `active_holder_id: null` is "nobody home" and must be distinguishable from
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

test("a malformed row does not take down the seats beside it", () => {
  const store = parseSeatStore(
    '{"bad":{"seat_id":"bad"},' +
      '"good":{"seat_id":"good","created_at":"t","active_holder_id":"h","next_ordinal":3,"closed_at":null}}',
  );
  assert.deepEqual(store.malformedSeatIds, ["bad"]);
  assert.equal(seatFromStore(store, "good")?.nextOrdinal, 3);
});

test("an unparseable FILE is an empty store with no malformed ids — there are no rows to attribute", () => {
  for (const payload of ["not json at all", "[]", "null", '"a string"', "42"]) {
    const store = parseSeatStore(payload);
    assert.equal(store.seats.size, 0, payload);
    assert.deepEqual(store.malformedSeatIds, [], payload);
  }
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
