import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HARNESS_CONFIG_DIR_ROOT_ENV,
  resolveHarnessConfigDirRoot,
} from "../src/acp/harness-config-dir-root.js";
import {
  assertHarnessConfigDirRootIsolated,
  isolatedHarnessConfigDirRoot,
  scopeHarnessConfigDirRootForCli,
} from "./config-dir-root-isolation.js";
import { withTempHome as withTempHomeFixture } from "./runtime-test-helpers.js";

/**
 * brick 0bac6a00 §4 — THE CONFIG-DIR SWEEP'S ROOT IS REACHABLE FROM THE CLI, AND
 * THE SUITE'S OWN PRUNES NO LONGER WALK THE BOX'S REAL `/tmp`.
 *
 * ## ⚠️ WHAT WAS ACTUALLY BROKEN, BECAUSE IT IS NOT WHAT IT LOOKS LIKE
 *
 * `pruneOrphanHarnessConfigDirs` has taken a `rootDir` since it was written, and
 * `params.rootDir ?? tmpdir()` looks like an override anyone could use. It was
 * **unreachable from the CLI by construction**: the prune handler's own sweep
 * function took no `rootDir` parameter at all, so there was nowhere for a caller
 * to pass one FROM. A missing parameter, not a missing argument — which is why
 * reading the sweep's source suggested the scoping already existed.
 *
 * The consequence is the reason this file exists: **an isolated `HOME` does not
 * scope the sweep.** 75 of this suite's `runCli` prune invocations reach it, 17 at
 * `--whole-box`, and every one of them resolved the real shared `/tmp` of whatever
 * box the gate ran on.
 *
 * ## ⚠️ WHY NO TEST HERE TOUCHES THE REAL `/tmp`, IN EITHER DIRECTION
 *
 * The obvious proof — plant a decoy in the real `/tmp` and watch an unscoped sweep
 * eat it — would be *demonstrating the hazard on shared state*, on a box carrying
 * other agents' live sessions. The code path and the already-captured deletion are
 * the proof that it happens. What these tests establish instead is the POSITIVE:
 * the sweep provably acts inside the root it was given, and provably leaves an
 * identical directory one level outside it alone. A sweep that is measurably
 * bounded cannot also be unbounded.
 *
 * ## The instrument control this file leans on rather than repeats
 *
 * `prune-positive-ownership.test.ts` → "an UNMEASURABLE /proc scan removes NOTHING
 * and says so" is the control that a sweep with no live-process census removes
 * nothing. Without it, a green "removed the decoy" here could not be distinguished
 * from a sweep that removes indiscriminately.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;

type CliResult = { code: number | null; stdout: string; stderr: string };

/**
 * Deliberately NOT the guarded `runCli` of the prune test files: these tests must
 * be able to drive an invocation the guard would reject (the `--config-dir-root`
 * precedence case passes its own root and no env), and a helper that could not do
 * that could not test the precedence at all.
 */
function runCliUnguarded(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve_) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.stdin.end();
    child.once("close", (code) => resolve_({ code, stdout, stderr }));
  });
}

/** An aged, unclaimed config dir — the shape the sweep is allowed to remove. */
function plantAgedConfigDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "marker.txt"), "planted");
  const past = (Date.now() - SEVEN_HOURS_MS) / 1000;
  utimesSync(dir, past, past);
  return dir;
}

function censusLine(text: string): string {
  const line = text.split("\n").find((l) => l.includes("harness config dirs:"));
  assert.ok(line !== undefined, `no config-dir census in output:\n${text}`);
  return line;
}

// ---------------------------------------------------------------------------
// The resolver itself
// ---------------------------------------------------------------------------

test("0bac6a00 §4: the root resolves argument > env > tmpdir(), and the DEFAULT is still tmpdir()", () => {
  assert.equal(resolveHarnessConfigDirRoot(undefined, {}), tmpdir());
  assert.equal(
    resolveHarnessConfigDirRoot(undefined, { [HARNESS_CONFIG_DIR_ROOT_ENV]: "/from/env" }),
    "/from/env",
  );
  assert.equal(
    resolveHarnessConfigDirRoot("/from/argument", { [HARNESS_CONFIG_DIR_ROOT_ENV]: "/from/env" }),
    "/from/argument",
  );
});

test("0bac6a00 §4: a BLANK root is treated as absent, never as a relative path", () => {
  // `join("", "acpx-opencode-x")` is RELATIVE — a sweep rooted wherever the CLI
  // was invoked from. Blank must fall through to the default, not become "".
  assert.equal(resolveHarnessConfigDirRoot("   ", {}), tmpdir());
  assert.equal(
    resolveHarnessConfigDirRoot(undefined, { [HARNESS_CONFIG_DIR_ROOT_ENV]: "  " }),
    tmpdir(),
  );
  assert.equal(
    resolveHarnessConfigDirRoot(undefined, { [HARNESS_CONFIG_DIR_ROOT_ENV]: "" }),
    tmpdir(),
  );
});

// ---------------------------------------------------------------------------
// The CLI, driven for real
// ---------------------------------------------------------------------------

test("0bac6a00 §4: `sessions prune` sweeps the ISOLATED root and leaves an identical dir outside it", async () => {
  await withTempHomeFixture("acpx-0bac6a00-scope-", async (homeDir) => {
    const isolated = isolatedHarnessConfigDirRoot();
    const outside = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-outside-"));
    try {
      // Same name, same age, same emptiness — the ONLY difference is which root
      // it sits in. That is what makes this a scoping measurement rather than a
      // classification one.
      const inside = plantAgedConfigDir(isolated, "acpx-opencode-0bac6a00-inside");
      const beyond = plantAgedConfigDir(outside, "acpx-opencode-0bac6a00-inside");

      const result = await runCliUnguarded(
        ["--verbose", "claude", "sessions", "prune", "--whole-box"],
        homeDir,
      );

      const census = censusLine(result.stderr);
      assert.ok(
        census.includes(`root=${isolated}`),
        `census names the wrong root — it should be the isolated one:\n${census}`,
      );
      assert.ok(
        !census.includes("REFUSED"),
        `the sweep refused, so this run measured nothing:\n${census}`,
      );
      // The POSITIVE: it really walked the isolated root and really acted there.
      assert.equal(existsSync(inside), false, "the sweep did not act inside its own root");
      // The BOUND: the identical directory one level outside is untouched.
      assert.equal(existsSync(beyond), true, "the sweep reached outside the root it was given");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("0bac6a00 §4: `--config-dir-root` reaches the sweep and OUTRANKS the environment", async () => {
  await withTempHomeFixture("acpx-0bac6a00-flag-", async (homeDir) => {
    const envRoot = isolatedHarnessConfigDirRoot();
    const flagRoot = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-flag-root-"));
    try {
      const viaEnv = plantAgedConfigDir(envRoot, "acpx-opencode-0bac6a00-env");
      const viaFlag = plantAgedConfigDir(flagRoot, "acpx-opencode-0bac6a00-flag");

      const result = await runCliUnguarded(
        ["--verbose", "claude", "sessions", "prune", "--whole-box", "--config-dir-root", flagRoot],
        homeDir,
      );

      const census = censusLine(result.stderr);
      assert.ok(census.includes(`root=${flagRoot}`), `flag did not win:\n${census}`);
      assert.equal(existsSync(viaFlag), false, "the flag's root was not swept");
      assert.equal(existsSync(viaEnv), true, "the env root was swept despite an explicit flag");
    } finally {
      rmSync(flagRoot, { recursive: true, force: true });
    }
  });
});

test("0bac6a00 §4: `sessions prune --help` advertises `--config-dir-root`", async () => {
  await withTempHomeFixture("acpx-0bac6a00-help-", async (homeDir) => {
    const result = await runCliUnguarded(["claude", "sessions", "prune", "--help"], homeDir);
    // The brick was FILED because `--help` had no such flag: the safety rule the
    // fleet was operating under named an option that did not exist, so nobody
    // could comply with it. The help text is where that is checkable.
    assert.match(result.stdout, /--config-dir-root/);
  });
});

// ---------------------------------------------------------------------------
// The guard — fire-tested in BOTH directions
// ---------------------------------------------------------------------------

test("0bac6a00 §4: the spawn-time guard REFUSES an unscoped prune", () => {
  const saved = process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
  try {
    delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    assert.throws(
      () => assertHarnessConfigDirRootIsolated(["claude", "sessions", "prune", "--whole-box"]),
      /no scoped config-dir root/,
    );
    // The real tmpdir is not "an explicit root" — it is the exact value the
    // defect resolved to, so naming it must not satisfy the guard.
    process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = tmpdir();
    assert.throws(
      () => assertHarnessConfigDirRootIsolated(["claude", "sessions", "prune"]),
      /not an isolated temp path/,
    );
    // A path outside the temp tree entirely is equally not isolation.
    process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = resolve(sep, "var", "tmp", "not-isolated");
    assert.throws(
      () => assertHarnessConfigDirRootIsolated(["claude", "sessions", "prune"]),
      /not an isolated temp path/,
    );
  } finally {
    if (saved === undefined) {
      delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    } else {
      process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = saved;
    }
  }
});

test("0bac6a00 §4: the guard PASSES what it should — scoped prunes, `--help`, and non-prune verbs", () => {
  const saved = process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
  try {
    // A guard that threw on everything would pass the test above and be useless;
    // the negative cases are what make the positive one evidence.
    delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    assertHarnessConfigDirRootIsolated(["claude", "sessions", "prune", "--help"]);
    assertHarnessConfigDirRootIsolated(["claude", "sessions", "list"]);
    const scoped = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-guard-"));
    try {
      assertHarnessConfigDirRootIsolated([
        "claude",
        "sessions",
        "prune",
        "--config-dir-root",
        scoped,
      ]);
      process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = scoped;
      assertHarnessConfigDirRootIsolated(["claude", "sessions", "prune", "--whole-box"]);
    } finally {
      rmSync(scoped, { recursive: true, force: true });
    }
  } finally {
    if (saved === undefined) {
      delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    } else {
      process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = saved;
    }
  }
});

test("0bac6a00 §4: the temp-home fixture is what scopes the suite, and it scopes CHILDREN", async () => {
  // ⚠️ THE PROPERTY THAT MATTERS IS INHERITANCE, not the variable's presence in
  // this process. Every runCli helper spawns with `{ ...process.env }`, so a
  // fixture-set variable is what reaches the CLI. Assert it from the CHILD.
  await withTempHomeFixture("acpx-0bac6a00-inherit-", async (homeDir) => {
    const isolated = isolatedHarnessConfigDirRoot();
    assert.ok(
      resolve(isolated).startsWith(`${resolve(tmpdir())}${sep}`),
      "the fixture's root is not under the temp tree",
    );
    const result = await runCliUnguarded(
      ["--verbose", "claude", "sessions", "prune", "--whole-box"],
      homeDir,
    );
    assert.ok(
      censusLine(result.stderr).includes(`root=${isolated}`),
      "the CLI child did not inherit the fixture's config-dir root",
    );
  });
});

test("0bac6a00 §4: the spawn-time scoping writes an isolated root INTO THE CHILD'S env", () => {
  // ⚠️ THIS IS THE CASE THE FIRST FULL GATE FOUND. `cli.test.ts` has its own local
  // withTempHome, and deletion-manifest's T-ISO-4 runs outside any fixture — five
  // prunes that a fixture-only scoping left pointed at the real /tmp. Scoping from
  // the helper's own isolated home covers all of them, whatever fixture they use.
  const home = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-child-"));
  const saved = process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
  try {
    delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    const env: NodeJS.ProcessEnv = { HOME: home };
    scopeHarnessConfigDirRootForCli(["claude", "sessions", "prune", "--whole-box"], env, home);
    const root = env[HARNESS_CONFIG_DIR_ROOT_ENV];
    assert.ok(root !== undefined, "the child env carries no root");
    assert.ok(root.startsWith(`${home}${sep}`), `root ${root} is not inside the isolated home`);
    assert.ok(existsSync(root), "the root was set but never created — the sweep would not measure");
    // The PARENT is deliberately untouched: scoping the child is the property,
    // and a helper that leaked into process.env would make sibling tests depend
    // on execution order.
    assert.equal(process.env[HARNESS_CONFIG_DIR_ROOT_ENV], undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (saved === undefined) {
      delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    } else {
      process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = saved;
    }
  }
});

test("0bac6a00 §4: the spawn-time scoping leaves an EXPLICIT --config-dir-root alone", () => {
  const home = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-explicit-"));
  const chosen = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-chosen-"));
  try {
    const env: NodeJS.ProcessEnv = {};
    scopeHarnessConfigDirRootForCli(
      ["claude", "sessions", "prune", "--config-dir-root", chosen],
      env,
      home,
    );
    // The flag outranks the env in the resolver; silently adding a second root
    // here would make the child's behaviour depend on a precedence the caller
    // never asked about.
    assert.equal(env[HARNESS_CONFIG_DIR_ROOT_ENV], undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(chosen, { recursive: true, force: true });
  }
});

test("0bac6a00 §4: the spawn-time scoping touches nothing for `--help` or a non-prune verb", () => {
  const home = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-noop-"));
  try {
    for (const args of [
      ["claude", "sessions", "prune", "--help"],
      ["claude", "sessions", "list"],
    ]) {
      const env: NodeJS.ProcessEnv = {};
      scopeHarnessConfigDirRootForCli(args, env, home);
      assert.equal(env[HARNESS_CONFIG_DIR_ROOT_ENV], undefined, args.join(" "));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
