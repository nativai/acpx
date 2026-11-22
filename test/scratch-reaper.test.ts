import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tryAcquireQueueOwnerLease, releaseQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { reapSessionScratch, type ScratchOwnerState } from "../src/session/scratch-reaper.js";
import { removeTempHome } from "./temp-home.js";

// block A8, TE finding F7 (TEST-PLAN AC-9.3): the 14-day scratch reaper "removes only what it may".

const DAY = 24 * 60 * 60 * 1000;
const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const SAVED = ["HOME", "ACPX_STATE_HOME", "ACPX_POD_TEST_HOME"].map(
  (name) => [name, process.env[name]] as const,
);

function restoreEnv(): void {
  for (const [name, value] of SAVED) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function withHome<T>(
  run: (home: string, root: string) => Promise<T> | T,
  place: "control" | "agent-pod" = "control",
): Promise<T> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-reaper-")));
  if (place === "agent-pod") {
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-reaper\n");
  }
  process.env.HOME = home;
  delete process.env.ACPX_STATE_HOME;
  process.env.ACPX_POD_TEST_HOME = home;
  const root = path.join(home, ".acpx", "session-tmp");
  fs.mkdirSync(root, { recursive: true });
  try {
    return await run(home, root);
  } finally {
    restoreEnv();
    await removeTempHome(home);
  }
}

/** A scratch entry `acpx-<id>` with one file, EVERYTHING in it `ageDays` old. */
function entry(root: string, id: string, ageDays: number): string {
  const dir = path.join(root, `acpx-${id}`);
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sub", "attachment.txt"), "x");
  const when = new Date(Date.now() - ageDays * DAY);
  for (const target of [path.join(dir, "sub", "attachment.txt"), path.join(dir, "sub"), dir]) {
    fs.utimesSync(target, when, when);
  }
  return dir;
}

const owner = (states: Record<string, ScratchOwnerState>) => async (id: string) =>
  states[id] ?? "gone";

test("old with NO live owner is removed", async () => {
  await withHome(async (_home, root) => {
    const dir = entry(root, "dead-old", 15);
    const result = await reapSessionScratch({ ownerState: owner({}) });
    assert.deepEqual(result.removed, ["acpx-dead-old"]);
    assert.equal(fs.existsSync(dir), false);
  });
});

test("NEGATIVE: old with a LIVE owner is kept — and an owner that cannot be told from here counts as live", async () => {
  await withHome(async (_home, root) => {
    const live = entry(root, "live-old", 30);
    const unknown = entry(root, "unknown-old", 30);
    const result = await reapSessionScratch({
      ownerState: owner({ "live-old": "live", "unknown-old": "unknown" }),
    });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      result.keptLiveOwner.toSorted((a, b) => a.localeCompare(b)),
      ["acpx-live-old", "acpx-unknown-old"],
    );
    assert.equal(fs.existsSync(live) && fs.existsSync(unknown), true);
  });
});

test("NEGATIVE: young is kept — and so is an old directory with ONE young file anywhere beneath it", async () => {
  await withHome(async (_home, root) => {
    const young = entry(root, "young", 3);
    const touched = entry(root, "touched", 30);
    fs.writeFileSync(path.join(touched, "sub", "fresh.txt"), "just now");
    const result = await reapSessionScratch({ ownerState: owner({}) });
    assert.deepEqual(result.removed, []);
    assert.equal(result.keptYoung.length, 2);
    assert.equal(fs.existsSync(young) && fs.existsSync(touched), true);
  });
});

test("the window is the argument: 14 days by default, and 13.9 days is not old", async () => {
  await withHome(async (_home, root) => {
    entry(root, "edge-young", 13.9);
    entry(root, "edge-old", 14.1);
    const result = await reapSessionScratch({ ownerState: owner({}) });
    assert.deepEqual(result.removed, ["acpx-edge-old"]);
    assert.deepEqual(result.keptYoung, ["acpx-edge-young"]);
  });
});

test("NEGATIVE: a symlink named acpx-<id> is never followed, and a stray file or foreign name is left", async () => {
  await withHome(async (home, root) => {
    const precious = path.join(home, "precious");
    fs.mkdirSync(precious);
    fs.writeFileSync(path.join(precious, "keep.txt"), "x");
    const old = new Date(Date.now() - 40 * DAY);
    fs.utimesSync(path.join(precious, "keep.txt"), old, old);
    fs.utimesSync(precious, old, old);
    fs.symlinkSync(precious, path.join(root, "acpx-linked"));
    fs.writeFileSync(path.join(root, "acpx-afile"), "x");
    fs.mkdirSync(path.join(root, "not-ours"));
    fs.utimesSync(path.join(root, "not-ours"), old, old);
    const result = await reapSessionScratch({ ownerState: owner({}) });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(
      result.skipped.toSorted((a, b) => a.localeCompare(b)),
      ["acpx-afile", "acpx-linked", "not-ours"],
    );
    assert.equal(fs.existsSync(path.join(precious, "keep.txt")), true);
  });
});

test("the owner is judged by the REAL lease as everywhere else: a live lease keeps an old entry, no lease removes it", async () => {
  await withHome(async (_home, root) => {
    const withOwner = entry(root, "owned-session", 30);
    const orphan = entry(root, "orphan-session", 30);
    const lease = await tryAcquireQueueOwnerLease("owned-session");
    assert.ok(lease, "this process holds a real lease");
    try {
      const result = await reapSessionScratch();
      assert.deepEqual(result.removed, ["acpx-orphan-session"]);
      assert.equal(fs.existsSync(withOwner), true, "the live owner's scratch is kept");
      assert.equal(fs.existsSync(orphan), false);
    } finally {
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("NEVER in an agent pod: it refuses control_pod_only and removes nothing", async () => {
  await withHome(async (_home, root) => {
    const dir = entry(root, "old-in-pod", 40);
    await assert.rejects(reapSessionScratch({ ownerState: owner({}) }), {
      detailCode: "control_pod_only",
    });
    assert.equal(fs.existsSync(dir), true);
  }, "agent-pod");
});

test("`acpx __scratch-reap` prints the result as JSON on the control pod, and exits 2 in an agent pod", async () => {
  await withHome(async (home, root) => {
    entry(root, "verb-old", 20);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_POD_TEST_HOME: home };
    delete env.ACPX_STATE_HOME;
    const ran = spawnSync(process.execPath, [CLI, "__scratch-reap"], { env, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual((JSON.parse(ran.stdout) as { removed: string[] }).removed, ["acpx-verb-old"]);
  });
  await withHome(async (home, root) => {
    const dir = entry(root, "verb-pod", 20);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_POD_TEST_HOME: home };
    delete env.ACPX_STATE_HOME;
    const ran = spawnSync(process.execPath, [CLI, "__scratch-reap"], { env, encoding: "utf8" });
    assert.equal(ran.status, 2, ran.stdout);
    assert.match(ran.stderr, /REFUSED reason=control_pod_only/u);
    assert.equal(fs.existsSync(dir), true);
  }, "agent-pod");
});
