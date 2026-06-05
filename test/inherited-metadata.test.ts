import assert from "node:assert/strict";
import test from "node:test";
import {
  withInheritedAgentCommand,
  withInheritedModel,
  withInheritedReasoningEffort,
  withInheritedSubscription,
  withInheritedTaskFolder,
} from "../src/cli/session/inherited-metadata.js";

test("withInheritedTaskFolder inherits the parent task_folder when child metadata is absent", () => {
  assert.deepEqual(withInheritedTaskFolder(undefined, "/abs/task"), { task_folder: "/abs/task" });
});

test("withInheritedTaskFolder inherits when child metadata has other keys but no task_folder", () => {
  assert.deepEqual(withInheritedTaskFolder({ other: "x" }, "/abs/task"), {
    other: "x",
    task_folder: "/abs/task",
  });
});

test("withInheritedTaskFolder: an explicit child task_folder always wins", () => {
  assert.deepEqual(withInheritedTaskFolder({ task_folder: "/child/task" }, "/parent/task"), {
    task_folder: "/child/task",
  });
});

test("withInheritedTaskFolder: an explicit empty child task_folder still wins (not overwritten)", () => {
  assert.deepEqual(withInheritedTaskFolder({ task_folder: "" }, "/parent/task"), {
    task_folder: "",
  });
});

test("withInheritedTaskFolder: a parent without a task_folder leaves the child unchanged", () => {
  assert.equal(withInheritedTaskFolder(undefined, undefined), undefined);
  assert.equal(withInheritedTaskFolder(undefined, null), undefined);
  assert.deepEqual(withInheritedTaskFolder({ a: "1" }, undefined), { a: "1" });
});

test("withInheritedTaskFolder: a whitespace-only parent task_folder is treated as absent", () => {
  assert.equal(withInheritedTaskFolder(undefined, "   "), undefined);
});

test("withInheritedTaskFolder trims the inherited parent value", () => {
  assert.deepEqual(withInheritedTaskFolder(undefined, "  /abs/task  "), {
    task_folder: "/abs/task",
  });
});

test("withInheritedTaskFolder does not mutate the child metadata object", () => {
  const child = { other: "x" };
  const result = withInheritedTaskFolder(child, "/abs/task");
  assert.notEqual(result, child);
  assert.deepEqual(child, { other: "x" });
});

test("withInheritedSubscription: child inherits the parent sub when it has no explicit selection", () => {
  assert.equal(withInheritedSubscription(undefined, "sub2"), "sub2");
});

test("withInheritedSubscription: an explicit child --subscription wins over the parent", () => {
  assert.equal(withInheritedSubscription("sub1", "sub2"), "sub1");
});

test("withInheritedSubscription: a parent without a sub leaves the child as-is (undefined)", () => {
  assert.equal(withInheritedSubscription(undefined, undefined), undefined);
});

test("withInheritedSubscription: a whitespace-only child is treated as absent → inherits parent", () => {
  assert.equal(withInheritedSubscription("   ", "sub2"), "sub2");
});

test("withInheritedSubscription: a whitespace-only parent is treated as absent", () => {
  assert.equal(withInheritedSubscription(undefined, "   "), undefined);
});

const CLAUDE_CMD = "node /opt/claude-agent-acp/dist/index.js";
const CODEX_CMD = "npx -y @agentclientprotocol/codex-acp@^0.0.44";

test("withInheritedAgentCommand: a bare spawn inherits the parent's agent command", () => {
  assert.equal(withInheritedAgentCommand(CODEX_CMD, false, CLAUDE_CMD), CLAUDE_CMD);
});

test("withInheritedAgentCommand: an explicit child agent always wins over the parent", () => {
  assert.equal(withInheritedAgentCommand(CODEX_CMD, true, CLAUDE_CMD), CODEX_CMD);
});

test("withInheritedAgentCommand: no resolvable parent keeps the child's own command", () => {
  assert.equal(withInheritedAgentCommand(CODEX_CMD, false, undefined), CODEX_CMD);
  assert.equal(withInheritedAgentCommand(CODEX_CMD, false, "   "), CODEX_CMD);
});

test("withInheritedModel: child inherits the parent model when it has no explicit --model", () => {
  assert.equal(withInheritedModel(undefined, "gpt-5.5[xhigh]"), "gpt-5.5[xhigh]");
});

test("withInheritedModel: an explicit child --model wins over the parent", () => {
  assert.equal(withInheritedModel("opus[1m]", "gpt-5.5[xhigh]"), "opus[1m]");
});

test("withInheritedModel: undefined-safe / whitespace-aware", () => {
  assert.equal(withInheritedModel(undefined, undefined), undefined);
  assert.equal(withInheritedModel("   ", "gpt-5.5[xhigh]"), "gpt-5.5[xhigh]");
  assert.equal(withInheritedModel(undefined, "   "), undefined);
});

test("withInheritedReasoningEffort: child inherits the parent effort when it has no flag", () => {
  assert.equal(withInheritedReasoningEffort(undefined, "high"), "high");
});

test("withInheritedReasoningEffort: an explicit child --reasoning-effort wins", () => {
  assert.equal(withInheritedReasoningEffort("low", "high"), "low");
});

test("withInheritedReasoningEffort: undefined-safe / whitespace-aware", () => {
  assert.equal(withInheritedReasoningEffort(undefined, undefined), undefined);
  assert.equal(withInheritedReasoningEffort("   ", "high"), "high");
  assert.equal(withInheritedReasoningEffort(undefined, "   "), undefined);
});
