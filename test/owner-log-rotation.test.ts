import assert from "node:assert/strict";
import { closeSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OWNER_LOG_MAX_BYTES, openOwnerLogFile } from "../src/cli/session/queue-owner-process.js";

// brick 7c06a855 (TE finding F2). The owner log over 1 MB used to be TRUNCATED when
// the next owner opened it, so a few chatty adapter crashes erased every earlier
// crash stack. It is now ROTATED to `<id>.owner.log.1`.

async function withLogDir(run: (logPath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-owner-log-rot-"));
  try {
    await run(path.join(dir, "sess.owner.log"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function writeThrough(logPath: string, text: string): void {
  const fd = openOwnerLogFile(logPath);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

test("a log over the threshold is rotated: its content survives in .1, the live log starts fresh", async () => {
  await withLogDir(async (logPath) => {
    const prior = `crash stack of an earlier owner\n${"x".repeat(OWNER_LOG_MAX_BYTES)}\n`;
    await fs.writeFile(logPath, prior, "utf8");

    writeThrough(logPath, "new owner line\n");

    assert.equal(await fs.readFile(`${logPath}.1`, "utf8"), prior, "prior content kept in .1");
    assert.equal(await fs.readFile(logPath, "utf8"), "new owner line\n");
  });
});

test("a second rotation replaces the previous .1 (two generations on disk, no more)", async () => {
  await withLogDir(async (logPath) => {
    await fs.writeFile(`${logPath}.1`, "oldest generation\n", "utf8");
    const middle = `middle generation\n${"y".repeat(OWNER_LOG_MAX_BYTES)}\n`;
    await fs.writeFile(logPath, middle, "utf8");

    writeThrough(logPath, "newest\n");

    assert.equal(await fs.readFile(`${logPath}.1`, "utf8"), middle);
    assert.equal(await fs.readFile(logPath, "utf8"), "newest\n");
    const names = (await fs.readdir(path.dirname(logPath))).toSorted();
    assert.deepEqual(names, ["sess.owner.log", "sess.owner.log.1"]);
  });
});

test("negative: a log under the threshold is APPENDED to and never rotated", async () => {
  await withLogDir(async (logPath) => {
    const prior = `earlier crash stack\n${"z".repeat(OWNER_LOG_MAX_BYTES - 100)}\n`;
    await fs.writeFile(logPath, prior, "utf8");

    writeThrough(logPath, "next owner line\n");

    assert.equal(await fs.readFile(logPath, "utf8"), `${prior}next owner line\n`);
    await assert.rejects(fs.stat(`${logPath}.1`), { code: "ENOENT" }, "no .1 below the threshold");
  });
});

test("an absent log is created and nothing is rotated", async () => {
  await withLogDir(async (logPath) => {
    writeThrough(logPath, "first owner line\n");
    assert.equal(await fs.readFile(logPath, "utf8"), "first owner line\n");
    await assert.rejects(fs.stat(`${logPath}.1`), { code: "ENOENT" });
  });
});
