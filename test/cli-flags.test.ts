import assert from "node:assert/strict";
import test from "node:test";
import {
  hasExplicitPermissionModeFlag,
  parseMetadataEntry,
  resolvePermissionMode,
  resolveSystemPromptFlag,
} from "../src/cli/flags.js";

test("resolvePermissionMode honors explicit approve-reads overrides", () => {
  assert.equal(resolvePermissionMode({ approveReads: true }, "approve-all"), "approve-reads");
  assert.equal(resolvePermissionMode({ approveAll: true }, "approve-reads"), "approve-all");
  assert.equal(resolvePermissionMode({ denyAll: true }, "approve-all"), "deny-all");
});

test("hasExplicitPermissionModeFlag detects explicit permission grants", () => {
  assert.equal(hasExplicitPermissionModeFlag({}), false);
  assert.equal(hasExplicitPermissionModeFlag({ approveReads: true }), true);
  assert.equal(hasExplicitPermissionModeFlag({ approveAll: true }), true);
  assert.equal(hasExplicitPermissionModeFlag({ denyAll: true }), true);
});

test("resolveSystemPromptFlag returns undefined when neither flag is set", () => {
  assert.equal(resolveSystemPromptFlag({}), undefined);
  assert.equal(resolveSystemPromptFlag({ systemPrompt: "" }), undefined);
  assert.equal(resolveSystemPromptFlag({ appendSystemPrompt: "" }), undefined);
});

test("resolveSystemPromptFlag returns string for --system-prompt", () => {
  assert.equal(
    resolveSystemPromptFlag({ systemPrompt: "you are an obsidian assistant" }),
    "you are an obsidian assistant",
  );
});

test("resolveSystemPromptFlag returns append object for --append-system-prompt", () => {
  assert.deepEqual(resolveSystemPromptFlag({ appendSystemPrompt: "always speak in spanish" }), {
    append: "always speak in spanish",
  });
});

test("resolveSystemPromptFlag rejects combining --system-prompt and --append-system-prompt", () => {
  assert.throws(
    () => resolveSystemPromptFlag({ systemPrompt: "a", appendSystemPrompt: "b" }),
    /Use only one of --system-prompt or --append-system-prompt/,
  );
});

test("parseMetadataEntry collects one key/value pair", () => {
  assert.deepEqual(parseMetadataEntry("task_folder=/abs/path", undefined), {
    task_folder: "/abs/path",
  });
});

test("parseMetadataEntry accumulates repeated flags (later wins per key)", () => {
  const first = parseMetadataEntry("task_folder=/abs/path", undefined);
  const second = parseMetadataEntry("project=acpx-ui", first);
  const third = parseMetadataEntry("task_folder=/new/path", second);
  assert.deepEqual(third, { task_folder: "/new/path", project: "acpx-ui" });
});

test("parseMetadataEntry preserves '=' inside the value", () => {
  assert.deepEqual(parseMetadataEntry("query=a=b=c", undefined), { query: "a=b=c" });
});

test("parseMetadataEntry accepts empty value after '='", () => {
  assert.deepEqual(parseMetadataEntry("empty=", undefined), { empty: "" });
});

test("parseMetadataEntry rejects entries without '='", () => {
  assert.throws(() => parseMetadataEntry("task_folder", undefined), /--metadata expects key=value/);
});

test("parseMetadataEntry rejects empty key (leading '=' or whitespace-only key)", () => {
  assert.throws(() => parseMetadataEntry("=value", undefined), /--metadata key must not be empty/);
  assert.throws(
    () => parseMetadataEntry("   =value", undefined),
    /--metadata key must not be empty/,
  );
});
