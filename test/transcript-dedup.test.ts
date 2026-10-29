import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyExitBlock,
  proveRedundantAndUnlink,
  readExitTailFile,
  reduceToExitTail,
  removeRedundantCopy,
  type DedupTraceEvent,
} from "../src/config/transcript-dedup.js";
import {
  conversation,
  exists,
  exitLine,
  jsonl,
  queueOperationLine,
  SESSION_A,
  sha256File,
  writeFileAt,
} from "./transcript-fixture-test-helpers.js";

// Matrix A of brick 81433524's TEST-PLAN: the two proof primitives. Every positive
// (a file removed or reduced) sits beside the negatives that must keep a file, so a
// remover that does nothing fails here as surely as one that removes too much.

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-dedup-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** P (the shared body), and two copies: `witness` = P + more turns, `candidate` per test. */
function body() {
  const p = conversation(SESSION_A, { pairs: 16 });
  const more = conversation(SESSION_A, {
    pairs: 3,
    seed: "later",
    startMinute: 100,
    parent: p.lastUuid,
  });
  return { p, pText: jsonl(p.lines), moreText: jsonl(more.lines) };
}

function counter() {
  const events: DedupTraceEvent[] = [];
  const bytesRead = () =>
    events.reduce((sum, event) => sum + (event.kind === "read" ? event.bytes : 0), 0);
  return { events, bytesRead, trace: (event: DedupTraceEvent) => events.push(event) };
}

/** A child that opens `file` with `flag` and holds it until killed. */
async function holdOpen(file: string, flag: "a" | "r"): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fd=require('node:fs').openSync(process.argv[1], process.argv[2]); process.stdout.write('ready'); setInterval(()=>{}, 1000);`,
      file,
      flag,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("error", reject);
  });
  return child;
}

async function killChild(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

test("A1: a byte-prefix copy is removed and the witness is byte-identical", async () => {
  await withDir(async (dir) => {
    const { pText, moreText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText + moreText);
    const candidate = await writeFileAt(path.join(dir, `${SESSION_A}.jsonl`), pText);
    const before = await sha256File(witness);
    const outcome = await proveRedundantAndUnlink(candidate, witness, { allowEqual: false });
    assert.equal(outcome.action, "removed");
    assert.equal(outcome.action === "removed" && outcome.bytes, Buffer.byteLength(pText));
    assert.equal(await exists(candidate), false);
    assert.equal(await sha256File(witness), before);
  });
});

test("A2 / S11: a copy with ONE unique trailing byte is kept, byte-identical", async () => {
  await withDir(async (dir) => {
    const { pText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), `${pText}x`);
    const before = await sha256File(candidate);
    const outcome = await proveRedundantAndUnlink(candidate, witness, { allowEqual: true });
    assert.deepEqual(outcome, { action: "kept", reason: "longer-than-witness" });
    assert.equal(await sha256File(candidate), before);
    // And the exit-tail reduction refuses it too: a lone byte is not an exit block.
    const reduced = await reduceToExitTail(candidate, witness, { reducedBy: "transcripts-dedup" });
    assert.deepEqual(reduced, { action: "kept", reason: "tail-not-exit-block:partial" });
    assert.equal(await sha256File(candidate), before);
    assert.deepEqual(
      (await fs.readdir(dir)).toSorted(),
      ["c.jsonl", "w.jsonl"],
      "no tail file may be left behind",
    );
  });
});

test("equal copies: removed only with allowEqual", async () => {
  await withDir(async (dir) => {
    const { pText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), pText);
    assert.deepEqual(await proveRedundantAndUnlink(candidate, witness, { allowEqual: false }), {
      action: "kept",
      reason: "equal-not-allowed",
    });
    const outcome = await proveRedundantAndUnlink(candidate, witness, { allowEqual: true });
    assert.equal(outcome.action, "removed");
  });
});

test("A3: a divergent last 64 KiB is rejected WITHOUT a full read", async () => {
  await withDir(async (dir) => {
    const big = "y".repeat(3 * 1024 * 1024);
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), `${big}AAAA\n${big}`);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), `${big}BBBB\n`);
    const reads = counter();
    const outcome = await proveRedundantAndUnlink(candidate, witness, {
      allowEqual: true,
      hooks: { trace: reads.trace },
    });
    assert.deepEqual(outcome, { action: "kept", reason: "divergent-tail" });
    assert.ok(reads.bytesRead() <= 2 * 64 * 1024, `read ${reads.bytesRead()} bytes`);
    assert.equal(await exists(candidate), true);
  });
});

test("A4: a difference at byte 1 with matching tails is found by the full compare", async () => {
  await withDir(async (dir) => {
    const tail = "z".repeat(2 * 1024 * 1024);
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), `aa${tail}more`);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), `ab${tail}`);
    const outcome = await proveRedundantAndUnlink(candidate, witness, { allowEqual: true });
    assert.deepEqual(outcome, { action: "kept", reason: "divergent-at:1" });
    assert.equal(await exists(candidate), true);
  });
});

test("A5: a process holding the candidate open for WRITING keeps it", async () => {
  await withDir(async (dir) => {
    const { pText, moreText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText + moreText);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), pText);
    const writer = await holdOpen(candidate, "a");
    try {
      const outcome = await proveRedundantAndUnlink(candidate, witness, { allowEqual: true });
      assert.deepEqual(outcome, { action: "kept", reason: "writer-holds-open" });
      assert.equal(await exists(candidate), true);
    } finally {
      await killChild(writer);
    }
  });
});

test("A6: a READER does not block the removal", async () => {
  await withDir(async (dir) => {
    const { pText, moreText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText + moreText);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), pText);
    const reader = await holdOpen(candidate, "r");
    try {
      const outcome = await proveRedundantAndUnlink(candidate, witness, { allowEqual: true });
      assert.equal(outcome.action, "removed");
    } finally {
      await killChild(reader);
    }
  });
});

test("A7: a file renamed onto the candidate's path before the unlink is NOT removed", async () => {
  await withDir(async (dir) => {
    const { pText, moreText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText + moreText);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), pText);
    const intruder = await writeFileAt(path.join(dir, "intruder"), "a different file\n");
    const outcome = await proveRedundantAndUnlink(candidate, witness, {
      allowEqual: true,
      hooks: { beforeRecheck: async () => await fs.rename(intruder, candidate) },
    });
    assert.deepEqual(outcome, { action: "kept", reason: "path-replaced" });
    assert.equal(await fs.readFile(candidate, "utf8"), "a different file\n");
  });
});

test("A8: an append during the verify keeps the candidate", async () => {
  await withDir(async (dir) => {
    const { pText, moreText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText + moreText);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), pText);
    const outcome = await proveRedundantAndUnlink(candidate, witness, {
      allowEqual: true,
      hooks: { beforeRecheck: async () => await fs.appendFile(candidate, "late line\n") },
    });
    assert.deepEqual(outcome, { action: "kept", reason: "changed-during-verify" });
    assert.equal(await exists(candidate), true);
  });
});

test("A9: /proc unavailable fails closed", async () => {
  await withDir(async (dir) => {
    const { pText, moreText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText + moreText);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), pText);
    const outcome = await proveRedundantAndUnlink(candidate, witness, {
      allowEqual: true,
      hooks: { procRoot: path.join(dir, "no-such-proc") },
    });
    assert.deepEqual(outcome, { action: "kept", reason: "no-proc" });
    const reduced = await reduceToExitTail(candidate, witness, {
      reducedBy: "transcripts-dedup",
      hooks: { procRoot: path.join(dir, "no-such-proc") },
    });
    assert.equal(reduced.action, "kept");
    assert.equal(await exists(candidate), true);
  });
});

test("the witness itself, a missing witness and a symlink are never proofs", async () => {
  await withDir(async (dir) => {
    const { pText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText);
    const link = path.join(dir, "hard.jsonl");
    await fs.link(witness, link);
    assert.deepEqual(await proveRedundantAndUnlink(link, witness, { allowEqual: true }), {
      action: "kept",
      reason: "same-file",
    });
    const missing = path.join(dir, "missing.jsonl");
    assert.deepEqual(await proveRedundantAndUnlink(link, missing, { allowEqual: true }), {
      action: "kept",
      reason: "witness-missing",
    });
    const symlink = path.join(dir, "sym.jsonl");
    await fs.symlink(witness, symlink);
    assert.deepEqual(await proveRedundantAndUnlink(symlink, witness, { allowEqual: true }), {
      action: "kept",
      reason: "not-regular",
    });
    assert.equal(await exists(witness), true);
    assert.equal(await exists(link), true);
  });
});

test("A17: the witness is fdatasync'ed BEFORE the candidate is unlinked", async () => {
  await withDir(async (dir) => {
    const { pText, moreText } = body();
    const witness = await writeFileAt(path.join(dir, "w.jsonl"), pText + moreText);
    const candidate = await writeFileAt(path.join(dir, "c.jsonl"), pText);
    const order = counter();
    await proveRedundantAndUnlink(candidate, witness, {
      allowEqual: true,
      hooks: { trace: order.trace },
    });
    const kinds = order.events.map((event) => event.kind).filter((kind) => kind !== "read");
    assert.deepEqual(kinds, ["witness-datasync", "unlink"]);
  });
});

/** S4b: left-behind = P + {cost-state, last-prompt}; active = P + newer turns. */
async function s4bPair(dir: string) {
  const { p, pText, moreText } = body();
  const block = jsonl([
    exitLine("cost-state", SESSION_A, p.lastUuid),
    exitLine("last-prompt", SESSION_A, p.lastUuid),
  ]);
  const witness = await writeFileAt(path.join(dir, "subB", `${SESSION_A}.jsonl`), pText + moreText);
  const candidate = await writeFileAt(path.join(dir, "subA", `${SESSION_A}.jsonl`), pText + block);
  return { p, pText, block, witness, candidate };
}

test("A10 (T): an exit-tail copy is reduced to a tail file with the full header", async () => {
  await withDir(async (dir) => {
    const { pText, block, witness, candidate } = await s4bPair(dir);
    const originalSha = await sha256File(candidate);
    const originalStat = await fs.stat(candidate);
    const outcome = await reduceToExitTail(candidate, witness, { reducedBy: "owner-exit" });
    assert.equal(outcome.action, "reduced", JSON.stringify(outcome));
    if (outcome.action !== "reduced") {
      return;
    }
    assert.equal(await exists(candidate), false);
    assert.equal(path.dirname(outcome.tailFile), path.dirname(candidate));
    assert.match(
      path.basename(outcome.tailFile),
      new RegExp(
        `^${SESSION_A}\\.exit-tail-\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d\\.\\d{3}Z\\.acpx$`,
      ),
    );
    assert.equal((await fs.stat(outcome.tailFile)).mode & 0o777, 0o600);
    const raw = await fs.readFile(outcome.tailFile);
    const newline = raw.indexOf(0x0a);
    const header = JSON.parse(raw.subarray(0, newline).toString()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(header), [
      "acpx_exit_tail",
      "session_id",
      "original_path",
      "original_size",
      "original_mtime_ms",
      "original_sha256",
      "prefix_bytes",
      "prefix_sha256",
      "tail_bytes",
      "tail_sha256",
      "witness_path",
      "witness_size",
      "reduced_at",
      "reduced_by",
      "acpx_version",
    ]);
    assert.equal(header.session_id, SESSION_A);
    assert.equal(header.original_path, candidate);
    assert.equal(header.original_size, originalStat.size);
    assert.equal(header.original_mtime_ms, Math.floor(originalStat.mtimeMs));
    assert.equal(header.original_sha256, originalSha);
    assert.equal(header.prefix_bytes, Buffer.byteLength(pText));
    const witnessBytes = await fs.readFile(witness);
    const prefixSha = createHash("sha256")
      .update(witnessBytes.subarray(0, Buffer.byteLength(pText)))
      .digest("hex");
    assert.equal(header.prefix_sha256, prefixSha);
    assert.equal(header.tail_bytes, Buffer.byteLength(block));
    assert.equal(header.witness_path, witness);
    assert.equal(header.reduced_by, "owner-exit");
    assert.equal(raw.subarray(newline + 1).toString(), block, "the tail is T, verbatim");
    const parsed = await readExitTailFile(outcome.tailFile);
    assert.equal(parsed.tail.toString(), block);
  });
});

test("A15 (T): a tail that is not an exit block is never reduced and leaves no tail file", async () => {
  const { p } = body();
  const leaf = p.lastUuid;
  const cases: Array<[string, string, string]> = [
    [
      "queue-operation",
      jsonl([exitLine("last-prompt", SESSION_A, leaf), queueOperationLine(SESSION_A, 500)]),
      "tail-not-exit-block:timestamp",
    ],
    [
      "uuid line",
      jsonl([JSON.stringify({ type: "last-prompt", uuid: "u-1", sessionId: SESSION_A })]),
      "tail-not-exit-block:uuid",
    ],
    [
      "timestamp line",
      jsonl([JSON.stringify({ type: "mode", timestamp: "2026-10-01T00:00:00Z" })]),
      "tail-not-exit-block:timestamp",
    ],
    [
      "unknown type",
      jsonl([JSON.stringify({ type: "worktree-state", sessionId: SESSION_A })]),
      "tail-not-exit-block:type",
    ],
    [
      "partial last line",
      `${exitLine("last-prompt", SESSION_A, leaf)}\n{"type":"cost-st`,
      "tail-not-exit-block:partial",
    ],
    [
      "65 KiB tail",
      jsonl(
        Array.from({ length: 70 }, () =>
          JSON.stringify({ type: "ai-title", aiTitle: "t".repeat(1000), sessionId: SESSION_A }),
        ),
      ),
      "tail-not-exit-block:too-big",
    ],
  ];
  for (const [label, block, reason] of cases) {
    await withDir(async (dir) => {
      const { pText, moreText } = body();
      const witness = await writeFileAt(path.join(dir, "subB", "w.jsonl"), pText + moreText);
      const candidate = await writeFileAt(
        path.join(dir, "subA", `${SESSION_A}.jsonl`),
        pText + block,
      );
      const before = await sha256File(candidate);
      const { outcome } = await removeRedundantCopy(candidate, witness, {
        reducedBy: "transcripts-dedup",
      });
      assert.deepEqual(outcome, { action: "kept", reason }, label);
      assert.equal(await sha256File(candidate), before, label);
      assert.deepEqual(await fs.readdir(path.join(dir, "subA")), [`${SESSION_A}.jsonl`], label);
    });
  }
});

test("S8: a real conversation branch is kept by both proofs", async () => {
  await withDir(async (dir) => {
    const { p, pText, moreText } = body();
    const branch = conversation(SESSION_A, {
      pairs: 2,
      seed: "branch",
      startMinute: 60,
      parent: p.lastUuid,
    });
    const witness = await writeFileAt(path.join(dir, "subB", "w.jsonl"), pText + moreText);
    const candidate = await writeFileAt(
      path.join(dir, "subA", `${SESSION_A}.jsonl`),
      pText + jsonl(branch.lines),
    );
    const before = await sha256File(candidate);
    const { outcome, reasons } = await removeRedundantCopy(candidate, witness, {
      reducedBy: "port",
    });
    assert.equal(outcome.action, "kept");
    assert.ok(reasons[0]?.startsWith("divergent-"), reasons.join(","));
    assert.equal(reasons[1], "tail-not-exit-block:uuid");
    assert.equal(await sha256File(candidate), before);
  });
});

test("A16 (T): a crash after the tail file is durable keeps the copy; the rerun reuses the file", async () => {
  await withDir(async (dir) => {
    const { witness, candidate } = await s4bPair(dir);
    const before = await sha256File(candidate);
    const crashed = await reduceToExitTail(candidate, witness, {
      reducedBy: "transcripts-dedup",
      hooks: {
        afterTailFileWritten: () => {
          throw Object.assign(new Error("injected crash"), { code: "EINJECTED" });
        },
      },
    });
    assert.deepEqual(crashed, { action: "kept", reason: "tail-file-failed:EINJECTED" });
    assert.equal(await sha256File(candidate), before, "the copy is intact");
    const tailFiles = (await fs.readdir(path.dirname(candidate))).filter((n) =>
      n.endsWith(".acpx"),
    );
    assert.equal(tailFiles.length, 1);

    const rerun = await reduceToExitTail(candidate, witness, { reducedBy: "transcripts-dedup" });
    assert.equal(rerun.action, "reduced");
    assert.equal(rerun.action === "reduced" && rerun.reusedTailFile, true);
    const after = (await fs.readdir(path.dirname(candidate))).filter((n) => n.endsWith(".acpx"));
    assert.deepEqual(after, tailFiles, "no second tail file");
  });
});

test("the reduction refuses an append during the verify", async () => {
  await withDir(async (dir) => {
    const { witness, candidate } = await s4bPair(dir);
    const outcome = await reduceToExitTail(candidate, witness, {
      reducedBy: "transcripts-dedup",
      hooks: { beforeRecheck: async () => await fs.appendFile(candidate, "{}\n") },
    });
    assert.deepEqual(outcome, { action: "kept", reason: "changed-during-verify" });
    assert.equal(await exists(candidate), true);
  });
});

test("classifyExitBlock accepts exactly the measured exit-block shapes", () => {
  const leaf = "leaf-uuid";
  const ok = (lines: string[]) => classifyExitBlock(Buffer.from(jsonl(lines)));
  assert.equal(ok([exitLine("last-prompt", SESSION_A, leaf)]), undefined);
  assert.equal(ok([exitLine("cost-state", SESSION_A, leaf)]), undefined);
  assert.equal(
    ok([
      exitLine("last-prompt", SESSION_A, leaf),
      exitLine("ai-title", SESSION_A, leaf),
      exitLine("mode", SESSION_A, leaf),
      exitLine("atis-latch", SESSION_A, leaf),
      exitLine("cost-state", SESSION_A, leaf),
    ]),
    undefined,
  );
  assert.equal(classifyExitBlock(Buffer.alloc(0)), "empty");
  assert.equal(classifyExitBlock(Buffer.from("not json\n")), "not-json");
  assert.equal(classifyExitBlock(Buffer.from("[1]\n")), "not-json");
});
