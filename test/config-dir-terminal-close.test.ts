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
      agentCommand: AGENT_REGISTRY.opencode,
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
    const dir = path.join(root, "acpx-opencode-shared-1");

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
    const dir = path.join(root, "acpx-opencode-solo-1");
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
    const dir = path.join(root, "acpx-opencode-no-holders");
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
    const linkDir = path.join(scratch, "opencode-ai");
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
    const configPath = path.join(dir, "opencode", "opencode.json");
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
