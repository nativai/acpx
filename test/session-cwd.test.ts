import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionCwdMissingError } from "../src/errors.js";
import { assertSessionCwdExists, sessionCwdIsMissing } from "../src/session/session-cwd.js";

// brick 45917618 §5.6 (CONCEPTION v1.4): what counts as a MISSING session folder.

function failingStat(code: string) {
  return () => {
    throw Object.assign(new Error(code), { code });
  };
}

test("missing: ENOENT, ENOTDIR, and an existing non-directory", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-session-cwd-"));
  try {
    const file = path.join(dir, "file");
    await fs.writeFile(file, "x");
    assert.equal(sessionCwdIsMissing(path.join(dir, "absent")), true);
    assert.equal(sessionCwdIsMissing(path.join(file, "below-a-file")), true);
    assert.equal(sessionCwdIsMissing(file), true);
    assert.equal(sessionCwdIsMissing(dir), false, "planted positive: an existing directory");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("uncertainty is NOT missing: any other stat error lets the turn proceed", () => {
  for (const code of ["EACCES", "EIO", "ESTALE", "EPERM"]) {
    assert.equal(sessionCwdIsMissing("/anything", failingStat(code)), false, code);
  }
  assert.equal(sessionCwdIsMissing("/anything", failingStat("ENOENT")), true);
});

test("the refusal names the folder and the remedies; a Pi source gets the successor only", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const check = (agentCommand: string) =>
    assert.throws(
      () => assertSessionCwdExists({ cwd: "/nope/gone", sessionId: id, agentCommand }),
      (error: unknown) => {
        assert.ok(error instanceof SessionCwdMissingError);
        assert.equal(error.detailCode, "SESSION_CWD_MISSING");
        assert.equal(error.cwd, "/nope/gone");
        assert.ok(error.message.includes(`acpx sessions new --from ${id}`));
        return true;
      },
    );
  check("node /opt/claude-agent-acp/dist/index.js");
  assert.throws(
    () =>
      assertSessionCwdExists({
        cwd: "/nope/gone",
        sessionId: id,
        agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      }),
    /Continue it as a copy/,
  );
  assert.throws(
    () =>
      assertSessionCwdExists({
        cwd: "/nope/gone",
        sessionId: id,
        agentCommand: "node /opt/pi-acp/dist/index.js",
      }),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes("Continue it as a copy") &&
      error.message.includes("Start a fresh successor"),
  );
});
