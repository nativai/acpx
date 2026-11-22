import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureSessionTmpDir,
  removeSessionTmpDir,
  resolveSessionTmpRoot,
  SESSION_TMP_ROOT_ENV,
  sessionTmpDirFor,
} from "../src/acp/session-tmp-dir.js";
import { setPodLockDepsForTests } from "../src/session/persistence/identity-file-lock.js";

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

// ---- block A8 (brick 88112988): the scratch root in pod placement, and its removal at close ----

const POD_ENV_NAMES = [
  "HOME",
  "ACPX_STATE_HOME",
  "ACPX_POD_TEST_HOME",
  SESSION_TMP_ROOT_ENV,
] as const;

/** Runs `fn` as an agent pod (the C1.1 seam: `.nv-agent` in a sandbox that IS the state home) or a control pod. */
async function asPlace<T>(
  place: "agent-pod" | "control",
  fn: (home: string) => Promise<T> | T,
): Promise<T> {
  const saved = Object.fromEntries(POD_ENV_NAMES.map((name) => [name, process.env[name]]));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "acpx-scratch-pod-")));
  if (place === "agent-pod") {
    writeFileSync(join(home, ".nv-agent"), "ag-scratch\n");
  }
  process.env.HOME = home;
  delete process.env.ACPX_STATE_HOME;
  delete process.env[SESSION_TMP_ROOT_ENV];
  process.env.ACPX_POD_TEST_HOME = home;
  try {
    return await fn(home);
  } finally {
    setPodLockDepsForTests(undefined);
    for (const name of POD_ENV_NAMES) {
      const value = saved[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("A8: in an agent pod the scratch root is <state home>/session-tmp; on the control pod it stays /tmp", async () => {
  await asPlace("agent-pod", (home) => {
    assert.equal(resolveSessionTmpRoot(undefined), join(home, ".acpx", "session-tmp"));
    const dir = ensureSessionTmpDir("sess-1");
    assert.equal(dir, join(home, ".acpx", "session-tmp", "acpx-sess-1"));
    assert.equal(statSync(dir).isDirectory(), true);
  });
  await asPlace("control", () => {
    assert.equal(resolveSessionTmpRoot(undefined), "/tmp");
  });
});

test("A8: removeSessionTmpDir removes the session's directory in pod placement — and only that one", async () => {
  await asPlace("agent-pod", (home) => {
    const mine = ensureSessionTmpDir("sess-mine");
    const other = ensureSessionTmpDir("sess-other");
    writeFileSync(join(mine, "attachment.txt"), "x");
    assert.equal(removeSessionTmpDir("sess-mine"), true);
    assert.equal(existsSync(mine), false);
    assert.equal(existsSync(other), true, "a neighbour is untouched");
    assert.equal(existsSync(join(home, ".acpx", "session-tmp")), true, "the root stays");
  });
});

test("A8 NEGATIVE: outside pod placement removeSessionTmpDir removes nothing (today's /tmp scratch is untouched)", async () => {
  await asPlace("control", () => {
    const keep = mkdtempSync(join(tmpdir(), "acpx-keep-"));
    process.env[SESSION_TMP_ROOT_ENV] = keep;
    const dir = ensureSessionTmpDir("sess-keep");
    assert.equal(removeSessionTmpDir("sess-keep"), false);
    assert.equal(existsSync(dir), true);
    rmSync(keep, { recursive: true, force: true });
  });
});

test("A8 NEGATIVE: an id that is not one path segment removes nothing, and an ACPX_SESSION_TMP_ROOT override is never removed from", async () => {
  await asPlace("agent-pod", (home) => {
    const root = join(home, ".acpx", "session-tmp");
    mkdirSync(root, { recursive: true });
    const sibling = join(home, ".acpx", "sessions-precious");
    mkdirSync(sibling, { recursive: true });
    for (const id of ["..", ".", "../sessions-precious", "a/b", "", "x\\0y"]) {
      assert.equal(removeSessionTmpDir(id), false, JSON.stringify(id));
    }
    assert.equal(existsSync(sibling), true);
    const overridden = mkdtempSync(join(tmpdir(), "acpx-override-"));
    mkdirSync(join(overridden, "acpx-sess-ov"), { recursive: true });
    process.env[SESSION_TMP_ROOT_ENV] = overridden;
    removeSessionTmpDir("sess-ov");
    assert.equal(existsSync(join(overridden, "acpx-sess-ov")), true);
    rmSync(overridden, { recursive: true, force: true });
  });
});

test("A8: closing the session removes its scratch directory in pod placement, and leaves another session's", async () => {
  await asPlace("agent-pod", async () => {
    const pod = { name: "ag-scratch", uid: "uid-scratch", node: "node-a", namespace: "ns" };
    setPodLockDepsForTests({ ownPod: () => pod, lockPod: () => pod });
    const { writeSessionRecord } = await import("../src/session/persistence.js");
    const { closeSession } = await import("../src/cli/session/session-control.js");
    const { makeSessionRecord } = await import("./runtime-test-helpers.js");
    const closing = makeSessionRecord({
      acpxRecordId: "close-me",
      acpSessionId: "acp-close-me",
      agentCommand: "agent",
      cwd: "/tmp/close-me",
    });
    await writeSessionRecord(closing);
    const scratch = ensureSessionTmpDir("close-me");
    const neighbour = ensureSessionTmpDir("not-closing");
    writeFileSync(join(scratch, "note.txt"), "x");
    await closeSession("close-me");
    assert.equal(existsSync(scratch), false, "removed with the close");
    assert.equal(existsSync(neighbour), true);
  });
});
