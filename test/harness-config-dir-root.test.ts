import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  HARNESS_CONFIG_DIR_ROOT_ENV,
  resolveHarnessConfigDirRoot,
} from "../src/acp/harness-config-dir-root.js";

// Re-pointed from the former config-dir-sweep-scope.test.ts (brick d1e12500):
// these two pin the resolver itself, which the WRITER (`applyHarnessConfigDir`)
// still depends on after the config-dir orphan sweep was removed — everything
// else in that file was about the sweep's use of the root and went with it.

test("0bac6a00 §4: the root resolves argument > env > tmpdir(), and the DEFAULT is still tmpdir()", () => {
  assert.equal(resolveHarnessConfigDirRoot(undefined, {}), tmpdir());
  assert.equal(
    resolveHarnessConfigDirRoot(undefined, { [HARNESS_CONFIG_DIR_ROOT_ENV]: "/from/env" }),
    "/from/env",
  );
  assert.equal(
    resolveHarnessConfigDirRoot("/from/argument", { [HARNESS_CONFIG_DIR_ROOT_ENV]: "/from/env" }),
    "/from/argument",
  );
});

test("0bac6a00 §4: a BLANK root is treated as absent, never as a relative path", () => {
  // `join("", "acpx-pi-x")` is RELATIVE — a write rooted wherever the CLI
  // was invoked from. Blank must fall through to the default, not become "".
  assert.equal(resolveHarnessConfigDirRoot("   ", {}), tmpdir());
  assert.equal(
    resolveHarnessConfigDirRoot(undefined, { [HARNESS_CONFIG_DIR_ROOT_ENV]: "  " }),
    tmpdir(),
  );
  assert.equal(
    resolveHarnessConfigDirRoot(undefined, { [HARNESS_CONFIG_DIR_ROOT_ENV]: "" }),
    tmpdir(),
  );
});
