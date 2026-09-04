import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deriveHarnessCapabilities,
  HARNESS_FACTS,
  HARNESS_IDS,
} from "../src/acp/harness-capabilities.js";
import {
  applyHarnessConfigDir,
  pruneOrphanHarnessConfigDirs,
  removeHarnessConfigDir,
} from "../src/acp/harness-config-dir.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { setHarnessConfigDir } from "../src/session/mode-preference.js";
import type { SessionRecord } from "../src/types.js";

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

// ── F-8 (brick 161294ce): no shared literal, and a blank id is REFUSED ───────

test("a BLANK session id is REFUSED — no dir, no env, no shared literal", () => {
  // ⚠️ THE DEFECT THIS PINS SHIPPED. The call site read
  // `acpxRecordId?.trim() || "session"`, and on the real `sessions new` path the
  // record id is EMPTY at adapter-spawn time (`creationSessionContext` sets
  // `acpxRecordId: ""`, because the CLI record id IS the adapter's own
  // session/new id and cannot exist before the spawn that produces it). So the
  // literal fired on EVERY create and two distinct sessions were handed the same
  // `/tmp/acpx-<harness>-session`.
  //
  // A fallback that silently de-isolates is worse than an error, so there is no
  // fallback: a blank id refuses.
  withTempRoot((root) => {
    for (const id of ["opencode", "pi"] as const) {
      for (const blank of ["", "   "]) {
        const env: NodeJS.ProcessEnv = {};
        const plan = applyHarnessConfigDir({
          env,
          agentCommand: AGENT_REGISTRY[id],
          sessionId: blank,
          primer: "P",
          rootDir: root,
        });
        assert.equal(plan, undefined, `${id}: a blank id produced a plan`);
        assert.deepEqual(Object.keys(env), [], `${id}: a blank id set env vars`);
      }
    }
    // NOTHING was written — and the directory listing is the evidence, not the
    // absence of a return value.
    assert.deepEqual(readdirSync(root), []);
  });
});

test("two spawns of the SAME session id share a dir; different ids never do", () => {
  withTempRoot((root) => {
    const a: NodeJS.ProcessEnv = {};
    const b: NodeJS.ProcessEnv = {};
    const c: NodeJS.ProcessEnv = {};
    const mk = (env: NodeJS.ProcessEnv, sessionId: string) =>
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY.opencode,
        sessionId,
        primer: "P",
        rootDir: root,
      });
    assert.equal(mk(a, "same-id")?.dir, mk(b, "same-id")?.dir);
    assert.notEqual(mk(a, "same-id")?.dir, mk(c, "other-id")?.dir);
    // The literal is GONE: no directory is named for a constant.
    assert.equal(
      readdirSync(root).some((entry) => entry.endsWith("-session")),
      false,
      "a shared literal directory was created",
    );
  });
});

// ── 433f6bf8: cleanup — remove-on-close and the orphan sweep ────────────────

test("removeHarnessConfigDir deletes a config dir and REFUSES anything else", () => {
  withTempRoot((root) => {
    const env: NodeJS.ProcessEnv = {};
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses_rm",
      primer: "P",
      rootDir: root,
    });
    assert.ok(plan);
    assert.equal(existsSync(plan.dir), true, "control: the dir must exist before removal");
    removeHarnessConfigDir(plan.dir);
    assert.equal(existsSync(plan.dir), false);

    // A path this module could never have created is left ALONE — otherwise a
    // caller passing the wrong string gets an arbitrary recursive delete.
    const foreign = join(root, "not-ours");
    mkdirSync(foreign, { recursive: true });
    removeHarnessConfigDir(foreign);
    assert.equal(existsSync(foreign), true, "a non-config directory was deleted");
  });
});

test("the orphan sweep removes dead dirs, RETAINS live ones, and prints its population", () => {
  withTempRoot((root) => {
    for (const [harness, id] of [
      ["opencode", "live-1"],
      ["opencode", "dead-1"],
      ["pi", "dead-2"],
    ] as const) {
      applyHarnessConfigDir({
        env: {},
        agentCommand: AGENT_REGISTRY[harness],
        sessionId: id,
        primer: "P",
        rootDir: root,
      });
    }
    // ⚠️ A DIRECTORY THAT IS NOT OURS. `cli/queue/paths.ts` creates
    // `/tmp/acpx-<hash>` for queue sockets — found by ENUMERATING the consumers
    // of this name, not by recalling them. The sweep must never touch it.
    const queueDir = join(root, "acpx-0a1b2c3d4e");
    mkdirSync(queueDir, { recursive: true });

    const result = pruneOrphanHarnessConfigDirs({
      liveSessionIds: new Set(["live-1"]),
      rootDir: root,
    });

    // POPULATION FIRST: 0 scanned would mean NOT RUN, not clean.
    assert.equal(result.scanned, 3, "scanned population is wrong — the sweep saw the wrong set");
    assert.equal(result.removed.length, 2);
    assert.equal(result.retained, 1);
    assert.equal(existsSync(queueDir), true, "the queue socket dir was swept — it is not ours");
    assert.equal(
      readdirSync(root).some((entry) => entry.endsWith("-live-1")),
      true,
      "a LIVE session's dir was removed",
    );
  });
});

test("the sweep on an unreadable root reports scanned=0 — NOT RUN, not clean", () => {
  const result = pruneOrphanHarnessConfigDirs({
    liveSessionIds: new Set(),
    rootDir: "/nonexistent-hp-b3-root-zzz9",
  });
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.removed, []);
});

// ── RS-14 (fa2e54ec): the recorded-path field, and its ABSENCE ──────────────

test("RS-14: setHarnessConfigDir leaves a no-config-dir record COMPLETELY untouched", () => {
  // ⚠️ ABSENT — not null, not {}. This runs with `undefined` on EVERY claude /
  // claude-pty / codex spawn, because only opencode and pi get a config dir. An
  // unconditional `record.acpx = clone ?? {}` would give a record whose `acpx`
  // was previously absent an empty object, changing the record SHAPE for three
  // harnesses the programme requires untouched — and record shape is consumed by
  // parse, serialize, the index projection and the UI.
  for (const acpx of [undefined, {}, { current_model_id: "x" }]) {
    const record = { agentCommand: CLAUDE, ...(acpx ? { acpx } : {}) } as unknown as SessionRecord;
    const before = JSON.stringify(record);
    setHarnessConfigDir(record, undefined);
    assert.equal(JSON.stringify(record), before, `record changed for acpx=${JSON.stringify(acpx)}`);
  }
  // The scan a tester runs: no key named harness_config_dir at ANY depth.
  const record = { agentCommand: CLAUDE } as unknown as SessionRecord;
  setHarnessConfigDir(record, undefined);
  assert.equal(pathsContainKey(record, "harness_config_dir"), 0);
  // PLANTED CONTROL, same scanner: it CAN see the key when it is there.
  setHarnessConfigDir(record, "/tmp/acpx-opencode-planted");
  assert.equal(pathsContainKey(record, "harness_config_dir"), 1, "the scanner is blind");
});

test("RS-14: a spawn that writes no dir CLEARS a stale recorded path", () => {
  // A stale path that still resolves is a silent WRONG answer — worse than a
  // miss — so it must not survive a spawn that produced no directory.
  const record = { agentCommand: CLAUDE } as unknown as SessionRecord;
  setHarnessConfigDir(record, "/tmp/acpx-opencode-old");
  assert.equal(record.acpx?.harness_config_dir, "/tmp/acpx-opencode-old");
  setHarnessConfigDir(record, undefined);
  assert.equal(record.acpx?.harness_config_dir, undefined);
  assert.equal(pathsContainKey(record, "harness_config_dir"), 0);
});

test("RS-14: the recorded path SURVIVES the per-turn acpx-state clone", () => {
  // The leg that ate `depth_projection`. `cloneSessionAcpxState` is an allowlist
  // the turn path re-bases `record.acpx` off, so a field it does not name is
  // dropped on EVERY REAL TURN — silently, with typecheck and the unit suite
  // green. Asserted as a PROPERTY, not as a source-text presence check.
  const record = { agentCommand: AGENT_REGISTRY.opencode } as unknown as SessionRecord;
  setHarnessConfigDir(record, "/tmp/acpx-opencode-survives");
  const cloned = cloneSessionAcpxState(record.acpx);
  assert.equal(cloned?.harness_config_dir, "/tmp/acpx-opencode-survives");
});

/** Count paths whose final key is `key`, at ANY depth — the `paths(..)` scan a
 *  tester runs with jq, expressed in-process. Never a field probe: a wrong path
 *  returns a silent undefined indistinguishable from the pass condition. */
function pathsContainKey(value: unknown, key: string): number {
  let hits = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key) {
        hits += 1;
      }
      walk(v);
    }
  };
  walk(value);
  return hits;
}
