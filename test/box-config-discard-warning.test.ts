import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// F-13 (brick 6d2ca570) — WARN when the per-session config discards keys the
// box's own `opencode.json` had set.
//
// ⚠️ THE SIGNATURE OF THIS DEFECT IS THAT EVERYTHING ELSE PASSES, WHICH DICTATES
// THE SHAPE OF EVERY ROW HERE. acpx re-points BOTH `OPENCODE_CONFIG_DIR` and
// `XDG_CONFIG_HOME`, so the box config is never read — yet the directory exists,
// the env is correct, the primer arrives and the turn completes. Measured on the
// rig across two sessions: a box-level pin of `deepseek-v4-pro`, a session created
// with NO `--model`, and OpenCode's own store served OpenCode's default
// (`big-pickle`). Nothing failed; the pin simply evaporated.
//
// ⇒ A test that only checks "the session works" CANNOT FAIL HERE. So every row
// asserts the WARNING, and names the key it must name.
//
// ⚠️ SCOPE: this makes the discard LOUD, not stopped. Treating the box config as
// a base and acpx's keys as an overlay is B4's job (brick 13f73472), and a
// per-session `--model` works today and is deliberately untouched.

/** Capture stderr for one call — the warning IS the subject, so it must be read. */
function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow shim for the duration of one call
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  };
  try {
    run();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore the real writer
    (process.stderr as any).write = original;
  }
  return captured;
}

function withBoxConfig(
  boxConfig: Record<string, unknown> | undefined,
  run: (env: NodeJS.ProcessEnv, root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "hp-b3-f13-"));
  try {
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    if (boxConfig) {
      writeFileSync(join(xdg, "opencode", "opencode.json"), JSON.stringify(boxConfig, null, 2));
    }
    run({ XDG_CONFIG_HOME: xdg, HOME: root }, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("F-13 → 13f73472: box keys are CARRIED now, so the warning has nothing to say", () => {
  // ⚠️ THIS ROW USED TO ASSERT THE OPPOSITE, AND THE INVERSION IS THE FIX.
  // F-13's job was to make a silent discard LOUD. The overlay (brick 13f73472)
  // removes the discard itself, so the loudness has nothing left to report: the
  // warning is fed the COMPOSED key set, which contains every box key by
  // construction.
  //
  // ⚠️ THE WARNING IS THEREFORE UNREACHABLE ON THE NORMAL PATH — and it is kept
  // deliberately, because its role has CHANGED rather than ended: it is now a
  // REGRESSION DETECTOR FOR THE OVERLAY. If composition ever stops carrying a box
  // key, this warning is what says so, by name. The mutation probe for 13f73472
  // demonstrates exactly that: with the overlay removed, the old F-13 behaviour
  // returns and the keys are named again.
  withBoxConfig({ model: "openrouter/deepseek/deepseek-v4-pro", theme: "dark" }, (env, root) => {
    const warning = captureStderr(() => {
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY.opencode,
        sessionId: "ses-f13",
        primer: "P", // no --model — the case that used to discard the box's model
        rootDir: root,
      });
    });

    // CONTROL: the spawn genuinely ran and re-pointed the env, so silence here
    // means "nothing was discarded" and not "nothing happened".
    assert.ok(env.OPENCODE_CONFIG_DIR, "the config dir was not created — the row is vacuous");
    assert.equal(warning, "", `box keys are still being discarded: ${warning}`);

    // And the positive half: the keys the warning used to name are now SERVED.
    const served = JSON.parse(
      readFileSync(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(served.model, "openrouter/deepseek/deepseek-v4-pro");
    assert.equal(served.theme, "dark");
  });
});

test("F-13: NO warning when the box config sets nothing the session drops", () => {
  // The negative that makes the positive meaningful. If the warning fired
  // unconditionally, the row above would pass on a build that says nothing useful.
  withBoxConfig({ instructions: ["/somewhere/else.md"] }, (env, root) => {
    const warning = captureStderr(() => {
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY.opencode,
        sessionId: "ses-f13-b",
        primer: "P", // the session DOES set `instructions`, so nothing is dropped
        rootDir: root,
      });
    });
    assert.ok(env.OPENCODE_CONFIG_DIR, "control: the config dir must have been created");
    assert.equal(warning, "", `expected no warning, got: ${warning}`);
  });
});

test("F-13: NO warning when there is no box config at all", () => {
  withBoxConfig(undefined, (env, root) => {
    const warning = captureStderr(() => {
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY.opencode,
        sessionId: "ses-f13-c",
        primer: "P",
        rootDir: root,
      });
    });
    assert.ok(env.OPENCODE_CONFIG_DIR, "control: the config dir must have been created");
    assert.equal(warning, "", "warned about a box config that does not exist");
  });
});

test("F-13: a per-session --model KEEPS the key, so it is not reported as discarded", () => {
  // Scope guard: the per-session pin works and is untouched. If this row ever
  // reports `model` as discarded, the warning has started lying about a path that
  // functions correctly — which would be worse than not warning at all.
  withBoxConfig({ model: "openrouter/deepseek/deepseek-v4-pro" }, (env, root) => {
    const warning = captureStderr(() => {
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY.opencode,
        sessionId: "ses-f13-d",
        primer: "P",
        model: "openrouter/z-ai/glm-5.3-flash",
        rootDir: root,
      });
    });
    assert.ok(env.OPENCODE_CONFIG_DIR, "control: the config dir must have been created");
    assert.equal(warning, "", `a session that PINS a model must not warn about it: ${warning}`);
  });
});

test("F-13: a box config that is not a JSON object names nothing", () => {
  // A JSON array parses perfectly well, and `Object.keys` on it yields "0", "1",
  // … — a warning that names array indices as discarded settings is worse than
  // silence, because it sends the reader after keys that do not exist.
  const root = mkdtempSync(join(tmpdir(), "hp-b3-f13-arr-"));
  try {
    const xdg = join(root, "xdg");
    mkdirSync(join(xdg, "opencode"), { recursive: true });
    writeFileSync(join(xdg, "opencode", "opencode.json"), '["model", "theme"]');
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: xdg, HOME: root };
    const warning = captureStderr(() => {
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY.opencode,
        sessionId: "ses-f13-e",
        primer: "P",
        rootDir: root,
      });
    });
    assert.ok(env.OPENCODE_CONFIG_DIR, "control: the config dir must have been created");
    assert.equal(warning, "", `named indices from a non-object config: ${warning}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("F-13 GUARDRAIL: claude/claude-pty/codex never reach this path", () => {
  // They get no config dir, so they discard nothing and must stay silent — the
  // programme's standing requirement that the three are untouched.
  withBoxConfig({ model: "something" }, (env, root) => {
    for (const id of ["claude", "claude-pty", "codex"] as const) {
      const warning = captureStderr(() => {
        applyHarnessConfigDir({
          env: { ...env },
          agentCommand: AGENT_REGISTRY[id],
          sessionId: `ses-${id}`,
          primer: "P",
          rootDir: root,
        });
      });
      assert.equal(warning, "", `${id}: warned about a config dir it never receives`);
    }
  });
});
