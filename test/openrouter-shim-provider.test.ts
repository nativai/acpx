import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnOpenRouterShim } from "../src/acp/openrouter-shim.js";

// T8 — brick 4c272cab §6.1: the Claude path's `provider` injection, checked
// against THE BODY OPENROUTER WOULD HAVE RECEIVED.
//
// ⚠️ THIS IS THE ONLY WAY TO CHECK THE CLAUDE PATH, AND IT IS WHY THE
// `OR_UPSTREAM_HOST` SEAM EXISTS (HoD ruling R-5). The shim used to hardcode its
// upstream, so the best available evidence was "OR_PROVIDER was on the child's
// env" — one step short of the place a Claude-path bug would actually hide.
// Asserting on the reply instead would be worse still: a reply proves only that
// SOMEBODY served the turn, and the named provider is routinely unavailable
// (acceptance A3 is deliberately NOT "the named provider served").
//
// The real shim process is spawned here — not a re-implementation of it — so a
// change to the embedded source is what these rows measure.

const SYNTHETIC_KEY = "sk-or-v1-TESTONLY-0000000000000000000000000000000000000000";
const MODEL = "z-ai/glm-5.3-flash";

type Capture = { bodies: unknown[]; origin: string; close: () => Promise<void> };

/**
 * A capture server standing in for openrouter.ai. It answers with a
 * NON-STREAMED completion body carrying the two attribution fields, which is the
 * shape the shim sniffs.
 */
async function captureServer(reply?: unknown): Promise<Capture> {
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        bodies.push({ unparseable: Buffer.concat(chunks).toString("utf8") });
      }
      const body = JSON.stringify(
        reply ?? {
          id: "gen-TESTONLY-1",
          provider: "Modal",
          choices: [{ finish_reason: "stop", native_finish_reason: "eos_token" }],
        },
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    bodies,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const DEFAULT_PAYLOAD = {
  model: "claude-opus-4-8",
  max_tokens: 1,
  messages: [{ role: "user", content: "hi" }],
};

async function postMessages(port: number, payload: unknown = DEFAULT_PAYLOAD): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  await response.text();
}

async function withShim(
  options: Parameters<typeof spawnOpenRouterShim>[2],
  run: (capture: Capture) => Promise<void>,
  reply?: unknown,
  payload?: unknown,
): Promise<void> {
  const capture = await captureServer(reply);
  const previous = process.env.OR_UPSTREAM_HOST;
  process.env.OR_UPSTREAM_HOST = capture.origin;
  try {
    const shim = await spawnOpenRouterShim(SYNTHETIC_KEY, MODEL, options);
    try {
      await postMessages(shim.port, payload);
      await run(capture);
    } finally {
      shim.stop();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.OR_UPSTREAM_HOST;
    } else {
      process.env.OR_UPSTREAM_HOST = previous;
    }
    await capture.close();
  }
}

test("T8 · OR_PROVIDER set ⇒ the forwarded body carries an EQUAL provider object", async () => {
  const providerObject = {
    order: ["baseten", "modal"],
    ignore: ["wafer"],
    quantizations: ["int8", "fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"],
    allow_fallbacks: true,
  };
  await withShim({ providerObject }, async (capture) => {
    assert.equal(capture.bodies.length, 1);
    const body = capture.bodies[0] as Record<string, unknown>;
    assert.deepEqual(body.provider, providerObject);
    // The model rewrite still happens — the two axes are independent.
    assert.equal(body.model, MODEL);
  });
});

test("A8 · no policy ⇒ NO provider key at all (not {}), body otherwise unchanged", async () => {
  await withShim({}, async (capture) => {
    const body = capture.bodies[0] as Record<string, unknown>;
    // `in`, not a truthiness check: `{}` and `null` would both pass the latter,
    // and `{}` is exactly the shape pi's truthiness guard would have forwarded.
    assert.equal("provider" in body, false);
  });
});

test("T8 · malformed OR_PROVIDER ⇒ key absent AND the shim still starts", async () => {
  // A settings typo must not present as a broken OpenRouter credential. The shim
  // process.exit(1)s on a missing key; this path must not join it.
  const capture = await captureServer();
  const previousHost = process.env.OR_UPSTREAM_HOST;
  const previousProvider = process.env.OR_PROVIDER;
  process.env.OR_UPSTREAM_HOST = capture.origin;
  process.env.OR_PROVIDER = "{not json";
  try {
    // `spawnOpenRouterShim` would overwrite OR_PROVIDER from its options, so the
    // malformed value is planted on the inherited env instead — the same place
    // the child reads it from.
    const shim = await spawnOpenRouterShim(SYNTHETIC_KEY, MODEL, {});
    try {
      await postMessages(shim.port);
      assert.equal("provider" in (capture.bodies[0] as Record<string, unknown>), false);
    } finally {
      shim.stop();
    }
  } finally {
    process.env.OR_UPSTREAM_HOST = previousHost;
    if (previousProvider === undefined) {
      delete process.env.OR_PROVIDER;
    } else {
      process.env.OR_PROVIDER = previousProvider;
    }
    await capture.close();
  }
});

test("T9 · the shim records the SERVED provider, never the preferred one", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acpx-or-attr-test-"));
  const logPath = path.join(dir, "or-attribution.ndjson");
  await withShim(
    {
      // The policy PREFERS BaseTen; the capture server answers as Modal. If the
      // recorded provider ever tracked the preference, this row goes red — which
      // is the whole point: a record that agrees with the policy by construction
      // cannot falsify the feature.
      providerObject: { order: ["baseten"], allow_fallbacks: true },
      attributionLogPath: logPath,
    },
    async () => {
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]) as Record<string, unknown>;
      assert.equal(entry.provider, "Modal");
      assert.equal(entry.native_finish_reason, "eos_token");
      assert.equal(entry.gen_id, "gen-TESTONLY-1");
      assert.equal(entry.model, MODEL);
    },
  );
});

test("F-3 · the line is written BEFORE the response body reaches the client", async () => {
  // 🛑 THE ORDERING THAT WAS THE BUG. Writing at upstream 'end' lost a race that
  // only exists in the production shape: on a STREAMED response the SDK acts on
  // the final SSE event as it arrives, so acpx's usage_update — and its read of
  // this log — can happen before the HTTP stream ends. Measured 3/3 against real
  // OpenRouter by the test engineer; a local non-streamed capture server won the
  // race every time, which is exactly why both lanes' rigs saw nothing.
  //
  // This row reproduces the production shape: an upstream that sends
  // `message_start` (which carries the provider) and then HOLDS THE STREAM OPEN.
  // The assertion is that the log already has the line while the body is still
  // being delivered — i.e. the line cannot arrive after the turn.
  const dir = mkdtempSync(path.join(os.tmpdir(), "acpx-or-attr-race-"));
  const logPath = path.join(dir, "or-attribution.ndjson");

  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", async () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Exactly what OpenRouter's Anthropic-compatible endpoint sends first.
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { id: "gen-STREAM-1", provider: "Together", model: MODEL },
        })}\n\n`,
      );
      await held;
      res.end("event: message_stop\ndata: {}\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const previous = process.env.OR_UPSTREAM_HOST;
  process.env.OR_UPSTREAM_HOST = `http://127.0.0.1:${port}`;
  const shim = await spawnOpenRouterShim(SYNTHETIC_KEY, MODEL, { attributionLogPath: logPath });
  try {
    const inFlight = postMessages(shim.port);
    // Poll while the upstream response is DELIBERATELY UNFINISHED.
    let recorded: string | undefined;
    for (let attempt = 0; attempt < 100 && !recorded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        const line = readFileSync(logPath, "utf8").trim();
        recorded =
          line.length > 0 ? (JSON.parse(line) as { provider: string }).provider : undefined;
      } catch {
        /* the log does not exist until the first response — ENOENT is normal here */
      }
    }
    assert.equal(recorded, "Together", "the provider must be on disk before the stream ends");
    release?.();
    await inFlight;
  } finally {
    process.env.OR_UPSTREAM_HOST = previous;
    shim.stop();
    server.close();
  }
});

test("T9 · a response naming no provider records NOTHING — absence stays absence", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "acpx-or-attr-test-"));
  const logPath = path.join(dir, "or-attribution.ndjson");
  // Plant the file so "no line was appended" is distinguishable from "the log
  // was never created" — an absent file would satisfy a naive emptiness check
  // for the wrong reason.
  writeFileSync(logPath, "", "utf8");
  await withShim(
    { providerObject: { order: ["baseten"], allow_fallbacks: true }, attributionLogPath: logPath },
    async () => {
      assert.equal(readFileSync(logPath, "utf8"), "");
    },
    { id: "gen-TESTONLY-2", choices: [{ finish_reason: "stop" }] },
  );
});

// brick 92121ff9 — CLI 2.1.287 sends per-turn effort as an `output_config` ON A
// MESSAGE (a mid-conversation `role:"system"` message). OpenRouter 400s it as a
// "configuration_update" for every non-Anthropic provider. The shim strips it as
// a safety net behind acpx's CLAUDE_CODE_MODEL_CAPABILITIES knob. This payload is
// the shape captured from a real 2.1.287 request (evidence/capture-A-*.ndjson).
const PER_TURN_EFFORT_PAYLOAD = {
  model: "claude-opus-5-5",
  max_tokens: 1,
  output_config: { effort: "high" },
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "system",
      content: [{ type: "text", text: "<env>" }],
      output_config: { effort: "high" },
    },
  ],
};

test("92121ff9 · per-message output_config is stripped from EVERY message", async () => {
  await withShim(
    {},
    async (capture) => {
      assert.equal(capture.bodies.length, 1);
      const body = capture.bodies[0] as { messages: Record<string, unknown>[] };
      assert.equal(body.messages.length, 2, "messages themselves are forwarded, not dropped");
      for (const message of body.messages) {
        assert.equal("output_config" in message, false);
      }
      // The system message's content survives — only the effort carrier goes.
      assert.deepEqual(body.messages[1].content, [{ type: "text", text: "<env>" }]);
    },
    undefined,
    PER_TURN_EFFORT_PAYLOAD,
  );
});

test("92121ff9 · the TOP-LEVEL output_config.effort (the user's selection) is kept unchanged", async () => {
  // The negative case for the row above: an over-eager strip that also deleted
  // the conversation-level effort would pass it and silently drop what the user
  // selected — both green-listed models accept effort at conversation level.
  await withShim(
    {},
    async (capture) => {
      const body = capture.bodies[0] as Record<string, unknown>;
      assert.deepEqual(body.output_config, { effort: "high" });
    },
    undefined,
    PER_TURN_EFFORT_PAYLOAD,
  );
});
