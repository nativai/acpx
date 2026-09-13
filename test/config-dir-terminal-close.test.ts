import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { applyHarnessConfigDir, releaseHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { connectAndLoadSession } from "../src/runtime/engine/reconnect.js";
import { withTempHome } from "./queue-test-helpers.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

/** A pid that is provably not running, so `dropStaleHolders` must drop its holder.
 *  Chosen by probing rather than assumed: a hardcoded "dead" pid can be recycled. */
const DEAD_PID = (() => {
  for (let candidate = 4_194_300; candidate > 4_000_000; candidate -= 7) {
    try {
      process.kill(candidate, 0);
    } catch {
      return candidate;
    }
  }
  throw new Error("could not find a dead pid to build the fixture with");
})();

// 4a6fdda0 — removal on close belongs to the session's TERMINAL close.
//
// ⚠️ THE PROPERTY, FROM AN IN-PROCESS REPRODUCTION. Two `AcpClient`s of one
// session compute the SAME config dir: `resolveConfigDirId()` returns the record
// id when present, BY DESIGN, so repeated spawns of one session reuse a single
// directory instead of accumulating one per resume. But `close()` on EITHER did
// an unconditional recursive `rmSync`. A transient client closing therefore
// deleted the primer and the model pin out from under the client still serving a
// turn.
//
// ⚠️ THE SECOND HALF OF THE BAR IS THE HALF THAT IS EASY TO MISS: the directory
// SURVIVING the first close is not sufficient. A directory that survives while
// the adapter's turn dies is not a fix, so the real-spawn row below completes a
// turn AFTER the first client has closed.
//
// ⚠️ THIS IS FIXED ON ITS OWN TERMS, NOT AS AN EXPLANATION FOR THE RETRACTED
// F-11 ANOMALY (brick 8d754d94). That report was re-measured and withdrawn; it
// stays honestly open rather than being handed a tidy cause it has not earned.
//
// 📌 It is one half of a pair. `78cc444` made the THIRD-PARTY sweep safe
// (positive ownership + a /proc live-process leg); this is the OWNER-OF-CLOSE
// half. Neither alone is the whole custody story for a config dir.

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

function sharedDir(root: string, sessionId: string, holders: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < holders; i += 1) {
    const plan = applyHarnessConfigDir({
      env: {},
      agentCommand: AGENT_REGISTRY.pi,
      sessionId,
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan?.holderId, `holder ${i} did not receive a claim`);
    ids.push(plan.holderId);
  }
  return ids;
}

test("4a6fdda0: the FIRST of two clients closing does NOT remove the shared dir", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-"));
  try {
    const [first, second] = sharedDir(root, "shared-1", 2);
    const dir = path.join(root, "acpx-pi-shared-1");

    // CONTROL: both clients really did land on ONE directory. Without this the
    // row would pass just as well on a build that gave each its own.
    assert.equal(existsSync(dir), true, "control: the shared dir was never created");
    assert.notEqual(first, second, "control: the two holders must be distinguishable");

    const firstClose = releaseHarnessConfigDir(dir, first);
    assert.equal(firstClose.removed, false, "the first close REMOVED the shared dir");
    assert.equal(firstClose.remainingHolders, 1);
    assert.equal(existsSync(dir), true, "the dir is gone after a non-terminal close");

    const terminal = releaseHarnessConfigDir(dir, second);
    assert.equal(terminal.removed, true, "the TERMINAL close failed to remove the dir");
    assert.equal(existsSync(dir), false, "the dir survived its terminal close — a leak");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("4a6fdda0: a single client still removes its dir — the fast path is intact", async () => {
  // The two-sided control. A fix that simply stopped removing would pass the row
  // above and reintroduce the leak `433f6bf8` exists to prevent.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-solo-"));
  try {
    const [only] = sharedDir(root, "solo-1", 1);
    const dir = path.join(root, "acpx-pi-solo-1");
    assert.equal(existsSync(dir), true, "control: the dir was never created");
    const result = releaseHarnessConfigDir(dir, only);
    assert.equal(result.removed, true, "a sole holder's close no longer removes the dir");
    assert.equal(existsSync(dir), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("4a6fdda0: an UNREADABLE holder set removes NOTHING and says so", async () => {
  // A holder set that cannot be read is a NON-MEASUREMENT. Treating it as "zero
  // holders" would restore the unconditional delete this whole change removes.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-unread-"));
  try {
    const dir = path.join(root, "acpx-pi-no-holders");
    await fs.mkdir(dir, { recursive: true });
    const result = releaseHarnessConfigDir(dir, "some-holder");
    assert.equal(result.notMeasured, true, "an unreadable holder set was treated as measured");
    assert.equal(result.removed, false, "removed a dir whose holders could not be read");
    assert.equal(existsSync(dir), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("4a6fdda0: a path this module could not have created is never removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-foreign-"));
  try {
    const foreign = path.join(root, "not-ours");
    await fs.mkdir(foreign, { recursive: true });
    const result = releaseHarnessConfigDir(foreign, "h1");
    assert.equal(result.removed, false);
    assert.equal(existsSync(foreign), true, "a foreign directory was deleted");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("4a6fdda0 REAL SPAWN: the dir survives client A's close AND client B's TURN COMPLETES", async () => {
  // ⚠️ THE ROW THE BAR IS ACTUALLY ABOUT. Everything above is about a directory
  // existing; this is about the session still WORKING after the other client let
  // go. A dir that survives while the turn dies is not a fix.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "4a6fdda0-spawn-"));
  const clients: AcpClient[] = [];
  try {
    const linkDir = path.join(scratch, "pi-acp");
    await fs.mkdir(linkDir, { recursive: true });
    const mockLink = path.join(linkDir, "mock-agent.js");
    await fs.symlink(MOCK_AGENT_PATH, mockLink);

    const recordId = `rec-4a6fdda0-${path.basename(scratch)}`;
    const spawn = async () => {
      const client = new AcpClient({
        agentCommand: `node ${JSON.stringify(mockLink)}`,
        cwd: scratch,
        permissionMode: "approve-reads",
        sessionContext: { acpxRecordId: recordId },
      });
      clients.push(client);
      await client.start();
      const session = await client.createSession();
      return { client, sessionId: session.sessionId };
    };

    const a = await spawn();
    const b = await spawn();

    // CONTROL: they really are two clients of ONE session's directory. If
    // `resolveConfigDirId()` ever stopped reusing the record id, this row would
    // silently stop testing anything.
    assert.ok(a.client.harnessConfigDirPath, "client A got no config dir");
    assert.equal(
      a.client.harnessConfigDirPath,
      b.client.harnessConfigDirPath,
      "the two clients did not share a directory — this row is vacuous",
    );
    const dir = a.client.harnessConfigDirPath;
    const configPath = path.join(dir, "settings.json");
    assert.equal(existsSync(configPath), true, "control: the config was never written");

    await a.client.close();

    // Half one: the directory, and its CONTENTS, survive.
    assert.equal(existsSync(dir), true, "client A's close deleted the shared dir");
    assert.equal(existsSync(configPath), true, "client A's close deleted the shared config file");

    // Half two, and the one that matters: B's turn still completes.
    await b.client.setSessionConfigOption(b.sessionId, "mode", "build").catch(() => {
      // The mock may not advertise `mode`; the round-trip is the subject.
    });
    const turn = await b.client.prompt(b.sessionId, [{ type: "text", text: "ping" }]);
    assert.ok(turn, "client B's turn did not complete after A closed");

    // And the terminal close still cleans up.
    await b.client.close();
    assert.equal(existsSync(dir), false, "the dir survived the TERMINAL close — a leak");
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
});

test("074a1bd9 REAL SPAWN: a session/new that names a seeded extension names the BOX file and the kill-switch", async () => {
  // ⚠️ THE ROW THAT PROVES THE WIRING, NOT JUST THE FUNCTION. The unit rows in
  // harness-config-dir.test.ts call `describePiExtensionSeedFailure` directly and
  // would stay green if `createSession` never invoked it — the gap that let the
  // original defect ship. This spawns a real adapter over a real ACP connection,
  // with a real seeded extension, and asserts on what a caller of `createSession`
  // actually receives.
  await withTempHome(async (boxHome) => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "074a1bd9-spawn-"));
    const clients: AcpClient[] = [];
    try {
      // The adapter is reached through a `pi-acp` path, which is how acpx decides
      // this spawn is pi and provisions a pi config dir at all.
      const linkDir = path.join(scratch, "pi-acp");
      await fs.mkdir(linkDir, { recursive: true });
      const mockLink = path.join(linkDir, "mock-agent.js");
      await fs.symlink(MOCK_AGENT_PATH, mockLink);

      // The temp HOME holds one extension pi cannot load — no default export, the
      // measured discriminator (pi 0.84.4).
      const boxExtDir = path.join(boxHome, ".pi", "agent", "extensions");
      await fs.mkdir(boxExtDir, { recursive: true });
      const boxExtension = path.join(boxExtDir, "half-written.js");
      await fs.writeFile(boxExtension, "export const notAFactory = 1\n");

      const client = new AcpClient({
        // brick 5fee840d: the mock used to die on the alphabetically first
        // extension; acpx's own live-routing builtin (acpx-openrouter-routing.js)
        // now sorts first and LOADS fine. pi dies on the UNLOADABLE one, so
        // name it — the simulation stays exact.
        agentCommand: `node ${JSON.stringify(mockLink)} --fail-new-session-on-seeded-extension half-written.js`,
        cwd: scratch,
        permissionMode: "approve-reads",
        sessionContext: { acpxRecordId: `rec-074a1bd9-${path.basename(scratch)}` },
      });
      clients.push(client);
      await client.start();

      // CONTROL: the extension really was seeded. Without it a build that stopped
      // seeding entirely would pass every assertion below for the wrong reason.
      const dir = client.harnessConfigDirPath;
      assert.ok(dir, "no pi config dir was provisioned — this row is vacuous");
      assert.equal(
        existsSync(path.join(dir, "extensions", "half-written.js")),
        true,
        "control: the box extension was never seeded",
      );

      const error = await client
        .createSession()
        .then(() => null)
        .catch((e: unknown) => e);
      assert.ok(error, "createSession resolved — the adapter did not fail as configured");

      const text = error instanceof Error ? error.message : JSON.stringify(error);
      // The defect verbatim: this is what a caller used to get INSTEAD of a cause.
      assert.equal(
        /Cannot call write after a stream was destroyed/i.test(text),
        false,
        `raw stream error reached the caller: ${text}`,
      );
      assert.ok(text.includes("half-written.js"), `the offending file is not named: ${text}`);
      assert.ok(text.includes(boxExtension), `the BOX source file is not named: ${text}`);
      assert.ok(
        text.includes("ACPX_PI_EXTENSIONS_SEED=off"),
        `the way to disable seeding is not stated: ${text}`,
      );
    } finally {
      for (const client of clients) {
        await client.close().catch(() => {});
      }
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 433f6bf8 — `closeSession` IS A CLOSE PATH, AND IT DID NOT RELEASE ANYTHING.
//
// ⚠️ WHY THE ROWS ABOVE COULD ALL PASS WHILE THE LEAK RAN. Every one of them
// closes an `AcpClient`, and `AcpClient.close()` has released since 4a6fdda0.
// The sessions that actually leak have NO CLIENT LEFT TO CLOSE: an owner
// released for idleness, a `kill -9`, a pod eviction. `acpx sessions close`
// then terminalises a record whose client is already gone, and nothing on that
// path ever looked at `harness_config_dir`.
//
// MEASURED on the deployed build 2026-09-08, before this fix: eight
// `/tmp/acpx-pi-<id>` directories, ~320 KB each, EVERY record `closed:true`
// carrying the correct `harness_config_dir`, and EVERY holder pid dead. They had
// survived ~16 h and more than two six-hour sweep intervals.
//
// 🛑 THE SUBJECT HERE IS `closeSession`, NOT `releaseHarnessConfigDir`. The
// release primitive was already correct and already tested — the defect was that
// the close path never CALLED it. A row that exercised the primitive again would
// pass on the unfixed build and prove nothing.
// ---------------------------------------------------------------------------

test("433f6bf8: a TERMINAL closeSession releases the dir when no LIVE holder remains", async () => {
  await withTempHome(async (homeDir) => {
    const { closeSession } = await import("../src/cli/session/session-control.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-433f6bf8-dead-"));
    try {
      // A dir shaped exactly like a real one, held by a pid that is GONE — the
      // measured state of all eight leaked directories.
      const dir = path.join(root, "acpx-pi-rec-433-dead");
      await fs.mkdir(path.join(dir, ".acpx-holders"), { recursive: true });
      await fs.writeFile(path.join(dir, "settings.json"), "{}");
      await fs.writeFile(path.join(dir, ".acpx-holders", `${DEAD_PID}-deadbeef`), "");

      const record = makeSessionRecord({
        acpxRecordId: "rec-433-dead",
        acpSessionId: "ses-433-dead",
        agentCommand: AGENT_REGISTRY.pi,
        cwd: homeDir,
      });
      record.acpx = { ...record.acpx, harness_config_dir: dir };
      await writeSessionRecordFile(homeDir, record);

      assert.equal(existsSync(dir), true, "control: the dir must exist before the close");

      await closeSession("rec-433-dead");

      assert.equal(
        existsSync(dir),
        false,
        "THE DEFECT: the terminal close left the config dir behind. Every leaked directory " +
          "measured on the box was in exactly this state — closed record, dead holder, dir on disk.",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test("433f6bf8 CONTROL: a LIVE holder keeps the dir — a close never deletes under a live client", async () => {
  // The two-sidedness that stops the row above from being satisfied by an
  // unconditional delete, which is the regression 4a6fdda0 exists to prevent.
  // Same close, same shape, ONE difference: the holder's pid is this very
  // process, so it is provably alive.
  await withTempHome(async (homeDir) => {
    const { closeSession } = await import("../src/cli/session/session-control.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-433f6bf8-live-"));
    try {
      const dir = path.join(root, "acpx-pi-rec-433-live");
      await fs.mkdir(path.join(dir, ".acpx-holders"), { recursive: true });
      await fs.writeFile(path.join(dir, "settings.json"), "{}");
      await fs.writeFile(path.join(dir, ".acpx-holders", `${process.pid}-liveheld`), "");

      const record = makeSessionRecord({
        acpxRecordId: "rec-433-live",
        acpSessionId: "ses-433-live",
        agentCommand: AGENT_REGISTRY.pi,
        cwd: homeDir,
      });
      record.acpx = { ...record.acpx, harness_config_dir: dir };
      await writeSessionRecordFile(homeDir, record);

      await closeSession("rec-433-live");

      assert.equal(
        existsSync(dir),
        true,
        "a live holder's directory was deleted by a close — this is the 4a6fdda0 regression, " +
          "and it is worse than the leak it would be fixing",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test("433f6bf8: a record with NO recorded config dir closes cleanly and touches nothing", async () => {
  // The population's third case. Most sessions are claude/codex and never get a
  // config dir at all; the release must be a no-op for them rather than an error
  // on a close path that must not fail.
  await withTempHome(async (homeDir) => {
    const { closeSession } = await import("../src/cli/session/session-control.js");
    const record = makeSessionRecord({
      acpxRecordId: "rec-433-none",
      acpSessionId: "ses-433-none",
      agentCommand: AGENT_REGISTRY.claude,
      cwd: homeDir,
    });
    await writeSessionRecordFile(homeDir, record);

    const result = await closeSession("rec-433-none");
    assert.equal(result.record.closed, true, "the close itself must still succeed");
  });
});

// ===========================================================================
// brick://cb214e48 §7.4 — THE END-TO-END ROW THAT WOULD ACTUALLY HAVE CAUGHT IT.
//
// The unit rows in `pi-session-jsonl-dir.test.ts` pin the DERIVATION; these two
// pin the same property through a REAL SPAWN, i.e. through
// `AcpClient.start()` → `buildAgentEnvironment` (R3) → `applyHarnessConfigDirEnv`
// (R1) → the adapter process, and read the answer out of the ADAPTER'S OWN
// ENVIRONMENT rather than out of the object acpx just built.
//
// ## The shape, and why the obvious one does not reproduce the incident
//
// ⚠️ `sessions recover` ALONE DOES NOT REACH THE FAILING PATH. The per-session
// config dir — and pi-acp's session map inside it — survive an owner kill, so the
// next spawn's `findStoredSession` short-circuits on the map and never scans for a
// JSONL. Measured by the test-engineer on this branch. The shape that reproduces
// the incident is:
//
//   1. the child is spawned from a PARENT-SHAPED env (the parent pi session
//      exports its own re-pointed `PI_CODING_AGENT_DIR` into every tool
//      subprocess, so the nested `acpx` inherits it),
//   2. the owner dies AND the child's OWN `/tmp/acpx-pi-<child>` dir is removed —
//      what a terminal close and the idle release both do,
//   3. the respawn comes from a CLEAN env, which is what the acpx-ui server has.
//
// On the unfixed code the transcript was inside the PARENT's directory and step 3
// died with `missing transcript at ~/.acpx/subscriptions/…`. Here it must survive
// step 2 and resume in step 3.
//
// ## What the mock CAN and CANNOT stand in for — stated, not glossed
//
// The mock agent is used so the gate runs with no model credentials, and it makes
// these rows about **acpx's placement and resume plumbing**. It has no JSONL store,
// so it cannot model pi-acp's `findPiSession` scan: the transcript below is a file
// this test writes at the path acpx pointed the adapter at. That is precisely the
// contract acpx owns — *"the directory acpx hands pi is in the box store and
// outlives the config dir"* — and it is the half that was broken. The other half,
// a real pi recalling a canary through a real resumed turn, is in the brick's
// `IMPL-SELFTEST.md` §3 as a live measurement.
// ===========================================================================

/** pi's own cwd mangling, transcribed rather than imported, so this row notices
 *  the implementation drifting away from it. */
function piSlug(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Run `body` with `process.env.PI_CODING_AGENT_DIR` set to a PARENT's per-session
 *  config dir — the inherited value that is the whole defect — and restore it. */
async function withParentShapedEnv<T>(parentDir: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = parentDir;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
}

/** A `node <…>/pi-acp/mock-agent.js` command: the mock BINARY under a path that
 *  `harnessIdForAgentCommand` classifies as **pi**, which is what earns it a
 *  config dir at all. Same trick the 4a6fdda0 row uses. */
async function piClassifiedMockCommand(root: string, args: string[]): Promise<string> {
  const linkDir = path.join(root, "pi-acp");
  await fs.mkdir(linkDir, { recursive: true });
  const mockLink = path.join(linkDir, "mock-agent.js");
  if (!existsSync(mockLink)) {
    await fs.symlink(MOCK_AGENT_PATH, mockLink);
  }
  return [`node ${JSON.stringify(mockLink)}`, ...args].join(" ");
}

test("cb214e48 REAL SPAWN: a child of a PARENT-shaped env is pointed at the BOX store, and its transcript outlives its own config dir", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "child-work");
    await fs.mkdir(cwd, { recursive: true });
    const configRoot = process.env.ACPX_HARNESS_CONFIG_DIR_ROOT ?? os.tmpdir();
    // The ancestor's throwaway dir, exactly as acpx names one.
    const parentDir = path.join(configRoot, "acpx-pi-01a08744-8e1f-74ab-93a1-368e09e68a13");
    await fs.mkdir(parentDir, { recursive: true });
    const envDump = path.join(homeDir, "child-env.json");

    const client = new AcpClient({
      agentCommand: await piClassifiedMockCommand(homeDir, [
        "--supports-load-session",
        `--env-dump-file ${JSON.stringify(envDump)}`,
        "--env-dump-extra PI_CODING_AGENT_DIR,PI_CODING_AGENT_SESSION_DIR",
      ]),
      cwd,
      permissionMode: "approve-reads",
      sessionContext: { acpxRecordId: "rec-cb214e48-child" },
    });

    try {
      await withParentShapedEnv(parentDir, async () => {
        await client.start();
      });

      // ⚠️ READ THE ADAPTER'S OWN ENVIRONMENT, not the object acpx just built.
      // This is what makes it an end-to-end row: it goes through the FW-07 scrub
      // and the config-dir writer together, exactly as a real spawn does.
      const spawned = JSON.parse(await fs.readFile(envDump, "utf8")) as Record<string, string>;
      const sessionDir = spawned.PI_CODING_AGENT_SESSION_DIR;

      const expected = path.join(homeDir, ".pi", "agent", "sessions", piSlug(cwd));
      assert.equal(sessionDir, expected, "the child was not pointed at the BOX store");
      // The failure this row exists for, stated as the thing that must NOT be true.
      assert.equal(
        sessionDir?.startsWith(parentDir),
        false,
        "the child's transcript was aimed INSIDE the parent's throwaway config dir",
      );
      // ⚠️ AND IT MUST EXIST BEFORE pi STARTS — a missing target hangs pi with
      // rc=124 and empty stdout AND stderr, which reads as a slow model.
      assert.equal(existsSync(sessionDir), true, `pi would HANG: ${sessionDir} does not exist`);

      // CONTROL: the config dir really was re-pointed, so this row is about the
      // store surviving that move and not about a spawn that never happened.
      const childConfigDir = client.harnessConfigDirPath;
      assert.ok(childConfigDir, "no config dir was created — the row is vacuous");
      assert.notEqual(childConfigDir, parentDir, "the child reused the PARENT's dir");
      assert.equal(spawned.PI_CODING_AGENT_DIR, childConfigDir);

      // pi is the only writer of this file; stand in for it at the exact path acpx
      // handed the adapter.
      const transcript = path.join(sessionDir, "2026-09-09T18-09-59-308Z_01a0875c-c60c.jsonl");
      await fs.writeFile(transcript, '{"child":"only copy"}\n', "utf8");

      // Step 2 of the shape: the child's OWN config dir goes, as a terminal close
      // and the idle release both do.
      await client.close();
      assert.equal(existsSync(childConfigDir), false, "control: the config dir was not removed");

      // THE POINT: the transcript is not in the directory that just went.
      assert.equal(
        existsSync(transcript),
        true,
        "the child's ONLY transcript was destroyed with its config dir",
      );
      assert.equal(await fs.readFile(transcript, "utf8"), '{"child":"only copy"}\n');
    } finally {
      await client.close().catch(() => {});
    }
  });
});

test("cb214e48 REAL SPAWN: after the config dir is removed, a CLEAN-env respawn resumes and lands on the SAME box store", async () => {
  // Step 3 of the shape. The respawn carries no PI_* vars at all — that is the
  // production respawn shape, the acpx-ui server's own environment, and it is the
  // path session 01a0875c wedged on.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "child-work");
    await fs.mkdir(cwd, { recursive: true });
    const configRoot = process.env.ACPX_HARNESS_CONFIG_DIR_ROOT ?? os.tmpdir();
    const parentDir = path.join(configRoot, "acpx-pi-01a08744-8e1f-74ab-93a1-368e09e68a13");
    await fs.mkdir(parentDir, { recursive: true });

    const firstDump = path.join(homeDir, "first-env.json");
    const secondDump = path.join(homeDir, "second-env.json");
    const command = async (dump: string) =>
      await piClassifiedMockCommand(homeDir, [
        "--supports-load-session",
        `--env-dump-file ${JSON.stringify(dump)}`,
        "--env-dump-extra PI_CODING_AGENT_DIR,PI_CODING_AGENT_SESSION_DIR",
      ]);

    const first = new AcpClient({
      agentCommand: await command(firstDump),
      cwd,
      permissionMode: "approve-reads",
      sessionContext: { acpxRecordId: "rec-cb214e48-resume" },
    });
    let sessionId = "";
    let firstConfigDir: string | undefined;
    try {
      await withParentShapedEnv(parentDir, async () => {
        await first.start();
        const created = await first.createSession(cwd);
        sessionId = created.sessionId;
      });
      firstConfigDir = first.harnessConfigDirPath;
    } finally {
      await first.close().catch(() => {});
    }

    const spawned = JSON.parse(await fs.readFile(firstDump, "utf8")) as Record<string, string>;
    const boxSessionDir = path.join(homeDir, ".pi", "agent", "sessions", piSlug(cwd));
    assert.equal(spawned.PI_CODING_AGENT_SESSION_DIR, boxSessionDir);
    const transcript = path.join(boxSessionDir, `2026-09-09T18-09-59-308Z_${sessionId}.jsonl`);
    await fs.writeFile(transcript, '{"child":"only copy"}\n', "utf8");

    // The config dir is gone (the close removed it) — the state a cold respawn
    // actually finds, and the state in which the old code went looking for a
    // Claude transcript.
    assert.ok(firstConfigDir);
    assert.equal(existsSync(firstConfigDir), false, "control: the config dir survived the close");

    const record = makeSessionRecord({
      acpxRecordId: "rec-cb214e48-resume",
      acpSessionId: sessionId,
      agentCommand: await command(secondDump),
      cwd,
      messages: [{ Agent: { content: [{ Text: "prior response" }], tool_results: {} } }],
    });

    const second = new AcpClient({
      agentCommand: record.agentCommand,
      cwd,
      permissionMode: "approve-reads",
      sessionContext: { acpxRecordId: "rec-cb214e48-resume" },
    });
    try {
      // NO PI_* in the environment — deliberately not wrapped in withParentShapedEnv.
      const result = await connectAndLoadSession({
        client: second,
        record,
        timeoutMs: 30_000,
        activeController: {
          hasActivePrompt: () => false,
          requestCancelActivePrompt: async () => false,
          setSessionMode: async () => {},
          setSessionModel: async () => {},
          setSessionConfigOption: async () => ({ configOptions: [] }) as never,
        },
      });

      assert.equal(result.resumed, true, "the clean-env respawn did not resume the session");
      assert.equal(result.sessionId, sessionId);
      // ⚠️ AND IT MUST NOT HAVE ASKED FOR A CLAUDE TRANSCRIPT. `loadError` is where
      // the old path's `missing transcript at ~/.acpx/subscriptions/…` surfaced.
      assert.equal(result.loadError, undefined, `the resume reported: ${result.loadError}`);

      // The respawn landed on the SAME box store, from an env that carried nothing.
      const respawned = JSON.parse(await fs.readFile(secondDump, "utf8")) as Record<string, string>;
      assert.equal(
        respawned.PI_CODING_AGENT_SESSION_DIR,
        boxSessionDir,
        "the respawn resolved a DIFFERENT store than the spawn that wrote the transcript",
      );
      assert.equal(existsSync(transcript), true, "the transcript did not survive the round trip");
    } finally {
      await second.close().catch(() => {});
    }
  });
});
