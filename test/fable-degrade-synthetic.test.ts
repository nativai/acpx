import assert from "node:assert/strict";
import test from "node:test";
import { sessionHasAgentMessages, sessionHasRealAgentTurn } from "../src/runtime/engine/lifecycle.js";
import { applyFableDegrade } from "../src/session/fable-degrade.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// The fable→opus degrade notice is a synthetic breadcrumb, not a real model turn.
// Untagged it re-opens the first-turn-death class fixed by brick://de3645c6: a
// fresh session whose first turn degraded and then died before any transcript
// write would count the breadcrumb as irreplaceable history, refuse the
// resume→session/new fallback on its cold -32002, and become permanently
// unpromptable (brick://509b4ee1).

test("fable degrade breadcrumb is synthetic — visible in messages but not a real agent turn", async () => {
  await withTempHome("acpx-degrade-", async (home) => {
    const record = makeSessionRecord({
      acpxRecordId: "degrade-rec",
      acpSessionId: "degrade-sid",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace",
      acpx: {
        session_options: { model: "fable", model_source: "explicit", fable_degrade_ok: true },
      },
    });
    await writeSessionRecordFile(home, record);

    const { to } = await applyFableDegrade(record, { from: "fable" });
    assert.equal(to, "opus");
    assert.equal(record.acpx?.session_options?.model, "opus");
    assert.equal(record.acpx?.session_options?.model_source, "explicit-degrade");

    // The notice IS mirrored for agent/spawner visibility...
    const breadcrumb = record.messages.at(-1);
    assert.ok(
      typeof breadcrumb === "object" && breadcrumb !== null && "Agent" in breadcrumb,
      "degrade notice is an Agent entry",
    );
    assert.ok(JSON.stringify(breadcrumb).includes("Fable share exhausted"));
    assert.equal(sessionHasAgentMessages(record), true);

    // ...but it is tagged synthetic and must NOT count as a real model turn for
    // the fallback-safety gate.
    assert.equal(breadcrumb.Agent.synthetic, true);
    assert.equal(sessionHasRealAgentTurn(record), false);
  });
});

test("a real agent turn alongside the degrade breadcrumb still counts as real history", async () => {
  await withTempHome("acpx-degrade-", async (home) => {
    const record = makeSessionRecord({
      acpxRecordId: "degrade-real-rec",
      acpSessionId: "degrade-real-sid",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace",
      acpx: {
        session_options: { model: "fable", model_source: "explicit", fable_degrade_ok: true },
      },
    });
    record.messages.push({ Agent: { content: [{ Text: "real turn output" }], tool_results: {} } });
    await writeSessionRecordFile(home, record);

    await applyFableDegrade(record, { from: "fable" });
    // The gate is not weakened: real history keeps the loud resume-required path.
    assert.equal(sessionHasRealAgentTurn(record), true);
  });
});
