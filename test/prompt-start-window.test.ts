/**
 * The PROMPT-START WINDOW (brick bf3a4533) — deterministic, no load involved.
 *
 * With a per-turn context provider registered, `AcpClient.prompt()` awaits the composed
 * context BEFORE its `session/prompt` reaches the wire. `runPromptTurn` fires
 * `onPromptStarted` the moment `prompt()` returns — i.e. INSIDE that window — and that hook
 * is where the queue owner applies a cancel queued while the turn was starting
 * (`markPromptActive` + `applyPendingCancel`) and where the mid-turn handler is armed.
 *
 * On 54cacda8 (the context alarm made the registry non-empty) both went wrong: the pending
 * cancel saw `hasActivePrompt() === false` and was dropped while the CLI had already been
 * told `cancelled: true`, so the turn ran to `end_turn`; and a prompt injected from the hook
 * reached the agent AHEAD of the turn's own prompt. `test/integration.test.ts`'s
 * "cancel yields cancelled stopReason" reproduced the first only under box load. These rows
 * hold the window open BY CONSTRUCTION — a test provider that waits on a gate the test
 * controls — so they fail on the defect every time.
 *
 * Real `AcpClient` + mock agent + real `runPromptTurn` + real `QueueOwnerTurnController`,
 * wired exactly as `queue-owner-runtime.ts` wires them.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/acp/client.js";
import { setTurnContextProvidersForTesting } from "../src/acp/turn-context.js";
import { QueueOwnerTurnController } from "../src/cli/queue/owner-turn-controller.js";
import { runPromptTurn } from "../src/runtime/engine/prompt-turn.js";
import { createSessionConversation } from "../src/session/conversation-model.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
// Well inside TURN_CONTEXT_BUDGET_MS (100), so the gate — not the budget — closes the window.
const GATE_MS = 20;

type MockOperation = { method?: string; text?: string };

async function promptTexts(operationLog: string): Promise<string[]> {
  const raw = await fs.readFile(operationLog, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MockOperation)
    .filter((operation) => operation.method === "session/prompt")
    .map((operation) => operation.text ?? "");
}

/**
 * A real client on the mock agent, with a registered provider that holds every turn's
 * prompt off the wire for {@link GATE_MS}. `onWindowOpen` runs while the window is open.
 */
async function withGatedClient(
  onWindowOpen: () => void,
  run: (client: AcpClient, sessionId: string, operationLog: string) => Promise<void>,
): Promise<void> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-start-window-"));
  const operationLog = path.join(scratchDir, "ops.jsonl");
  const client = new AcpClient({
    agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --operation-log ${JSON.stringify(operationLog)}`,
    cwd: scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: "prompt-start-window" },
  });
  const restore = setTurnContextProvidersForTesting([
    {
      id: "test-start-gate",
      attribution: { kind: "neutral" },
      resolve: async () => {
        onWindowOpen();
        await new Promise((resolve) => setTimeout(resolve, GATE_MS));
        return undefined;
      },
    },
  ]);
  try {
    await client.start();
    const created = await client.createSession();
    await run(client, created.sessionId, operationLog);
  } finally {
    restore();
    await client.close().catch(() => {});
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

function ownerTurnController(client: AcpClient): QueueOwnerTurnController {
  const controller = new QueueOwnerTurnController({
    withTimeout: async (run) => await run(),
    setSessionModeFallback: async () => {},
    setSessionModelFallback: async () => {},
    setSessionConfigOptionFallback: async () => ({}) as SetSessionConfigOptionResponse,
  });
  controller.setActiveController({
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({}) as SetSessionConfigOptionResponse,
  });
  return controller;
}

test("bf3a4533: a cancel accepted while the turn's prompt is starting cancels that turn", async () => {
  let controller: QueueOwnerTurnController | undefined;
  let cancelAccepted: Promise<boolean> | undefined;
  await withGatedClient(
    () => {
      // The `acpx cancel` IPC request landing while the prompt is held off the wire.
      cancelAccepted ??= controller?.requestCancel();
    },
    async (client, sessionId) => {
      controller = ownerTurnController(client);
      controller.beginTurn();
      const startedAt = Date.now();
      const result = await runPromptTurn({
        client,
        sessionId,
        prompt: "sleep 3000",
        conversation: createSessionConversation(),
        // queue-owner-runtime.ts's onPromptActive, verbatim.
        onPromptStarted: async () => {
          controller?.markPromptActive();
          await controller?.applyPendingCancel();
        },
      });
      controller.endTurn();

      assert.ok(cancelAccepted, "the cancel must have been sent inside the start window");
      assert.equal(await cancelAccepted, true, "the owner told the CLI the cancel was accepted");
      assert.equal(
        result.stopReason,
        "cancelled",
        "an ACCEPTED cancel must cancel the turn — reporting cancelled:true and then letting " +
          "the turn run to end_turn is the bf3a4533 defect",
      );
      assert.ok(Date.now() - startedAt < 3000, "the 3 s turn must not have run to completion");
    },
  );
});

test("bf3a4533: a prompt injected while the turn's prompt is starting reaches the agent after it, and is delivered", async () => {
  // CONTROL for the gate: the window must actually be open when the hook runs, or this row
  // passes on a build where the provider is never consulted.
  let windowOpened = false;
  await withGatedClient(
    () => {
      windowOpened = true;
    },
    async (client, sessionId, operationLog) => {
      let injected: Promise<{ stopReason: string }> | undefined;
      await runPromptTurn({
        client,
        sessionId,
        prompt: "sleep 2000",
        conversation: createSessionConversation(),
        // Where runtime.ts arms the mid-turn handler: a message arriving now is injected.
        onPromptStarted: () => {
          injected = client.prompt(sessionId, "sleep 200");
        },
      });
      assert.equal(windowOpened, true, "the turn's prompt must have passed through the gate");
      assert.ok(injected, "the hook must have injected");
      const injectedResult = await injected;

      assert.deepEqual(
        await promptTexts(operationLog),
        ["sleep 2000", "sleep 200"],
        "the turn's own prompt must reach the agent FIRST; an injection overtaking it while " +
          "the context is composed turns the turn's prompt into the steer",
      );
      assert.equal(
        injectedResult.stopReason,
        "end_turn",
        "the injected message must be delivered, not displaced by the turn it was injected into",
      );
    },
  );
});
