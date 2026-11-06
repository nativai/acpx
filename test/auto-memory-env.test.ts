import assert from "node:assert/strict";
import test from "node:test";
import { AUTO_MEMORY_OFF_ENV } from "../src/acp/auth-env.js";
import { buildAgentSpawnOptions } from "../src/acp/client.js";

// brick 7de83919 (CONCEPTION c53cbd97 §7, TEST-PLAN F1/F2): acpx OVERWRITES
// CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 on every agent spawn, for every harness. The commands are the
// three REAL adapter commands of the live store (sampled 2026-11-06 from ~/.acpx/sessions/index.json,
// agentCommand field only: 2415 claude, 242 codex, 36 pi records), plus a raw escape-hatch command.

const REAL_COMMANDS = {
  claude: "node /opt/claude-agent-acp/dist/index.js",
  codex: "node /opt/codex-acp/dist/index.js",
  pi: "node /opt/pi-acp/dist/index.js",
  raw: "node ./some-raw-agent.js",
};

function withParentEnv<T>(value: string | undefined, run: () => T): T {
  const saved = process.env[AUTO_MEMORY_OFF_ENV];
  if (value === undefined) {
    delete process.env[AUTO_MEMORY_OFF_ENV];
  } else {
    process.env[AUTO_MEMORY_OFF_ENV] = value;
  }
  try {
    return run();
  } finally {
    if (saved === undefined) {
      delete process.env[AUTO_MEMORY_OFF_ENV];
    } else {
      process.env[AUTO_MEMORY_OFF_ENV] = saved;
    }
  }
}

test("F1: an inherited =0 (which Claude Code reads as FORCED ON) is overwritten to 1", () => {
  for (const inherited of ["0", "false", ""]) {
    const env = withParentEnv(
      inherited,
      () =>
        buildAgentSpawnOptions(process.cwd(), undefined, undefined, {}, REAL_COMMANDS.claude).env,
    );
    assert.equal(env[AUTO_MEMORY_OFF_ENV], "1", `inherited ${JSON.stringify(inherited)}`);
  }
});

test("F2: set for every harness, not only Claude (and with nothing inherited)", () => {
  for (const [harness, command] of Object.entries(REAL_COMMANDS)) {
    const env = withParentEnv(
      undefined,
      () => buildAgentSpawnOptions(process.cwd(), undefined, undefined, {}, command).env,
    );
    assert.equal(env[AUTO_MEMORY_OFF_ENV], "1", harness);
  }
});

test("F1 control: the spawn env is the only place it is set — the parent process is untouched", () => {
  withParentEnv("0", () => {
    buildAgentSpawnOptions(process.cwd(), undefined, undefined, {}, REAL_COMMANDS.claude);
    assert.equal(process.env[AUTO_MEMORY_OFF_ENV], "0");
  });
});
