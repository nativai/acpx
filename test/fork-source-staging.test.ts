import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageFile, stageLockPath, withStageLock } from "../src/acp/fork-source-staging.js";
import { resetCreateCwdWarnings, resolveCreateCwd } from "../src/cli/create-cwd.js";

// brick 45917618 §5.5 D6/D7 — the stage lock and the staging scope a cross-cwd copy runs in
// (TEST-PLAN D12/D12b serialisation, D13 a planted stale lock), plus B4 (one warning per process).

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fork-stage-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("D12: two concurrent stages of one source are serialised — the second starts after the first cleaned up", async () => {
  await withDir(async (dir) => {
    const source = path.join(dir, "source.jsonl");
    const staged = path.join(dir, "dest", "source-id.jsonl");
    await fs.writeFile(source, "SOURCE\n");
    const events: string[] = [];
    const copy = (name: string) =>
      withStageLock(
        staged,
        async (lock) => {
          const cleanup = await stageFile(source, staged, lock);
          events.push(`${name}:staged:${existsSync(staged)}`);
          await new Promise((resolve) => setTimeout(resolve, 80));
          await cleanup();
          events.push(`${name}:cleaned:${existsSync(staged)}`);
        },
        { pollMs: 10 },
      );
    await Promise.all([copy("a"), copy("b")]);
    assert.deepEqual(
      events.map((event) => event.replace(/^[ab]/, "x")),
      ["x:staged:true", "x:cleaned:false", "x:staged:true", "x:cleaned:false"],
    );
    assert.equal(existsSync(staged), false, "no stray staged copy");
    assert.equal(existsSync(stageLockPath(staged)), false, "lock released");
    assert.equal(await fs.readFile(source, "utf8"), "SOURCE\n", "source unchanged");
  });
});

test("D13: a planted stale lock (old mtime) is taken over; its leftover stage is removed by the cleanup", async () => {
  await withDir(async (dir) => {
    const source = path.join(dir, "source.jsonl");
    const staged = path.join(dir, "dest", "source-id.jsonl");
    await fs.writeFile(source, "SOURCE\n");
    // What a SIGKILLed copy leaves behind: its lock, and its staged copy.
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.writeFile(staged, "LEFTOVER FROM A KILLED COPY\n");
    await fs.writeFile(stageLockPath(staged), "{}\n");
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(stageLockPath(staged), old, old);

    const result = await withStageLock(
      staged,
      async (lock) => {
        assert.equal(lock.tookOverStale, true);
        const cleanup = await stageFile(source, staged, lock);
        assert.equal(await fs.readFile(staged, "utf8"), "SOURCE\n");
        await cleanup();
        return "proceeded";
      },
      { staleMs: 60_000, maxWaitMs: 5_000 },
    );
    assert.equal(result, "proceeded");
    assert.equal(existsSync(staged), false, "the killed copy's leftover is gone too");
    assert.equal(existsSync(stageLockPath(staged)), false);
  });
});

test("D13 negative: a LIVE (fresh) lock is not stolen — the waiter times out instead", async () => {
  await withDir(async (dir) => {
    const staged = path.join(dir, "dest", "source-id.jsonl");
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.writeFile(stageLockPath(staged), "{}\n");
    await assert.rejects(
      withStageLock(staged, async () => "ran", { staleMs: 60_000, maxWaitMs: 150, pollMs: 20 }),
      /Timed out waiting for another copy/,
    );
    assert.equal(existsSync(stageLockPath(staged)), true, "the live holder's lock is untouched");
  });
});

test("a file already at the staged path under a live (non-stale) lock is preserved by the cleanup", async () => {
  await withDir(async (dir) => {
    const source = path.join(dir, "source.jsonl");
    const staged = path.join(dir, "dest", "source-id.jsonl");
    await fs.writeFile(source, "SOURCE\n");
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.writeFile(staged, "PRE-EXISTING\n");
    await withStageLock(staged, async (lock) => {
      assert.equal(lock.tookOverStale, false);
      const cleanup = await stageFile(source, staged, lock);
      assert.equal(await fs.readFile(staged, "utf8"), "SOURCE\n");
      await cleanup();
    });
    assert.equal(await fs.readFile(staged, "utf8"), "PRE-EXISTING\n");
  });
});

test("B4: two inert --cwd creates in one process print the warning once; requestedCwd is reported both times", async () => {
  const saved = process.env.ACPX_SESSION_ROOT;
  process.env.ACPX_SESSION_ROOT = "/srv/session-root";
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    resetCreateCwdWarnings();
    const first = resolveCreateCwd({ explicitRequest: "/tmp/a", fallback: "/tmp" });
    const second = resolveCreateCwd({ explicitRequest: "/tmp/b", fallback: "/tmp" });
    assert.deepEqual(first, { cwd: "/srv/session-root", requestedCwd: "/tmp/a" });
    assert.deepEqual(second, { cwd: "/srv/session-root", requestedCwd: "/tmp/b" });
  } finally {
    (process.stderr as unknown as { write: unknown }).write = original;
    resetCreateCwdWarnings();
    if (saved === undefined) {
      delete process.env.ACPX_SESSION_ROOT;
    } else {
      process.env.ACPX_SESSION_ROOT = saved;
    }
  }
  const lines = chunks
    .join("")
    .split("\n")
    .filter((line) => line.includes("does not apply"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.startsWith("[acpx] --cwd /tmp/a does not apply to new sessions"));
});
