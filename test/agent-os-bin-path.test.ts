import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACPX_AGENT_OS_BIN_ENV,
  DEFAULT_AGENT_OS_BIN_DIR,
  appendAgentOsBinToPath,
} from "../src/acp/agent-os-bin-path.js";
import { buildAgentSpawnOptions } from "../src/acp/client.js";

const BASE_PATH = "/usr/local/bin:/usr/bin:/bin";

// The real directory name has a space in it; the temp dir carries one too so a split-on-whitespace
// regression cannot pass.
function withOsBinDir(run: (dir: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-os-bin-"));
  const dir = path.join(root, "Operating System", "bin");
  fs.mkdirSync(dir, { recursive: true });
  try {
    run(dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function envWith(pathValue: string | undefined, knob: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (pathValue !== undefined) {
    env.PATH = pathValue;
  }
  if (knob !== undefined) {
    env[ACPX_AGENT_OS_BIN_ENV] = knob;
  }
  return env;
}

test("the default directory is the Operating System bin directory", () => {
  assert.equal(DEFAULT_AGENT_OS_BIN_DIR, "/wisdom/Operating System/bin");
});

test("an existing directory is appended exactly once, at the end of PATH", () => {
  withOsBinDir((dir) => {
    const env = envWith(BASE_PATH, dir);
    appendAgentOsBinToPath(env);
    assert.equal(env.PATH, `${BASE_PATH}:${dir}`);
    assert.equal(env.PATH?.split(":").filter((entry) => entry === dir).length, 1);
    assert.equal(env.PATH?.split(":").at(-1), dir);
    assert.match(dir, / /);
  });
});

test("a missing directory leaves PATH byte-identical", () => {
  const env = envWith(BASE_PATH, "/nonexistent/acpx-os-bin-absent");
  appendAgentOsBinToPath(env);
  assert.equal(env.PATH, BASE_PATH);
});

test("a path that is a file, not a directory, is not appended", () => {
  withOsBinDir((dir) => {
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "");
    const env = envWith(BASE_PATH, file);
    appendAgentOsBinToPath(env);
    assert.equal(env.PATH, BASE_PATH);
  });
});

test("an entry already on PATH is not appended again, wherever it sits", () => {
  withOsBinDir((dir) => {
    for (const existing of [`${BASE_PATH}:${dir}`, `${dir}:${BASE_PATH}`, `/a:${dir}:/b`]) {
      const env = envWith(existing, dir);
      appendAgentOsBinToPath(env);
      assert.equal(env.PATH, existing);
    }
  });
});

test("a second append (a nested spawn) changes nothing", () => {
  withOsBinDir((dir) => {
    const env = envWith(BASE_PATH, dir);
    appendAgentOsBinToPath(env);
    const once = env.PATH;
    appendAgentOsBinToPath(env);
    assert.equal(env.PATH, once);
  });
});

test("the knob empty string disables the append even when the default would apply", () => {
  withOsBinDir((dir) => {
    const env = envWith(BASE_PATH, "");
    appendAgentOsBinToPath(env);
    assert.equal(env.PATH, BASE_PATH);
    // control: the same PATH with the knob pointing at an existing directory does change
    const control = envWith(BASE_PATH, dir);
    appendAgentOsBinToPath(control);
    assert.notEqual(control.PATH, BASE_PATH);
  });
});

test("the knob overrides the default directory", () => {
  withOsBinDir((dir) => {
    const env = envWith(BASE_PATH, dir);
    appendAgentOsBinToPath(env);
    assert.ok(env.PATH?.endsWith(`:${dir}`));
    assert.ok(!env.PATH?.includes(DEFAULT_AGENT_OS_BIN_DIR));
  });
});

test("existing PATH entries keep their order and nothing is dropped", () => {
  withOsBinDir((dir) => {
    const original = "/z/last:/a/first:/m/middle:/a/first";
    const env = envWith(original, dir);
    appendAgentOsBinToPath(env);
    assert.deepEqual(env.PATH?.split(":").slice(0, -1), original.split(":"));
  });
});

test("an unset PATH becomes the directory; an unset PATH with no directory stays unset", () => {
  withOsBinDir((dir) => {
    const env = envWith(undefined, dir);
    appendAgentOsBinToPath(env);
    assert.equal(env.PATH, dir);
  });
  const absent = envWith(undefined, "/nonexistent/acpx-os-bin-absent");
  appendAgentOsBinToPath(absent);
  assert.equal(absent.PATH, undefined);
});

test("a directory whose name contains ':' cannot live in PATH and is skipped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-os-bin-"));
  const dir = path.join(root, "a:b");
  fs.mkdirSync(dir);
  try {
    const env = envWith(BASE_PATH, dir);
    appendAgentOsBinToPath(env);
    assert.equal(env.PATH, BASE_PATH);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildAgentSpawnOptions appends the directory to the spawned adapter's PATH", () => {
  withOsBinDir((dir) => {
    const saved = { path: process.env.PATH, knob: process.env[ACPX_AGENT_OS_BIN_ENV] };
    try {
      process.env.PATH = BASE_PATH;
      process.env[ACPX_AGENT_OS_BIN_ENV] = dir;
      const present = buildAgentSpawnOptions("/tmp", undefined).env;
      assert.equal(present.PATH, `${BASE_PATH}:${dir}`);

      process.env[ACPX_AGENT_OS_BIN_ENV] = "/nonexistent/acpx-os-bin-absent";
      assert.equal(buildAgentSpawnOptions("/tmp", undefined).env.PATH, BASE_PATH);

      process.env[ACPX_AGENT_OS_BIN_ENV] = "";
      assert.equal(buildAgentSpawnOptions("/tmp", undefined).env.PATH, BASE_PATH);
    } finally {
      if (saved.path === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = saved.path;
      }
      if (saved.knob === undefined) {
        delete process.env[ACPX_AGENT_OS_BIN_ENV];
      } else {
        process.env[ACPX_AGENT_OS_BIN_ENV] = saved.knob;
      }
    }
  });
});
