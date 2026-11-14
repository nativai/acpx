import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  loadOrRebuildSessionIndex,
  readSessionIndex,
  reconcileSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// T22 (P3a §1.7): `atrium_os*` is projected onto the session index entry as `atriumOs`, verbatim, on BOTH
// index legs — a field missing from the parse leg is stripped from every untouched entry on the next
// rewrite of ANY other session. Shaped like session-index-principal.test.ts.

const OS: Record<string, string> = {
  atrium_os: "/workspace/projects/os/wt",
  atrium_os_revision: "0123456789abcdef0123456789abcdef01234567",
  atrium_os_fallback: "2026-11-14T20:00:00.000Z",
  atrium_os_primer_error: "2026-11-14T20:00:00.000Z exited with code 1",
};

function osRecord(
  id: string,
  metadata: Record<string, string> | undefined,
  lastUsedAt = "2026-06-01T00:00:00.000Z",
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "agent",
    cwd: "/tmp/atrium-os",
    lastUsedAt,
    metadata,
  });
}

async function withSessionDir<T>(run: (sessionDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-atrium-os-"));
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

test("toSessionIndexEntry projects exactly the atrium_os* metadata, verbatim", () => {
  const entry = toSessionIndexEntry(
    osRecord("os-1", { brick: "b", principal_via: "none", ...OS, worktree_path: "/w" }),
    "os-1.json",
  );
  assert.deepEqual(entry.atriumOs, OS);
});

test("a default session gets no atriumOs, and near-miss keys never leak in", () => {
  const without = toSessionIndexEntry(osRecord("os-2", { brick: "b" }), "os-2.json");
  assert.equal(without.atriumOs, undefined);
  assert.equal(JSON.stringify(without).includes('"atriumOs"'), false);
  const nearMiss = toSessionIndexEntry(
    osRecord("os-3", { Atrium_os: "/x", not_atrium_os: "/x", atrium: "/x" }),
    "os-3.json",
  );
  assert.equal(nearMiss.atriumOs, undefined);
});

test("atriumOs round-trips index.json write → parseIndexEntry → rewrite byte-identically", async () => {
  await withSessionDir(async (sessionDir) => {
    const entry = toSessionIndexEntry(osRecord("os-5", OS), "os-5.json");
    await writeSessionIndex(sessionDir, { files: ["os-5.json"], entries: [entry] });
    const firstBytes = await fs.readFile(path.join(sessionDir, "index.json"), "utf8");
    assert.ok(firstBytes.includes('"atriumOs"'), "atriumOs reached index.json");
    const parsed = await readSessionIndex(sessionDir);
    assert.deepEqual(parsed?.entries[0]?.atriumOs, OS);
    await writeSessionIndex(sessionDir, {
      files: parsed?.files ?? [],
      entries: parsed?.entries ?? [],
    });
    assert.equal(await fs.readFile(path.join(sessionDir, "index.json"), "utf8"), firstBytes);
  });
});

test("T22 an untouched entry keeps atriumOs through another session's reconcile rewrite (the parse leg)", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = osRecord("os-a", OS);
    const fileA = await writeRecordFile(sessionDir, a);
    // A marker the on-disk record lacks: incremental reconcile writes the entry back AS PARSED, so the
    // marker AND atriumOs survive only through parseIndexEntry.
    const markedA = { ...toSessionIndexEntry(a, fileA), agentName: "marker-not-on-disk" };
    await writeSessionIndex(sessionDir, { files: [fileA], entries: [markedA] });
    const b = osRecord("os-b", undefined, "2026-06-02T00:00:00.000Z");
    const fileB = await writeRecordFile(sessionDir, b);

    const { index, drift } = await reconcileSessionIndex(sessionDir);
    assert.equal(drift, true);
    await writeSessionIndex(sessionDir, index);

    const reread = await readSessionIndex(sessionDir);
    const entryA = reread?.entries.find((entry) => entry.file === fileA);
    assert.equal(
      entryA?.agentName,
      "marker-not-on-disk",
      "positive control: A was not re-projected",
    );
    assert.deepEqual(entryA?.atriumOs, OS);
    assert.equal(reread?.entries.find((entry) => entry.file === fileB)?.atriumOs, undefined);
  });
});

test("a full index rebuild projects atriumOs from the record on disk (the projection leg)", async () => {
  await withSessionDir(async (sessionDir) => {
    const fileWith = await writeRecordFile(
      sessionDir,
      osRecord("os-r1", { atrium_os: OS.atrium_os }),
    );
    const fileWithout = await writeRecordFile(
      sessionDir,
      osRecord("os-r2", { brick: "b" }, "2026-06-02T00:00:00.000Z"),
    );
    const index = await loadOrRebuildSessionIndex(sessionDir);
    assert.deepEqual(index.entries.find((entry) => entry.file === fileWith)?.atriumOs, {
      atrium_os: OS.atrium_os,
    });
    assert.equal(index.entries.find((entry) => entry.file === fileWithout)?.atriumOs, undefined);
  });
});
