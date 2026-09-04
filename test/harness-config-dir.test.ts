import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveHarnessCapabilities,
  HARNESS_FACTS,
  HARNESS_IDS,
} from "../src/acp/harness-capabilities.js";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// B3 deliverable 5 — ONE per-session config dir serving primer + model pin +
// catalogue fragment, GATED PER HARNESS off the descriptor.
//
// ⚠️ BOUNDARY (IR-15): these tests measure the env object acpx builds for the
// ADAPTER spawn. They CANNOT see the acpx-ui -> acpx boundary (that is RS-01's,
// and RS-01 is structurally blind to this change in both directions), and they
// do not prove the harness READ the files — that is the rig's job (RS-13).

const CLAUDE = "node /opt/claude-agent-acp/dist/index.js";
const CLAUDE_PTY = "node /opt/claude-pty-acp/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";

function withTempRoot<T>(run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "hp-b3-cfgdir-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── THE GUARDRAIL: the three Claude/codex agents gain NOTHING ────────────────

test("GUARDRAIL: claude, claude-pty and codex adapter envs are UNCHANGED", () => {
  withTempRoot((root) => {
    for (const agentCommand of [CLAUDE, CLAUDE_PTY, CODEX]) {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/node" };
      const before = JSON.stringify(env);
      const plan = applyHarnessConfigDir({
        env,
        agentCommand,
        sessionId: "s1",
        primer: "PRIMER-MARKER",
        model: "some-model",
        rootDir: root,
      });
      assert.equal(plan, undefined, `${agentCommand}: a config dir was planned`);
      // POPULATION PRINTED as an assertion, not a hope: the env must be the same
      // SIZE and the same CONTENT. A zero-length env would make "unchanged"
      // vacuously true, so the size is asserted against a known non-zero value.
      assert.equal(Object.keys(env).length, 2, `${agentCommand}: env population changed`);
      assert.equal(JSON.stringify(env), before, `${agentCommand}: env content changed`);
      // And nothing was written to disk for them at all.
      assert.deepEqual(readdirSync(root), [], `${agentCommand}: wrote files it should not have`);
    }
  });
});

test("the gate is the descriptor cell, not a hardcoded harness list", () => {
  // Exactly the harnesses declaring `config-file` get a dir — stated as a
  // population over ALL harnesses so a sixth cannot join silently.
  const gated = HARNESS_IDS.filter(
    (id) => HARNESS_FACTS[id].primerChannel === "config-file",
  ).toSorted();
  assert.deepEqual(gated, ["opencode", "pi"]);
  withTempRoot((root) => {
    for (const id of HARNESS_IDS) {
      const env: NodeJS.ProcessEnv = {};
      const plan = applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY[id],
        sessionId: `s-${id}`,
        primer: "P",
        rootDir: root,
      });
      assert.equal(
        plan !== undefined,
        gated.includes(id),
        `${id}: gate disagrees with its primerChannel cell`,
      );
    }
  });
});

test("an agent command the descriptor cannot classify gets nothing", () => {
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: "some-unknown-adapter --acp",
      sessionId: "s1",
      primer: "P",
      rootDir: root,
    });
    assert.equal(plan, undefined);
    assert.deepEqual(Object.keys(env), ["PATH"]);
  });
});

// ── OpenCode ─────────────────────────────────────────────────────────────────

test("opencode gets BOTH XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR", () => {
  // ⚠️ BOTH, together. OpenCode MERGES config from both, so setting only
  // OPENCODE_CONFIG_DIR does not isolate the session — I1's first negative
  // control failed for exactly this reason.
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = {};
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.opencode,
      sessionId: "ses_1",
      primer: "NV-PRIMER-MARKER",
      model: "openrouter/z-ai/glm-5.3-flash",
      provisionModelId: "openrouter/z-ai/glm-5.3-flash",
      rootDir: root,
    });
    assert.ok(plan);
    assert.deepEqual(plan.envNames.toSorted(), ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"]);
    assert.ok(env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME unset — the session is NOT isolated");
    assert.ok(env.OPENCODE_CONFIG_DIR, "OPENCODE_CONFIG_DIR unset");
    assert.equal(env.OPENCODE_CONFIG_DIR, join(env.XDG_CONFIG_HOME, "opencode"));

    const config = JSON.parse(
      readFileSync(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), "utf8"),
    ) as Record<string, unknown>;

    // 1. the primer, by ABSOLUTE path (I1 R9 — repo-independent)
    const instructions = config.instructions as string[];
    assert.equal(instructions.length, 1);
    assert.ok(instructions[0].startsWith("/"), "instructions path must be absolute");
    assert.equal(readFileSync(instructions[0], "utf8"), "NV-PRIMER-MARKER");
    // 2. the model pin
    assert.equal(config.model, "openrouter/z-ai/glm-5.3-flash");
    // 3. the catalogue fragment — keyed on the BARE slug, provider-prefix stripped
    assert.deepEqual(config.provider, {
      openrouter: { models: { "z-ai/glm-5.3-flash": {} } },
    });
  });
});

test("the catalogue key strips the provider prefix — a prefixed key is never looked up", () => {
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = {};
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.opencode,
      sessionId: "ses_2",
      provisionModelId: "openrouter/anthropic/claude-haiku-4.5",
      rootDir: root,
    });
    // Assert the var EXISTS before reading through it: without this the probe
    // could throw on undefined and read as a broken test rather than a missing
    // config dir.
    assert.ok(env.OPENCODE_CONFIG_DIR, "OPENCODE_CONFIG_DIR unset — nothing to inspect");
    const config = JSON.parse(
      readFileSync(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), "utf8"),
    ) as { provider: { openrouter: { models: Record<string, unknown> } } };
    const keys = Object.keys(config.provider.openrouter.models);
    assert.deepEqual(keys, ["anthropic/claude-haiku-4.5"]);
    // The failure this pins: `provider.openrouter.models.openrouter/...` is never
    // looked up, and the resulting local "model not found" reads exactly like the
    // un-provisioned case it was meant to fix.
    assert.equal(
      keys.some((key) => key.startsWith("openrouter/")),
      false,
    );
  });
});

// ── Pi ───────────────────────────────────────────────────────────────────────

test("pi gets PI_CODING_AGENT_DIR and an APPEND_SYSTEM.md primer", () => {
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = {};
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi",
      primer: "NV-PI-PRIMER",
      rootDir: root,
    });
    assert.ok(plan);
    assert.deepEqual(plan.envNames, ["PI_CODING_AGENT_DIR"]);
    assert.ok(env.PI_CODING_AGENT_DIR, "PI_CODING_AGENT_DIR unset — the session is NOT isolated");
    assert.equal(
      readFileSync(join(env.PI_CODING_AGENT_DIR, "APPEND_SYSTEM.md"), "utf8"),
      "NV-PI-PRIMER",
    );
  });
});

test("pi does NOT get a generated models-store.json — the replace/merge risk", () => {
  // ⚠️ This asserts an ABSENCE ON PURPOSE. It is not an unfinished feature: it is
  // unknown whether a file in PI_CODING_AGENT_DIR merges with or REPLACES Pi's
  // ~371-entry bundled catalogue. I2 proved only that EDITING existing entries is
  // honoured. If the semantics are REPLACE, writing one entry silently removes
  // the rest from every Pi session. Not writing costs one unprovisioned slug
  // failing honestly; writing wrongly costs every session its catalogue.
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = {};
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_pi2",
      primer: "P",
      provisionModelId: "openrouter/z-ai/glm-5.3-flash",
      rootDir: root,
    });
    assert.ok(
      env.PI_CODING_AGENT_DIR,
      "PI_CODING_AGENT_DIR unset — the listing below would be of nothing",
    );
    const written = readdirSync(env.PI_CODING_AGENT_DIR);
    // The absence assertion needs a non-empty listing to be meaningful: an empty
    // dir would satisfy "no models-store.json" vacuously.
    assert.deepEqual(written, ["APPEND_SYSTEM.md"], "a models-store.json was generated");
  });
});

test("pi's arbitrary-model support stays UNROUTED, so the picker offers no failing band", () => {
  // The descriptor consequence of the row above, asserted rather than assumed.
  assert.equal(deriveHarnessCapabilities(HARNESS_FACTS.pi).acceptsArbitraryModelIds, false);
  assert.equal(deriveHarnessCapabilities(HARNESS_FACTS.opencode).acceptsArbitraryModelIds, false);
});

// ── Degradation ──────────────────────────────────────────────────────────────

test("no primer and no model still yields a dir and the env vars", () => {
  // The dir is the isolation boundary as well as the primer carrier: without the
  // env vars OpenCode falls back to /home/node and writes global state there
  // (measured twice by I1 during its own cleanup).
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = {};
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.opencode,
      sessionId: "ses_3",
      rootDir: root,
    });
    assert.ok(plan);
    assert.ok(env.XDG_CONFIG_HOME);
    assert.ok(env.OPENCODE_CONFIG_DIR);
    const config = JSON.parse(
      readFileSync(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(config, {});
  });
});

test("two sessions get two different directories", () => {
  withTempRoot((root) => {
    const a: NodeJS.ProcessEnv = {};
    const b: NodeJS.ProcessEnv = {};
    applyHarnessConfigDir({
      env: a,
      agentCommand: AGENT_REGISTRY.opencode,
      sessionId: "ses_a",
      rootDir: root,
    });
    applyHarnessConfigDir({
      env: b,
      agentCommand: AGENT_REGISTRY.opencode,
      sessionId: "ses_b",
      rootDir: root,
    });
    assert.notEqual(a.XDG_CONFIG_HOME, b.XDG_CONFIG_HOME);
  });
});
