import assert from "node:assert/strict";
import test from "node:test";
import { TerminalManager } from "../src/acp/terminal-manager.js";
import { resetInertPermissionFlagWarning, resolvePermissionMode } from "../src/cli/flags.js";
import { FileSystemHandlers } from "../src/filesystem.js";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  enforcePermissionMode,
  isReducingPermissionMode,
  type PermissionMode,
} from "../src/types.js";

// brick https://acpx.devbox.nativai.de/?brick=a4369a7e
//
// THE PROPERTY: **no flag reduces permissions at any surface, present or future.**
//
// ⚠️ THIS FILE ASSERTS THE PROPERTY, NOT A LIST OF SURFACES — deliberately, and
// the history is the reason. The ruling was scoped by enumeration TWICE and was
// wrong both times: first `session/request_permission` alone, then
// `+ terminal/create`; the FILESYSTEM (`fs/write_text_file`) was a third surface,
// found only because a test went red. An enumeration written by someone who has
// not just grepped is a guess with a confident shape.
//
// So the enforcement lives at the POLICY SOURCE (`enforcePermissionMode`, applied
// where `AcpClient` STORES the mode) and this file checks the surfaces
// BEHAVIOURALLY — it drives the real `FileSystemHandlers` and `TerminalManager`
// rather than asserting that some helper was called. A per-surface patch that
// misses one goes red here.

/**
 * Capture what `resolvePermissionMode` writes to stderr. Factored out rather than
 * repeated per test: three copies of a stderr monkey-patch is three chances to
 * forget the `finally` that restores it, and a leaked patch corrupts every later
 * test in the file.
 */
function captureStderr(run: () => void): string[] {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

const REDUCING_MODES = PERMISSION_MODES.filter((mode) => isReducingPermissionMode(mode));

test("the reducing modes this property is about actually exist — the test is not vacuous", () => {
  // Without this, every loop below would pass by iterating an empty list.
  assert.deepEqual(REDUCING_MODES, ["approve-reads", "deny-all"]);
  assert.equal(DEFAULT_PERMISSION_MODE, "approve-all");
});

test("the policy source returns the enforced mode for EVERY input, including the reducing ones", () => {
  for (const mode of PERMISSION_MODES) {
    assert.equal(enforcePermissionMode(mode), DEFAULT_PERMISSION_MODE, mode);
  }
  assert.equal(enforcePermissionMode(undefined), DEFAULT_PERMISSION_MODE);
});

// ── The surfaces, driven for real ────────────────────────────────────────────

test("SURFACE fs/write_text_file: a write is approved under every reducing mode", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  for (const requested of REDUCING_MODES) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-perm-fs-"));
    try {
      // The handler is constructed with the ENFORCED mode, exactly as AcpClient
      // constructs it — that is the point: the client never stores the request.
      const handlers = new FileSystemHandlers({
        cwd: root,
        permissionMode: enforcePermissionMode(requested),
        // `fail` is what used to turn an unavailable prompt into a hard denial.
        // It must no longer be reachable, so it is set here on purpose.
        nonInteractivePermissions: "fail",
      });
      const target = path.join(root, "written.txt");
      await handlers.writeTextFile({ sessionId: "s", path: target, content: "hi" });
      assert.equal(await fs.readFile(target, "utf8"), "hi", `write blocked under ${requested}`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("SURFACE terminal/create: a command executes under every reducing mode", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  for (const requested of REDUCING_MODES) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-perm-term-"));
    try {
      const manager = new TerminalManager({
        cwd: root,
        permissionMode: enforcePermissionMode(requested),
        nonInteractivePermissions: "fail",
      });
      const created = await manager.createTerminal({
        sessionId: "s",
        command: "sh",
        args: ["-c", "printf ok"],
      });
      await manager.waitForTerminalExit({ sessionId: "s", terminalId: created.terminalId });
      const output = await manager.terminalOutput({
        sessionId: "s",
        terminalId: created.terminalId,
      });
      assert.match(output.output, /ok/, `terminal blocked under ${requested}`);
      await manager.releaseTerminal({ sessionId: "s", terminalId: created.terminalId });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

// ── The CLI half: the flags still parse, and say they are inert ──────────────

test("a reducing FLAG still parses, still resolves to the enforced mode, and WARNS once", () => {
  const written = captureStderr(() => {
    resetInertPermissionFlagWarning();
    assert.equal(resolvePermissionMode({ denyAll: true }, "approve-all"), DEFAULT_PERMISSION_MODE);
    // The SECOND reducing flag in the same process must NOT warn again — a
    // repeated warning trains people to filter it.
    assert.equal(
      resolvePermissionMode({ approveReads: true }, "approve-all"),
      DEFAULT_PERMISSION_MODE,
    );
  });

  const warnings = written.filter((line) => line.includes("accepted but inert"));
  assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
  assert.match(warnings[0] ?? "", /--deny-all accepted but inert on this fleet/);
  assert.match(warnings[0] ?? "", /agents always run with full process permissions/);
  assert.match(warnings[0] ?? "", /Daniel 2026-09-03/);
});

test("the flags are NOT removed — combining two is still a parse error", () => {
  // Accepting a flag and quietly doing nothing is the defect this warning ends;
  // REMOVING the flags would break every script and brief on the fleet. Both
  // still parse, and the mutual-exclusion check still bites.
  resetInertPermissionFlagWarning();
  assert.throws(() => resolvePermissionMode({ approveAll: true, denyAll: true }, "approve-all"), {
    message: /Use only one permission mode/,
  });
});

test("a reducing DEFAULT from a config file is announced too, not silently enforced away", () => {
  const written = captureStderr(() => {
    resetInertPermissionFlagWarning();
    assert.equal(resolvePermissionMode({}, "deny-all" as PermissionMode), DEFAULT_PERMISSION_MODE);
  });
  assert.match(
    written.find((line) => line.includes("accepted but inert")) ?? "",
    /defaultPermissions "deny-all"/,
  );
});

test("--approve-all is NOT warned about — it asks for what it already gets", () => {
  const written = captureStderr(() => {
    resetInertPermissionFlagWarning();
    assert.equal(
      resolvePermissionMode({ approveAll: true }, "approve-all"),
      DEFAULT_PERMISSION_MODE,
    );
  });
  // The positive control for the warning: it must not fire for a flag that is
  // NOT inert, or it becomes noise on every fleet recipe (every one passes
  // --approve-all).
  assert.deepEqual(
    written.filter((line) => line.includes("accepted but inert")),
    [],
  );
});
