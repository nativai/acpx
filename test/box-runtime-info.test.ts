// brick 04063316 — the dev-box runtime record moved off NFS to /data/runtime; boxes
// not yet migrated keep /workspace/.runtime. Both readers (deploy-staleness and the
// Claude advertisement key) resolve it here, newest location first.
import assert from "node:assert/strict";
import test from "node:test";
import { BOX_RUNTIME_INFO_PATHS, defaultBoxRuntimeInfoPath } from "../src/box-runtime-info.js";
import { runtimeInfoPathFor } from "../src/models/claude-advertisement.js";

const NEW = "/data/runtime/info.json";
const OLD = "/workspace/.runtime/info.json";
const only =
  (...present: string[]) =>
  (candidate: string) =>
    present.includes(candidate);

test("candidates are the migrated location first, then the legacy one", () => {
  assert.deepEqual([...BOX_RUNTIME_INFO_PATHS], [NEW, OLD]);
});

test("a migrated box reads /data/runtime even while a legacy copy still exists", () => {
  assert.equal(defaultBoxRuntimeInfoPath(only(NEW, OLD)), NEW);
  assert.equal(defaultBoxRuntimeInfoPath(only(NEW)), NEW);
});

test("a box not yet migrated reads /workspace/.runtime", () => {
  assert.equal(defaultBoxRuntimeInfoPath(only(OLD)), OLD);
});

test("with neither present the current location is reported, never the legacy one", () => {
  assert.equal(defaultBoxRuntimeInfoPath(only()), NEW);
});

test("ACPX_RUNTIME_INFO_PATH still overrides the box record", () => {
  assert.equal(runtimeInfoPathFor({ ACPX_RUNTIME_INFO_PATH: " /x/info.json " }), "/x/info.json");
  assert.notEqual(runtimeInfoPathFor({ ACPX_RUNTIME_INFO_PATH: "" }), "");
});
