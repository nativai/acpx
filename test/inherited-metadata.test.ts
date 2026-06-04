import assert from "node:assert/strict";
import test from "node:test";
import {
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
