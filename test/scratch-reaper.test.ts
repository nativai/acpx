import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tryAcquireQueueOwnerLease, releaseQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
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

// ---- F8: only a MISSING lease means gone — a lease that exists but cannot be read or parsed is UNKNOWN ----

function plantLease(sessionId: string, body: string, mode?: number): string {
  const file = queueLockFilePath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode !== undefined) {
    fs.chmodSync(file, mode);
  }
  return file;
}

test("F8 NEGATIVE: a lease that EXISTS but is unreadable (EACCES) keeps the scratch — judged by the real reaper path", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads a mode-000 file");
    return;
  }
  await withHome(async (_home, root) => {
    const dir = entry(root, "lease-eacces", 30);
    const file = plantLease("lease-eacces", '{"pid": 1}', 0o000);
    try {
      const result = await reapSessionScratch();
      assert.deepEqual(result.removed, []);
      assert.deepEqual(result.keptLiveOwner, ["acpx-lease-eacces"]);
      assert.equal(fs.existsSync(dir), true);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
});

test("F8 NEGATIVE: a lease that exists but is garbage (torn JSON, empty, wrong shape) keeps the scratch", async () => {
  await withHome(async (_home, root) => {
    const bodies = ['{"pid": 12', "", "[]", JSON.stringify({ hello: "world" })];
    for (const [index, body] of bodies.entries()) {
      const id = `lease-garbage-${index}`;
      entry(root, id, 30);
      plantLease(id, body);
    }
    const result = await reapSessionScratch();
    assert.deepEqual(result.removed, [], "no garbage lease read as 'no owner'");
    assert.equal(result.keptLiveOwner.length, bodies.length);
  });
});

test("F8: a MISSING lease is still gone — removed; and so is a well-formed lease of a dead process", async () => {
  await withHome(async (_home, root) => {
    const missing = entry(root, "lease-missing", 30);
    const dead = entry(root, "lease-dead", 30);
    const lease = await tryAcquireQueueOwnerLease("lease-dead");
    assert.ok(lease);
    const file = queueLockFilePath("lease-dead");
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete record.processIdentity;
    delete record.host;
    fs.writeFileSync(file, JSON.stringify({ ...record, pid: 999_999 }));
    const result = await reapSessionScratch();
    assert.equal(fs.existsSync(missing), false, "no lease file at all");
    assert.equal(fs.existsSync(dead), false, "a lease whose owner process is provably gone");
    assert.deepEqual(
      result.removed.toSorted((a, b) => a.localeCompare(b)),
      ["acpx-lease-dead", "acpx-lease-missing"],
    );
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

// ---- F3: every unknown argument is refused with exit 2 BEFORE anything is judged or removed ----

function runVerb(
  home: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_POD_TEST_HOME: home };
  delete env.ACPX_STATE_HOME;
  return spawnSync(process.execPath, [CLI, "__scratch-reap", ...args], { env, encoding: "utf8" });
}

function fingerprintTree(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).toSorted((a, b) => a.localeCompare(b))) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      parts.push(
        `${path.relative(dir, full)}:${stat.mtimeMs}:${stat.isDirectory() ? "d" : fs.readFileSync(full, "utf8")}`,
      );
      if (stat.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return parts.join("\n");
}

test("F3: `--dry-run`, an invented flag, a stray word and a malformed --max-age-days all exit 2 and the planted scratch is byte-identical", async () => {
  await withHome(async (home, root) => {
    entry(root, "must-survive-flags", 40); // old, no owner: a real reap WOULD remove it
    const before = fingerprintTree(root);
    for (const args of [
      ["--dry-run"],
      ["--invented-flag"],
      ["--dry-run", "--max-age-days", "1"],
      ["--max-age-days", "1", "--dry-run"],
      ["stray-word"],
      ["--max-age-days"],
      ["--max-age-days", "0"],
      ["--max-age-days", "abc"],
      ["--max-age-days=", ""],
      ["--max-age-days", "1", "--max-age-days", "2"],
      ["-n"],
    ]) {
      const ran = runVerb(home, args);
      assert.equal(
        ran.status,
        2,
        `${JSON.stringify(args)} → exit ${ran.status}; stdout=${ran.stdout}`,
      );
      assert.equal(ran.stdout, "", "no JSON result: nothing was judged");
      assert.match(ran.stderr, /usage: acpx __scratch-reap/u);
    }
    assert.equal(fingerprintTree(root), before, "nothing was touched");
  });
});

test("F3: the accepted forms still work — no argument, `--max-age-days <n>`, `--max-age-days=<n>` — with the one-line JSON contract", async () => {
  await withHome(async (home, root) => {
    entry(root, "twenty-days", 20);
    const young = runVerb(home, ["--max-age-days=30"]);
    assert.equal(young.status, 0, young.stderr);
    assert.deepEqual(JSON.parse(young.stdout), {
      removed: [],
      keptLiveOwner: [],
      keptYoung: ["acpx-twenty-days"],
      skipped: [],
    });
    assert.equal(young.stdout.trim().split("\n").length, 1, "ONE JSON line");
    const reaped = runVerb(home, ["--max-age-days", "10"]);
    assert.equal(reaped.status, 0, reaped.stderr);
    assert.deepEqual((JSON.parse(reaped.stdout) as { removed: string[] }).removed, [
      "acpx-twenty-days",
    ]);
    assert.equal(runVerb(home, []).status, 0);
  });
});

// ---- O-R2: the lease is re-read just before each removal ----

test("O-R2: an owner that starts between the judgement and the removal keeps its scratch (counted under keptLiveOwner)", async () => {
  await withHome(async (_home, root) => {
    const dir = entry(root, "owner-starts", 30);
    const result = await reapSessionScratch({
      ownerState: owner({}), // judged gone: no owner yet
      betweenJudgeAndRemove: async (id) => {
        plantLease(id, JSON.stringify({ pid: process.pid, started: "just now" }));
      },
    });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.keptLiveOwner, ["acpx-owner-starts"]);
    assert.equal(fs.existsSync(dir), true);
  });
});

test("O-R2: a lease REWRITTEN in the window (a dead owner's lease replaced by a fresh one) keeps the scratch too", async () => {
  await withHome(async (_home, root) => {
    const dir = entry(root, "owner-replaced", 30);
    plantLease("owner-replaced", JSON.stringify({ pid: 999_999 }));
    const result = await reapSessionScratch({
      ownerState: owner({}),
      betweenJudgeAndRemove: async (id) => {
        plantLease(id, JSON.stringify({ pid: process.pid, generation: "new owner" }));
      },
    });
    assert.deepEqual(result.keptLiveOwner, ["acpx-owner-replaced"]);
    assert.equal(fs.existsSync(dir), true);
  });
});

test("O-R2 NEGATIVE CONTROL: with the lease unchanged across the window the same entry IS removed", async () => {
  await withHome(async (_home, root) => {
    const dir = entry(root, "nothing-changes", 30);
    let called = 0;
    const result = await reapSessionScratch({
      ownerState: owner({}),
      betweenJudgeAndRemove: async () => {
        called += 1;
      },
    });
    assert.equal(called, 1, "the window really was exercised");
    assert.deepEqual(result.removed, ["acpx-nothing-changes"]);
    assert.equal(fs.existsSync(dir), false);
  });
});
