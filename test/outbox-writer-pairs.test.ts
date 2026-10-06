import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeSessionRecord } from "../src/session/persistence.js";
import type { SessionMessage } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

/**
 * SAME-RECORD WRITER PAIRS ACROSS PROCESSES (brick eb4c8d06).
 *
 * Ordinary session writes no longer go through the outbox's box-wide lock; two processes writing
 * the SAME record are ordered by the repository's per-record lock file and its read-merge-rename
 * rules. Each
 * row runs a live owner checkpointing 20 records back to back in one process and, in a second
 * process, one op per record; after the owner has rewritten that record twice more, the op's
 * effect must still be on disk. A missing effect is a LOST UPDATE.
 *
 * Non-vacuity: every op must complete without error, and the owner must really rewrite the record
 * twice after it (the worker reports `owner-stalled` otherwise). `observedWithOp` (the op seen on
 * disk right after it landed) is reported, not asserted: an op clobbered before that read is
 * itself a lost update, and is counted as one.
 */

const WORKER = new URL("./fixtures/writer-pair-worker.js", import.meta.url).pathname;
const RECORDS = 20;

function messages(count: number): SessionMessage[] {
  return Array.from({ length: count }, (_u, i) => ({
    Agent: { content: [{ Text: `seed ${i} ${"x".repeat(200)}` }], tool_results: {} },
  })) as SessionMessage[];
}

type PairResult = {
  kind: string;
  ops: number;
  observedWithOp: number;
  lost: number;
  lostRecords: string[];
  opErrors: Record<string, number>;
};

async function runPair(kind: string): Promise<{ pair: PairResult; ownerErrors: object }> {
  return await withTempHome(`acpx-writer-pair-${kind}-`, async (home) => {
    for (let i = 0; i < RECORDS; i++) {
      await writeSessionRecord(
        makeSessionRecord({
          acpxRecordId: `pair-record-${i}`,
          acpSessionId: `acp-pair-record-${i}`,
          agentCommand: "agent",
          cwd: home,
          messages: messages(50),
        }),
      );
    }
    await writeSessionRecord(
      makeSessionRecord({
        acpxRecordId: "pair-parent",
        acpSessionId: "acp-pair-parent",
        agentCommand: "agent",
        cwd: home,
      }),
    );
    const dir = fs.mkdtempSync(path.join(home, "pair-"));
    const env = { ...process.env, HOME: home, ACPX_STATE_HOME: home };
    const owner = spawn(process.execPath, [WORKER, "owner", dir, String(RECORDS)], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const ownerExit = new Promise<number | null>((resolve) => owner.once("exit", resolve));
    let ownerStderr = "";
    owner.stderr.on("data", (chunk: Buffer) => (ownerStderr += chunk.toString()));
    try {
      const pairProc = spawn(process.execPath, [WORKER, "pair", dir, kind, String(RECORDS)], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      pairProc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      pairProc.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => pairProc.once("exit", resolve));
      assert.equal(code, 0, `pair worker failed (${code}): ${err}`);
      const pair = JSON.parse(out.trim().split("\n").pop() ?? "{}") as PairResult;
      fs.writeFileSync(path.join(dir, "stop"), "1");
      assert.equal(await ownerExit, 0, `owner worker failed: ${ownerStderr}`);
      const ownerErrors = (
        JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")) as { errors: object }
      ).errors;
      return { pair, ownerErrors };
    } finally {
      fs.writeFileSync(path.join(dir, "stop"), "1");
      if (owner.exitCode === null) {
        await ownerExit;
      }
    }
  });
}

/**
 * MEASURED LOST UPDATES (lost / 20 ops per run; devbox workbench, load1 ~40-75, 2026-10-05):
 *
 *   pair          main      spawn-only  integrate  + re-read      + record lock
 *                 79fe7835  0b60de85    29c98145   before rename  (this tree)
 *   writer        0, 0      6, 4, 4     8          4, 3, 2        0, 0, 0
 *   close         8, 6      4, 1, 8     1          4, 4, 4        0, 0, 0
 *   set-parent    3, 2      2, 1, 3     4          3, 4, 1        0, 0, 0
 *   ui-lifecycle  9, 9      13, 8, 13   10         3, 0, 2        1, 4, 1
 *
 * The first three are HARD rows: every writer in them goes through `writeSessionRecordInternal`,
 * which re-reads right before its rename and holds the record's lock file across read -> rename
 * (brick eb4c8d06). Remove either and these rows go red.
 *
 * 🛑 `ui-lifecycle` stays `todo`, and that is not this repo's bug to hide: it models acpx-ui's
 * own raw tmp + rename of favourite / name / metadata, which does NOT take the record lock. Until
 * acpx-ui takes the same `<record>.json.lock` (protocol in `record-file-lock.ts`) a live owner's
 * checkpoint can still overwrite an acpx-ui lifecycle edit landing inside its read -> rename.
 */
const KNOWN_LOSSES: Record<string, string | undefined> = {
  "ui-lifecycle":
    "acpx-ui's raw write does not take the record lock yet: 1-4/20 lost with the lock in acpx",
};

for (const kind of ["writer", "close", "set-parent", "ui-lifecycle"]) {
  test(
    `writer pair · owner checkpoint vs ${kind}: no lost update, no refusal`,
    { todo: KNOWN_LOSSES[kind] },
    async (t) => {
      const { pair, ownerErrors } = await runPair(kind);
      const summary = JSON.stringify({ pair, ownerErrors });
      t.diagnostic(`writer-pair ${kind} lost=${pair.lost}/${pair.ops} ${summary}`);
      assert.deepEqual(pair.opErrors, {}, `the ${kind} writer was refused or stalled: ${summary}`);
      assert.deepEqual(ownerErrors, {}, `the owner checkpoint was refused: ${summary}`);
      assert.equal(pair.lost, 0, `LOST UPDATES: ${summary}`);
    },
  );
}
