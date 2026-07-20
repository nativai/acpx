import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOutputError } from "../src/acp/error-normalization.js";
import { FableShareExhaustedError } from "../src/errors.js";
import {
  buildTerminalTurnErrorMessage,
  isTerminalTurnError,
} from "../src/session/persist-terminal-error.js";

// The cross-lane seam (§5): db02a753's FIX-A mirror is CLASS-AGNOSTIC — it keys on
// resolveTerminalDetailCode(err) = normalizeOutputError(err).detailCode. These
// tests prove FableShareExhaustedError satisfies that contract WITHOUT any persist
// code on our side, so the agent SEES the Fable-share reason in messages.ndjson
// (AC5) once a real fable turn 429s and failover raises the error.

test("FableShareExhaustedError normalizes to detailCode 'fable-share-exhausted'", () => {
  const err = new FableShareExhaustedError("sub1 (sub1): fable exhausted");
  const normalized = normalizeOutputError(err, { origin: "runtime" });
  assert.equal(normalized.detailCode, "fable-share-exhausted");
  assert.equal(normalized.code, "RUNTIME");
  assert.equal(normalized.origin, "runtime");
});

test("isTerminalTurnError is TRUE for FableShareExhaustedError (mirror routing gate)", () => {
  assert.equal(isTerminalTurnError(new FableShareExhaustedError("x")), true);
});

test("buildTerminalTurnErrorMessage carries the AC5 agent-visible entry shape", () => {
  const err = new FableShareExhaustedError("sub1 (sub1): fable exhausted");
  const built = buildTerminalTurnErrorMessage(err);
  assert.ok(typeof built === "object" && "Agent" in built, "mirror entry is an Agent message");
  const msg = built as unknown as {
    Agent: {
      content: Array<{ Text?: string }>;
      terminal_error?: {
        detail_code?: string;
        output_code?: string;
        origin?: string;
        message?: string;
      };
    };
  };
  // human-readable line an agent reads in its own log
  assert.match(msg.Agent.content[0].Text ?? "", /^⚠ turn failed: Fable-share limit reached/);
  // machine-readable classifier the spawner/acpx-ui branches on
  assert.equal(msg.Agent.terminal_error?.detail_code, "fable-share-exhausted");
  assert.equal(msg.Agent.terminal_error?.output_code, "RUNTIME");
  assert.equal(msg.Agent.terminal_error?.origin, "runtime");
  // the message states WHAT + the remedy + that the limit is intermittent
  assert.match(msg.Agent.terminal_error?.message ?? "", /unified 5h\/7d windows are healthy/);
  assert.match(msg.Agent.terminal_error?.message ?? "", /switch to a non-Fable/);
  assert.match(msg.Agent.terminal_error?.message ?? "", /intermittent — a later turn may succeed/);
});
