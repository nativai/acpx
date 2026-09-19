import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveAndEnsureAgentFolder,
  sanitizeAgentFolderName,
} from "../src/cli/session/agent-folder.js";
import type { SessionRecord } from "../src/types.js";

function recordWith(fields: Partial<SessionRecord>): SessionRecord {
  return {
    acpxRecordId: "f186ee80-1111-2222-3333-444444444444",
    ...fields,
  } as unknown as SessionRecord;
}

async function withBaseDir(run: (baseDir: string) => Promise<void> | void): Promise<void> {
  const taskDir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-agent-folder-"));
  try {
    await run(taskDir);
  } finally {
    await fsp.rm(taskDir, { recursive: true, force: true });
  }
}

// --- sanitizeAgentFolderName ---

test("sanitizeAgentFolderName lowercases and replaces filesystem-unsafe characters", () => {
  assert.equal(sanitizeAgentFolderName("Agent Context Plumbing"), "agent-context-plumbing");
  assert.equal(sanitizeAgentFolderName("feat/Spawn:Task@host"), "feat-spawn-task-host");
});

test("sanitizeAgentFolderName collapses repeats and strips leading/trailing separators", () => {
  assert.equal(sanitizeAgentFolderName("  --a___b..  "), "a___b");
  // dots, underscores and single dashes are allowed mid-segment
  assert.equal(sanitizeAgentFolderName("a.b_c-d"), "a.b_c-d");
});

test("sanitizeAgentFolderName returns undefined for empty / dot-only / separator-only names", () => {
  assert.equal(sanitizeAgentFolderName(undefined), undefined);
  assert.equal(sanitizeAgentFolderName(""), undefined);
  assert.equal(sanitizeAgentFolderName("   "), undefined);
  assert.equal(sanitizeAgentFolderName("."), undefined);
  assert.equal(sanitizeAgentFolderName(".."), undefined);
  assert.equal(sanitizeAgentFolderName("---"), undefined);
});

test("sanitizeAgentFolderName caps the length at 64 characters", () => {
  const result = sanitizeAgentFolderName("x".repeat(200));
  assert.equal(result?.length, 64);
});

// --- resolveAndEnsureAgentFolder ---

test("resolveAndEnsureAgentFolder returns null when there is no usable brick path", () => {
  assert.equal(resolveAndEnsureAgentFolder(recordWith({})), null);
  assert.equal(resolveAndEnsureAgentFolder(recordWith({ metadata: {} })), null);
  assert.equal(resolveAndEnsureAgentFolder(recordWith({}), "   "), null);
});

test("resolveAndEnsureAgentFolder returns null for a non-absolute brick path (no mkdir)", () => {
  assert.equal(resolveAndEnsureAgentFolder(recordWith({}), "relative/brick"), null);
});

test("resolveAndEnsureAgentFolder returns null and creates nothing when the brick dir is missing", () => {
  const missing = path.join(os.tmpdir(), "acpx-agent-folder-missing-7f3a1b9c2d");
  assert.equal(resolveAndEnsureAgentFolder(recordWith({}), missing), null);
  assert.equal(fs.existsSync(missing), false);
});

test("resolveAndEnsureAgentFolder creates <brick>/agents/<name>-<id8> and returns the absolute path", async () => {
  await withBaseDir((brickDir) => {
    const record = recordWith({
      acpxRecordId: "f186ee80-aaaa-bbbb-cccc-dddddddddddd",
      name: "Conception Agent",
      metadata: { brick: "11111111-2222-3333-4444-555555555555" },
    });
    const expected = path.join(brickDir, "agents", "conception-agent-f186ee80");
    assert.equal(resolveAndEnsureAgentFolder(record, brickDir), expected);
    assert.ok(fs.statSync(expected).isDirectory());
  });
});

// brick b11f98fb — the legacy `metadata.task_folder` fallback is GONE. This is the
// specimen the removal has to be proven against: a pre-removal record that still
// carries the key, pointing at a directory that really exists. Before the removal
// this returned `<taskDir>/agents/...` and created it; now it must return null and
// create NOTHING, while the record itself loads and its live keys are untouched.
test("resolveAndEnsureAgentFolder ignores a legacy metadata.task_folder entirely", async () => {
  await withBaseDir((taskDir) => {
    const record = recordWith({
      acpxRecordId: "f186ee80-aaaa-bbbb-cccc-dddddddddddd",
      name: "Legacy Agent",
      metadata: { task_folder: taskDir },
    });
    assert.equal(resolveAndEnsureAgentFolder(record), null);
    assert.equal(resolveAndEnsureAgentFolder(record, null), null);
    assert.equal(fs.existsSync(path.join(taskDir, "agents")), false);
    // The orphan key survives on the record — nothing migrates or strips it.
    assert.equal((record.metadata as Record<string, string>).task_folder, taskDir);
  });
});

// A live brick path still wins on a record that ALSO carries the legacy key, and the
// folder lands under the brick — never under the stale task folder.
test("resolveAndEnsureAgentFolder uses the brick path on a record that still has task_folder", async () => {
  await withBaseDir(async (taskDir) => {
    const brickDir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-agent-brick-"));
    try {
      const record = recordWith({
        acpxRecordId: "f186ee80-aaaa-bbbb-cccc-dddddddddddd",
        name: "Brick Agent",
        metadata: { brick: "11111111-2222-3333-4444-555555555555", task_folder: taskDir },
      });
      const expected = path.join(brickDir, "agents", "brick-agent-f186ee80");
      assert.equal(resolveAndEnsureAgentFolder(record, brickDir), expected);
      assert.ok(fs.statSync(expected).isDirectory());
      assert.equal(fs.existsSync(path.join(taskDir, "agents")), false);
    } finally {
      await fsp.rm(brickDir, { recursive: true, force: true });
    }
  });
});
