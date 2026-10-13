import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_QUEUE_SOCKET_PATH_BYTES,
  queueBaseDir,
  queueKeyForSession,
  queueLockFilePath,
  queueSharedSocketDir,
  queueSocketBaseDir,
  queueSocketPath,
} from "../src/cli/queue/paths.js";

test("queue path helpers derive stable lock and socket paths", () => {
  const homeDir = "/tmp/example-home";
  const key = queueKeyForSession("session-id");

  assert.equal(key.length, 24);
  assert.equal(queueBaseDir(homeDir), "/tmp/example-home/.acpx/queues");
  assert.equal(queueLockFilePath("session-id", homeDir), `${queueBaseDir(homeDir)}/${key}.lock`);

  if (process.platform === "win32") {
    assert.equal(queueSocketBaseDir(homeDir), undefined);
    assert.equal(queueSocketPath("session-id", homeDir), `\\\\.\\pipe\\acpx-${key}`);
    return;
  }

  // brick ae547131 §9 — a short HOME's socket is on the SHARED state volume now, not /tmp; the
  // /tmp dir remains the fallback for paths past the byte limit (rewritten per CONCEPT §9.5).
  assert.equal(queueSocketBaseDir(homeDir)?.startsWith("/tmp/acpx-"), true);
  assert.equal(queueSocketPath("session-id", homeDir), `/tmp/example-home/.acpx/q/${key}.sock`);
});

test("T22b the q/ path is used up to the byte limit and falls back to /tmp one byte past it", () => {
  if (process.platform === "win32") {
    return;
  }
  // <home>/.acpx/q/<24>.sock = home + 38 bytes
  const homeAt = (total: number) => `/${"h".repeat(total - 38 - 1)}`;
  const atLimit = queueSocketPath("s", homeAt(MAX_QUEUE_SOCKET_PATH_BYTES));
  assert.equal(Buffer.byteLength(atLimit), MAX_QUEUE_SOCKET_PATH_BYTES);
  assert.ok(atLimit.includes("/.acpx/q/"), atLimit);
  const pastLimit = queueSocketPath("s", homeAt(MAX_QUEUE_SOCKET_PATH_BYTES + 1));
  assert.ok(pastLimit.startsWith("/tmp/acpx-"), pastLimit);
  // a multi-byte HOME is measured in BYTES, not characters
  const multibyte = `/${"é".repeat(40)}`;
  assert.ok(Buffer.byteLength(path.join(queueSharedSocketDir(multibyte), "x".repeat(24))) > 107);
  assert.ok(queueSocketPath("s", multibyte).startsWith("/tmp/acpx-"));
});

/**
 * T22c — two sessions under an 80-byte HOME. Their q/ candidates are past the limit, so both take
 * the /tmp fallback and get two DISTINCT, working sockets. Without the length check they would be
 * bound past byte 108, which Node silently truncates — the CONCEPT A.5 collision, where a client of
 * session two is answered by session one's owner (reproduced below as the control).
 */
test("T22c two sessions with an 80-byte HOME get two distinct, working sockets", async () => {
  if (process.platform !== "linux") {
    return;
  }
  const home = `/tmp/${"r".repeat(80 - 5)}`;
  assert.equal(Buffer.byteLength(home), 80);
  const paths = ["session-one", "session-two"].map((id) => queueSocketPath(id, home));
  assert.notEqual(paths[0], paths[1]);
  const servers: net.Server[] = [];
  try {
    for (const [index, socketPath] of paths.entries()) {
      assert.ok(Buffer.byteLength(socketPath) <= MAX_QUEUE_SOCKET_PATH_BYTES, socketPath);
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
      const server = net.createServer((socket) => socket.end(`I am ${index}`));
      await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
      servers.push(server);
    }
    for (const [index, socketPath] of paths.entries()) {
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString()));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      assert.equal(answer, `I am ${index}`, `${socketPath} answered by the wrong owner`);
    }
  } finally {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // the control: two 140-byte paths that differ only past byte 108 DO collide (A.5)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a5-"));
  const long = (tail: string) => path.join(dir, `${"x".repeat(140 - dir.length - 6)}${tail}.sock`);
  const first = net.createServer((socket) => socket.end("ONE"));
  await new Promise<void>((resolve) => first.listen(long("a"), () => resolve()));
  const second = net.createServer();
  const secondBind = await new Promise<string>((resolve) => {
    second.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    second.listen(long("b"), () => resolve("bound"));
  });
  await new Promise<void>((resolve) => first.close(() => resolve()));
  second.close();
  await fs.rm(dir, { recursive: true, force: true });
  assert.equal(secondBind, "EADDRINUSE", "the truncation control did not reproduce");
});

test("queueSocketPath stays short on unix even for long home paths", () => {
  if (process.platform === "win32") {
    return;
  }

  const longHome =
    "/Users/example/Library/Containers/com.example.ReallyLongTemporaryHomePath/Somewhere/Deep";
  const socketPath = queueSocketPath("session-id-for-length-check", longHome);

  assert(socketPath.startsWith("/tmp/acpx-"));
  assert(socketPath.length < 104, socketPath);
});
