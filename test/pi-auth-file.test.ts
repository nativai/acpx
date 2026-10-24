import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { resetPiKnowledgeMemo } from "../src/acp/pi-model-knowledge.js";

// brick 1dc24c1c — pi gets the box OpenRouter key from its PER-SESSION `auth.json`, as a
// `!command` that reads `providers.json`, because the key is no longer in any agent env.
//
// ⚠️ THE COMMAND IS RUN THE WAY PI RUNS IT: `execSync(<value minus "!">)` — `/bin/sh -c`,
// pi's own environment, stdin ignored (pi 0.84.4 `resolve-config-value.js`,
// `executeWithDefaultShell`). With `PATH` pointing nowhere, so a command that depended
// on `node` or `jq` being on PATH fails here rather than on a box image without them.
const SENTINEL = "TESTONLY-1dc24c1c-pi-auth-sentinel";
const PI_AGENT = "node /opt/pi-acp/dist/index.js";

type Fixture = { root: string; providersPath: string; env: NodeJS.ProcessEnv };

function fixture(providers: unknown): Fixture {
  // A space AND an apostrophe in the path: the command quotes it for `/bin/sh`.
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-auth-"));
  const home = join(root, "pro viders'q");
  mkdirSync(home, { recursive: true });
  const providersPath = join(home, "providers.json");
  if (providers !== undefined) {
    writeFileSync(providersPath, JSON.stringify(providers), { mode: 0o600 });
  }
  writeFileSync(
    join(root, "pi-knowledge.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), ids: [] }),
  );
  writeFileSync(
    join(root, "models-cache.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), models: [] }),
  );
  resetPiKnowledgeMemo();
  return {
    root,
    providersPath,
    env: {
      HOME: join(root, "home"),
      ACPX_PI_KNOWLEDGE_CACHE: join(root, "pi-knowledge.json"),
      ACPX_MODELS_CACHE: join(root, "models-cache.json"),
      ACPX_PI_BOX_AGENT_DIR: join(root, "box-agent"),
      ACPX_PI_EXTENSIONS_SEED: "off",
      PATH: "/nonexistent-so-a-spawn-cannot-silently-succeed",
    },
  };
}

function spawnPi(fx: Fixture, sessionId: string) {
  const plan = applyHarnessConfigDir({
    env: { ...fx.env },
    agentCommand: PI_AGENT,
    sessionId,
    rootDir: join(fx.root, "cfg"),
    providersPath: fx.providersPath,
  });
  assert.ok(plan, "pi must produce a config dir");
  return plan;
}

function openRouter(entry: Record<string, unknown>): unknown {
  return { version: 1, providers: { openrouter: { env: "OPENROUTER_API_KEY", ...entry } } };
}

/** What pi does with an `auth.json` key value that starts with `!`. */
function runAsPi(keyValue: string, env: NodeJS.ProcessEnv): string {
  assert.ok(keyValue.startsWith("!"), "the key value must be a command reference");
  return execSync(keyValue.slice(1), {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function readAuth(dir: string): Record<string, { type: string; key: string }> {
  return JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as Record<
    string,
    { type: string; key: string }
  >;
}

test("after a pi spawn, the per-session auth.json carries openrouter as a command reference — never the key", () => {
  const fx = fixture(openRouter({ apiKey: SENTINEL }));
  try {
    const plan = spawnPi(fx, "pi-auth-command");
    const authPath = join(plan.dir, "auth.json");
    assert.ok(plan.files.includes(authPath), "the plan must report auth.json as written");
    const text = readFileSync(authPath, "utf8");
    assert.ok(!text.includes(SENTINEL), "auth.json must not hold the key value");
    const entry = readAuth(plan.dir).openrouter;
    assert.equal(entry.type, "api_key");
    // Positive control for the absence above: the command really does yield the key.
    assert.equal(runAsPi(entry.key, { PATH: "/nonexistent" }), SENTINEL);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("the command follows a re-minted key with no respawn of acpx — it reads the file when pi starts", () => {
  const fx = fixture(openRouter({ apiKey: SENTINEL }));
  try {
    const { key } = readAuth(spawnPi(fx, "pi-auth-rotate").dir).openrouter;
    writeFileSync(fx.providersPath, JSON.stringify(openRouter({ apiKey: `${SENTINEL}-rotated` })));
    assert.equal(runAsPi(key, { PATH: "/nonexistent" }), `${SENTINEL}-rotated`);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("apiKeyEnv beats the literal inside the command, as in resolveBoxProviderKey", () => {
  const fx = fixture(openRouter({ apiKey: SENTINEL, apiKeyEnv: "HP_1DC_INDIRECT" }));
  try {
    const { key } = readAuth(spawnPi(fx, "pi-auth-indirect").dir).openrouter;
    assert.equal(runAsPi(key, { HP_1DC_INDIRECT: "indirect-value" }), "indirect-value");
    assert.equal(runAsPi(key, {}), SENTINEL, "control: without the variable the literal wins");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("respawn is idempotent, and entries pi wrote into the per-session file are kept", () => {
  const fx = fixture(openRouter({ apiKey: SENTINEL }));
  try {
    const first = spawnPi(fx, "pi-auth-respawn");
    const before = readFileSync(join(first.dir, "auth.json"), "utf8");
    assert.equal(
      readFileSync(join(spawnPi(fx, "pi-auth-respawn").dir, "auth.json"), "utf8"),
      before,
    );

    // A `/login` during the session writes its own entry; the next spawn of the same
    // session dir must not drop it — and must still (re)write `openrouter`.
    const withLogin = { ...readAuth(first.dir), anthropic: { type: "api_key", key: "TESTONLY-x" } };
    delete (withLogin as Record<string, unknown>).openrouter;
    writeFileSync(join(first.dir, "auth.json"), JSON.stringify(withLogin));
    const after = readAuth(spawnPi(fx, "pi-auth-respawn").dir);
    assert.equal(after.anthropic?.key, "TESTONLY-x");
    assert.equal(after.openrouter?.key, JSON.parse(before).openrouter.key);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("no openrouter provider on the box: no auth.json entry is written", () => {
  for (const [label, providers] of [
    ["no providers.json", undefined],
    ["another provider only", { version: 1, providers: { other: { env: "X", apiKey: SENTINEL } } }],
    ["openrouter with no resolvable key", openRouter({ apiKeyEnv: "HP_1DC_ABSENT" })],
  ] as const) {
    const fx = fixture(providers);
    try {
      const plan = spawnPi(fx, `pi-auth-none-${label.replaceAll(" ", "-")}`);
      assert.equal(existsSync(join(plan.dir, "auth.json")), false, `${label}: auth.json written`);
      assert.ok(plan.files.length > 0, `control (${label}): the dir was provisioned`);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});
