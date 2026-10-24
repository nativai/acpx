import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_STRIPPED_CREDENTIAL_ENV } from "../src/acp/agent-credential-env.js";
import { AcpClient } from "../src/acp/client.js";
import { buildTerminalSpawnOptions } from "../src/acp/terminal-manager.js";

// brick 1dc24c1c — box API credentials never reach an agent's environment.
//
// ⚠️ WHY EVERY CASE SPAWNS A REAL CHILD. The property is about the environment the
// AGENT PROCESS receives, and that is built in two places (`buildAgentEnvironment`,
// then `resolveAgentLaunchPlan`, which used to add `providers.json` entries AFTER the
// build). A unit test of either half cannot see what the other adds. So each case
// spawns the mock agent through `AcpClient` and reads the names out of the env the
// child itself observed.
//
// ⚠️ ONE SOURCE PER CASE. `promotePrefixedAuthEnvironment` only promotes a prefixed
// value when the plain name is absent, so a case that set both forms would let the
// plain-name strip hide a missing prefixed strip. Each case plants exactly one origin.
//
// ⚠️ SENTINELS ONLY. Every value is `TESTONLY-…`; the names are restored afterwards.
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const SENTINEL = "TESTONLY-1dc24c1c-sentinel";

// A non-secret name the test plants beside the credentials. It MUST arrive: it proves
// the dump captures inherited extras at all, so an absent credential is a measurement
// and not a dump that never looked.
const CANARY = "HP_1DC_NON_SECRET_CANARY";
// Kept by decision (Daniel 2026-10-24) — a name pattern here would be a regression.
const KEPT = ["GITHUB_TOKEN", "BROWSERLESS_TOKEN"] as const;

const DUMP_EXTRA = [...AGENT_STRIPPED_CREDENTIAL_ENV, CANARY, ...KEPT, "HP_1DC_PROBE_AUTH"];

type Scratch = { stateHome: string; scratchDir: string; envDumpPath: string };

async function withEnv(vars: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** The ambient copies of every name this file asserts on, cleared for the test. */
function clearedAmbient(): Record<string, string | undefined> {
  const names = [
    ...AGENT_STRIPPED_CREDENTIAL_ENV,
    ...AGENT_STRIPPED_CREDENTIAL_ENV.map((name) => `ACPX_AUTH_${name}`),
  ];
  const saved: Record<string, string | undefined> = {};
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  return saved;
}

function restoreAmbient(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function withScratch(providers: unknown, run: (scratch: Scratch) => Promise<void>) {
  const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-1dc-home-"));
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-1dc-cwd-"));
  await fs.mkdir(path.join(stateHome, ".acpx"), { recursive: true });
  if (providers !== undefined) {
    await fs.writeFile(
      path.join(stateHome, ".acpx", "providers.json"),
      JSON.stringify(providers),
      "utf8",
    );
  }
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = stateHome;
  const ambient = clearedAmbient();
  try {
    await run({ stateHome, scratchDir, envDumpPath: path.join(scratchDir, "env-dump.json") });
  } finally {
    restoreAmbient(ambient);
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    await fs.rm(stateHome, { recursive: true, force: true });
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

async function spawnAndDumpEnv(
  scratch: Scratch,
  authCredentials?: Record<string, string>,
): Promise<Record<string, string>> {
  const client = new AcpClient({
    agentCommand:
      `node ${JSON.stringify(MOCK_AGENT_PATH)} ` +
      `--env-dump-file ${JSON.stringify(scratch.envDumpPath)} ` +
      `--env-dump-extra ${DUMP_EXTRA.join(",")}`,
    cwd: scratch.scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: "rec-1dc24c1c" },
    ...(authCredentials ? { authCredentials } : {}),
  });
  try {
    await client.start();
    await client.createSession();
    return JSON.parse(await fs.readFile(scratch.envDumpPath, "utf8")) as Record<string, string>;
  } finally {
    await client.close().catch(() => {});
  }
}

function assertNoneOfTheFive(dump: Record<string, string>, origin: string): void {
  assert.equal(dump[CANARY], "1", `control (${origin}): the dump must capture inherited extras`);
  for (const name of AGENT_STRIPPED_CREDENTIAL_ENV) {
    assert.equal(name in dump, false, `${origin}: ${name} reached the agent`);
    assert.equal(
      `ACPX_AUTH_${name}` in dump,
      false,
      `${origin}: ACPX_AUTH_${name} reached the agent`,
    );
  }
  assert.ok(
    !JSON.stringify(dump).includes(SENTINEL),
    `${origin}: a sentinel value reached the agent`,
  );
}

const plain = Object.fromEntries(AGENT_STRIPPED_CREDENTIAL_ENV.map((name) => [name, SENTINEL]));
const prefixed = Object.fromEntries(
  AGENT_STRIPPED_CREDENTIAL_ENV.map((name) => [`ACPX_AUTH_${name}`, SENTINEL]),
);

test("(a) inherited under the PLAIN name: none of the five reaches the agent; non-secret env does", async () => {
  await withScratch(undefined, async (scratch) => {
    await withEnv(
      { ...plain, [CANARY]: "1", GITHUB_TOKEN: "kept-1", BROWSERLESS_TOKEN: "kept-2" },
      async () => {
        const dump = await spawnAndDumpEnv(scratch);
        assertNoneOfTheFive(dump, "plain");
        // Kept by decision, and a pattern-based strip would take them — pinned here.
        assert.equal(dump.GITHUB_TOKEN, "kept-1");
        assert.equal(dump.BROWSERLESS_TOKEN, "kept-2");
      },
    );
  });
});

test("(b) inherited as ACPX_AUTH_<NAME>: neither the prefixed form nor its promotion reaches the agent", async () => {
  await withScratch(undefined, async (scratch) => {
    await withEnv({ ...prefixed, [CANARY]: "1" }, async () => {
      assertNoneOfTheFive(await spawnAndDumpEnv(scratch), "ACPX_AUTH_ prefix");
    });
  });
});

test("(c) declared in providers.json: no entry of ANY name is delivered into the agent env", async () => {
  // One entry per stripped name, plus a probe whose name is on no strip list: with
  // env delivery reintroduced after the env build, the probe is what would arrive.
  const providers: Record<string, unknown> = {
    openrouter: { env: "OPENROUTER_API_KEY", apiKey: SENTINEL },
    probe: { env: "HP_1DC_PROBE_AUTH", apiKey: SENTINEL },
  };
  for (const name of AGENT_STRIPPED_CREDENTIAL_ENV) {
    providers[`p-${name.toLowerCase()}`] = { env: name, apiKey: SENTINEL };
  }
  await withScratch({ version: 1, box: "devbox", providers }, async (scratch) => {
    await withEnv({ [CANARY]: "1" }, async () => {
      const dump = await spawnAndDumpEnv(scratch);
      assertNoneOfTheFive(dump, "providers.json");
      assert.equal("HP_1DC_PROBE_AUTH" in dump, false, "a providers.json entry was delivered");
    });
  });
});

test("(d) a config authCredentials entry naming one of the five does not reach the agent", async () => {
  await withScratch(undefined, async (scratch) => {
    await withEnv({ [CANARY]: "1" }, async () => {
      assertNoneOfTheFive(await spawnAndDumpEnv(scratch, { ...plain }), "authCredentials");
    });
  });
});

// The ACP terminal capability runs commands FOR the agent from the queue owner's own
// environment, which can still hold a pre-rule snapshot. Same strip, inherited base only.
test("terminal/create: the five are dropped from the inherited base; a name the request sets is kept", async () => {
  await withEnv({ ...plain, ...prefixed, [CANARY]: "1" }, async () => {
    const inherited = buildTerminalSpawnOptions("true", os.tmpdir(), undefined).env ?? {};
    assert.equal(inherited[CANARY], "1", "control: the terminal env inherits the base");
    for (const name of AGENT_STRIPPED_CREDENTIAL_ENV) {
      assert.equal(name in inherited, false, `terminal inherited ${name}`);
      assert.equal(`ACPX_AUTH_${name}` in inherited, false, `terminal inherited ACPX_AUTH_${name}`);
    }
    const asked =
      buildTerminalSpawnOptions("true", os.tmpdir(), [{ name: "FAL_KEY", value: "explicit" }])
        .env ?? {};
    assert.equal(asked.FAL_KEY, "explicit");
  });
});
