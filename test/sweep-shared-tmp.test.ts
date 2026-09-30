import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import { registerDefaultCommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";

// brick f61391ac — `scripts/sweep-shared-tmp.sh`, the tier-2 retention sweeper
// (SPEC.md §4). Acceptance criteria 5 and 6 are this file's bar.

// dist-test/test/<this file> → the repo root two levels up. Both the script and
// its fixture roots are derived from it, so the test exercises the SHIPPED
// script rather than a copy.
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SWEEPER = join(REPO_ROOT, "scripts", "sweep-shared-tmp.sh");

// ⚠️ THE FIXTURE ROOT MUST LIVE UNDER `/workspace`, AND THAT IS NOT INCIDENTAL:
// the sweeper refuses any root outside it, so a fixture in the system temp dir
// would make every row below pass by REFUSAL — a green suite proving nothing.
// `dist-test/` is under the repo (hence under /workspace), is gitignored, and is
// wiped by `build:test`, so debris from a crashed row cannot leak into a commit.
const FIXTURE_PARENT = join(REPO_ROOT, "dist-test", "sweep-fixtures");

function withFixtureRoot<T>(fn: (root: string) => T): T {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "root-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * ⚠️ SEPARATE ASYNC VARIANT, NOT AN `async` VERSION OF THE ABOVE. The sync
 * helper's `finally` fires as soon as `fn` RETURNS — for an async body that is
 * the moment it returns its promise, so the fixture is deleted before the body
 * has used it. Measured while writing this file: the async row failed with
 * "root ... does not exist yet", which looks like a sweeper bug and is a
 * teardown race in the test.
 */
async function withFixtureRootAsync(fn: (root: string) => Promise<void>): Promise<void> {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(join(FIXTURE_PARENT, "root-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A child directory whose ENTIRE subtree is `ageDays` old. */
function makeAgedChild(root: string, name: string, ageDays: number): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "sub"), { recursive: true });
  const file = join(dir, "sub", "payload.txt");
  writeFileSync(file, "x".repeat(64));
  const when = new Date(Date.now() - ageDays * 86_400_000);
  // Deepest first: touching a child updates its parent's mtime.
  for (const target of [file, join(dir, "sub"), dir]) {
    utimesSync(target, when, when);
  }
  return dir;
}

function runSweeper(args: string[]): { status: number; stdout: string } {
  const result = spawnSync(SWEEPER, args, { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// ── Acceptance criterion 5 ───────────────────────────────────────────────────

test("sweeper --apply removes an 8-day-old subtree and keeps a 6-day-old one", () => {
  withFixtureRoot((root) => {
    makeAgedChild(root, "acpx-old", 8);
    makeAgedChild(root, "acpx-recent", 6);

    const { status, stdout } = runSweeper(["--root", root, "--apply"]);
    assert.equal(status, 0, `a reaper must always exit 0; stdout:\n${stdout}`);
    assert.equal(
      existsSync(join(root, "acpx-old")),
      false,
      `8d subtree must be removed:\n${stdout}`,
    );
    assert.equal(
      existsSync(join(root, "acpx-recent")),
      true,
      `6d subtree must be KEPT — the retention window is 7 days:\n${stdout}`,
    );
  });
});

// The window is on the NEWEST mtime ANYWHERE in the subtree, not the directory's
// own mtime: a directory's mtime tracks only its direct entries, so a busy
// grandchild under an otherwise-static parent would read as abandoned. This row
// is the one that fails if someone "simplifies" the walk to `stat` the child.
test("sweeper keeps an old directory whose only recent file is deep in the subtree", () => {
  withFixtureRoot((root) => {
    const dir = makeAgedChild(root, "acpx-deep", 30);
    const deep = join(dir, "sub", "deeper");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "fresh.txt"), "touched just now");
    // The child directory itself stays 30 days old.
    const old = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(dir, old, old);

    const { status, stdout } = runSweeper(["--root", root, "--apply"]);
    assert.equal(status, 0);
    assert.equal(
      existsSync(dir),
      true,
      `a subtree with ANY recent entry must be kept, however old the parent dir is:\n${stdout}`,
    );
  });
});

test("sweeper skips a directory holding a live process's cwd, however old it is", async () => {
  await withFixtureRootAsync(async (root) => {
    const busy = makeAgedChild(root, "acpx-busy", 30);
    const doomed = makeAgedChild(root, "acpx-doomed", 30);

    // Hold the cwd from a real process. It signals readiness on stdout rather
    // than by writing a file — a write would refresh the subtree's mtime and
    // the row would then pass for the WRONG reason (recent, not protected).
    const holder = spawn(
      process.execPath,
      ["-e", "console.log('ready');setTimeout(()=>{},60000)"],
      {
        cwd: busy,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once("data", () => resolve());
        holder.once("error", reject);
        setTimeout(() => reject(new Error("holder process never signalled ready")), 20_000);
      });

      const { status, stdout } = runSweeper(["--root", root, "--apply"]);
      assert.equal(status, 0);
      assert.equal(
        existsSync(busy),
        true,
        `a directory holding a live process's cwd must be skipped:\n${stdout}`,
      );
      assert.match(stdout, /SKIP.*acpx-busy.*live process cwd/);
      // The control: an equally-old sibling with no process in it IS removed,
      // so the row above cannot pass merely because the sweeper did nothing.
      assert.equal(
        existsSync(doomed),
        false,
        `control: an equally-old UNoccupied sibling must still be removed:\n${stdout}`,
      );
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

test("sweeper REFUSES a root outside /workspace and touches nothing there", () => {
  const outside = mkdtempSync(join("/tmp", "acpx-sweep-outside-"));
  try {
    const ancient = join(outside, "acpx-ancient");
    mkdirSync(ancient);
    const old = new Date(Date.now() - 90 * 86_400_000);
    utimesSync(ancient, old, old);

    const { status, stdout } = runSweeper(["--root", outside, "--apply"]);
    assert.equal(status, 0, "even a refusal exits 0 — it must never wedge the supervised loop");
    assert.match(stdout, /REFUSE/);
    assert.equal(
      existsSync(ancient),
      true,
      "a root outside /workspace must be left completely untouched",
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// `/workspace` itself is refused as emphatically as `/` would be: the child glob
// would otherwise run across the whole shared project tree.
test("sweeper REFUSES /workspace itself, not just paths outside it", () => {
  const { status, stdout } = runSweeper(["--root", "/workspace", "--apply"]);
  assert.equal(status, 0);
  assert.match(stdout, /REFUSE/);
});

test("sweeper dry-run is the DEFAULT and removes nothing", () => {
  withFixtureRoot((root) => {
    makeAgedChild(root, "acpx-old", 30);
    const { status, stdout } = runSweeper(["--root", root]);
    assert.equal(status, 0);
    assert.match(stdout, /WOULD-REMOVE/);
    assert.equal(
      existsSync(join(root, "acpx-old")),
      true,
      `without --apply nothing may be removed:\n${stdout}`,
    );
  });
});

test("sweeper only ever considers acpx-* children, and WARNS about anything else", () => {
  withFixtureRoot((root) => {
    makeAgedChild(root, "acpx-old", 30);
    // A hand-made stray, old enough to be swept if the name filter were absent.
    const stray = join(root, "someone-elses-log");
    mkdirSync(stray);
    writeFileSync(join(stray, "f"), "hand-made");
    const old = new Date(Date.now() - 90 * 86_400_000);
    utimesSync(join(stray, "f"), old, old);
    utimesSync(stray, old, old);

    const { status, stdout } = runSweeper(["--root", root, "--apply"]);
    assert.equal(status, 0);
    assert.equal(existsSync(stray), true, `a non-acpx-* entry must never be removed:\n${stdout}`);
    assert.match(stdout, /WARN {2}unexpected non-acpx-\* entry/);
    // And the control that the sweep was live at all.
    assert.equal(existsSync(join(root, "acpx-old")), false);
  });
});

test("sweeper never removes the root itself, even when it is empty and ancient", () => {
  withFixtureRoot((root) => {
    const old = new Date(Date.now() - 90 * 86_400_000);
    utimesSync(root, old, old);
    const { status } = runSweeper(["--root", root, "--apply"]);
    assert.equal(status, 0);
    assert.equal(existsSync(root), true, "the root is swept, never reaped");
  });
});

// A symlinked child is never followed and never removed: `rm -rf` on one would
// remove only the link, but the mtime walk would be reading a subtree that is
// not ours — so the decision would be made on foreign data.
test("sweeper skips a symlinked child rather than following it", () => {
  withFixtureRoot((root) => {
    const real = makeAgedChild(root, "elsewhere", 30);
    const link = join(root, "acpx-link");
    spawnSync("ln", ["-s", real, link]);
    const { status, stdout } = runSweeper(["--root", root, "--apply"]);
    assert.equal(status, 0);
    assert.match(stdout, /SKIP.*acpx-link.*symlink/);
    assert.equal(existsSync(real), true, "the symlink's target must survive untouched");
  });
});

test("sweeper logs path, age and reclaimed size for every removal", () => {
  withFixtureRoot((root) => {
    makeAgedChild(root, "acpx-old", 12);
    const { stdout } = runSweeper(["--root", root, "--apply"]);
    assert.match(
      stdout,
      /REMOVE {2}.*acpx-old {2}\(age=\d+d, reclaimed=\d+ bytes\)/,
      `the ledger must be auditable after the fact:\n${stdout}`,
    );
  });
});

// ⚠️ The root comes from the WRITER'S MODULE, not a literal re-typed in bash.
// `harness-config-dir-root.ts` exists because a sweep that disagrees with its
// writer reports a truthful, entirely clean census over the wrong directory —
// success with nothing reclaimed and no error anywhere. This row proves the two
// agree by running the sweeper with NO --root and reading back the root it
// chose: it must be the module's own default.
test("sweeper resolves its root from the writer's module, not a re-typed literal", async () => {
  const { SESSION_SHARED_TMP_DEFAULT_ROOT } = await import("../src/acp/session-shared-tmp-dir.js");
  const result = spawnSync(SWEEPER, [], {
    encoding: "utf8",
    // Scrub the suite-wide override so the module's real DEFAULT is what
    // answers — otherwise this row would only prove the env var works.
    env: { ...process.env, ACPX_SESSION_SHARED_TMP_ROOT: "" },
  });
  const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0);
  assert.ok(
    stdout.includes(SESSION_SHARED_TMP_DEFAULT_ROOT),
    `the sweeper must name the module's own default root (${SESSION_SHARED_TMP_DEFAULT_ROOT}):\n${stdout}`,
  );
});

test("sweeper honours ACPX_SESSION_SHARED_TMP_ROOT through the module's own precedence", () => {
  withFixtureRoot((root) => {
    makeAgedChild(root, "acpx-old", 30);
    const result = spawnSync(SWEEPER, ["--apply"], {
      encoding: "utf8",
      env: { ...process.env, ACPX_SESSION_SHARED_TMP_ROOT: root },
    });
    assert.equal(result.status, 0);
    assert.equal(
      existsSync(join(root, "acpx-old")),
      false,
      `the env override must reach the sweeper:\n${result.stdout}${result.stderr}`,
    );
  });
});

// ── Acceptance criterion 6 — structurally unreachable from a request path ────

function fakeConfig(): ResolvedAcpxConfig {
  return {
    defaultAgent: "codex",
    defaultPermissions: "approve-all",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    ttlMs: 900_000,
    queueMaxDepth: 16,
    format: "text",
    agents: {},
    auth: {},
    disableExec: false,
    mcpServers: [],
    subscriptions: { version: 3, subscriptions: [], profiles: [] },
    globalPath: "/tmp/acpx-test-config.json",
    projectPath: "/tmp/.acpxrc.json",
    hasGlobalConfig: false,
    hasProjectConfig: false,
  } as unknown as ResolvedAcpxConfig;
}

// ⚠️ NO EXIT-CODE ASSERTION HERE, DELIBERATELY. `src/cli-core.ts` is explicit
// that the rc of an unregistered token reports WHICH FALL-THROUGH PATH WAS HIT,
// is cwd-dependent, and is therefore sound in neither direction — and the error
// goes to stderr, so a stdout-only probe sees a clean, silent rc with no message
// at all. This asks the PARSER instead, exactly as `top-level-verbs.test.ts`
// does: a token commander does not know throws `commander.unknownCommand`.
function isAnswered(verb: string): boolean {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDefaultCommands(program, fakeConfig());
  if (program.commands.some((command) => command.name() === verb)) {
    return true;
  }
  try {
    program.parse([verb], { from: "user" });
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "commander.unknownCommand";
  }
}

test("the sweeper is NOT reachable as an acpx CLI verb", () => {
  for (const candidate of ["sweep-shared-tmp", "sweep-shared-tmp.sh", "sweep", "shared-tmp"]) {
    assert.equal(
      isAnswered(candidate),
      false,
      `'${candidate}' resolves as a CLI verb — the sweeper must stay unreachable from any ` +
        `request-serving path (brick d1e12500: an on-prompt reclaim pass OOM-killed user prompts)`,
    );
    assert.equal(
      TOP_LEVEL_VERBS.has(candidate),
      false,
      `'${candidate}' is claimed in TOP_LEVEL_VERBS`,
    );
  }
  // The positive control: without it, a broken `isAnswered` that always returns
  // false would make every assertion above vacuous.
  assert.equal(isAnswered("sessions"), true, "control: a real verb must be answered");
  assert.equal(TOP_LEVEL_VERBS.has("sessions"), true, "control: a real verb must be in the set");
});

const SWEEPER_NEEDLE = "sweep-shared-tmp";

/**
 * Does this source INVOKE the sweeper, as opposed to merely mentioning it?
 *
 * ⚠️ THE DISTINCTION IS THE WHOLE POINT, AND A PLAIN `source.includes()` GETS IT
 * WRONG IN THE DIRECTION THAT COSTS YOU. Measured while writing this file: the
 * naive version flagged `src/acp/session-shared-tmp-dir.ts`, whose only mention
 * of the sweeper is a DOC COMMENT explaining the retention policy — a false
 * RED, and the obvious fix for a false red is an exception list, which is a
 * hand-maintained list wearing a disguise and would have swallowed a real hit
 * in that same file later. Comments are stripped instead, so the question asked
 * is about executable text: an import, or a string literal handed to a spawn.
 */
function invokesSweeper(source: string): boolean {
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
  return withoutComments.includes(SWEEPER_NEEDLE);
}

// The committed POSITIVE case for the predicate above. Without it, a predicate
// that can never return true — an over-eager comment strip, a typo in the
// needle — reads as a clean sweep over `src/`, and the check would survive its
// own violation.
test("invokesSweeper flags real invocations and ignores mere mentions", () => {
  assert.equal(
    invokesSweeper(`import { x } from "../scripts/sweep-shared-tmp.sh";`),
    true,
    "an import of the sweeper must be flagged",
  );
  assert.equal(
    invokesSweeper(`spawnSync("scripts/sweep-shared-tmp.sh", ["--apply"]);`),
    true,
    "a spawn of the sweeper must be flagged",
  );
  assert.equal(
    invokesSweeper(`/** Retention is enforced by scripts/sweep-shared-tmp.sh. */\nconst a = 1;`),
    false,
    "a block-comment mention is documentation, not reachability",
  );
  assert.equal(
    invokesSweeper(`// see scripts/sweep-shared-tmp.sh\nconst a = 1;`),
    false,
    "a line-comment mention is documentation, not reachability",
  );
});

// A DISCOVERING check, not a hand-maintained file list: it walks `src/` and
// finds its own subjects, so a new module that reaches for the sweeper is caught
// without anyone registering it anywhere.
test("no module under src/ invokes the sweeper script", () => {
  const hits: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith(".ts")) {
        scanned += 1;
        if (invokesSweeper(readFileSync(full, "utf8"))) {
          hits.push(full);
        }
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  // A walk that silently visited nothing reads exactly like a clean sweep.
  assert.ok(scanned > 100, `the walk must actually visit src/ — only ${scanned} files scanned`);
  assert.deepEqual(
    hits,
    [],
    `these src/ modules invoke the sweeper, making it reachable from request-serving code: ` +
      hits.join(", "),
  );
  assert.ok(statSync(SWEEPER).mode & 0o111, "the shipped sweeper must be executable");
});
