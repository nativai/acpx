import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * brick ceca191f (SPEC.md acceptance criterion 3) — THE CROSS-POD PROPERTY, TESTED
 * ACROSS THE ACTUAL POD BOUNDARY, WITH A POSITIVE CONTROL.
 *
 * ## ⚠️ WHY THIS FILE EXISTS SEPARATELY FROM `session-tmp-dir.test.ts`
 *
 * A test that only compares `$ACPX_SESSION_TMP`'s STRING VALUE across
 * `workbench-exec` proves nothing about cross-pod visibility: `workbench-exec`
 * forwards the whole environment unconditionally, so the same string would echo
 * back identically for a `/tmp`-rooted value too — the very rooting this brick
 * rejected. Such a test cannot distinguish the fix from the bug it fixes.
 *
 * What actually matters, and what this file tests: write BYTES at
 * `$ACPX_SESSION_TMP/<name>` on the control-plane pod (where this suite runs),
 * then read that SAME PATH via `workbench-exec` and get the SAME BYTES back —
 * and the reverse direction too. Its POSITIVE CONTROL is a `/tmp`-rooted path,
 * which MUST fail this same check (a real dev box's `/tmp` is per-pod, not
 * shared) — proving the test apparatus can actually tell the two apart, not just
 * report success unconditionally.
 *
 * Gated on `workbench-exec` being present: this property is specific to this
 * box's control+workbench pod topology and cannot be exercised in a generic
 * single-machine CI runner. An environment-gated skip is not an ignored test —
 * it runs wherever the dependency exists (`dev-server-workspace` skill).
 */

function workbenchExecAvailable(): boolean {
  try {
    execFileSync("which", ["workbench-exec"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function readViaWorkbench(path: string): string | undefined {
  try {
    return execFileSync("workbench-exec", ["cat", path], { encoding: "utf8", stdio: "pipe" });
  } catch {
    return undefined; // ENOENT (or any failure) on the workbench side — not visible there
  }
}

/**
 * ⚠️ NO STDIN. `workbench-exec` does not forward stdin (`dev-server-workspace` skill,
 * measured 2026-09-11) — a version on this box actively REFUSES it
 * (`stdin_unsupported`, rc 64) rather than silently dropping it, which is how this
 * function's first draft was caught red-handed rather than silently no-op'ing.
 * The payload goes onto the shared `/workspace` first and is read FROM THERE by the
 * command, exactly as the skill prescribes.
 */
function writeViaWorkbench(destPath: string, content: string): boolean {
  const stagingPath = join("/workspace/.tmp", `crosspod-stage-${randomUUID()}.txt`);
  writeFileSync(stagingPath, content, "utf8");
  try {
    execFileSync("workbench-exec", ["cp", stagingPath, destPath], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(stagingPath, { force: true });
  }
}

test(
  "ACPX_SESSION_TMP (/workspace-rooted): a file written on the control pod is read byte-for-byte via workbench-exec, and vice versa",
  { skip: !workbenchExecAvailable() && "workbench-exec not on PATH — not this box's topology" },
  () => {
    const dir = join("/workspace/.tmp", `crosspod-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const fromControl = `control-plane says ${randomUUID()}`;
      const controlFile = join(dir, "from-control.txt");
      writeFileSync(controlFile, fromControl, "utf8");

      const seenFromWorkbench = readViaWorkbench(controlFile);
      assert.equal(
        seenFromWorkbench,
        fromControl,
        "a file written on the control pod must read back byte-identical via workbench-exec",
      );

      const fromWorkbench = `workbench says ${randomUUID()}`;
      const workbenchFile = join(dir, "from-workbench.txt");
      assert.equal(
        writeViaWorkbench(workbenchFile, fromWorkbench),
        true,
        "workbench-exec must be able to write into the /workspace-rooted dir",
      );
      const seenOnControl = readFileSync(workbenchFile, "utf8");
      assert.equal(
        seenOnControl,
        fromWorkbench,
        "a file written via workbench-exec must read back byte-identical on the control pod",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "POSITIVE CONTROL: the SAME check against a /tmp-rooted path FAILS — proving the apparatus can tell /workspace and /tmp apart",
  { skip: !workbenchExecAvailable() && "workbench-exec not on PATH — not this box's topology" },
  () => {
    // ⚠️ THIS TEST MUST FAIL TO PASS. If a control-pod-local /tmp file were
    // somehow visible byte-identical via workbench-exec, the check above would
    // be worthless — indistinguishable from a broken apparatus that always
    // reports success. This row is what makes the row above trustworthy.
    const dir = mkdtempSync(join(tmpdir(), "acpx-crosspod-negative-control-"));
    try {
      const content = `control-plane-only ${randomUUID()}`;
      const file = join(dir, "only-here.txt");
      writeFileSync(file, content, "utf8");

      const seenFromWorkbench = readViaWorkbench(file);
      assert.notEqual(
        seenFromWorkbench,
        content,
        "/tmp must NOT be visible cross-pod — if this fails, /tmp is unexpectedly shared " +
          "and the /workspace rooting decision (SPEC.md) needs to be re-examined, not this test",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
