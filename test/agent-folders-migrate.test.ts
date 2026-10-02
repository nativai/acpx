import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import {
  migrateAgentFolders,
  type AgentFolderMigrationReport,
} from "../src/cli/session/agent-folders-migrate.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// C7 (brick 09197f03) — the FILESYSTEM migration (acceptance rows 5 and 6). Every row runs on a THROWAWAY
// tree (`withTempHome` pins HOME + ACPX_STATE_HOME to a tmp dir, and `writeSessionRecordFile` refuses a
// non-tmp store). Nothing here may touch /wisdom/Bricks, and `--apply` is NEVER run against a real pool.
//
// ⚠️ THE POPULATION BELOW IS BUILT FROM THE MEASURED SHAPE, NOT A CONVENIENT ONE. The census of the real
// pool found the `<name>-<id8>` form created 321 times and non-empty only 20 (6%), the uuid form non-empty
// 110 of 127 (87%) — so a migration keyed on `$ACPX_AGENT_FOLDER` alone would move EMPTY directories in
// ~94% of cases and strand the artifacts. The uuid form and the non-empty name form are therefore the
// POSITIVE cases here, and the empty name form is the one that must be removed rather than carried.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const BRICK_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const BRICK_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const BRICK_C = "cccccccc-0000-4000-8000-00000000000c";

// Seated sessions (and their seats).
const S1 = "11111111-1111-4111-8111-111111111111";
const SEAT1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const S2 = "22222222-2222-4222-8222-222222222222";
const SEAT2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const S5 = "55555555-5555-4555-8555-555555555555";
const SEAT5 = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
// A seat-less session (pre-backfill).
const S3 = "33333333-3333-4333-8333-333333333333";
// A seated session whose uuid-form dir is EMPTY: removed, then replaced by the link.
const S6 = "66666666-6666-4666-8666-666666666666";
const SEAT6 = "dddddddd-6666-4666-8666-dddddddddddd";
// Two sessions sharing an id8 ⇒ a name-form dir carrying it is AMBIGUOUS.
const S4A = "44444444-aaaa-4444-8444-444444444444";
const S4B = "44444444-bbbb-4444-8444-444444444444";

type Tree = { pool: string; sessionsDir: string; home: string };

async function writeFile(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
}

async function writeSeatedRecords(home: string): Promise<void> {
  const base = { agentCommand: "agent", cwd: home };
  const records: Array<[string, string | undefined, string]> = [
    [S1, SEAT1, "s1"],
    [S2, SEAT2, "s2"],
    [S5, SEAT5, "s5"],
    [S6, SEAT6, "s6"],
    [S3, undefined, "s3"],
    [S4A, "ffffffff-4444-4444-8444-44444444444a", "s4a"],
    [S4B, "ffffffff-4444-4444-8444-44444444444b", "s4b"],
  ];
  for (const [id, seatId, name] of records) {
    await writeSessionRecordFile(
      home,
      makeSessionRecord({ ...base, acpxRecordId: id, acpSessionId: `acp-${name}`, seatId, name }),
    );
  }
}

/** The measured-shape population: uuid form, non-empty name form, bare id8, empty name form, and every class that must stay untouched. */
async function buildPopulation(home: string): Promise<Tree> {
  const pool = path.join(home, "pool");
  const sessionsDir = path.join(home, ".acpx", "sessions");
  await writeSeatedRecords(home);

  const agentsA = path.join(pool, BRICK_A, "agents");
  // S1: BOTH a uuid-form and a name-form dir, with a deliberate NAME COLLISION on notes.md.
  await writeFile(path.join(agentsA, S1, "notes.md"), "uuid-form notes\n");
  await writeFile(path.join(agentsA, S1, "sub", "deep.txt"), "deep file\n");
  await writeFile(path.join(agentsA, "my-name-11111111", "notes.md"), "name-form notes\n");
  await writeFile(path.join(agentsA, "my-name-11111111", "extra.txt"), "extra\n");
  await fs.mkdir(path.join(agentsA, S6), { recursive: true });
  // S2: a bare id8 dir (non-empty) and an EMPTY name-form dir.
  await writeFile(path.join(agentsA, "22222222", "report.md"), "bare id8 report\n");
  await fs.mkdir(path.join(agentsA, "named-22222222"), { recursive: true });
  // Untouched classes.
  await writeFile(path.join(agentsA, S3, "seatless.md"), "seat-less keeps its folder\n");
  await writeFile(path.join(agentsA, "ghost-99999999", "orphan.md"), "no such session\n");
  await writeFile(
    path.join(agentsA, "x-44444444", "ambiguous.md"),
    "two sessions share 44444444\n",
  );
  await writeFile(path.join(agentsA, "README.txt"), "not a directory\n");
  await writeFile(path.join(agentsA, "scratch", "tmp.txt"), "matches no session form\n");

  // A brick that already carries a C7 seat folder from an earlier run.
  await writeFile(
    path.join(pool, BRICK_B, "agents", "aaaaaaaa", "holders", "11111111", "done.md"),
    "already migrated\n",
  );
  return { pool, sessionsDir, home };
}

type Entry = { rel: string; kind: "dir" | "file" | "link"; sha?: string; target?: string };

/** Full tree listing with a sha256 per file — what "mutates nothing" is compared against. */
async function snapshot(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isSymbolicLink()) {
        // Never followed: a link is compared by its own target string.
        out.push({ rel, kind: "link", target: await fs.readlink(full) });
      } else if (entry.isDirectory()) {
        out.push({ rel, kind: "dir" });
        await walk(full);
      } else {
        const sha = createHash("sha256")
          .update(await fs.readFile(full))
          .digest("hex");
        out.push({ rel, kind: "file", sha });
      }
    }
  }
  await walk(root);
  return out;
}

/** The multiset of file contents under a root — conserved by a migration that loses and duplicates nothing. */
async function contentMultiset(root: string): Promise<string[]> {
  return (await snapshot(root))
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.sha as string)
    .toSorted();
}

async function read(file: string): Promise<string> {
  return await fs.readFile(file, "utf8");
}

async function exists(file: string): Promise<boolean> {
  return await fs.lstat(file).then(
    () => true,
    () => false,
  );
}

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], home: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_STATE_HOME: home };
    for (const key of ["ACPX_SESSION_URL", "ACPX_SEAT_URL", "ACPX_BRICK", "ACPX_BRICK_PATH"]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, "--cwd", home, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const EXPECTED_COUNTS = {
  moved: 3, // S1 uuid form, S1 name form, S2 bare id8
  removedEmpty: 2, // named-22222222, S6's empty uuid dir
  untouchedSeatless: 1, // S3's uuid dir
  unresolved: 1, // ghost-99999999
  ambiguous: 1, // x-44444444
  other: 2, // README.txt, scratch
  alreadyC7: 1, // BRICK_B's aaaaaaaa/holders
  linked: 2, // S1's and S6's uuid-form paths become symlinks to their holder folders
  alreadyLinked: 0,
};

const SEAT1_TARGET = (pool: string) =>
  path.join(pool, BRICK_A, "agents", "aaaaaaaa", "holders", "11111111");
const SEAT2_TARGET = (pool: string) =>
  path.join(pool, BRICK_A, "agents", "bbbbbbbb", "holders", "22222222");

test("DEFAULT is a dry run: the library call mutates nothing — tree listing + every file hash identical", async () => {
  await withTempHome("acpx-c7-dry-", async (home) => {
    const tree = await buildPopulation(home);
    const before = await snapshot(home);
    assert.ok(before.length > 20, "the population did not build — the arm measured nothing");

    const report = await migrateAgentFolders({
      pool: tree.pool,
      sessionsDir: tree.sessionsDir,
      apply: false,
    });

    assert.equal(report.mode, "dry-run");
    assert.deepEqual(report.counts, EXPECTED_COUNTS);
    assert.deepEqual(await snapshot(home), before, "a dry run changed the filesystem");
    // The plan is visible without being executed.
    assert.ok(
      report.actions.some(
        (action) =>
          action.action === "move" &&
          action.from.endsWith(S1) &&
          action.to === SEAT1_TARGET(tree.pool),
      ),
      JSON.stringify(report.actions),
    );
  });
});

test("DEFAULT is a dry run: `acpx agent-folders migrate` with NO flag mutates nothing (the real CLI)", async () => {
  await withTempHome("acpx-c7-dry-cli-", async (home) => {
    const tree = await buildPopulation(home);
    const before = await snapshot(home);

    const result = await runCli(
      [
        "--format",
        "json",
        "agent-folders",
        "migrate",
        "--pool",
        tree.pool,
        "--sessions-dir",
        tree.sessionsDir,
      ],
      home,
    );
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout.trim()) as AgentFolderMigrationReport;
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(report.counts, EXPECTED_COUNTS);
    assert.deepEqual(await snapshot(home), before, "the default invocation changed the filesystem");
  });
});

test("--apply carries uuid-form, name-form and bare-id8 dirs of seated sessions, byte-for-byte (rows 5, 6)", async () => {
  await withTempHome("acpx-c7-apply-", async (home) => {
    const tree = await buildPopulation(home);
    const contentsBefore = await contentMultiset(tree.pool);

    const report = await migrateAgentFolders({
      pool: tree.pool,
      sessionsDir: tree.sessionsDir,
      apply: true,
    });
    assert.equal(report.mode, "apply");
    assert.deepEqual(report.counts, EXPECTED_COUNTS);

    const s1 = SEAT1_TARGET(tree.pool);
    // uuid form → renamed in (it sorts first), its collision-free files byte-identical.
    assert.equal(await read(path.join(s1, "notes.md")), "uuid-form notes\n");
    assert.equal(await read(path.join(s1, "sub", "deep.txt")), "deep file\n");
    // name form → merged in; the NAME COLLISION is kept under `<name>.from-<srcdir>`, never overwritten.
    assert.equal(await read(path.join(s1, "extra.txt")), "extra\n");
    assert.equal(await read(path.join(s1, "notes.md.from-my-name-11111111")), "name-form notes\n");
    // bare id8 form of S2 → carried.
    assert.equal(await read(path.join(SEAT2_TARGET(tree.pool), "report.md")), "bare id8 report\n");

    const agentsA = path.join(tree.pool, BRICK_A, "agents");
    // Sources are gone (row 6: no non-empty directory is left behind), the EMPTY name form is removed.
    for (const gone of ["my-name-11111111", "22222222", "named-22222222"]) {
      assert.equal(await exists(path.join(agentsA, gone)), false, `${gone} was left behind`);
    }
    // The uuid-form paths are no longer directories: each is a RELATIVE symlink to its holder folder.
    for (const [uuid, link] of [
      [S1, "aaaaaaaa/holders/11111111"],
      [S6, "dddddddd/holders/66666666"],
    ]) {
      assert.equal((await fs.lstat(path.join(agentsA, uuid))).isSymbolicLink(), true, uuid);
      assert.equal(await fs.readlink(path.join(agentsA, uuid)), link);
    }
    // Seat-less / unresolved / ambiguous / non-matching are untouched.
    assert.equal(await read(path.join(agentsA, S3, "seatless.md")), "seat-less keeps its folder\n");
    assert.equal(
      await read(path.join(agentsA, "ghost-99999999", "orphan.md")),
      "no such session\n",
    );
    assert.equal(
      await read(path.join(agentsA, "x-44444444", "ambiguous.md")),
      "two sessions share 44444444\n",
    );
    assert.equal(await read(path.join(agentsA, "README.txt")), "not a directory\n");
    assert.equal(await read(path.join(agentsA, "scratch", "tmp.txt")), "matches no session form\n");
    // Row 4: the seat-less session got NO seat path invented for it.
    assert.deepEqual(
      (await fs.readdir(agentsA)).toSorted(),
      [
        "README.txt",
        "aaaaaaaa",
        "bbbbbbbb",
        "dddddddd",
        S1,
        S3,
        S6,
        "ghost-99999999",
        "scratch",
        "x-44444444",
      ].toSorted(),
    );
    // NO ARTIFACT LOST OR DUPLICATED: the multiset of file contents is conserved exactly (the empty dir held none).
    assert.deepEqual(await contentMultiset(tree.pool), contentsBefore);
  });
});

test("a second --apply reports zero moves and zero removals and changes nothing (row 5, idempotence)", async () => {
  await withTempHome("acpx-c7-idem-", async (home) => {
    const tree = await buildPopulation(home);
    await migrateAgentFolders({ pool: tree.pool, sessionsDir: tree.sessionsDir, apply: true });
    const afterFirst = await snapshot(home);

    const second = await migrateAgentFolders({
      pool: tree.pool,
      sessionsDir: tree.sessionsDir,
      apply: true,
    });
    assert.equal(second.counts.moved, 0);
    assert.equal(second.counts.removedEmpty, 0);
    assert.deepEqual(second.actions, []);
    // The seat folders the first run created are recognised, not re-read as unresolved bare id8 dirs.
    assert.equal(second.counts.alreadyC7, EXPECTED_COUNTS.alreadyC7 + 3);
    assert.equal(second.counts.linked, 0);
    assert.equal(
      second.counts.alreadyLinked,
      2,
      "the links the first run left are recognised, not re-read",
    );
    assert.deepEqual(await snapshot(home), afterFirst, "the second --apply changed the filesystem");
  });
});

test("the real CLI: --apply then a second --apply is a no-op, and --format json carries the counts", async () => {
  await withTempHome("acpx-c7-apply-cli-", async (home) => {
    const tree = await buildPopulation(home);
    const args = (extra: string[]) => [
      "--format",
      "json",
      "agent-folders",
      "migrate",
      "--pool",
      tree.pool,
      "--sessions-dir",
      tree.sessionsDir,
      ...extra,
    ];
    const first = await runCli(args(["--apply"]), home);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    const firstReport = JSON.parse(first.stdout.trim()) as AgentFolderMigrationReport;
    assert.equal(firstReport.mode, "apply");
    assert.deepEqual(firstReport.counts, EXPECTED_COUNTS);
    assert.equal(await read(path.join(SEAT1_TARGET(tree.pool), "sub", "deep.txt")), "deep file\n");

    const afterFirst = await snapshot(home);
    const second = await runCli(args(["--apply"]), home);
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    const secondReport = JSON.parse(second.stdout.trim()) as AgentFolderMigrationReport;
    assert.equal(secondReport.counts.moved, 0);
    assert.equal(secondReport.counts.removedEmpty, 0);
    assert.deepEqual(await snapshot(home), afterFirst);
  });
});

test("merging into an EXISTING target keeps both sides: nothing overwritten, nothing dropped", async () => {
  await withTempHome("acpx-c7-merge-", async (home) => {
    const pool = path.join(home, "pool");
    const sessionsDir = path.join(home, ".acpx", "sessions");
    await writeSeatedRecords(home);
    const target = path.join(pool, BRICK_C, "agents", "eeeeeeee", "holders", "55555555");
    await writeFile(path.join(target, "keep.txt"), "already there\n");
    await writeFile(path.join(target, "notes.md"), "target notes\n");
    await writeFile(path.join(target, "dir", "inner.txt"), "target inner\n");
    const source = path.join(pool, BRICK_C, "agents", S5);
    await writeFile(path.join(source, "notes.md"), "source notes\n");
    await writeFile(path.join(source, "new.txt"), "brand new\n");
    await writeFile(path.join(source, "dir", "inner.txt"), "source inner\n");
    await writeFile(path.join(source, "dir", "more.txt"), "source more\n");
    const before = await contentMultiset(pool);

    const report = await migrateAgentFolders({ pool, sessionsDir, apply: true });
    assert.equal(report.counts.moved, 1);
    assert.equal(report.counts.linked, 1);

    assert.equal(await read(path.join(target, "keep.txt")), "already there\n");
    assert.equal(await read(path.join(target, "notes.md")), "target notes\n");
    assert.equal(await read(path.join(target, `notes.md.from-${S5}`)), "source notes\n");
    assert.equal(await read(path.join(target, "new.txt")), "brand new\n");
    assert.equal(await read(path.join(target, "dir", "inner.txt")), "target inner\n");
    assert.equal(await read(path.join(target, "dir", `inner.txt.from-${S5}`)), "source inner\n");
    assert.equal(await read(path.join(target, "dir", "more.txt")), "source more\n");
    // The source path is now the link, never a directory again.
    assert.equal(await fs.readlink(source), "eeeeeeee/holders/55555555");
    assert.deepEqual(await contentMultiset(pool), before);
  });
});

test("a pool or sessions dir that cannot be read FAILS CLOSED — an unreadable input is never a clean empty report", async () => {
  await withTempHome("acpx-c7-failclosed-", async (home) => {
    const tree = await buildPopulation(home);
    const missing = path.join(home, "no-such-pool");
    await assert.rejects(
      migrateAgentFolders({ pool: missing, sessionsDir: tree.sessionsDir, apply: false }),
      /no-such-pool/,
    );
    const result = await runCli(
      ["agent-folders", "migrate", "--pool", missing, "--sessions-dir", tree.sessionsDir],
      home,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /no-such-pool/);
  });
});

test("`agent-folders` is a REAL top-level verb: a bogus subverb is an error, never an agent prompt", async () => {
  // PROJECT.md: a verb needs BOTH registerDefaultCommands AND TOP_LEVEL_VERBS. Registered only in the
  // former, `acpx agent-folders bogus` is absorbed as an AGENT NAMED agent-folders with `bogus` as its
  // PROMPT and fails as `No acpx session found` on STDERR — so capture stderr, and assert on content.
  assert.equal(TOP_LEVEL_VERBS.has("agent-folders"), true);
  await withTempHome("acpx-c7-verb-", async (home) => {
    const bogus = await runCli(["agent-folders", "bogus"], home);
    const output = `${bogus.stdout}\n${bogus.stderr}`;
    assert.doesNotMatch(output, /No acpx session found/, output);
    assert.equal(bogus.code, 1, output);
    assert.match(output, /too many arguments|unknown command/, output);

    const help = await runCli(["agent-folders", "migrate", "--help"], home);
    assert.equal(help.code, 0, `${help.stdout}\n${help.stderr}`);
    assert.match(help.stdout, /--apply/);
    assert.match(help.stdout, /--pool/);
    assert.match(help.stdout, /--sessions-dir/);
  });
});

// C7 LINK (F3, the TE's finding): Claude keeps its system prompt as a transcript SNAPSHOT and codex never
// re-sends developer items, so a session whose primer was rendered BEFORE C7 keeps naming
// `agents/<session-uuid>/` as "Your workspace" forever while its env names the holder path. If the migration
// merely moved that directory away, the agent would `mkdir -p` it again and the split would be back.
test("a write through the OLD uuid path lands in the holder folder, and `mkdir -p` of it still works", async () => {
  await withTempHome("acpx-c7-link-", async (home) => {
    const tree = await buildPopulation(home);
    await migrateAgentFolders({ pool: tree.pool, sessionsDir: tree.sessionsDir, apply: true });
    const agentsA = path.join(tree.pool, BRICK_A, "agents");

    // What an agent holding the pre-C7 primer does: mkdir -p its named workspace, then write into it.
    await fs.mkdir(path.join(agentsA, S1), { recursive: true });
    await fs.writeFile(path.join(agentsA, S1, "late.md"), "written through the old path\n");
    assert.equal(
      await read(path.join(SEAT1_TARGET(tree.pool), "late.md")),
      "written through the old path\n",
    );
    // The empty-uuid case too: the holder folder exists (it was created for the link), so the link is not dangling.
    await fs.writeFile(path.join(agentsA, S6, "late.md"), "empty case\n");
    assert.equal(
      await read(path.join(agentsA, "dddddddd", "holders", "66666666", "late.md")),
      "empty case\n",
    );
    // No second directory ever reappears next to the seat folder.
    assert.equal((await fs.lstat(path.join(agentsA, S1))).isSymbolicLink(), true);
  });
});

test("the dry run REPORTS the links it would create, and creates none", async () => {
  await withTempHome("acpx-c7-link-dry-", async (home) => {
    const tree = await buildPopulation(home);
    const report = await migrateAgentFolders({
      pool: tree.pool,
      sessionsDir: tree.sessionsDir,
      apply: false,
    });
    assert.equal(report.counts.linked, 2);
    const links = report.actions.filter((action) => action.link === true);
    assert.deepEqual(
      links.map((action) => path.basename(action.from)).toSorted(),
      [S1, S6].toSorted(),
    );
    const agentsA = path.join(tree.pool, BRICK_A, "agents");
    assert.equal(
      (await fs.lstat(path.join(agentsA, S1))).isDirectory(),
      true,
      "the dry run replaced a directory",
    );
  });
});

test("name-form and bare-id8 dirs are carried or removed WITHOUT a link (no primer ever rendered them)", async () => {
  await withTempHome("acpx-c7-nolink-", async (home) => {
    const tree = await buildPopulation(home);
    await migrateAgentFolders({ pool: tree.pool, sessionsDir: tree.sessionsDir, apply: true });
    const agentsA = path.join(tree.pool, BRICK_A, "agents");
    for (const gone of ["my-name-11111111", "22222222", "named-22222222"]) {
      assert.equal(await exists(path.join(agentsA, gone)), false, gone);
    }
  });
});

test("a symlink that already points at the right holder is skipped (alreadyLinked); one pointing ELSEWHERE is never repointed", async () => {
  await withTempHome("acpx-c7-foreign-", async (home) => {
    const pool = path.join(home, "pool");
    const sessionsDir = path.join(home, ".acpx", "sessions");
    await writeSeatedRecords(home);
    const agents = path.join(pool, BRICK_C, "agents");
    await fs.mkdir(path.join(agents, "eeeeeeee", "holders", "55555555"), { recursive: true });
    await fs.symlink("eeeeeeee/holders/55555555", path.join(agents, S5)); // already right
    await fs.mkdir(path.join(agents, "elsewhere"), { recursive: true });
    await fs.symlink("elsewhere", path.join(agents, S1)); // foreign
    const before = await snapshot(home);

    for (const apply of [false, true]) {
      const report = await migrateAgentFolders({ pool, sessionsDir, apply });
      assert.equal(report.counts.alreadyLinked, 1, `apply=${apply}`);
      assert.equal(report.counts.linked, 0);
      assert.equal(report.counts.moved, 0);
      assert.equal(report.counts.removedEmpty, 0);
      assert.equal(report.counts.other, 1, "the foreign link is reported as other");
      assert.deepEqual(report.actions, []);
      assert.deepEqual(await snapshot(home), before, `apply=${apply} touched a link`);
    }
    assert.equal(await fs.readlink(path.join(agents, S1)), "elsewhere");
  });
});
