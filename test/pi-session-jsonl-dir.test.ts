import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// ac86eb34 — pi's session JSONL must keep landing where IR-3 reads it.
//
// ⚠️ THE DEFECT. `PI_CODING_AGENT_DIR` is pi's DATA dir as well as its config
// dir, so B3 re-pointing it for the primer took the session store along. The
// JSONL was still WRITTEN — that is measured, and it matters: this is not "pi
// stopped writing", it is acpx sending it somewhere disposable. pi's per-message
// JSONL is IR-3's SECOND authority for pi, so every pi served-model claim was
// left on one leg.
//
// ⚠️ THE TRAP THAT MAKES A PATH CHECK WORTHLESS HERE. pi honours
// `PI_CODING_AGENT_SESSION_DIR`, but treats it as the FINAL directory — NOT as a
// root it appends `--<cwd>--` to. Measured against the real pi 0.84.4 binary with
// real turns:
//
//   ARM A  PI_CODING_AGENT_DIR only (today)      → JSONL under the per-session
//                                                  dir, at `sessions/--<cwd>--/`
//   ARM B  + SESSION_DIR = a store ROOT          → JSONL written FLAT into it
//   ARM C  + SESSION_DIR = the MANGLED subdir    → JSONL at the IR-3 path, with
//                                                  real content
//
// Arm B is why the obvious fix is wrong: it produces a directory that exists and
// is written to, and is still not the one IR-3 reads. Only arm C's shape works,
// and that is the shape asserted below.
//
// ⚠️ AND: pointed at a directory that does NOT exist, pi HANGS — rc=124 on a
// 150s timeout with EMPTY stdout and EMPTY stderr. So the target is created here,
// and a row below pins that it is.

const HOME_FIXTURE = "hp-ac86eb34-";

function fixture(): { root: string; box: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), HOME_FIXTURE));
  const box = join(root, "box-agent");
  const cwd = join(root, "work");
  mkdirSync(box, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, box, cwd };
}

/** pi's own mangling, as measured — kept here independently of the source so the
 *  test would notice the implementation drifting away from it. */
function expectedName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

test("ac86eb34: pi's session dir is pinned to the BOX store, at the cwd-mangled path", () => {
  const { root, box, cwd } = fixture();
  try {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: box, HOME: root };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-jsonl",
      primer: "P",
      cwd,
      rootDir: root,
    });

    assert.ok(plan, "no plan — the config dir was never created");
    const expected = join(box, "sessions", expectedName(cwd));
    assert.equal(
      env.PI_CODING_AGENT_SESSION_DIR,
      expected,
      "the session store was not pinned to the IR-3 path",
    );

    // ⚠️ NOT the store ROOT. This is arm B, the fix that half-works: a directory
    // that exists, is written to, and is not the one IR-3 reads.
    assert.notEqual(
      env.PI_CODING_AGENT_SESSION_DIR,
      join(box, "sessions"),
      "the session dir was pinned to the store ROOT — pi writes FLAT there",
    );

    // CONTROL: the config dir really was re-pointed, so this row is about the
    // session store surviving that move and not about a spawn that never happened.
    assert.ok(env.PI_CODING_AGENT_DIR, "PI_CODING_AGENT_DIR unset");
    assert.notEqual(env.PI_CODING_AGENT_DIR, box, "the agent dir was never moved");
    assert.deepEqual(plan.envNames, ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ac86eb34: the target directory EXISTS before pi is started", () => {
  // ⚠️ NOT COSMETIC. Measured: with the variable naming a missing directory, pi
  // hangs — no output on either stream, no error. A missing mkdir does not
  // degrade, it wedges the session and looks exactly like a slow model.
  const { root, box, cwd } = fixture();
  try {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: box, HOME: root };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-mkdir",
      primer: "P",
      cwd,
      rootDir: root,
    });
    const target = env.PI_CODING_AGENT_SESSION_DIR;
    assert.ok(target, "no session dir was set at all");
    assert.equal(existsSync(target), true, `pi would HANG: ${target} does not exist`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ac86eb34: with no box PI_CODING_AGENT_DIR, pi's documented default is used", () => {
  // `~/.pi/agent` — read from pi's own `getAgentDir()`, which is
  // `process.env[ENV_AGENT_DIR] ?? join(homedir(), CONFIG_DIR_NAME, "agent")`
  // with `CONFIG_DIR_NAME = ".pi"`. NOT the rig's `.pi-agent`, which is the rig's
  // own choice of override and would be wrong for every other box.
  const { root, cwd } = fixture();
  try {
    const env: NodeJS.ProcessEnv = { HOME: root };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-default",
      primer: "P",
      cwd,
      rootDir: root,
    });
    assert.equal(
      env.PI_CODING_AGENT_SESSION_DIR,
      join(root, ".pi", "agent", "sessions", expectedName(cwd)),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ac86eb34: with NO cwd the session dir is left alone rather than invented", () => {
  // A path guessed without a cwd would be a directory pi writes to and nobody
  // reads. Leaving the variable unset keeps today's behaviour — degraded but
  // alive — which is the honest degradation.
  const { root, box } = fixture();
  try {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: box, HOME: root };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-nocwd",
      primer: "P",
      rootDir: root,
    });
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, undefined, "a session dir was invented");
    assert.deepEqual(
      plan?.envNames,
      ["PI_CODING_AGENT_DIR"],
      "the plan claims a var it did not set",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ac86eb34: the mangling matches pi's, including the drive-colon case", () => {
  // Transcribed from `pi-agent-core` `repo.js:13-15`, not approximated: a
  // near-miss produces a directory that exists, is written to, and is not the one
  // IR-3 reads. The `:` clause is in pi's regex and is pinned here so a
  // simplification to slashes-only would fail.
  const { root, box } = fixture();
  try {
    for (const cwd of ["/a/b/c", "/tmp/x-y/z", "/a/b:c/d"]) {
      const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: box, HOME: root };
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY.pi,
        sessionId: `ses-${cwd.replace(/\W/g, "")}`,
        primer: "P",
        cwd,
        rootDir: root,
      });
      assert.equal(
        env.PI_CODING_AGENT_SESSION_DIR,
        join(box, "sessions", expectedName(cwd)),
        `mangling drifted for ${cwd}`,
      );
    }
    assert.equal(expectedName("/a/b:c/d"), "--a-b-c-d--", "the colon clause was dropped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// brick://cb214e48 — a pi child of a pi PARENT inherits the parent's re-pointed
// `PI_CODING_AGENT_DIR`, which acpx then treated as "the box". Measured on devbox
// 2026-09-09: eight pi transcripts (four of them GRANDchildren) written into an
// ancestor's `/tmp/acpx-pi-<id>/sessions/` — a directory removed at that
// ancestor's close, taking the children's only transcript with it.
//
// The rows below are the unit-level pins. The end-to-end one (real spawn, real
// turns, owner killed) is the acceptance criterion in the brick's TEST-PLAN.
// ============================================================================

/** A directory shaped exactly like the one acpx re-points a pi parent at. */
function parentConfigDir(root: string): string {
  return join(root, "acpx-pi-01a08744-8e1f-74ab-93a1-368e09e68a13");
}

test("cb214e48: an inherited acpx-pi-* PI_CODING_AGENT_DIR is REFUSED as the box dir", () => {
  const { root, cwd } = fixture();
  try {
    const parent = parentConfigDir(root);
    mkdirSync(parent, { recursive: true });
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: parent, HOME: root };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-child-of-pi",
      primer: "P",
      cwd,
      rootDir: root,
    });
    assert.equal(
      env.PI_CODING_AGENT_SESSION_DIR,
      join(root, ".pi", "agent", "sessions", expectedName(cwd)),
      "the child's transcript was aimed at the PARENT's throwaway dir",
    );
    // The failure this row exists for, stated as the thing that must NOT be true:
    // any path under the parent's dir is a transcript with somebody else's
    // lifecycle.
    assert.equal(
      env.PI_CODING_AGENT_SESSION_DIR?.startsWith(parent),
      false,
      "the session store is inside another session's throwaway directory",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cb214e48: the holders marker ALONE is enough to refuse a dir — the prefix is not the only leg", () => {
  // The `OR` is deliberate: the two legs cover each other. A dir named without the
  // prefix but carrying acpx's holder bookkeeping is still acpx's own per-session
  // dir, and a transcript in it is still on somebody else's lifecycle clock.
  const { root, cwd } = fixture();
  try {
    const disguised = join(root, "not-prefixed-at-all");
    mkdirSync(join(disguised, ".acpx-holders"), { recursive: true });
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: disguised, HOME: root };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-holders-leg",
      primer: "P",
      cwd,
      rootDir: root,
    });
    assert.equal(
      env.PI_CODING_AGENT_SESSION_DIR,
      join(root, ".pi", "agent", "sessions", expectedName(cwd)),
      "a dir carrying .acpx-holders was accepted as the box dir",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cb214e48: a REAL box dir is still honoured — the refusal is not a blanket ignore", () => {
  // THE CONTROL. Without it, "always derive from HOME" would pass every row above
  // while silently breaking every box that legitimately relocates pi's agent dir.
  const { root, box, cwd } = fixture();
  try {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: box, HOME: root };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-real-box",
      primer: "P",
      cwd,
      rootDir: root,
    });
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, join(box, "sessions", expectedName(cwd)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cb214e48: ACPX_PI_BOX_AGENT_DIR overrides even an acpx-pi-* inherited value", () => {
  // The escape hatch for the one shape of box the refusal could otherwise cost
  // something: pi's agent dir genuinely elsewhere, under a name that trips the
  // predicate.
  const { root, box, cwd } = fixture();
  try {
    const parent = parentConfigDir(root);
    mkdirSync(parent, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      PI_CODING_AGENT_DIR: parent,
      ACPX_PI_BOX_AGENT_DIR: box,
      HOME: root,
    };
    applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-escape-hatch",
      primer: "P",
      cwd,
      rootDir: root,
    });
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, join(box, "sessions", expectedName(cwd)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cb214e48: with NO cwd an inherited PI_CODING_AGENT_SESSION_DIR is DELETED, not left standing", () => {
  // ⚠️ THE EXISTING `with NO cwd …` ROW ABOVE CANNOT SEE THIS LEG. It builds `env`
  // fresh, with nothing inherited, so `undefined` is true there by construction.
  // Seed the parent's value and the old `if (sessionDir)` leaves it standing —
  // aiming the child at the parent's directory for the PARENT's cwd, two sessions'
  // stores colliding in one folder.
  const { root, box } = fixture();
  try {
    const env: NodeJS.ProcessEnv = {
      PI_CODING_AGENT_DIR: box,
      PI_CODING_AGENT_SESSION_DIR: join(root, "acpx-pi-parent", "sessions", "--other-cwd--"),
      HOME: root,
    };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-nocwd-inherited",
      primer: "P",
      rootDir: root,
    });
    assert.equal(
      env.PI_CODING_AGENT_SESSION_DIR,
      undefined,
      "an inherited session dir survived into the child spawn",
    );
    assert.deepEqual(plan?.envNames, ["PI_CODING_AGENT_DIR"]);
    assert.equal(plan?.sessionDir, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cb214e48: the box CATALOGUE is read from the box dir, not the parent's", () => {
  // `readBoxPiOpenRouterModels` had the IDENTICAL inherited-dir bug, and it is
  // invisible in the session-dir rows: plant a distinguishable model in each dir
  // and assert which one reaches the written `models-store.json`.
  const { root, box, cwd } = fixture();
  try {
    const parent = parentConfigDir(root);
    mkdirSync(parent, { recursive: true });
    // `maxTokens` is what makes the entry OBSERVABLE in the written `models.json`
    // (it lands as a `modelOverrides` key), so this row needs no provisioned slug
    // and never reaches the `pi --version` spawn.
    const store = (id: string) =>
      JSON.stringify({ openrouter: { models: [{ id, name: id, maxTokens: 4096 }] } });
    writeFileSync(join(box, "models-store.json"), store("box-only/model"));
    writeFileSync(join(parent, "models-store.json"), store("parent-only/model"));

    const env: NodeJS.ProcessEnv = {
      PI_CODING_AGENT_DIR: parent,
      ACPX_PI_BOX_AGENT_DIR: box,
      HOME: root,
    };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-catalogue",
      primer: "P",
      cwd,
      rootDir: root,
    });
    assert.ok(plan, "no plan — the config dir was never created");
    const written = readFileSync(join(plan.dir, "models.json"), "utf8");
    assert.match(written, /box-only\/model/, "the box catalogue was not carried forward");
    assert.doesNotMatch(written, /parent-only\/model/, "the PARENT's catalogue was read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cb214e48: the plan reports the session dir it handed pi", () => {
  // The carrier for `acpx.pi_session_dir`. Without it the record cannot record the
  // directory, and the fallback error message has nothing to name.
  const { root, box, cwd } = fixture();
  try {
    const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: box, HOME: root };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-plan-sessiondir",
      primer: "P",
      cwd,
      rootDir: root,
    });
    assert.equal(plan?.sessionDir, join(box, "sessions", expectedName(cwd)));
    assert.equal(plan?.sessionDir, env.PI_CODING_AGENT_SESSION_DIR);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ac86eb34 GUARDRAIL: the Claude family and codex never gain the variable", () => {
  const { root, box, cwd } = fixture();
  try {
    for (const id of ["claude", "codex"] as const) {
      const env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: box, HOME: root };
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY[id],
        sessionId: `ses-${id}`,
        primer: "P",
        cwd,
        rootDir: root,
      });
      assert.equal(
        env.PI_CODING_AGENT_SESSION_DIR,
        undefined,
        `${id} gained PI_CODING_AGENT_SESSION_DIR`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
