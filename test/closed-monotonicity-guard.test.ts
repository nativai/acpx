import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { reopenSession } from "../src/cli/session/session-control.js";
import { getPerfMetricsSnapshot, resetPerfMetrics } from "../src/perf-metrics.js";
import {
  readPersistedLifecycle,
  writeSessionRecordWithLifecycle,
  writeSessionRecordWithPersistedLifecycle,
} from "../src/session/persistence.js";
import { CLOSED_REGRESSION_BLOCKED_COUNTER } from "../src/session/persistence/repository.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// ---------------------------------------------------------------------------
// brick 1bfb95ed deliverable 3 — THE MONOTONICITY GUARD.
//
// Lane A's forensics (FINDINGS.md §1d/§1f) found the specimen's own write went
// through the SANCTIONED reopen route, so a guard keyed on "which verb called
// this" would not have caught it — and found the mechanism this guard DOES
// catch: `readPersistedLifecycle` swallowing a failed read into `undefined`
// silently converts a preserve-protected write into an unprotected one.
// `repro-R2.mjs` (forensics/) is that mechanism's committed reproduction
// against the real product functions; the cases below mirror its phases and
// its green control, driven through the SAME repository entrypoints a real
// caller uses — no code edit, no mutation testing.
//
// ROUND II (test-engineer / Lane C): A3, A4, A5 and the equal-case below are
// the confirmed defects in round I's comparator, which compared an
// UNVALIDATED `reopenedAt` against `closed_at` alone. On the measured
// evidence, format validation is doing more work than ordering — A3 and A4
// are both malformed-input defeats, not mis-ordered-input ones.
// ---------------------------------------------------------------------------

function countBlocked(): number {
  return getPerfMetricsSnapshot().counters[CLOSED_REGRESSION_BLOCKED_COUNTER] ?? 0;
}

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function seedRecord(
  homeDir: string,
  id: string,
  overrides: Omit<
    Parameters<typeof makeSessionRecord>[0],
    "acpxRecordId" | "acpSessionId" | "agentCommand" | "cwd"
  >,
): ReturnType<typeof makeSessionRecord> {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "agent",
    cwd: homeDir,
    ...overrides,
  });
}

async function readOnDisk(homeDir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
    string,
    unknown
  >;
}

test("privileged write with no warrant cannot regress closed:true -> false", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-privileged-no-warrant";
    const closedAt = "2026-01-01T00:00:00.000Z";
    await writeSessionRecordFile(
      homeDir,
      seedRecord(homeDir, id, { closed: true, closedAt, lastSeq: 1 }),
    );

    // The stale in-memory copy a misbehaving caller of the PRIVILEGED write
    // family would be holding: closed flipped, no `reopenedAt` warrant, but
    // carrying real, unrelated state (lastSeq) the write must still deliver.
    const stale = seedRecord(homeDir, id, { closed: false, lastSeq: 7 });

    const before = countBlocked();
    const { stderr } = await captureStderr(() => writeSessionRecordWithLifecycle(stale));
    assert.equal(countBlocked(), before + 1, "the guard must count every refusal");
    assert.match(stderr, /refused a closed:true->false write/);

    const onDisk = await readOnDisk(homeDir, id);
    assert.equal(onDisk.closed, true, "the regression must not land");
    assert.equal(
      onDisk.closed_at,
      closedAt,
      "disk's original closed_at must be restored, not dropped",
    );
    assert.equal(
      onDisk.last_seq,
      7,
      "the REST of the write — real, unrelated state — must still land",
    );
  });
});

test("A3: a malformed warrant string cannot beat a real timestamp lexicographically", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-a3-malformed-warrant";
    const closedAt = "2026-01-01T00:00:00.000Z";
    await writeSessionRecordFile(homeDir, seedRecord(homeDir, id, { closed: true, closedAt }));

    // "z" > any digit under a bare string comparison — this is the exact
    // mechanism that defeated round I's comparator (measured:
    // garbage_warrant_BEATS_mtime=true).
    const stale = seedRecord(homeDir, id, { closed: false, reopenedAt: "zzz-not-a-date" });
    const before = countBlocked();
    const { stderr } = await captureStderr(() => writeSessionRecordWithLifecycle(stale));
    assert.equal(
      countBlocked(),
      before + 1,
      "a malformed warrant must never authorize a regression",
    );
    assert.match(stderr, /refused a closed:true->false write/);

    const onDisk = await readOnDisk(homeDir, id);
    assert.equal(onDisk.closed, true);
    assert.equal(onDisk.closed_at, closedAt);
  });
});

test("A4: a non-UTC-offset warrant is rejected by FORMAT, never reached chronologically", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-a4-offset-warrant";
    const closedAt = "2026-01-01T08:00:00.000Z";
    await writeSessionRecordFile(homeDir, seedRecord(homeDir, id, { closed: true, closedAt }));

    // This string's bare-text time component ("09") sorts AFTER closedAt's
    // ("08"), which is exactly what let it through round I's comparator — but
    // its ACTUAL instant (+02:00 => 07:00Z) is BEFORE closedAt, so a correct
    // chronological read would also refuse it. Format validation refuses it
    // for a simpler reason first: it is not the exact toISOString() shape at
    // all (no literal "Z").
    const stale = seedRecord(homeDir, id, {
      closed: false,
      reopenedAt: "2026-01-01T09:00:00.000+02:00",
    });
    const before = countBlocked();
    const { stderr } = await captureStderr(() => writeSessionRecordWithLifecycle(stale));
    assert.equal(
      countBlocked(),
      before + 1,
      "an offset-bearing warrant must never authorize a regression",
    );
    assert.match(stderr, /refused a closed:true->false write/);

    const onDisk = await readOnDisk(homeDir, id);
    assert.equal(onDisk.closed, true);
  });
});

test("A5: closed:true with no closed_at falls back to the PRE-WRITE mtime, and a stale warrant is refused", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-a5-mtime-fallback";
    // Seeded WITHOUT closedAt — the shape `closed:true` with no `closed_at`
    // genuinely reaches (e.g. a record closed, reopened, closed again without
    // the intervening reopen ever being flushed to disk in between).
    await writeSessionRecordFile(homeDir, seedRecord(homeDir, id, { closed: true }));
    const seeded = await readOnDisk(homeDir, id);
    assert.equal(
      "closed_at" in seeded,
      false,
      "control: the seed must carry no closed_at, or this case proves nothing",
    );

    // Validly formatted, not future — but genuinely OLDER than the seed file's
    // own mtime (written moments ago), exactly the shape a long-stale
    // in-memory copy's warrant would have.
    const staleWarrant = new Date(Date.now() - 60_000).toISOString();
    const stale = seedRecord(homeDir, id, { closed: false, reopenedAt: staleWarrant });
    const before = countBlocked();
    const { stderr } = await captureStderr(() => writeSessionRecordWithLifecycle(stale));
    assert.equal(
      countBlocked(),
      before + 1,
      "a stale warrant must be refused even with no closed_at to compare against",
    );
    assert.match(stderr, /refused a closed:true->false write/);

    const onDisk = await readOnDisk(homeDir, id);
    assert.equal(onDisk.closed, true);
  });
});

test("the equal case (warrant === closed_at) is refused, not accepted", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-equal-case-refused";
    const closedAt = "2026-01-01T00:00:00.000Z";
    await writeSessionRecordFile(homeDir, seedRecord(homeDir, id, { closed: true, closedAt }));

    // An EXACT match, not newer — ruled explicitly: equality is not evidence
    // of a NEWER authorization.
    const stale = seedRecord(homeDir, id, { closed: false, reopenedAt: closedAt });
    const before = countBlocked();
    await writeSessionRecordWithLifecycle(stale);
    assert.equal(countBlocked(), before + 1, "an exact match must be refused — strict >, not >=");

    const onDisk = await readOnDisk(homeDir, id);
    assert.equal(onDisk.closed, true);
  });
});

test("reopenSession's own warrant satisfies the guard — closed:false lands normally", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-legit-reopen";
    const closedAt = "2026-01-01T00:00:00.000Z";
    await writeSessionRecordFile(homeDir, seedRecord(homeDir, id, { closed: true, closedAt }));

    const before = countBlocked();
    const result = await reopenSession(id);
    assert.equal(result.reopened, true);
    assert.equal(countBlocked(), before, "a warranted reopen must never trip the guard");

    const onDisk = await readOnDisk(homeDir, id);
    assert.equal(onDisk.closed, false);
    assert.equal("closed_at" in onDisk, false, "reopenSession still clears closed_at as before");
    assert.equal(
      typeof onDisk.reopened_at,
      "string",
      "the warrant must be the one thing written down",
    );
  });
});

// THE COMMITTED RED for Lane A's R2 reproduction (forensics/repro-R2.mjs),
// driven through the real repository entrypoints at the unit level. Mirrors
// R2's own phases and its GREEN CONTROL: without phase 1-2 below, a red in
// phase 3 would not distinguish "the guard was defeated" from "this write
// never protected anything in the first place".
//
// The guard now does its OWN independent read for every write (round II), so
// "control" and "red" here differ only in whether the ON-DISK bytes are
// intact or corrupted — not in which code path the guard takes.
test("R2 (brick 1bfb95ed): a schema-invalid record cannot smuggle closed:false past the guard", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-r2-schema-invalid";
    const closedAt = "2026-01-01T00:00:00.000Z";

    // Phase 1 — an intact, closed record on disk.
    await writeSessionRecordFile(
      homeDir,
      seedRecord(homeDir, id, { closed: true, closedAt, metadata: { brick: "laneA" } }),
    );

    // Phase 2 — GREEN CONTROL: a stale in-memory copy, written while disk is
    // still intact, must be corrected by the ORDINARY preserve step
    // (`applyPersistedLifecycleForWrite`, preserveLifecycle:true) — it reads
    // succeed here, restores `record.closed = true` BEFORE this guard even
    // runs, so the guard's own counter must NOT move: this phase proves the
    // specimen is actually intact, not that the guard fired.
    const staleIntact = seedRecord(homeDir, id, { closed: false });
    const beforeControl = countBlocked();
    await writeSessionRecordWithPersistedLifecycle(staleIntact, await readPersistedLifecycle(id));
    assert.equal(
      countBlocked(),
      beforeControl,
      "GREEN CONTROL FAILED: the guard fired on an intact record — it should never need to",
    );
    let onDisk = await readOnDisk(homeDir, id);
    assert.equal(
      onDisk.closed,
      true,
      "CONTROL-FAILED: the ORDINARY preserve step should already hold on an intact record",
    );

    // Phase 3 — realistic on-disk corruption: a non-string `metadata` value
    // fails parseSessionRecord (and so readPersistedLifecycle) for the WHOLE
    // record. Same induced failure as repro-R2.mjs, same reason (Projects/
    // acpx-ui change-hazards: metadata is Record<string,string> only). The
    // guard's own reader bypasses schema validation (same as deliverable 4's
    // raw reader), so it still sees the real closed:true underneath.
    const raw = await readOnDisk(homeDir, id);
    raw.metadata = { brick: 12345 };
    await fs.writeFile(sessionFilePath(homeDir, id), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    assert.equal(
      await readPersistedLifecycle(id),
      undefined,
      "control: the induced corruption must defeat the ORDINARY read, or this case proves nothing",
    );

    const staleCorrupt = seedRecord(homeDir, id, { closed: false });
    const beforeRed = countBlocked();
    // The caller's own read ALSO failed (undefined) — exactly what a real
    // queue-owner checkpoint would have gotten, per LiveSessionCheckpoint.save.
    await writeSessionRecordWithPersistedLifecycle(staleCorrupt, undefined);
    assert.equal(
      countBlocked(),
      beforeRed + 1,
      "the guard must catch what the ordinary read could not",
    );
    onDisk = await readOnDisk(homeDir, id);
    assert.equal(onDisk.closed, true, "VERDICT: the regression Lane A reproduced must not land");
    assert.equal(onDisk.closed_at, closedAt, "the ORIGINAL closed_at must be restored");
  });
});

// NOT an integration test, DELIBERATELY. A file broken badly enough to make
// JSON.parse itself throw (distinct from the schema-invalid-but-
// syntactically-valid case R2 exercises above) is ALSO broken for every
// other reader `writeSessionRecordWithPersistedLifecycle`'s pipeline touches
// (measured: driving this through the real write entrypoint throws earlier,
// inside `BrickOutbox.readRecord`'s own `JSON.parse` of the SAME bytes — a
// different component hitting the identical wall first). There is no file
// content that fails only this guard's own reader. So this tests the
// PRIMITIVE directly — the guard's own "disk unreadable, non-ENOENT, fail
// closed" branch is covered by code review plus this, not by an end-to-end
// repro; flagged as a named residual in the tester plan.
test("readRawRecordClosedState itself distinguishes ENOENT from a genuine parse failure", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    const { readRawRecordClosedState } = await import("../src/session/persistence/repository.js");
    const id = "guard-raw-reader-malformed-json";
    await fs.mkdir(path.dirname(sessionFilePath(homeDir, id)), { recursive: true });
    await fs.writeFile(sessionFilePath(homeDir, id), "{ this is not valid json", "utf8");

    await assert.rejects(
      readRawRecordClosedState(id),
      (error: unknown) =>
        !(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT",
      "a genuine parse failure must throw something OTHER than ENOENT, so the guard's catch block can tell it apart from a brand-new session",
    );
  });
});

// The SECOND permit case (L0 correction): a guard built to close a hole must
// prove what it LETS THROUGH, not only what it stops — and must stay SILENT
// doing it. A guard that reports on every ordinary new session would flood
// the one channel the refusal path depends on for signal.
test("a brand-new session (no prior record) is never blocked, and the guard stays silent", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-brand-new-session";
    const fresh = seedRecord(homeDir, id, { closed: false });
    const before = countBlocked();
    const { stderr } = await captureStderr(() => writeSessionRecordWithLifecycle(fresh));
    assert.equal(countBlocked(), before, "record creation (ENOENT) must never engage the guard");
    assert.doesNotMatch(
      stderr,
      /refused a closed:true->false write/,
      "a brand-new session must never trigger the guard's loud report",
    );
    const onDisk = await readOnDisk(homeDir, id);
    assert.equal(onDisk.closed, false);
  });
});
