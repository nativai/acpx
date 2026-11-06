import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withInheritedWorktree } from "../src/cli/session/inherited-metadata.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  loadOrRebuildSessionIndex,
  readSessionIndex,
  reconcileSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
  type SessionIndexEntry,
} from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// brick 45917618 §5.8 (TEST-PLAN G23): the three flat `worktree_*` metadata strings atrium writes
// at create are projected onto the index entry as `worktree: {path, branch, repo}` on BOTH index
// legs — a field missing from the parse leg is stripped from every untouched entry on the next
// rewrite of ANY other session. Shaped like session-index-started-by.test.ts.

const WORKTREE_METADATA = {
  worktree_path: "/workspace/projects/demo/feat-x",
  worktree_branch: "feat-x",
  worktree_repo: "/workspace/projects/demo",
};
const WORKTREE = {
  path: "/workspace/projects/demo/feat-x",
  branch: "feat-x",
  repo: "/workspace/projects/demo",
};

function worktreeRecord(
  id: string,
  metadata: Record<string, string> | undefined,
  lastUsedAt = "2026-11-06T00:00:00.000Z",
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "agent",
    cwd: "/workspace",
    lastUsedAt,
    metadata,
  });
}

async function withSessionDir<T>(run: (sessionDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-worktree-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeRecordFile(sessionDir: string, record: SessionRecord): Promise<string> {
  const fileName = `${encodeURIComponent(record.acpxRecordId)}.json`;
  await fs.writeFile(
    path.join(sessionDir, fileName),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
    "utf8",
  );
  return fileName;
}

test("toSessionIndexEntry projects the three worktree_* keys as worktree {path, branch, repo}", () => {
  const entry = toSessionIndexEntry(
    worktreeRecord("wt-1", { brick: "b", ...WORKTREE_METADATA }),
    "wt-1.json",
  );
  assert.deepEqual(entry.worktree, WORKTREE);
});

test("no worktree unless ALL three keys are present", () => {
  for (const missing of Object.keys(WORKTREE_METADATA)) {
    const metadata: Record<string, string> = { ...WORKTREE_METADATA };
    delete metadata[missing];
    const entry = toSessionIndexEntry(worktreeRecord(`wt-${missing}`, metadata), "x.json");
    assert.equal(entry.worktree, undefined, `missing ${missing}`);
  }
  const none = toSessionIndexEntry(worktreeRecord("wt-none", undefined), "wt-none.json");
  assert.equal(none.worktree, undefined);
  assert.equal(JSON.stringify(none).includes('"worktree"'), false);
});

test("worktree round-trips index.json write → parseIndexEntry → rewrite byte-identically", async () => {
  await withSessionDir(async (sessionDir) => {
    const entry = toSessionIndexEntry(worktreeRecord("wt-5", WORKTREE_METADATA), "wt-5.json");
    await writeSessionIndex(sessionDir, { files: ["wt-5.json"], entries: [entry] });
    const firstBytes = await fs.readFile(path.join(sessionDir, "index.json"), "utf8");
    assert.ok(firstBytes.includes('"worktree"'), "worktree reached index.json");

    const parsed = await readSessionIndex(sessionDir);
    assert.ok(parsed);
    assert.deepEqual(parsed.entries[0]?.worktree, WORKTREE);

    await writeSessionIndex(sessionDir, { files: parsed.files, entries: parsed.entries });
    const secondBytes = await fs.readFile(path.join(sessionDir, "index.json"), "utf8");
    assert.equal(secondBytes, firstBytes);
  });
});

test("parseIndexEntry drops a worktree with a non-string or missing member, or a non-object", async () => {
  await withSessionDir(async (sessionDir) => {
    const good = toSessionIndexEntry(worktreeRecord("wt-6", WORKTREE_METADATA), "wt-6.json");
    const variants: Array<[string, unknown]> = [
      ["wt-7.json", { ...WORKTREE, branch: 7 }],
      ["wt-8.json", { path: WORKTREE.path, branch: WORKTREE.branch }],
      ["wt-9.json", "/workspace/projects/demo/feat-x"],
    ];
    const entries = [
      good,
      ...variants.map(
        ([file, worktree]) =>
          ({ ...good, file, acpxRecordId: file, worktree }) as unknown as SessionIndexEntry,
      ),
    ];
    await writeSessionIndex(sessionDir, { files: entries.map((e) => e.file), entries });
    const parsed = await readSessionIndex(sessionDir);
    assert.ok(parsed, "index still parses");
    const byFile = new Map(parsed.entries.map((entry) => [entry.file, entry]));
    assert.deepEqual(byFile.get("wt-6.json")?.worktree, WORKTREE);
    for (const [file] of variants) {
      assert.equal(byFile.get(file)?.worktree, undefined, file);
    }
  });
});

test("an untouched entry keeps worktree through an incremental reconcile rewrite", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = worktreeRecord("wt-a", WORKTREE_METADATA);
    const fileA = await writeRecordFile(sessionDir, a);
    // The marker proves entry A was written back AS PARSED (not re-projected from disk), so
    // its worktree survives only through parseIndexEntry.
    const markedA = { ...toSessionIndexEntry(a, fileA), agentName: "marker-not-on-disk" };
    await writeSessionIndex(sessionDir, { files: [fileA], entries: [markedA] });

    const b = worktreeRecord("wt-b", undefined, "2026-11-07T00:00:00.000Z");
    const fileB = await writeRecordFile(sessionDir, b);

    const { index, drift } = await reconcileSessionIndex(sessionDir);
    assert.equal(drift, true);
    await writeSessionIndex(sessionDir, index);

    const reread = await readSessionIndex(sessionDir);
    assert.ok(reread);
    const entryA = reread.entries.find((entry) => entry.file === fileA);
    const entryB = reread.entries.find((entry) => entry.file === fileB);
    assert.equal(entryA?.agentName, "marker-not-on-disk");
    assert.deepEqual(entryA?.worktree, WORKTREE);
    assert.equal(entryB?.worktree, undefined);
  });
});

test("a full index rebuild (index.json deleted) projects worktree from the record on disk", async () => {
  await withSessionDir(async (sessionDir) => {
    const fileWith = await writeRecordFile(sessionDir, worktreeRecord("wt-r1", WORKTREE_METADATA));
    const fileWithout = await writeRecordFile(
      sessionDir,
      worktreeRecord("wt-r2", { brick: "b" }, "2026-11-07T00:00:00.000Z"),
    );
    const index = await loadOrRebuildSessionIndex(sessionDir);
    assert.deepEqual(index.entries.find((entry) => entry.file === fileWith)?.worktree, WORKTREE);
    assert.equal(index.entries.find((entry) => entry.file === fileWithout)?.worktree, undefined);
  });
});

test("carry rule: a copy/successor inherits the source's worktree_* keys unless it names its own", () => {
  assert.deepEqual(withInheritedWorktree({ a: "1" }, { ...WORKTREE_METADATA, brick: "b" }), {
    a: "1",
    ...WORKTREE_METADATA,
  });
  assert.deepEqual(withInheritedWorktree(undefined, WORKTREE_METADATA), WORKTREE_METADATA);
  // The caller's own key wins and no source key is mixed in (never a half-inherited triple).
  assert.deepEqual(withInheritedWorktree({ worktree_path: "/elsewhere" }, WORKTREE_METADATA), {
    worktree_path: "/elsewhere",
  });
  // Negative case: a source without worktree keys adds nothing (and no other source key leaks).
  assert.equal(withInheritedWorktree(undefined, { brick: "b" }), undefined);
  assert.deepEqual(withInheritedWorktree({ a: "1" }, { brick: "b" }), { a: "1" });
});
