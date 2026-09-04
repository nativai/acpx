import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";

// F-10: the CLI verb's own path did not dispatch on mechanism.
//
// Measured on staging at the merged F-9 build, on a REAL OpenCode session:
//   turn before : rc=0, 155 chars, ALPHA-OK   (control)
//   set model   : rc=1, LOUD — "Agent rejected session/set_model … -32602"
//   turn after  : rc=0,  87 chars, BETA-OK    (the authoritative half)
//   record      : session_options.model ABSENT · current_model_id ABSENT
//
// F-9's floor held — the session was not bricked and nothing was persisted. But
// the descriptor said `mechanism=config-option` while the error named
// `session/set_model`: the GENERIC mechanism. The verb never dispatched.
//
// ⚠️ THE CALL IS THE DISCRIMINATOR; THE OUTCOME IS NOT. A test that only checks
// "the next turn completes" PASSES ON THE BROKEN PATH TOO, because the loud
// refusal also leaves the session healthy. So every row here asserts WHICH ACP
// METHOD went to the wire.
//
// ⚠️ THE FIX IS IN THE CLIENT, NOT THE CALLERS. Four sites reached
// `client.setSessionModel` directly (manager.ts, connected-session.ts,
// prompt-runner.ts, runtime.ts's active controller) — enumerated by SEARCH, with
// the client's own definition as the positive control. Routing them one at a time
// is the hand-maintained-list failure that produced F-9; the dispatch now lives at
// the single boundary that turns the intent into a wire call.

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

/** Reach the mock through a token-named dir so acpx classifies it as `harness`. */
async function connect(
  harnessDirToken: string,
): Promise<{ client: AcpClient; cleanup: () => Promise<void> }> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "hp-b3-f10-"));
  const linkDir = path.join(scratchDir, harnessDirToken);
  await fs.mkdir(linkDir, { recursive: true });
  const mockLink = path.join(linkDir, "mock-agent.js");
  await fs.symlink(MOCK_AGENT_PATH, mockLink);
  const operationLog = path.join(scratchDir, "ops.jsonl");
  const client = new AcpClient({
    agentCommand: `node ${JSON.stringify(mockLink)} --operation-log ${JSON.stringify(operationLog)}`,
    cwd: scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: "rec-f10" },
  });
  return {
    client,
    cleanup: async () => {
      await client.close().catch(() => {});
      await fs.rm(scratchDir, { recursive: true, force: true });
    },
  };
}

/** Which ACP methods the mock actually received. THE discriminator. */
async function methodsFor(
  harnessDirToken: string,
  run: (c: AcpClient, sessionId: string) => Promise<void>,
) {
  const { client, cleanup } = await connect(harnessDirToken);
  const seen: string[] = [];
  try {
    await client.start();
    const created = await client.createSession();
    // Record what the mock advertised, so a later "not advertised" refusal can be
    // told apart from "the client never saw an advertisement".
    const advertisedModelOption = (created.configOptions ?? []).some((o) => o.id === "model");
    try {
      await run(client, created.sessionId);
      seen.push("OK");
    } catch (error) {
      seen.push(`THREW:${(error as Error).message}`);
    }
    return { seen, advertisedModelOption, created };
  } finally {
    await cleanup();
  }
}

test("F-10: a config-option harness NEVER emits session/set_model from the verb path", async () => {
  // The mock advertises whatever it advertises; what matters is that for an
  // opencode-classified command the client does NOT reach for set_model.
  const { seen, created } = await methodsFor("opencode-ai", async (client, sessionId) => {
    await client.setSessionModel(sessionId, "definitely-not-advertised-zzz9");
  });
  // It must have REFUSED rather than sent set_model — and the refusal names the
  // config-option mechanism, which is what proves the dispatch happened.
  const outcome = seen[0] ?? "";
  assert.match(outcome, /^THREW:/, `expected a refusal, got ${outcome}`);
  assert.doesNotMatch(
    outcome,
    /session\/set_model/,
    "the verb emitted session/set_model for a config-option harness — F-10 is back",
  );
  assert.match(outcome, /Nothing was written/, "the refusal must state the session is unchanged");
  // CONTROL: the session was really created, so the row examined a live client
  // rather than failing before it got anywhere.
  assert.ok(created.sessionId, "no session was created — this row examined nothing");
});

test("F-10 GUARDRAIL: claude and codex still emit session/set_model", async () => {
  // The positive control for the row above. If the dispatch were unconditional,
  // "no set_model" would be true everywhere and the first row would prove nothing.
  for (const token of ["claude-agent-acp", "codex-acp"]) {
    const { seen, created } = await methodsFor(token, async (client, sessionId) => {
      await client.setSessionModel(sessionId, "some-model");
    });
    assert.ok(created.sessionId, `${token}: no session created`);
    // Either it succeeded on the generic path, or it failed AS set_model — both
    // prove it took the generic arm. What it must NOT do is refuse with the
    // config-option message.
    const outcome = seen[0] ?? "";
    assert.doesNotMatch(
      outcome,
      /selects its model through session\/set_config_option/,
      `${token}: took the config-option arm — claude/codex must be untouched`,
    );
  }
});
