import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";

// THE CONFIG DIR, MEASURED THROUGH A REAL SPAWN.
//
// ⚠️ WHY THIS FILE EXISTS, AND IT IS NOT A DEFECT FIX. It was written for a
// reported regression (F-11, brick 8d754d94) that was then REFUTED by
// re-measurement: on staging, polling every 0.3 s and tracking the ADAPTER
// process separately from the queue owner, the directory IS created, DOES exist
// while the adapter is alive, and DOES hold the primer. Nothing was broken. The
// original report generalised from a single anomalous session.
//
// The instrument is kept because it was the right instrument for the wrong
// defect. The gap it closes is real and predates F-11:
//
//   `test/harness-config-dir-spawn-env.test.ts` HAND-SUPPLIES `sessionContext`,
//   so the whole suite could say nothing about a directory that only a REAL
//   SPAWN creates. That is why F-8 got through, and it is why a false report
//   about this directory went uncontradicted by the test suite for an hour.
//
// ⚠️ ONE MEASURED FACT THAT MAKES A NAIVE VERSION OF THIS TEST LIE: the directory
// is created by the spawn that SERVES A TURN, not by `sessions new`. A check that
// reads the record straight after creation sees an ABSENT field and files a miss —
// exactly the mistake the F-11 report made. So this asserts against a client that
// has actually started and created a session, never against a bare record read.

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

async function spawnOpenCodeClient() {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "hp-b3-lifetime-"));
  const linkDir = path.join(scratchDir, "opencode-ai");
  await fs.mkdir(linkDir, { recursive: true });
  const mockLink = path.join(linkDir, "mock-agent.js");
  await fs.symlink(MOCK_AGENT_PATH, mockLink);
  const client = new AcpClient({
    agentCommand: `node ${JSON.stringify(mockLink)}`,
    cwd: scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: `rec-lifetime-${path.basename(scratchDir)}` },
  });
  await client.start();
  const session = await client.createSession();
  return {
    client,
    session,
    dir: client.harnessConfigDirPath,
    cleanup: async () => {
      await client.close().catch(() => {});
      await fs.rm(scratchDir, { recursive: true, force: true });
    },
  };
}

test("a REAL spawn creates the config dir, and its FILES, while the adapter is alive", async () => {
  // The bar, stated as the staging probe stated it: not "a name was set" — the
  // artifact the harness actually reads must be on disk for the adapter's life.
  const s = await spawnOpenCodeClient();
  try {
    assert.ok(s.dir, "no config dir was created by a real spawn");
    assert.equal(
      existsSync(s.dir),
      true,
      "the config dir does not exist while the adapter is alive",
    );

    // The FILES, not just the directory. An empty directory would satisfy an
    // existence check while the harness read no primer and no pin.
    const configPath = path.join(s.dir, "opencode", "opencode.json");
    assert.equal(existsSync(configPath), true, `missing ${configPath}`);
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.ok(config, "opencode.json did not parse");

    // Still there after a real ACP round-trip — not merely at the instant of spawn.
    await client_roundTrip(s.client, s.session.sessionId);
    assert.equal(existsSync(configPath), true, "the config vanished during the adapter's life");
  } finally {
    await s.cleanup();
  }
});

test("the recorded path points at the dir that actually exists", async () => {
  // The channel acpx-ui reads. A recorded path that does not resolve is the
  // failure mode `fa2e54ec` exists to make visible, so it is worth pinning that
  // the two agree for a real spawn rather than assuming they do.
  const s = await spawnOpenCodeClient();
  try {
    assert.ok(s.dir, `no config dir was planned; ${await describeTmpState(undefined)}`);
    assert.equal(
      existsSync(s.dir),
      true,
      `recorded dir is absent; ${await describeTmpState(s.dir)}`,
    );
    // CONTROL: the path is not merely non-empty — it is under tmp and carries the
    // harness prefix, so a stray value could not satisfy this vacuously.
    assert.match(path.basename(s.dir), /^acpx-opencode-/);
  } finally {
    await s.cleanup();
  }
});

test("close removes the dir it created — the fast path still works", async () => {
  // The other direction: if creation were fixed by never removing anything, the
  // leak `433f6bf8` addresses would return. Remove-on-close is the fast path; the
  // `sessions prune` sweep remains the guarantee for the cases close never runs.
  const s = await spawnOpenCodeClient();
  assert.ok(s.dir);
  assert.equal(existsSync(s.dir), true, "control: the dir must exist before close");
  await s.client.close();
  assert.equal(existsSync(s.dir), false, "close() no longer removes its own dir");
  await s.cleanup();
});

/** A real ACP round-trip, so the assertion after it is about a LIVE adapter. */
async function client_roundTrip(client: AcpClient, sessionId: string): Promise<void> {
  await client.setSessionConfigOption(sessionId, "mode", "build").catch(() => {
    // The mock may not advertise `mode`; the point is the round-trip, not the set.
  });
}

/**
 * State a failing config-dir assertion needs and cannot otherwise recover.
 *
 * ⚠️ THIS EXISTS BECAUSE A ROW WENT RED TWICE UNDER FULL-SUITE LOAD AND I COULD
 * NEVER CAPTURE THE ASSERTION. Both times it passed in isolation and on the next
 * full run, so there was nothing left to inspect — only a `not ok` line. A row
 * that prints what it judged turns an unreproducible intermittent into a
 * diagnosable one, which is the only form of "capture the detail first" that
 * survives not being there when it happens.
 */
async function describeTmpState(dir: string | undefined): Promise<string> {
  const parts = [`dir=${dir ?? "<none>"}`];
  if (dir) {
    parts.push(`exists=${existsSync(dir)}`);
    try {
      parts.push(`entries=${JSON.stringify(await fs.readdir(dir))}`);
    } catch (error) {
      parts.push(`readdir failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const siblings = (await fs.readdir(os.tmpdir())).filter((e) => e.startsWith("acpx-opencode-"));
    parts.push(`tmp acpx-opencode-* population=${siblings.length}`);
    parts.push(`sample=${JSON.stringify(siblings.slice(0, 5))}`);
  } catch {
    parts.push("tmp listing unavailable — NOT MEASURED");
  }
  return parts.join(" · ");
}
