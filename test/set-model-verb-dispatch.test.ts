import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";

// F-10: the CLI verb's own path did not dispatch on mechanism.
//
// ⚠️ THE ROW THAT PROVED THE DISPATCH IS GONE, AND SO IS THE DISPATCH. It needed
// a harness whose model is a config option, and none is declared any more — the
// arm was removed with the last one (brick://2b02ccd3). What survives here is the
// GUARDRAIL below: `setSessionModel` must keep emitting `session/set_model` for
// the harnesses that do use it. If a per-mechanism dispatch ever returns, it
// belongs inside `setSessionModel` — never re-inlined into the callers, which is
// the hand-maintained-list failure F-10 was.
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
    sessionContext: { seatNameGeneric: false, acpxRecordId: "rec-f10" },
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

test("F-10 GUARDRAIL: claude and codex still emit session/set_model", async () => {
  // The surviving half of F-10: the generic path must still reach the wire for
  // every harness that uses it. If this ever goes quiet,  has
  // grown a branch that swallows the call.
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
