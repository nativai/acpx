import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "../src/types.js";
import {
  fileExists,
  makeSessionRecord,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * brick://dd4cb0e8 — `acpx sessions prune` scope-first hardening.
 *
 * These drive the REAL compiled CLI as a NON-TTY subprocess against an isolated
 * store, because that is the production shape: every agent invokes acpx from a
 * non-TTY Bash tool, and the scope refusal lives at the CLI layer. A test that
 * only called the exported `pruneSessions()` could not see any of it.
 * Core-layer selection semantics live in test/sessions-prune.test.ts.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

/** The 2026-07-24 specimen's own output filter, verbatim from its tool-call frame.
 *  The four ids are the four repro sessions it had just closed and meant to delete. */
const SPECIMEN_IDS = ["051458e5", "e600985f", "f5c00b72", "78eccb7f"];
const SPECIMEN_FILTER = new RegExp(`prune|delet|remov|repro|${SPECIMEN_IDS.join("|")}`, "i");

/** The three it destroyed without ever learning their ids. */
const BYSTANDER_IDS = ["aaaa1111", "bbbb2222", "cccc3333"];

type CliResult = { code: number | null; stdout: string; stderr: string };

/**
 * ⚠️ Pins BOTH `HOME` and `ACPX_STATE_HOME` to the SAME temp path. `sessionBaseDir()`
 * reads `process.env.ACPX_STATE_HOME || os.homedir()`, so `ACPX_STATE_HOME` WINS:
 * a harness pinning only `HOME` runs against whatever `ACPX_STATE_HOME` points at
 * while reading as isolated. These tests DELETE session records — isolation is part
 * of the test, not setup.
 */
function runCli(args: string[], homeDir: string, cwd?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-prune-scope-test-", run);
}

/**
 * `[acpx] full session-index rebuild (reason: ...)` is a pre-existing daemon
 * diagnostic emitted by the index subsystem for EVERY verb, not part of prune's
 * output surface — and it fires here only because these fixtures write records
 * without an index. Stripped so the assertions below pin prune's own lines.
 *
 * ⚠️ It is stripped by an explicit, named predicate rather than by a loose regex
 * over the whole stream: a filter that quietly swallowed prune's own lines would
 * make every assertion here vacuous.
 */
function pruneOutput(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("[acpx] "))
    .join("\n");
}

const AGENT_COMMAND = "node /opt/claude-agent-acp/dist/index.js";

function sessionDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

function messagesPath(homeDir: string, id: string): string {
  return path.join(sessionDir(homeDir), `${encodeURIComponent(id)}.messages.ndjson`);
}

function streamPath(homeDir: string, id: string): string {
  return path.join(sessionDir(homeDir), `${encodeURIComponent(id)}.stream.ndjson`);
}

type FixtureOptions = {
  closed?: boolean;
  closedAt?: string;
  name?: string;
  template?: SessionRecord["template"];
  streamBytes?: number;
};

async function seedSession(
  homeDir: string,
  id: string,
  cwd: string,
  options: FixtureOptions = {},
): Promise<void> {
  const closedAt = options.closedAt ?? "2026-07-24T04:39:56.000Z";
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord(
      {
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: AGENT_COMMAND,
        agentName: "claude",
        cwd,
        name: options.name ?? id,
        createdAt: "2026-07-24T04:30:00.000Z",
        lastUsedAt: closedAt,
        closed: options.closed ?? true,
        closedAt: (options.closed ?? true) ? closedAt : undefined,
        template: options.template,
      },
      { defaultName: false, defaultAcpx: false },
    ),
  );
  await fs.writeFile(messagesPath(homeDir, id), `sidecar for ${id}\n`, "utf8");
  if (options.streamBytes !== 0) {
    await fs.writeFile(streamPath(homeDir, id), "x".repeat(options.streamBytes ?? 32), "utf8");
  }
}

/**
 * Reproduces the 2026-07-24 specimen: four `repro-*` sessions the caller had just
 * created and could name, plus three unrelated sessions in another directory that
 * it destroyed and never identified.
 *
 * ⚠️ The work directory deliberately contains NO `repro` substring. The specimen's
 * own filter carries the literal `repro`, so a fixture path like
 * `/tmp/.../repro-32002` would make `--cwd`'s output line survive the filter by
 * ACCIDENT — a survival that vanishes on any other directory, testing nothing.
 */
async function seedSpecimen(homeDir: string): Promise<{ workCwd: string; otherCwd: string }> {
  const workCwd = path.join(homeDir, "workspace", "temp", "sweep-32002");
  const otherCwd = path.join(homeDir, "workspace", "elsewhere");
  await fs.mkdir(workCwd, { recursive: true });
  await fs.mkdir(otherCwd, { recursive: true });
  for (const id of SPECIMEN_IDS) {
    await seedSession(homeDir, id, workCwd);
  }
  for (const id of BYSTANDER_IDS) {
    await seedSession(homeDir, id, otherCwd);
  }
  return { workCwd, otherCwd };
}

async function survivingRecords(homeDir: string, ids: string[]): Promise<string[]> {
  const alive: string[] = [];
  for (const id of ids) {
    if (await fileExists(sessionFilePath(homeDir, id))) {
      alive.push(id);
    }
  }
  return alive;
}

async function survivingSidecars(homeDir: string, ids: string[]): Promise<string[]> {
  const alive: string[] = [];
  for (const id of ids) {
    if (await fileExists(messagesPath(homeDir, id))) {
      alive.push(id);
    }
  }
  return alive;
}

const ALL_IDS = [...SPECIMEN_IDS, ...BYSTANDER_IDS];

/** The operator's `2>&1 | grep -iE "..." ` — combined stream, filtered, in order. */
function throughSpecimenPipeline(result: CliResult): string[] {
  return `${result.stdout}${result.stderr}`
    .split("\n")
    .filter((line) => SPECIMEN_FILTER.test(line));
}

// ─── T1 · the crown test: the specimen replayed through its literal pipeline ──
//
// ⚠️ DO NOT SIMPLIFY THIS TEST. Its awkwardness — building the operator's real
// `grep -iE ... | head` rather than reading stdout directly — IS the point. It is
// the one check that says the 2026-07-24 incident cannot happen again the way it
// happened, and it asserts the refusal is visible THROUGH the filter that hid the
// original blast radius, not merely present in a buffer nobody's pipe delivered.
test("prune refuses the specimen's own bare invocation and destroys nothing", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(["--cwd", workCwd, "claude", "sessions", "prune"], homeDir);

    assert.equal(result.code, 2, result.stderr);
    // Nothing deleted — records AND sidecars, both of which the verb destroys.
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ALL_IDS);
    assert.deepEqual(await survivingSidecars(homeDir, ALL_IDS), ALL_IDS);

    // The refusal must survive the operator's own filter. `| head` keeps 10 lines;
    // the refusal is 9 status lines plus 2 blanks, and grep drops the blanks.
    const visible = throughSpecimenPipeline(result).slice(0, 10);
    assert.equal(
      visible[0],
      "acpx sessions prune: refusing to run unscoped — nothing was deleted.",
      "the FIRST line through the specimen's own pipeline must state the refusal",
    );
    // Both counts, at the decision point: box-wide, and here.
    assert.ok(
      visible.some((line) => line.includes("ALL 7 closed claude sessions on this box")),
      `box-wide count missing from the filtered output:\n${visible.join("\n")}`,
    );
    assert.ok(
      visible.some((line) => line.includes("# the 4 closed in ")),
      `here-count missing from the filtered output:\n${visible.join("\n")}`,
    );
    // The escape hatch is still reachable after filtering — an E3 that survives the
    // audit grep but not the operator's own pipe is half a control.
    assert.ok(
      visible.some((line) => line.includes("--whole-box")),
      `escape hatch missing from the filtered output:\n${visible.join("\n")}`,
    );
    assert.equal(visible.length, 9, `expected 9 surviving lines, got:\n${visible.join("\n")}`);
  });
});

// Positive control for T1, on the SAME fixture and the SAME harness. Without it, a
// harness pointed at an empty store, a binary that failed to build, or a fixture
// that never wrote files produces the identical clean "nothing was deleted".
test("prune --whole-box on the same fixture DOES delete all seven [T1 control]", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--whole-box"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Pruned 7 sessions/);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), []);
    assert.deepEqual(await survivingSidecars(homeDir, ALL_IDS), []);
  });
});

// ─── T2 · the guard blocks in JSON too ────────────────────────────────────────
test("prune refuses unscoped under --format json with a parseable refusal", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(
      ["--cwd", workCwd, "--format", "json", "claude", "sessions", "prune"],
      homeDir,
    );

    assert.equal(result.code, 2, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      action?: string;
      reason?: string;
      closedCandidates?: number;
      closedCandidatesInCwd?: number;
      scopes?: string[];
    };
    assert.equal(payload.action, "sessions_prune_refused");
    assert.equal(payload.reason, "scope_required");
    assert.equal(payload.closedCandidates, 7);
    assert.equal(payload.closedCandidatesInCwd, 4);
    assert.deepEqual(payload.scopes, ["<ids>", "--cwd", "--whole-box", "--older-than", "--before"]);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ALL_IDS);

    // Control: the same fixture, scoped, reports the same number as PRUNED.
    const control = await runCli(
      ["--cwd", workCwd, "--format", "json", "claude", "sessions", "prune", "--whole-box"],
      homeDir,
    );
    assert.equal(control.code, 0, control.stderr);
    const success = JSON.parse(control.stdout) as { action?: string; count?: number };
    assert.equal(success.action, "sessions_pruned");
    assert.equal(success.count, 7);
  });
});

// ─── T3 · the guard passes what it must: unscoped --dry-run ──────────────────
test("prune --dry-run needs no scope and deletes nothing", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--dry-run"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[DRY RUN\] Would prune 7 sessions/);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ALL_IDS);

    // Control for the zero-deletion claim — "the dry run deleted nothing" is also
    // true of a binary that cannot delete at all.
    const control = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--whole-box"],
      homeDir,
    );
    assert.equal(control.code, 0, control.stderr);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), []);
  });
});

// ─── T4 · age filters count as a scope and are byte-identical to before ──────
test("prune --older-than and --before still run unrefused", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "aged-out", workCwd, { closedAt: "2020-01-01T00:00:00.000Z" });
    await seedSession(homeDir, "recent", workCwd, { closedAt: "2099-01-01T00:00:00.000Z" });

    const olderThan = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--older-than", "30"],
      homeDir,
    );
    assert.equal(olderThan.code, 0, olderThan.stderr);
    assert.match(olderThan.stdout, /Pruned 1 session/);
    assert.equal(await fileExists(sessionFilePath(homeDir, "aged-out")), false);
    assert.equal(await fileExists(sessionFilePath(homeDir, "recent")), true);

    await seedSession(homeDir, "aged-out", workCwd, { closedAt: "2020-01-01T00:00:00.000Z" });
    const before = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--before", "2021-01-01"],
      homeDir,
    );
    assert.equal(before.code, 0, before.stderr);
    assert.match(before.stdout, /Pruned 1 session/);
    assert.equal(await fileExists(sessionFilePath(homeDir, "recent")), true);
  });
});

// ─── T5 · the count precedes the act ─────────────────────────────────────────
//
// Ordering within ONE captured stdout is the observable meaning of "before": the
// original defect was that `Pruned 7 sessions` arrived AFTER the irreversible act.
test("the pre-flight count is printed before any per-record line or the summary", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--whole-box"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const planIndex = result.stdout.indexOf("Will prune ALL 7 closed claude sessions");
    const summaryIndex = result.stdout.indexOf("Pruned 7 sessions");
    const firstRecordIndex = result.stdout.indexOf("  051458e5");
    assert.ok(planIndex >= 0, `pre-flight line missing:\n${result.stdout}`);
    assert.ok(summaryIndex >= 0, `summary missing:\n${result.stdout}`);
    assert.ok(firstRecordIndex >= 0, `per-record lines missing:\n${result.stdout}`);
    assert.ok(planIndex < summaryIndex, "pre-flight line must precede the summary");
    assert.ok(planIndex < firstRecordIndex, "pre-flight line must precede the record list");
  });
});

// ─── T6 · positional ids are all-or-nothing ──────────────────────────────────
test("prune with one unknown id among four good ones deletes nothing", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", ...SPECIMEN_IDS, "deadbeef"],
      homeDir,
    );

    assert.equal(result.code, 1);
    assert.equal(
      pruneOutput(result.stderr).trim(),
      "acpx sessions prune: no closed claude session matches 'deadbeef' — nothing was deleted.",
    );
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ALL_IDS);
    assert.deepEqual(await survivingSidecars(homeDir, ALL_IDS), ALL_IDS);

    // Control: the same four WITHOUT the unknown id delete exactly those four.
    const control = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", ...SPECIMEN_IDS],
      homeDir,
    );
    assert.equal(control.code, 0, control.stderr);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), BYSTANDER_IDS);
    assert.deepEqual(await survivingSidecars(homeDir, ALL_IDS), BYSTANDER_IDS);
  });
});

test("prune matches ids by SUFFIX, never by substring or prefix", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "aaa-target-zzz", workCwd);
    await seedSession(homeDir, "bystander", workCwd);

    // "target" is a SUBSTRING of the id but not a suffix — an `includes` match
    // would select it and a `startsWith` match would not; both are wrong.
    const substring = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "target"],
      homeDir,
    );
    assert.equal(substring.code, 1);
    assert.match(substring.stderr, /no closed claude session matches 'target'/);
    assert.equal(await fileExists(sessionFilePath(homeDir, "aaa-target-zzz")), true);

    // "aaa" is a PREFIX, equally not a suffix.
    const prefix = await runCli(["--cwd", workCwd, "claude", "sessions", "prune", "aaa"], homeDir);
    assert.equal(prefix.code, 1);
    assert.equal(await fileExists(sessionFilePath(homeDir, "aaa-target-zzz")), true);

    // Control: the real suffix resolves and deletes.
    const suffix = await runCli(["--cwd", workCwd, "claude", "sessions", "prune", "zzz"], homeDir);
    assert.equal(suffix.code, 0, suffix.stderr);
    assert.equal(await fileExists(sessionFilePath(homeDir, "aaa-target-zzz")), false);
    assert.equal(await fileExists(sessionFilePath(homeDir, "bystander")), true);
  });
});

test("prune refuses an ambiguous suffix, lists the matches, and deletes nothing", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "one-shared", workCwd, { name: "alpha" });
    await seedSession(homeDir, "two-shared", workCwd, { name: "beta" });

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "shared"],
      homeDir,
    );

    assert.equal(result.code, 1);
    const lines = pruneOutput(result.stderr).split("\n");
    assert.equal(
      lines[0],
      "acpx sessions prune: 'shared' is ambiguous — 2 closed sessions match, so prune deleted nothing.",
    );
    assert.ok(
      lines.some((line) => line.startsWith("  one-shared (alpha)\t")),
      `match list missing:\n${result.stderr}`,
    );
    assert.ok(lines.includes("Re-run prune with a longer suffix or the full id."));
    assert.equal(await fileExists(sessionFilePath(homeDir, "one-shared")), true);
    assert.equal(await fileExists(sessionFilePath(homeDir, "two-shared")), true);

    // Control: a longer, unique suffix succeeds.
    const unique = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "one-shared"],
      homeDir,
    );
    assert.equal(unique.code, 0, unique.stderr);
    assert.equal(await fileExists(sessionFilePath(homeDir, "one-shared")), false);
  });
});

test("prune refuses an id naming an OPEN session and says to close it first", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "still-open", workCwd, { closed: false });

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "still-open"],
      homeDir,
    );

    assert.equal(result.code, 1);
    assert.equal(
      pruneOutput(result.stderr).trim(),
      "acpx sessions prune: 'still-open' is still open — close it first, then prune. Nothing was deleted.",
    );
    assert.equal(await fileExists(sessionFilePath(homeDir, "still-open")), true);

    // Control: closed, the same id succeeds.
    // These fixtures write records behind the index's back, so flipping `closed`
    // in place needs the index invalidated — a real `sessions close` rewrites it.
    await seedSession(homeDir, "still-open", workCwd, { closed: true });
    await fs.rm(path.join(sessionDir(homeDir), "index.json"), { force: true });
    const closed = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "still-open"],
      homeDir,
    );
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(await fileExists(sessionFilePath(homeDir, "still-open")), false);
  });
});

// T6d — the preview must fail exactly where the real run fails. This is the check
// that catches the natural misreading of "invoke the callback before the delete
// loop" as "after the dry-run early return".
test("prune --dry-run fails on a bad id instead of previewing a partial set", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--dry-run", "051458e5", "deadbeef"],
      homeDir,
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no closed claude session matches 'deadbeef'/);
    assert.doesNotMatch(result.stdout, /Would prune/);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ALL_IDS);

    // Control: the good id alone previews exactly one and exits 0.
    const control = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--dry-run", "051458e5"],
      homeDir,
    );
    assert.equal(control.code, 0, control.stderr);
    assert.match(control.stdout, /\[DRY RUN\] Would prune 1 session/);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ALL_IDS);
  });
});

// ─── T7 · --cwd ──────────────────────────────────────────────────────────────
test("prune --cwd deletes only this directory's sessions", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--cwd"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), BYSTANDER_IDS);
    assert.deepEqual(await survivingSidecars(homeDir, ALL_IDS), BYSTANDER_IDS);
  });
});

test("prune --cwd is exact equality, not a path prefix", async () => {
  await withTempHome(async (homeDir) => {
    const target = path.join(homeDir, "workspace", "sweep");
    const sibling = path.join(homeDir, "workspace", "sweep-32002");
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await seedSession(homeDir, "in-target", target);
    await seedSession(homeDir, "in-sibling", sibling);

    const result = await runCli(["--cwd", target, "claude", "sessions", "prune", "--cwd"], homeDir);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await fileExists(sessionFilePath(homeDir, "in-target")), false);
    assert.equal(
      await fileExists(sessionFilePath(homeDir, "in-sibling")),
      true,
      "a sibling directory whose path merely STARTS WITH the target must not be swept",
    );
  });
});

// T7c — the parse check that motivated dropping `--cwd [dir]`'s value form. With an
// optional value, Commander binds the next non-flag token as the value and the id
// is silently dropped — a parse ambiguity in a destructive verb.
test("prune --cwd <id> binds the id as an id, never as --cwd's value", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd, otherCwd } = await seedSpecimen(homeDir);
    void otherCwd;

    const result = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--cwd", "aaaa1111"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    // Union of "this cwd" (the 4 repro ids) and the named bystander.
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ["bbbb2222", "cccc3333"]);
  });
});

// ─── T11 · stranding is visible, in both directions ──────────────────────────
test("prune names the stream files it strands, and does not when --include-history", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "with-stream", workCwd, { streamBytes: 2048 });

    const stranding = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--cwd"],
      homeDir,
    );
    assert.equal(stranding.code, 0, stranding.stderr);
    assert.match(
      stranding.stdout,
      /^ {2}note: prune leaves 1 stream file \(2\.0 KB\) behind, unreachable — no later prune$/m,
    );
    assert.match(
      stranding.stdout,
      /^ {8}can reclaim them\. Add --include-history so prune removes them too\.$/m,
    );
    assert.equal(await fileExists(streamPath(homeDir, "with-stream")), true);

    // The other direction: with --include-history there is no note AND the stream
    // is gone. Two-directional, so neither a never-firing nor an always-firing note
    // passes.
    await seedSession(homeDir, "with-stream", workCwd, { streamBytes: 2048 });
    const including = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--cwd", "--include-history"],
      homeDir,
    );
    assert.equal(including.code, 0, including.stderr);
    assert.doesNotMatch(including.stdout, /note: prune leaves/);
    assert.equal(await fileExists(streamPath(homeDir, "with-stream")), false);
  });
});

test("prune reports stranded stream totals in json", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "json-stream", workCwd, { streamBytes: 100 });

    const result = await runCli(
      ["--cwd", workCwd, "--format", "json", "claude", "sessions", "prune", "--cwd"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      strandedStreamFiles?: number;
      strandedStreamBytes?: number;
      scope?: Record<string, unknown>;
      skippedTemplates?: unknown;
    };
    assert.equal(payload.strandedStreamFiles, 1);
    assert.equal(payload.strandedStreamBytes, 100);
    assert.deepEqual(payload.scope, { cwd: workCwd });
  });
});

// The a62de399 JSON surface is a CONTRACT: field name and shape must not move
// under its consumers, even while the human-readable line evolves.
test("the skippedTemplates json field name and shape are unchanged", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "bp-json", workCwd, {
      template: {
        enabled: true,
        slug: "intaker",
        version: 7,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    });

    const result = await runCli(
      ["--cwd", workCwd, "--format", "json", "claude", "sessions", "prune", "--cwd"],
      homeDir,
    );

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(payload.skippedTemplates, [{ acpxRecordId: "bp-json", slug: "intaker" }]);
    // Every pre-existing key still present with its original meaning.
    for (const key of ["action", "dryRun", "count", "bytesFreed", "pruned", "skippedTemplates"]) {
      assert.ok(key in payload, `existing json key '${key}' disappeared`);
    }
  });
});

// ─── T12 · E2: the refusal teaches the right invocation, not the override ────
//
// ⚠️ The refusal text is the CONTROL SURFACE. An agent pastes and retries whatever
// the error suggests, so these assertions are what stop a later "helpful" edit from
// turning the refusal into a one-line bypass. Prose is not type-checked.
test("the refusal offers runnable commands, ids first, and never pastes --whole-box", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const result = await runCli(["--cwd", workCwd, "claude", "sessions", "prune"], homeDir);
    assert.equal(result.code, 2);
    const lines = pruneOutput(result.stderr).split("\n");

    // (i) the copy-paste block is ≥3 complete, runnable commands.
    const copyPasteBlock = lines.filter((line) => /^ {2}acpx .*sessions prune/.test(line));
    assert.ok(
      copyPasteBlock.length >= 3,
      `expected ≥3 runnable commands, got ${copyPasteBlock.length}:\n${result.stderr}`,
    );

    // (ii) the FIRST one is the positional-id form — the usual case.
    assert.equal(
      copyPasteBlock[0],
      "  acpx claude sessions prune <id> [<id>...]    # just the ones you name — the usual case",
    );

    // (iii) THE E2-COROLLARY TEST. A refusal whose remedy is the override has built
    // a one-line bypass and is worse than no refusal. This fires if anyone later
    // moves --whole-box into the runnable block.
    for (const line of lines.filter((candidate) => /^\s*acpx /.test(candidate))) {
      assert.ok(
        !line.includes("--whole-box"),
        `--whole-box must never appear on a paste-ready 'acpx ...' line: ${line}`,
      );
    }

    // (iv) but it IS named, with its count, so a legitimate operator is not stranded.
    assert.ok(
      lines.includes(
        "prune --whole-box is every closed claude session on this box (7) — only if you mean it.",
      ),
      `escape hatch line missing or reworded:\n${result.stderr}`,
    );
  });
});

test("the refusal still shows the --cwd line when this directory holds nothing", async () => {
  await withTempHome(async (homeDir) => {
    const { otherCwd } = await seedSpecimen(homeDir);
    const emptyCwd = path.join(homeDir, "workspace", "empty");
    await fs.mkdir(emptyCwd, { recursive: true });
    void otherCwd;

    const result = await runCli(["--cwd", emptyCwd, "claude", "sessions", "prune"], homeDir);

    assert.equal(result.code, 2);
    // Its ABSENCE would be the useful signal, so the line stays and says so.
    assert.ok(
      result.stderr.includes(
        `  acpx claude sessions prune --cwd             # no closed sessions here (${emptyCwd})`,
      ),
      `zero-count --cwd line missing or reworded:\n${result.stderr}`,
    );
  });
});

// ─── T13 · E3: the override is greppable and un-aliased ──────────────────────
test("a --whole-box run leaves two greppable traces and --all is not an alias", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);

    const argv = ["--cwd", workCwd, "claude", "sessions", "prune", "--whole-box"];
    const result = await runCli(argv, homeDir);
    assert.equal(result.code, 0, result.stderr);

    // The invocation itself plus the echoed pre-flight line — so the sweep survives
    // a command line built by variable interpolation.
    const transcript = `${argv.join(" ")}\n${result.stdout}${result.stderr}`;
    const hits = transcript.split("\n").filter((line) => line.includes("--whole-box"));
    assert.ok(
      hits.length >= 2,
      `expected ≥2 --whole-box traces, got ${hits.length}: ${hits.join(" | ")}`,
    );

    // Positive control for the sweep: a --cwd run leaves ZERO such traces, so the
    // token genuinely discriminates rather than matching everything.
    await seedSpecimen(homeDir);
    const cwdArgv = ["--cwd", workCwd, "claude", "sessions", "prune", "--cwd"];
    const cwdRun = await runCli(cwdArgv, homeDir);
    const cwdTranscript = `${cwdArgv.join(" ")}\n${cwdRun.stdout}${cwdRun.stderr}`;
    assert.equal(
      cwdTranscript.split("\n").filter((line) => line.includes("--whole-box")).length,
      0,
    );

    // No --all alias, hidden or otherwise: an alias would let the override run
    // without leaving the distinctive trace, defeating E3 entirely.
    await seedSpecimen(homeDir);
    const aliased = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--all"],
      homeDir,
    );
    assert.notEqual(aliased.code, 0);
    assert.match(aliased.stderr, /unknown option '--all'/);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ALL_IDS);
  });
});

// ─── T14 · --whole-box conflicts ─────────────────────────────────────────────
test("prune --whole-box cannot be combined with ids or --cwd", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);
    const expected =
      "acpx sessions prune: --whole-box cannot be combined with session ids or --cwd — nothing was deleted.\n" +
      "prune --whole-box means the whole box; ids and --cwd mean a specific set. Pick one.";

    const withId = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--whole-box", "051458e5"],
      homeDir,
    );
    assert.equal(withId.code, 2);
    assert.equal(pruneOutput(withId.stderr).trim(), expected);

    const withCwd = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--whole-box", "--cwd"],
      homeDir,
    );
    assert.equal(withCwd.code, 2);
    assert.equal(pruneOutput(withCwd.stderr).trim(), expected);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), ALL_IDS);

    // Control: --whole-box WITH an age filter is the honest spelling of a
    // retention sweep and must still run.
    const aged = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "--whole-box", "--older-than", "1"],
      homeDir,
    );
    assert.equal(aged.code, 0, aged.stderr);
    assert.deepEqual(await survivingRecords(homeDir, ALL_IDS), []);
  });
});

// ─── A5 · the verb names what it destroys ────────────────────────────────────
test("prune --help names the messages sidecar and the scope requirement", async () => {
  await withTempHome(async (homeDir) => {
    const help = await runCli(["claude", "sessions", "prune", "--help"], homeDir);
    assert.equal(help.code, 0, help.stderr);
    assert.ok(help.stdout.includes("messages sidecar"));
    assert.ok(help.stdout.includes("--whole-box"));
    assert.ok(help.stdout.includes("--cwd"));
    assert.ok(help.stdout.includes("[ids...]"));
  });
});

// ─── T15 · the token rule ────────────────────────────────────────────────────
//
// Every status line this verb prints must contain the literal `prune`, so it
// survives the operator's own output filter. "Pruning" does NOT contain "prune"
// (p-r-u-n-i-n-g), which is how the original blast radius went unseen. T1 pins only
// the refusal's first line; this pins the rest, across EVERY output path.
//
// A line is DATA (and exempt) when it is an enumerable id listing: the pruned-record
// lines and the ambiguity match list. Each such block is introduced by a surviving
// status line stating its count and followed by a surviving remedy line.
const DATA_LINE = /^ {2}\S+( \([^)]*\))?\t/;

function statusLines(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !DATA_LINE.test(line));
}

function assertEveryStatusLineCarriesTheToken(label: string, text: string): void {
  for (const line of statusLines(text)) {
    assert.match(
      line,
      /prune/i,
      `[${label}] this line would be dropped by the operator's own filter: ${JSON.stringify(line)}`,
    );
  }
}

test("every status line of every prune output path carries the literal token", async () => {
  await withTempHome(async (homeDir) => {
    const { workCwd } = await seedSpecimen(homeDir);
    const emptyCwd = path.join(homeDir, "workspace", "empty");
    await fs.mkdir(emptyCwd, { recursive: true });

    // ANTI-ACCIDENT CONTROL: the fixture path must not contain `repro`. The
    // specimen's filter carries the literal `repro`, so a `repro`-bearing path
    // would make the --cwd line survive by accident on a wording that fails the
    // rule — a fixture reproducing the accident tests nothing.
    assert.ok(!workCwd.includes("repro"), "fixture cwd must not contain 'repro'");
    assert.ok(!emptyCwd.includes("repro"), "fixture cwd must not contain 'repro'");

    const paths: [string, string[], string][] = [
      ["scope refusal", ["claude", "sessions", "prune"], workCwd],
      ["scope refusal (empty cwd)", ["claude", "sessions", "prune"], emptyCwd],
      ["conflict", ["claude", "sessions", "prune", "--whole-box", "--cwd"], workCwd],
      ["id not found", ["claude", "sessions", "prune", "nosuchid"], workCwd],
      ["pre-flight ids", ["claude", "sessions", "prune", ...SPECIMEN_IDS], workCwd],
      ["pre-flight cwd", ["claude", "sessions", "prune", "--cwd"], workCwd],
      ["pre-flight whole-box", ["claude", "sessions", "prune", "--whole-box"], workCwd],
      ["pre-flight older-than", ["claude", "sessions", "prune", "--older-than", "1"], workCwd],
      ["pre-flight before", ["claude", "sessions", "prune", "--before", "2099-01-01"], workCwd],
      ["dry run", ["claude", "sessions", "prune", "--dry-run"], workCwd],
    ];

    for (const [label, args, cwd] of paths) {
      await seedSpecimen(homeDir);
      const result = await runCli(["--cwd", cwd, ...args], homeDir);
      assertEveryStatusLineCarriesTheToken(label, pruneOutput(`${result.stdout}${result.stderr}`));
    }

    // The ambiguity path needs its own fixture.
    await seedSession(homeDir, "one-shared", workCwd, { name: "alpha" });
    await seedSession(homeDir, "two-shared", workCwd, { name: "beta" });
    const ambiguous = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "shared"],
      homeDir,
    );
    assertEveryStatusLineCarriesTheToken("id ambiguous", pruneOutput(ambiguous.stderr));

    // The open-session path.
    await seedSession(homeDir, "open-one", workCwd, { closed: false });
    const open = await runCli(
      ["--cwd", workCwd, "claude", "sessions", "prune", "open-one"],
      homeDir,
    );
    assertEveryStatusLineCarriesTheToken("id open", pruneOutput(open.stderr));
  });
});

// POSITIVE CONTROL for the token rule: the instrument must be able to see a DROP.
// Without it, "every line passed" is indistinguishable from "the filter matched
// everything" or "nothing was captured".
test("the token-rule check rejects the first-draft wording it was written to catch", () => {
  const firstDraft = "Pruning 4 named claude sessions (record + messages sidecar each).";
  // "Pruning" is p-r-u-n-i-n-g — it does NOT contain the substring "prune".
  assert.doesNotMatch(firstDraft, /prune/i);
  assert.throws(
    () => assertEveryStatusLineCarriesTheToken("control", firstDraft),
    /would be dropped by the operator's own filter/,
  );

  // And the shipped wording passes the same instrument.
  assertEveryStatusLineCarriesTheToken(
    "control",
    "Will prune 4 named claude sessions (record + messages sidecar each).",
  );
});

/**
 * ⚠️ THE DISCRIMINATING CONTROL, and the reason T15 asserts the RULE rather than
 * running the specimen's filter.
 *
 * The specimen's filter is `prune|delet|remov|repro|<ids>` — STRICTLY BROADER than
 * the rule "every status line contains the literal `prune`". A line can therefore
 * pass the filter while violating the rule, by matching on `remov` or `delet` or on
 * a `repro` that happens to be in the fixture path. That is not hypothetical: it is
 * how the stranded-stream note's second line was certified 27-of-27 twice, by two
 * parties who both ran the filter instead of the rule.
 *
 * Without this case T15 cannot tell the two instruments apart — which IS the bug.
 * If you ever find yourself using the broader filter to prove the narrower rule,
 * stop: that is this defect reproducing itself.
 */
test("the token rule is not satisfied by a line that merely survives the specimen filter", () => {
  const passesFilterFailsRule = "can reclaim them. Add --include-history to remove them.";

  // It DOES survive the operator's pipeline — on "remov" in "remove".
  assert.match(passesFilterFailsRule, SPECIMEN_FILTER);
  // And it FAILS the rule, so T15 must reject it.
  assert.doesNotMatch(passesFilterFailsRule, /prune/i);
  assert.throws(
    () => assertEveryStatusLineCarriesTheToken("control", passesFilterFailsRule),
    /would be dropped by the operator's own filter/,
    "a broader instrument standing in for the rule is exactly what this control exists to catch",
  );

  // The shipped wording of that same line satisfies BOTH.
  const shipped = "        can reclaim them. Add --include-history so prune removes them too.";
  assert.match(shipped, SPECIMEN_FILTER);
  assertEveryStatusLineCarriesTheToken("control", shipped);
});
