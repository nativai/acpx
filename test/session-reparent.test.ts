import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// `acpx sessions set-parent` — CONCEPTION §1.8, brick c99f9994.
//
// Driven as the REAL COMPILED CLI against a temp HOME-scoped store, not as unit
// calls on the mutator: the failure this feature is most exposed to is a field
// that survives the mutator and is dropped by one of the four field-by-field
// persistence transforms (serialize / parse / the index projection / the index
// PARSER). Every one of those legs is green under a unit call on the mutator.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SESSION_MODULE_URL = new URL("../src/session/session.js", import.meta.url);
const PERSISTENCE_MODULE_URL = new URL("../src/session/persistence.js", import.meta.url);

type SessionModule = typeof import("../src/session/session.js");
type PersistenceModule = typeof import("../src/session/persistence.js");
type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    // ⚠️ ACPX_SESSION_URL / ACPX_PARENT_SESSION_URL MUST BE SCRUBBED. `sessions
    // new`/`copy` fall back to them for --parent-id, and the runner's own env
    // carries them, so a fixture built without this scrub silently acquires the
    // TEST RUNNER's session as its parent — which is how a `--children-of` that
    // "correctly moved nothing" becomes indistinguishable from one pointed at the
    // wrong parent. (Measured on this brick's rig: it produced real orphan edges.)
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  return withTempHomeFixture("acpx-reparent-", run);
}

async function loadSessionModule(): Promise<SessionModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(`${SESSION_MODULE_URL.href}?reparent_test=${cacheBuster}`)) as SessionModule;
}

async function loadPersistenceModule(): Promise<PersistenceModule> {
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  return (await import(
    `${PERSISTENCE_MODULE_URL.href}?reparent_test=${cacheBuster}`
  )) as PersistenceModule;
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

async function readIndexEntry(homeDir: string, id: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(
    await fs.readFile(path.join(homeDir, ".acpx", "sessions", "index.json"), "utf8"),
  ) as { entries?: Record<string, unknown>[] };
  const entry = (raw.entries ?? []).find((candidate) => candidate.acpxRecordId === id);
  assert.ok(entry, `no index entry for ${id}`);
  return entry;
}

function parseJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").at(-1);
  assert.ok(line, "expected a JSON line on stdout");
  return JSON.parse(line) as Record<string, unknown>;
}

// ─── 1. Round-trip through the REAL transforms, record AND index entry ────────

test("set-parent round-trips all four fields onto the record AND the index entry", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "old-parent");
    await seed(homeDir, "new-parent");
    await seed(homeDir, "child", { parentSessionId: "old-parent" });

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "child",
        "--parent-id",
        "new-parent",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = parseJsonLine(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, false);
    // `moved` is an ARRAY even for a single target — a batch of one is still a
    // batch, so a caller never branches on which flag it passed. The repo has a
    // live specimen of an alarm that fired on a complete success because a `moved`
    // field was read as a scalar (acpx-ui 97ff3eac).
    assert.ok(Array.isArray(payload.moved), "moved must be an array");
    const moved = payload.moved as Record<string, unknown>[];
    assert.equal(moved.length, 1);
    assert.equal(moved[0]?.acpxRecordId, "child");
    assert.equal(moved[0]?.previousParentSessionId, "old-parent");
    assert.equal(moved[0]?.spawnedBySessionId, "old-parent");

    // Leg 1+2: the on-disk record, in snake_case.
    const record = await readRecordJson(homeDir, "child");
    assert.equal(record.parent_session_id, "new-parent");
    assert.equal(record.spawned_by_session_id, "old-parent");
    assert.equal(typeof record.parent_set_at, "string");

    // Leg 3+4: the INDEX ENTRY. acpx-ui's hot path never opens <id>.json — it
    // synthesises its whole view from this entry — so a record-only write leaves
    // the board's tree unmoved while typecheck, build and every other test pass.
    const entry = await readIndexEntry(homeDir, "child");
    assert.equal(entry.parentSessionId, "new-parent");
    assert.equal(entry.spawnedBySessionId, "old-parent");
    assert.equal(entry.parentSetAt, record.parent_set_at);
  });
});

test("the index PARSER preserves the new fields across a DRIFT reconcile", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "old-parent");
    await seed(homeDir, "new-parent");
    await seed(homeDir, "child", { parentSessionId: "old-parent" });
    await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "new-parent"],
      homeDir,
    );
    assert.equal((await readIndexEntry(homeDir, "child")).parentSetAt !== undefined, true);

    // ⚠️ THE DRIFT PATH IS THE ONLY ONE THAT EXERCISES `parseIndexEntry`, AND
    // GETTING THAT WRONG MAKES THIS TEST UNABLE TO FAIL. A full rebuild
    // (`index.json` missing/unparseable) re-derives every entry FROM ITS RECORD
    // through the projection, so a field the PARSER drops is silently restored and
    // the test passes against a broken parser — measured, this test's first version
    // did exactly that: deleting both parser lines left it green.
    //
    // So: drop a NEW record file straight onto disk to make index.files drift, then
    // run a WRITE. reconcileDriftedEntries parses only the new file and carries
    // every other entry over FROM index.json — i.e. through parseIndexEntry — and
    // the write persists the result. `child`'s entry makes that round trip without
    // its record ever being re-read.
    await seed(homeDir, "late-arrival");
    const write = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "late-arrival",
        "--parent-id",
        "new-parent",
      ],
      homeDir,
    );
    assert.equal(write.code, 0, write.stderr);

    const entry = await readIndexEntry(homeDir, "child");
    assert.equal(entry.parentSessionId, "new-parent");
    assert.equal(entry.spawnedBySessionId, "old-parent");
    assert.equal(typeof entry.parentSetAt, "string");
  });
});

// ─── 2. ACCEPTANCE CRITERION 4 — the live-owner checkpoint ────────────────────

test("a stale checkpoint write does NOT revert a re-parent (criterion 4)", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "old-parent");
    await seed(homeDir, "new-parent");
    await seed(homeDir, "child", { parentSessionId: "old-parent" });

    const persistence = await loadPersistenceModule();
    // THE PRODUCTION SHAPE, modelled: a live queue owner holds an in-memory record
    // read BEFORE the re-parent — so it still carries the OLD parent — and flushes
    // it at its next periodic checkpoint through plain `writeSessionRecord`. That
    // flush is the lost update. Held here explicitly so the staleness is the
    // fixture rather than a timing accident.
    const ownerInMemoryRecord = await persistence.resolveSessionRecord("child");
    assert.equal(ownerInMemoryRecord.parentSessionId, "old-parent");

    const moved = await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "new-parent"],
      homeDir,
    );
    assert.equal(moved.code, 0, moved.stderr);

    // The owner checkpoints. Its record is stale; disk must win.
    ownerInMemoryRecord.lastUsedAt = new Date().toISOString();
    await persistence.writeSessionRecord(ownerInMemoryRecord);

    const record = await readRecordJson(homeDir, "child");
    assert.equal(
      record.parent_session_id,
      "new-parent",
      "the stale owner checkpoint reverted the parent — applyPersistedLifecycleForWrite is not preserving it",
    );
    assert.equal(record.spawned_by_session_id, "old-parent");
    assert.equal(typeof record.parent_set_at, "string");
    // …and the INDEX ENTRY too: acpx-ui reads the tree from there, so a record
    // that survives while the entry reverts still moves the board back.
    const entry = await readIndexEntry(homeDir, "child");
    assert.equal(entry.parentSessionId, "new-parent");
  });
});

test("criterion 4 on a FORKED child — the case where the strip is VISIBLE", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "fork-source");
    await seed(homeDir, "new-parent");
    // ⚠️ THE FIRE-TEST FOR CRITERION 4 MUST USE A FORKED CHILD, AND THE NON-FORKED
    // VERSION ABOVE IS NOT A SUBSTITUTE. Measured cross-lane on this brick: when a
    // writer strips `parent_set_at`, the two cases diverge —
    //   plain spawn child → LOOKS FINE. Lineage branch 4 resolves to the same
    //                       parent, so losing the marker changes no edge and a
    //                       test here PASSES ON A BROKEN BUILD.
    //   FORKED child      → REVERTS. Without the marker, fork-wins returns and the
    //                       edge goes back to the fork source; the board moves the
    //                       tile back.
    // So this test, not its sibling, is the one that can see the hole.
    await seed(homeDir, "forked-child", {
      parentSessionId: "fork-source",
      forkedFromSessionId: "fork-source",
    });

    const persistence = await loadPersistenceModule();
    const ownerInMemoryRecord = await persistence.resolveSessionRecord("forked-child");

    const moved = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "forked-child",
        "--parent-id",
        "new-parent",
      ],
      homeDir,
    );
    assert.equal(moved.code, 0, moved.stderr);

    ownerInMemoryRecord.lastUsedAt = new Date().toISOString();
    await persistence.writeSessionRecord(ownerInMemoryRecord);

    const record = await readRecordJson(homeDir, "forked-child");
    // The MARKER is what decides the edge for a forked child. Its loss is the whole
    // defect, and `parent_session_id` surviving is NOT enough to call this green.
    assert.equal(
      typeof record.parent_set_at,
      "string",
      "the marker was stripped — a forked child silently reverts to its fork source",
    );
    assert.equal(record.parent_session_id, "new-parent");
    assert.equal(record.spawned_by_session_id, "fork-source");
    assert.equal(record.forked_from_session_id, "fork-source");

    const entry = await readIndexEntry(homeDir, "forked-child");
    assert.equal(
      typeof entry.parentSetAt,
      "string",
      "the marker was stripped from the INDEX ENTRY",
    );
    assert.equal(entry.parentSessionId, "new-parent");
  });
});

test("PROVENANCE AFTER A STRIP: re-applying re-captures from the CURRENT parent", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "spawner-a");
    await seed(homeDir, "adopter-b");
    await seed(homeDir, "child", { parentSessionId: "spawner-a" });

    await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "adopter-b"],
      homeDir,
    );
    assert.equal((await readRecordJson(homeDir, "child")).spawned_by_session_id, "spawner-a");

    // Simulate an OUT-OF-VERSION writer: an acpx build that predates these two
    // fields drops them on parse and never writes them back. Measured directly
    // against the deployed `main` build, which strips exactly `parent_set_at` and
    // `spawned_by_session_id` while keeping `parent_session_id` / `parent_session_url`.
    const recordPath = sessionFilePath(homeDir, "child");
    const stripped = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
    delete stripped.parent_set_at;
    delete stripped.spawned_by_session_id;
    await fs.writeFile(recordPath, `${JSON.stringify(stripped, null, 2)}\n`, "utf8");

    await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "adopter-b"],
      homeDir,
    );

    // 🛑 THIS ASSERTION PINS A LIE, DELIBERATELY, AND IT IS NOT A BUG TO "FIX" HERE.
    // The edge recovers; the PROVENANCE does not. After a strip both fields are
    // absent, and absence is the ONLY signal the write-once rule has — by design,
    // because absence also legitimately means "this session was a root". Nothing on
    // the record can tell "never had provenance" from "provenance was stripped", so
    // no guard here can decide it:
    //   - refusing to capture when previousParent === newParent would break the
    //     legitimate no-op re-parent of a child that really was spawned by that
    //     parent, which is the fork-onto-its-existing-parent case;
    //   - back-filling a sentinel would destroy "was a root", which §0.2 requires.
    // THE CURE IS DEPLOYMENT ORDERING: no writer that predates these fields may
    // touch the store. This test exists so the corruption is documented and visible
    // rather than discovered again from a wrong provenance value in the field.
    assert.equal(
      (await readRecordJson(homeDir, "child")).spawned_by_session_id,
      "adopter-b",
      "if this now reads spawner-a, the write-once rule gained a way to tell the two absences apart — update this comment, it is good news",
    );
  });
});

// ─── F2 — the PRIVILEGED write path (brick c99f9994 finding F2) ──────────────

// Both exported privileged writers, by name. They set `preserveLifecycle: false`,
// so they SKIP the lifecycle preserve entirely — which is why the parent preserve
// must live OUTSIDE that branch. Enumerated here so a fifth privileged entrypoint
// added later is a visible omission from this list rather than silent coverage loss.
const PRIVILEGED_WRITERS = [
  "writeSessionRecordWithLifecycle",
  "writeSessionRecordAtBoundaryWithLifecycle",
] as const;

for (const writerName of PRIVILEGED_WRITERS) {
  test(`F2: a stale record written through ${writerName} cannot undo a re-parent`, async () => {
    await withTempHome(async (homeDir) => {
      await seed(homeDir, "old-parent");
      await seed(homeDir, "new-parent");
      await seed(homeDir, "forked-child", {
        parentSessionId: "old-parent",
        // FORKED on purpose: for a plain spawn child, losing only the MARKER leaves
        // the edge unchanged and the damage is invisible. Here the whole linkage
        // reverts, but the fork case is the one that also moves the rendered edge.
        forkedFromSessionId: "old-parent",
      });

      const persistence = await loadPersistenceModule();

      // ⚠️ THIS IS THE PRODUCTION SHAPE, MADE DETERMINISTIC — NOT A WEAKER MODEL OF
      // IT. `session-control.ts`'s closeSession reads the record at entry, then
      // waits out the ENTIRE owner-termination sequence (drain → ask the owner to
      // close → SIGTERM, grace, SIGKILL, grace → terminate the adapter) before
      // writing what it read. Measured window ≥2 s, and it GROWS with how long the
      // owner takes to die — widest exactly when a handover is most likely. The
      // staleness is the fixture here so the test is not a race-timed flake; the
      // reachability was proven separately by the test-engineer.
      const recordReadBeforeTheReparent = await persistence.resolveSessionRecord("forked-child");
      assert.equal(recordReadBeforeTheReparent.parentSessionId, "old-parent");

      const moved = await runCli(
        [
          "claude",
          "sessions",
          "set-parent",
          "--session-id",
          "forked-child",
          "--parent-id",
          "new-parent",
        ],
        homeDir,
      );
      assert.equal(moved.code, 0, moved.stderr);

      // …and now the close lands, writing the record it read seconds ago.
      recordReadBeforeTheReparent.pid = undefined;
      recordReadBeforeTheReparent.closed = true;
      recordReadBeforeTheReparent.closedAt = new Date().toISOString();
      await persistence[writerName](recordReadBeforeTheReparent);

      const record = await readRecordJson(homeDir, "forked-child");
      assert.equal(
        record.parent_session_id,
        "new-parent",
        `${writerName} reverted the parent — the preserve is inside the preserveLifecycle branch again`,
      );
      assert.equal(typeof record.parent_set_at, "string", "the marker was reverted");
      assert.equal(record.spawned_by_session_id, "old-parent", "provenance was reverted");
      // The privileged write must still do its OWN job.
      assert.equal(record.closed, true, "the close itself was suppressed — too much is preserved");

      // The index entry is what acpx-ui reads; a revert there moves the board back
      // even if the record survives.
      const entry = await readIndexEntry(homeDir, "forked-child");
      assert.equal(entry.parentSessionId, "new-parent");
      assert.equal(typeof entry.parentSetAt, "string");
    });
  });
}

test("BOTH DIRECTIONS AT ONCE: the preserve beats a stale write, and set-parent beats the preserve", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "old-parent");
    await seed(homeDir, "new-parent");
    await seed(homeDir, "later-parent");
    await seed(homeDir, "child", { parentSessionId: "old-parent" });

    const persistence = await loadPersistenceModule();

    // 🛑 THESE TWO ASSERTIONS ARE IN ONE TEST DELIBERATELY. They pull in OPPOSITE
    // directions through the same seam, and each has a passing test of its own
    // elsewhere — so fixing one by breaking the other leaves the suite GREEN:
    //   • make the preserve unconditional but drop the `authoritative` gate
    //     → direction B fails, set-parent silently writes nothing (§1.2 leg b);
    //   • keep the gate but move the preserve back inside `preserveLifecycle`
    //     → direction A fails, a close in flight silently undoes a re-parent (F2).
    // Held together, neither repair can be made at the other's expense unnoticed.

    // ── DIRECTION A: disk wins over a stale privileged write ──────────────────
    const staleRecord = await persistence.resolveSessionRecord("child");
    await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "new-parent"],
      homeDir,
    );
    staleRecord.closed = true;
    staleRecord.closedAt = new Date().toISOString();
    await persistence.writeSessionRecordAtBoundaryWithLifecycle(staleRecord);
    assert.equal(
      (await readRecordJson(homeDir, "child")).parent_session_id,
      "new-parent",
      "DIRECTION A FAILED: a stale privileged write undid the re-parent",
    );

    // ── DIRECTION B: set-parent's OWN write beats that same preserve ──────────
    const second = await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "later-parent"],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);
    assert.equal(
      (await readRecordJson(homeDir, "child")).parent_session_id,
      "later-parent",
      "DIRECTION B FAILED: the preserve swallowed set-parent's own write — the verb is a silent no-op",
    );
    // Provenance stays the SPAWNER across both directions.
    assert.equal((await readRecordJson(homeDir, "child")).spawned_by_session_id, "old-parent");
  });
});

// ─── 3. Self-clobber — leg (b) ────────────────────────────────────────────────

test("set-parent on an existing on-disk record actually changes it (leg b)", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "old-parent");
    await seed(homeDir, "new-parent");
    await seed(homeDir, "child", { parentSessionId: "old-parent" });

    const before = await readRecordJson(homeDir, "child");
    assert.equal(before.parent_session_id, "old-parent");

    await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "new-parent"],
      homeDir,
    );

    // ⚠️ THIS IS THE TEST THAT FAILS IF THE PRESERVE IS ADDED AND PLAIN
    // `writeSessionRecord` IS REUSED: the write re-reads disk, the preserve puts
    // the old parent straight back, and the verb exits 0 having changed nothing.
    const after = await readRecordJson(homeDir, "child");
    assert.equal(after.parent_session_id, "new-parent");
  });
});

// ─── 4 + 5. Provenance ────────────────────────────────────────────────────────

test("spawnedBySessionId is WRITE-ONCE: after A→B→C it still reads A", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "a");
    await seed(homeDir, "b");
    await seed(homeDir, "c");
    await seed(homeDir, "child", { parentSessionId: "a" });

    await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "b"],
      homeDir,
    );
    const afterFirst = await readRecordJson(homeDir, "child");
    assert.equal(afterFirst.spawned_by_session_id, "a");

    await runCli(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "c"],
      homeDir,
    );
    const afterSecond = await readRecordJson(homeDir, "child");
    assert.equal(afterSecond.parent_session_id, "c");
    assert.equal(
      afterSecond.spawned_by_session_id,
      "a",
      "provenance must name the SPAWNER, not the previous supervisor",
    );
  });
});

test("adopting a ROOT leaves spawnedBySessionId absent — no sentinel", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "new-parent");
    await seed(homeDir, "orphan");

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "orphan",
        "--parent-id",
        "new-parent",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const record = await readRecordJson(homeDir, "orphan");
    assert.equal(record.parent_session_id, "new-parent");
    // ABSENCE MEANS "was a root". Back-filling a sentinel would make that
    // unrecoverable.
    assert.equal(record.spawned_by_session_id, undefined);
    assert.ok(!("spawned_by_session_id" in record) || record.spawned_by_session_id === undefined);

    // …and the facet warning fires, because nobody reads --help at the moment they
    // do the thing.
    const payload = parseJsonLine(result.stdout);
    const warnings = payload.warnings as string[];
    assert.ok(
      warnings.some((warning) => warning.includes("user-facing")),
      `expected a user-facing-facet warning, got ${JSON.stringify(warnings)}`,
    );
  });
});

// ─── 6. --children-of selection ───────────────────────────────────────────────

test("--children-of moves open direct children only; subagent is skipped by name", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "a");
    await seed(homeDir, "b");
    await seed(homeDir, "open-child", { parentSessionId: "a" });
    await seed(homeDir, "second-child", { parentSessionId: "a" });
    await seed(homeDir, "closed-child", { parentSessionId: "a", closed: true });
    await seed(homeDir, "subagent-child", { parentSessionId: "a", kind: "subagent" });
    await seed(homeDir, "grandchild", { parentSessionId: "open-child" });

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--children-of",
        "a",
        "--parent-id",
        "b",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = parseJsonLine(result.stdout);
    const moved = (payload.moved as Record<string, unknown>[]).map((entry) => entry.acpxRecordId);
    assert.deepEqual(
      moved.toSorted((a, b) => String(a).localeCompare(String(b))),
      ["open-child", "second-child"],
    );

    const skipped = payload.skipped as Record<string, unknown>[];
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]?.acpxRecordId, "subagent-child");
    assert.equal(skipped[0]?.code, "SUBAGENT_PARENT_IMMUTABLE");

    // A closed child is not moved and is not reported: it was never selected.
    assert.equal((await readRecordJson(homeDir, "closed-child")).parent_session_id, "a");
    // A subagent's parent is its RETENTION ANCHOR — it must be untouched on disk.
    assert.equal((await readRecordJson(homeDir, "subagent-child")).parent_session_id, "a");
    // Direct only: a grandchild keeps its own parent.
    assert.equal((await readRecordJson(homeDir, "grandchild")).parent_session_id, "open-child");
  });
});

// ─── F4 — a child TORN ACROSS THE TWO STORES ─────────────────────────────────

/**
 * Tear a session across the two stores the way a kill mid-`--children-of` does:
 * the RECORD write landed, the INDEX update did not.
 *
 * ⚠️ CONSTRUCTED DETERMINISTICALLY, NOT BY RACING A SIGKILL. The window is real but
 * small, and a race-timed fixture is a flake generator; the test-engineer already
 * proved reachability against a live batch. What must be deterministic is the STATE.
 *
 * ⚠️ AND THE TORN STATE IS THE ONLY THING THAT DISTINGUISHES THE TWO PREDICATES.
 * Record-only and union selection agree on every child whose stores agree — so a
 * fixture built from an ordinary child PASSES EITHER WAY and proves nothing at all.
 */
async function tearAcrossStores(
  homeDir: string,
  childId: string,
  recordParent: string,
): Promise<void> {
  const recordPath = sessionFilePath(homeDir, childId);
  const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
  record.parent_session_id = recordParent;
  record.parent_set_at = new Date().toISOString();
  await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  // …and the index entry is deliberately left naming the OLD parent.
}

test("F4: --children-of HEALS a child whose record arrived but whose index did not", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "old-parent");
    await seed(homeDir, "new-parent");
    await seed(homeDir, "torn-child", { parentSessionId: "old-parent" });
    await seed(homeDir, "ordinary-child", { parentSessionId: "old-parent" });
    // Materialise index.json with BOTH children under old-parent.
    await runCli(["claude", "sessions", "list", "--local"], homeDir);
    assert.equal((await readIndexEntry(homeDir, "torn-child")).parentSessionId, "old-parent");

    // The tear: record says new-parent, index still says old-parent.
    await tearAcrossStores(homeDir, "torn-child", "new-parent");

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--children-of",
        "old-parent",
        "--parent-id",
        "new-parent",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJsonLine(result.stdout);

    // BEFORE this fix the torn child was in NEITHER array and the run said ok:true.
    const moved = payload.moved as Record<string, unknown>[];
    const movedIds = new Set(moved.map((entry) => entry.acpxRecordId));
    assert.ok(
      movedIds.has("torn-child"),
      `the torn child was not moved — it is invisible again: ${result.stdout}`,
    );
    assert.ok(movedIds.has("ordinary-child"));

    // …and the heal is AUDITABLE, not indistinguishable from an ordinary move.
    const tornEntry = moved.find((entry) => entry.acpxRecordId === "torn-child");
    const divergence = tornEntry?.healedStoreDivergence as Record<string, unknown> | undefined;
    assert.ok(divergence, "a healed child must carry the two values that disagreed");
    assert.equal(divergence?.recordParentSessionId, "new-parent");
    assert.equal(divergence?.indexParentSessionId, "old-parent");
    assert.ok(
      (payload.warnings as string[]).some((warning) =>
        warning.includes("SPLIT across the two stores"),
      ),
      "the heal must be visible in warnings, not only in a nested field",
    );
    // An ordinary child must NOT be labelled as healed.
    const ordinary = moved.find((entry) => entry.acpxRecordId === "ordinary-child");
    assert.equal(ordinary?.healedStoreDivergence, undefined);

    // BOTH stores now agree.
    assert.equal((await readRecordJson(homeDir, "torn-child")).parent_session_id, "new-parent");
    assert.equal((await readIndexEntry(homeDir, "torn-child")).parentSessionId, "new-parent");
  });
});

test("F4: a torn child whose record names a THIRD session is REPORTED, never moved", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "old-parent");
    await seed(homeDir, "new-parent");
    await seed(homeDir, "third-parent");
    await seed(homeDir, "torn-child", { parentSessionId: "old-parent" });
    await runCli(["claude", "sessions", "list", "--local"], homeDir);

    // The child was already deliberately moved to a THIRD session; only its stale
    // index still calls it a child of old-parent.
    await tearAcrossStores(homeDir, "torn-child", "third-parent");

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--children-of",
        "old-parent",
        "--parent-id",
        "new-parent",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJsonLine(result.stdout);

    // 🛑 REFUSING TO GUESS IS THE POINT. Moving it would silently override a
    // COMPLETED deliberate re-parent — F4's own failure mode wearing a different
    // hat. Nothing here can tell whether the operator means the record or the index.
    assert.deepEqual(payload.moved, [], "a third-session divergence must NOT be moved");
    const diverged = payload.diverged as Record<string, unknown>[];
    assert.equal(diverged.length, 1);
    assert.equal(diverged[0]?.acpxRecordId, "torn-child");
    assert.equal(diverged[0]?.recordParentSessionId, "third-parent");
    assert.equal(diverged[0]?.indexParentSessionId, "old-parent");
    assert.ok(
      (payload.warnings as string[]).some((warning) => warning.includes("was NOT moved")),
      "a refusal that is not reported is the defect, not the refusal",
    );
    // Untouched: the deliberate move to the third session stands.
    assert.equal((await readRecordJson(homeDir, "torn-child")).parent_session_id, "third-parent");
  });
});

test("F4: set-parent writes the index entry IMMEDIATELY, not through the coalescing queue", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "parent-b");
    await seed(homeDir, "parent-c");
    await seed(homeDir, "child", { parentSessionId: "old-parent" });

    // ⚠️ GETTING THIS FIXTURE WRONG MAKES THE TEST UNABLE TO FAIL, AND MY FIRST
    // VERSION DID. The coalescing queue only throttles a file it has ALREADY
    // written in this process and written RECENTLY: `updateSessionIndexForRecordWrite`
    // takes the immediate branch when the file is membership-unknown OR when
    // `elapsed >= SCALAR_FLUSH_INTERVAL_MS` (5 s), and a first touch is both. So a
    // single set-parent flushes promptly whether or not the immediate flag exists —
    // measured: removing the flag left that version 23/23 green.
    //
    // Hence TWO writes to the SAME file from the SAME module instance, back to back:
    // the first primes `knownFiles` + `lastWrittenAt`, and only the second can be
    // throttled. This is also the shape a long-lived in-process caller (acpx-ui) has
    // and a fresh CLI process never does.
    const session = await loadSessionModule();
    await session.setSessionParent({
      target: { kind: "session", sessionId: "child" },
      parent: { id: "parent-b" },
    });
    await session.setSessionParent({
      target: { kind: "session", sessionId: "child" },
      parent: { id: "parent-c" },
    });

    // Read index.json straight off disk — NOT through an acpx API, because every
    // index read flushes the queue first (read-your-writes) and would hide exactly
    // the throttling this asserts against.
    const raw = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "sessions", "index.json"), "utf8"),
    ) as { entries?: Record<string, unknown>[] };
    const entry = (raw.entries ?? []).find((candidate) => candidate.acpxRecordId === "child");
    assert.ok(entry, "no index entry for child");
    assert.equal(
      entry?.parentSessionId,
      "parent-c",
      "the second re-parent's index write was THROTTLED — the board follows the index, and a re-parent is human-frequency, freshness-sensitive work",
    );
    // The record is not in question; only the index half is throttled.
    assert.equal((await readRecordJson(homeDir, "child")).parent_session_id, "parent-c");
  });
});

// ─── 9. Zero children is a SUCCESS ────────────────────────────────────────────

test("--children-of matching zero children exits 0 with moved: []", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "childless");
    await seed(homeDir, "b");

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--children-of",
        "childless",
        "--parent-id",
        "b",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJsonLine(result.stdout);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.moved, []);
  });
});

// ─── 7. Refusals, asserting the CODE ──────────────────────────────────────────

async function refusalCode(
  args: string[],
  homeDir: string,
): Promise<CliResult & { code2: string }> {
  const result = await runCli([...args, "--format", "json"], homeDir);
  const payload = parseJsonLine(result.stdout);
  assert.equal(payload.ok, false, `expected a refusal, got ${result.stdout}`);
  return { ...result, code2: payload.code as string };
}

test("every refusal emits its own code and exit status", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "a");
    await seed(homeDir, "b");
    await seed(homeDir, "child", { parentSessionId: "a" });
    await seed(homeDir, "grandchild", { parentSessionId: "child" });
    await seed(homeDir, "subagent-child", { parentSessionId: "a", kind: "subagent" });

    // Neither target flag.
    const noTarget = await refusalCode(
      ["claude", "sessions", "set-parent", "--parent-id", "b"],
      homeDir,
    );
    assert.equal(noTarget.code2, "USAGE");
    assert.equal(noTarget.code, 2);

    // Both target flags.
    const bothTargets = await refusalCode(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "child",
        "--children-of",
        "a",
        "--parent-id",
        "b",
      ],
      homeDir,
    );
    assert.equal(bothTargets.code2, "USAGE");

    // Both parent flags — deliberately NOT "url wins", unlike the spawn path.
    const bothParents = await refusalCode(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "child",
        "--parent-id",
        "b",
        "--parent-session-url",
        "https://atrium.example/?session=b",
      ],
      homeDir,
    );
    assert.equal(bothParents.code2, "USAGE");

    // ⚠️ NO PARENT FLAG AT ALL IS A USAGE ERROR, NEVER AN ENV-DERIVED DEFAULT.
    // The spawn path falls back to $ACPX_SESSION_URL; if set-parent did, an agent
    // with a typo'd flag would silently adopt the child ITSELF.
    const noParent = await refusalCode(
      ["claude", "sessions", "set-parent", "--session-id", "child"],
      homeDir,
    );
    assert.equal(noParent.code2, "USAGE");

    // Detach refuses BY NAME rather than arriving as a generic usage error.
    const detach = await refusalCode(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", ""],
      homeDir,
    );
    assert.equal(detach.code2, "PARENT_DETACH_UNSUPPORTED");
    assert.equal(detach.code, 2);

    // Unknown target → exit 4, so a typo cannot read as "moved nothing".
    const noSession = await refusalCode(
      ["claude", "sessions", "set-parent", "--session-id", "nope-nope", "--parent-id", "b"],
      homeDir,
    );
    assert.equal(noSession.code2, "SESSION_NOT_FOUND");
    assert.equal(noSession.code, 4);

    // --children-of against an id that does not resolve must REFUSE, not match
    // zero children and exit 0.
    const noChildrenParent = await refusalCode(
      ["claude", "sessions", "set-parent", "--children-of", "nope-nope", "--parent-id", "b"],
      homeDir,
    );
    assert.equal(noChildrenParent.code2, "SESSION_NOT_FOUND");
    assert.equal(noChildrenParent.code, 4);

    const parentNotFound = await refusalCode(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "nope-nope"],
      homeDir,
    );
    assert.equal(parentNotFound.code2, "PARENT_NOT_FOUND");
    assert.equal(parentNotFound.code, 2);

    const self = await refusalCode(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "child"],
      homeDir,
    );
    assert.equal(self.code2, "PARENT_SELF");

    // A→B→A: proposing a DESCENDANT as the parent would produce a graph with no
    // root, which every walker survives by silently rendering a subtree as
    // unreachable — worse than an error.
    const cycle = await refusalCode(
      ["claude", "sessions", "set-parent", "--session-id", "child", "--parent-id", "grandchild"],
      homeDir,
    );
    assert.equal(cycle.code2, "PARENT_CYCLE");

    const subagent = await refusalCode(
      ["claude", "sessions", "set-parent", "--session-id", "subagent-child", "--parent-id", "b"],
      homeDir,
    );
    assert.equal(subagent.code2, "SUBAGENT_PARENT_IMMUTABLE");

    // Nothing above may have written anything.
    assert.equal((await readRecordJson(homeDir, "child")).parent_session_id, "a");
  });
});

// ─── 8. --dry-run writes nothing ──────────────────────────────────────────────

test("--dry-run writes nothing to either store, and reports the same envelope", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "a");
    await seed(homeDir, "b");
    await seed(homeDir, "child", { parentSessionId: "a" });
    // Materialise index.json first, so the byte comparison below is against a
    // real index rather than its absence.
    await runCli(["claude", "sessions", "list", "--local"], homeDir);

    const recordPath = sessionFilePath(homeDir, "child");
    const indexPath = path.join(homeDir, ".acpx", "sessions", "index.json");
    const recordBefore = await fs.readFile(recordPath, "utf8");
    const indexBefore = await fs.readFile(indexPath, "utf8");

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "child",
        "--parent-id",
        "b",
        "--dry-run",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);

    const payload = parseJsonLine(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.ok, true);
    const moved = payload.moved as Record<string, unknown>[];
    assert.equal(moved.length, 1);
    assert.equal(moved[0]?.acpxRecordId, "child");
    assert.equal(typeof moved[0]?.parentSetAt, "string");

    assert.equal(await fs.readFile(recordPath, "utf8"), recordBefore);
    assert.equal(await fs.readFile(indexPath, "utf8"), indexBefore);
  });
});

test("--dry-run text output is visibly a preview, and shows the fork override", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "a");
    await seed(homeDir, "b");
    await seed(homeDir, "forked-child", {
      parentSessionId: "a",
      forkedFromSessionId: "a",
    });

    const result = await runCli(
      ["claude", "sessions", "set-parent", "--children-of", "a", "--parent-id", "b", "--dry-run"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN — no changes written\./);
    assert.match(result.stdout, /Would re-parent 1 session\(s\) onto/);
    // Decision 1 made visible: an explicitly set parent overrides the derived fork
    // edge. This is the one behaviour a user can be surprised by, so the preview
    // shows it happening instead of leaving it to --help.
    assert.match(result.stdout, /\[fork edge → spawn\]/);
    // The caveat travels WITH the hint. It is a hand-written mirror of a rule that
    // lives in acpx-ui and has been measured wrong on a byway carrying a fork
    // source; whoever reads the label is mid-handover, which is exactly when they
    // cannot second-guess it, so `--help` alone is not where this belongs.
    assert.match(result.stdout, /advisory label and can be wrong/);
  });
});

test("no fork annotation ⇒ no advisory footnote", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "a");
    await seed(homeDir, "b");
    await seed(homeDir, "plain-child", { parentSessionId: "a" });

    const result = await runCli(
      ["claude", "sessions", "set-parent", "--children-of", "a", "--parent-id", "b", "--dry-run"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\[fork edge → spawn\]/);
    // The footnote is scoped to the hint it qualifies — printing it unconditionally
    // would train readers to skip it.
    assert.doesNotMatch(result.stdout, /advisory label and can be wrong/);
  });
});

// ─── The fork case, written ───────────────────────────────────────────────────

test("a forked child is re-parented and keeps forked_from_session_id", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "fork-source");
    await seed(homeDir, "b");
    await seed(homeDir, "forked-child", {
      parentSessionId: "fork-source",
      forkedFromSessionId: "fork-source",
    });

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "forked-child",
        "--parent-id",
        "b",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const moved = (parseJsonLine(result.stdout).moved as Record<string, unknown>[])[0];
    assert.equal(moved?.wasForkEdge, true);

    const record = await readRecordJson(homeDir, "forked-child");
    assert.equal(record.parent_session_id, "b");
    // The fork provenance is LEFT INTACT — only the graph edge moves.
    assert.equal(record.forked_from_session_id, "fork-source");
  });
});

// ─── A closed new parent warns, it does not refuse ────────────────────────────

test("a CLOSED new parent is allowed with a warning", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "a");
    await seed(homeDir, "closed-parent", { closed: true });
    await seed(homeDir, "child", { parentSessionId: "a" });

    const result = await runCli(
      [
        "claude",
        "sessions",
        "set-parent",
        "--session-id",
        "child",
        "--parent-id",
        "closed-parent",
        "--format",
        "json",
      ],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJsonLine(result.stdout);
    assert.ok((payload.warnings as string[]).includes("new parent is closed"));
    assert.equal((await readRecordJson(homeDir, "child")).parent_session_id, "closed-parent");
  });
});

// ─── The in-process API, for acpx-ui-shaped callers ───────────────────────────

test("setSessionParent is reachable from the session module and returns the envelope", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, "a");
    await seed(homeDir, "b");
    await seed(homeDir, "child", { parentSessionId: "a" });

    const session = await loadSessionModule();
    const result = await session.setSessionParent({
      target: { kind: "children-of", parentSessionId: "a" },
      parent: { id: "b" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.moved.length, 1);
    assert.equal(result.moved[0]?.acpxRecordId, "child");
    assert.equal(result.parent.crossBox, false);
    assert.equal((await readRecordJson(homeDir, "child")).parent_session_id, "b");
  });
});
