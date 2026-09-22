/**
 * A rejected sub-agent boundary record-write must NOT kill the queue-owner
 * process (brick://da3d7c95).
 *
 * WHAT THIS DEFENDS. `createSubagentBoundaryWriteEnqueuer` chains a `.finally()`
 * onto the write promise to drop the chain entry once it settles. `.finally()`
 * returns a NEW promise that inherits the rejection, and the `void` in front of
 * it discards that promise with no handler. acpx installs no
 * `process.on("unhandledRejection")`, so under Node's default
 * `--unhandled-rejections=throw` a single rejected write — `OutboxError
 * ("outbox-busy")` under record-outbox contention — became an uncaught
 * exception that killed the queue owner mid-turn. Nine owners died that way on
 * devbox on 2026-09-22; the call sites' own `.catch(() => {})` on the returned
 * promise does not cover the derived one.
 *
 * ⚠️ THIS MUST RUN IN A CHILD PROCESS, AND THAT IS THE WHOLE POINT. `node --test`
 * installs its own `unhandledRejection` handler, so in-process the fault is
 * downgraded from "the process dies" to "a test is marked failed" — an
 * assertion inside this runner therefore cannot observe the production
 * behaviour at all. The child runs with no handler installed, exactly like a
 * queue owner, and its EXIT CODE is the observable.
 *
 * ⚠️ AND IT MUST IMPORT THE REAL FACTORY, NOT A RE-TYPED COPY OF THE SHAPE. A
 * hand-written replica of the `.then`/`.finally`/`void` chain would pass
 * forever after someone fixed the replica and not the product. The child
 * imports the compiled `src/cli/session/subagent-boundary-write.js` and
 * substitutes only the leaf `write` — which is the one thing that has to be
 * substituted to inject the rejection the outbox raises in production.
 *
 * MUTATION CONTROL. Deleting the trailing `.catch()` from the factory turns
 * `rejecting-write` from exit 0 to exit 1 with `ERR_UNHANDLED_REJECTION`;
 * measured while writing this test. `resolving-write` is the positive control
 * that proves the child harness reaches and exercises the factory at all —
 * without it, an exit 0 from a child that silently failed to import anything
 * would read as a pass.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSubagentBoundaryWriteEnqueuer } from "../src/cli/session/subagent-boundary-write.js";
import type { SessionRecord } from "../src/types.js";

// This file is compiled to `dist-test/test/`; the factory lands at
// `dist-test/src/cli/session/subagent-boundary-write.js`.
const FACTORY_URL = new URL("../src/cli/session/subagent-boundary-write.js", import.meta.url).href;

interface ChildResult {
  status: number | null;
  stderr: string;
}

/**
 * Run the REAL factory in a fresh node process with no `unhandledRejection`
 * handler, enqueue one write, and report how the process ended.
 */
function runChild(mode: "rejecting-write" | "resolving-write"): ChildResult {
  const source = `
    import { createSubagentBoundaryWriteEnqueuer } from ${JSON.stringify(FACTORY_URL)};

    const chains = new Map();
    const enqueue = createSubagentBoundaryWriteEnqueuer({
      chains,
      write: async () => {
        if (${JSON.stringify(mode)} === "rejecting-write") {
          const error = new Error("outbox-busy");
          error.code = "outbox-busy";
          throw error;
        }
      },
      onWriteError: (id, error) => {
        process.stderr.write("onWriteError " + id + " " + String(error && error.message) + "\\n");
      },
    });

    // Exactly what both production call sites do: discard the returned promise
    // behind a .catch(). The derived .finally() promise is the exposure.
    void enqueue("child-record-id", { acpxRecordId: "child-record-id" }).catch(() => {});

    // Give the microtask queue and the unhandled-rejection check time to run.
    // An unhandled rejection is raised on the macrotask turn AFTER the promise
    // settles, so an immediate exit would miss it and report a false pass.
    setTimeout(() => {
      process.stderr.write("chains-size " + chains.size + "\\n");
      process.exit(0);
    }, 200);
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 20_000,
    cwd: path.dirname(fileURLToPath(import.meta.url)),
  });
  return { status: result.status, stderr: result.stderr ?? "" };
}

test("a rejected sub-agent boundary write does not kill the owner process", () => {
  const rejecting = runChild("rejecting-write");

  assert.equal(
    rejecting.status,
    0,
    `owner process died on a rejected record write (exit ${String(rejecting.status)}).\n` +
      `stderr:\n${rejecting.stderr}`,
  );
  assert.ok(
    !/ERR_UNHANDLED_REJECTION|Unhandled|unhandledRejection/.test(rejecting.stderr),
    `child reported an unhandled rejection:\n${rejecting.stderr}`,
  );
  // The failure is surfaced, not swallowed.
  assert.match(rejecting.stderr, /onWriteError child-record-id outbox-busy/);
  // The chain entry is still dropped — the `.finally()` bookkeeping must keep
  // working on the failure path, not just the success path.
  assert.match(rejecting.stderr, /chains-size 0/);
});

test("positive control: the child harness really exercises the factory", () => {
  const resolving = runChild("resolving-write");

  assert.equal(resolving.status, 0, `stderr:\n${resolving.stderr}`);
  assert.match(resolving.stderr, /chains-size 0/);
  // No write failure on this arm, so nothing may be reported.
  assert.ok(
    !/onWriteError/.test(resolving.stderr),
    `a resolving write reported an error:\n${resolving.stderr}`,
  );
});

test("in-process: the returned promise rejects and the chain entry is dropped", async () => {
  const chains = new Map<string, Promise<void>>();
  const seen: unknown[] = [];
  const enqueue = createSubagentBoundaryWriteEnqueuer({
    chains,
    write: async () => {
      throw new Error("outbox-busy");
    },
    onWriteError: (_id, error) => {
      seen.push(error);
    },
  });

  const record = { acpxRecordId: "child-record-id" } as unknown as SessionRecord;
  await assert.rejects(enqueue("child-record-id", record), /outbox-busy/);
  // Let the bookkeeping chain settle.
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(chains.size, 0);
  assert.equal(seen.length, 1);
});

test("writes for one sub-agent stay serialised across a failure", async () => {
  const chains = new Map<string, Promise<void>>();
  const order: string[] = [];
  let call = 0;
  const enqueue = createSubagentBoundaryWriteEnqueuer({
    chains,
    write: async () => {
      call += 1;
      const label = `write-${call}`;
      order.push(`${label}-start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${label}-end`);
      if (call === 1) {
        throw new Error("outbox-busy");
      }
    },
    onWriteError: () => {},
  });

  const record = { acpxRecordId: "child-record-id" } as unknown as SessionRecord;
  const first = enqueue("child-record-id", record).catch(() => {});
  const second = enqueue("child-record-id", record).catch(() => {});
  await Promise.all([first, second]);

  // The second write starts only after the first has finished failing.
  assert.deepEqual(order, ["write-1-start", "write-1-end", "write-2-start", "write-2-end"]);
});
