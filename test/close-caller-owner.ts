// The PARENT session's queue-owner stand-in for test/close-child-never-closes-caller.test.ts.
//
// Production shape this reproduces: the parent agent's Bash runs UNDER its own queue owner
// (owner → ACP adapter → agent → `acpx sessions close …`), so the CLI that closes a CHILD is a
// descendant of the PARENT's owner. Here: this process (the owner, with a real control socket and
// a lease the test plants with its genuine process identity) → an intermediate runner (the
// adapter/agent layer) → the real CLI.
//
// Everything the parent's owner is ever asked or told is recorded to files, because the property
// under test is what did NOT happen to it:
//   - `observedFile`: one JSON line per control-socket request (a drain or close_session sent to
//     the PARENT's owner means a close was aimed at the PARENT);
//   - `markerFile`: written from the SIGTERM handler (the owner was signalled).
// The CLI's own outcome lands in `resultFile` once it exits.
//
// Not a test file (no `.test.` in the name) — compiled by `build:test`, only spawned.
//
// Protocol (stdout): `READY` once the socket listens and the runner is waiting for the go-file.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { listenServer } from "./queue-test-helpers.js";

const [socketPath, observedFile, markerFile, resultFile, goFile, cliPath, cwd, cliArgsJson] =
  process.argv.slice(2);
if (
  !socketPath ||
  !observedFile ||
  !markerFile ||
  !resultFile ||
  !goFile ||
  !cliPath ||
  !cwd ||
  !cliArgsJson
) {
  process.stderr.write(
    "usage: close-caller-owner <socket> <observed> <marker> <result> <goFile> <cli> <cwd> <cliArgsJson>\n",
  );
  process.exit(2);
}

// The intermediate: waits for the go-file (the test plants the lease FIRST — a close that runs
// before the lease exists could never take the self arm, a red caused by the harness), then runs
// the real CLI and records its outcome.
const RUNNER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [goFile, resultFile, cliPath, cwd, cliArgsJson] = process.argv.slice(1);
const deadline = Date.now() + 30000;
const wait = () => {
  if (fs.existsSync(goFile)) { return run(); }
  if (Date.now() > deadline) { process.exit(3); }
  setTimeout(wait, 10);
};
const run = () => {
  const cli = spawn(process.execPath, [cliPath, ...JSON.parse(cliArgsJson)], {
    cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  cli.stdout.setEncoding('utf8'); cli.stderr.setEncoding('utf8');
  cli.stdout.on('data', (c) => { stdout += c; });
  cli.stderr.on('data', (c) => { stderr += c; });
  cli.on('close', (code, signal) => {
    fs.writeFileSync(resultFile, JSON.stringify({ code, signal, stdout, stderr }));
    process.exit(0);
  });
};
wait();
`;

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("error", () => {
    // a close racing the socket is normal here
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      const request = JSON.parse(line) as {
        requestId: string;
        type: string;
        reason?: string;
        timeoutMs?: number;
      };
      fs.appendFileSync(
        observedFile,
        `${JSON.stringify({
          type: request.type,
          ...(request.reason !== undefined ? { reason: request.reason } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        })}\n`,
      );
      socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
      if (request.type === "drain_deliveries") {
        socket.write(
          `${JSON.stringify({
            type: "drain_deliveries_result",
            requestId: request.requestId,
            drained: 0,
            undelivered: [],
            turnSettled: true,
            activeTurnAtEntry: false,
          })}\n`,
        );
      } else if (request.type === "close_session") {
        socket.write(
          `${JSON.stringify({
            type: "close_session_result",
            requestId: request.requestId,
            closed: true,
          })}\n`,
        );
      } else if (request.type === "schedule_close") {
        // brick 9d34a178 — the deferred self-close: recorded for the end of the (pretend) turn.
        socket.write(
          `${JSON.stringify({
            type: "schedule_close_result",
            requestId: request.requestId,
            scheduled: true,
            activeTurn: true,
          })}\n`,
        );
      }
      socket.end();
    }
  });
});
await listenServer(server, socketPath);

const runner = spawn(
  process.execPath,
  ["-e", RUNNER, goFile, resultFile, cliPath, cwd, cliArgsJson],
  { stdio: ["ignore", "inherit", "inherit"], env: process.env },
);
// Like the production owner, whose exit takes its adapter (and the agent, and the CLI running
// the close) down with it.
process.on("SIGTERM", () => {
  fs.writeFileSync(markerFile, "SIGTERM\n");
  try {
    runner.kill("SIGKILL");
  } catch {
    // already gone
  }
  process.exit(0);
});
process.stdout.write("READY\n");
setInterval(() => {}, 1000);
