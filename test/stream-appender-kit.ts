import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import {
  releaseQueueOwnerLease,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../src/types.js";
import { connectSocket, nextJsonLine } from "./queue-test-helpers.js";
import { withTempHome as sharedWithTempHome } from "./temp-home.js";

// brick 3f33cc2d — the shared fixtures of the stream-appender rows (the lockless appenders to
// `<id>.stream.ndjson`). Only production entry points and the existing hold seam are used here, so the
// production-path rows compile and run on 57004dd5 + the seam commit.

export function withTempHome(
  prefix: string,
  run: (homeDir: string) => Promise<void>,
): Promise<void> {
  return sharedWithTempHome(prefix, run, { pin: ["HOME"] });
}

export function record(id: string, cwd: string): SessionRecord {
  const now = "2026-02-28T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: id,
    acpSessionId: id,
    agentCommand: AGENT_REGISTRY.codex,
    cwd,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: { ...defaultSessionEventLog(id), max_segments: 3, segment_count: 1 },
    closed: false,
    title: null,
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {},
  };
}

export function frame(n: number, pad = 0): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { n, pad: "x".repeat(pad) },
  } as AcpJsonRpcMessage;
}

export async function seedRecord(homeDir: string, id: string): Promise<void> {
  await writeSessionRecord(record(id, homeDir));
}

export function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** The lines a reader sees: split on newline, the final piece after the last newline dropped (if empty). */
export function linesOf(payload: string): string[] {
  const pieces = payload.split("\n");
  return pieces.at(-1) === "" ? pieces.slice(0, -1) : pieces;
}

export type Shape = { lines: number; empty: number; damaged: number; endsWithNewline: boolean };

export function shapeOf(payload: string): Shape {
  const lines = linesOf(payload);
  return {
    lines: lines.length,
    empty: lines.filter((line) => line.trim() === "").length,
    damaged: lines.filter((line) => line.trim() !== "" && !parses(line)).length,
    endsWithNewline: payload.endsWith("\n"),
  };
}

export function methodsOf(events: AcpJsonRpcMessage[]): string[] {
  return events.map((event) => (event as { method?: string }).method ?? "");
}

export function frameNumbers(events: AcpJsonRpcMessage[]): number[] {
  return events
    .filter((event) => (event as { method?: string }).method === "session/update")
    .map((event) => (event as { params: { n: number } }).params.n);
}

const WRITER_SOURCE = `
const [eventsUrl, persistenceUrl, id, frameMiB] = process.argv.slice(1);
const events = await import(eventsUrl);
const persistence = await import(persistenceUrl);
const writer = await events.SessionEventWriter.open(await persistence.resolveSessionRecord(id));
const frame = (n, pad) => ({ jsonrpc: "2.0", method: "session/update", params: { n, pad: "x".repeat(pad) } });
await writer.appendMessages([frame(1, 0)]);
// An event above 1 MiB goes out in parts; the seam holds the process after the first part is synced.
await writer.appendMessages([frame(2, Number(frameMiB) * 1024 * 1024)]);
await writer.close({ checkpoint: false });
`;

const heldWriters = new Set<HeldWriter>();
const spawnedChildren = new Set<ChildProcess>();
const inProcessHolds: { marker: string; flush: Promise<unknown>; close?: () => Promise<void> }[] =
  [];

export type HeldWriter = { child: ChildProcess; marker: string; exited: Promise<number | null> };

/**
 * A REAL writer process, ALIVE and holding the stream lock, held between part 1 and part 2 of frame 2
 * (2.5 MiB) by the hold seam. Remove `marker` and it finishes its line and closes; SIGKILL it and it is a
 * writer dead mid-line.
 */
export async function startWriterHeldMidLine(
  homeDir: string,
  id: string,
  frameMiB = 2.5,
): Promise<HeldWriter> {
  const marker = path.join(homeDir, `${id}.hold-marker`);
  const here = import.meta.url;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      WRITER_SOURCE,
      new URL("../src/session/events.js", here).href,
      new URL("../src/session/persistence.js", here).href,
      id,
      String(frameMiB),
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ACPX_TEST_STREAM_HOLD_MID_LINE: marker },
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(marker)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      assert.fail(`the writer child never reached the hold (exit=${child.exitCode}): ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  heldWriters.add({ child, marker, exited });
  return { child, marker, exited };
}

export async function killAndWait(held: HeldWriter): Promise<void> {
  assert.equal(held.child.kill("SIGKILL"), true, "the writer is killed");
  await held.exited;
}

/**
 * Removes the hold marker every time the writer writes it again (the seam holds after EACH part but the
 * last: a 2.5 MiB frame holds twice) until `settled` resolves.
 */
export async function releaseUntil(marker: string, settled: Promise<unknown>): Promise<void> {
  const state = { done: false };
  const finished = settled.finally(() => {
    state.done = true;
  });
  while (!state.done) {
    fs.rmSync(marker, { force: true });
    await Promise.race([
      finished.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 20)),
    ]);
  }
  await finished;
}

/** Lets the held writer finish its line (and close), and waits for it to exit cleanly. */
export async function releaseAndWait(held: HeldWriter): Promise<void> {
  await releaseUntil(held.marker, held.exited);
  assert.equal(await held.exited, 0, "the released writer finished its line and exited 0");
}

/** A dead writer: frame 1 is a whole line, frame 2 a PARTIAL line (no newline), and its lock file is left behind. */
export async function leaveDeadWriterMidLine(homeDir: string, id: string): Promise<void> {
  await seedRecord(homeDir, id);
  const held = await startWriterHeldMidLine(homeDir, id);
  await killAndWait(held);
}

/** Runs `run` against a REAL SessionQueueOwner for `sessionId` and submits one prompt to it over its socket. */
export async function submitThroughRealOwner(
  sessionId: string,
  requestId: string,
  messageId: string,
  run: () => Promise<void>,
): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(sessionId);
  assert(lease);
  const owner = await SessionQueueOwner.start(lease, {
    cancelPrompt: async () => false,
    closeSession: async () => false,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
    setDepth: async (requested: string): Promise<DepthProjection> => ({
      kind: "send-nothing",
      requested,
    }),
    queryActiveTurn: () => false,
  });
  try {
    const socket = await connectSocket(lease.socketPath);
    const lines = readline.createInterface({ input: socket });
    const iterator = lines[Symbol.asyncIterator]();
    socket.write(
      `${JSON.stringify({
        type: "submit_prompt",
        requestId,
        ownerGeneration: lease.ownerGeneration,
        messageId,
        message: "hello",
        permissionMode: "approve-reads",
        waitForCompletion: false,
      })}\n`,
    );
    const accepted = (await nextJsonLine(iterator)) as { type: string };
    assert.equal(accepted.type, "accepted");
    lines.close();
    socket.destroy();
    await run();
  } finally {
    await owner.close();
    await releaseQueueOwnerLease(lease);
  }
}

export async function waitFor(what: string, ok: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Runs a script in a separate node process (no test context unless `env` adds it) and returns its stdout. */
export async function runChild(
  source: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  spawnedChildren.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { stdout, stderr, code };
}

/** Registers a writer of THIS process that sits in the hold seam, so `releaseAllHeld` can let it go. */
export function holdInProcess(
  marker: string,
  flush: Promise<unknown>,
  close?: () => Promise<void>,
): void {
  inProcessHolds.push({ marker, flush, ...(close ? { close } : {}) });
}

/**
 * L-A: run after EVERY row (`afterEach`). A row that fails an assertion while a writer is held (a real
 * process in the seam, or one of this process holding the stream lock) must not leave it there: a held
 * writer makes every later row wait out the lock, so a regression would HANG the gate instead of reddening it.
 */
export async function releaseAllHeld(): Promise<void> {
  for (const held of heldWriters) {
    if (held.child.exitCode === null && held.child.signalCode === null) {
      held.child.kill("SIGKILL");
    }
    await held.exited;
  }
  heldWriters.clear();
  for (const child of spawnedChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  spawnedChildren.clear();
  for (const hold of inProcessHolds.splice(0)) {
    await Promise.race([
      releaseUntil(hold.marker, hold.flush).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    await hold.close?.().catch(() => {});
  }
}

export function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of names) {
    delete env[name];
  }
  return env;
}

/**
 * Lets the held writer's line GROW: removes the hold marker every `everyMs` (one more part each time)
 * until `stop()` says so. Returns the loop's promise; the writer finishes its frame on its own after.
 */
export async function growEvery(
  held: HeldWriter,
  everyMs: number,
  stop: () => boolean,
): Promise<void> {
  while (!stop() && held.child.exitCode === null) {
    fs.rmSync(held.marker, { force: true });
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
