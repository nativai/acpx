import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { queueLockFilePath, queueSocketPath } from "../src/cli/queue/paths.js";

export type QueuePaths = {
  lockPath: string;
  socketPath: string;
};

export function queuePaths(homeDir: string, sessionId: string): QueuePaths {
  return {
    lockPath: queueLockFilePath(sessionId, homeDir),
    socketPath: queueSocketPath(sessionId, homeDir),
  };
}

export async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-test-home-"));
  process.env.HOME = tempHome;

  try {
    await run(tempHome);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

export async function startKeeperProcess(): Promise<ReturnType<typeof spawn>> {
  const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  await once(keeper, "spawn");
  return keeper;
}

// A keeper spawned `detached: true`, i.e. its own process-group leader
// (pgid === pid) — matching how the real queue owner is spawned
// (queue-owner-process.ts). Lets tests exercise the process-group kill path.
export async function startDetachedKeeperProcess(): Promise<ReturnType<typeof spawn>> {
  const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    detached: true,
  });
  await once(keeper, "spawn");
  return keeper;
}

// A detached group-leader "owner" that itself spawns a non-detached "grandchild"
// in the same process group, mirroring owner -> ACP adapter -> SDK child. The
// grandchild's pid is written to `pidFile` so a test can assert the process-group
// kill reaps it (risk R2: a native-blocked grandchild must not be orphaned).
export async function startDetachedOwnerWithChild(
  pidFile: string,
): Promise<{ owner: ReturnType<typeof spawn>; childPid: number }> {
  const script =
    "const{spawn}=require('node:child_process');const fs=require('node:fs');" +
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);";
  const owner = spawn(process.execPath, ["-e", script, pidFile], {
    stdio: "ignore",
    detached: true,
  });
  await once(owner, "spawn");

  let childPid = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const raw = (await fs.readFile(pidFile, "utf8")).trim();
      if (raw) {
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed > 0) {
          childPid = parsed;
          break;
        }
      }
    } catch {
      // pid file not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { owner, childPid };
}

export function stopProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
  }
}

export async function writeQueueOwnerLock(options: {
  lockPath: string;
  pid: number | undefined;
  sessionId: string;
  socketPath: string;
  ownerGeneration?: number;
  queueDepth?: number;
  createdAt?: string;
  heartbeatAt?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const createdAt = options.createdAt ?? now;
  const heartbeatAt = options.heartbeatAt ?? createdAt;
  await fs.mkdir(path.dirname(options.lockPath), { recursive: true });
  await fs.writeFile(
    options.lockPath,
    `${JSON.stringify({
      pid: options.pid,
      sessionId: options.sessionId,
      socketPath: options.socketPath,
      createdAt,
      heartbeatAt,
      ownerGeneration:
        options.ownerGeneration ?? Date.now() * 1_000 + Math.floor(Math.random() * 1_000),
      queueDepth: options.queueDepth ?? 0,
    })}\n`,
    "utf8",
  );
}

export async function cleanupOwnerArtifacts(options: {
  socketPath: string;
  lockPath: string;
}): Promise<void> {
  if (process.platform !== "win32") {
    await fs.rm(options.socketPath, { force: true });
  }
  await fs.rm(options.lockPath, { force: true });
}

export async function listenServer(server: net.Server, socketPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

export async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export function createSingleRequestServer(
  onRequest: (socket: net.Socket, request: { requestId: string; type: string }) => void,
): net.Server {
  return net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        return;
      }

      onRequest(socket, JSON.parse(line) as { requestId: string; type: string });
    });
  });
}

export async function connectSocket(socketPath: string): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export async function nextJsonLine(
  iterator: AsyncIterator<string>,
  timeoutMs = 2_000,
): Promise<unknown> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for queue line")), timeoutMs);
  });

  const next = (async () => {
    const result = await iterator.next();
    if (result.done || !result.value) {
      throw new Error("Queue socket closed before receiving expected line");
    }
    return JSON.parse(result.value);
  })();

  return await Promise.race([next, timeout]);
}
