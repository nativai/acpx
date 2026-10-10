// Fake ACP adapter for brick 7c06a855: answers initialize and session/new, and
// on session/prompt writes to stderr and then dies with exit code 1 mid-prompt,
// the shape codex-acp took on 2026-10-10 (an uncaught exception's stack on
// stderr, then exit 1). argv[2] is the number of filler bytes to write first;
// the final writes split one line across two chunks and a multi-byte character
// across two more, so the owner log must reassemble them.
import readline from "node:readline";

const fillerBytes = Number(process.argv[2] ?? "0");
// Mirrored in test/agent-stderr-tee.test.ts; never import this file (it reads stdin).
const CRASH_MARKER = "Error: stderr-crash-adapter boom";

function reply(id: unknown, body: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
}

function write(chunk: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write(chunk, () => setTimeout(resolve, 5));
  });
}

async function crash(): Promise<never> {
  process.stderr.write("startup noise before the crash\n");
  if (fillerBytes > 0) {
    await write(`${"x".repeat(99)}\n`.repeat(Math.ceil(fillerBytes / 100)));
  }
  await write("split line, first half / ");
  await write("second half\n");
  const euro = Buffer.from("multi-byte: €\n", "utf8");
  const cut = euro.indexOf(0xe2) + 1;
  await write(euro.subarray(0, cut));
  await write(euro.subarray(cut));
  await write(`${CRASH_MARKER}\n    at handlePrompt (stderr-crash-adapter.js:1:1)\n`);
  process.exit(1);
}

readline.createInterface({ input: process.stdin }).on("line", (raw) => {
  const request = JSON.parse(raw) as { id?: unknown; method?: string };
  if (request.id === undefined) {
    return;
  }
  if (request.method === "initialize") {
    reply(request.id, {
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "stderr-crash-adapter", version: "1" },
        authMethods: [],
      },
    });
    return;
  }
  if (request.method === "session/new") {
    reply(request.id, { result: { sessionId: "stderr-crash-session" } });
    return;
  }
  if (request.method === "session/prompt") {
    void crash();
    return;
  }
  reply(request.id, { result: {} });
});
