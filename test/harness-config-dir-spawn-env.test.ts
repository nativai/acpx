import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";

// B3 deliverable 5 — RS-13's in-repo half: THE ADAPTER-BOUNDARY DIFFERENTIAL.
//
// ⚠️ BOUNDARY (IR-15). This measures the environment of the process ACPX SPAWNS
// AS THE ADAPTER, read out of the child's OWN dump. It is the only boundary that
// can see this change:
//
//   acpx-ui --spawn('acpx')--> acpx CLI --spawn(adapter)--> the harness adapter
//                ^                              ^
//                └ RS-01 captures HERE          └ the config dir is applied HERE
//
// RS-01 is one level upstream and is structurally blind to this in BOTH
// directions — it shows an empty delta for a working gate and an equally empty
// delta for one that never ran. A row that cited RS-01 for this claim would be
// NOT RUN, not PASS.
//
// ⚠️ WHAT IT STILL CANNOT SEE: whether the harness READ the files. That needs a
// real OpenCode/Pi turn on the rig.
//
// ⚠️ THE MOCK AGENT'S ENV DUMP IS AN ALLOWLIST (ACPX_* / INDEPENDENT_CLAUDE_* /
// CLAUDE_CONFIG_DIR). The three names under test are NONE of those, so without
// `--env-dump-extra` every one reads `undefined` — INDISTINGUISHABLE from "acpx
// never set it", and this whole file would pass while proving nothing. hp-b1-acpx
// hit exactly that and added the flag; it is not optional here.
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

/** The names the config dir sets. Every arm captures ALL of them, so a harness
 *  that gains one it should not is caught as loudly as one that misses one. */
const CONFIG_DIR_NAMES = ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "PI_CODING_AGENT_DIR"];

/**
 * The directory name that makes a command CLASSIFY as each harness.
 *
 * ⚠️ Every shipped detector matches with `args.some(arg => arg.includes(TOKEN))`
 * — verified in `src/acp/agent-command.ts` and `src/acp/codex-compat.ts` — so the
 * mock's own PATH is what classifies it. Placing a SYMLINK to the real mock under
 * a token-named directory means the argument string carries the token while Node
 * still resolves the module (and its relative imports) from the real location.
 *
 * ⚠️ This exercises acpx's REAL classification path with an adapter that answers,
 * which is the point: it measures ACPX'S GATE, not the harness. Passing the token
 * as a bare extra argument does not work — the mock rejects unknown options and
 * exits 1 before `initialize`, which reads as an infrastructure failure rather
 * than a result.
 */
const HARNESS_DIR_TOKENS: Record<string, string> = {
  claude: "claude-agent-acp",
  "claude-pty": "claude-pty-acp",
  codex: "codex-acp",
  opencode: "opencode-ai",
  pi: "pi-acp",
};

/** Which harnesses MUST receive a config dir, and exactly which names. */
const EXPECTED: Record<string, string[]> = {
  claude: [],
  "claude-pty": [],
  codex: [],
  opencode: ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"],
  pi: ["PI_CODING_AGENT_DIR"],
};

async function spawnAndDumpEnv(harness: string): Promise<Record<string, string>> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "hp-b3-rs13-cwd-"));
  const envDumpPath = path.join(scratchDir, "env-dump.json");
  const linkDir = path.join(scratchDir, HARNESS_DIR_TOKENS[harness]);
  await fs.mkdir(linkDir, { recursive: true });
  const mockLink = path.join(linkDir, "mock-agent.js");
  await fs.symlink(MOCK_AGENT_PATH, mockLink);

  const client = new AcpClient({
    agentCommand:
      `node ${JSON.stringify(mockLink)} ` +
      `--env-dump-file ${JSON.stringify(envDumpPath)} ` +
      `--env-dump-extra ${CONFIG_DIR_NAMES.join(",")}`,
    cwd: scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: `rec-b3-rs13-${harness}` },
  });
  try {
    await client.start();
    await client.createSession();
    return JSON.parse(await fs.readFile(envDumpPath, "utf8")) as Record<string, string>;
  } finally {
    await client.close().catch(() => {});
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

test("RS-13: config-dir vars reach opencode and pi ONLY — claude/claude-pty/codex EMPTY", async () => {
  const observed: Record<string, string[]> = {};
  const populations: Record<string, number> = {};

  for (const harness of Object.keys(HARNESS_DIR_TOKENS)) {
    const dump = await spawnAndDumpEnv(harness);

    // ⚠️ POPULATION FIRST, IN EVERY ARM. A dump of size 0 means the child never
    // wrote it — NOT RUN — and would satisfy every "is absent" assertion below
    // vacuously. This is what turns an empty result from "clean" into "broken".
    populations[harness] = Object.keys(dump).length;
    assert.ok(
      populations[harness] > 5,
      `${harness}: env dump has ${populations[harness]} entries — the child never ran, so this arm is NOT RUN, not clean`,
    );

    observed[harness] = CONFIG_DIR_NAMES.filter((name) => dump[name] !== undefined).toSorted();
  }

  // Printed so the row's evidence is the measurement, not the verdict.
  process.stderr.write(
    `[RS-13] populations=${JSON.stringify(populations)} observed=${JSON.stringify(observed)}\n`,
  );

  for (const [harness, expected] of Object.entries(EXPECTED)) {
    assert.deepEqual(
      observed[harness],
      expected.toSorted(),
      `${harness}: expected config-dir vars ${JSON.stringify(expected)} but observed ${JSON.stringify(observed[harness])}`,
    );
  }

  // THE TWO-SIDED CONTROL, stated as one assertion rather than left implicit:
  // the run must contain BOTH a harness that gained names and harnesses that
  // gained none. All-empty would mean the feature never fired; all-populated
  // would mean the gate does not gate.
  const gained = Object.entries(observed).filter(([, names]) => names.length > 0);
  const empty = Object.entries(observed).filter(([, names]) => names.length === 0);
  assert.equal(gained.length, 2, "exactly opencode and pi must gain config-dir vars");
  assert.equal(empty.length, 3, "exactly claude, claude-pty and codex must gain none");
});

test("RS-13 control: the probe CAN see these names — a planted value is captured", async () => {
  // The positive control for the three EMPTY arms above. Without it, "claude has
  // no XDG_CONFIG_HOME" is equally consistent with "--env-dump-extra is not
  // working and no name of this shape is ever captured". Plant the value in the
  // parent env and require the SAME instrument, in the same process, to see it
  // on the SAME harness that must otherwise show none.
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/tmp/hp-b3-planted-control";
  try {
    const dump = await spawnAndDumpEnv("claude");
    assert.equal(
      dump.XDG_CONFIG_HOME,
      "/tmp/hp-b3-planted-control",
      "the instrument cannot see XDG_CONFIG_HOME at all — every absence assertion above is blind",
    );
    // And acpx did not overwrite an inherited value for a non-config-dir harness.
    assert.equal(dump.OPENCODE_CONFIG_DIR, undefined);
    assert.equal(dump.PI_CODING_AGENT_DIR, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  }
});

test("the config dir opencode receives is REAL — the files exist where the env points", async () => {
  // The env var alone proves a name was set, not that a primer was written.
  const dump = await spawnAndDumpEnv("opencode");
  const configDir = dump.OPENCODE_CONFIG_DIR;
  assert.ok(configDir, "OPENCODE_CONFIG_DIR unset");
  const configPath = path.join(configDir, "opencode.json");
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  assert.ok(config, `opencode.json at ${configPath} did not parse`);
  // XDG_CONFIG_HOME must be the PARENT — OpenCode merges both, so a mismatch
  // silently de-isolates the session (I1 R15).
  assert.equal(dump.XDG_CONFIG_HOME, path.dirname(configDir));
  await fs.rm(path.dirname(configDir), { recursive: true, force: true });
});
