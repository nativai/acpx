import assert from "node:assert/strict";
import test from "node:test";
import { acpAdapterKind } from "../src/acp/agent-command.js";

// brick://4dd3ee2c — the copy/fork/byway agent-lock must treat two command
// spellings that drive the SAME adapter as the same agent type. The regression:
// a claude-pty session created under `.../acp-server-transcript.mjs` (the root
// shim) could not be forked once the resolver yielded `.../dist/index.js` (the
// registry default) — the two are the SAME program, but the lock compared raw
// command strings and rejected the copy, surfacing as a 502 on byway-create.
test("acpAdapterKind maps both claude-pty command spellings to the same kind", () => {
  const distDefault = "node /opt/claude-pty-acp/dist/index.js";
  const mjsShim = "node /opt/claude-pty-acp/acp-server-transcript.mjs";
  assert.equal(acpAdapterKind(distDefault), "claude-pty");
  assert.equal(acpAdapterKind(mjsShim), "claude-pty");
  assert.equal(acpAdapterKind(distDefault), acpAdapterKind(mjsShim));
  // A dev-worktree override still classifies as claude-pty (path contains the
  // repo name / server-script name).
  assert.equal(
    acpAdapterKind("node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs"),
    "claude-pty",
  );
});

test("acpAdapterKind classifies the other known adapters", () => {
  assert.equal(acpAdapterKind("node /opt/claude-agent-acp/dist/index.js"), "claude");
  assert.equal(acpAdapterKind("node /opt/codex-acp/dist/index.js"), "codex");
  assert.equal(acpAdapterKind("gemini --acp"), "gemini");
  assert.equal(acpAdapterKind("copilot --acp --stdio"), "copilot");
});

test("acpAdapterKind returns undefined for a raw/unknown command (strict escape hatch)", () => {
  assert.equal(acpAdapterKind("node /tmp/some-custom-agent.js --agent"), undefined);
  assert.equal(acpAdapterKind("my-weird-acp serve"), undefined);
  assert.equal(acpAdapterKind(""), undefined);
});
