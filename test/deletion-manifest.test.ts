import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "../src/types.js";
import { scopeHarnessConfigDirRootForCli } from "./config-dir-root-isolation.js";
import {
  fileExists,
  makeSessionRecord,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * brick://401a6216 — the deletion manifest, the `--include-history` flip, and
 * the two file classes a deletion now takes with it.
 *
 * These drive the REAL compiled CLI as a NON-TTY subprocess against an isolated
 * store, because that is the production shape: every caller invokes acpx from a
 * non-TTY shell, and the flag surface, the exit codes and the operator-facing
 * strings all live at the CLI layer.
 *
 * ⚠️ ISOLATION IS PART OF THE TEST, NOT SETUP — this suite DELETES session
 * records. `sessionBaseDir()` is `ACPX_STATE_HOME || os.homedir()`, so
 * `ACPX_STATE_HOME` WINS and a harness pinning only `HOME` would run against
 * the real store WHILE READING AS ISOLATED. Every run below pins BOTH.
 *
 * The single deliberate exception is T-ISO-4, which pins them to two DISTINCT
 * TEMP paths — neither ever the real `~` — because the property it tests does
 * not exist while they are equal. It asserts that divergence, and that neither
 * path resolves under the real `os.homedir()`, before it prunes anything.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const AGENT_COMMAND = "node /opt/claude-agent-acp/dist/index.js";

type CliResult = { code: number | null; stdout: string; stderr: string };

type RunOptions = {
  /** Pinned to HOME. */
  home: string;
  /** Pinned to ACPX_STATE_HOME. Defaults to `home` — the two diverge only in
   *  T-ISO-4, which passes this explicitly. */
  stateHome?: string;
  cwd?: string;
  /** Applied last, so a test can put a scrubbed var back deliberately. */
  extra?: NodeJS.ProcessEnv;
};

function runCli(args: string[], options: RunOptions): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: options.home,
      ACPX_STATE_HOME: options.stateHome ?? options.home,
    };
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
    Object.assign(env, options.extra ?? {});
    // ⚠️ SCOPE THE CHILD'S OWN ENV, then verify it (brick 0bac6a00). A prune
    // sweeps harness config dirs under a root NO HOME scopes, so an isolated
    // store is not isolation here. Checking process.env instead would measure
    // the runner, one inheritance step away from the process that sweeps.
    scopeHarnessConfigDirRootForCli(args, env, options.home);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
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
  await withTempHomeFixture("acpx-deletion-manifest-test-", run);
}

function sessionDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

function manifestPath(homeDir: string): string {
  return path.join(sessionDir(homeDir), "deletions.ndjson");
}

function safe(id: string): string {
  return encodeURIComponent(id);
}

function streamPath(homeDir: string, id: string): string {
  return path.join(sessionDir(homeDir), `${safe(id)}.stream.ndjson`);
}

function timestampsPath(homeDir: string, id: string): string {
  return path.join(sessionDir(homeDir), `${safe(id)}.timestamps.ndjson`);
}

function ownerLogPath(homeDir: string, id: string): string {
  return path.join(sessionDir(homeDir), `${safe(id)}.owner.log`);
}

type ManifestLine = {
  v?: number;
  op?: string;
  phase?: string;
  at?: string;
  box?: string;
  covers?: string[];
  agent?: string;
  invoker?: string | null;
  scope?: Record<string, unknown>;
  id?: string;
  name?: string;
  cwd?: string;
  createdAt?: string;
  closedAt?: string;
  classes?: string[];
};

/** Reads the manifest as parsed lines. Returns `[]` when the file does not
 *  exist — which is a real state (nothing has ever been deleted) and is what the
 *  current-build half of every transition below observes. */
async function readManifest(homeDir: string): Promise<ManifestLine[]> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(homeDir), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ManifestLine);
}

function entriesOf(lines: ManifestLine[]): ManifestLine[] {
  return lines.filter((line) => line.op !== "manifest_open");
}

function headersOf(lines: ManifestLine[]): ManifestLine[] {
  return lines.filter((line) => line.op === "manifest_open");
}

type FixtureOptions = {
  closed?: boolean;
  name?: string;
  template?: SessionRecord["template"];
  /** Write the acpx-ui-owned timestamps sidecar alongside the stream. */
  timestamps?: boolean;
  /** Write an owner log. */
  ownerLog?: boolean;
  streamBytes?: number;
};

async function seedSession(
  homeDir: string,
  id: string,
  cwd: string,
  options: FixtureOptions = {},
): Promise<void> {
  const closedAt = "2026-07-24T04:39:56.000Z";
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
  const dir = sessionDir(homeDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${safe(id)}.messages.ndjson`), `sidecar for ${id}\n`, "utf8");
  if (options.streamBytes !== 0) {
    await fs.writeFile(streamPath(homeDir, id), "x".repeat(options.streamBytes ?? 64), "utf8");
  }
  if (options.timestamps !== false) {
    await fs.writeFile(timestampsPath(homeDir, id), `{"offset":0,"ts":1}\n`, "utf8");
  }
  if (options.ownerLog !== false) {
    await fs.writeFile(ownerLogPath(homeDir, id), `owner log for ${id}\n`, "utf8");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// RIDER 3 — the name is structurally un-sweepable, PROVEN against the sweeper
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ THIS TEST IS THE CONTROL, and a naming convention is not one.
 *
 * The manifest lives in the same directory acpx's index rebuild sweeps for
 * session records. That sweep is `name.endsWith(".json") && name !== "index.json"`,
 * and the live store proves what it costs to be caught by it: 200
 * `<id>.delivery.json` files are ingested and discarded on every rebuild.
 *
 * So the requirement is not "we picked a name that looks different" — it is
 * "the real sweeper, run for real, does not pick this file up". This test runs
 * the PRODUCTION rebuild path (triggered by deleting index.json, exactly as
 * happens in the field) and reads the rebuilt `index.files` back off disk.
 *
 * The `.delivery.json` decoy is the POSITIVE CONTROL, and it is the one that
 * makes the assertion mean something: it proves the sweeper in this very run
 * DOES ingest a non-record file whose name ends in `.json` — so "deletions.ndjson
 * is absent" reports the name, not a sweeper that swept nothing.
 */
test("rider 3: the real index rebuild does not sweep up deletions.ndjson", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "rebuild-survivor", workCwd, { closed: false });
    await seedSession(homeDir, "rebuild-victim", workCwd);

    const dir = sessionDir(homeDir);
    // Positive control: a non-record file that DOES end in `.json`. acpx-ui
    // writes 200 of these into the real store, and the sweeper ingests every
    // one of them.
    await fs.writeFile(path.join(dir, "decoy.delivery.json"), "{}\n", "utf8");
    await fs.rm(path.join(dir, "index.json"), { force: true });

    // A real prune: it WRITES the manifest and then runs the production
    // `rebuildSessionIndex(sessionDir, "prune")` over the directory that now
    // contains it. Nothing here is simulated.
    const pruned = await runCli(["claude", "sessions", "prune", "rebuild-victim"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(pruned.code, 0, pruned.stderr);
    assert.equal(
      await fileExists(manifestPath(homeDir)),
      true,
      "the manifest must exist for this test to be about anything",
    );

    const index = JSON.parse(await fs.readFile(path.join(dir, "index.json"), "utf8")) as {
      files: string[];
    };

    // The control fires: the sweeper really is ingesting `.json` non-records in
    // THIS run. Without it, "deletions.ndjson is absent" is indistinguishable
    // from a sweeper that swept nothing.
    assert.ok(
      index.files.includes("decoy.delivery.json"),
      `the sweeper ingested nothing .json-suffixed, so this test proves nothing: ${JSON.stringify(index.files)}`,
    );
    assert.ok(index.files.includes("rebuild-survivor.json"), "a real record must be indexed");

    // The property under test.
    assert.ok(
      !index.files.includes("deletions.ndjson"),
      `the deletion manifest was swept up as a session record: ${JSON.stringify(index.files)}`,
    );
  });
});

/** The same property one level down, stated as the arithmetic the name rests on.
 *  If someone renames the manifest to anything `.json`-suffixed, this fails with
 *  a message that says why, before the behavioural test above even runs. */
test("rider 3: the manifest name does not satisfy the sweeper's predicate", async () => {
  const sweptUp = (name: string): boolean => name.endsWith(".json") && name !== "index.json";
  assert.equal(sweptUp("deletions.ndjson"), false);
  // Controls in both directions, so a predicate that answered `false` to
  // everything could not pass this.
  assert.equal(sweptUp("4e25443c-aa01.json"), true);
  assert.equal(sweptUp("decoy.delivery.json"), true);
  assert.equal(sweptUp("index.json"), false);
});

// ───────────────────────────────────────────────────────────────────────────
// RIDER 2 — the Commander declaration-order trap, at the layer where it EXISTS
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ READ THIS BEFORE ASSUMING THE BEHAVIOURAL TESTS COVER THE FLAG SURFACE.
 * THEY DO NOT COVER THE DECLARATION ORDER, AND THAT IS MEASURED.
 *
 * The conception specified two mitigations for the trap, "belt and braces, both
 * required": register `--no-include-history` FIRST, and read `!== false` (never
 * `=== true`) in the handler. Running each named mutation against the whole
 * behavioural suite produced **ZERO reds**:
 *
 *   M-F1 (swap the two `.option()` calls)              -> 0 reds
 *   M-F2 (`!== false` becomes `=== true`)              -> 0 reds
 *   M-F1 + M-F2 together                               -> reds T-F1 (see below)
 *
 * The two mitigations are not independent — they are REDUNDANT, and either one
 * alone is sufficient:
 *
 *   - correct order + `=== true`  : bare parses to `true`, `true === true`  -> delete
 *   - swapped order + `!== false` : bare parses to `undefined`,
 *                                   `undefined !== false`                   -> delete
 *   - swapped order + `=== true`  : bare parses to `undefined`,
 *                                   `undefined === true` is FALSE           -> STRAND
 *
 * So the behavioural suite genuinely can catch the real defect, but only when
 * both mitigations are gone. Each alone is unobservable in behaviour, which is
 * why the declaration order needs pinning at the layer where it actually
 * exists: the parse.
 *
 * This is NOT an assertion about the order of two lines of source — that would
 * be a convention check, and a convention is not a control. It drives the REAL
 * `registerSessionsCommand` and asserts the OUTCOME the order exists to
 * produce: a bare prune parses to `includeHistory === true`, not `undefined`.
 * That is what protects a future reader who writes `=== true` — precisely the
 * mistake the conception predicted an implementer would make.
 */
test("rider 2: a bare prune parses includeHistory as true, not undefined", async () => {
  const { Command } = await import("commander");
  const { registerSessionsCommand } = await import("../src/cli/command-registration.js");

  const parseFlags = (argv: string[]): Record<string, unknown> => {
    const program = new Command();
    program.exitOverride();
    let captured: Record<string, unknown> | undefined;
    registerSessionsCommand(program, "claude", {
      defaultAgent: "claude",
      defaultPermissions: "approve-reads",
      nonInteractivePermissions: "deny",
      authPolicy: "skip",
      ttlMs: 300_000,
      queueMaxDepth: 16,
      format: "text",
      agents: {},
      auth: {},
      disableExec: false,
      mcpServers: [],
      subscriptions: { subscriptions: [] },
      globalPath: "/tmp/global-config.json",
      projectPath: "/tmp/project-config.json",
      hasGlobalConfig: false,
      hasProjectConfig: false,
    });
    const sessions = program.commands.find((c) => c.name() === "sessions");
    assert.ok(sessions, "sessions command not registered");
    const prune = sessions.commands.find((c) => c.name() === "prune");
    assert.ok(prune, "prune command not registered");
    // Replace the action so parsing never executes a real prune.
    prune.action((_ids: string[], flags: Record<string, unknown>) => {
      captured = flags;
    });
    // `from: "user"` means argv carries no node/script prefix.
    program.parse(["sessions", "prune", ...argv], { from: "user" });
    assert.ok(captured, "the prune action never ran");
    return captured;
  };

  // THE ONE THAT REDS UNDER M-F1, and the only thing that does.
  assert.equal(
    parseFlags([]).includeHistory,
    true,
    "a bare prune must parse includeHistory as an explicit true — if this is " +
      "undefined, the two .option() registrations have been swapped, and a " +
      "future `=== true` reader will silently strand every stream",
  );

  // Both directions, so a registration that always yielded `true` could not pass.
  assert.equal(parseFlags(["--include-history"]).includeHistory, true);
  assert.equal(parseFlags(["--no-include-history"]).includeHistory, false);
});

// ───────────────────────────────────────────────────────────────────────────
// T-M · the manifest
// ───────────────────────────────────────────────────────────────────────────

/** T-M1 — the manifest is complete across BOTH deleters. A prune-only manifest
 *  would not have covered its own motivating case: the RCA's three baker nights
 *  were destroyed by `templates rollback --delete`, not by a prune. */
test("T-M1: both deleters write to the manifest, and a run that deletes nothing writes nothing", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });

    // POSITIVE CONTROL FIRST, on the same instrument: a prune that matches zero
    // sessions must write zero lines — so the writer is driven by the deleted
    // set, not by being called. Run before anything exists, so the file does
    // not either.
    const empty = await runCli(["claude", "sessions", "prune", "--cwd"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal((await readManifest(homeDir)).length, 0, "an empty prune wrote to the manifest");
    assert.equal(await fileExists(manifestPath(homeDir)), false);

    for (const id of ["pruned-a", "pruned-b", "pruned-c"]) {
      await seedSession(homeDir, id, workCwd);
    }
    await seedSession(homeDir, "tmpl-victim", workCwd, {
      template: {
        slug: "intaker-candidate",
        version: 1,
        enabled: true,
        created_at: "2026-07-24T04:30:00.000Z",
      },
    });
    await fs.rm(path.join(sessionDir(homeDir), "index.json"), { force: true });

    const pruned = await runCli(
      ["claude", "sessions", "prune", "pruned-a", "pruned-b", "pruned-c"],
      { home: homeDir, cwd: workCwd },
    );
    assert.equal(pruned.code, 0, pruned.stderr);

    const rolled = await runCli(
      ["claude", "sessions", "templates", "rollback", "intaker-candidate", "--delete"],
      { home: homeDir, cwd: workCwd },
    );
    assert.equal(rolled.code, 0, rolled.stderr);

    const lines = await readManifest(homeDir);
    assert.equal(headersOf(lines).length, 1, "exactly one header");
    const entries = entriesOf(lines);
    assert.equal(entries.length, 4, `expected 4 entries, got ${JSON.stringify(entries)}`);
    assert.equal(entries.filter((e) => e.op === "sessions_prune").length, 3);
    assert.equal(entries.filter((e) => e.op === "templates_rollback_delete").length, 1);

    // The shape, pinned — M-M8 changes `phase` and must red here.
    for (const entry of entries) {
      assert.equal(entry.v, 1);
      assert.equal(
        entry.phase,
        "begin",
        "an entry records an AUTHORISED AND BEGUN deletion, never a completed one",
      );
      assert.ok(entry.at, "every entry is dated");
      assert.ok(entry.id, "every entry names its session");
      assert.equal(entry.cwd, workCwd);
      assert.ok(Array.isArray(entry.classes) && entry.classes.length > 0);
    }

    // The rollback entry carries the identity the index alone could not supply:
    // SessionIndexEntry has no createdAt/closedAt, so these prove the record was
    // loaded before it was unlinked.
    const rollbackEntry = entries.find((e) => e.op === "templates_rollback_delete");
    assert.ok(rollbackEntry);
    assert.equal(rollbackEntry.id, "tmpl-victim");
    assert.equal(rollbackEntry.name, "tmpl-victim");
    assert.equal(rollbackEntry.createdAt, "2026-07-24T04:30:00.000Z");
    assert.equal(rollbackEntry.closedAt, "2026-07-24T04:39:56.000Z");
    // No agent/scope on this path — it has neither, and absent means
    // "not applicable" rather than "unknown".
    assert.equal(rollbackEntry.agent, undefined);
    assert.equal(rollbackEntry.scope, undefined);

    // A1: the promise of the whole brick — one grep answers "what happened to
    // this session", including WHICH DELETER RAN, which the file-shape residue
    // could never resolve.
    const pruneEntry = entries.find((e) => e.id === "pruned-a");
    assert.ok(pruneEntry);
    assert.equal(pruneEntry.op, "sessions_prune");
    assert.equal(pruneEntry.agent, "claude");
    assert.deepEqual(pruneEntry.scope, { sessionIds: ["pruned-a", "pruned-b", "pruned-c"] });
  });
});

/** T-M2 — a dry run records NOTHING, in both directions. Neither a
 *  never-writing nor an always-writing manifest passes this. */
test("T-M2: a dry run records nothing; the same fixture without --dry-run records every session", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    for (const id of ["dry-a", "dry-b"]) {
      await seedSession(homeDir, id, workCwd);
    }

    const dry = await runCli(["claude", "sessions", "prune", "--dry-run", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(entriesOf(await readManifest(homeDir)).length, 0, "a dry run wrote an audit line");
    assert.equal(await fileExists(sessionFilePath(homeDir, "dry-a")), true);

    const real = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(real.code, 0, real.stderr);
    assert.equal(entriesOf(await readManifest(homeDir)).length, 2);
    assert.equal(await fileExists(sessionFilePath(homeDir, "dry-a")), false);
  });
});

/**
 * T-M3 — a prune that cannot be recorded does not happen, AND THE INJECTION IS
 * VERIFIED TO HAVE FIRED.
 *
 * ⚠️ The injection is a DIRECTORY at the manifest path, not a `chmod`. A
 * `chmod 500` fails to fire in two ways at once here — the suite may run as
 * root, and a mode change on a directory does not affect an already-open handle
 * — and a fault injection that does not fire manufactures a green nobody
 * earned. `open(dir, "a")` returns EISDIR for every uid, always, at the real
 * seam in the real writer, with no test-only code path in production.
 *
 * (The conception specified a test-supplied writer that throws. This is a
 * deliberate, reported substitution: it exercises the SHIPPED writer instead of
 * a stand-in, and it needs no injectable seam in `PruneOptions` — which would
 * itself be a way to call `pruneSessions` with the audit disabled.)
 *
 * Asserting the injection fired is part of the test: the cause reaches the
 * operator, every record survives, and the exit code is 1.
 */
test("T-M3: a manifest write failure aborts the prune with nothing deleted", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    for (const id of ["abort-a", "abort-b"]) {
      await seedSession(homeDir, id, workCwd);
    }
    await fs.mkdir(manifestPath(homeDir), { recursive: true });

    const failed = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });

    // The injection fired, and it fired where it was aimed.
    assert.equal(failed.code, 1, `expected exit 1, got ${failed.code}: ${failed.stderr}`);
    assert.match(failed.stderr, /EISDIR/, "the real cause must reach the operator");
    assert.match(
      failed.stderr,
      /^acpx sessions prune: could not record this deletion — nothing was pruned\.$/m,
    );
    // ⚠️ This assertion USED to demand the disk-full line here, and that was the
    // F5 defect in miniature: the injection is EISDIR, and the refusal was
    // telling the operator to free bytes. The remedy now branches on the real
    // errno; the executable proof that it recovers them is in the F5 tests.
    assert.ok(
      failed.stderr.includes(
        `${manifestPath(homeDir)} is a directory, not a file — remove it, then re-run prune.`,
      ),
      `wrong remedy for an EISDIR failure:\n${failed.stderr}`,
    );
    assert.doesNotMatch(failed.stderr, /Free a few bytes/);

    // Nothing was destroyed. This is the claim.
    for (const id of ["abort-a", "abort-b"]) {
      assert.equal(await fileExists(sessionFilePath(homeDir, id)), true, `${id} was deleted`);
      assert.equal(await fileExists(ownerLogPath(homeDir, id)), true);
      assert.equal(await fileExists(streamPath(homeDir, id)), true);
    }

    // POSITIVE CONTROL, same fixture, working writer: they really were
    // deletable, so the survival above is the abort and not an inert harness.
    await fs.rm(manifestPath(homeDir), { recursive: true, force: true });
    const ok = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(ok.code, 0, ok.stderr);
    for (const id of ["abort-a", "abort-b"]) {
      assert.equal(await fileExists(sessionFilePath(homeDir, id)), false);
    }
  });
});

/**
 * ⚠️ M-S5 IS DELIBERATELY UNGUARDED, and this note is why — a vacuous test used
 * to sit here.
 *
 * The claim M-S5 attacks is that both handlers must catch
 * `DeletionManifestWriteError` BY TYPE and re-throw anything else, because a
 * bare `catch` on a destructive path would report an unrelated failure as an
 * audit failure and send the operator at the wrong problem.
 *
 * MEASURED: the mutation (`instanceof DeletionManifestWriteError` ->
 * `instanceof Error`) builds cleanly and reds NOTHING, because within
 * `handleSessionsPrune`'s try block the only reachable throws today are
 * `PruneAborted` — handled by the branch above it — and
 * `DeletionManifestWriteError` itself. Everything else on that path is already
 * swallowed locally: `loadPrunableRecords` skips an unparseable record,
 * `unlinkCountingBytes` catches every unlink error, `rebuildSessionIndex` is
 * `.catch()`ed.
 *
 * The first attempt at a guard here replaced a record file with a DIRECTORY and
 * asserted the output was not an audit failure. Probed directly, that injection
 * produces NO ERROR AT ALL — the record is skipped and prune prints "No sessions
 * pruned" — so the assertion held whatever the catch looked like. A fault
 * injection that does not fire manufactures a green nobody earned, so the test
 * was removed rather than kept as decoration.
 *
 * The typed catch stays because it is correct and costs one line; it is
 * defence-in-depth against a FUTURE throw on this path, not a live guard. If
 * you add one, this is the test to write.
 */

/**
 * F5 — THE REFUSAL'S REMEDY MUST ACTUALLY RECOVER THE OPERATOR.
 *
 * ⚠️ ASSERTED BY EXECUTION, NOT INSPECTION, because that is how the defect was
 * found and it is the only method that could have found it. The refusal printed
 * hard-coded ENOSPC advice ("Free a few bytes…") for EVERY manifest failure; a
 * test-engineer followed that advice from the refused state — created a file in
 * the store, unlinked it, re-ran — and measured rc=1 with all 15 files still
 * present. Every string-shaped check passed the whole time. Aborting is only
 * humane if the operator has a way out, so the way out is what gets tested.
 *
 * This is the THIRD instance of "a refusal teaching a remedy that does not work"
 * in this lane (the `session_open` advice; the `without --delete` trap; this).
 * If you add a fourth refusal, execute its advice here before believing it.
 */
test("F5: the manifest-failure remedy recovers the operator (EISDIR), executed not inspected", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "remedy-eisdir", workCwd);
    await fs.mkdir(manifestPath(homeDir), { recursive: true });

    const refused = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /EISDIR/);
    // It must NOT hand out the disk-full remedy for a non-disk-full fault.
    assert.doesNotMatch(
      refused.stderr,
      /Free a few bytes/,
      "ENOSPC advice was printed for a non-ENOSPC failure",
    );
    // And the remedy names the PATH the operator has to act on.
    assert.ok(
      refused.stderr.includes(
        `${manifestPath(homeDir)} is a directory, not a file — remove it, then re-run prune.`,
      ),
      `remedy did not name the path:\n${refused.stderr}`,
    );
    assert.equal(await fileExists(sessionFilePath(homeDir, "remedy-eisdir")), true);

    // EXECUTE THE PRINTED ADVICE, then re-run. This is the assertion.
    await fs.rm(manifestPath(homeDir), { recursive: true, force: true });
    const recovered = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(
      recovered.code,
      0,
      `following the printed remedy did not recover the operator: ${recovered.stderr}`,
    );
    assert.equal(await fileExists(sessionFilePath(homeDir, "remedy-eisdir")), false);
    assert.equal(entriesOf(await readManifest(homeDir)).length, 1);
  });
});

/**
 * F5's PRODUCTION-REACHABLE case: EACCES, not disk-full.
 *
 * The manifest is long-lived. Create it once under another uid — a root-run
 * acpx, a bootstrap quirk — and EVERY later agent prune fails forever while
 * being told to free space. Strictly worse than ENOSPC, which self-resolves.
 *
 * This also falsifies conception §4.1.1 reason #1 ("a store where the manifest
 * write fails for permission reasons is a store where prune could not have
 * deleted anything anyway"): `unlink` needs write on the DIRECTORY, this write
 * needs write on the FILE. The test proves the directory writable in the same
 * run that watches prune refuse, so the two permissions are visibly distinct
 * rather than argued about. The manifest's LOCATION is still right; the premise
 * offered for it was not.
 *
 * ⚠️ The `chmod` injection cannot fire as root — but it does not fail SILENTLY
 * there: the prune would succeed and the `code === 1` assertion would go red,
 * which is the direction to want. Measured at uid 1000: `open(0444, "a")` gives
 * EACCES.
 */
test("F5: an unwritable manifest in a writable directory refuses, and its remedy recovers (EACCES)", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "remedy-eacces", workCwd);

    // A pre-existing manifest this user cannot append to.
    await fs.writeFile(manifestPath(homeDir), `{"v":1,"op":"manifest_open"}\n`, "utf8");
    await fs.chmod(manifestPath(homeDir), 0o444);

    const refused = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(
      refused.code,
      1,
      `expected a refusal — if this ran as root the chmod could not fire: ${refused.stderr}`,
    );
    assert.match(refused.stderr, /EACCES/, "the injection did not fire");
    assert.doesNotMatch(
      refused.stderr,
      /Free a few bytes/,
      "the operator was told to free disk space for a permissions fault",
    );
    assert.ok(
      refused.stderr.includes(
        `Make ${manifestPath(homeDir)} writable by this user (check its owner and mode), then re-run prune.`,
      ),
      `remedy did not name the path:\n${refused.stderr}`,
    );
    assert.equal(await fileExists(sessionFilePath(homeDir, "remedy-eacces")), true);

    // THE DIRECTORY IS WRITABLE THROUGHOUT — so "prune could not have deleted
    // anything anyway" is false, measured rather than asserted.
    const probe = path.join(sessionDir(homeDir), "writability-probe.tmp");
    await fs.writeFile(probe, "the directory is writable\n", "utf8");
    await fs.rm(probe);

    // EXECUTE THE PRINTED ADVICE: make it writable, re-run.
    await fs.chmod(manifestPath(homeDir), 0o644);
    const recovered = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(
      recovered.code,
      0,
      `following the printed remedy did not recover the operator: ${recovered.stderr}`,
    );
    assert.equal(await fileExists(sessionFilePath(homeDir, "remedy-eacces")), false);
  });
});

/**
 * F5 — THE DISK-FULL CASE, AND IT FAILS AT A DIFFERENT SEAM.
 *
 * ⚠️ THIS IS THE ONE THE OTHER TWO CANNOT REACH. EISDIR and EACCES both fail at
 * `open`. True disk-full does NOT: `open(path,"ax")` returns EEXIST (the header
 * is skipped, exactly as on any store whose manifest already exists), then
 * `open(path,"a")` SUCCEEDS and the **write** returns ENOSPC. So a
 * classification that only inspected open-time errors would miss the disk-full
 * case entirely — and disk-full is the one class whose advice was already
 * correct, so missing it would silently regress the only branch that worked.
 *
 * `appendDeletionManifest` wraps the open AND the write loop in one `try`, which
 * is what makes the errno reach the remedy from either seam. That was true
 * before this test existed and untested; this is the pin.
 *
 * Injection: a symlink to `/dev/full`, which accepts writes and reports ENOSPC.
 * Measured here — `ax` -> EEXIST, `a` -> ok, `write` -> "ENOSPC: no space left
 * on device, write".
 *
 * ⚠️ SCOPE OF THIS TEST, stated rather than implied: it pins CLASSIFICATION and
 * NON-DESTRUCTION. It does NOT execute the printed remedy, because /dev/full
 * cannot be "freed" — the literal advice is unperformable against this
 * injection. That ENOSPC advice genuinely RECOVERS an operator is the TE's
 * measurement on a real constrained filesystem (both verbs, recovered=YES); it
 * is not re-derived here. The two F5 tests above execute their advice; this one
 * cannot, and says so.
 */
test("F5: disk-full is classified from the WRITE seam, not just the open seam", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "enospc-victim", workCwd);

    await fs.symlink("/dev/full", manifestPath(homeDir));

    const refused = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });

    assert.equal(refused.code, 1, `expected a refusal: ${refused.stderr}`);
    // The injection fired, AND it fired at the write seam — the trailing
    // ", write" is what distinguishes this from an open-time failure.
    assert.match(
      refused.stderr,
      /ENOSPC: no space left on device, write/,
      "the write seam did not fire",
    );
    // The disk-full remedy is the one that was already right. It must survive
    // the introduction of branching unchanged.
    assert.match(
      refused.stderr,
      /^Free a few bytes on that filesystem \(any single file will do\), then re-run prune\.$/m,
    );
    // Nothing destroyed.
    assert.equal(await fileExists(sessionFilePath(homeDir, "enospc-victim")), true);
    assert.equal(await fileExists(ownerLogPath(homeDir, "enospc-victim")), true);
    assert.equal(await fileExists(streamPath(homeDir, "enospc-victim")), true);

    // Control: the store is otherwise healthy, so the refusal is the manifest's
    // doing and not a broken fixture.
    await fs.unlink(manifestPath(homeDir));
    const recovered = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(await fileExists(sessionFilePath(homeDir, "enospc-victim")), false);
  });
});

/** The same seam on the rollback verb, since §4.5(h) carried the identical
 *  assumption and the fix has to hold on both. */
test("F5: the rollback verb also classifies disk-full from the write seam", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "enospc-rb", workCwd, {
      template: {
        slug: "enospc-slug",
        version: 1,
        enabled: true,
        created_at: "2026-07-24T04:30:00.000Z",
      },
    });
    await fs.symlink("/dev/full", manifestPath(homeDir));

    const refused = await runCli(
      ["claude", "sessions", "templates", "rollback", "enospc-slug", "--delete"],
      { home: homeDir, cwd: workCwd },
    );
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /ENOSPC: no space left on device, write/);
    assert.ok(
      refused.stderr.includes(
        "Free a few bytes on that filesystem (any single file will do), then re-run the rollback. The slug is untouched, so nothing needs undoing first.",
      ),
      `wrong remedy for disk-full on the rollback path:\n${refused.stderr}`,
    );
    assert.equal(await fileExists(sessionFilePath(homeDir, "enospc-rb")), true);
  });
});

/** The remedy selector itself, over the errno values the end-to-end tests above
 *  cannot deterministically produce (ENOSPC, EROFS) plus the unknown-errno
 *  fallback. Every branch must name the path, and none but ENOSPC may talk about
 *  free space — the default arm is the one that regressed. */
test("F5: every remedy branch names the path, and only ENOSPC talks about free space", async () => {
  const { manifestFailureRemedy } = await import("../src/session/persistence.js");
  const target = "/home/node/.acpx/sessions/deletions.ndjson";
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  assert.match(manifestFailureRemedy(err("ENOSPC"), target, "prune"), /Free a few bytes/);

  for (const code of ["EACCES", "EPERM", "EISDIR", "EROFS", "ENOTSUP", "SOMETHING_NEW"]) {
    const remedy = manifestFailureRemedy(err(code), target, "prune");
    assert.ok(remedy.includes(target), `${code} remedy does not name the path: ${remedy}`);
    assert.doesNotMatch(
      remedy,
      /Free a few bytes/,
      `${code} was given the disk-full remedy — the exact defect F5 fixes`,
    );
    // Prune's token rule reaches every status line, remedies included.
    assert.match(remedy, /prune/i, `${code} remedy loses the prune token: ${remedy}`);
  }

  // An error carrying no `code` at all still gets actionable, path-naming advice.
  const bare = manifestFailureRemedy(new Error("something odd"), target, "prune");
  assert.ok(bare.includes(target));
  assert.doesNotMatch(bare, /Free a few bytes/);

  // The verb is carried, so the rollback path cannot tell an operator to re-run
  // prune — and no prune token is invented for a verb that has no token rule.
  assert.match(
    manifestFailureRemedy(err("EACCES"), target, "the rollback"),
    /then re-run the rollback\./,
  );
});

/** T-M4 — `invoker` distinguishes its two cases, in BOTH directions. A writer
 *  that always emits `null` and one that always emits the URL each pass one
 *  direction, so one direction proves nothing. */
test("T-M4: invoker records the acpx session URL, or null when there is none", async () => {
  const url = "https://acpx.devbox.nativai.de/?session=11111111-2222-3333-4444-555555555555";

  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "with-invoker", workCwd);

    const result = await runCli(["claude", "sessions", "prune", "with-invoker"], {
      home: homeDir,
      cwd: workCwd,
      extra: { ACPX_SESSION_URL: url },
    });
    assert.equal(result.code, 0, result.stderr);
    const entry = entriesOf(await readManifest(homeDir))[0];
    assert.equal(entry?.invoker, url);
  });

  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "no-invoker", workCwd);

    const result = await runCli(["claude", "sessions", "prune", "no-invoker"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(result.code, 0, result.stderr);

    // Read the RAW line, because `undefined` and `null` are indistinguishable
    // after a property read: `entry.invoker === null` is satisfied by a missing
    // key too. The schema says these are DIFFERENT — null is a positive
    // assertion ("no acpx session in the environment"), absent means unknown.
    // M-M6 emits it as absent and must red here.
    const raw = await fs.readFile(manifestPath(homeDir), "utf8");
    const entryLine = raw.split("\n").find((line) => line.includes(`"op":"sessions_prune"`));
    assert.ok(entryLine);
    assert.match(entryLine, /"invoker":null/, "invoker must be an explicit null, not absent");
  });
});

/** T-M5 — the header names the coverage boundary, and is written exactly once. */
test("T-M5: the header is written once, carries covers and a URL-shaped box", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "hdr-a", workCwd);
    await seedSession(homeDir, "hdr-b", workCwd);

    const first = await runCli(["claude", "sessions", "prune", "hdr-a"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(first.code, 0, first.stderr);

    const afterFirst = await readManifest(homeDir);
    assert.equal(headersOf(afterFirst).length, 1);
    const header = headersOf(afterFirst)[0];
    assert.equal(header.v, 1);
    assert.ok(header.at, "the header dates the coverage boundary");
    // `covers` is the point of the header: without it, "I grepped and found
    // nothing" cannot distinguish "acpx did not delete it" from "deleted before
    // this file existed" from "deleted by a path this never covered".
    assert.deepEqual(header.covers, ["sessions_prune", "templates_rollback_delete"]);

    // M-M9 sources `box` from os.hostname(), which on a dev box is the EPHEMERAL
    // POD NAME — a machine that stops existing on the next restart, in the one
    // artifact whose whole job is provenance. Assert it parses as a URL, which a
    // bare hostname does not.
    assert.ok(header.box, "the header names the box that wrote it");
    assert.doesNotThrow(
      () => new URL(header.box as string),
      `box must be a base URL, not a hostname: ${header.box}`,
    );

    const second = await runCli(["claude", "sessions", "prune", "hdr-b"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(second.code, 0, second.stderr);

    const afterSecond = await readManifest(homeDir);
    assert.equal(headersOf(afterSecond).length, 1, "a second header was written");
    // Control for the "exactly one" claim: the second run DID write, so
    // "no second header" is not "the second run did nothing".
    assert.equal(entriesOf(afterSecond).length, 2);
  });
});

/**
 * T-M6 — the header race, AND ONLY THE HEADER RACE.
 *
 * ⚠️ Deliberately NOT a general concurrency claim. `fs.open(path, "ax")` really
 * does guarantee exactly-one-creator, and that is what this asserts. It does NOT
 * assert that concurrent whole-box prunes cannot interleave mid-line: per-line
 * writes make that very unlikely, but racing prunes are an unsupported,
 * unfixed pre-existing condition, and a test that passes because the race did
 * not happen is a green nobody earned. Do not upgrade this on the strength of
 * one passing run.
 */
test("T-M6: two concurrent prunes produce exactly one header and no torn lines", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    for (const id of ["race-a", "race-b"]) {
      await seedSession(homeDir, id, workCwd);
    }

    const [a, b] = await Promise.all([
      runCli(["claude", "sessions", "prune", "race-a"], { home: homeDir, cwd: workCwd }),
      runCli(["claude", "sessions", "prune", "race-b"], { home: homeDir, cwd: workCwd }),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);

    // Parses at all => no torn lines. `readManifest` JSON.parses every line and
    // throws otherwise, so this assertion is load-bearing rather than incidental.
    const lines = await readManifest(homeDir);
    assert.equal(headersOf(lines).length, 1, "the ax-open header race let a second header through");
    assert.equal(entriesOf(lines).length, 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T-F4 / T-F5 · the deletion set's two new classes, TIERED
// ───────────────────────────────────────────────────────────────────────────

/** T-F4 — `.owner.log` is RECORD tier: it goes even when history is kept. The
 *  stream surviving in the same run is the positive control — it shows the
 *  instrument can watch a file NOT disappear. */
test("T-F4: the owner log goes with the record, even under --no-include-history", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "tier-owner", workCwd);

    assert.equal(await fileExists(ownerLogPath(homeDir, "tier-owner")), true);
    const result = await runCli(
      ["claude", "sessions", "prune", "tier-owner", "--no-include-history"],
      { home: homeDir, cwd: workCwd },
    );
    assert.equal(result.code, 0, result.stderr);

    assert.equal(
      await fileExists(ownerLogPath(homeDir, "tier-owner")),
      false,
      "the owner log follows the RECORD, not the history",
    );
    // Positive control, same run, same helper: history really was kept.
    assert.equal(await fileExists(streamPath(homeDir, "tier-owner")), true);

    const classes = entriesOf(await readManifest(homeDir))[0]?.classes;
    assert.deepEqual(classes, ["record", "messages", "owner"]);
  });
});

/** T-F5 — `.timestamps.ndjson` is HISTORY tier: it follows the STREAM, in both
 *  directions. It is acpx-ui's file, and the ownership argument that licenses
 *  deleting it is precisely that it is an index OF the stream — so if the stream
 *  stays, it stays. M-C2 (always delete it) reds direction (b). */
test("T-F5: the timestamps sidecar follows the stream, in both directions", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "tier-ts-default", workCwd);

    const defaulted = await runCli(["claude", "sessions", "prune", "tier-ts-default"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(defaulted.code, 0, defaulted.stderr);
    assert.equal(await fileExists(streamPath(homeDir, "tier-ts-default")), false);
    assert.equal(
      await fileExists(timestampsPath(homeDir, "tier-ts-default")),
      false,
      "(a) with the stream deleted, its index must go too",
    );
    assert.deepEqual(entriesOf(await readManifest(homeDir))[0]?.classes, [
      "record",
      "messages",
      "stream",
      "timestamps",
      "owner",
    ]);
  });

  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "tier-ts-kept", workCwd);

    const kept = await runCli(
      ["claude", "sessions", "prune", "tier-ts-kept", "--no-include-history"],
      { home: homeDir, cwd: workCwd },
    );
    assert.equal(kept.code, 0, kept.stderr);
    assert.equal(await fileExists(streamPath(homeDir, "tier-ts-kept")), true);
    assert.equal(
      await fileExists(timestampsPath(homeDir, "tier-ts-kept")),
      true,
      "(b) keep the stream and its index stays with it",
    );
  });
});

/** T-F6 — a template blueprint spared by a prune keeps its NEW-class files too.
 *  The non-template fixture in the same run is the positive control: its files
 *  of the same classes go present -> absent, so "the blueprint's survived" is
 *  not "the prune deleted nothing". */
test("T-F6: a spared blueprint keeps its owner log and timestamps sidecar", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "protected-bp", workCwd, {
      template: {
        slug: "kept-slug",
        version: 1,
        enabled: true,
        created_at: "2026-07-24T04:30:00.000Z",
      },
    });
    await seedSession(homeDir, "plain-one", workCwd);

    const result = await runCli(["claude", "sessions", "prune", "--whole-box"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await fileExists(sessionFilePath(homeDir, "protected-bp")), true);
    assert.equal(await fileExists(ownerLogPath(homeDir, "protected-bp")), true);
    assert.equal(await fileExists(timestampsPath(homeDir, "protected-bp")), true);

    // Positive control in the same run.
    assert.equal(await fileExists(sessionFilePath(homeDir, "plain-one")), false);
    assert.equal(await fileExists(ownerLogPath(homeDir, "plain-one")), false);
    assert.equal(await fileExists(timestampsPath(homeDir, "plain-one")), false);

    // And the manifest records only what was actually destroyed.
    const entries = entriesOf(await readManifest(homeDir));
    assert.deepEqual(
      entries.map((e) => e.id),
      ["plain-one"],
    );
  });
});

/** The rollback path takes the new classes too. Without this, `templates
 *  rollback --delete` would keep producing exactly the `--T--` shape the RCA
 *  read as ambiguous — the shape this whole change exists to stop creating. */
test("T-M1 sibling: templates rollback --delete leaves no owner log or timestamps sidecar", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "rb-victim", workCwd, {
      template: {
        slug: "rb-slug",
        version: 1,
        enabled: true,
        created_at: "2026-07-24T04:30:00.000Z",
      },
    });

    const result = await runCli(
      ["claude", "sessions", "templates", "rollback", "rb-slug", "--delete"],
      { home: homeDir, cwd: workCwd },
    );
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await fileExists(sessionFilePath(homeDir, "rb-victim")), false);
    assert.equal(await fileExists(streamPath(homeDir, "rb-victim")), false);
    assert.equal(
      await fileExists(ownerLogPath(homeDir, "rb-victim")),
      false,
      "the RCA's three baker nights survived as exactly this file",
    );
    assert.equal(
      await fileExists(timestampsPath(homeDir, "rb-victim")),
      false,
      "and as exactly this one",
    );
    // The messages sidecar. Omitted originally, and that omission WAS the hole:
    // dropping the two messages-log unlinks from `unlinkHardDeletedFiles` — the
    // shape a "consolidate the messages-log handling" refactor produces — left
    // this file on disk while the entry below still claimed "messages", and NO
    // test in ANY suite went red. M-OC-B is that mutation.
    assert.equal(
      await fileExists(path.join(sessionDir(homeDir), "rb-victim.messages.ndjson")),
      false,
      "the messages sidecar survived a rollback that recorded having taken it",
    );

    // ⚠️ THE ENTRY'S `classes` MUST MATCH WHAT WAS ACTUALLY ATTEMPTED — asserted
    // exactly, not by shape. §4.3.2 claims the manifest "never over-claims", and
    // until this assertion existed that claim rested on the array and the unlink
    // sequence happening to derive from one helper. That is a CONSTRUCTION, and
    // a construction is only a control while it holds: a refactor separating
    // them makes the manifest lie about a deletion it did not perform, which is
    // the precise failure mode this brick exists to end.
    //
    // Both directions are pinned by mutation — M-OC-B makes the array OVER-claim
    // (files survive, entry still lists them) and M-OC-A makes it UNDER-claim
    // (`deletedFileClasses(false)`) — and a `length > 0` shape check passed
    // both. This is the rollback-path counterpart of what T-F4 and T-F5 already
    // assert for prune.
    const entry = entriesOf(await readManifest(homeDir))[0];
    assert.equal(entry?.op, "templates_rollback_delete");
    assert.deepEqual(entry?.classes, ["record", "messages", "stream", "timestamps", "owner"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T-S4 · the rollback failure string
// ───────────────────────────────────────────────────────────────────────────

/**
 * T-S4 — the rollback failure is RENDERED, not leaked, and it claims two states
 * because two states are at stake.
 *
 * `rollbackTemplateSlug` runs find -> retract -> find-new-latest under ONE lock
 * hold, so an operator seeing a mid-verb failure must learn both that no files
 * were deleted AND that the slug registration did not move. Asserted
 * separately, because they are separate facts.
 */
test("T-S4: a rollback that cannot be recorded prints its refusal and changes nothing", async () => {
  await withTempHome(async (homeDir) => {
    const workCwd = path.join(homeDir, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(homeDir, "ts4-victim", workCwd, {
      template: {
        slug: "ts4-slug",
        version: 1,
        enabled: true,
        created_at: "2026-07-24T04:30:00.000Z",
      },
    });
    await fs.mkdir(manifestPath(homeDir), { recursive: true });

    const failed = await runCli(
      ["claude", "sessions", "templates", "rollback", "ts4-slug", "--delete"],
      { home: homeDir, cwd: workCwd },
    );

    assert.equal(failed.code, 1, `expected exit 1, got ${failed.code}: ${failed.stderr}`);
    assert.match(
      failed.stderr,
      /^acpx sessions templates rollback: could not record this deletion — nothing was deleted, and template 'ts4-slug' is unchanged\.$/m,
    );
    // F5: the remedy branches on the real errno rather than assuming disk-full,
    // and the trailing clause stays true whatever it was — nothing partial
    // happened, so there is genuinely nothing to undo first.
    assert.ok(
      failed.stderr.includes(
        `${manifestPath(homeDir)} is a directory, not a file — remove it, then re-run the rollback. The slug is untouched, so nothing needs undoing first.`,
      ),
      `rollback remedy did not branch on the errno:\n${failed.stderr}`,
    );
    assert.doesNotMatch(
      failed.stderr,
      /Free space on that filesystem/,
      "the rollback carried the same hard-coded ENOSPC assumption F5 removed from prune",
    );
    assert.match(failed.stderr, /EISDIR/);
    // Not a stack trace.
    assert.doesNotMatch(failed.stderr, /at Object\.|at async |\.ts:\d+:\d+/);

    // ⚠️ THE ASSERTION AN IMPLEMENTER TRIPS. "or re-run without --delete" is the
    // natural-looking disk-full remedy and it is WRONG: soft-retract calls
    // writeSessionRecordWithLifecycle, which is itself a write and fails on the
    // same full disk. A refusal teaching a remedy that does not work is exactly
    // the defect the session_open advice exists to fix. M-S3 adds it.
    assert.doesNotMatch(
      failed.stderr,
      /without --delete/,
      "the refusal must not suggest soft-retract as a disk-full remedy — it writes too",
    );

    // (a) the record files are all still present.
    assert.equal(await fileExists(sessionFilePath(homeDir, "ts4-victim")), true);
    assert.equal(await fileExists(ownerLogPath(homeDir, "ts4-victim")), true);

    // (b) the slug still resolves to the same version — a subsequent rollback
    // still finds a target rather than reporting an empty slug.
    await fs.rm(manifestPath(homeDir), { recursive: true, force: true });
    const soft = await runCli(["claude", "sessions", "templates", "rollback", "ts4-slug"], {
      home: homeDir,
      cwd: workCwd,
    });
    assert.equal(soft.code, 0, soft.stderr);
    assert.doesNotMatch(soft.stdout, /no enabled version to roll back/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T-ISO-4 · the forbidden owner-log path, PINNED
// ───────────────────────────────────────────────────────────────────────────

/**
 * T-ISO-4 — THE ONE TEST ALLOWED TO DIVERGE `HOME` FROM `ACPX_STATE_HOME`, and
 * it must, because the property does not exist while they are equal.
 *
 * The owner log's WRITER resolves its path from a bare `homedir()`, deliberately
 * (`queue-owner-process.ts`: "the log is intentionally not state-home-isolated").
 * So "delete it where it was written" is the obvious reading of the requirement
 * and it is catastrophic: under `ACPX_STATE_HOME` isolation every prune test
 * would reach OUT of its temp store and unlink real owner logs from the
 * developer's `~/.acpx`.
 *
 * ⚠️ The obvious construction of this test is VACUOUS. Pin `HOME` and
 * `ACPX_STATE_HOME` to one path, as every other test here correctly does, and
 * `homedir()` IS `sessionBaseDir()` — so the wrong implementation and the right
 * one delete the same file and the test cannot tell them apart.
 *
 * ⚠️ A POSITIVE CONTROL PROVABLY CANNOT CATCH THIS CLASS. Watching an owner log
 * disappear from the store shows the instrument works; it says NOTHING about
 * whether the HOME-derived directory was touched. Only planting a file the code
 * must NOT touch, in the directory the wrong implementation would reach for,
 * discriminates. That decoy is the test.
 *
 * Both paths are temp; neither is ever the real `~`. Asserted before the prune.
 */
test("T-ISO-4: the owner log is deleted from the state home, never from HOME", async () => {
  const homeOnly = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-iso4-home-"));
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-iso4-state-"));
  try {
    // ── The isolation invariant of the test that breaks the isolation rule ──
    assert.notEqual(homeOnly, stateHome, "the two paths must diverge or this test is vacuous");
    const realHome = os.homedir();
    for (const candidate of [homeOnly, stateHome]) {
      assert.ok(
        candidate.startsWith(os.tmpdir()),
        `${candidate} is not under tmpdir — refusing to run a destructive test`,
      );
      assert.ok(
        !path.resolve(candidate).startsWith(path.resolve(realHome) + path.sep) &&
          path.resolve(candidate) !== path.resolve(realHome),
        `${candidate} resolves under the REAL home ${realHome} — refusing to run`,
      );
    }

    const workCwd = path.join(stateHome, "workspace");
    await fs.mkdir(workCwd, { recursive: true });
    await seedSession(stateHome, "iso4-session", workCwd);

    // The decoy: an owner log for the SAME id, in the HOME-derived directory the
    // wrong implementation would reach for. It must survive untouched.
    const decoyDir = path.join(homeOnly, ".acpx", "sessions");
    await fs.mkdir(decoyDir, { recursive: true });
    const decoy = path.join(decoyDir, "iso4-session.owner.log");
    await fs.writeFile(decoy, "DECOY — a correct prune never touches this\n", "utf8");

    const result = await runCli(["claude", "sessions", "prune", "iso4-session"], {
      home: homeOnly,
      stateHome,
      cwd: workCwd,
    });
    assert.equal(result.code, 0, result.stderr);

    // The property. M-O2 (delete from homedir()) reds here and nothing else does.
    assert.equal(
      await fileExists(decoy),
      true,
      "prune reached OUT of the state home and deleted a HOME-derived owner log",
    );
    assert.equal(
      await fs.readFile(decoy, "utf8"),
      "DECOY — a correct prune never touches this\n",
      "the decoy was modified",
    );

    // And the in-store one really did go, so the run was not inert.
    assert.equal(
      await fileExists(path.join(stateHome, ".acpx", "sessions", "iso4-session.owner.log")),
      false,
    );
    assert.equal(await fileExists(sessionFilePath(stateHome, "iso4-session")), false);
  } finally {
    await fs.rm(homeOnly, { recursive: true, force: true });
    await fs.rm(stateHome, { recursive: true, force: true });
  }
});
