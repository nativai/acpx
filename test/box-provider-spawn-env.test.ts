import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";

// Block B1 deliverable 2 — the delivery mechanism, pinned BEHAVIOURALLY.
//
// ⚠️ WHY THIS IS NOT A UNIT TEST OF applyBoxProviderEnv. That function is
// exercised directly in `box-providers.test.ts`; what THIS file exists to catch
// is the wiring — that `resolveAgentLaunchPlan` actually calls it, on the one
// path every agent child is spawned through. A source-text check
// (`client.ts` includes "applyBoxProviderEnv") would survive its own violation:
// a leftover import or comment keeps the string present after the call is gone.
// So this SPAWNS a real child and reads the variable out of the environment the
// child itself observed. Delete the call in client.ts and this goes red.
//
// ⚠️ NO REAL CREDENTIAL IS USED OR REACHABLE. The provider names are unique to
// this test (`HP_B1_*`), so they cannot collide with — or capture — anything in
// the ambient environment, and the values are synthetic.
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

const SYNTHETIC_KEY = "sk-or-v1-TESTONLY-spawnenv-00000000000000000000000000";
const SYNTHETIC_KEY_2 = "sk-or-v1-TESTONLY-spawnenv-second-000000000000000000";

// ⚠️ THE MOCK AGENT'S ENV DUMP IS AN ALLOWLIST (ACPX_* / INDEPENDENT_CLAUDE_* /
// CLAUDE_CONFIG_DIR), so any other name reads `undefined` — INDISTINGUISHABLE
// from "acpx never set it", which is precisely the false negative this file must
// not be able to produce. `--env-dump-extra` names the probe variables
// explicitly. Found the hard way: the first version of this test failed with the
// variable absent from a dump that had never been asked to capture it.
const PROBE_NAMES = ["HP_B1_PROBE_API_KEY", "HP_B1_PROBE_AUTH"];

type Scratch = { stateHome: string; scratchDir: string; envDumpPath: string; restore: () => void };

async function withScratch(providers: unknown, run: (scratch: Scratch) => Promise<void>) {
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-b1-spawn-home-"));
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-b1-spawn-cwd-"));
  await fs.mkdir(path.join(stateHome, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(stateHome, ".acpx", "providers.json"),
    JSON.stringify(providers),
    "utf8",
  );
  await fs.chmod(path.join(stateHome, ".acpx", "providers.json"), 0o600);

  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = stateHome;
  const scratch: Scratch = {
    stateHome,
    scratchDir,
    envDumpPath: path.join(scratchDir, "env-dump.json"),
    restore: () => {
      if (previous === undefined) {
        delete process.env.ACPX_STATE_HOME;
      } else {
        process.env.ACPX_STATE_HOME = previous;
      }
    },
  };
  try {
    await run(scratch);
  } finally {
    scratch.restore();
    await fs.rm(stateHome, { recursive: true, force: true });
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

async function spawnAndDumpEnv(scratch: Scratch): Promise<Record<string, string>> {
  const client = new AcpClient({
    agentCommand:
      `node ${JSON.stringify(MOCK_AGENT_PATH)} ` +
      `--env-dump-file ${JSON.stringify(scratch.envDumpPath)} ` +
      `--env-dump-extra ${PROBE_NAMES.join(",")}`,
    cwd: scratch.scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: "rec-b1-spawn-env" },
  });
  try {
    await client.start();
    await client.createSession();
    return JSON.parse(await fs.readFile(scratch.envDumpPath, "utf8")) as Record<string, string>;
  } finally {
    await client.close().catch(() => {});
  }
}

test("a declared provider variable REACHES the spawned child's environment", async () => {
  await withScratch(
    {
      version: 1,
      box: "devbox",
      providers: {
        probe: { env: "HP_B1_PROBE_API_KEY", apiKey: SYNTHETIC_KEY, source: "manual" },
        // A name that does NOT end in a redaction-wildcard suffix, delivered the
        // same way — the injection is name-agnostic and the redactor must not
        // assume otherwise.
        probe2: { env: "HP_B1_PROBE_AUTH", apiKey: SYNTHETIC_KEY_2, source: "manual" },
      },
    },
    async (scratch) => {
      const dump = await spawnAndDumpEnv(scratch);

      // ⚠️ CONTROL FIRST: prove the dump is a real child environment and not an
      // empty object. Without this, every assertion below could be satisfied by
      // a file that never got written — the shape where a check "passes" having
      // examined nothing.
      assert.ok(Object.keys(dump).length > 5, "control: the env dump must be a real environment");

      assert.equal(dump.HP_B1_PROBE_API_KEY, SYNTHETIC_KEY);
      assert.equal(dump.HP_B1_PROBE_AUTH, SYNTHETIC_KEY_2);
    },
  );
});

test("an ALREADY-SET variable is never overwritten by the box credential", async () => {
  await withScratch(
    {
      version: 1,
      providers: { probe: { env: "HP_B1_PROBE_API_KEY", apiKey: SYNTHETIC_KEY } },
    },
    async (scratch) => {
      // ⚠️ THIS IS THE PROPERTY THAT MAKES THE STANDING RIG'S DELTA EMPTY, and it
      // is worth pinning for exactly that reason: on any box where the variable
      // is already in acpx's own environment (the wave-one ambient
      // ACPX_AUTH_OPENROUTER_API_KEY shortcut, or a rig that exports it at
      // launch), the child inherits that value and this injection is a
      // structural no-op. An RS-01 baseline that does not move is therefore a
      // PASS of the bound, not evidence the code never ran.
      process.env.HP_B1_PROBE_API_KEY = "pre-existing-ambient-value";
      try {
        const dump = await spawnAndDumpEnv(scratch);
        assert.equal(dump.HP_B1_PROBE_API_KEY, "pre-existing-ambient-value");
        assert.notEqual(dump.HP_B1_PROBE_API_KEY, SYNTHETIC_KEY);
      } finally {
        delete process.env.HP_B1_PROBE_API_KEY;
      }
    },
  );
});

test("no providers.json: the child environment is untouched — Claude/Codex behaviour unchanged", async () => {
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-b1-spawn-empty-"));
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-b1-spawn-empty-cwd-"));
  await fs.mkdir(path.join(stateHome, ".acpx"), { recursive: true });
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = stateHome;
  const envDumpPath = path.join(scratchDir, "env-dump.json");
  const client = new AcpClient({
    agentCommand:
      `node ${JSON.stringify(MOCK_AGENT_PATH)} ` +
      `--env-dump-file ${JSON.stringify(envDumpPath)} ` +
      `--env-dump-extra ${PROBE_NAMES.join(",")}`,
    cwd: scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: "rec-b1-spawn-empty" },
  });
  try {
    await client.start();
    await client.createSession();
    const dump = JSON.parse(await fs.readFile(envDumpPath, "utf8")) as Record<string, string>;
    // The unprovisioned box — which is nearly every box on day one. Session
    // creation must succeed and add nothing.
    assert.ok(Object.keys(dump).length > 5, "control: the env dump must be a real environment");
    assert.equal("HP_B1_PROBE_API_KEY" in dump, false);
    assert.equal("HP_B1_PROBE_AUTH" in dump, false);
  } finally {
    await client.close().catch(() => {});
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    await fs.rm(stateHome, { recursive: true, force: true });
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
});
