import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

test("ac86eb34 GUARDRAIL: opencode and the Claude family never gain the variable", () => {
  const { root, box, cwd } = fixture();
  try {
    for (const id of ["claude", "claude-pty", "codex", "opencode"] as const) {
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
