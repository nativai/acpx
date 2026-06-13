import assert from "node:assert/strict";
import test from "node:test";
import { setSessionModel } from "../src/cli/session/session-control.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

test("setSessionModel rejects a non-advertised model without persisting it", async () => {
  await withTempHome("acpx-set-model-home-", async (homeDir) => {
    const record = makeSessionRecord({
      acpxRecordId: "model-record",
      acpSessionId: "provider-session",
      agentCommand: "agent",
      cwd: "/tmp/workspace",
      acpx: {
        current_model_id: "sonnet",
        available_models: ["sonnet", "haiku"],
      },
    });
    await writeSessionRecordFile(homeDir, record);

    await assert.rejects(
      async () =>
        await setSessionModel({
          sessionId: "model-record",
          modelId: "not-advertised",
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "RequestedModelUnsupportedError");
        assert.match(error.message, /Available models: sonnet, haiku/);
        return true;
      },
    );

    const persisted = await resolveSessionRecord("model-record");
    assert.equal(persisted.acpx?.session_options?.model, undefined);
    assert.equal(persisted.acpx?.current_model_id, "sonnet");
    assert.deepEqual(persisted.acpx?.available_models, ["sonnet", "haiku"]);
  });
});
