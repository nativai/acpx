// The queue-owner stand-in for the self-close INDEX row (brick 19ee17ab, T2 in
// test/self-close.test.ts).
//
// Production shape: the session's own queue owner holds a pending (throttled) index update for
// the session — its last live checkpoint, projected while the session was open — and the session
// closes ITSELF from inside its turn. The self arm writes `closed:true` to the record and the
// index, sends this owner a zero-timeout drain, then terminates it. If the owner's trailing flush
// fires inside that window it used to write its pre-close snapshot over the close (RCA 2338b781).
// This stand-in makes that schedule deterministic: it flushes exactly when the drain arrives,
// BEFORE it answers, so the write lands between the close's index write and the terminate.
// On SIGTERM it exits without flushing, as the real owner does (no async I/O in that handler).
//
// Like the INTERMEDIATE_SCRIPT owner it extends, it spawns the close-running grandchild
// (`self-close-owner-child.js`) and kills it on SIGTERM. Not a test file — only spawned.
//
// Protocol (stdout): `READY` once the pending update is held and the socket listens;
// `DRAIN <json>` when the drain arrived and the flush finished.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  flushPendingSessionIndexUpdates,
  parseSessionRecord,
  sessionBaseDir,
  sessionRecordFileName,
  writeSessionRecord,
} from "../src/session/persistence.js";
import { listenServer } from "./queue-test-helpers.js";

const [childScript, sessionId, goFile, socketPath] = process.argv.slice(2);
if (!childScript || !sessionId || !goFile || !socketPath) {
  process.stderr.write(
    "usage: self-close-index-owner <childScript> <sessionId> <goFile> <socket>\n",
  );
  process.exit(2);
}

const file = path.join(sessionBaseDir(), sessionRecordFileName(sessionId));
const record = parseSessionRecord(JSON.parse(await fs.readFile(file, "utf8")));
if (!record) {
  throw new Error(`unparseable record ${file}`);
}
record.lastUsedAt = new Date().toISOString();
await writeSessionRecord(record); // this process's membership-immediate write
const firstWrittenAt = Date.now();
record.lastUsedAt = new Date().toISOString();
await writeSessionRecord(record); // throttled → PENDING (closed:false), trailing flush in ~5 s

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("error", () => {
    // a close racing the socket is normal here
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex < 0) {
      return;
    }
    const request = JSON.parse(buffer.slice(0, newlineIndex)) as {
      requestId: string;
      type: string;
    };
    void (async () => {
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      if (request.type === "drain_deliveries") {
        const drainAt = Date.now();
        await flushPendingSessionIndexUpdates(sessionBaseDir());
        process.stdout.write(
          `DRAIN ${JSON.stringify({ sinceFirstWriteMs: drainAt - firstWrittenAt })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: "drain_deliveries_result",
            requestId: request.requestId,
            drained: 0,
            undelivered: [],
            turnSettled: false,
            activeTurnAtEntry: true,
          })}\n`,
        );
      }
      socket.end();
    })();
  });
});
await listenServer(server, socketPath);

const child = spawn(process.execPath, [childScript, sessionId, goFile], {
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});
process.on("SIGTERM", () => {
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
  process.exit(0);
});
process.stdout.write("READY\n");
setInterval(() => {}, 1000);
