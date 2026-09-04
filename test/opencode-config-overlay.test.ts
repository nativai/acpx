import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// 13f73472 — the box's opencode.json is the BASE; acpx's keys are an OVERLAY.
//
// ⚠️ THE MEASUREMENT THIS EXISTS FOR, AND WHY IT WAS INVISIBLE. acpx re-points
// BOTH `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`, so the box's own config was
// never read. On the rig, reproduced on two independent sessions: a box-level pin
// of `openrouter/deepseek/deepseek-v4-pro`, a session created with NO `--model`,
// and OpenCode served its own default (`big-pickle`). **Every acpx-side assertion
// passed while the model the box configured was not what served** — which is why
// the rows below assert the COMPOSED FILE ON DISK, the thing OpenCode actually
// reads, and not acpx's intent.
//
// ⚠️ IT KEEPS BOTH PROPERTIES THAT WERE IN TENSION. Sessions still get their own
// directory and cannot write into the box's or each other's (B3's isolation), AND
// a setting configured once for the box survives into every session that does not
// explicitly override it.

function fixture(boxConfig?: Record<string, unknown>): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "hp-13f73472-"));
  const xdg = join(root, "xdg");
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  if (boxConfig) {
    writeFileSync(join(xdg, "opencode", "opencode.json"), JSON.stringify(boxConfig, null, 2));
  }
  return { root, env: { XDG_CONFIG_HOME: xdg, HOME: root } };
}

/** The file OpenCode will actually read — never acpx's intent. */
function servedConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  assert.ok(env.OPENCODE_CONFIG_DIR, "OPENCODE_CONFIG_DIR unset — nothing was written");
  return JSON.parse(readFileSync(join(env.OPENCODE_CONFIG_DIR, "opencode.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function spawn(env: NodeJS.ProcessEnv, root: string, extra: Record<string, unknown> = {}) {
  return applyHarnessConfigDir({
    env,
    agentCommand: AGENT_REGISTRY.opencode,
    sessionId: `ses-${Math.random().toString(36).slice(2, 8)}`,
    primer: "PRIMER",
    rootDir: root,
    ...extra,
  });
}

test("13f73472: a box MODEL survives a session that pins none — the measured failure", () => {
  const { root, env } = fixture({ model: "openrouter/deepseek/deepseek-v4-pro" });
  try {
    spawn(env, root);
    const served = servedConfig(env);
    assert.equal(
      served.model,
      "openrouter/deepseek/deepseek-v4-pro",
      "the box's model was discarded — OpenCode will serve its own default",
    );
    // CONTROL: the overlay still applied, so this is composition and not "acpx
    // wrote nothing".
    assert.ok(Array.isArray(served.instructions), "acpx's primer never reached the config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13f73472: an explicit --model OVERRIDES the box's — that is the point of passing it", () => {
  const { root, env } = fixture({ model: "openrouter/deepseek/deepseek-v4-pro" });
  try {
    spawn(env, root, { model: "openrouter/z-ai/glm-5.3-flash" });
    assert.equal(servedConfig(env).model, "openrouter/z-ai/glm-5.3-flash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13f73472: nested objects DEEP-merge — a box catalogue is not replaced", () => {
  // ⚠️ THE HAZARD A SHALLOW OVERLAY WOULD CAUSE, and it is the same
  // replace-vs-merge risk that keeps `provisionModelId` switched off for pi:
  // writing `provider.openrouter.models.<slug>` shallowly would drop every model
  // the box had declared under that key, while looking like an addition.
  const { root, env } = fixture({
    provider: {
      openrouter: {
        options: { baseURL: "https://openrouter.ai/api/v1" },
        models: { "box/model-a": {}, "box/model-b": {} },
      },
    },
  });
  try {
    spawn(env, root, { provisionModelId: "openrouter/z-ai/glm-5.3-flash" });
    const served = servedConfig(env) as {
      provider: { openrouter: { options?: unknown; models: Record<string, unknown> } };
    };
    assert.deepEqual(
      Object.keys(served.provider.openrouter.models).toSorted(),
      ["box/model-a", "box/model-b", "z-ai/glm-5.3-flash"],
      "the box's declared models were dropped by the overlay",
    );
    assert.ok(served.provider.openrouter.options, "a sibling key under the same object was lost");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13f73472: `instructions` UNIONS — box entries first, acpx's primer last", () => {
  // An array would normally replace. Replacing here IS the discard this brick
  // exists to end: a box that configured instructions would lose them to any
  // session carrying a primer.
  const { root, env } = fixture({ instructions: ["/box/policy.md"] });
  try {
    spawn(env, root);
    const served = servedConfig(env) as { instructions: string[] };
    assert.equal(
      served.instructions.length,
      2,
      `expected both, got ${JSON.stringify(served.instructions)}`,
    );
    assert.equal(served.instructions[0], "/box/policy.md", "box policy must come first");
    assert.match(served.instructions[1], /acpx-primer\.md$/, "acpx's primer must come last");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13f73472: repeated spawns do not ACCUMULATE instructions", () => {
  // The union dedupes, so a session re-spawned into the same box config cannot
  // grow its instruction list every time.
  const { root, env } = fixture({ instructions: ["/box/policy.md", "/box/policy.md"] });
  try {
    spawn(env, root);
    const served = servedConfig(env) as { instructions: string[] };
    assert.equal(
      new Set(served.instructions).size,
      served.instructions.length,
      "duplicates survived",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13f73472: unrelated box keys are carried through untouched", () => {
  const { root, env } = fixture({ theme: "dark", share: "disabled", autoupdate: false });
  try {
    spawn(env, root);
    const served = servedConfig(env);
    assert.equal(served.theme, "dark");
    assert.equal(served.share, "disabled");
    assert.equal(served.autoupdate, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13f73472: ISOLATION is preserved — the box's own file is never written", () => {
  // The property B3 bought and this must not spend. The composed config goes into
  // the per-session dir; the box's file is read-only input.
  const { root, env } = fixture({ model: "box/model", theme: "dark" });
  const boxPath = join(root, "xdg", "opencode", "opencode.json");
  const before = readFileSync(boxPath, "utf8");
  try {
    spawn(env, root, { model: "session/model" });
    assert.equal(readFileSync(boxPath, "utf8"), before, "acpx wrote into the BOX's config file");
    assert.notEqual(
      env.OPENCODE_CONFIG_DIR,
      join(root, "xdg", "opencode"),
      "the session was pointed at the box's own config dir — isolation lost",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13f73472: the F-13 warning goes SILENT, because nothing is discarded any more", () => {
  // ⚠️ NOT DEFANGED — fed the COMPOSED key set. A warning that goes quiet because
  // the defect is fixed is its correct end state; one that goes quiet because it
  // was disabled is a regression wearing the same output.
  const { root, env } = fixture({ model: "openrouter/deepseek/deepseek-v4-pro", theme: "dark" });
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow shim for one call
  (process.stderr as any).write = (chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  };
  try {
    spawn(env, root);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
    (process.stderr as any).write = original;
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(captured, "", `keys are still being discarded: ${captured}`);
});

test("13f73472: with NO box config, behaviour is exactly today's", () => {
  const { root, env } = fixture();
  try {
    spawn(env, root, { model: "session/model" });
    const served = servedConfig(env);
    assert.deepEqual(Object.keys(served).toSorted(), ["instructions", "model"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("13f73472: a MALFORMED box config degrades to today's behaviour, never throws", () => {
  const { root, env } = fixture();
  writeFileSync(join(root, "xdg", "opencode", "opencode.json"), "{ not json at all");
  try {
    spawn(env, root, { model: "session/model" });
    assert.equal(servedConfig(env).model, "session/model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
