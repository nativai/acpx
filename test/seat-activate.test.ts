import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readSeatStore,
  resolveSessionRecord,
  seatFromStore,
  withSeatStoreWrite,
  writeSessionRecordAuthorizingSeatHolderWithoutIndex,
  type SeatRecord,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// THE SUCCESSION WRITE — `ACTIVATION-PROTOCOL.md` §2.7, brick b64dfbb3 (B2).
//
// 🔑 EVERY REFUSAL HERE HAS A PAIRED ROW PROVING THE LEGITIMATE CASE STILL PASSES.
// That rule is not decoration: D11's "seat not in the store" refusal was tested and
// phase 0.2's was tested, and BECAUSE NEITHER GOT ITS PAIR, every seat the system
// created was un-joinable and un-succeedable for a while with the suite fully green.
// A refusal tested alone proves the door is locked; it says nothing about whether
// anyone can still get in. So the happy path is asserted FIRST, and each refusal row
// below names the positive row it is paired with.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const SEAT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    // Same scrub `session-reparent.test.ts` documents: a fixture built without it can
    // silently acquire the TEST RUNNER's own session as ambient context.
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-activate-", run);
}

function sessionDirOf(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

async function readRecordJson(homeDir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(sessionDirOf(homeDir), `${id}.json`), "utf8"),
  ) as Record<string, unknown>;
}

async function seedHolder(
  homeDir: string,
  id: string,
  over: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const record = makeSessionRecordFixture({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "node mock",
    agentName: "claude",
    cwd: path.join(homeDir, "workspace"),
    seatId: SEAT_A,
    ...over,
  });
  await writeSessionRecordFile(homeDir, record);
  return record;
}

/** Plant a seat row directly through the store's own writer. */
async function seedSeat(homeDir: string, over: Partial<SeatRecord> = {}): Promise<SeatRecord> {
  const row: SeatRecord = {
    seatId: SEAT_A,
    createdAt: "2026-09-28T00:00:00.000Z",
    activeHolderId: "holder-one",
    nextOrdinal: 2,
    closedAt: null,
    name: "the seat",
    brickId: undefined,
    favorite: false,
    ...over,
  };
  await withSeatStoreWrite(sessionDirOf(homeDir), (store) => {
    const seats = new Map(store.seats);
    seats.set(row.seatId, row);
    return { mutation: { kind: "write", seats }, result: undefined };
  });
  return row;
}

/** A seat with holder-one ACTIVE (ordinal 1) and holder-two PREPARED (no ordinal) —
 * exactly the state `sessions new --seat` leaves behind. */
async function seedSuccession(homeDir: string): Promise<void> {
  await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
  await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
  await seedHolder(homeDir, "holder-two", { holderActive: false });
  await seedSeat(homeDir);
}

function activate(homeDir: string, seat = SEAT_A, successor = "holder-two"): Promise<CliResult> {
  return runCli(
    ["--agent", MOCK_AGENT_COMMAND, "--format", "json", "sessions", "activate", seat, successor],
    homeDir,
  );
}

// ─── brick `eca085bb` — AC-LINK2 (D-BRICK-ON-SEAT / D-SEAT-HOLD, `0d2b83f0` CONCEPTION §3) ──
// A close does not vacate a seat: the holder pointer is replaced only by activation.

function closeSessionById(homeDir: string, id: string): Promise<CliResult> {
  return runCli(
    ["--agent", MOCK_AGENT_COMMAND, "--format", "json", "sessions", "close", "--session-id", id],
    homeDir,
  );
}

test("AC-LINK2: `sessions close` on the ACTIVE holder leaves the seat's active_holder_id set to it", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);

    const closed = await closeSessionById(homeDir, "holder-one");
    assert.equal(closed.code, 0, `${closed.stderr}${closed.stdout}`);
    // THE CONTROL: the close really landed — without it, "the pointer is unchanged"
    // is satisfied just as well by a close that never ran.
    assert.equal((await readRecordJson(homeDir, "holder-one")).closed, true);

    const row = seatFromStore(await readSeatStore(sessionDirOf(homeDir)), SEAT_A);
    assert.equal(
      row?.activeHolderId,
      "holder-one",
      "AC-LINK2 FAILED: a close cleared the seat's holder pointer",
    );
    assert.equal(row?.closedAt, null, "closing a holder does not close the SEAT");
  });
});

test("AC-LINK2 (succession): a successor is activated over a CLOSED predecessor, which stays closed", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const closed = await closeSessionById(homeDir, "holder-one");
    assert.equal(closed.code, 0, `${closed.stderr}${closed.stdout}`);

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const row = seatFromStore(await readSeatStore(sessionDirOf(homeDir)), SEAT_A);
    assert.equal(row?.activeHolderId, "holder-two", "the pointer is replaced by activation");
    assert.equal((await readRecordJson(homeDir, "holder-one")).closed, true);
    assert.equal((await readRecordJson(homeDir, "holder-two")).holder_active, true);
  });
});

// ─── 1 · THE HAPPY PATH — the paired row every refusal below leans on ─────────

test("a succession retires the predecessor, points the seat, and draws the ordinal", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.ok, true);
    assert.equal(payload.outcome, "activated");
    assert.equal(payload.holderOrdinal, 2, "the successor must take next_ordinal (2), not 1");

    // The SEAT ROW is the authority — assert it from disk.
    const store = await readSeatStore(sessionDirOf(homeDir));
    const row = seatFromStore(store, SEAT_A);
    assert.equal(row?.activeHolderId, "holder-two", "the seat still names the old holder");
    assert.equal(row?.nextOrdinal, 3, "next_ordinal must advance exactly once per activation");

    // The MIRROR on both records follows.
    const predecessor = await readRecordJson(homeDir, "holder-one");
    const successor = await readRecordJson(homeDir, "holder-two");
    assert.equal(predecessor.holder_active, false, "the predecessor was not retired");
    assert.equal(successor.holder_active, true, "the successor was not activated");
    assert.equal(successor.holder_ordinal, 2);

    // 🛑 RETIREMENT IS NOT A CLOSE. The old address must still RESOLVE so a sender can
    // be WARNED rather than getting a bare closed error — a closed-check would reject
    // first. This is the assertion that catches an "automatic close" being added.
    assert.notEqual(
      predecessor.closed,
      true,
      "the predecessor was CLOSED by activate — retirement is not a close, and closing it " +
        "collapses vacant into closed and makes the old address unresolvable",
    );
  });
});

test("the verb tells the caller closing the predecessor is THEIR duty, with the command", async () => {
  // D7 — the duty is a documented step with a named owner, not a mechanism. Nothing
  // else in the system will ever close the retired holder, so if this output stops
  // saying so, "retired but open" silently becomes a resting state.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const result = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "sessions", "activate", SEAT_A, "holder-two"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Retired \(NOT closed\)/i);
    assert.match(result.stdout, /duty/i, "the output does not say whose duty the close is");
    assert.match(
      result.stdout,
      /acpx sessions close --session-id holder-one/,
      "the output does not give the exact command to discharge the duty",
    );
  });
});

// ─── 2 · AP4 — two concurrent activations ────────────────────────────────────

test("AP4 · two concurrent activations do NOT both take the same ordinal", async () => {
  // ⚠️ DRIVEN IN-PROCESS, AND THAT IS THE WHOLE POINT OF THE ROW. Two CLI
  // SUBPROCESSES cannot be made to overlap: `Promise.all` over two spawns only
  // guarantees both are started, and if the first finishes before the second reads the
  // seat row, the second is a perfectly legitimate SECOND SUCCESSION
  // (holder-two → holder-three) which correctly exits 0. My first version of this row
  // did exactly that and read `[0,0]` — it was measuring sequential successions, not a
  // race, and would have gone green against a verb with NO compare-and-swap at all.
  // In-process, both calls share one event loop: both complete phase 0 against the same
  // pre-state before either reaches phase 2, which is the interleaving the CAS exists
  // for.
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedHolder(homeDir, "holder-three", { holderActive: false });
    await seedSeat(homeDir);

    const { activateSeatHolder, SeatActivationRefusalError } =
      await import("../src/cli/session/seat-activate.js");
    const settled = await Promise.allSettled([
      activateSeatHolder(SEAT_A, "holder-two"),
      activateSeatHolder(SEAT_A, "holder-three"),
    ]);
    const won = settled.filter((r) => r.status === "fulfilled");
    const lost = settled.filter((r) => r.status === "rejected");
    assert.equal(
      won.length,
      1,
      `exactly one activation must win — ${won.length} did. ${JSON.stringify(settled.map((r) => r.status))}`,
    );
    assert.equal(lost.length, 1, "exactly one activation must refuse");

    // 🔑 The loser must refuse on the COMPARE-AND-SWAP by name, not fail some other way
    // that happens to reject. A lost CAS is a RACE, not a divergence, and is reported as
    // its own condition.
    const reason: unknown = lost[0].reason;
    assert.ok(
      reason instanceof SeatActivationRefusalError && reason.code === "CONCURRENT_ACTIVATION",
      `the loser did not refuse on the compare-and-swap: ${String(reason)}`,
    );

    // The counter advanced EXACTLY ONCE, so no ordinal was issued twice — D4a's
    // guarantee is that a number is never RE-ISSUED.
    const store = await readSeatStore(sessionDirOf(homeDir));
    assert.equal(
      seatFromStore(store, SEAT_A)?.nextOrdinal,
      3,
      "next_ordinal advanced more than once — two activations drew from the same counter",
    );
    // …and exactly one holder ended up active on the seat row itself.
    const winner = (won[0] as PromiseFulfilledResult<{ successorId: string; ordinal: number }>)
      .value;
    assert.equal(seatFromStore(store, SEAT_A)?.activeHolderId, winner.successorId);
    assert.equal(winner.ordinal, 2, "the winner did not take next_ordinal");
  });
});

// ─── 3 · AP6 — D4's heal, and the no-op that must NOT burn an ordinal ─────────

test("AP6 · a re-run after the pointer moved HEALS, and does not re-draw the ordinal", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    // The torn state a kill between phases 2 and 3 leaves: the seat row already names
    // holder-two, holder-one is retired, and holder-two has NO ordinal and is not active.
    await seedHolder(homeDir, "holder-one", { holderActive: false, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir, { activeHolderId: "holder-two", nextOrdinal: 2 });

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.outcome, "resumed", "the heal did not identify itself as a resumption");

    const successor = await readRecordJson(homeDir, "holder-two");
    assert.equal(successor.holder_active, true, "the heal did not activate the successor");
    // 🔑 D4a — GAPS ARE LEGAL, REPEATS ARE DEFECTS. The crashed run's ordinal is BURNED
    // rather than recovered: deriving it as `next_ordinal - 1` would be wrong the moment
    // any other activation interleaved.
    assert.equal(successor.holder_ordinal, 2);
    const store = await readSeatStore(sessionDirOf(homeDir));
    assert.equal(seatFromStore(store, SEAT_A)?.nextOrdinal, 3);
    // 🛑 AND THE HEAL MUST NOT HAVE COUNTED A DIVERGENCE. The torn state it repairs has
    // the seat and the mirror legitimately disagreeing; counting that would measure
    // crashes rather than the two-source ambiguity. The exclusion is structural — the
    // resumption branch never reaches the observer.
    assert.equal(payload.mirrorDivergence, null, "the heal reported a divergence");
  });
});

test("activating the holder that is ALREADY active is a no-op that burns no ordinal", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
    await seedSeat(homeDir, { activeHolderId: "holder-one", nextOrdinal: 2 });

    const result = await activate(homeDir, SEAT_A, "holder-one");
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.outcome, "already-active");
    const store = await readSeatStore(sessionDirOf(homeDir));
    assert.equal(
      seatFromStore(store, SEAT_A)?.nextOrdinal,
      2,
      "a no-op burned an ordinal — the counter must not move when nothing happened",
    );
  });
});

// ─── 4 · D10 — the divergence line, and what must NOT produce one ────────────

test("D10 · a FALSIFIED predecessor mirror produces EXACTLY ONE divergence line", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    // The §3.4 clobber signature: the seat names holder-one active, while holder-one's
    // own mirror says otherwise — which is what a close landing on the flip produces.
    await seedHolder(homeDir, "holder-one", { holderActive: false, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir, { activeHolderId: "holder-one", nextOrdinal: 2 });

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const divergence = payload.mirrorDivergence as Record<string, unknown> | null;
    assert.ok(divergence, "a falsified mirror produced NO divergence report");
    assert.equal(divergence.seatId, SEAT_A);
    assert.equal(divergence.predecessorId, "holder-one");
    // 🔑 EXACTLY ONE, not "at least one". Exactness is what makes a future double-report
    // visible AS TWO rather than blending in.
    const lines = result.stderr
      .split("\n")
      .filter((line) => line.includes("seat-mirror-divergence"));
    assert.equal(lines.length, 1, `expected exactly one divergence line, got ${lines.length}`);
    assert.match(lines[0], /seat=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/);
    assert.match(lines[0], /predecessor=holder-one/);
  });
});

test("D10 · a CLEAN succession reports NO divergence — the paired row", async () => {
  // 🛑 WITHOUT THIS THE ROW ABOVE CANNOT DISTINGUISH "detects divergence" from "reports
  // one on every activation". Phase 1 retires P BEFORE phase 2 reads the seat row, so a
  // comparison taken at the wrong point would fire on EVERY healthy succession — and the
  // row above would pass just as happily.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const result = await activate(homeDir);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(
      payload.mirrorDivergence,
      null,
      "a healthy succession reported a divergence — the observation is reading the mirror " +
        "AFTER phase 1 retired it, so it is seeing a disagreement the verb itself created",
    );
    assert.equal(
      result.stderr.includes("seat-mirror-divergence"),
      false,
      "a healthy succession emitted a divergence line",
    );
  });
});

// ─── 5 · PHASE 0's REFUSALS — each paired with the positive row above ─────────

test("phase 0 · a successor that belongs to ANOTHER seat is refused — activate never re-seats", async () => {
  // PAIRED WITH: "a succession retires the predecessor…" above, which proves a successor
  // that IS in the seat succeeds. Without that pair this row could pass against a verb
  // that refuses everything.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    await seedHolder(homeDir, "outsider", {
      holderActive: false,
      seatId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    });

    const result = await activate(homeDir, SEAT_A, "outsider");
    assert.notEqual(result.code, 0, "a session from another seat was activated");
    assert.match(`${result.stdout}${result.stderr}`, /SUCCESSOR_NOT_IN_SEAT/);
    // Nothing moved.
    const store = await readSeatStore(sessionDirOf(homeDir));
    assert.equal(seatFromStore(store, SEAT_A)?.activeHolderId, "holder-one");
    assert.equal(seatFromStore(store, SEAT_A)?.nextOrdinal, 2, "a refusal burned an ordinal");
  });
});

test("phase 0 · a CLOSED successor is refused, while an OPEN one succeeds", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const closedSuccessor = await seedHolder(homeDir, "holder-closed", {
      holderActive: false,
      closed: true,
    });
    assert.equal(closedSuccessor.closed, true, "fixture precondition");

    const refused = await activate(homeDir, SEAT_A, "holder-closed");
    assert.notEqual(refused.code, 0, "a closed session became a seat's active holder");
    assert.match(`${refused.stdout}${refused.stderr}`, /SUCCESSOR_CLOSED/);

    // PAIRED HALF, in the same test so the refusal cannot be satisfied by a verb that
    // refuses every successor: the open one still activates.
    const allowed = await activate(homeDir, SEAT_A, "holder-two");
    assert.equal(allowed.code, 0, `${allowed.stderr}${allowed.stdout}`);
  });
});

test("phase 0 · a CLOSED SEAT is refused, while a VACANT seat still accepts a holder", async () => {
  // 🔑 THE PAIR HERE IS THE POINT, because the two states are easy to conflate: a CLOSED
  // seat is abolished and takes no holders; a VACANT seat (no active holder) is a
  // first-class resting state that must still accept one. A verb that refused both
  // would pass a closed-seat row alone.
  //
  // ⚠️ FIXTURE-ENTERED, AND STATED WHY (B2c, F-B2c-1): at B2 nothing in the product
  // could write a closure, so a fixtured `closedAt` was the only way to reach this
  // state at all. **The product path now EXISTS** — `acpx seats close` — and
  // `"B2c product-entered · a real acpx seats close refuses a real activate (R3)"`
  // below reaches this same refusal by driving it. This row is KEPT because its
  // VACANT half is still a real AP15 pair for the fixture mechanism (clearing
  // `closed_at` by hand is still the only way to reach "closed at a time nothing in
  // this rig produced" — see B2c PLAN.md §0 F-B2c-1), not because the refusal still
  // needs a fixture to be reached.
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir, { activeHolderId: null, closedAt: "2026-09-28T09:00:00.000Z" });

    const refused = await activate(homeDir);
    assert.notEqual(refused.code, 0, "a closed seat accepted a holder");
    assert.match(`${refused.stdout}${refused.stderr}`, /SEAT_CLOSED/);

    // Re-open the seat by clearing `closed_at`, leaving it VACANT, and the same
    // activation must now succeed.
    await withSeatStoreWrite(sessionDirOf(homeDir), (store) => {
      const row = seatFromStore(store, SEAT_A);
      assert.ok(row);
      const seats = new Map(store.seats);
      seats.set(SEAT_A, { ...row, closedAt: null });
      return { mutation: { kind: "write", seats }, result: undefined };
    });
    const allowed = await activate(homeDir);
    assert.equal(
      allowed.code,
      0,
      `a VACANT seat refused a holder — vacancy is a resting state, not an error: ${allowed.stderr}`,
    );
    const payload = JSON.parse(allowed.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.predecessorId, null, "a vacant seat reported a predecessor");
  });
});

test("B2c product-entered · a real `acpx seats close` refuses a real `sessions activate` (R3)", async () => {
  // PRODUCT-ENTERED, per B2c PLAN.md §3 row R3 — the whole point of this block: the
  // closed state is reached through the REAL `acpx seats close` verb, not a fixture.
  //
  // Sequence: mint a founding holder H1 into a fresh seat S (`sessions new -s`);
  // create a successor H2 INTO that seat while it is still open (`sessions new
  // --seat`, since create-into-seat itself refuses once S is closed — R4); close H1
  // so the seat's active holder is no longer open (R1's precondition for `close` to
  // succeed); close S for real; THEN attempt to activate H2 into S and assert the
  // refusal carries `SEAT_CLOSED` — the same code `phase 0 · a CLOSED SEAT is
  // refused` above asserts, reached this time by the real verb.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const founded = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "b2c-r3-h1",
      ],
      homeDir,
    );
    assert.equal(founded.code, 0, founded.stderr);
    const h1 = (JSON.parse(founded.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
    assert.ok(h1, `fixture precondition: sessions new returned a record id — ${founded.stdout}`);
    const h1Record = await readRecordJson(homeDir, h1);
    const seatId = h1Record.seat_id as string | undefined;
    assert.ok(seatId, "fixture precondition: the founding holder carries a seat id");
    assert.match(seatId, /^[0-9a-f-]{36}$/);

    const successor = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "--seat",
        seatId,
      ],
      homeDir,
    );
    assert.equal(successor.code, 0, successor.stderr);
    const h2 = (JSON.parse(successor.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
    assert.ok(
      h2,
      `fixture precondition: sessions new --seat returned a record id — ${successor.stdout}`,
    );

    // `--session-id`, NOT the positional `[name]` arg — that resolves by SESSION
    // NAME, not by record id (`session-selector.ts`: only `--session-id`/
    // `--session-url` reach `resolveExplicitSessionRecord`).
    const closedHolder = await runCli(
      ["--format", "json", "sessions", "close", "--session-id", h1],
      homeDir,
    );
    assert.equal(closedHolder.code, 0, closedHolder.stderr);

    const closedSeat = await runCli(["--format", "json", "seats", "close", seatId], homeDir);
    assert.equal(
      closedSeat.code,
      0,
      `fixture precondition: acpx seats close must succeed once the active holder is closed — ` +
        `${closedSeat.stdout}${closedSeat.stderr}`,
    );
    const closedAt = (JSON.parse(closedSeat.stdout.trim()) as { closedAt?: string }).closedAt;
    assert.ok(closedAt, "fixture precondition: the real close returned a timestamp");

    const refused = await activate(homeDir, seatId, h2);
    assert.notEqual(refused.code, 0, "a seat closed by the REAL verb still accepted an activation");
    const said = `${refused.stdout}${refused.stderr}`;
    assert.match(
      said,
      /SEAT_CLOSED/,
      "the refusal must carry the SEAT_CLOSED code — the command under test (`sessions activate`) " +
        "is what discriminates this from R4's identically-coded create-into-seat refusal",
    );
    // 🛑 F4 (independent TE finding, 2026-09-29): AC16's `Fails if:` clause is
    // explicit — "refuses either without naming the seat and its closed_at". The
    // product does this correctly, but a message reword could drop it silently
    // and greenly with no assertion here to catch it.
    assert.match(said, new RegExp(seatId), "the refusal must name the SEAT");
    assert.match(said, new RegExp(closedAt), "the refusal must name its closed_at TIMESTAMP");
    // 🛑 F5 (independent TE finding, 2026-09-29): `seat-activate.ts` throws
    // SEAT_CLOSED from TWO sites — phase 0.1 (unlocked pre-check, `:160`) and
    // phase 2 (re-check inside the hold, `:287`). A bare `/SEAT_CLOSED/` cannot
    // tell them apart, so this row was believed to pin phase 0.1 and did not —
    // deleting that guard would leave phase 2 to catch it and this row would stay
    // green. Pin phase 0.1's UNIQUE phrase (phase 2's is "while this activation
    // was running", which does not appear here) so a future deletion of the
    // phase-0.1 guard turns this row red.
    assert.match(
      said,
      /takes no further holders/,
      "phase 0.1's unique phrase is absent — this row may be exercising phase 2's " +
        "re-check instead, which would mean the phase-0.1 guard is unpinned",
    );
  });
});

test("phase 0 · a seat with NO ROW is refused with the cause and the remedy (AP17)", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    // No seat row planted at all.
    const result = await activate(homeDir);
    assert.notEqual(result.code, 0);
    const said = `${result.stdout}${result.stderr}`;
    assert.match(said, /SEAT_ROW_MISSING/);
    assert.match(said, /predates the seat store/i, "the refusal does not name the cause");
    assert.match(said, /backfill/i, "the refusal does not name the remedy");
  });
});

test("phase 0 · a malformed seat REFERENCE is rejected, not repaired (D8)", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    // Each is a different one of the three states D8 refuses to collapse. The uppercase
    // and leading-space forms are the ones a `trim().toLowerCase()` would let through —
    // and a value stored differently from how it was submitted is exactly what makes the
    // layers downstream disagree about whether it is absent, malformed or valid.
    for (const bad of ["   ", "not-a-uuid", SEAT_A.toUpperCase(), ` ${SEAT_A}`]) {
      const result = await activate(homeDir, bad);
      assert.notEqual(result.code, 0, `seat ref ${JSON.stringify(bad)} was accepted`);
    }
    // PAIRED HALF: the exact same seat id, unmodified, works.
    const ok = await activate(homeDir, SEAT_A);
    assert.equal(ok.code, 0, `${ok.stderr}${ok.stdout}`);
  });
});

test("phase 0 · a successor of a DIFFERENT kind is refused (B1 ruling 4)", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-sub", { holderActive: false, kind: "subagent" });
    await seedSeat(homeDir);

    const result = await activate(homeDir, SEAT_A, "holder-sub");
    assert.notEqual(result.code, 0, "a subagent was activated into a session seat");
    assert.match(`${result.stdout}${result.stderr}`, /KIND_MISMATCH/);
  });
});

// ─── brick `eca085bb` fix round — KIND_MISMATCH on an ABSENT kind (TE c1c2c2b7) ──
// An absent `kind` MEANS "session" (the refusal message already says so). Comparing
// the raw field refused a succession whenever one side spelled it and the other did
// not — the shape of every migrated (backfilled, pre-programme) record against a
// successor created with `--parent-id`, which stamps `kind: "session"`.

test('KIND · activation over a CLOSED predecessor with kind ABSENT accepts a successor of kind "session"', async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1, closed: true });
    await seedHolder(homeDir, "holder-two", { holderActive: false, kind: "session" });
    await seedSeat(homeDir);
    assert.equal(
      (await readRecordJson(homeDir, "holder-one")).kind,
      undefined,
      "fixture: kind absent",
    );

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const row = seatFromStore(await readSeatStore(sessionDirOf(homeDir)), SEAT_A);
    assert.equal(row?.activeHolderId, "holder-two");
  });
});

test('KIND · activation over a CLOSED predecessor of kind "session" accepts a successor with kind ABSENT', async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", {
      holderActive: true,
      holderOrdinal: 1,
      closed: true,
      kind: "session",
    });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir);

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const row = seatFromStore(await readSeatStore(sessionDirOf(homeDir)), SEAT_A);
    assert.equal(row?.activeHolderId, "holder-two");
  });
});

test("KIND · a genuinely different kind still refuses, and the remedy is printed", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1, closed: true });
    await seedHolder(homeDir, "holder-sub", { holderActive: false, kind: "subagent" });
    await seedSeat(homeDir);

    const result = await activate(homeDir, SEAT_A, "holder-sub");
    assert.notEqual(result.code, 0, "a subagent was activated into a session seat");
    const out = `${result.stdout}${result.stderr}`;
    assert.match(out, /KIND_MISMATCH/);
    assert.match(out, /subagent/);
    assert.match(out, /differs from the seat's current holder \(session\)/);
    assert.match(out, /cannot inherit this seat/);
  });
});

// ─── brick `eca085bb` fix round — the FILL sets the holder's mirror ─────────────

test("MIRROR · after `seats backfill --apply` fills a closed holder's pointer, the FIRST succession reports no mirrorDivergence", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", {
      holderActive: false,
      holderOrdinal: 1,
      closed: true,
    });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    // The migrated shape: an EXISTING row, null pointer (the narrowing's leftover).
    await seedSeat(homeDir, { activeHolderId: null });

    const filled = await runCli(["--format", "json", "seats", "backfill", "--apply"], homeDir);
    assert.equal(filled.code, 0, `${filled.stderr}${filled.stdout}`);
    const row = seatFromStore(await readSeatStore(sessionDirOf(homeDir)), SEAT_A);
    assert.equal(row?.activeHolderId, "holder-one", "control: the fill really pointed the seat");
    assert.equal(
      (await readRecordJson(homeDir, "holder-one")).holder_active,
      true,
      "the mirror disagrees with the pointer the fill just wrote",
    );

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(
      payload.mirrorDivergence,
      null,
      "the first succession reported a false D10 divergence — the fill left the mirror false",
    );
  });
});

// ─── 6 · THE NOTICE (D6) — what it must and must not say ─────────────────────

test("D6 · the notice orients and does NOT brief, claim inherited context, or say P is closed", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const result = await activate(homeDir);
    assert.equal(result.code, 0, result.stderr);
    const notice = String(
      (JSON.parse(result.stdout.trim()) as { activationNotice?: unknown }).activationNotice,
    );

    // The sentinel is first, on its own line, and keyed on as a STRING — never prose.
    assert.ok(notice.startsWith("⟦SEAT-ACTIVATION⟧\n"), "the sentinel is not the first line");
    // What it MUST claim.
    assert.match(notice, /active holder/i);
    assert.match(notice, /holder #2/);
    assert.match(notice, /holder-one/, "the notice does not name the predecessor");
    assert.match(notice, /retired/i);
    assert.match(notice, /arrives here/i, "the notice does not say mail now arrives here");

    // 🛑 WHAT IT MUST NOT CLAIM — the load-bearing half.
    assert.doesNotMatch(
      notice,
      /\bclosed\b/i,
      "the notice says the predecessor is CLOSED — retirement is not a close, and that duty " +
        "may be undischarged, so the notice must not assert an act that has not happened",
    );
    // ⚠️ THE ASSERTION IS ON AN AFFIRMATIVE INSTRUCTION, NOT ON THE WORD. A bare
    // /resume/ is wrong here and my first version of this row used it: the notice
    // legitimately says "Nothing is waiting for you to resume", which is the NEGATION —
    // exactly the sentence D6 wants. Forbidding the word would push the notice into
    // saying LESS about the thing it most needs to be explicit about.
    assert.doesNotMatch(
      notice,
      /\bresume (your|the|this|where)|you (can|should|may|must) resume|continue where|pick up where/i,
      "the notice INSTRUCTS the successor to resume — it is a FRESH session and carries none " +
        "of the predecessor's transcript, so this would send it looking for one it does not have",
    );
    // …and the positive half, because "does not instruct resumption" is satisfied by
    // saying nothing at all. D6 requires the notice to be EXPLICIT that there is no
    // inherited context — silence would leave the successor to assume there is.
    assert.match(
      notice,
      /no inherited context/i,
      "the notice does not state that the successor has NO inherited context",
    );
    assert.doesNotMatch(
      notice,
      /your (task|job|duties|responsibilities) (is|are)|you should now/i,
      "the notice briefs the successor — it tells it what it IS, never what to DO; a notice " +
        "that summarises duties has become the seat description Daniel struck",
    );
    assert.doesNotMatch(
      notice,
      /will be forwarded|forwarded to you|follow you/i,
      "the notice claims mail to the old address follows — it does not",
    );
  });
});

// ─── 7 · the index projection lands for BOTH records ─────────────────────────

test("both records reach the INDEX in one projection, agreeing with their records", async () => {
  // The index is what acpx-ui's hot path reads; a mirror that stopped at the record
  // would be a routing failure rather than a cosmetic one.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    assert.equal((await activate(homeDir)).code, 0);

    const index = JSON.parse(
      await fs.readFile(path.join(sessionDirOf(homeDir), "index.json"), "utf8"),
    ) as { entries?: { acpxRecordId?: string; holderActive?: boolean; holderOrdinal?: number }[] };
    const entryFor = (id: string) => (index.entries ?? []).find((e) => e.acpxRecordId === id);
    assert.equal(entryFor("holder-one")?.holderActive, false, "the index still shows P active");
    assert.equal(entryFor("holder-two")?.holderActive, true);
    assert.equal(entryFor("holder-two")?.holderOrdinal, 2);
  });
});

// ─── 8 · the preserve and the activation, together on the real verb ──────────

test("a stale privileged write after the flip cannot revive the retired holder", async () => {
  // AP1's record half against the REAL activate verb rather than a hand-built write:
  // hold a record read BEFORE the flip (which is what `closeSession` does across its
  // drain), then write it privileged afterwards, and require the flip to survive.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const persistence = await import("../src/session/persistence.js");
    const stale = await resolveSessionRecord("holder-one");
    assert.equal(stale.holderActive, true, "fixture precondition");

    assert.equal((await activate(homeDir)).code, 0);

    stale.closed = true;
    stale.closedAt = new Date().toISOString();
    await persistence.writeSessionRecordAtBoundaryWithLifecycle(stale);

    const after = await readRecordJson(homeDir, "holder-one");
    assert.equal(
      after.holder_active,
      false,
      "a stale privileged write revived the retired holder — the seat now mirrors the wrong holder",
    );
    assert.equal(after.closed, true, "the close itself must still have landed");
    void writeSessionRecordAuthorizingSeatHolderWithoutIndex;
  });
});

// ─── 7 · F8 — THE DURABLE LEG. A diagnostic on stderr ONLY is not on the record ──

// 🛑 WHY THIS ROW IS NOT A NICETY: Cluster A requirement 3 stores NOTHING for a mirror
// divergence — no counter, no field, no total — and says the line goes to the verb's output
// **and the session stream** *"so it is on the record"*. So this line is the ENTIRE durable
// trace of a two-source divergence, and it was stderr-only until F8 (the test-engineer's
// pass 2) found the missing half. The row above it (§4) asserted "exactly one line" on
// stderr and passed the whole time — proving that a complete-looking assertion on one leg
// says nothing whatever about the other.
test("F8 · the divergence line reaches the SUCCESSOR'S STREAM, not only stderr", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: false, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir, { activeHolderId: "holder-one", nextOrdinal: 2 });

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    // The terminal leg — unchanged, and still exactly one.
    assert.equal(
      result.stderr.split("\n").filter((l) => l.includes("seat-mirror-divergence")).length,
      1,
    );

    // THE DURABLE LEG, read back off disk.
    // ⚠️ FROM THE SIDECAR, NOT `<id>.json`. A boundary write persists messages to
    // `<id>.messages.ndjson` and leaves the record's inline `messages` EMPTY — that is the
    // established storage shape (`messages_log`), not a defect. My first version of this row
    // asserted on `record.messages` and failed against correct code, which is the same
    // wrong-file mistake in the opposite direction: it would have reported a missing durable
    // leg that was in fact present. Both files are read here so the row says WHICH carried it.
    const successor = await readRecordJson(homeDir, "holder-two");
    const sidecarPath = path.join(sessionDirOf(homeDir), "holder-two.messages.ndjson");
    const sidecar = await fs.readFile(sidecarPath, "utf8").catch(() => "");
    const onRecord = `${JSON.stringify(successor.messages ?? [])}\n${sidecar}`;
    assert.ok(
      sidecar.length > 0,
      `the successor has no messages sidecar at all (${sidecarPath}) — the durable leg was ` +
        `never written, so the line exists only in the operator's scrollback`,
    );
    // The record's BOOKKEEPING must agree with the sidecar, or the line is on disk and
    // invisible: acpx-ui hydrates a conversation through `messages_log` (a
    // `SessionMessagesLogState`, NOT a path — my first version asserted `typeof === "string"`
    // and failed against a correct record, which is why the shape is named here).
    const log = successor.messages_log as { count?: unknown; bytes?: unknown } | undefined;
    assert.ok(
      log !== undefined && typeof log.count === "number" && log.count >= 1,
      `the record does not account for the appended message (messages_log=${JSON.stringify(log)}) ` +
        `— nothing will render the line even though it is on disk`,
    );
    assert.ok(
      onRecord.includes("seat-mirror-divergence"),
      `the divergence line is NOT on the successor's record — it exists only in the ` +
        `operator's scrollback, and requirement 3 stores nothing else about it. ` +
        `messages=${onRecord.slice(0, 400)}`,
    );
    assert.ok(
      onRecord.includes("predecessor=holder-one"),
      "the line on the record does not name the predecessor, so the forensic link the " +
        "successor's-stream choice depends on is broken",
    );
    // 🔑 SYNTHETIC — a system breadcrumb, not a model turn. Unmarked, it counts as
    // irreplaceable history in the resume→session/new fallback gate (brick://de3645c6) and
    // a fresh successor whose first prompt hits a missing transcript becomes permanently
    // unpromptable. A WARNING MUST NEVER BE ABLE TO COST THE SESSION IT WARNS ABOUT.
    assert.ok(
      onRecord.includes('"synthetic":true'),
      "the diagnostic was appended as a REAL turn — it must be marked synthetic",
    );
  });
});

// THE PAIR, and without it the row above cannot tell "writes on divergence" from "writes
// on every activation" — the same trap §4's clean-succession row exists for, one leg down.
test("F8 · a CLEAN succession puts NO divergence line on the successor's stream", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const result = await activate(homeDir);
    assert.equal(result.code, 0, result.stderr);
    const successor = await readRecordJson(homeDir, "holder-two");
    assert.equal(
      JSON.stringify(successor.messages ?? []).includes("seat-mirror-divergence"),
      false,
      "a healthy succession wrote a divergence line onto the successor's record",
    );
  });
});

// ─── 8 · F9 — THE NOTICE MUST NOT STATE A FACT IT CANNOT KNOW ────────────────────

// 🛑 THE DEFECT F9 FOUND: both the `resumed` and `already-active` branches rendered
// *"This seat was vacant before you; there is no predecessor."* — on the HEAL path, where a
// predecessor was demonstrably retired moments earlier by the run that crashed. D6's
// governing rule is that nothing in this notice is fabricated, and this is the one piece of
// text whose entire job is orienting a successor.
//
// ⚠️ AND THE FIX IS **OMIT**, NOT COMPUTE. On these branches the pointer already names the
// successor, so `resolvePredecessorOrRefuse` resolves the successor ITSELF and the real
// predecessor is unknowable from the surviving state. Computing it would need the holder
// enumeration the protocol confines to the backfill. `{known:false}` means *"not computed on
// this branch"*, which is a different fact from `{known:true, id:null}` = *genuinely vacant*.
test("F9 · the RESUMED notice omits the predecessor sentence rather than claiming vacancy", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    // AP6's torn state: the pointer already moved to holder-two, holder-one is retired.
    await seedHolder(homeDir, "holder-one", { holderActive: false, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir, { activeHolderId: "holder-two", nextOrdinal: 2 });

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.outcome, "resumed", "this row must exercise the HEAL branch");
    const notice = String(payload.activationNotice);
    assert.equal(
      notice.includes("vacant"),
      false,
      `the resumed notice claims the seat was VACANT — holder-one was retired moments ago by ` +
        `the crashed run, so this is a fabricated fact in the successor's orientation text: ${notice}`,
    );
    assert.equal(
      notice.includes("no predecessor"),
      false,
      `the resumed notice denies a predecessor: ${notice}`,
    );
    // …and the rest of the notice is intact — an omission, not a truncation. The line it
    // dropped must not have taken its neighbours with it.
    assert.ok(notice.includes("holder #2"), `the resumed notice lost its ordinal: ${notice}`);
    assert.ok(
      notice.includes("no inherited context"),
      `the resumed notice lost D6's central statement: ${notice}`,
    );
    assert.ok(
      notice.includes("Mail addressed to the seat now arrives here"),
      `the resumed notice lost the line that FOLLOWED the omitted one — the omission removed ` +
        `more than the sentence: ${notice}`,
    );
  });
});

// THE PAIR — and it is the whole non-vacuity control for the two rows above: a notice that
// dropped the sentence UNCONDITIONALLY would pass them both while losing real information
// on the branch where the predecessor IS known.
test("F9 · the ACTIVATED notice still names a known predecessor, and still reports a genuine vacancy", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const withPredecessor = await activate(homeDir);
    assert.equal(withPredecessor.code, 0, withPredecessor.stderr);
    const notice = String(
      (JSON.parse(withPredecessor.stdout.trim()) as Record<string, unknown>).activationNotice,
    );
    assert.ok(
      notice.includes("Your predecessor is holder-one"),
      `a KNOWN predecessor is no longer named — the omission was applied too widely: ${notice}`,
    );
    assert.ok(notice.includes("RETIRED and still readable"), notice);
  });
});

test("F9 · a GENUINELY vacant seat still says so — `null` and `not known` are different facts", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    // activeHolderId null = vacant. The predecessor IS known here: there was none.
    await seedSeat(homeDir, { activeHolderId: null, nextOrdinal: 2 });

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.outcome, "activated");
    assert.ok(
      String(payload.activationNotice).includes("vacant"),
      `a genuinely vacant seat stopped saying so — the F9 fix collapsed "not known" and ` +
        `"known to be none" into one silence: ${String(payload.activationNotice)}`,
    );
  });
});

test("F9 · the ALREADY-ACTIVE notice omits it too", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
    await seedSeat(homeDir, { activeHolderId: "holder-one", nextOrdinal: 2 });

    const result = await activate(homeDir, SEAT_A, "holder-one");
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.outcome, "already-active");
    assert.equal(
      String(payload.activationNotice).includes("vacant"),
      false,
      `the already-active notice claims vacancy while the addressee IS the sitting holder: ` +
        String(payload.activationNotice),
    );
  });
});

// ─── practical-tests pass 1, brick e829327e — AC6: an ordinal is a LABEL, assigned once, never renumbered ─────
// Rolling back to a RETIRED (open) former holder used to draw a fresh ordinal for it — #2 became #4, and "#2"
// named no one in the seat any more — overwriting a label that journal lines, stamps and humans already hold.
// Re-activating a holder KEEPS its ordinal and leaves next_ordinal alone; only a NEW holder (one with no
// ordinal yet) takes next_ordinal.

/** a retired (#1), b retired (#2), c ACTIVE (#3), and a PREPARED holder d with no ordinal; next_ordinal 4. */
async function seedRolledForwardSeat(homeDir: string): Promise<void> {
  await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
  await seedHolder(homeDir, "holder-a", { holderActive: false, holderOrdinal: 1 });
  await seedHolder(homeDir, "holder-b", { holderActive: false, holderOrdinal: 2 });
  await seedHolder(homeDir, "holder-c", { holderActive: true, holderOrdinal: 3 });
  await seedHolder(homeDir, "holder-d", { holderActive: false });
  await seedSeat(homeDir, { activeHolderId: "holder-c", nextOrdinal: 4 });
}

test("AC6 · re-activating a RETIRED holder KEEPS its ordinal and does not advance next_ordinal", async () => {
  await withTempHome(async (homeDir) => {
    await seedRolledForwardSeat(homeDir);

    const result = await activate(homeDir, SEAT_A, "holder-b");
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.outcome, "activated");
    assert.equal(payload.holderOrdinal, 2, "holder-b was #2 and must stay #2, not be re-drawn");

    const row = seatFromStore(await readSeatStore(sessionDirOf(homeDir)), SEAT_A);
    assert.equal(
      row?.activeHolderId,
      "holder-b",
      "the pointer must still move to the re-activated holder",
    );
    assert.equal(
      row?.nextOrdinal,
      4,
      "re-activation consumed an ordinal — next_ordinal must not move",
    );

    const b = await readRecordJson(homeDir, "holder-b");
    const c = await readRecordJson(homeDir, "holder-c");
    assert.equal(b.holder_ordinal, 2, "the stored label of holder-b changed");
    assert.equal(b.holder_active, true);
    assert.equal(c.holder_ordinal, 3, "the retired holder's label must be untouched");
    assert.equal(c.holder_active, false);
  });
});

test("AC6 · a NEW holder still takes next_ordinal, after a re-activation as before it", async () => {
  await withTempHome(async (homeDir) => {
    await seedRolledForwardSeat(homeDir);

    const rollback = await activate(homeDir, SEAT_A, "holder-b");
    assert.equal(rollback.code, 0, `${rollback.stderr}${rollback.stdout}`);

    const fresh = await activate(homeDir, SEAT_A, "holder-d");
    assert.equal(fresh.code, 0, `${fresh.stderr}${fresh.stdout}`);
    const payload = JSON.parse(fresh.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.holderOrdinal, 4, "a new holder takes next_ordinal (4)");
    const row = seatFromStore(await readSeatStore(sessionDirOf(homeDir)), SEAT_A);
    assert.equal(row?.nextOrdinal, 5);
    assert.equal((await readRecordJson(homeDir, "holder-d")).holder_ordinal, 4);
    assert.equal((await readRecordJson(homeDir, "holder-b")).holder_ordinal, 2, "b is still #2");
  });
});
