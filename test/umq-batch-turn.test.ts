// UMQ A1 (brick 0a6deb9a) — one turn for a batch: the REAL `runQueuedTask` -> `runSessionPrompt` runtime
// against a scripted Claude adapter that records every `client.prompt()` call. What each row pins is the
// prompt the adapter receives (CONCEPTION §5.3–§5.5, CONTRACTS K4) and the delivery events the stream
// carries for each member (exactly one terminal each). Rows are titled with their TEST-PLAN §4.1 ids.

import assert from "node:assert/strict";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import type { AcpxBatchMeta } from "../src/acp/batch-meta.js";
import type { AcpPromptOptions } from "../src/acp/client.js";
import {
  type QueueOwnerControlHandlers,
  type QueueTask,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { resetSessionCloseIntentForTests } from "../src/cli/queue/session-close-intent.js";
import { batchEnvelopeText } from "../src/cli/session/batch-envelope.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import { buildDeliveryEvent } from "../src/session/delivery-events.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { listSessionEvents, SessionEventWriter } from "../src/session/events.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import type { PromptInput, SessionRecord } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  createDeferred,
  type Deferred,
} from "./pathological-adapter-helpers.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const MUST_FINISH_MS = 30_000;

type PromptResponse = { stopReason: "end_turn" | "cancelled"; _meta?: Record<string, unknown> };

type PromptCall = {
  input: PromptInput;
  options: AcpPromptOptions | undefined;
  /** Settles this call (only used when the script withholds it). */
  settle: Deferred<PromptResponse>;
};

type Script = (call: PromptCall, index: number) => void;

/** A Claude-backend client whose `prompt()` records every call; `script` decides how each settles. */
function makeRecordingClient(script: Script) {
  const calls: PromptCall[] = [];
  const mock = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    markAdvertisement: () => 0,
    advertisedConfigOptionsSince: () => undefined,
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: () => {},
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => true,
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt: (
      _sessionId: string,
      input: PromptInput | string,
      options?: AcpPromptOptions,
    ): Promise<PromptResponse> => {
      const call: PromptCall = {
        input: typeof input === "string" ? textPrompt(input) : input,
        options,
        settle: createDeferred<PromptResponse>(),
      };
      calls.push(call);
      script(call, calls.length - 1);
      return call.settle.promise;
    },
  };
  return { client: mock as unknown as import("../src/acp/client.js").AcpClient, calls };
}

function endTurnAlways(call: PromptCall): void {
  call.settle.resolve({ stopReason: "end_turn" });
}

function memberId(n: number): string {
  return `0a6deb9a-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function makeTask(n: number, text = `hello ${n}`): QueueTask {
  return {
    requestId: `req-batch#${n - 1}`,
    messageId: memberId(n),
    message: text,
    prompt: textPrompt(`[message from a person in atrium (delivery ${memberId(n)})]\n\n${text}`),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: false,
    enqueuedAt: Date.now(),
    send: (_message: QueueOwnerMessage) => {},
    close: () => {},
  } satisfies QueueTask;
}

type DeliveryParams = {
  messageId?: string;
  phase?: string;
  stopReason?: string | null;
  error?: { message?: string; detailCode?: string };
};

async function deliveryEvents(record: SessionRecord): Promise<DeliveryParams[]> {
  const events = (await listSessionEvents(record.acpxRecordId)) as Array<{
    method?: string;
    params?: DeliveryParams;
  }>;
  return events
    .filter((event) => event.method === "acpx/delivery")
    .map((event) => event.params ?? {});
}

async function phasesFor(record: SessionRecord, messageId: string): Promise<string[]> {
  return (await deliveryEvents(record))
    .filter((params) => params.messageId === messageId)
    .map((params) => `${params.phase}${params.stopReason ? `/${params.stopReason}` : ""}`);
}

async function userRowIds(record: SessionRecord): Promise<string[]> {
  const latest = await resolveSessionRecord(record.acpxRecordId);
  return latest.messages.flatMap((message) =>
    message !== "Resume" && "User" in message ? [message.User.id] : [],
  );
}

function batchMetaOf(call: PromptCall): AcpxBatchMeta | undefined {
  return call.options?.batchMeta;
}

function textsOf(call: PromptCall): string[] {
  return call.input.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

async function withRecord(
  sessionId: string,
  body: (record: SessionRecord) => Promise<void>,
): Promise<void> {
  await withTempHome(`acpx-umq-batch-turn-${sessionId}-`, async (homeDir) => {
    const record = makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: `${sessionId}-acp`,
      agentCommand: CLAUDE_AGENT_COMMAND,
      cwd: homeDir,
      // The helper's default (1 KiB, one segment) rotates a batch's lines away before they are read.
      eventLog: {
        active_path: ".stream.ndjson",
        segment_count: 1,
        max_segment_bytes: 64 * 1024 * 1024,
        max_segments: 5,
        last_write_at: "2026-01-01T00:00:00.000Z",
        last_write_error: null,
      },
    });
    await writeSessionRecordFile(homeDir, record);
    try {
      await body(record);
    } finally {
      resetSessionCloseIntentForTests();
    }
  });
}

async function withRaceTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), MUST_FINISH_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + MUST_FINISH_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`never: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("G5 (CONCEPTION §14): a 3-member batch is ONE session/prompt — envelope + members' blocks + _meta acpx/batch; 3 User rows, 3 accepted, 3 done", async () => {
  await withRecord("umq-batch-3", async (record) => {
    const { client, calls } = makeRecordingClient(endTurnAlways);
    const members = [makeTask(1), makeTask(2), makeTask(3)];
    await runQueuedTask(record.acpxRecordId, members, {
      sharedClient: client,
      suppressSdkConsoleErrors: true,
    });

    assert.equal(calls.length, 1, "one prompt for the whole batch");
    const [call] = calls;
    const texts = textsOf(call);
    assert.equal(
      texts[0],
      `${batchEnvelopeText(3)}\n\n`,
      "block 0 is the envelope + its own newlines",
    );
    assert.equal(
      texts[0],
      "[acpx: 3 messages delivered together, oldest first — each starts with its own sender header]\n\n",
    );
    for (const [index, member] of members.entries()) {
      assert.equal(
        texts[index + 1],
        `${(member.prompt[0] as { text: string }).text}\n\n`,
        `member ${index + 1}'s LAST text block ends with its own newlines (pi joins blocks with none)`,
      );
    }
    assert.equal(
      call.options?.messageId,
      memberId(1),
      "the frame's messageId is the head member's",
    );
    assert.deepEqual(batchMetaOf(call), {
      v: 1,
      envelope: { first: 0, count: 1 },
      members: members.map((member, index) => ({
        messageId: member.messageId,
        requestId: member.requestId,
        first: index + 1,
        count: 1,
      })),
    });
    assert.deepEqual(await userRowIds(record), [memberId(1), memberId(2), memberId(3)]);
    for (const member of members) {
      assert.deepEqual(await phasesFor(record, member.messageId ?? ""), [
        "accepted",
        "done/end_turn",
      ]);
    }
  });
});

test("N-A1-1 (runtime half): a batch of ONE sends that member's own prompt — no envelope, no _meta acpx/batch", async () => {
  await withRecord("umq-batch-1", async (record) => {
    const { client, calls } = makeRecordingClient(endTurnAlways);
    const only = makeTask(1);
    await runQueuedTask(record.acpxRecordId, [only], { sharedClient: client });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, only.prompt, "the SAME prompt array, not a rebuilt copy");
    assert.equal(batchMetaOf(calls[0]), undefined);
    assert.deepEqual(await phasesFor(record, memberId(1)), ["accepted", "done/end_turn"]);
  });
});

test("N-A1-15: a batch whose members all already completed ends each done/deduplicated and runs no turn", async () => {
  await withRecord("umq-batch-dedup", async (record) => {
    const first = makeRecordingClient(endTurnAlways);
    await runQueuedTask(record.acpxRecordId, [makeTask(1), makeTask(2)], {
      sharedClient: first.client,
    });
    const again = makeRecordingClient(endTurnAlways);
    await runQueuedTask(record.acpxRecordId, [makeTask(1), makeTask(2)], {
      sharedClient: again.client,
    });
    assert.equal(again.calls.length, 0, "no turn runs");
    for (const n of [1, 2]) {
      assert.deepEqual(await phasesFor(record, memberId(n)), [
        "accepted",
        "done/end_turn",
        "done/deduplicated",
      ]);
    }
    assert.deepEqual(await userRowIds(record), [memberId(1), memberId(2)], "one User row per id");
  });
});

test("N-A1-15 (partial): an already-completed member leaves the batch; the rest run as ONE prompt", async () => {
  await withRecord("umq-batch-dedup-partial", async (record) => {
    await runQueuedTask(record.acpxRecordId, [makeTask(1)], {
      sharedClient: makeRecordingClient(endTurnAlways).client,
    });
    const { client, calls } = makeRecordingClient(endTurnAlways);
    await runQueuedTask(record.acpxRecordId, [makeTask(1), makeTask(2), makeTask(3)], {
      sharedClient: client,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      batchMetaOf(calls[0])?.members.map((member) => member.messageId),
      [memberId(2), memberId(3)],
    );
    assert.deepEqual(await phasesFor(record, memberId(1)), [
      "accepted",
      "done/end_turn",
      "done/deduplicated",
    ]);
  });
});

test("N-A1-4 (runtime half): what reached the capture buffer while the adapter connected joins the turn's ONE prompt", async () => {
  await withRecord("umq-batch-gather", async (record) => {
    const { client, calls } = makeRecordingClient(endTurnAlways);
    const head = makeTask(1);
    const captured = [makeTask(2), makeTask(3)];
    let takes = 0;
    const batch = [head];
    await runQueuedTask(record.acpxRecordId, batch, {
      sharedClient: client,
      takeGatheredTasks: () => {
        takes += 1;
        return captured.splice(0);
      },
    });
    assert.equal(takes, 1, "gather is taken once, at the first prompt send");
    assert.equal(calls.length, 1, "ONE prompt, not one plus two injections");
    assert.deepEqual(
      batchMetaOf(calls[0])?.members.map((member) => member.messageId),
      [memberId(1), memberId(2), memberId(3)],
    );
    assert.deepEqual(await userRowIds(record), [memberId(1), memberId(2), memberId(3)]);
    for (const n of [1, 2, 3]) {
      assert.deepEqual(await phasesFor(record, memberId(n)), ["accepted", "done/end_turn"]);
    }
  });
});

test("N-A1-4 (twin, runtime half): a turn that fails before its prompt is sent never takes the capture buffer", async () => {
  await withRecord("umq-batch-gather-fail", async (record) => {
    const { client } = makeRecordingClient(endTurnAlways);
    (client as unknown as { start: () => Promise<void> }).start = async () => {
      throw new Error("adapter failed to start");
    };
    (client as unknown as { hasReusableSession: () => boolean }).hasReusableSession = () => false;
    let takes = 0;
    await runQueuedTask(record.acpxRecordId, [makeTask(1)], {
      sharedClient: client,
      takeGatheredTasks: () => {
        takes += 1;
        return [makeTask(2)];
      },
    }).catch(() => {});
    assert.equal(takes, 0, "the captured tasks stay with the owner (requeued in order there)");
  });
});

// The claude-agent-acp shape (verification/R13.md §6.1): JSON-RPC -32603 "Internal error: Prompt is too long".
function claudePromptTooLong(): Error {
  return Object.assign(new Error("Internal error: Prompt is too long"), {
    code: -32603,
    data: { errorKind: "invalid_request" },
  });
}

function memberCount(call: PromptCall): number {
  return batchMetaOf(call)?.members.length ?? 1;
}

test("N-A1-7: a stub rejecting any prompt over K members for context size delivers 2K+1 as halves, oldest first, each member exactly once", async () => {
  const K = 2;
  await withRecord("umq-batch-split", async (record) => {
    const { client, calls } = makeRecordingClient((call) => {
      if (memberCount(call) > K) {
        call.settle.reject(claudePromptTooLong());
        return;
      }
      call.settle.resolve({ stopReason: "end_turn" });
    });
    const members = [1, 2, 3, 4, 5].map((n) => makeTask(n));
    const { stderr } = await captureStderr(
      async () =>
        await withRaceTimeout(
          runQueuedTask(record.acpxRecordId, members, { sharedClient: client, promptRetries: 2 }),
          "the split never finished",
        ),
    );

    // 5 -> fails; older 3 -> fails; 2 (1–2) ok; 1 (3) ok; newer 2 (4–5) ok.
    assert.deepEqual(
      calls.map((call) =>
        batchMetaOf(call)
          ?.members.map((m) => m.messageId.slice(-1))
          .join(""),
      ),
      ["12345", "123", "12", "3", "45"],
      "halves, older first, recursively (an odd member goes to the older half); no retry of a misfit",
    );
    assert.deepEqual(
      calls.slice(2).map((call) => batchMetaOf(call)?.split),
      [
        { total: 5, from: 1, to: 2 },
        { total: 5, from: 3, to: 3 },
        { total: 5, from: 4, to: 5 },
      ],
    );
    assert.equal(
      textsOf(calls[2])[0],
      "[acpx: 2 of 5 messages delivered together, oldest first — each starts with its own sender header; the newer 3 follow in the next turn]\n\n",
    );
    assert.equal(
      textsOf(calls[3])[0],
      "[acpx: messages 3–3 of 5 delivered together, oldest first — each starts with its own sender header; they continue the previous turn's messages]\n\n",
    );
    assert.equal(
      textsOf(calls[4])[0],
      "[acpx: the last 2 of 5 messages delivered together, oldest first — each starts with its own sender header; they continue the previous turn's messages]\n\n",
    );
    for (const member of members) {
      const terminals = (await phasesFor(record, member.messageId ?? "")).filter(
        (phase) => phase !== "accepted",
      );
      assert.deepEqual(terminals, ["done/end_turn"], `${member.messageId}: exactly one terminal`);
    }
    assert.deepEqual(
      await userRowIds(record),
      members.map((member) => member.messageId),
    );
    assert.equal(
      stderr.split("\n").filter((line) => line.includes("did not fit the recipient's context"))
        .length,
      2,
      "one owner.log line per split",
    );
  });
});

test("N-A1-7 (twin): a NON-context failure never splits — every member gets that failure's terminal", async () => {
  await withRecord("umq-batch-no-split", async (record) => {
    const { client, calls } = makeRecordingClient((call) => {
      call.settle.reject(
        Object.assign(new Error("Internal error"), {
          code: -32603,
          data: { details: "upstream exploded" },
        }),
      );
    });
    const members = [1, 2, 3].map((n) => makeTask(n));
    const { stderr } = await captureStderr(async () => {
      await runQueuedTask(record.acpxRecordId, members, { sharedClient: client }).catch(() => {});
    });
    assert.equal(calls.length, 1, "no split, no extra turn");
    assert.equal(memberCount(calls[0]), 3);
    for (const member of members) {
      const phases = await phasesFor(record, member.messageId ?? "");
      assert.deepEqual(phases, ["accepted", "failed"], `${member.messageId}`);
    }
    assert.equal(stderr.includes("did not fit the recipient's context"), false);
  });
});

test("N-A1-7 (pi shape): an end_turn carrying a context-overflow turnError splits a batch instead of ending it done", async () => {
  await withRecord("umq-batch-split-pi", async (record) => {
    const { client, calls } = makeRecordingClient((call) => {
      call.settle.resolve(
        memberCount(call) > 1
          ? {
              stopReason: "end_turn",
              _meta: {
                piAcp: {
                  turnError:
                    "This endpoint's maximum context length is 131072 tokens. However, you requested about 250000 tokens.",
                },
              },
            }
          : { stopReason: "end_turn" },
      );
    });
    const members = [1, 2].map((n) => makeTask(n));
    await captureStderr(async () => {
      await runQueuedTask(record.acpxRecordId, members, { sharedClient: client });
    });
    assert.deepEqual(calls.map(memberCount), [2, 1, 1]);
    for (const member of members) {
      assert.deepEqual(
        (await phasesFor(record, member.messageId ?? "")).filter((phase) => phase !== "accepted"),
        ["done/end_turn"],
      );
    }
  });
});

test("N-A1-7 (single message): ONE message that overflows ends with that error exactly as today — no split", async () => {
  await withRecord("umq-batch-single-overflow", async (record) => {
    const { client, calls } = makeRecordingClient((call) => {
      call.settle.reject(claudePromptTooLong());
    });
    await captureStderr(async () => {
      await runQueuedTask(record.acpxRecordId, [makeTask(1)], { sharedClient: client }).catch(
        () => {},
      );
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(await phasesFor(record, memberId(1)), ["accepted", "failed"]);
  });
});

function stubControlHandlers(): QueueOwnerControlHandlers {
  return {
    cancelPrompt: async () => false,
    closeSession: async () => true,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
    setDepth: async (requested: string): Promise<DepthProjection> => ({
      kind: "send-nothing",
      requested,
    }),
    queryActiveTurn: () => true,
  };
}

/**
 * A main turn withheld by the adapter; `body` gets the mid-turn handler the runtime registered and
 * the recorded calls. The rig releases every withheld call afterwards and waits for the turn.
 */
async function withRunningTurn(
  sessionId: string,
  body: (rig: {
    record: SessionRecord;
    inject: (tasks: QueueTask[]) => void;
    calls: PromptCall[];
    owner: SessionQueueOwner;
  }) => Promise<void>,
): Promise<void> {
  await withRecord(sessionId, async (record) => {
    const mainInFlight = createDeferred<void>();
    const { client, calls } = makeRecordingClient((call, index) => {
      if (index === 0) {
        mainInFlight.resolve();
        return;
      }
      call.settle.resolve({ stopReason: "end_turn" });
    });
    const lease = await tryAcquireQueueOwnerLease(record.acpxRecordId);
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, stubControlHandlers(), { maxQueueDepth: 8 });
    let handler: ((tasks: QueueTask[]) => void) | undefined;
    const run = runQueuedTask(record.acpxRecordId, [makeTask(1, "main")], {
      sharedClient: client,
      setMidTurnHandler: (next) => {
        if (next) {
          handler = next;
        }
      },
    });
    try {
      await mainInFlight.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(handler, "the runtime registered its mid-turn handler");
      await body({ record, inject: (tasks) => handler?.(tasks), calls, owner });
      await new Promise((resolve) => setTimeout(resolve, 50));
      calls[0].settle.resolve({ stopReason: "end_turn" });
      await withRaceTimeout(run, "the turn never finished");
    } finally {
      await owner.close();
    }
  });
}

test("N-A1-9: a batch submitted mid-turn is ONE injected client.prompt() with per-member accepted and terminals", async () => {
  await withRunningTurn("umq-batch-midturn", async ({ record, inject, calls }) => {
    inject([makeTask(2), makeTask(3)]);
    await eventually(
      async () => (await phasesFor(record, memberId(3))).includes("done/end_turn"),
      "the injected batch settles",
    );
    assert.equal(calls.length, 2, "main + ONE injected prompt");
    assert.deepEqual(
      batchMetaOf(calls[1])?.members.map((member) => member.messageId),
      [memberId(2), memberId(3)],
    );
    assert.equal(textsOf(calls[1])[0], `${batchEnvelopeText(2)}\n\n`);
    for (const n of [2, 3]) {
      assert.deepEqual(await phasesFor(record, memberId(n)), ["accepted", "done/end_turn"]);
    }
  });
});

test("N-A1-9 (twin): two separate submissions mid-turn stay two injections", async () => {
  await withRunningTurn("umq-batch-midturn-twin", async ({ inject, calls }) => {
    inject([makeTask(2)]);
    inject([makeTask(3)]);
    await eventually(() => calls.length >= 3, "both injections are sent");
    assert.equal(calls.length, 3, "main + two injections");
    assert.equal(batchMetaOf(calls[1]), undefined, "a single injection carries no batch layout");
    assert.equal(batchMetaOf(calls[2]), undefined);
  });
});

test("N-A1-10: a close that cuts a batch turn terminalises every member exactly once", async () => {
  await withRecord("umq-batch-close-cut", async (record) => {
    const mainInFlight = createDeferred<void>();
    const { client, calls } = makeRecordingClient(() => mainInFlight.resolve());
    const lease = await tryAcquireQueueOwnerLease(record.acpxRecordId);
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, stubControlHandlers(), { maxQueueDepth: 8 });
    const members = [1, 2, 3].map((n) => makeTask(n));
    const run = runQueuedTask(record.acpxRecordId, members, { sharedClient: client });
    try {
      await mainInFlight.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await owner.drainDeliveries("session-close", 0);
      assert.equal(owner.terminalizeCustodyOnSignal(), 3, "the sweep writes one per member");
      calls[0].settle.resolve({ stopReason: "cancelled" });
      await withRaceTimeout(run, "the turn never finished");
      for (const member of members) {
        const terminals = (await phasesFor(record, member.messageId ?? "")).filter(
          (phase) => phase !== "accepted",
        );
        assert.equal(terminals.length, 1, `${member.messageId}: exactly one terminal`);
      }
    } finally {
      await owner.close();
    }
  });
});

// A planted positive for `phasesFor`: an event written by hand reads back, so an empty list above
// is the runtime's silence and never a reader that sees nothing.
test("umq batch test reader: a hand-written delivery event reads back", async () => {
  await withRecord("umq-batch-reader-control", async (record) => {
    const writer = await SessionEventWriter.open(record);
    await writer.appendMessage(
      buildDeliveryEvent({ messageId: memberId(9), requestId: "r", phase: "accepted" }),
    );
    await writer.close({ checkpoint: true });
    assert.deepEqual(await phasesFor(record, memberId(9)), ["accepted"]);
  });
});
