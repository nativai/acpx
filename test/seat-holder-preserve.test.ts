import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  copySeatHolderFields,
  copySeatLinkageFields,
  SEAT_FIELD_PARTITION,
} from "../src/session/persistence/seat-fields.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// D1 — the seat write-authority partition (brick b64dfbb3, ACTIVATION-PROTOCOL.md
// §3.5), and the two acceptance rows that discriminate it: AP2 and AP3.
//
// WHAT THIS FILE DEFENDS, in one sentence: the seat group has TWO authorised
// writers, and each must be unable to move the other's fields. `c99f9994` F2 was
// found by exactly this shape of positive control and never by the type system,
// which is why the rows below assert a VALUE ON DISK after a real write rather
// than that a helper's name appears in the source.
//
// ⚠️ Driven against the real persistence module (and the real compiled CLI for
// the `set-parent` row) rather than as unit calls on the preserve, for the reason
// `session-reparent.test.ts` states for its own rows: the failure this feature is
// most exposed to is a field that survives the mutator and is dropped by one of
// the four field-by-field transforms, and every one of those legs is green under a
// unit call.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const PERSISTENCE_MODULE_URL = new URL("../src/session/persistence.js", import.meta.url);

type PersistenceModule = typeof import("../src/session/persistence.js");
type CliResult = { code: number | null; stdout: string; stderr: string };

function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  return withTempHomeFixture("acpx-seat-holder-preserve-", run);
}

async function loadPersistenceModule(): Promise<PersistenceModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(
    `${PERSISTENCE_MODULE_URL.href}?seat_holder_preserve_test=${cacheBuster}`
  )) as PersistenceModule;
}

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    // ⚠️ Same scrub `session-reparent.test.ts` documents: `sessions` verbs fall
    // back to these for --parent-id, and the runner's own env carries them, so a
    // fixture built without the scrub silently acquires the TEST RUNNER's session
    // as its parent.
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
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
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function seed(
  homeDir: string,
  id: string,
  overrides: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const record = makeSessionRecordFixture({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "node mock",
    agentName: "claude",
    cwd: path.join(homeDir, "workspace"),
    name: id,
    ...overrides,
  });
  await writeSessionRecordFile(homeDir, record);
  return record;
}

async function readRecordJson(homeDir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
    string,
    unknown
  >;
}

// ─── 1 · The partition anchor's two halves actually partition ────────────────
//
// The committed negative case for the doc comments on `copySeatHolderFields` /
// `copySeatLinkageFields`: each claims to be TOTAL over its own half and to touch
// NOTHING outside it. A comment has no adversary, so these rows are the adversary.
// They are also what catches a mis-classification in `SEAT_FIELD_PARTITION`
// itself — the one place a seat field's authority is declared.

test("D1 partition: every seat field is classified into exactly one half", () => {
  assert.deepEqual(SEAT_FIELD_PARTITION, {
    seatId: "holder",
    holderOrdinal: "holder",
    holderActive: "holder",
    parentSeatId: "linkage",
  });
  // The compiler forces EXHAUSTIVENESS (`satisfies { [K in keyof
  // Required<SeatRecordFields>]: SeatFieldHalf }`), so a fifth seat field cannot
  // reach this assertion unclassified — it fails typecheck by name first. What
  // this row adds is the CLASSIFICATION itself: that `holderActive` is in the
  // holder half and `parentSeatId` is not, which is the fact AP2 rests on and
  // which the compiler cannot check.
});

test("copySeatHolderFields copies all three holder fields and does NOT touch parentSeatId", () => {
  const target: Partial<SessionRecord> = {
    seatId: "old-seat",
    holderOrdinal: 1,
    holderActive: true,
    parentSeatId: "target-parent-seat",
  };
  // ⚠️ THE STRONGEST HALF OF THIS GUARANTEE IS BY CONSTRUCTION, NOT BEHAVIOURAL,
  // and it was confirmed by the compiler while this row was being written: adding
  // `parentSeatId` to the source literal below fails `build:test` with
  // `TS2353: 'parentSeatId' does not exist in type 'SeatHolderFields'`. The
  // derived half-type cannot even NAME the other half's field, so the holder copy
  // has no way to reach it. The runtime assertion below is the belt on top of
  // that: it pins the target's linkage value across the call.
  copySeatHolderFields(target, {
    seatId: "disk-seat",
    holderOrdinal: 7,
    holderActive: false,
  });
  assert.equal(target.seatId, "disk-seat");
  assert.equal(target.holderOrdinal, 7);
  assert.equal(target.holderActive, false);
  assert.equal(
    target.parentSeatId,
    "target-parent-seat",
    "the holder half reached into the LINKAGE half — that is the coarse-flag defect D1 rejects",
  );
});

test("copySeatHolderFields copies an ABSENT value as absent — it does not fill an absence", () => {
  // This is the row that discriminates unconditional disk-wins from the
  // fill-an-absence style. `holderActive` is THE field that changes, so a
  // fill-an-absence copy is the no-op form of the whole fix.
  const target: Partial<SessionRecord> = { holderActive: true, holderOrdinal: 4 };
  copySeatHolderFields(target, { holderActive: undefined, holderOrdinal: undefined });
  assert.equal(target.holderActive, undefined, "a stale `true` survived an absent on-disk value");
  assert.equal(target.holderOrdinal, undefined);
});

test("copySeatLinkageFields copies parentSeatId and does NOT touch the holder half", () => {
  const target: Partial<SessionRecord> = {
    seatId: "target-seat",
    holderActive: true,
    parentSeatId: "old-parent-seat",
  };
  copySeatLinkageFields(target, {
    parentSeatId: "disk-parent-seat",
  });
  assert.equal(target.parentSeatId, "disk-parent-seat");
  assert.equal(
    target.holderActive,
    true,
    "the linkage half moved holderActive — a single coarse seat flag would do exactly this",
  );
  assert.equal(target.seatId, "target-seat");
});

// ─── 2 · AP2 + AP3 + the preserve, all three directions in ONE test ─────────

test("ALL DIRECTIONS AT ONCE: the preserve beats a stale privileged write, the activation beats the preserve, and set-parent moves neither holder field", async () => {
  await withTempHome(async (homeDir) => {
    const persistence = await loadPersistenceModule();

    await seed(homeDir, "new-parent", { seatId: "11111111-1111-4111-8111-111111111111" });
    await seed(homeDir, "holder", {
      seatId: "22222222-2222-4222-8222-222222222222",
      holderOrdinal: 1,
      holderActive: true,
      parentSeatId: "33333333-3333-4333-8333-333333333333",
    });

    // 🛑 THESE ASSERTIONS ARE IN ONE TEST DELIBERATELY. They pull in OPPOSITE
    // directions through the same seam, and each would have a passing test of its
    // own in isolation — so a repair to one made at the other's expense leaves the
    // suite GREEN. Exactly the argument `session-reparent.test.ts`'s own
    // "BOTH DIRECTIONS AT ONCE" row makes for the parent group:
    //   • make the preserve unconditional but drop the `authoritative.seatHolder`
    //     gate  → direction B fails, the succession verb silently writes nothing;
    //   • keep the gate but move the preserve inside `preserveLifecycle`
    //     → direction A fails, a close in flight silently undoes the flip;
    //   • collapse the two halves into one coarse `seat?: true` flag
    //     → direction C fails, `set-parent` gains authority over the active-holder
    //       mirror through the very mechanism meant to protect it.

    // ── DIRECTION A (the preserve) — disk wins over a stale privileged write ──
    // The production shape being probed is `session-control.ts`'s `closeSession`:
    // it reads the record at entry, spends multi-seconds draining and killing the
    // owner, then writes that stale object through
    // `writeSessionRecordAtBoundaryWithLifecycle` (`preserveLifecycle: false`).
    // We hold the stale object the same way, let the flip land underneath it, and
    // then perform that privileged write.
    const staleRecord = await persistence.resolveSessionRecord("holder");
    assert.equal(staleRecord.holderActive, true, "fixture precondition");

    // The succession's retirement write lands while the close holds its stale copy.
    const retiring = await persistence.resolveSessionRecord("holder");
    retiring.holderActive = false;
    retiring.holderOrdinal = 1;
    await persistence.writeSessionRecordAuthorizingSeatHolderWithoutIndex(retiring);
    assert.equal(
      (await readRecordJson(homeDir, "holder")).holder_active,
      false,
      "precondition for direction A: the retirement write did not reach disk",
    );

    // 🔑 PAIRED CONTROL — WITHOUT THIS, DIRECTION A'S GREEN IS UNFALSIFIABLE.
    // The row below asserts that a value SURVIVES a stale privileged write. A rig
    // in which nothing is ever clobbered would pass it while proving nothing, and
    // that failure mode is silent. So the same privileged write must be shown to
    // clobber a field that is deliberately NOT protected on this path: `favorite`
    // is preserved only inside the `preserveLifecycle` branch, which the privileged
    // write bypasses by design. We set it on disk underneath the stale copy and
    // require it to be REVERTED by the same call that leaves `holderActive` alone.
    //
    // ⚠️ If this control ever fails, do NOT delete it: it means `favorite` gained
    // unconditional preservation, and the control needs a new unprotected subject —
    // not that the seat preserve is broken.
    //
    // ⚠️ AND IT MUST BE SET THROUGH THE PRIVILEGED PATH, not `writeSessionRecord`.
    // Measured while writing this row: the ordinary write is `preserveLifecycle:
    // true`, so `applyPersistedLifecycleForWrite` overwrites the in-memory
    // `favorite` with the on-disk value and the fixture's own set-up is silently
    // suppressed — the precondition assertion below read `undefined`. `favorite` is
    // acpx-ui-owned; nothing on the daemon side can set it through the preserving
    // path, which is exactly the asymmetry that makes it a good control subject.
    const favouriting = await persistence.resolveSessionRecord("holder");
    favouriting.favorite = true;
    favouriting.favoritedAt = new Date().toISOString();
    await persistence.writeSessionRecordWithLifecycle(favouriting);
    assert.equal(
      (await readRecordJson(homeDir, "holder")).favorite,
      true,
      "control precondition: the favorite write did not reach disk",
    );

    staleRecord.closed = true;
    staleRecord.closedAt = new Date().toISOString();
    await persistence.writeSessionRecordAtBoundaryWithLifecycle(staleRecord);

    const afterClose = await readRecordJson(homeDir, "holder");
    assert.equal(
      afterClose.holder_active,
      false,
      "DIRECTION A FAILED: a stale privileged write revived the retired holder — the seat now mirrors the wrong holder",
    );
    assert.equal(afterClose.closed, true, "the close itself must still have landed");
    assert.notEqual(
      afterClose.favorite,
      true,
      "PAIRED CONTROL FAILED: this stale privileged write clobbered NOTHING, so direction A's pass is vacuous — the rig cannot observe the defect it is asserting the absence of",
    );

    // ── DIRECTION B (the authority) — the activation write beats that preserve ──
    const activating = await persistence.resolveSessionRecord("holder");
    activating.holderActive = true;
    activating.holderOrdinal = 2;
    await persistence.writeSessionRecordAuthorizingSeatHolderWithoutIndex(activating);

    const afterActivate = await readRecordJson(homeDir, "holder");
    assert.equal(
      afterActivate.holder_active,
      true,
      "DIRECTION B FAILED: the preserve swallowed the activation's own write — the succession verb is a silent no-op",
    );
    assert.equal(afterActivate.holder_ordinal, 2);
    // AP3: the activation declared `authoritative.seatHolder` ONLY, so the
    // linkage half must still come from disk untouched.
    assert.equal(
      afterActivate.parent_seat_id,
      "33333333-3333-4333-8333-333333333333",
      "AP3 FAILED: the activation moved parentSeatId — it is authoritative for the holder half only",
    );

    // ── DIRECTION C (AP2) — `set-parent` cannot move holderActive ──────────────
    // `set-parent` declares `authoritative: { parent: true }`. Under a single
    // coarse seat flag that same declaration would hand it authority over
    // `holderActive`, and this row is what catches that design.
    // Put the on-disk holder into the RETIRED state, then hand set-parent a
    // process whose own read will carry it — and assert it cannot flip it back.
    const retireAgain = await persistence.resolveSessionRecord("holder");
    retireAgain.holderActive = false;
    await persistence.writeSessionRecordAuthorizingSeatHolderWithoutIndex(retireAgain);

    const setParent = await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "holder", "--parent-id", "new-parent"],
      homeDir,
    );
    assert.equal(setParent.code, 0, setParent.stderr);

    const afterSetParent = await readRecordJson(homeDir, "holder");
    assert.equal(
      afterSetParent.holder_active,
      false,
      "AP2 FAILED: set-parent moved holderActive — requirement 3's exactly-one-writer is broken by the mechanism meant to protect it",
    );
    assert.equal(afterSetParent.holder_ordinal, 2, "AP2 FAILED: set-parent moved holderOrdinal");
    assert.equal(
      afterSetParent.seat_id,
      "22222222-2222-4222-8222-222222222222",
      "AP2 FAILED: set-parent moved seatId",
    );
    // …while its OWN half did move, which is what makes the row above a real
    // discrimination rather than a verb that simply failed.
    assert.equal(
      afterSetParent.parent_seat_id,
      "11111111-1111-4111-8111-111111111111",
      "set-parent did not write its own linkage half — the row above proves nothing if the verb no-opped",
    );
  });
});
