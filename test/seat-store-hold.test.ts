import assert from "node:assert/strict";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import {
  SEAT_STORE_NO_CHANGE,
  seatFromStore,
  seatStorePath,
  withSeatStoreWrite,
} from "../src/session/persistence/seat-store.js";

// AP11 — "THE PHASE-2 HOLD CANNOT ACQUIRE A THIRD OPERATION."
// (ACTIVATION-PROTOCOL.md §2.6.1 / §10.)
//
// The bound being defended: inside the seat-store write hold there is EXACTLY ONE
// `seats.json` read and ONE `seats.json` write, and nothing else — no record I/O,
// no index read or write, no network, no notice composition, no additional await.
//
// 🔑 WHY THIS ROW EXISTS AT ALL, quoting the rationale on the record: "the bound's
// whole purpose is to survive the next person who has one convenient read to add,
// and that person will not have read §2.6." A bound nobody can FAIL is a bound
// nobody keeps — so this file does not assert that today's code is narrow, it
// COUNTS the I/O the hold performs, and it carries a POSITIVE CONTROL proving the
// count catches an addition.
//
// ## Two layers, and the first one is the strong one
//
// 1. **STRUCTURAL, compiler-enforced:** `withSeatStoreWrite`'s mutator is
//    SYNCHRONOUS. It cannot `await`, and every form of record I/O, index I/O,
//    network call, drain, signal and process wait in this codebase is async — so
//    they are unreachable from inside the hold BY TYPE. Nothing can regress that
//    without failing `typecheck`, which is why it is layer one.
// 2. **BEHAVIOURAL, this file:** the residue a sync callback can still reach is
//    *synchronous* fs. So the instrument watches the sync namespace as well as the
//    async one, and the control at the bottom performs exactly that forbidden
//    operation to prove the instrument is not vacuous.
//
// ⚠️ This is NOT mutation testing. Nothing under `src/` is modified by any row
// here; the forbidden operation lives in this file's own callback and stays in the
// suite permanently.

type Op = { api: string; target: string };

const SEAT_ID = "11111111-1111-4111-8111-111111111111";

/** Bump the seat's ordinal — the activation's own phase-2 shape, expressed through
 * the mutation descriptor `withSeatStoreWrite` takes. The store is a ReadonlyMap, so
 * the next state is BUILT rather than mutated in place; that is deliberate in the
 * module and it is what stops a mutator from half-editing a shared object. */
function bumpOrdinal(store: Parameters<Parameters<typeof withSeatStoreWrite<number>>[1]>[0]): {
  mutation: { readonly kind: "write"; readonly seats: ReadonlyMap<string, SeatRecordLike> };
  result: number;
} {
  const seat = seatFromStore(store, SEAT_ID);
  assert.ok(seat, "fixture precondition: the seat is in the store");
  const taken = seat.nextOrdinal;
  const next = new Map(store.seats);
  next.set(SEAT_ID, { ...seat, nextOrdinal: taken + 1 });
  return { mutation: { kind: "write", seats: next }, result: taken };
}

type SeatRecordLike = NonNullable<ReturnType<typeof seatFromStore>>;

const ASYNC_APIS = ["readFile", "writeFile", "rename", "mkdir", "stat", "unlink"] as const;
const SYNC_APIS = ["readFileSync", "writeFileSync", "renameSync", "statSync"] as const;
const SEAT_STORE_BASENAME = "seats.json";

/**
 * The first argument of an fs call, as a path string.
 *
 * ⚠️ NOT `String(arg)`. An fs path argument may legitimately be a `Buffer` or a
 * `URL`, and `String()` on some objects yields `[object Object]` — which would
 * classify as `"outside"` and be SILENTLY DROPPED from the log, i.e. an operation
 * the bound forbids could go uncounted. A file handle (`fs.promises.FileHandle`)
 * has no path at all, so it is named explicitly rather than stringified into
 * something that looks like one.
 */
function pathArgumentOf(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof URL) {
    return arg.pathname;
  }
  if (arg instanceof Buffer) {
    return arg.toString("utf8");
  }
  return "<non-path-argument>";
}

/**
 * Classify a path into the only things the hold may legitimately touch, plus the
 * one it may not. Classifying — rather than string-matching one filename — is what
 * lets a record read be RECOGNISED as a record read instead of quietly counting as
 * "something else I did not think to look for".
 */
function classify(sessionDir: string, value: string): string {
  if (!value.startsWith(sessionDir)) {
    return "outside";
  }
  if (value === sessionDir) {
    return "session-dir";
  }
  const base = path.basename(value);
  if (base === SEAT_STORE_BASENAME) {
    return "seat-store";
  }
  if (base.startsWith(`${SEAT_STORE_BASENAME}.`) && base.endsWith(".tmp")) {
    return "seat-store-temp";
  }
  if (base === "index.json.lock") {
    return "lock";
  }
  if (base === "index.json") {
    return "index";
  }
  return "record";
}

/**
 * Run `body` with every fs call recorded, then restore. The spies KEEP the original
 * behaviour (that is `mock.method`'s default), so this observes a real write to a
 * real store rather than a simulation.
 *
 * ⚠️ `node:fs/promises` and `node:fs` each expose ONE cached namespace object shared
 * by every importer, so patching a method on it is seen by `seat-store.ts` and by
 * `index-lock.ts` alike — which is why the lock's own I/O appears in the log and has
 * to be classified rather than assumed absent.
 */
async function recordFsOps(body: () => Promise<void>): Promise<Op[]> {
  // `mock.method` defaults to calling through to the original, so these observe
  // without changing behaviour. The tracker's recorded calls survive
  // `restoreAll()` — only the patched method is put back — so the log is read
  // after restoring rather than inside the `finally`.
  const trackers = [
    ...ASYNC_APIS.map((api) => ({ api, fn: mock.method(fsp, api) })),
    ...SYNC_APIS.map((api) => ({ api, fn: mock.method(fsSync, api) })),
  ];
  try {
    await body();
  } finally {
    mock.restoreAll();
  }
  const ops: Op[] = [];
  for (const tracker of trackers) {
    for (const call of tracker.fn.mock.calls) {
      ops.push({ api: tracker.api, target: pathArgumentOf(call.arguments[0]) });
    }
  }
  return ops;
}

async function withStoreDir<T>(run: (sessionDir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-seat-hold-"));
  const sessionDir = path.join(dir, "sessions");
  await fsp.mkdir(sessionDir, { recursive: true });
  // A real session record, so that "a record touch" is a touch of something that
  // actually exists and would actually succeed.
  await fsp.writeFile(
    path.join(sessionDir, "a-holder.json"),
    JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "a-holder" }),
    "utf8",
  );
  // The store is ONE JSON OBJECT KEYED BY seat_id — no envelope, no schema key
  // (`SEAT-STORE.md` ratification item 1). Written here as raw bytes rather than
  // through `withSeatStoreWrite`, so the fixture cannot mask a defect in the very
  // writer under test.
  await fsp.writeFile(
    seatStorePath(sessionDir),
    `${JSON.stringify({
      [SEAT_ID]: {
        seat_id: SEAT_ID,
        created_at: "2026-01-01T00:00:00.000Z",
        active_holder_id: "a-holder",
        next_ordinal: 2,
        closed_at: null,
      },
    })}\n`,
    "utf8",
  );
  try {
    return await run(sessionDir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function summarise(sessionDir: string, ops: Op[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const op of ops) {
    const kind = classify(sessionDir, op.target);
    if (kind === "outside") {
      continue;
    }
    const key = `${kind}:${op.api}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

test("AP11: the hold performs exactly one store read and one store write, and touches no record or index file", async () => {
  await withStoreDir(async (sessionDir) => {
    const ops = await recordFsOps(async () => {
      await withSeatStoreWrite(sessionDir, bumpOrdinal);
    });

    const counts = summarise(sessionDir, ops);
    const detail = JSON.stringify(counts);

    assert.equal(
      counts["seat-store:readFile"],
      1,
      `expected exactly ONE seats.json read — ${detail}`,
    );
    assert.equal(
      counts["seat-store-temp:writeFile"],
      1,
      `expected exactly ONE store write, to a temp file — ${detail}`,
    );
    assert.equal(
      counts["seat-store-temp:rename"],
      1,
      `expected exactly ONE atomic rename into place — ${detail}`,
    );

    // The bound itself. Every one of these must be absent, and the message names
    // what was seen so a failure is diagnosable rather than just red.
    for (const api of [...ASYNC_APIS, ...SYNC_APIS]) {
      assert.equal(
        counts[`record:${api}`],
        undefined,
        `RECORD I/O INSIDE THE HOLD (${api}) — the phase-2 bound is broken — ${detail}`,
      );
      assert.equal(
        counts[`index:${api}`],
        undefined,
        `INDEX I/O INSIDE THE HOLD (${api}) — the phase-2 bound is broken — ${detail}`,
      );
    }

    // And the store itself is never read or written more than once, by ANY api —
    // this is what catches a "just re-read it to be safe" addition on the store's
    // own path, which the per-kind counts above would otherwise permit.
    const storeOps = ops.filter((op) => {
      const kind = classify(sessionDir, op.target);
      return kind === "seat-store" || kind === "seat-store-temp";
    });
    assert.equal(
      storeOps.length,
      3,
      `the hold's body must be exactly read + write + rename on the store — saw ${JSON.stringify(storeOps)}`,
    );
  });
});

test("AP11: the bound holds on an EMPTY store too — the state where it was actually broken", async () => {
  // 🛑 THIS ROW EXISTS BECAUSE THE ONE ABOVE PASSED WHILE THE BOUND WAS BROKEN. The
  // writer used to do a SECOND `readFile` inside the hold, to tell an absent file from an
  // unparseable one — and that extra read fired ONLY when the parsed store was empty,
  // which is exactly the CREATE path. The headline row's fixture seeds a seat, so the
  // store is never empty and the assertion never entered the state it claimed to cover.
  // Found while fixing F1, not by this file.
  //
  // ⚠️ THE GENERAL LESSON, and it is the same one twice more on this block: a bound
  // asserted only in the easy state is unverified exactly where it is easiest to break.
  // The fixture has to exercise the state the code special-cases.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-seat-hold-empty-"));
  const sessionDir = path.join(dir, "sessions");
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(
    path.join(sessionDir, "a-holder.json"),
    JSON.stringify({ schema: "acpx.session.v1", acpx_record_id: "a-holder" }),
    "utf8",
  );
  try {
    // NO seats.json at all — the first-write-on-a-fresh-box case.
    const ops = await recordFsOps(async () => {
      await withSeatStoreWrite(sessionDir, (store) => {
        assert.equal(store.fileState, "absent", "fixture precondition: no store yet");
        const seats = new Map(store.seats);
        seats.set(SEAT_ID, {
          seatId: SEAT_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
          activeHolderId: "a-holder",
          nextOrdinal: 2,
          closedAt: null,
          name: undefined,
          brickId: undefined,
          favorite: false,
        });
        return { mutation: { kind: "write" as const, seats }, result: undefined };
      });
    });
    const counts = summarise(sessionDir, ops);
    const detail = JSON.stringify(counts);
    // ONE read even though there is nothing to read — the ENOENT is the read.
    assert.equal(counts["seat-store:readFile"], 1, `expected exactly ONE store read — ${detail}`);
    assert.equal(counts["seat-store-temp:writeFile"], 1, `expected ONE temp write — ${detail}`);
    assert.equal(counts["seat-store-temp:rename"], 1, `expected ONE rename — ${detail}`);
    for (const api of [...ASYNC_APIS, ...SYNC_APIS]) {
      assert.equal(
        counts[`record:${api}`],
        undefined,
        `RECORD I/O (${api}) in the hold — ${detail}`,
      );
      assert.equal(counts[`index:${api}`], undefined, `INDEX I/O (${api}) in the hold — ${detail}`);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("AP11: a no-change mutation reads ONCE and writes NOTHING", async () => {
  // The other half of the bound. An O(all-seats) rewrite that changes nothing is
  // pure cost, and on a missing store it would additionally CREATE the file — so
  // "decided not to write" has to be observably free, not merely correct.
  await withStoreDir(async (sessionDir) => {
    const before = await fsp.stat(seatStorePath(sessionDir));
    const ops = await recordFsOps(async () => {
      await withSeatStoreWrite(sessionDir, () => ({
        mutation: SEAT_STORE_NO_CHANGE,
        result: undefined,
      }));
    });
    const counts = summarise(sessionDir, ops);
    const detail = JSON.stringify(counts);
    assert.equal(counts["seat-store:readFile"], 1, `expected exactly ONE store read — ${detail}`);
    assert.equal(
      counts["seat-store-temp:writeFile"],
      undefined,
      `a no-change mutation wrote a temp file — ${detail}`,
    );
    assert.equal(
      counts["seat-store-temp:rename"],
      undefined,
      `a no-change mutation renamed into place — ${detail}`,
    );
    // Belt: the file itself is byte-for-byte untouched.
    const after = await fsp.stat(seatStorePath(sessionDir));
    assert.equal(after.mtimeMs, before.mtimeMs, "a no-change mutation rewrote the store file");
  });
});

test("AP11 POSITIVE CONTROL: the instrument catches record I/O added inside the hold", async () => {
  // 🔑 THE ROW THAT MAKES THE ROW ABOVE MEAN SOMETHING. That row asserts an
  // ABSENCE — zero record touches — and an instrument that can never SEE a record
  // touch passes it while proving nothing, silently and forever. So this row
  // performs the forbidden operation and requires the instrument to report it.
  //
  // ⚠️ It reaches for `fsSync.readFileSync` THROUGH THE NAMESPACE rather than
  // `fsp.readFile`, and both details are deliberate: the mutator is synchronous, so
  // an async record read does not merely violate the bound, it does not compile —
  // sync fs is the only residue the type system leaves, so it is the only thing this
  // control can be written with. And calling through the namespace is how the spy
  // sees it, which is also how a future developer adding "one convenient read" would
  // most naturally write it.
  await withStoreDir(async (sessionDir) => {
    const recordPath = path.join(sessionDir, "a-holder.json");
    let contents = "";

    const ops = await recordFsOps(async () => {
      await withSeatStoreWrite(sessionDir, (store) => {
        // THE FORBIDDEN OPERATION — record I/O inside the hold.
        contents = fsSync.readFileSync(recordPath, "utf8");
        return bumpOrdinal(store);
      });
    });

    assert.match(contents, /a-holder/, "the control did not actually read the record file");

    const counts = summarise(sessionDir, ops);
    assert.equal(
      counts["record:readFileSync"],
      1,
      `THE INSTRUMENT IS VACUOUS: a record file was demonstrably read inside the hold and the ` +
        `fs log did not show it, so the row above cannot fail and proves nothing — ${JSON.stringify(counts)}`,
    );
  });
});
