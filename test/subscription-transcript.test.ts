import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  portTranscript,
  transcriptCwdHash,
  transcriptJsonlPath,
} from "../src/config/subscription-transcript.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-transcript-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("transcriptCwdHash replaces every slash with a dash", () => {
  assert.equal(transcriptCwdHash("/workspace/temp"), "-workspace-temp");
  assert.equal(transcriptCwdHash("/a/b/c"), "-a-b-c");
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
