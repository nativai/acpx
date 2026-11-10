/**
 * What the connect writes on `record.acpx` must survive the turn's own live checkpoint
 * (brick://7fc0bc03; the sleeping flag half is brick://56d160be).
 *
 * `connectAndLoadSession` replaces and mutates `record.acpx` (`available_models`, the advertised
 * config options, a first wake's deleted `sleeping`) while the turn's `acpxState` still holds the
 * clone taken at turn load. A checkpoint firing in that span assigned the pre-connect `acpxState`
 * back onto `record.acpx` (`mergeLatestDurablePreferences`) and wrote it: the first turn's model
 * check then threw MODEL_NOT_ADVERTISED (~10 % of first wakes of a sleeping session under load, the
 * real claude adapter) and the woken record kept `sleeping` beside its session id.
 *
 * The window is held open deterministically: the test holds `<id>.json.lock` from inside the
 * client's `createSession`, so the materialisation's final record write parks AFTER the connect
 * modified `record.acpx`; the session update `createSession` emitted arms the checkpoint's 500 ms
 * timer, which fires into that span and parks on the same lock; the lock is then released.
 */
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import type { SessionNotification } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  MAIN_PROMPT_TEXT,
  makePathologicalClient,
} from "./pathological-adapter-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const MAIN = "main-0000-4000-8000-000000000000";
const WOKEN = "acp-woken-by-the-turn";

type Raw = {
  acp_session_id: string;
  acpx?: {
    sleeping?: unknown;
    available_models?: string[];
    current_model_id?: string;
    config_options?: unknown[];
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function task(send: (message: QueueOwnerMessage) => void): QueueTask {
  return {
    requestId: "req-main",
    messageId: MAIN,
    message: MAIN_PROMPT_TEXT,
    prompt: textPrompt(MAIN_PROMPT_TEXT),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send,
    close: () => {},
  } satisfies QueueTask;
}

async function wake(agentCommand: string): Promise<{ raw: Raw; failure: unknown }> {
  let out: { raw: Raw; failure: unknown } | undefined;
  await withTempHome("acpx-7fc0bc03-", async (homeDir) => {
    const id = `wake-${agentCommand.length}`;
    const record = makeSessionRecord(
      { acpxRecordId: id, acpSessionId: "", agentCommand, cwd: homeDir },
      { defaultAcpx: false },
    );
    // Created `--model fast-model`, as the real reproduction was (`--model haiku`).
    record.acpx = {
      sleeping: { since: "2026-11-10T10:00:00.000Z" },
      session_options: { model: "fast-model" },
    };
    await writeSessionRecordFile(homeDir, record);
    const file = sessionFilePath(homeDir, id);
    const lockPath = `${file}.lock`;

    const control = makePathologicalClient({ acpSessionId: WOKEN });
    const advertised = {
      sessionId: WOKEN,
      agentSessionId: "agent-woken",
      models: {
        currentModelId: "default-model",
        availableModels: [
          { modelId: "default-model", name: "default-model" },
          { modelId: "fast-model", name: "fast-model" },
        ],
      },
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "medium",
          options: [{ value: "medium", name: "medium" }],
        },
      ],
    };
    // What the connect obtains from the adapter, and the park-and-arm that opens the window.
    const park = async (): Promise<void> => {
      control.emitSessionUpdate({
        sessionId: WOKEN,
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      } as unknown as SessionNotification);
      await fs.writeFile(lockPath, "{}");
    };
    const client = control.client as unknown as Record<string, unknown>;
    client.hasReusableSession = () => false;
    client.createSession = async () => {
      await park();
      return advertised;
    };

    const sent: QueueOwnerMessage[] = [];
    const run = runQueuedTask(id, [task((message) => sent.push(message))], {
      sharedClient: control.client,
      suppressSdkConsoleErrors: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The materialisation's write is parked; the checkpoint timer (500 ms) fires into the window.
    await sleep(1_500);
    await fs.rm(lockPath, { force: true });

    const settled = await Promise.race([
      control.mainPromptInFlight.then(() => "prompting" as const),
      run.then(() => "ended" as const),
    ]);
    if (settled === "prompting") {
      control.resolveMainPrompt({ stopReason: "end_turn" });
    }
    // A failed turn is reported to the caller as an `error` message, not thrown.
    const thrown = await run;
    const reported = sent.find((message) => message.type === "error");
    const failure = thrown ?? (reported === undefined ? undefined : JSON.stringify(reported));
    out = { raw: JSON.parse(await fs.readFile(file, "utf8")) as Raw, failure };
  });
  assert.ok(out);
  return out;
}

// Production runs `node /opt/claude-agent-acp/dist/index.js`: the model check lets a missing
// advertisement pass for that command (supportsLegacyClaudeCodeModelMetadata), so the clobber there
// shows as a DONE turn whose record lost `available_models` and kept `sleeping`.
test("a first wake: the connect's results survive a checkpoint inside the window (the production adapter command)", async () => {
  const { raw, failure } = await wake(CLAUDE_AGENT_COMMAND);
  assert.equal(failure, undefined, `the first turn ran (${String(failure)})`);
  assert.equal(raw.acp_session_id, WOKEN);
  assert.deepEqual(raw.acpx?.available_models, ["default-model", "fast-model"]);
  assert.equal(raw.acpx?.config_options?.length, 1, "the advertised config options survive");
  assert.equal(raw.acpx?.sleeping, undefined, "and the woken record is not marked sleeping");
});

// An adapter command without the claude token has no such leniency: the lost advertisement made the
// first turn's model check throw MODEL_NOT_ADVERTISED (every time the window was hit, 21 of 180
// first wakes in the rig whose adapter copy sat outside a `claude-agent-acp` path).
test("a first wake: the first turn's model check passes (an adapter command without the claude token)", async () => {
  const { raw, failure } = await wake("node /opt/generic-acp/dist/index.js");
  assert.equal(failure, undefined, `the first turn ran (${String(failure)})`);
  assert.deepEqual(raw.acpx?.available_models, ["default-model", "fast-model"]);
});
