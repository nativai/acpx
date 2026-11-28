// P1 (brick e9f71106, the authority's ruling row (a)): a Pi owner that cannot write the box's Pi session store
// does NOT start. It used to: `resolvePiSessionDir` swallowed the mkdir failure, `writePiConfigDir` deleted
// `PI_CODING_AGENT_SESSION_DIR`, and pi wrote its JSONL into the per-session `/tmp/acpx-pi-<id>` dir, which in
// ANY pod (home or pool) dies with the pod: a lost transcript nobody is told about.
//
// The row the test-engineer holds (sub-HoD, 2026-11-28): the owner does not start; nothing is written outside the
// box's store; the delivery ends not delivered under PI_SESSION_STORE_UNWRITABLE; the sender is told; no new
// conversation exists afterwards. Each `assert` below names which clause it holds.
//
// ⚠️ THE UNWRITABLE STORE IS THE POOL POD'S SHAPE: the directory EXISTS (a read-only view of the control's
// `runtime/pi-home`), so `mkdirSync({recursive:true})` SUCCEEDS on it. A check of existence alone passes there —
// which is why the first rows make the cwd folder exist and read-only. Runs as uid 1000 on the workbench; a root
// run cannot be denied, and the `EACCES` match below is what proves the lever bit.

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { QUEUE_TURN_START_FAILED_DETAIL_CODE } from "../src/cli/queue/delivery-terminals.js";
import {
  releaseQueueOwnerLease,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import {
  PI_SESSION_STORE_UNWRITABLE_DETAIL_CODE,
  PiSessionStoreUnwritableError,
} from "../src/errors.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { listSessionEvents } from "../src/session/events.js";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import { connectSocket, nextJsonLine } from "./queue-test-helpers.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

/** pi's own cwd mangling (pi 0.84.4), kept independent of the source. */
function mangled(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** A box agent dir whose `sessions/<cwd>` folder EXISTS and is read-only — the pool pod's view before P1. */
function readOnlyStore(root: string, cwd: string): { box: string; target: string } {
  const box = path.join(root, "box-agent");
  const target = path.join(box, "sessions", mangled(cwd));
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o555);
  chmodSync(path.join(box, "sessions"), 0o555);
  return { box, target };
}

function unlock(box: string, target: string): void {
  chmodSync(path.join(box, "sessions"), 0o755);
  chmodSync(target, 0o755);
}

// ─── unit: the config-dir writer ─────────────────────────────────────────────────────────────────────────────

test("P1 (a) unit: an EXISTING but read-only store is refused by name — env untouched, no per-session dir", async () => {
  await withTempHome("acpx-p1a-unit-ro-", async (home) => {
    const cwd = path.join(home, "work");
    mkdirSync(cwd, { recursive: true });
    const { box, target } = readOnlyStore(home, cwd);
    const inherited = path.join(home, "acpx-pi-parent", "sessions", "--parent--");
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      ACPX_PI_BOX_AGENT_DIR: box,
      PI_CODING_AGENT_SESSION_DIR: inherited,
    };
    const rootDir = path.join(home, "cfg-root");
    mkdirSync(rootDir, { recursive: true });
    try {
      assert.throws(
        () =>
          applyHarnessConfigDir({
            env,
            agentCommand: AGENT_REGISTRY.pi,
            sessionId: "ses-ro",
            primer: "P",
            cwd,
            rootDir,
          }),
        (error: unknown) => {
          assert.ok(error instanceof PiSessionStoreUnwritableError, String(error));
          assert.equal(error.detailCode, PI_SESSION_STORE_UNWRITABLE_DETAIL_CODE);
          assert.equal(error.sessionDir, target);
          assert.match(error.message, /^PI_SESSION_STORE_UNWRITABLE: /);
          assert.match(error.message, /EACCES/, "the write probe, not mkdir, refused it");
          return true;
        },
      );
    } finally {
      unlock(box, target);
    }
    // The old leg DELETED this; refusing must leave the env exactly as it was handed in.
    assert.equal(
      env.PI_CODING_AGENT_SESSION_DIR,
      inherited,
      "PI_CODING_AGENT_SESSION_DIR was unset",
    );
    assert.equal(env.PI_CODING_AGENT_DIR, undefined, "PI_CODING_AGENT_DIR was re-pointed");
    assert.deepEqual(readdirSync(rootDir), [], "a per-session config dir was created");
    assert.deepEqual(readdirSync(target), [], "the write probe was left behind");
  });
});

test("P1 (a) unit: a store that cannot be CREATED (a file where a folder must be) is refused by name", async () => {
  await withTempHome("acpx-p1a-unit-notdir-", async (home) => {
    const cwd = path.join(home, "work");
    mkdirSync(cwd, { recursive: true });
    const box = path.join(home, "box-agent");
    mkdirSync(box, { recursive: true });
    writeFileSync(path.join(box, "sessions"), "not a folder");
    const rootDir = path.join(home, "cfg-root");
    mkdirSync(rootDir, { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home, ACPX_PI_BOX_AGENT_DIR: box };
    assert.throws(
      () =>
        applyHarnessConfigDir({
          env,
          agentCommand: AGENT_REGISTRY.pi,
          sessionId: "ses-notdir",
          primer: "P",
          cwd,
          rootDir,
        }),
      PiSessionStoreUnwritableError,
    );
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, undefined);
    assert.deepEqual(readdirSync(rootDir), []);
  });
});

test("P1 (a) unit, positive control: a writable store still yields the box session dir and leaves no probe file", async () => {
  await withTempHome("acpx-p1a-unit-ok-", async (home) => {
    const cwd = path.join(home, "work");
    mkdirSync(cwd, { recursive: true });
    const box = path.join(home, "box-agent");
    mkdirSync(box, { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home, ACPX_PI_BOX_AGENT_DIR: box };
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: AGENT_REGISTRY.pi,
      sessionId: "ses-ok",
      primer: "P",
      cwd,
      rootDir: path.join(home, "cfg-root"),
    });
    const target = path.join(box, "sessions", mangled(cwd));
    assert.equal(plan?.sessionDir, target);
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, target);
    assert.deepEqual(readdirSync(target), [], "the write probe was left behind");
  });
});

// ─── the real owner path: a real SessionQueueOwner, an accepted no-wait task (acpx-ui's shape), a REAL AcpClient ──

const MESSAGE_ID = "e9f71106-0000-4000-8000-00000000000a";

type DeliveryParams = {
  messageId: string;
  phase: string;
  error?: { message: string; detailCode: string };
};

async function eventsOf(sessionId: string, method: string): Promise<DeliveryParams[]> {
  return (await listSessionEvents(sessionId))
    .filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { method?: unknown }).method === method,
    )
    .map((event) => (event as { params: DeliveryParams }).params)
    .filter((params) => params.messageId === MESSAGE_ID);
}

async function waitForReceivedMarker(sessionId: string, requestId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const text = await fs.readFile(sessionEventActivePath(sessionId), "utf8").catch(() => "");
    if (
      text.split("\n").some((line) => line.includes("acpx/received") && line.includes(requestId))
    ) {
      return;
    }
    assert(Date.now() < deadline, `the acpx/received marker for ${requestId} never reached disk`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function withEnv<T>(over: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(over).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return run().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

// The refusal reads NO placement fact: it holds in every process that starts a Pi owner. The rows run with each
// placement fact an agent pod carries (and none, the control/legacy shape), so a future change that made it
// pool-only — the authority's binding point: home pods lose the per-session folder too — goes red on `home`.
for (const placement of [undefined, "home", "pool"] as const) {
  test(`P1 (a) real owner path, placement=${placement ?? "none"}: the Pi owner does not start; nothing is written outside the box store; the delivery ends not delivered under PI_SESSION_STORE_UNWRITABLE; the sender is told; no new conversation`, async () => {
    await withTempHome(`acpx-p1a-owner-${placement ?? "none"}-`, async (home) => {
      const cwd = path.join(home, "work");
      mkdirSync(cwd, { recursive: true });
      const { box, target } = readOnlyStore(home, cwd);
      // A stand-in pi adapter. If acpx ever spawns it, it leaves this marker and exits — "the owner did not start"
      // is the marker's absence, and the row can never hang on a real pi.
      const marker = path.join(home, "pi-adapter-started");
      const adapter = path.join(home, "fake", "pi-acp", "dist", "index.js");
      mkdirSync(path.dirname(adapter), { recursive: true });
      writeFileSync(adapter, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
      const sessionId = `p1a-${placement ?? "none"}-session`;
      const acpSessionId = `acp-${sessionId}`;
      await writeSessionRecord(
        makeSessionRecord({
          acpxRecordId: sessionId,
          acpSessionId,
          agentCommand: `node ${adapter}`,
          cwd,
        }),
      );
      const lease = await tryAcquireQueueOwnerLease(sessionId);
      assert(lease);
      const owner = await SessionQueueOwner.start(lease, {
        cancelPrompt: async () => false,
        closeSession: async () => true,
        setSessionMode: async () => {},
        setSessionModel: async () => {},
        setSessionConfigOption: async () => ({ configOptions: [] }),
        setDepth: async (requested: string): Promise<DepthProjection> => ({
          kind: "send-nothing",
          requested,
        }),
        queryActiveTurn: () => false,
      });
      const socket = await connectSocket(lease.socketPath);
      const lines = readline.createInterface({ input: socket });
      try {
        const requestId = `${sessionId}-request`;
        socket.write(
          `${JSON.stringify({
            type: "submit_prompt",
            requestId,
            ownerGeneration: lease.ownerGeneration,
            messageId: MESSAGE_ID,
            message: "hello pi",
            permissionMode: "approve-all",
            waitForCompletion: false,
          })}\n`,
        );
        const accepted = (await nextJsonLine(lines[Symbol.asyncIterator]())) as { type: string };
        assert.equal(accepted.type, "accepted");
        await waitForReceivedMarker(sessionId, requestId);
        const task = await owner.nextBatch().then((batch) => batch?.[0]);
        assert(task);
        await withEnv(
          { ACPX_PI_BOX_AGENT_DIR: box, NV_AGENT_PLACEMENT: placement },
          async () =>
            await runQueuedTask(sessionId, [task], { suppressSdkConsoleErrors: true }).catch(
              () => undefined,
            ),
        );
      } finally {
        lines.close();
        socket.destroy();
        await owner.close();
        await releaseQueueOwnerLease(lease);
        unlock(box, target);
      }

      // The owner does not start.
      assert.equal(existsSync(marker), false, "the pi adapter was spawned");
      // Nothing is written outside the box's store: no per-session dir in the isolated root nor in the real tmp.
      const isolatedRoot = process.env.ACPX_HARNESS_CONFIG_DIR_ROOT;
      assert.ok(isolatedRoot, "the temp home isolates the config-dir root");
      const strays = (dir: string) =>
        readdirSync(dir).filter((name) => name.startsWith("acpx-pi-") && name.includes(sessionId));
      assert.deepEqual(strays(isolatedRoot), [], "a /tmp/acpx-pi-<id> dir was created");
      assert.deepEqual(strays(tmpdir()), [], "a /tmp/acpx-pi-<id> dir was created in the real tmp");
      assert.deepEqual(readdirSync(target), [], "something was written into the refused store");
      // The delivery ends not delivered, under the named code.
      const failed = await eventsOf(sessionId, "acpx/delivery");
      assert.equal(failed.length, 1, `exactly one terminal; got ${JSON.stringify(failed)}`);
      assert.equal(failed[0]?.phase, "failed");
      assert.equal(failed[0]?.error?.detailCode, QUEUE_TURN_START_FAILED_DETAIL_CODE);
      assert.match(
        failed[0]?.error?.message ?? "",
        /PiSessionStoreUnwritableError: PI_SESSION_STORE_UNWRITABLE: .*EACCES/,
      );
      // The sender is told: that terminal is the cross-repo contract's turn-start row, which atrium classifies
      // not delivered / resend-safe / definitive and NOTIFIES THE SENDER for (vendored byte-identical in acpx-ui).
      const contract = JSON.parse(
        readFileSync(path.join("test", "fixtures", "delivery-contract.fixture.json"), "utf8"),
      ) as { turnStartTerminals: Array<Record<string, unknown>> };
      const row = contract.turnStartTerminals.find(
        (entry) => entry.detailCode === failed[0]?.error?.detailCode,
      );
      assert.equal(row?.notifiesSender, true, "the terminal's code does not notify the sender");
      assert.equal(row?.reachedModel, "no");
      assert.equal(row?.resendSafe, true);
      // No new conversation: the record still names the original ACP session, and no turn was recorded.
      const after = await resolveSessionRecord(sessionId);
      assert.equal(after.acpSessionId, acpSessionId, "a new conversation replaced the session");
      assert.equal(after.messages.length, 0, "a turn was recorded");
    });
  });
}
