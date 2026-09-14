import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrickOutbox, type DiskRecord } from "../../src/brick-outbox.js";
import { createFileSessionStore } from "../../src/runtime/public/file-session-store.js";
import { parseSessionRecord } from "../../src/session/persistence/parse.js";
import { writeSessionRecordWithLifecycle } from "../../src/session/persistence/repository.js";

assert.ok(os.homedir().startsWith("/workspace/bricksdb-b14-selftest/"));
const outbox = new BrickOutbox();
const instance = "i-111111111111";
const mode = process.argv[2] ?? "bound";
fs.writeFileSync(
  path.join(os.homedir(), ".acpx", "instance.json"),
  JSON.stringify({ instance_id: instance, home: os.homedir() }),
);
if (mode === "bound" || mode === "alias") {
  outbox.bindIdentity({
    instance_id: instance,
    box: "fixture",
    public_base_url: "https://example.invalid",
  });
}
const id = mode === "opaque" ? "legacy/adapter:record" : "11111111-1111-4111-8111-111111111111";
const brick = "22222222-2222-4222-8222-222222222222";
const raw: DiskRecord = {
  schema: "acpx.session.v1",
  kind: "session",
  acpx_record_id: id,
  acp_session_id: "adapter-id",
  agent_command: "codex",
  agent_name: "codex",
  cwd: os.homedir(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_used_at: new Date().toISOString(),
  last_seq: 0,
  messages: [],
  metadata: { brick },
  closed: false,
};
let operations = 0;
try {
  outbox.saveRecord(raw);
  let stateDir = path.join(os.homedir(), ".acpx");
  if (mode === "alias") {
    stateDir = path.join(os.homedir(), "alias");
    fs.mkdirSync(stateDir);
    fs.symlinkSync(outbox.sessionsDir, path.join(stateDir, "sessions"));
  }
  const store = createFileSessionStore({ stateDir });
  const current = await store.load(id);
  assert.ok(current);
  current.name = "positive writer control";
  const save =
    mode === "repository" || mode === "state-home"
      ? writeSessionRecordWithLifecycle
      : store.save.bind(store);
  await save(current);
  operations++;
  process.stdout.write(`${JSON.stringify({ actors: 1, operation: "positive-write-completed" })}\n`);
  assert.equal(outbox.readRecord(id)?.name, "positive writer control");
  const stale = parseSessionRecord({ ...raw, metadata: {}, name: "stale writer" });
  assert.ok(stale);
  outbox.setDrain("public-writer-control");
  let refused = false;
  try {
    await save(stale);
  } catch (error) {
    refused = (error as { code?: string }).code === "maintenance";
    if (!refused) {throw error;}
  }
  operations++;
  const observed = outbox.readRecord(id);
  process.stdout.write(
    `${JSON.stringify({ mode, actors: 1, operations, refused, name: observed?.name, metadata: observed?.metadata })}\n`,
  );
  assert.equal(
    refused,
    true,
    "a metadata-dropped writer must still consult the active outbox drain",
  );
  assert.equal(observed?.name, "positive writer control");
  assert.equal(observed?.metadata?.brick, brick);
  if (mode === "state-home") {
    process.env.ACPX_STATE_HOME = path.join(os.homedir(), "alternate-state-home");
    await writeSessionRecordWithLifecycle(stale);
    const alternate = createFileSessionStore({
      stateDir: path.join(process.env.ACPX_STATE_HOME, ".acpx"),
    });
    assert.equal((await alternate.load(id))?.name, "stale writer");
    assert.equal(
      outbox.readRecord(id)?.name,
      "positive writer control",
      "state-home writes must not be redirected into HOME",
    );
    delete process.env.ACPX_STATE_HOME;
  }
  const separate = createFileSessionStore({ stateDir: path.join(os.homedir(), "independent") });
  await separate.save(stale);
  assert.equal(
    (await separate.load(id))?.name,
    "stale writer",
    "a genuinely non-overlapping custom store is not the canonical writer",
  );
  assert.equal(outbox.readRecord(id)?.name, "positive writer control");
} finally {
  outbox.close();
  if (operations === 0) {
    process.stderr.write("EXAMINED NOTHING\n");
    process.exit(2);
  }
}
