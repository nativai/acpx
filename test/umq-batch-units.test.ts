// UMQ A1 (brick 0a6deb9a) — the pure pieces of batching: the envelope's words (UX-SPEC §7, CONTRACTS §2.2),
// the wire request (K4), the CONTEXT_OVERFLOW class (§22.1, verification/R13.md §6), the fork-cut snap (R3)
// and the batch file v1 parser (K3).

import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptRequest } from "../src/acp/client.js";
import {
  isCodexContextOverflowReply,
  isContextOverflowError,
  isContextOverflowText,
} from "../src/acp/error-normalization.js";
import { BatchFileUsageError, parseBatchFile } from "../src/cli/batch-file.js";
import { batchEnvelopeText, buildBatchPrompt } from "../src/cli/session/batch-envelope.js";
import {
  resolveForkCutIndex,
  snapForkCutToBatchBoundary,
} from "../src/cli/session/fork-at-log-index.js";
import type { SessionMessage } from "../src/types.js";

test("K4 envelope: the four texts, literally (en dash, em dash)", () => {
  assert.equal(
    batchEnvelopeText(3),
    "[acpx: 3 messages delivered together, oldest first — each starts with its own sender header]",
  );
  assert.equal(
    batchEnvelopeText(3, { total: 7, from: 1, to: 3 }),
    "[acpx: 3 of 7 messages delivered together, oldest first — each starts with its own sender header; the newer 4 follow in the next turn]",
  );
  assert.equal(
    batchEnvelopeText(2, { total: 7, from: 4, to: 5 }),
    "[acpx: messages 4–5 of 7 delivered together, oldest first — each starts with its own sender header; they continue the previous turn's messages]",
  );
  assert.equal(
    batchEnvelopeText(2, { total: 7, from: 6, to: 7 }),
    "[acpx: the last 2 of 7 messages delivered together, oldest first — each starts with its own sender header; they continue the previous turn's messages]",
  );
  // U3's reader (CONTRACTS §2.2 + §12 A-7) must match block 0 as written, trailing newlines included.
  const block0 = buildBatchPrompt([
    { messageId: "a", requestId: "r#0", prompt: [{ type: "text", text: "x" }] },
    { messageId: "b", requestId: "r#1", prompt: [{ type: "text", text: "y\n" }] },
  ])?.prompt[0] as { text: string };
  assert.match(block0.text, /^\[acpx: [^\]\n]*\]\s*$/u);
});

test("K4 layout: block ranges per member; the last TEXT block of each member ends with newlines, others untouched", () => {
  const built = buildBatchPrompt([
    {
      messageId: "m1",
      requestId: "r#0",
      prompt: [
        { type: "text", text: "header\n\nbody" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    },
    { messageId: "m2", requestId: "r#1", prompt: [{ type: "text", text: "already ends\n" }] },
  ]);
  assert.ok(built);
  assert.deepEqual(built.meta, {
    v: 1,
    envelope: { first: 0, count: 1 },
    members: [
      { messageId: "m1", requestId: "r#0", first: 1, count: 2 },
      { messageId: "m2", requestId: "r#1", first: 3, count: 1 },
    ],
  });
  assert.deepEqual(built.prompt.slice(1), [
    { type: "text", text: "header\n\nbody\n\n" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "text", text: "already ends\n" },
  ]);
});

test("N-A1-1 (builder): a batch of ONE that is not a split part builds nothing — the turn sends the member's own prompt", () => {
  assert.equal(
    buildBatchPrompt([{ messageId: "m", requestId: "r", prompt: [{ type: "text", text: "x" }] }]),
    undefined,
  );
  const part = buildBatchPrompt(
    [{ messageId: "m", requestId: "r", prompt: [{ type: "text", text: "x" }] }],
    { total: 3, from: 3, to: 3 },
  );
  assert.deepEqual(part?.meta.split, { total: 3, from: 3, to: 3 }, "a split part always says so");
});

test("N-A1-1 (wire): without batchMeta the request is today's literal — no _meta key; with it, ranges shift past a turn-context block", () => {
  const prompt = [{ type: "text" as const, text: "x" }];
  const plain = buildPromptRequest("s", prompt, { messageId: "m" });
  assert.deepEqual(Object.keys(plain), ["sessionId", "prompt", "messageId"]);
  assert.equal(plain.prompt, prompt, "same reference");
  const built = buildBatchPrompt([
    { messageId: "a", requestId: "r#0", prompt },
    { messageId: "b", requestId: "r#1", prompt },
  ]);
  assert.ok(built);
  const withContext = buildPromptRequest(
    "s",
    built.prompt,
    { messageId: "a", promptId: "p", batchMeta: built.meta },
    "turn context",
  );
  const meta = (withContext as { _meta?: Record<string, unknown> })._meta;
  assert.equal(meta?.["_claude/promptId"], "p", "the existing key keeps its place");
  assert.deepEqual(meta?.["acpx/batch"], {
    ...built.meta,
    envelope: { first: 1, count: 1 },
    members: [
      { messageId: "a", requestId: "r#0", first: 2, count: 1 },
      { messageId: "b", requestId: "r#1", first: 3, count: 1 },
    ],
  });
});

test("§22.1 CONTEXT_OVERFLOW: each adapter's shape is recognised (R13 §6)", () => {
  const claude = Object.assign(new Error("Internal error: Prompt is too long"), {
    code: -32603,
    data: { errorKind: "invalid_request" },
  });
  const codexCap = Object.assign(new Error("Internal error"), {
    code: -32603,
    data: { details: "Input exceeds the maximum length of 1048576 characters." },
  });
  assert.equal(isContextOverflowError(claude), true, "claude-agent-acp -32603");
  assert.equal(isContextOverflowError(codexCap), true, "codex app-server input cap");
  assert.equal(
    isContextOverflowText(
      "This endpoint's maximum context length is 131072 tokens. However, you requested about 250000 tokens.",
    ),
    true,
    "a pi turnError (OpenRouter)",
  );
  assert.equal(
    isContextOverflowText(
      "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
    ),
    true,
    "pi's own recovery failure",
  );
  assert.equal(
    isCodexContextOverflowReply(
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    ),
    true,
  );
});

test("§22.1 CONTEXT_OVERFLOW negative: other failures are NOT the class (a non-context failure never splits)", () => {
  for (const error of [
    Object.assign(new Error("Internal error"), { code: -32603, data: { details: "boom" } }),
    Object.assign(new Error("Rate limit reached"), {
      code: -32603,
      data: { errorKind: "rate_limit" },
    }),
    Object.assign(new Error("Internal error"), {
      code: -32603,
      data: { errorKind: "invalid_request" },
    }),
    new Error("Session not found"),
  ]) {
    assert.equal(isContextOverflowError(error), false, error.message);
  }
  assert.equal(isContextOverflowText(undefined), false);
  assert.equal(
    isCodexContextOverflowReply("the prompt is too long, so I shortened my summary"),
    false,
    "a reply is matched only against codex's own sentence",
  );
});

function user(id: string): SessionMessage {
  return { User: { id, content: [{ Text: id }] } };
}

function agent(text: string): SessionMessage {
  return { Agent: { content: [{ Text: text }], tool_results: {} } };
}

test("N-A1-12: a fork cut aimed inside a batch snaps to the batch's boundary; k's neighbours are never split from it", () => {
  // [u0, a0, b1, b2, b3, a1] — b1..b3 are one batch turn's members.
  const messages = [user("u0"), agent("a0"), user("b1"), user("b2"), user("b3"), agent("a1")];
  assert.equal(snapForkCutToBatchBoundary(messages, 3), 2, "after b1 -> before b1");
  assert.equal(snapForkCutToBatchBoundary(messages, 4), 2, "after b2 -> before b1");
  assert.equal(snapForkCutToBatchBoundary(messages, 2), 2, "before the batch stays");
  assert.equal(snapForkCutToBatchBoundary(messages, 5), 5, "after its last member stays");
  assert.equal(snapForkCutToBatchBoundary(messages, 6), 6, "after the reply stays");
  assert.equal(snapForkCutToBatchBoundary(messages, 1), 1, "a single User row is not a run");
});

test("N-A1-12 (codex): the harness's turn snap and the batch snap together land on a position both accept", () => {
  const codex = "node /opt/codex-acp/dist/index.js";
  // [u0, a0, b1, b2, b3, a1, u4, a4]
  const messages = [
    user("u0"),
    agent("a0"),
    user("b1"),
    user("b2"),
    user("b3"),
    agent("a1"),
    user("u4"),
    agent("a4"),
  ];
  // 5 -> codex rounds to 4 (inside the batch) -> batch snap 2 -> codex keeps 2.
  assert.equal(resolveForkCutIndex(codex, messages, 5), 2);
  assert.equal(resolveForkCutIndex("node /opt/claude-agent-acp/dist/index.js", messages, 4), 2);
  assert.equal(resolveForkCutIndex("node /opt/claude-agent-acp/dist/index.js", messages, 6), 6);
});

test("K3 batch file v1: a valid file parses in order; each refusal names its rule and member index", () => {
  const prompt = [{ type: "text", text: "x" }];
  const id = (n: number) => `0a6deb9a-3333-4000-8000-${String(n).padStart(12, "0")}`;
  assert.deepEqual(
    parseBatchFile(
      JSON.stringify({
        v: 1,
        messages: [
          { messageId: id(1), prompt },
          { messageId: id(2), prompt, options: { timeoutMs: 1_000 } },
        ],
      }),
    ),
    [
      { messageId: id(1), prompt },
      { messageId: id(2), prompt, options: { timeoutMs: 1_000 } },
    ],
  );
  const refusals: Array<[string, RegExp]> = [
    ["not json", /body is not JSON/u],
    [JSON.stringify({ v: 2, messages: [] }), /version 2 is not supported/u],
    [JSON.stringify({ v: 1, messages: [] }), /messages must be a non-empty array/u],
    [
      JSON.stringify({ v: 1, messages: [{ messageId: "nope", prompt }] }),
      /messages\[0\]: messageId/u,
    ],
    [
      JSON.stringify({
        v: 1,
        messages: [
          { messageId: id(1), prompt },
          { messageId: id(1), prompt },
        ],
      }),
      /messages\[1\]: duplicate messageId/u,
    ],
    [
      JSON.stringify({ v: 1, messages: [{ messageId: id(1), prompt: [] }] }),
      /messages\[0\]: prompt/u,
    ],
    [
      JSON.stringify({
        v: 1,
        messages: [{ messageId: id(1), prompt, options: { timeoutMs: -1 } }],
      }),
      /messages\[0\]: options are invalid/u,
    ],
  ];
  for (const [body, rule] of refusals) {
    assert.throws(
      () => parseBatchFile(body),
      (error: unknown) => error instanceof BatchFileUsageError && rule.test(error.message),
      body,
    );
  }
});
