// brick://1d1cd13a — the guarantees of the shared temp-HOME teardown, proved with
// REAL processes and a REAL filesystem: no mock stands in for the reap, the /proc
// reads or the removal.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OWNER_TAG_ENV } from "./owner-reaper.js";
import { removeTempHome, removeTempHomeSync, withTempHome } from "./temp-home.js";

// A child that keeps writing into `<home>/.acpx/sessions` — the shape of the detached
// `__queue-owner` and `models --warm` children that raced the base teardown.
const WRITER_SOURCE = [
  "const fs = require('node:fs');",
  "const home = process.argv[1];",
  "const dir = home + '/.acpx/sessions';",
  "let n = 0;",
  "setInterval(() => {",
  "  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/f' + (n++ % 50), 'x'); } catch {}",
  "}, 5);",
].join("\n");

// A child that writes nothing and just stays alive: used where the question is
// only whether the teardown KILLED it.
const IDLE_SOURCE = "setInterval(() => {}, 1000);";

type Spawned = { child: ChildProcess; pid: number; exited: Promise<void> };

/** Spawn `source` the way the CLI spawns its daemons: detached (own process group),
 *  stdio ignored, HOME set explicitly, everything else inherited — INCLUDING this
 *  file's `ACPX_TEST_OWNER_TAG` unless `env` overrides it. */
function spawnHomeChild(source: string, home: string, env: NodeJS.ProcessEnv = {}): Spawned {
  const child = spawn(process.execPath, ["-e", source, home], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HOME: home, ...env },
  });
  const pid = child.pid;
  assert.ok(pid !== undefined, "child failed to spawn");
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  return { child, pid, exited };
}

async function exitsWithin(spawned: Spawned, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      spawned.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`pid ${String(spawned.pid)} still alive after ${String(ms)}ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitUntilWriting(home: string): Promise<void> {
  await waitFor(
    () => existsSync(path.join(home, ".acpx", "sessions", "f0")),
    "the writer's 1st file",
  );
}

/** Always-run safety net: kills a child this test started, by its OWN pid. */
function killOwn(spawned: Spawned): void {
  try {
    process.kill(-spawned.pid, "SIGKILL");
  } catch {
    try {
      process.kill(spawned.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function newHome(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("teardown reaps a tagged child that keeps writing into the home, then removes it (async)", async () => {
  const home = newHome("acpx-temphome-a-");
  const writer = spawnHomeChild(WRITER_SOURCE, home);
  try {
    await waitUntilWriting(home);
    assert.ok(isAlive(writer.pid), "control: the writer is alive before the teardown");

    await removeTempHome(home);

    assert.equal(existsSync(home), false, "the home is gone and was not recreated by the writer");
    await exitsWithin(writer, 5_000);
    assert.equal(isAlive(writer.pid), false, "the writer was reaped");
  } finally {
    killOwn(writer);
    rmSync(home, { recursive: true, force: true });
  }
});

test("teardown reaps a tagged child that keeps writing into the home (sync twin)", async () => {
  const home = newHome("acpx-temphome-a-sync-");
  const writer = spawnHomeChild(WRITER_SOURCE, home);
  try {
    await waitUntilWriting(home);
    removeTempHomeSync(home);
    assert.equal(existsSync(home), false);
    await exitsWithin(writer, 5_000);
  } finally {
    killOwn(writer);
    rmSync(home, { recursive: true, force: true });
  }
});

test("withTempHome: a writer started inside the body is reaped by the teardown and the pinned env is restored", async () => {
  const before = { home: process.env.HOME, state: process.env.ACPX_STATE_HOME };
  let writer: Spawned | undefined;
  let seenHome = "";
  try {
    await withTempHome(
      "acpx-temphome-with-",
      async (home) => {
        seenHome = home;
        assert.equal(process.env.HOME, home);
        assert.equal(process.env.ACPX_STATE_HOME, home);
        writer = spawnHomeChild(WRITER_SOURCE, home);
        await waitUntilWriting(home);
      },
      { pin: ["HOME", "ACPX_STATE_HOME"] },
    );
    assert.equal(existsSync(seenHome), false);
    assert.ok(writer !== undefined);
    await writer.exited;
    assert.equal(process.env.HOME, before.home);
    assert.equal(process.env.ACPX_STATE_HOME, before.state);
  } finally {
    if (writer !== undefined) {
      killOwn(writer);
    }
  }
});

test("SAFETY: a different tag, a different HOME, and a name-prefix sibling all survive; a HOME / STATE_HOME under the home is reaped", async () => {
  const home = newHome("acpx-temphome-b-");
  const otherHome = newHome("acpx-temphome-b-other-");
  // `<home>-sibling` shares the NAME PREFIX of `<home>` but is not inside it: the
  // "/" boundary in the path match is what keeps it alive.
  const siblingHome = `${home}-sibling`;
  mkdirSync(siblingHome);
  // A fixture may give the CLI `<root>/home` and `<root>/state` (message-ledger.test.ts):
  // such a child holds the root being removed and MUST be reaped.
  mkdirSync(path.join(home, "home"));
  mkdirSync(path.join(home, "state"));
  const underHome = spawnHomeChild(IDLE_SOURCE, path.join(home, "home"));
  const underState = spawnHomeChild(IDLE_SOURCE, otherHome, {
    ACPX_STATE_HOME: path.join(home, "state"),
  });
  const sibling = spawnHomeChild(IDLE_SOURCE, siblingHome);
  const foreignTag = spawnHomeChild(IDLE_SOURCE, home, {
    [OWNER_TAG_ENV]: "acpxtest.not-ours.some-other-file.1.abcdef",
  });
  const otherHomeSameTag = spawnHomeChild(IDLE_SOURCE, otherHome);
  const tagged = spawnHomeChild(IDLE_SOURCE, home);
  try {
    await waitFor(
      () => [foreignTag, otherHomeSameTag, sibling].every((child) => isAlive(child.pid)),
      "children up",
    );

    await removeTempHome(home);

    // Positive control: the child the match DOES select is gone — otherwise "the
    // others survived" would also be true of a teardown that reaped nothing.
    await Promise.all([tagged.exited, underHome.exited, underState.exited]);
    assert.equal(isAlive(tagged.pid), false, "control: the tagged child at this HOME was reaped");
    assert.equal(isAlive(underHome.pid), false, "HOME=<home>/home is under the home: reaped");
    assert.equal(
      isAlive(underState.pid),
      false,
      "ACPX_STATE_HOME=<home>/state is under it: reaped",
    );
    assert.equal(isAlive(sibling.pid), true, "<home>-sibling is NOT inside <home>: must survive");

    assert.equal(isAlive(foreignTag.pid), true, "a different ACPX_TEST_OWNER_TAG must survive");
    assert.equal(isAlive(otherHomeSameTag.pid), true, "a different HOME must survive");
  } finally {
    killOwn(foreignTag);
    killOwn(otherHomeSameTag);
    killOwn(tagged);
    killOwn(underHome);
    killOwn(underState);
    killOwn(sibling);
    await Promise.all([
      foreignTag.exited,
      otherHomeSameTag.exited,
      tagged.exited,
      underHome.exited,
      underState.exited,
      sibling.exited,
    ]);
    rmSync(siblingHome, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(otherHome, { recursive: true, force: true });
    assert.equal(isAlive(foreignTag.pid), false, "cleanup killed our own foreign-tag child");
    assert.equal(isAlive(otherHomeSameTag.pid), false, "cleanup killed our own other-HOME child");
  }
});

const RUNNING_AS_ROOT = process.getuid?.() === 0;

test(
  "a home that cannot be removed throws naming the directory, what is left and who holds it — never silence",
  {
    skip: RUNNING_AS_ROOT
      ? "root ignores directory permissions, so this failure cannot be made honestly"
      : false,
  },
  async () => {
    const home = newHome("acpx-temphome-c-");
    // An unreapable holder: same HOME, NO tag of this file. The teardown must not
    // touch it, and must name it in the failure.
    const stranger = spawnHomeChild(IDLE_SOURCE, home, {
      [OWNER_TAG_ENV]: "acpxtest.not-ours.some-other-file.1.abcdef",
    });
    const locked = path.join(home, "locked");
    mkdirSync(locked);
    writeFileSync(path.join(locked, "stuck.txt"), "x");
    // A read-only directory cannot have entries unlinked: a persistent, real,
    // cheap failure — not a mocked fs.
    chmodSync(locked, 0o500);
    try {
      await waitFor(() => isAlive(stranger.pid), "stranger up");
      await assert.rejects(removeTempHome(home, { maxRetries: 2, retryDelayMs: 5 }), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(home), `names the directory: ${error.message}`);
        assert.ok(
          error.message.includes("locked/stuck.txt"),
          `lists what is left: ${error.message}`,
        );
        assert.ok(
          error.message.includes(`pid=${String(stranger.pid)} comm=node`),
          `names the holder's pid and comm: ${error.message}`,
        );
        assert.ok(error.cause instanceof Error, "carries the underlying fs error as its cause");
        return true;
      });
      assert.equal(isAlive(stranger.pid), true, "the unreapable holder was not killed");
      assert.equal(
        existsSync(path.join(locked, "stuck.txt")),
        true,
        "nothing was hidden or half-removed",
      );
    } finally {
      killOwn(stranger);
      await stranger.exited;
      chmodSync(locked, 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  "withTempHome: a throwing body is not masked by a failing teardown — both are reported",
  { skip: RUNNING_AS_ROOT ? "root ignores directory permissions" : false },
  async () => {
    let locked = "";
    let home = "";
    try {
      await assert.rejects(
        withTempHome(
          "acpx-temphome-d-",
          async (tempHome) => {
            home = tempHome;
            locked = path.join(tempHome, "locked");
            mkdirSync(locked);
            writeFileSync(path.join(locked, "stuck.txt"), "x");
            chmodSync(locked, 0o500);
            throw new Error("the test body's own failure");
          },
          { removal: { maxRetries: 1, retryDelayMs: 5 } },
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes("the test body's own failure"), error.message);
          assert.ok(error.message.includes("could not remove"), error.message);
          return true;
        },
      );
    } finally {
      if (locked !== "") {
        chmodSync(locked, 0o700);
      }
      if (home !== "") {
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);
