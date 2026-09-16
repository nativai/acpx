import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ARCHIVE_MANIFEST_COLUMNS,
  ARCHIVE_MANIFEST_HEADER,
  ArchiveManifestWriter,
  cleanManifestText,
  foldArchiveManifest,
  serializeManifestRow,
  type ArchiveManifestRow,
} from "../src/session/archive/manifest.js";
import { effectiveEndedAt, projectArchiveRecord } from "../src/session/archive/record-view.js";

/**
 * Cold-archive tier — `MANIFEST.tsv` (conception `archive-formats.md` §3) and the
 * end-of-life anchor (Amendment A1).
 *
 * The manifest format is FROZEN: tonight's rows must stay readable forever, and a
 * second implementation (the acpx-ui lane) parses the same file. A change here is
 * a change to a shared on-disk contract, so these assertions are deliberately
 * literal rather than derived from the code under test.
 */

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "acpx-archive-manifest-"));
}

const UUID_A = "0027b16c-7b7a-4e26-a50f-381299ff59ba";

function row(overrides: Partial<ArchiveManifestRow> = {}): ArchiveManifestRow {
  return {
    at: "2026-09-16T18:30:35.283Z",
    wave: "cli-20260916T1830Z",
    action: "archive",
    id: UUID_A,
    reason: "closed-before-2026-09-02",
    closed: "true",
    closedAt: "2026-08-20T13:15:12.321Z",
    lastUsedAt: "2026-08-20T13:07:11.734Z",
    kind: "session",
    name: "acpx-prune-te",
    brick: "a62de399-72e9-43bc-9794-d45831af4fee",
    file: `${UUID_A}.json`,
    bytes: 2551292,
    mtime: "2026-08-20T13:15:12.321Z",
    ...overrides,
  };
}

test("the header is byte-exact and frozen at 14 columns", () => {
  assert.equal(
    ARCHIVE_MANIFEST_HEADER,
    "at\twave\taction\tid\treason\tclosed\tclosed_at\tlast_used_at\tkind\tname\tbrick\tfile\tbytes\tmtime",
  );
  assert.equal(ARCHIVE_MANIFEST_HEADER.split("\t").length, ARCHIVE_MANIFEST_COLUMNS);
});

test("every row is exactly 14 columns, in the frozen order", () => {
  const columns = serializeManifestRow(row()).split("\t");
  assert.equal(columns.length, ARCHIVE_MANIFEST_COLUMNS);
  // Positional, because the format has no field names on the wire. Column 12 is
  // the one a restore renames by.
  assert.equal(columns[2], "archive");
  assert.equal(columns[3], UUID_A);
  assert.equal(columns[6], "2026-08-20T13:15:12.321Z", "col 7 is closed_at");
  assert.equal(columns[11], `${UUID_A}.json`, "col 12 is the verbatim basename");
  assert.equal(columns[12], "2551292");
});

test("clean() collapses TAB/CR/LF and truncates at 120 — and NEVER touches the file column", () => {
  assert.equal(cleanManifestText("a\tb\r\nc"), "a b c");
  assert.equal(cleanManifestText(undefined), "");
  assert.equal(cleanManifestText("x".repeat(200)).length, 120);

  // ⚠️ THE FILE COLUMN IS NOT CLEANED, BY DESIGN. A hostile filename is REFUSED
  // upstream (`isHostileFileName`) rather than escaped here, because a restore
  // reads this column back as a path — escaping it would silently break restore.
  // This asserts the absence of escaping, which is the property that makes the
  // upstream refusal load-bearing rather than belt-and-braces.
  const hostile = serializeManifestRow(row({ file: "a\tb.json" }));
  assert.equal(
    hostile.split("\t").length,
    ARCHIVE_MANIFEST_COLUMNS + 1,
    "an unescaped tab in `file` corrupts the row — which is exactly why such a name must never reach here",
  );
});

test("the header is written exactly once, even across writers", async () => {
  const dir = await tempDir();
  const first = await ArchiveManifestWriter.open(dir, "2026-09-16T18:30:35.283Z", "w1");
  await first.appendIdBlock([row()]);
  await first.close();

  const second = await ArchiveManifestWriter.open(dir, "2026-09-16T18:40:00.000Z", "w2");
  await second.appendIdBlock([row({ wave: "w2", file: `${UUID_A}.stream.ndjson` })]);
  await second.close();

  const lines = (await fs.readFile(path.join(dir, "MANIFEST.tsv"), "utf8"))
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.filter((line) => line === ARCHIVE_MANIFEST_HEADER).length, 1);
  assert.equal(lines.length, 3, "header + one row per writer");
  await fs.rm(dir, { recursive: true, force: true });
});

test("write-ahead: a row exists for a move that never completed, and --repair can find it", async () => {
  // ⚠️ THIS IS THE CONSEQUENCE OF WRITE-AHEAD, AND IT IS THE POINT OF THE ORDERING.
  // The reference one-off appended rows AFTER the renames and buffered 500 in
  // memory, so a crash mid-run left files with no manifest row — the audit trail
  // lost in the only scenario it exists for. Here the row is written and NO
  // rename follows, which is precisely the crash state; the fold must still
  // report the file as belonging in the archive so `--repair` has something to
  // act on.
  //
  // (Proving the ORDER of the two syscalls needs fault injection between them and
  // is a named gap in the testplan. This proves the property that ordering buys.)
  const dir = await tempDir();
  const writer = await ArchiveManifestWriter.open(dir, "2026-09-16T18:30:35.283Z", "cli-x");
  await writer.appendIdBlock([row({ file: `${UUID_A}.stream.ndjson` })]);
  await writer.close();

  const fold = await foldArchiveManifest(dir);
  assert.equal(fold.lastByFile.get(`${UUID_A}.stream.ndjson`)?.action, "archive");
  assert.equal(fold.totalRows, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a missing manifest folds to `absent`, never to an empty-but-present result", async () => {
  const dir = await tempDir();
  const fold = await foldArchiveManifest(dir);
  assert.equal(fold.absent, true);
  assert.equal(fold.totalRows, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("readers tolerate a wrong column count, an unknown action and a truncated final line", async () => {
  const dir = await tempDir();
  const good = serializeManifestRow(row({ file: `${UUID_A}.ok.ndjson` }));
  await fs.writeFile(
    path.join(dir, "MANIFEST.tsv"),
    // header, a good row, a short row, an unknown action, then a truncated line
    // with no trailing newline.
    `${ARCHIVE_MANIFEST_HEADER}\n${good}\nshort\trow\n${serializeManifestRow(
      row({ file: `${UUID_A}.weird.ndjson` }),
    ).replace("\tarchive\t", "\tvaporise\t")}\n2026-09-16T18:30:35.283Z\tcli-x\tarch`,
    "utf8",
  );

  const fold = await foldArchiveManifest(dir);
  assert.equal(fold.totalRows, 1, "only the well-formed row counts");
  assert.equal(fold.skippedRows, 3);
  assert.equal(fold.lastByFile.has(`${UUID_A}.ok.ndjson`), true);
  assert.equal(
    fold.lastByFile.has(`${UUID_A}.weird.ndjson`),
    false,
    "an unknown action is skipped, never folded into either branch — it must not move files",
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("🛑 the two folds run in OPPOSITE directions over the same file", async () => {
  // ⚠️ THE SINGLE MOST LIKELY THING TO BE GOT BACKWARDS LATER, which is why both
  // halves are asserted in ONE test rather than two — separated, each reads as
  // obviously right and the pairing is invisible.
  //
  //   residency   — where is this FILE now?          key: file  both actions  LAST wins
  //   end-of-life — when did this SESSION end?       key: id    archive only  FIRST wins
  const dir = await tempDir();
  const recordFile = `${UUID_A}.json`;
  const lines = [
    ARCHIVE_MANIFEST_HEADER,
    // first archive: the TRUE end of life
    serializeManifestRow(
      row({
        at: "2026-01-01T00:00:00.000Z",
        closedAt: "2025-12-31T00:00:00.000Z",
        file: recordFile,
      }),
    ),
    // restored, consulted, re-closed, archived again — `closed_at` was re-stamped
    serializeManifestRow(
      row({
        at: "2026-02-01T00:00:00.000Z",
        action: "restore",
        reason: "restore",
        closed: "",
        closedAt: "",
        lastUsedAt: "",
        kind: "",
        name: "",
        brick: "",
        file: recordFile,
      }),
    ),
    serializeManifestRow(
      row({
        at: "2026-03-01T00:00:00.000Z",
        closedAt: "2026-02-28T00:00:00.000Z",
        file: recordFile,
      }),
    ),
  ];
  await fs.writeFile(path.join(dir, "MANIFEST.tsv"), `${lines.join("\n")}\n`, "utf8");

  const fold = await foldArchiveManifest(dir);

  // RESIDENCY: last row in FILE ORDER — the final archive.
  assert.equal(fold.lastByFile.get(recordFile)?.action, "archive");
  assert.equal(fold.lastByFile.get(recordFile)?.at, "2026-03-01T00:00:00.000Z");

  // END-OF-LIFE: FIRST archive row, never overwritten by the later one.
  assert.equal(
    fold.firstArchiveById.get(UUID_A)?.closedAt,
    "2025-12-31T00:00:00.000Z",
    "latest-wins here re-sets the retention clock on every consult — the defect A1 fixes",
  );
  assert.equal(fold.lastRestoredAtById.get(UUID_A), "2026-02-01T00:00:00.000Z");
  await fs.rm(dir, { recursive: true, force: true });
});

test("effectiveEndedAt prefers the manifest's original over the record's re-stamped closed_at", () => {
  // The record now says it was closed yesterday, because someone restored it to
  // consult it and closed it again. Keying retention on that measures "when did
  // someone last CLOSE this", not "when did this session END" — so a session
  // people actually reach for never returns to the archive.
  const view = projectArchiveRecord({
    acpx_record_id: UUID_A,
    closed: true,
    closed_at: "2026-09-15T00:00:00.000Z",
    last_used_at: "2026-09-15T00:00:00.000Z",
  });
  assert.ok(view);

  assert.equal(
    effectiveEndedAt(view, { closedAt: "2025-12-31T00:00:00.000Z", lastUsedAt: "" }),
    "2025-12-31T00:00:00.000Z",
    "the manifest's immutable first value wins",
  );
  // Never archived: no manifest anchor, so the record is the only source — and
  // on a never-archived box no fold runs at all.
  assert.equal(effectiveEndedAt(view, undefined), "2026-09-15T00:00:00.000Z");
  // An archive row that carried no closed_at (a T3 entry) falls through to its
  // recorded last_used_at rather than to the record's current value.
  assert.equal(
    effectiveEndedAt(view, { closedAt: "", lastUsedAt: "2026-01-02T00:00:00.000Z" }),
    "2026-01-02T00:00:00.000Z",
  );
});

test("the record view reads snake_case — the camelCase TS type yields empty columns that typecheck", () => {
  // ⚠️ Records on disk are snake_case; `SessionRecord` and every `index.json`
  // entry are camelCase. An implementer reading only the TS types produces a
  // manifest of blanks and nothing fails.
  const view = projectArchiveRecord({
    acpx_record_id: UUID_A,
    closed: true,
    closed_at: "2026-08-20T13:15:12.321Z",
    last_used_at: "2026-08-20T13:07:11.734Z",
    agent_name: "claude",
    last_seq: 4821,
    parent_session_id: "parent-1",
    forked_from_session_id: "fork-1",
    metadata: { brick: "brick-1", byway_parent: "anchor-1" },
  });
  assert.ok(view);
  assert.equal(view.closedAt, "2026-08-20T13:15:12.321Z");
  assert.equal(view.lastUsedAt, "2026-08-20T13:07:11.734Z");
  assert.equal(view.agentName, "claude");
  assert.equal(view.lastSeq, 4821);
  assert.equal(view.brick, "brick-1");
  assert.equal(view.bywayParent, "anchor-1");
  assert.equal(view.forkedFromSessionId, "fork-1");

  // `template` is PRESENCE, not `.enabled`: a soft-retracted blueprint keeps
  // `enabled:false` so it can be rolled back, and testing truthiness archives
  // every retracted template.
  const retracted = projectArchiveRecord({
    acpx_record_id: UUID_A,
    template: { enabled: false },
  });
  assert.equal(retracted?.hasTemplate, true);

  // Not a session record at all — the live `brick-remote-links.json` shape.
  assert.equal(projectArchiveRecord({ links: [] }), undefined);
});
