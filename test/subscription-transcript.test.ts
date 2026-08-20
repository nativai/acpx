import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureTranscriptAtConfigDir,
  portTranscript,
  transcriptCwdHash,
  transcriptJsonlPath,
} from "../src/config/subscription-transcript.js";

const CWD = "/work/proj";
const ACP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Minimal transcript-bearing record for ensureTranscriptAtConfigDir. */
function transcriptRecord() {
  return { cwd: CWD, acpSessionId: ACP_ID, acpx: {} };
}

/** Isolate ensure() from any real subscription registry / ~/.claude. */
function ensureOpts(dir: string, sourceConfigDirs: string[]) {
  return {
    homeDir: dir,
    registry: { subscriptions: [] },
    sourceConfigDirs,
  };
}

/** Write a transcript JSONL whose last entry carries the given ISO timestamp. */
async function writeTranscriptAt(
  configDir: string,
  isoTimestamp: string,
  marker: string,
): Promise<string> {
  const jsonlPath = transcriptJsonlPath(configDir, CWD, ACP_ID);
  await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
  const body =
    `{"type":"user","timestamp":"2026-07-10T00:00:00.000Z","text":"first"}\n` +
    `{"type":"assistant","timestamp":"${isoTimestamp}","text":"${marker}"}\n`;
  await fs.writeFile(jsonlPath, body);
  return jsonlPath;
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function supersededSidecar(configDir: string): Promise<string | undefined> {
  const dir = path.dirname(transcriptJsonlPath(configDir, CWD, ACP_ID));
  const entries = await fs.readdir(dir);
  const sidecar = entries.find(
    (name) => name.startsWith(`${ACP_ID}.superseded-`) && name.endsWith(".jsonl"),
  );
  return sidecar ? path.join(dir, sidecar) : undefined;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-transcript-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("transcriptCwdHash replaces every character outside [A-Za-z0-9-] with a dash", () => {
  // Slash-only cwds — unchanged by the brick://ae715773 fix, and the reason the
  // bug survived so long: for these the old and new derivations agree.
  assert.equal(transcriptCwdHash("/workspace/temp"), "-workspace-temp");
  assert.equal(transcriptCwdHash("/a/b/c"), "-a-b-c");

  // The characters the old derivation dropped. Pinned against Claude Code's real
  // behaviour by the live probes in test/transcript-cwd-slug.test.ts — that file
  // is the authority; these are the fast regression guard.
  assert.equal(transcriptCwdHash("/w/p/.bare"), "-w-p--bare");
  assert.equal(transcriptCwdHash("/w/p/v1.2.3"), "-w-p-v1-2-3");
  assert.equal(transcriptCwdHash("/w/p/under_score"), "-w-p-under-score");
  assert.equal(transcriptCwdHash("/w/p/multi..dots"), "-w-p-multi--dots");

  // Preserved: case, digits, and an existing hyphen.
  assert.equal(transcriptCwdHash("/w/Proj-2/Main"), "-w-Proj-2-Main");
});

test("transcriptJsonlPath builds <configDir>/projects/<cwdHash>/<id>.jsonl", () => {
  assert.equal(
    transcriptJsonlPath("/cfg/subA", "/workspace/temp", "abc-123"),
    path.join("/cfg/subA", "projects", "-workspace-temp", "abc-123.jsonl"),
  );
});

test("portTranscript copies the JSONL into the destination projects tree", async () => {
  await withTempDir(async (dir) => {
    const srcConfigDir = path.join(dir, "subA");
    const dstConfigDir = path.join(dir, "subB");
    const cwd = "/work/proj";
    const acpSessionId = "11111111-2222-3333-4444-555555555555";

    const src = transcriptJsonlPath(srcConfigDir, cwd, acpSessionId);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, '{"type":"user","sessionId":"x"}\n');

    const result = await portTranscript({ srcConfigDir, dstConfigDir, cwd, acpSessionId });
    assert.deepEqual(result, { copied: true });

    const dst = transcriptJsonlPath(dstConfigDir, cwd, acpSessionId);
    assert.equal(await fs.readFile(dst, "utf8"), '{"type":"user","sessionId":"x"}\n');
  });
});

test("portTranscript is overwrite-safe (idempotent re-copy)", async () => {
  await withTempDir(async (dir) => {
    const srcConfigDir = path.join(dir, "subA");
    const dstConfigDir = path.join(dir, "subB");
    const cwd = "/work/proj";
    const acpSessionId = "id-1";

    const src = transcriptJsonlPath(srcConfigDir, cwd, acpSessionId);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, "v1\n");

    await portTranscript({ srcConfigDir, dstConfigDir, cwd, acpSessionId });
    await fs.writeFile(src, "v2-newer\n");
    const result = await portTranscript({ srcConfigDir, dstConfigDir, cwd, acpSessionId });

    assert.deepEqual(result, { copied: true });
    const dst = transcriptJsonlPath(dstConfigDir, cwd, acpSessionId);
    assert.equal(await fs.readFile(dst, "utf8"), "v2-newer\n");
  });
});

test("portTranscript no-ops when the source JSONL is absent (fresh session)", async () => {
  await withTempDir(async (dir) => {
    const srcConfigDir = path.join(dir, "subA");
    const dstConfigDir = path.join(dir, "subB");
    const cwd = "/work/proj";
    const acpSessionId = "never-prompted";

    const result = await portTranscript({ srcConfigDir, dstConfigDir, cwd, acpSessionId });
    assert.deepEqual(result, { copied: false, reason: "no-source" });

    const dst = transcriptJsonlPath(dstConfigDir, cwd, acpSessionId);
    await assert.rejects(() => fs.access(dst));
  });
});

test("portTranscript no-ops when src and dst dirs are identical", async () => {
  await withTempDir(async (dir) => {
    const cwd = "/work/proj";
    const acpSessionId = "same";
    const result = await portTranscript({
      srcConfigDir: dir,
      dstConfigDir: dir,
      cwd,
      acpSessionId,
    });
    assert.deepEqual(result, { copied: false, reason: "same-dir" });
  });
});

// --- ensureTranscriptAtConfigDir: freshness selection (context-rollback fix, brick://08ac840f) ---

test("ensure: stale destination + fresher source → ported, stale dest renamed aside", async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, "subA");
    const dst = path.join(dir, "subB");
    await writeTranscriptAt(src, "2026-07-20T10:00:00.000Z", "FRESH-SOURCE");
    const dstPath = await writeTranscriptAt(dst, "2026-07-17T18:00:00.000Z", "STALE-DEST");

    const result = await ensureTranscriptAtConfigDir(
      transcriptRecord(),
      dst,
      ensureOpts(dir, [src]),
    );

    assert.equal(result.status, "ported");
    assert.equal(result.status === "ported" && result.sourceConfigDir, path.resolve(src));
    // Destination now holds the fresher source content.
    assert.match((await readIfExists(dstPath)) ?? "", /FRESH-SOURCE/);
    // The old (divergent) destination branch is preserved in a sidecar, not lost.
    const sidecar = await supersededSidecar(dst);
    assert.ok(sidecar, "expected a .superseded-*.jsonl sidecar");
    assert.equal(result.status === "ported" && result.supersededPath, sidecar);
    assert.match((await readIfExists(sidecar)) ?? "", /STALE-DEST/);
  });
});

test("ensure: destination is freshest → already-present, untouched (no rename, no port)", async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, "subA");
    const dst = path.join(dir, "subB");
    await writeTranscriptAt(src, "2026-07-17T18:00:00.000Z", "STALE-SOURCE");
    const dstPath = await writeTranscriptAt(dst, "2026-07-20T10:00:00.000Z", "FRESH-DEST");
    const before = await readIfExists(dstPath);

    const result = await ensureTranscriptAtConfigDir(
      transcriptRecord(),
      dst,
      ensureOpts(dir, [src]),
    );

    assert.equal(result.status, "already-present");
    assert.equal(await readIfExists(dstPath), before, "destination must be untouched");
    assert.equal(await supersededSidecar(dst), undefined, "no sidecar when nothing superseded");
  });
});

test("ensure: missing destination + multiple sources of mixed age → ports the FRESHEST, not first-in-order", async () => {
  await withTempDir(async (dir) => {
    const older = path.join(dir, "subA");
    const newer = path.join(dir, "subB");
    const dst = path.join(dir, "subC"); // no file — destination missing
    await writeTranscriptAt(older, "2026-07-18T09:00:00.000Z", "OLDER-SOURCE");
    await writeTranscriptAt(newer, "2026-07-20T09:00:00.000Z", "NEWER-SOURCE");

    // `older` is passed first (registry/first-in order); freshness must still win.
    const result = await ensureTranscriptAtConfigDir(
      transcriptRecord(),
      dst,
      ensureOpts(dir, [older, newer]),
    );

    assert.equal(result.status, "ported");
    assert.equal(result.status === "ported" && result.sourceConfigDir, path.resolve(newer));
    const dstPath = transcriptJsonlPath(dst, CWD, ACP_ID);
    assert.match((await readIfExists(dstPath)) ?? "", /NEWER-SOURCE/);
  });
});

test("ensure: content freshness beats mtime — stale-content dest with fresh mtime is superseded", async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, "subA");
    const dst = path.join(dir, "subB");
    // Fresh CONTENT but OLD mtime (source last touched days ago).
    const srcPath = await writeTranscriptAt(src, "2026-07-20T10:00:00.000Z", "FRESH-CONTENT");
    // Stale CONTENT but FRESH mtime — exactly the copyFile-stamped stale copy trap.
    const dstPath = await writeTranscriptAt(dst, "2026-07-17T18:00:00.000Z", "STALE-CONTENT");
    const oldTime = new Date("2026-07-17T18:00:00.000Z");
    await fs.utimes(srcPath, oldTime, oldTime);
    const nowIsh = new Date("2026-07-20T11:00:00.000Z");
    await fs.utimes(dstPath, nowIsh, nowIsh);

    const result = await ensureTranscriptAtConfigDir(
      transcriptRecord(),
      dst,
      ensureOpts(dir, [src]),
    );

    // Despite the destination's newer mtime, its stale content must be superseded.
    assert.equal(result.status, "ported");
    assert.match((await readIfExists(dstPath)) ?? "", /FRESH-CONTENT/);
    assert.ok(await supersededSidecar(dst), "stale-content dest must be superseded");
  });
});

test("ensure: unparsable-timestamp candidates fall back to mtime ordering", async () => {
  await withTempDir(async (dir) => {
    const src = path.join(dir, "subA");
    const dst = path.join(dir, "subB");
    const srcPath = transcriptJsonlPath(src, CWD, ACP_ID);
    const dstPath = transcriptJsonlPath(dst, CWD, ACP_ID);
    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.mkdir(path.dirname(dstPath), { recursive: true });
    // No parseable .timestamp anywhere → mtime is the only signal.
    await fs.writeFile(srcPath, "not-json fresher\n");
    await fs.writeFile(dstPath, "not-json staler\n");
    const staleTime = new Date("2026-07-17T18:00:00.000Z");
    const freshTime = new Date("2026-07-20T10:00:00.000Z");
    await fs.utimes(dstPath, staleTime, staleTime);
    await fs.utimes(srcPath, freshTime, freshTime);

    const result = await ensureTranscriptAtConfigDir(
      transcriptRecord(),
      dst,
      ensureOpts(dir, [src]),
    );

    assert.equal(result.status, "ported");
    assert.match((await readIfExists(dstPath)) ?? "", /fresher/);
    assert.ok(await supersededSidecar(dst), "mtime-staler dest superseded");
  });
});
