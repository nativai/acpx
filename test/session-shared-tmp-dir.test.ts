import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureSessionSharedTmpDir,
  resolveSessionSharedTmpRoot,
  SESSION_SHARED_TMP_DEFAULT_ROOT,
  SESSION_SHARED_TMP_ROOT_ENV,
  sessionSharedTmpDirFor,
} from "../src/acp/session-shared-tmp-dir.js";

function withScopedRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "acpx-session-shared-tmp-dir-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The default root is a PUBLISHED path: the primer teaches it, and agents will
// hard-code it in shell one-liners long after this module is last read. Pinning
// it here means a change to it is a deliberate act with a red test, not a quiet
// edit that silently relocates every session's scratch.
test("the default root is /workspace/.session-scratch — NOT the pre-existing /workspace/.scratch", () => {
  assert.equal(SESSION_SHARED_TMP_DEFAULT_ROOT, "/workspace/.session-scratch");
  assert.notEqual(
    SESSION_SHARED_TMP_DEFAULT_ROOT,
    "/workspace/.scratch",
    "/workspace/.scratch already exists with unrelated hand-made content (measured 2026-09-30); " +
      "tier 2 owns its root exclusively so every entry in it is recognisably acpx's",
  );
});

test("resolveSessionSharedTmpRoot precedence: explicit arg > env > default", () => {
  const previous = process.env[SESSION_SHARED_TMP_ROOT_ENV];
  process.env[SESSION_SHARED_TMP_ROOT_ENV] = "/from/env";
  try {
    assert.equal(resolveSessionSharedTmpRoot("/from/arg"), "/from/arg");
    assert.equal(resolveSessionSharedTmpRoot(undefined), "/from/env");
    assert.equal(resolveSessionSharedTmpRoot("   "), "/from/env", "whitespace-only arg is ABSENT");
    delete process.env[SESSION_SHARED_TMP_ROOT_ENV];
    assert.equal(resolveSessionSharedTmpRoot(undefined), SESSION_SHARED_TMP_DEFAULT_ROOT);
  } finally {
    if (previous === undefined) {
      delete process.env[SESSION_SHARED_TMP_ROOT_ENV];
    } else {
      process.env[SESSION_SHARED_TMP_ROOT_ENV] = previous;
    }
  }
});

// Acceptance criterion 4, the half that is easy to get wrong: `FOO=` in an env
// file yields "", and `join("", id)` is a path RELATIVE TO THE PROCESS CWD — a
// scratch directory wherever the CLI happened to be invoked from, with nothing
// erroring and the documented root sitting empty.
test("a blank ACPX_SESSION_SHARED_TMP_ROOT is ABSENT, never a cwd-relative path", () => {
  const previous = process.env[SESSION_SHARED_TMP_ROOT_ENV];
  try {
    for (const blank of ["", "   ", "\t\n"]) {
      process.env[SESSION_SHARED_TMP_ROOT_ENV] = blank;
      assert.equal(
        resolveSessionSharedTmpRoot(undefined),
        SESSION_SHARED_TMP_DEFAULT_ROOT,
        `a blank value (${JSON.stringify(blank)}) must fall through to the default`,
      );
      const dir = sessionSharedTmpDirFor("abc-123", resolveSessionSharedTmpRoot(undefined));
      assert.equal(dir.startsWith("/"), true, "the composed path must be absolute");
      assert.equal(dir, "/workspace/.session-scratch/acpx-abc-123");
    }
  } finally {
    if (previous === undefined) {
      delete process.env[SESSION_SHARED_TMP_ROOT_ENV];
    } else {
      process.env[SESSION_SHARED_TMP_ROOT_ENV] = previous;
    }
  }
});

test("sessionSharedTmpDirFor composes exactly <root>/acpx-<sessionId>", () => {
  assert.equal(
    sessionSharedTmpDirFor("abc-123", "/workspace/.session-scratch"),
    "/workspace/.session-scratch/acpx-abc-123",
  );
});

test("ensureSessionSharedTmpDir creates the directory at mode 0700 exactly", () => {
  withScopedRoot((root) => {
    const dir = ensureSessionSharedTmpDir("11111111-2222-3333-4444-555555555555", root);
    assert.equal(dir, join(root, "acpx-11111111-2222-3333-4444-555555555555"));
    const stat = statSync(dir);
    assert.equal(stat.isDirectory(), true);
    // The FULL mode, special bits included — `stat -c %a` reads this, and it is
    // the exact acceptance criterion (SPEC.md #1).
    assert.equal(stat.mode & 0o7777, 0o700);
  });
});

// ⚠️ THE COMMITTED NEGATIVE CASE, AND FOR THIS TIER IT IS THE LIVE CASE, NOT A
// HYPOTHETICAL. The real parent of this tier's root — `/workspace` — carries
// the setgid bit TODAY (`drwxrwsr-x`, `2775`, measured 2026-09-30), and Linux
// directories inherit a parent's setgid bit on creation REGARDLESS of the mode
// passed to `mkdir(2)`: v1 of the tier-1 work measured `2700` instead of `700`
// against a real spawn under exactly this parent. The unconditional
// `chmodSync(0o700)` is the only thing making the published guarantee true, so
// this row is what stops a future reader "simplifying" it away.
test("ensureSessionSharedTmpDir strips an inherited setgid bit from a setgid-parent root", () => {
  withScopedRoot((root) => {
    chmodSync(root, 0o2775); // the mode /workspace actually carries
    const before = statSync(root);
    assert.equal(before.mode & 0o7000, 0o2000, "setup sanity: the fixture root must carry setgid");

    const dir = ensureSessionSharedTmpDir("22222222-3333-4444-5555-666666666666", root);
    const stat = statSync(dir);
    assert.equal(
      stat.mode & 0o7777,
      0o700,
      "the created directory must be 700 exactly — not 2700 from the parent's setgid bit",
    );
  });
});

test("ensureSessionSharedTmpDir is idempotent across two spawns for the same session", () => {
  withScopedRoot((root) => {
    const first = ensureSessionSharedTmpDir("33333333-4444-5555-6666-777777777777", root);
    writeFileSync(join(first, "survivor.txt"), "written before the pod restart");
    const second = ensureSessionSharedTmpDir("33333333-4444-5555-6666-777777777777", root);
    assert.equal(first, second);
    assert.equal(statSync(second).mode & 0o7777, 0o700);
    assert.equal(
      statSync(join(second, "survivor.txt")).isFile(),
      true,
      "re-ensuring must not wipe scratch a resumed session still needs",
    );
  });
});

// ⚠️ BEST-EFFORT, NOT THROWING — the comment on `ensureSessionSharedTmpDir`
// claims this, so here is the case that exercises it. The PVC can genuinely be
// full, and failing SESSION CREATION over a scratch directory would be strictly
// worse than a session that starts without one. The returned path is still the
// intended one, so the eventual write fails loudly (ENOENT) at the point of use
// rather than silently landing somewhere else.
test("ensureSessionSharedTmpDir never throws when the root is unusable, and still returns the intended path", () => {
  withScopedRoot((root) => {
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "a FILE where the root directory should be");
    const expected = join(blocked, "acpx-44444444-5555-6666-7777-888888888888");

    let dir = "";
    assert.doesNotThrow(() => {
      dir = ensureSessionSharedTmpDir("44444444-5555-6666-7777-888888888888", blocked);
    });
    assert.equal(dir, expected, "the intended path is returned even though creation failed");
    assert.throws(
      () => statSync(dir),
      /ENOTDIR|ENOENT/,
      "and the directory genuinely does not exist, so a write there fails loudly",
    );
  });
});
