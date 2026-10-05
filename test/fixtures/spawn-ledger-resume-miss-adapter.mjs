// PREPARED TEST ADAPTER (brick d36c222f). Every session/load and session/resume MISSES with
// -32002 (resource not found) — the normal shape on a cold owner start, 44/44 recent devbox
// prod streams — so the owner falls back to session/new and gets a NEW acp session id.
// Every session/prompt is appended to the log, one JSON line per prompt.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
const log = process.argv[2];
if (!log?.startsWith("/workspace/spawn-ledger-selftest/")) {
  console.error("EXAMINED NOTHING");
  process.exit(2);
}
const note = (entry) => fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
const reply = (id, body) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (!("id" in request)) {
    return;
  }
  if (request.method === "initialize") {
    reply(request.id, {
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "resume-miss-fixture", version: "1" },
        authMethods: [],
      },
    });
    return;
  }
  if (request.method === "session/load" || request.method === "session/resume") {
    note({ method: request.method, sessionId: request.params?.sessionId });
    reply(request.id, { error: { code: -32002, message: "Resource not found" } });
    return;
  }
  if (request.method === "session/new") {
    const sessionId = randomUUID();
    note({ method: "session/new", sessionId });
    reply(request.id, { result: { sessionId } });
    return;
  }
  if (request.method === "session/prompt") {
    const text = (request.params?.prompt ?? [])
      .map((block) => (block?.type === "text" ? block.text : ""))
      .join("");
    note({ method: "session/prompt", sessionId: request.params?.sessionId, text });
    reply(request.id, { result: { stopReason: "end_turn" } });
    return;
  }
  reply(request.id, { result: {} });
});
