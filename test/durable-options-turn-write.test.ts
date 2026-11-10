/**
 * A durable option set while a turn starts must survive the turn's own record writes
 * (brick://34f5f588).
 *
 * `recordPromptStart` assigned the `record.acpx` it had cloned when the turn loaded the record
 * and wrote it; `writeSessionRecordAtBoundary` did not overlay the latest durable options (only
 * the live checkpoint merged them). An `acpx set outputStyle` accepted between the load and that
 * write — the one verb accepted while a turn is active — was put back to the OLD value, and
 * every later turn and owner kept it (lost 4/16 on dev be2b3860).
 *
 * The window is held open deterministically: the test holds `<id>.json.lock` (an unjudgeable
 * body is waited on, never broken, inside 15 s), so the turn's record write parks AFTER it
 * loaded the record; the set is then planted on disk and the lock released.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import type { SessionRecord } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  INJECTED_PROMPT_TEXT,
  MAIN_PROMPT_TEXT,
  createDeferred,
  makePathologicalClient,
} from "./pathological-adapter-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

type PersistenceModule = typeof import("../src/session/persistence.js");

async function loadPersistence(): Promise<PersistenceModule> {
  return await import("../src/session/persistence.js");
}

const MAIN = "main-0000-4000-8000-000000000000";
const INJ = "45143e51-0000-4000-8000-000000000001";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function styledRecord(id: string, cwd: string): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: CLAUDE_AGENT_COMMAND,
    cwd,
    acpx: {
      desired_mode_id: "default",
      desired_config_options: { outputStyle: "Old", effort: "high", other: "keep" },
      session_options: { output_style: "Old", effort: "high", auto_failover: true },
    },
  });
}

/** What `acpx set outputStyle <style>` and `acpx set effort <effort>` leave on disk. */
type RawRecord = {
  acpx: {
    desired_mode_id?: string;
    desired_config_options: Record<string, string>;
    session_options: Record<string, unknown>;
  };
};

async function plantSets(file: string, style: string, effort: string): Promise<void> {
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as RawRecord;
  raw.acpx.desired_config_options.outputStyle = style;
  raw.acpx.session_options.output_style = style;
  raw.acpx.desired_config_options.effort = effort;
  raw.acpx.session_options.effort = effort;
  await fs.writeFile(file, `${JSON.stringify(raw)}\n`, "utf8");
}

async function readRaw(file: string): Promise<RawRecord> {
  return JSON.parse(await fs.readFile(file, "utf8")) as RawRecord;
}

function assertSetsSurvived(raw: RawRecord, style: string, effort: string): void {
  assert.equal(raw.acpx.session_options.output_style, style);
  assert.equal(raw.acpx.desired_config_options.outputStyle, style);
  assert.equal(raw.acpx.session_options.effort, effort);
  assert.equal(raw.acpx.desired_config_options.effort, effort);
  // Options nobody set mid-turn are untouched.
  assert.equal(raw.acpx.session_options.auto_failover, true);
  assert.equal(raw.acpx.desired_config_options.other, "keep");
  assert.equal(raw.acpx.desired_mode_id, "default");
}

// ---------------------------------------------------------------------------
// The writer (`writeSessionRecordInternal`), exercised the way the turn exercises it.
// ---------------------------------------------------------------------------

test("a set landing between load and a boundary write survives it, for output style AND another option", async () => {
  await withTempHome("acpx-34f5f588-writer-", async (homeDir) => {
    const persistence = await loadPersistence();
    const record = styledRecord("w-1", homeDir);
    await writeSessionRecordFile(homeDir, record);

    // The turn loads the record and clones its acpx state (runSessionPrompt: `acpxState`) …
    const turnRecord = await persistence.resolveSessionRecord("w-1");
    const acpxState = structuredClone(turnRecord.acpx);
    // … `acpx set outputStyle` / `set effort` are accepted …
    await plantSets(sessionFilePath(homeDir, "w-1"), "New", "low");
    // … and recordPromptStart writes the clone back through a boundary write.
    turnRecord.acpx = acpxState;
    await persistence.writeSessionRecordAtBoundary(turnRecord);

    assertSetsSurvived(await readRaw(sessionFilePath(homeDir, "w-1")), "New", "low");
    // The turn keeps carrying the merged value (its later checkpoints write from this object).
    assert.equal(acpxState?.session_options?.output_style, "New");
    assert.equal(
      turnRecord.acpx,
      acpxState,
      "merged in place: the turn's own reference is current",
    );
  });
});

test("the plain (checkpoint) write path and the privileged lifecycle path are covered too", async () => {
  await withTempHome("acpx-34f5f588-paths-", async (homeDir) => {
    const persistence = await loadPersistence();
    await writeSessionRecordFile(homeDir, styledRecord("p-1", homeDir));
    await writeSessionRecordFile(homeDir, styledRecord("p-2", homeDir));

    const plain = await persistence.resolveSessionRecord("p-1");
    const privileged = await persistence.resolveSessionRecord("p-2");
    await plantSets(sessionFilePath(homeDir, "p-1"), "New", "low");
    await plantSets(sessionFilePath(homeDir, "p-2"), "New", "low");

    await persistence.writeSessionRecord(plain);
    await persistence.writeSessionRecordWithLifecycle(privileged);

    assertSetsSurvived(await readRaw(sessionFilePath(homeDir, "p-1")), "New", "low");
    assertSetsSurvived(await readRaw(sessionFilePath(homeDir, "p-2")), "New", "low");
  });
});

test("desired mode and a policy toggle set mid-turn survive too", async () => {
  await withTempHome("acpx-34f5f588-mode-", async (homeDir) => {
    const persistence = await loadPersistence();
    await writeSessionRecordFile(homeDir, styledRecord("m-1", homeDir));
    const turnRecord = await persistence.resolveSessionRecord("m-1");

    const file = sessionFilePath(homeDir, "m-1");
    const raw = await readRaw(file);
    raw.acpx.desired_mode_id = "plan";
    raw.acpx.session_options.auto_failover = false;
    await fs.writeFile(file, `${JSON.stringify(raw)}\n`, "utf8");

    await persistence.writeSessionRecordAtBoundary(turnRecord);

    const after = await readRaw(file);
    assert.equal(after.acpx.desired_mode_id, "plan");
    assert.equal(after.acpx.session_options.auto_failover, false);
  });
});

test("a deliberate change by the writer still wins over the disk value", async () => {
  await withTempHome("acpx-34f5f588-deliberate-", async (homeDir) => {
    const persistence = await loadPersistence();
    await writeSessionRecordFile(homeDir, styledRecord("d-1", homeDir));
    const writer = await persistence.resolveSessionRecord("d-1");

    await plantSets(sessionFilePath(homeDir, "d-1"), "Disk", "low");
    // The writer itself is `acpx set outputStyle Mine` — and has NOT touched effort.
    writer.acpx = {
      ...writer.acpx,
      desired_config_options: { ...writer.acpx?.desired_config_options, outputStyle: "Mine" },
      session_options: { ...writer.acpx?.session_options, output_style: "Mine" },
    };
    await persistence.writeSessionRecord(writer);

    const after = await readRaw(sessionFilePath(homeDir, "d-1"));
    assert.equal(after.acpx.session_options.output_style, "Mine");
    assert.equal(after.acpx.desired_config_options.outputStyle, "Mine");
    // effort was not the writer's change: the disk value is adopted.
    assert.equal(after.acpx.session_options.effort, "low");
  });
});

test("a record that never went through a parse or a write is persisted verbatim", async () => {
  await withTempHome("acpx-34f5f588-fresh-", async (homeDir) => {
    const persistence = await loadPersistence();
    await writeSessionRecordFile(homeDir, styledRecord("f-1", homeDir));
    await plantSets(sessionFilePath(homeDir, "f-1"), "Disk", "low");

    const fresh = styledRecord("f-1", homeDir); // no baseline
    fresh.acpx = { ...fresh.acpx, session_options: { output_style: "Fresh" } };
    await persistence.writeSessionRecord(fresh);

    assert.equal(
      (await readRaw(sessionFilePath(homeDir, "f-1"))).acpx.session_options.output_style,
      "Fresh",
    );
  });
});

test("an option absent on disk is not adopted (the checkpoint merge never cleared either)", async () => {
  await withTempHome("acpx-34f5f588-absent-", async (homeDir) => {
    const persistence = await loadPersistence();
    await writeSessionRecordFile(homeDir, styledRecord("a-1", homeDir));
    const writer = await persistence.resolveSessionRecord("a-1");

    const file = sessionFilePath(homeDir, "a-1");
    const raw = await readRaw(file);
    delete raw.acpx.session_options.output_style;
    delete raw.acpx.desired_config_options.outputStyle;
    await fs.writeFile(file, `${JSON.stringify(raw)}\n`, "utf8");
    await persistence.writeSessionRecord(writer);

    assert.equal((await readRaw(file)).acpx.session_options.output_style, "Old");
  });
});

// ---------------------------------------------------------------------------
// The real turn: runQueuedTask, with the set planted while the prompt-start write is parked.
// ---------------------------------------------------------------------------

function makeTask(
  requestId: string,
  text: string,
  messageId: string,
  send: (message: QueueOwnerMessage) => void = () => {},
): QueueTask {
  return {
    requestId,
    messageId,
    message: text,
    prompt: textPrompt(text),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send,
    close: () => {},
  } satisfies QueueTask;
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function logHas(logPath: string, messageId: string): Promise<boolean> {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  return text.includes(messageId);
}

test("a set accepted while the turn's prompt-start write is parked is the value the record holds after the turn", async () => {
  await withTempHome("acpx-34f5f588-turn-", async (homeDir) => {
    const record = styledRecord("t-1", homeDir);
    await writeSessionRecordFile(homeDir, record);
    const file = sessionFilePath(homeDir, record.acpxRecordId);
    const logPath = path.join(
      path.dirname(file),
      `${encodeURIComponent(record.acpxRecordId)}.messages.ndjson`,
    );

    const control = makePathologicalClient({ acpSessionId: record.acpSessionId });
    const lockPath = `${file}.lock`;
    await fs.writeFile(lockPath, "{}");
    const run = runQueuedTask(record.acpxRecordId, [makeTask("req-main", MAIN_PROMPT_TEXT, MAIN)], {
      sharedClient: control.client,
      suppressSdkConsoleErrors: true,
    });

    // The turn loaded the record and appended its User entry to the log; its record write is
    // now parked on the lock — the window `acpx set` lands in.
    await waitFor(async () => await logHas(logPath, MAIN), "the prompt-start log append");
    await plantSets(file, "New", "low");
    await fs.rm(lockPath, { force: true });

    await control.mainPromptInFlight;
    control.resolveMainPrompt({ stopReason: "end_turn" });
    await run;

    assertSetsSurvived(await readRaw(file), "New", "low");
  });
});

test("the same for an injected prompt's own prompt-start write", async () => {
  await withTempHome("acpx-34f5f588-inject-", async (homeDir) => {
    const record = styledRecord("i-1", homeDir);
    await writeSessionRecordFile(homeDir, record);
    const file = sessionFilePath(homeDir, record.acpxRecordId);
    const logPath = path.join(
      path.dirname(file),
      `${encodeURIComponent(record.acpxRecordId)}.messages.ndjson`,
    );

    const injectedInFlight = createDeferred<void>();
    const injectedRelease = createDeferred<{ stopReason: "end_turn" }>();
    const control = makePathologicalClient({
      acpSessionId: record.acpSessionId,
      onInjectedPrompt: async () => {
        injectedInFlight.resolve();
        return await injectedRelease.promise;
      },
    });
    let midTurnHandler: ((injected: QueueTask[]) => void) | undefined;
    const handlerRegistered = createDeferred<void>();
    const run = runQueuedTask(record.acpxRecordId, [makeTask("req-main", MAIN_PROMPT_TEXT, MAIN)], {
      sharedClient: control.client,
      setMidTurnHandler: (handler) => {
        midTurnHandler = handler;
        if (handler) {
          handlerRegistered.resolve();
        }
      },
      suppressSdkConsoleErrors: true,
    });
    await control.mainPromptInFlight;
    await handlerRegistered.promise;
    await sleep(100);

    const lockPath = `${file}.lock`;
    await fs.writeFile(lockPath, "{}");
    midTurnHandler?.([makeTask("req-inj", INJECTED_PROMPT_TEXT, INJ)]);
    await waitFor(async () => await logHas(logPath, INJ), "the injection's log append");
    await plantSets(file, "New", "low");
    await fs.rm(lockPath, { force: true });
    await injectedInFlight.promise;

    control.resolveMainPrompt({ stopReason: "end_turn" });
    injectedRelease.resolve({ stopReason: "end_turn" });
    await run;

    assertSetsSurvived(await readRaw(file), "New", "low");
  });
});
