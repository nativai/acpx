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

async function withTaskDir(run: (taskDir: string) => Promise<void> | void): Promise<void> {
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

test("resolveAndEnsureAgentFolder returns null when there is no usable task_folder", () => {
  assert.equal(resolveAndEnsureAgentFolder(recordWith({})), null);
  assert.equal(resolveAndEnsureAgentFolder(recordWith({ metadata: {} })), null);
  assert.equal(resolveAndEnsureAgentFolder(recordWith({ metadata: { task_folder: "   " } })), null);
});

test("resolveAndEnsureAgentFolder returns null for a non-absolute task_folder (no mkdir)", () => {
  assert.equal(
    resolveAndEnsureAgentFolder(recordWith({ metadata: { task_folder: "relative/task" } })),
    null,
  );
});

test("resolveAndEnsureAgentFolder returns null and creates nothing when the task dir is missing", () => {
  const missing = path.join(os.tmpdir(), "acpx-agent-folder-missing-7f3a1b9c2d");
  assert.equal(
    resolveAndEnsureAgentFolder(recordWith({ metadata: { task_folder: missing } })),
    null,
  );
  assert.equal(fs.existsSync(missing), false);
});

test("resolveAndEnsureAgentFolder creates <task>/agents/<name>-<id8> and returns the absolute path", async () => {
  await withTaskDir((taskDir) => {
    const record = recordWith({
      acpxRecordId: "f186ee80-aaaa-bbbb-cccc-dddddddddddd",
      name: "Conception Agent",
      metadata: { task_folder: taskDir },
    });
    const expected = path.join(taskDir, "agents", "conception-agent-f186ee80");
    assert.equal(resolveAndEnsureAgentFolder(record), expected);
    assert.ok(fs.statSync(expected).isDirectory());
  });
});

test("resolveAndEnsureAgentFolder falls back to the bare id8 when the name is empty", async () => {
  await withTaskDir((taskDir) => {
    const record = recordWith({
      acpxRecordId: "abcdef01-2222-3333-4444-555555555555",
      name: "   ",
      metadata: { task_folder: taskDir },
    });
    const expected = path.join(taskDir, "agents", "abcdef01");
    assert.equal(resolveAndEnsureAgentFolder(record), expected);
    assert.ok(fs.statSync(expected).isDirectory());
  });
});

test("resolveAndEnsureAgentFolder gives same-named sibling sessions distinct folders", async () => {
  await withTaskDir((taskDir) => {
    const a = resolveAndEnsureAgentFolder(
      recordWith({
        acpxRecordId: "11111111-aaaa-bbbb-cccc-dddddddddddd",
        name: "conception",
        metadata: { task_folder: taskDir },
      }),
    );
    const b = resolveAndEnsureAgentFolder(
      recordWith({
        acpxRecordId: "22222222-aaaa-bbbb-cccc-dddddddddddd",
        name: "conception",
        metadata: { task_folder: taskDir },
      }),
    );
    assert.equal(a, path.join(taskDir, "agents", "conception-11111111"));
    assert.equal(b, path.join(taskDir, "agents", "conception-22222222"));
    assert.notEqual(a, b);
  });
});
