import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_STDERR_CAP_BYTES,
  AGENT_STDERR_PREFIX,
  AgentStderrTee,
} from "../src/acp/agent-stderr-tee.js";
import { AcpClient } from "../src/acp/client.js";

// brick 7c06a855 — a queue owner keeps a bounded copy of its adapter's stderr in
// `<id>.owner.log`. On 2026-10-10 codex-acp died 8× mid-turn with exit 1 and the
// owner log held only "agent exit observed: code=1"; the stack Node printed on
// the adapter's stderr was discarded (acpx forwarded it only under --verbose).

const ADAPTER_PATH = fileURLToPath(new URL("./fixtures/stderr-crash-adapter.js", import.meta.url));
// Mirrors the fixture's constant (importing the fixture would run it).
const CRASH_MARKER = "Error: stderr-crash-adapter boom";
const TRUNCATED_LINE = "[acpx] agent stderr truncated after 256 KB";

function collect(cap?: number, tail?: number): { tee: AgentStderrTee; out: () => string } {
  let text = "";
  const tee = new AgentStderrTee((chunk) => (text += chunk), cap, tail);
  return { tee, out: () => text };
}

test("tee prefixes every line and reassembles a line split across chunks", () => {
  const { tee, out } = collect();
  tee.push("first line\nsecond ");
  tee.push(Buffer.from("half\nthird"));
  assert.equal(out(), "[agent-stderr] first line\n[agent-stderr] second half\n");
  tee.end();
  assert.equal(out().endsWith("[agent-stderr] third\n"), true, "partial line flushed at end");
});

test("tee reassembles a multi-byte character split across chunks", () => {
  const { tee, out } = collect();
  const euro = Buffer.from("€\n", "utf8");
  tee.push(euro.subarray(0, 1));
  tee.push(euro.subarray(1));
  assert.equal(out(), "[agent-stderr] €\n");
  assert.equal(out().includes("�"), false);
});

test("tee stops at the cap with ONE truncation line, and stays silent after it", () => {
  const { tee, out } = collect(64, 16);
  tee.push(`${"a".repeat(40)}\n${"b".repeat(40)}\n`);
  tee.push("Z".repeat(500));
  tee.push("more\n");
  tee.end();
  const text = out();
  assert.equal(text.split("[acpx] agent stderr truncated").length - 1, 1);
  assert.equal(text.includes("Z"), false, "nothing past the cap was teed");
  // 64 bytes teed: line a (41) + 23 bytes of line b, flushed as a partial line.
  assert.equal(
    text,
    `[agent-stderr] ${"a".repeat(40)}\n[agent-stderr] ${"b".repeat(23)}\n[acpx] agent stderr truncated after 64 bytes\n`,
  );
});

test("tee writes EXACTLY the cap without a truncation line when nothing exceeds it", () => {
  const { tee, out } = collect(8, 4);
  tee.push("1234567\n");
  tee.noteUnexpectedExit();
  tee.end();
  assert.equal(out(), "[agent-stderr] 1234567\n");
});

test("tail after the cap is written once, only for an unexpected exit, after the stream ends", () => {
  const { tee, out } = collect(16, 12);
  tee.push("x".repeat(100));
  tee.push("\nboom here\n");
  const beforeEnd = out();
  tee.noteUnexpectedExit();
  assert.equal(out(), beforeEnd, "no tail before the stream has drained");
  tee.end();
  tee.noteUnexpectedExit();
  tee.end();
  const tailPart = out().slice(beforeEnd.length);
  assert.equal(
    tailPart,
    "[acpx] agent stderr tail (last 12 of 111 bytes) after unexpected exit:\n[agent-stderr] x\n[agent-stderr] boom here\n",
  );
});

test("negative: a truncated stream that ends WITHOUT an unexpected exit writes no tail", () => {
  const { tee, out } = collect(16, 12);
  tee.push("y".repeat(100));
  tee.end();
  assert.equal(out().includes("tail"), false);
});

test("a throwing sink never escapes the tee", () => {
  const tee = new AgentStderrTee(
    () => {
      throw new Error("EPIPE");
    },
    4,
    4,
  );
  assert.doesNotThrow(() => {
    tee.push("line\nmore than the cap");
    tee.noteUnexpectedExit();
    tee.end();
  });
});

// ---- Real child process as the adapter ---------------------------------------

// Stands in for the owner's stderr fd (= owner.log): swallow and record writes.
async function captureStderr<T>(
  run: (stderr: () => string) => Promise<T>,
): Promise<{ value: T; log: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await run(() => captured), log: captured };
  } finally {
    process.stderr.write = original;
  }
}

/** Run one prompt against the crashing adapter; return what reached "owner.log". */
async function crashMidPrompt(options: {
  fillerBytes: number;
  ownerLog: boolean;
  verbose?: boolean;
}): Promise<{ log: string; error: unknown }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-agent-stderr-"));
  const savedGate = process.env.ACPX_OWNER_LOG;
  if (options.ownerLog) {
    process.env.ACPX_OWNER_LOG = "1";
  } else {
    delete process.env.ACPX_OWNER_LOG;
  }
  const client = new AcpClient({
    agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(ADAPTER_PATH)} ${options.fillerBytes}`,
    cwd,
    permissionMode: "approve-all",
    verbose: options.verbose,
  });
  try {
    const { value: error, log } = await captureStderr(async (stderr) => {
      try {
        await client.start();
        const { sessionId } = await client.createSession(cwd);
        const failure = await client.prompt(sessionId, "crash").then(
          () => undefined,
          (caught: unknown) => caught,
        );
        // The stderr stream drains after the disconnect is observed; wait for the
        // crash frame (or, in the negative rows, a bounded quiet period).
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !stderr().includes("handlePrompt")) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return failure;
      } finally {
        await client.close();
      }
    });
    return { log, error };
  } finally {
    if (savedGate === undefined) {
      delete process.env.ACPX_OWNER_LOG;
    } else {
      process.env.ACPX_OWNER_LOG = savedGate;
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function agentLines(log: string): string[] {
  return log.split("\n").filter((line) => line.startsWith(AGENT_STDERR_PREFIX));
}

test("owner log: a crashing adapter's stderr lands prefixed, split lines reassembled", async () => {
  const { log, error } = await crashMidPrompt({ fillerBytes: 0, ownerLog: true });
  assert.ok(error, "control: the prompt must fail — the adapter exited mid-prompt");
  assert.match(log, /\[acpx\] agent disconnect: .*unexpectedDuringPrompt=true/);
  const lines = new Set(agentLines(log));
  assert.ok(lines.has(`${AGENT_STDERR_PREFIX}startup noise before the crash`), log);
  assert.ok(lines.has(`${AGENT_STDERR_PREFIX}split line, first half / second half`), log);
  assert.ok(lines.has(`${AGENT_STDERR_PREFIX}multi-byte: €`), log);
  assert.ok(lines.has(`${AGENT_STDERR_PREFIX}${CRASH_MARKER}`), log);
  assert.equal(log.includes("truncated"), false, "a small stream is never truncated");
  assert.equal(log.includes("agent stderr tail"), false, "no tail without truncation");
});

test("owner log: past 256 KB one truncation line, then the last 8 KB after the crash", async () => {
  const { log, error } = await crashMidPrompt({ fillerBytes: 300 * 1024, ownerLog: true });
  assert.ok(error, "control: the prompt must fail — the adapter exited mid-prompt");
  assert.equal(log.split(TRUNCATED_LINE).length - 1, 1, "exactly one truncation line");
  const truncatedAt = log.indexOf(TRUNCATED_LINE);
  const tailAt = log.indexOf("[acpx] agent stderr tail (last 8192 of ");
  assert.ok(tailAt > truncatedAt, "the tail follows the truncation line");
  // Bounded: everything teed before the cap is at most the cap (plus prefixes).
  const teedBytes = agentLines(log.slice(0, truncatedAt)).reduce(
    (sum, line) => sum + Buffer.byteLength(line.slice(AGENT_STDERR_PREFIX.length)) + 1,
    0,
  );
  assert.ok(teedBytes <= AGENT_STDERR_CAP_BYTES + 1, `teed ${teedBytes} bytes`);
  assert.ok(teedBytes >= AGENT_STDERR_CAP_BYTES - 1, `teed ${teedBytes} bytes`);
  assert.ok(
    log.indexOf(`${AGENT_STDERR_PREFIX}${CRASH_MARKER}`, tailAt) > tailAt,
    "crash stack is in the tail",
  );
  assert.ok(log.indexOf("handlePrompt", tailAt) > tailAt, "crash frame is in the tail");
  assert.equal(
    log.slice(0, truncatedAt).includes(CRASH_MARKER),
    false,
    "the stack lay past the cap",
  );
});

test("negative: outside the owner-log gate nothing of the adapter's stderr is written", async () => {
  const { log, error } = await crashMidPrompt({ fillerBytes: 300 * 1024, ownerLog: false });
  assert.ok(error, "control: the prompt must fail — the adapter exited mid-prompt");
  assert.equal(agentLines(log).length, 0);
  assert.equal(log.includes(CRASH_MARKER), false);
  assert.equal(log.includes("[acpx] agent"), false, "no truncation, tail or disconnect line");
});

test("--verbose keeps forwarding raw stderr, without the owner-log prefix or cap", async () => {
  const { log } = await crashMidPrompt({ fillerBytes: 0, ownerLog: true, verbose: true });
  assert.ok(log.includes(`\n${CRASH_MARKER}\n`) || log.startsWith(CRASH_MARKER), log);
  assert.equal(agentLines(log).length, 0, "verbose output is not double-teed");
});
