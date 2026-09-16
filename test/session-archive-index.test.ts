import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ARCHIVE_INDEX_SCHEMA,
  buildArchiveIndexEntry,
  listArchiveIndexShardKeys,
  mutateArchiveIndexShard,
  readArchiveIndexShard,
  shardKeyForArchivedAt,
  writeArchiveIndexShard,
  type ArchiveIndexEntry,
} from "../src/session/archive/archive-index.js";
import { findClobbers, moveFileSet, statFileSet } from "../src/session/archive/move.js";
import { isDetachedArchiveDir, sessionArchiveDirFor } from "../src/session/archive/paths.js";

/**
 * Cold-archive tier — the `ARCHIVE-INDEX/<YYYY-MM>.json` shards (formats §4) and
 * the move primitives (§6).
 *
 * The shard index is a CACHE, never truth — the files are truth. Every read path
 * must behave correctly with the whole directory deleted: degraded, never wrong.
 */

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "acpx-archive-index-"));
}

const AT = "2026-09-16T18:30:35.283Z";

function entry(id: string, overrides: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry {
  return buildArchiveIndexEntry({
    id,
    archivedAt: AT,
    reason: "closed-before-2026-09-02",
    wave: "cli-20260916T1830Z",
    files: 6,
    bytes: 2551292,
    ...overrides,
  });
}

test("🛑 AC-11 is ENTRY-identity: two rebuilds agree on `.entries`, and the FILE differs by design", async () => {
  // ⚠️ AC-11 originally demanded a "byte-identical file", which cannot hold: §4.2
  // mandates a per-run `generatedAt`. RULED: AC-11 was the defective side and
  // `generatedAt` stays (it is diagnostically useful precisely because the shard
  // is a cache). Assert determinism over CONTENT. A whole-file comparison here is
  // WRONG and reads as a FAIL against correct code — this test encodes that so a
  // later reader cannot reintroduce it.
  const dir = await tempDir();
  const entries = [entry("b-id"), entry("a-id"), entry("c-id")];

  await writeArchiveIndexShard(dir, "2026-09", entries, AT);
  const first = await fs.readFile(path.join(dir, "ARCHIVE-INDEX", "2026-09.json"), "utf8");

  // Same input, different order, different generatedAt — i.e. a rebuild.
  await writeArchiveIndexShard(
    dir,
    "2026-09",
    [...entries].toReversed(),
    "2026-09-16T19:00:00.000Z",
  );
  const second = await fs.readFile(path.join(dir, "ARCHIVE-INDEX", "2026-09.json"), "utf8");

  const entriesOf = (payload: string): string =>
    JSON.stringify((JSON.parse(payload) as { entries: unknown }).entries);
  assert.equal(entriesOf(first), entriesOf(second), "entries must be identical across rebuilds");
  assert.notEqual(first, second, "the whole file differs — by design, via generatedAt");
  await fs.rm(dir, { recursive: true, force: true });
});

test("the sort is a TOTAL order — `archivedAt` alone is not, since one run shares one `at`", () => {
  // Every id archived by a single run carries that run's `at` by construction, so
  // without the `id` tiebreak two rebuilds of the same input can differ.
  const same = [entry("c-id"), entry("a-id"), entry("b-id")];
  const sortedIds = (input: ArchiveIndexEntry[]): string[] => {
    const cloned = [...input].toSorted(
      (a, b) => b.archivedAt.localeCompare(a.archivedAt) || a.id.localeCompare(b.id),
    );
    return cloned.map((e) => e.id);
  };
  assert.deepEqual(sortedIds(same), ["a-id", "b-id", "c-id"]);
  assert.deepEqual(sortedIds([...same].toReversed()), ["a-id", "b-id", "c-id"]);
});

test("optional keys are OMITTED when absent, never null", () => {
  const minimal = entry("x");
  assert.equal("kind" in minimal, false);
  assert.equal("closedAt" in minimal, false);

  // ⚠️ A T3 entry is archived with `closed:false` and NO `closedAt` — archive-in-
  // place means `closed` is whatever it was, and that is what lets the UI warn
  // that restoring returns the session open-but-ownerless.
  const notClosed = entry("y", { closed: false });
  assert.equal(notClosed.closed, false);
  assert.equal("closedAt" in notClosed, false);
});

test("a corrupt shard is QUARANTINED, not deleted, and only its own month is lost", async () => {
  const dir = await tempDir();
  await writeArchiveIndexShard(dir, "2026-08", [entry("august")], AT);
  await fs.writeFile(
    path.join(dir, "ARCHIVE-INDEX", "2026-09.json"),
    '{"schema":"acpx.sess',
    "utf8",
  );

  const bad = await readArchiveIndexShard(dir, "2026-09");
  assert.equal(bad.status, "corrupt");

  // A write to the bad shard renames it aside and rebuilds from what this run knows.
  await mutateArchiveIndexShard(dir, "2026-09", { upsert: [entry("september")] }, AT);
  const names = await fs.readdir(path.join(dir, "ARCHIVE-INDEX"));
  assert.equal(
    names.some((name) => name.startsWith("2026-09.json.corrupt-")),
    true,
    "the bad shard must survive as a quarantined copy — never deleted",
  );

  // The untouched month is unaffected: per-month blast radius.
  const august = await readArchiveIndexShard(dir, "2026-08");
  assert.equal(august.status === "ok" && august.shard.entries[0].id, "august");
  await fs.rm(dir, { recursive: true, force: true });
});

test("ONE unparseable entry is dropped; the rest of the shard survives", async () => {
  // ⚠️ THE DELIBERATE DIVERGENCE FROM `index.json`. `readSessionIndex` discards
  // the ENTIRE index if any single entry fails to parse, forcing a full-store
  // re-parse — the precise cost this feature exists to remove. Do not "fix" this
  // into symmetry with it.
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, "ARCHIVE-INDEX"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "ARCHIVE-INDEX", "2026-09.json"),
    `${JSON.stringify({
      schema: ARCHIVE_INDEX_SCHEMA,
      shard: "2026-09",
      generatedAt: AT,
      entries: [entry("good"), { id: "bad", archivedAt: 12345 }],
    })}\n`,
    "utf8",
  );

  const read = await readArchiveIndexShard(dir, "2026-09");
  assert.equal(read.status, "ok");
  assert.equal(read.status === "ok" && read.droppedEntries, 1);
  assert.deepEqual(read.status === "ok" && read.shard.entries.map((e) => e.id), ["good"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a restore REMOVES the id's entry from its shard", async () => {
  const dir = await tempDir();
  await writeArchiveIndexShard(dir, "2026-09", [entry("stays"), entry("goes")], AT);
  await mutateArchiveIndexShard(dir, "2026-09", { remove: ["goes"] }, AT);
  const read = await readArchiveIndexShard(dir, "2026-09");
  assert.deepEqual(read.status === "ok" && read.shard.entries.map((e) => e.id), ["stays"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a deleted ARCHIVE-INDEX directory degrades to empty, never to an error", async () => {
  const dir = await tempDir();
  assert.deepEqual(await listArchiveIndexShardKeys(dir), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test("shards key off the UTC month of archivedAt", () => {
  assert.equal(shardKeyForArchivedAt("2026-09-16T18:30:35.283Z"), "2026-09");
  assert.equal(shardKeyForArchivedAt("2026-01-01T00:00:00.000Z"), "2026-01");
  // A month boundary in UTC, not local time.
  assert.equal(shardKeyForArchivedAt("2026-08-31T23:59:59.999Z"), "2026-08");
});

// ── move primitives ─────────────────────────────────────────────────────────────

test("🛑 the RECORD is renamed LAST — the instant it leaves, the id is archived", async () => {
  // While `<id>.json` is in the hot dir the session is coherent to every reader.
  // Moving it first would leave a record pointing at sidecars that had moved out
  // from under it — the INVISIBLE bad state. Record-last leaves the visible one
  // (listed session, truncated transcript) which `--repair` completes.
  const dir = await tempDir();
  const hot = path.join(dir, "sessions");
  const archive = path.join(dir, "sessions-archive");
  await fs.mkdir(hot, { recursive: true });
  await fs.mkdir(archive, { recursive: true });

  const id = "0027b16c-7b7a-4e26-a50f-381299ff59ba";
  const files = [`${id}.json`, `${id}.messages.ndjson`, `${id}.stream.ndjson`];
  for (const file of files) {
    await fs.writeFile(path.join(hot, file), file, "utf8");
  }

  const { moved, failed } = await moveFileSet(hot, archive, id, files);
  assert.deepEqual(failed, []);
  assert.equal(moved.at(-1), `${id}.json`, "the record must be the final rename");
  assert.equal(moved.length, 3);
  await fs.rm(dir, { recursive: true, force: true });
});

test("no-clobber: an id already at the destination is reported, never overwritten", async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, "a.json"), "x", "utf8");
  assert.deepEqual(await findClobbers(dir, ["a.json", "b.json"]), ["a.json"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("stat is taken BEFORE the rename — after it, the source is gone", async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, "a.json"), "hello", "utf8");
  const stats = await statFileSet(dir, ["a.json", "vanished.json"]);
  assert.equal(stats.length, 1, "a file that vanished between plan and apply is simply not moved");
  assert.equal(stats[0].bytes, 5);
  await fs.rm(dir, { recursive: true, force: true });
});

test("the archive dir is a sibling of whatever hot dir THIS process resolved", () => {
  // ⚠️ acpx and acpx-ui resolve the hot dir differently and that divergence is
  // deliberately unfixed. Deriving the archive from the caller's hot dir means the
  // two can never disagree about the archive MORE than they already disagree about
  // the hot dir — it inherits exactly one failure mode and adds none.
  const previous = process.env.ACPX_SESSIONS_ARCHIVE_DIR;
  delete process.env.ACPX_SESSIONS_ARCHIVE_DIR;
  try {
    assert.equal(
      sessionArchiveDirFor("/home/node/.acpx/sessions"),
      "/home/node/.acpx/sessions-archive",
    );
    assert.equal(
      isDetachedArchiveDir("/home/node/.acpx/sessions", "/home/node/.acpx/sessions-archive"),
      false,
    );
    // The override is the documented footgun: two hot dirs, one archive.
    assert.equal(isDetachedArchiveDir("/home/node/.acpx/sessions", "/elsewhere/arc"), true);
  } finally {
    if (previous == null) {
      delete process.env.ACPX_SESSIONS_ARCHIVE_DIR;
    } else {
      process.env.ACPX_SESSIONS_ARCHIVE_DIR = previous;
    }
  }
});
