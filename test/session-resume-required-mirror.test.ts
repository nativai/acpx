import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOutputError } from "../src/acp/error-normalization.js";
import { isSessionResumeRequiredError, SessionResumeRequiredError } from "../src/errors.js";
import {
  buildTerminalTurnErrorMessage,
  isTerminalTurnError,
} from "../src/session/persist-terminal-error.js";

// brick://de3645c6 Part 2 (observability): a turn that dies BEFORE any agent
// output with a SessionResumeRequiredError must not be silent — it is surfaced
// to BOTH sinks (`.stream.ndjson` board banner + `.messages.ndjson` spawner
// mirror) by mirrorUnrecoveredTerminalTurnError. That surfacing reuses the
// CLASS-AGNOSTIC FIX-A mirror, which keys on
// resolveTerminalDetailCode(err) = normalizeOutputError(err).detailCode. These
// tests prove SessionResumeRequiredError satisfies that contract, so the board
// renders lastError and the spawner reads the reason in messages.ndjson.

test("SessionResumeRequiredError normalizes to detailCode SESSION_RESUME_REQUIRED", () => {
  const err = new SessionResumeRequiredError(
    "Persistent ACP session abc could not be resumed: missing transcript at /x",
  );
  const normalized = normalizeOutputError(err, { origin: "runtime" });
  assert.equal(normalized.detailCode, "SESSION_RESUME_REQUIRED");
  assert.equal(normalized.code, "RUNTIME");
});

test("isTerminalTurnError is TRUE for SessionResumeRequiredError (mirror routing gate)", () => {
  assert.equal(isTerminalTurnError(new SessionResumeRequiredError("x")), true);
});

test("isSessionResumeRequiredError type guard", () => {
  assert.equal(isSessionResumeRequiredError(new SessionResumeRequiredError("x")), true);
  assert.equal(isSessionResumeRequiredError(new Error("x")), false);
  assert.equal(isSessionResumeRequiredError(undefined), false);
});

test("buildTerminalTurnErrorMessage carries the agent-visible entry shape for a resume-required death", () => {
  const err = new SessionResumeRequiredError(
    "Persistent ACP session abc could not be resumed: missing transcript at /x; searched: sub1",
  );
  const built = buildTerminalTurnErrorMessage(err);
  assert.ok(typeof built === "object" && "Agent" in built, "mirror entry is an Agent message");
  const msg = built as unknown as {
    Agent: {
      content: Array<{ Text?: string }>;
      terminal_error?: { detail_code?: string; output_code?: string; message?: string };
    };
  };
  // human-readable line an agent reads in its own log
  assert.match(msg.Agent.content[0].Text ?? "", /^⚠ turn failed: /);
  assert.match(msg.Agent.content[0].Text ?? "", /could not be resumed/);
  // machine-readable classifier the spawner / acpx-ui branch on
  assert.equal(msg.Agent.terminal_error?.detail_code, "SESSION_RESUME_REQUIRED");
  assert.equal(msg.Agent.terminal_error?.output_code, "RUNTIME");
});
