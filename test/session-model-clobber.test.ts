import assert from "node:assert/strict";
import test from "node:test";
import { resolvePinnedModelForPersist } from "../src/session/persistence/model-merge.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

type PersistenceModule = typeof import("../src/session/persistence.js");

async function loadPersistence(): Promise<PersistenceModule> {
  return await import("../src/session/persistence.js");
}

function pinnedRecord(id: string, model: string): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "agent",
    cwd: "/tmp/model-clobber",
    acpx: { session_options: { model }, current_model_id: model },
  });
}

// ---------------------------------------------------------------------------
// Pure resolver — the deterministic core of the fix.
// ---------------------------------------------------------------------------

test("resolvePinnedModelForPersist adopts the on-disk pin when the writer dropped the model", () => {
  // The clobber shape: a reconnect synced the adapter default and lost the
  // desired model, so the in-memory pin is absent. It must NOT win.
  assert.equal(
    resolvePinnedModelForPersist({
      inMemory: undefined,
      baseline: "claude-fable-5",
      onDisk: "claude-fable-5",
    }),
    "claude-fable-5",
  );
});

test("resolvePinnedModelForPersist keeps the pin when unchanged from baseline", () => {
  assert.equal(
    resolvePinnedModelForPersist({
      inMemory: "claude-fable-5",
      baseline: "claude-fable-5",
      onDisk: "claude-fable-5",
    }),
    "claude-fable-5",
  );
});

test("resolvePinnedModelForPersist adopts a newer on-disk pin an unchanged writer never touched", () => {
  assert.equal(
    resolvePinnedModelForPersist({
      inMemory: "claude-fable-5",
      baseline: "claude-fable-5",
      onDisk: "claude-opus-4-8",
    }),
    "claude-opus-4-8",
  );
});

test("resolvePinnedModelForPersist lets a deliberate change win over the on-disk pin", () => {
  assert.equal(
    resolvePinnedModelForPersist({
      inMemory: "claude-opus-4-8",
      baseline: "claude-fable-5",
      onDisk: "claude-fable-5",
    }),
    "claude-opus-4-8",
  );
});

test("resolvePinnedModelForPersist self-heals when disk has already lost the pin", () => {
  // A healthy writer still holds the pin (in-memory === baseline), but disk was
  // clobbered to absent by a pre-fix write. The write must restore the pin, not
  // propagate the loss.
  assert.equal(
    resolvePinnedModelForPersist({
      inMemory: "claude-fable-5",
      baseline: "claude-fable-5",
      onDisk: undefined,
    }),
    "claude-fable-5",
  );
});

test("resolvePinnedModelForPersist leaves an unpinned session unpinned", () => {
  assert.equal(
    resolvePinnedModelForPersist({ inMemory: undefined, baseline: undefined, onDisk: undefined }),
    undefined,
  );
});

test("resolvePinnedModelForPersist treats a first-ever pin as a deliberate change", () => {
  assert.equal(
    resolvePinnedModelForPersist({
      inMemory: "claude-fable-5",
      baseline: undefined,
      onDisk: undefined,
    }),
    "claude-fable-5",
  );
});

// ---------------------------------------------------------------------------
// Integration through the real persistence write path. Each of these is RED
// pre-fix (the write clobbered the pin) and GREEN post-fix.
// ---------------------------------------------------------------------------

test("concurrent stale writer cannot clobber a pinned model (red pre-fix / green post-fix)", async () => {
  await withTempHome("acpx-model-clobber-", async () => {
    const persistence = await loadPersistence();

    // Record pinned to fable on disk.
    await persistence.writeSessionRecord(pinnedRecord("clobber-1", "claude-fable-5"));

    // Writer B reads the pinned record (captures baseline = fable).
    const staleWriter = await persistence.resolveSessionRecord("clobber-1");

    // Writer A (external) meanwhile re-persists the same pin → on-disk stays fable.
    await persistence.writeSessionRecord(await persistence.resolveSessionRecord("clobber-1"));

    // Writer B now looks like a reconnect that synced the adapter default and
    // dropped the desired model: current_model_id="default", session_options.model gone.
    staleWriter.acpx = staleWriter.acpx ?? {};
    staleWriter.acpx.current_model_id = "default";
    if (staleWriter.acpx.session_options) {
      delete staleWriter.acpx.session_options.model;
    }
    await persistence.writeSessionRecord(staleWriter);

    const onDisk = await persistence.resolveSessionRecord("clobber-1");
    assert.equal(onDisk.acpx?.session_options?.model, "claude-fable-5");
    assert.equal(onDisk.acpx?.current_model_id, "claude-fable-5");
  });
});

test("current_model_id is realigned to the pin even when session_options.model survived", async () => {
  await withTempHome("acpx-model-current-", async () => {
    const persistence = await loadPersistence();

    await persistence.writeSessionRecord(pinnedRecord("current-1", "claude-fable-5"));

    // A reconnect advertised the box default without dropping the desired model:
    // session_options.model still fable, but current_model_id transiently "default".
    const writer = await persistence.resolveSessionRecord("current-1");
    writer.acpx = writer.acpx ?? {};
    writer.acpx.current_model_id = "default";
    await persistence.writeSessionRecord(writer);

    const onDisk = await persistence.resolveSessionRecord("current-1");
    assert.equal(onDisk.acpx?.session_options?.model, "claude-fable-5");
    assert.equal(onDisk.acpx?.current_model_id, "claude-fable-5");
  });
});

test("a deliberate model change still wins over the on-disk pin", async () => {
  await withTempHome("acpx-model-change-", async () => {
    const persistence = await loadPersistence();

    await persistence.writeSessionRecord(pinnedRecord("change-1", "claude-fable-5"));

    const writer = await persistence.resolveSessionRecord("change-1"); // baseline fable
    writer.acpx = writer.acpx ?? {};
    writer.acpx.session_options = { ...writer.acpx.session_options, model: "claude-opus-4-8" };
    writer.acpx.current_model_id = "claude-opus-4-8";
    await persistence.writeSessionRecord(writer);

    const onDisk = await persistence.resolveSessionRecord("change-1");
    assert.equal(onDisk.acpx?.session_options?.model, "claude-opus-4-8");
    assert.equal(onDisk.acpx?.current_model_id, "claude-opus-4-8");
  });
});

test("an unpinned session keeps its other session_options (effort) across writes", async () => {
  // The merge must never call setDesiredModelId(undefined) on an unpinned write,
  // which would drop the whole session_options block — including effort.
  await withTempHome("acpx-model-effort-", async () => {
    const persistence = await loadPersistence();

    const unpinned = makeSessionRecord({
      acpxRecordId: "effort-1",
      acpSessionId: "acp-effort-1",
      agentCommand: "agent",
      cwd: "/tmp/model-clobber",
      acpx: {
        session_options: { effort: "max" },
        desired_config_options: { effort: "max" },
        current_model_id: "default",
      },
    });
    await persistence.writeSessionRecord(unpinned);

    // A subsequent no-op-ish checkpoint write of the resolved record must not
    // drop effort while resolving the (absent) pinned model.
    const writer = await persistence.resolveSessionRecord("effort-1");
    await persistence.writeSessionRecord(writer);

    const onDisk = await persistence.resolveSessionRecord("effort-1");
    assert.equal(onDisk.acpx?.session_options?.effort, "max");
    assert.equal(onDisk.acpx?.session_options?.model, undefined);
  });
});

test("a first-ever pin persists as-is (no baseline to protect against)", async () => {
  await withTempHome("acpx-model-first-", async () => {
    const persistence = await loadPersistence();

    await persistence.writeSessionRecord(pinnedRecord("first-1", "claude-fable-5"));

    const onDisk = await persistence.resolveSessionRecord("first-1");
    assert.equal(onDisk.acpx?.session_options?.model, "claude-fable-5");
    assert.equal(onDisk.acpx?.current_model_id, "claude-fable-5");
  });
});
