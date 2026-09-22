import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureSessionTmpDir,
  resolveSessionTmpRoot,
  SESSION_TMP_ROOT_ENV,
  sessionTmpDirFor,
} from "../src/acp/session-tmp-dir.js";

function withScopedRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "acpx-session-tmp-dir-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveSessionTmpRoot precedence: explicit arg > env > default", () => {
  const previous = process.env[SESSION_TMP_ROOT_ENV];
  process.env[SESSION_TMP_ROOT_ENV] = "/from/env";
  try {
    assert.equal(resolveSessionTmpRoot("/from/arg"), "/from/arg");
    assert.equal(resolveSessionTmpRoot(undefined), "/from/env");
    assert.equal(resolveSessionTmpRoot("   "), "/from/env", "whitespace-only arg is ABSENT");
    delete process.env[SESSION_TMP_ROOT_ENV];
    assert.equal(resolveSessionTmpRoot(undefined), "/tmp");
  } finally {
    if (previous === undefined) {
      delete process.env[SESSION_TMP_ROOT_ENV];
    } else {
      process.env[SESSION_TMP_ROOT_ENV] = previous;
    }
  }
});

test("sessionTmpDirFor composes exactly <root>/acpx-<sessionId>", () => {
  assert.equal(sessionTmpDirFor("abc-123", "/tmp"), "/tmp/acpx-abc-123");
});

test("ensureSessionTmpDir creates the directory at mode 0700 exactly", () => {
  withScopedRoot((root) => {
    const dir = ensureSessionTmpDir("11111111-2222-3333-4444-555555555555", root);
    assert.equal(dir, join(root, "acpx-11111111-2222-3333-4444-555555555555"));
    const stat = statSync(dir);
    assert.equal(stat.isDirectory(), true);
    // The FULL mode, special bits included — %a in `stat -c %a` reads this,
    // and this is the exact acceptance criterion (SPEC.md #1).
    assert.equal(stat.mode & 0o7777, 0o700);
  });
});

// brick ceca191f — measured against a REAL spawn under v1's `/workspace`-rooted
// design: that parent carried the setgid bit (`2775`), and Linux directories
// INHERIT their parent's setgid bit on creation REGARDLESS of the `mode`
// passed to `mkdir(2)`. A plain `mkdirSync(dir, { mode: 0o700 })` under such a
// parent produces `stat -c %a` `2700`, not `700` — this row is the regression
// guard for the `chmodSync` fix that followed that measurement, kept even
// though `/tmp` (v2's root) does not itself carry setgid, since a
// caller-supplied `rootDir` or a future box's `/tmp` still could.
test("ensureSessionTmpDir strips an inherited setgid bit from a setgid-parent root", () => {
  withScopedRoot((root) => {
    chmodSync(root, 0o2775); // simulate a setgid-carrying parent (rwxrwsr-x)
    const before = statSync(root);
    assert.equal(before.mode & 0o7000, 0o2000, "setup sanity: the fixture root must carry setgid");

    const dir = ensureSessionTmpDir("22222222-3333-4444-5555-666666666666", root);
    const stat = statSync(dir);
    assert.equal(
      stat.mode & 0o7777,
      0o700,
      "the created directory must not inherit the parent's setgid bit",
    );
  });
});

test("ensureSessionTmpDir is idempotent across two spawns for the same session", () => {
  withScopedRoot((root) => {
    const first = ensureSessionTmpDir("33333333-4444-5555-6666-777777777777", root);
    const second = ensureSessionTmpDir("33333333-4444-5555-6666-777777777777", root);
    assert.equal(first, second);
    assert.equal(statSync(second).mode & 0o7777, 0o700);
  });
});
