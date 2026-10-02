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

test("privileged write with no warrant cannot regress closed:true -> false", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-privileged-no-warrant";
    const closedAt = "2026-01-01T00:00:00.000Z";
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: `${id}-acp`,
        agentCommand: "agent",
        cwd: homeDir,
        closed: true,
        closedAt,
        lastSeq: 1,
      }),
    );

    // The stale in-memory copy a misbehaving caller of the PRIVILEGED write
    // family would be holding: closed flipped, no `reopenedAt` warrant, but
    // carrying real, unrelated state (lastSeq) the write must still deliver.
    const stale = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: "agent",
      cwd: homeDir,
      closed: false,
      lastSeq: 7,
    });

    const before = countBlocked();
    const { stderr } = await captureStderr(() => writeSessionRecordWithLifecycle(stale));
    assert.equal(countBlocked(), before + 1, "the guard must count every refusal");
    assert.match(stderr, /refused a closed:true->false write/);

    const onDisk = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
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

test("reopenSession's own warrant satisfies the guard — closed:false lands normally", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-legit-reopen";
    const closedAt = "2026-01-01T00:00:00.000Z";
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: `${id}-acp`,
        agentCommand: "agent",
        cwd: homeDir,
        closed: true,
        closedAt,
      }),
    );

    const before = countBlocked();
    const result = await reopenSession(id);
    assert.equal(result.reopened, true);
    assert.equal(countBlocked(), before, "a warranted reopen must never trip the guard");

    const onDisk = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
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
test("R2 (brick 1bfb95ed): a schema-invalid record cannot smuggle closed:false past the guard", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-r2-schema-invalid";
    const closedAt = "2026-01-01T00:00:00.000Z";

    // Phase 1 — an intact, closed record on disk.
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: id,
        acpSessionId: `${id}-acp`,
        agentCommand: "agent",
        cwd: homeDir,
        closed: true,
        closedAt,
        metadata: { brick: "laneA" },
      }),
    );

    // Phase 2 — GREEN CONTROL: a stale in-memory copy, written while disk is
    // still intact, must be corrected by the ORDINARY preserve path alone —
    // the guard's raw fallback is never even reached here.
    const staleIntact = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: "agent",
      cwd: homeDir,
      closed: false,
    });
    const beforeControl = countBlocked();
    await writeSessionRecordWithPersistedLifecycle(staleIntact, await readPersistedLifecycle(id));
    assert.equal(
      countBlocked(),
      beforeControl,
      "GREEN CONTROL FAILED: the guard's raw fallback fired on an intact record",
    );
    let onDisk = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(
      onDisk.closed,
      true,
      "CONTROL-FAILED: the ordinary preserve path alone should already hold on an intact record",
    );

    // Phase 3 — realistic on-disk corruption: a non-string `metadata` value
    // fails parseSessionRecord (and so readPersistedLifecycle) for the WHOLE
    // record. Same induced failure as repro-R2.mjs, same reason (Projects/
    // acpx-ui change-hazards: metadata is Record<string,string> only).
    const raw = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
    raw.metadata = { brick: 12345 };
    await fs.writeFile(sessionFilePath(homeDir, id), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    assert.equal(
      await readPersistedLifecycle(id),
      undefined,
      "control: the induced corruption must defeat the ordinary read, or this case proves nothing",
    );

    const staleCorrupt = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: "agent",
      cwd: homeDir,
      closed: false,
    });
    const beforeRed = countBlocked();
    // The caller's own read ALSO failed (undefined) — exactly what a real
    // queue-owner checkpoint would have gotten, per LiveSessionCheckpoint.save.
    await writeSessionRecordWithPersistedLifecycle(staleCorrupt, undefined);
    assert.equal(
      countBlocked(),
      beforeRed + 1,
      "the guard's raw fallback must catch what the ordinary read could not",
    );
    onDisk = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(onDisk.closed, true, "VERDICT: the regression Lane A reproduced must not land");
    assert.equal(onDisk.closed_at, closedAt, "the ORIGINAL closed_at must be restored");
  });
});

// NOT an integration test, DELIBERATELY. A file broken badly enough to make
// `readRawRecordClosedState`'s own JSON.parse throw (distinct from the
// schema-invalid-but-syntactically-valid case R2 exercises above) is ALSO
// broken for every other reader `writeSessionRecordWithPersistedLifecycle`'s
// pipeline touches (measured: driving this through the real write entrypoint
// throws earlier, inside `BrickOutbox.readRecord`'s own `JSON.parse` of the
// SAME bytes — a different component hitting the identical wall first). There
// is no file content that fails only MY reader; any JSON malformed enough to
// do that fails fs.readFile+JSON.parse for literally every caller, which in
// production is a bigger incident than this guard alone, and in a unit test
// just proves the wrong thing. So this tests the PRIMITIVE directly — the
// guard's own "disk unreadable, non-ENOENT, fail closed" branch is covered by
// code review plus this, not by an end-to-end repro; flagged as a named
// residual in the tester plan.
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

test("a brand-new session (no prior record) is never blocked by the guard", async () => {
  await withTempHome("acpx-test-home-", async (homeDir) => {
    resetPerfMetrics();
    const id = "guard-brand-new-session";
    const fresh = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: "agent",
      cwd: homeDir,
      closed: false,
    });
    const before = countBlocked();
    await writeSessionRecordWithLifecycle(fresh);
    assert.equal(countBlocked(), before, "record creation (ENOENT) must never engage the guard");
    const onDisk = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(onDisk.closed, false);
  });
});
