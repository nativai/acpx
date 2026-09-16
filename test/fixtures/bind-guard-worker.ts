/**
 * Bind-authorisation probe (brick 42b4fb28) — one scenario per invocation, in a scratch HOME.
 *
 * This file is deliberately source-only (`--import tsx`, importing `src/`), so the SAME file can
 * be run against a PRE-GUARD checkout to produce the red arm. Every scenario prints one
 * `OBS <json>` line naming what the outbox meta actually holds afterwards; the caller asserts on
 * that, never on this process's exit code — the 2026-09-15 outage was invisible to a test verdict
 * precisely because the poisoning moved nothing about the exit code (brick 507a1c38).
 *
 * Usage: HOME=<scratch> node --import tsx test/fixtures/bind-guard-worker.ts <scenario>
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BrickOutbox, type DiskRecord } from "../../src/brick-outbox.js";

const SCRATCH_ROOT = "/workspace/bind-guard-probe";

// 🛑 NEVER RUN AGAINST THE BOX'S REAL HOME. devbox's control-plane outbox carries production's own
// live binding and a real daemon writes to it; the workbench is foreign-bound deliberately.
assert.ok(
  os.homedir().startsWith(`${SCRATCH_ROOT}/`),
  `refusing to run outside ${SCRATCH_ROOT}: HOME resolved to ${os.homedir()}`,
);

/** The fixture identity that actually poisoned devbox on 2026-09-15 (brick 507a1c38). */
const FIXTURE = {
  instance_id: "i-twin0000001",
  box: "f32-twin",
  public_base_url: "https://fixture.invalid",
};
const LOCAL_INSTANCE = "i-aaaaaaaaaaaa";
const RECORD_ID = "11111111-1111-4111-8111-111111111111";
const BRICK_ID = "22222222-2222-4222-8222-222222222222";

function mintInstanceRecord(instanceId = LOCAL_INSTANCE): void {
  const dir = path.join(os.homedir(), ".acpx");
  fs.mkdirSync(dir, { recursive: true });
  // The shape acpx-ui's openOrMintInstanceRecord writes: the id plus the HOME it is bound to.
  fs.writeFileSync(
    path.join(dir, "instance.json"),
    JSON.stringify({
      instance_id: instanceId,
      created_at: new Date().toISOString(),
      home: os.homedir(),
      machine_id: "f".repeat(64),
    }),
  );
}

/** Read the identity rows back with an INDEPENDENT connection — never through the class. */
function metaRows(dbPath: string): Record<string, string | null> {
  const db = new DatabaseSync(dbPath);
  try {
    const read = (key: string): string | null => {
      const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
      return row ? String(row.value) : null;
    };
    return {
      instance_id: read("instance_id"),
      projection_identity: read("projection_identity"),
      schema_version: read("schema_version"),
    };
  } finally {
    db.close();
  }
}

function record(): DiskRecord {
  return {
    schema: "acpx.session.v1",
    kind: "session",
    acpx_record_id: RECORD_ID,
    acp_session_id: "adapter-independent-id",
    agent_command: "node /opt/codex-acp/dist/index.js",
    agent_name: "codex",
    cwd: os.homedir(),
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_seq: 0,
    messages: [],
    metadata: { brick: BRICK_ID },
    closed: false,
  };
}

/** Run `action`, reporting whether it threw and with which OutboxError code. */
function attempt(action: () => void): { threw: boolean; code: string | null; message: string } {
  try {
    action();
    return { threw: false, code: null, message: "" };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      threw: true,
      code: typeof code === "string" ? code : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const scenario = process.argv[2];
let outcome: { threw: boolean; code: string | null; message: string } = {
  threw: false,
  code: null,
  message: "",
};
let outbox: BrickOutbox;

if (scenario === "local-bind") {
  // The production shape: the id handed to bindIdentity is READ BACK from the record acpx-ui
  // minted, exactly as bootInstanceRecord() sources it. Nothing is injected into the guard.
  mintInstanceRecord();
  outbox = new BrickOutbox();
  const minted = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".acpx", "instance.json"), "utf8"),
  ) as { instance_id: string };
  outcome = attempt(() =>
    outbox.bindIdentity({
      instance_id: minted.instance_id,
      box: "devbox.nativai.de",
      public_base_url: "https://atrium.devbox.nativai.de",
    }),
  );
} else if (scenario === "foreign-bind") {
  mintInstanceRecord();
  outbox = new BrickOutbox();
  outcome = attempt(() => outbox.bindIdentity(FIXTURE));
} else if (scenario === "unadmitted-home") {
  // No instance.json at all — devbox-staging's workbench, the fleet's maximally capturable pod.
  outbox = new BrickOutbox();
  outcome = attempt(() => outbox.bindIdentity(FIXTURE));
} else if (scenario === "rebind-poisoned") {
  // An already-captured outbox re-affirming its capture: bindIdentity's own previous-vs-new check
  // passes (they are equal), so only a check against instance.json can refuse it.
  mintInstanceRecord();
  outbox = new BrickOutbox();
  const seed = new DatabaseSync(outbox.dbPath);
  seed
    .prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?")
    .run("instance_id", FIXTURE.instance_id, FIXTURE.instance_id);
  seed.close();
  outcome = attempt(() => outbox.bindIdentity(FIXTURE));
} else if (scenario === "prepare-projection-foreign") {
  // THE SECOND ROUTE: public prepareProjection takes a caller-supplied identity, and
  // checkProjectionInstance writes meta.instance_id from it. bindIdentity is never called here.
  mintInstanceRecord();
  outbox = new BrickOutbox();
  outcome = attempt(() =>
    outbox.prepareProjection(RECORD_ID, record(), {
      instance_id: FIXTURE.instance_id,
      box: FIXTURE.box,
      session_url: `${FIXTURE.public_base_url}/?session=${RECORD_ID}`,
      agent_type: "codex",
    }),
  );
} else if (scenario === "setmeta-bypass") {
  // THE CAPABILITY, reached without naming either public method: the private writer, through a
  // computed key so no textual lint on the literal could ever see it.
  mintInstanceRecord();
  outbox = new BrickOutbox();
  const write = (outbox as unknown as Record<string, (k: string, v: string) => void>).setMeta.bind(
    outbox,
  );
  const key = ["instance", "id"].join("_");
  outcome = attempt(() => write(key, FIXTURE.instance_id));
} else if (scenario === "setmeta-ordinary-key") {
  // CONTROL for setmeta-bypass: an ORDINARY meta key must still be writable, or the previous
  // scenario's refusal would prove only that the probe was broken.
  mintInstanceRecord();
  outbox = new BrickOutbox();
  const write = (outbox as unknown as Record<string, (k: string, v: string) => void>).setMeta.bind(
    outbox,
  );
  outcome = attempt(() => write("probe_ordinary_key", "written"));
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

const meta = metaRows(outbox.dbPath);
const ordinary = new DatabaseSync(outbox.dbPath);
const ordinaryRow = ordinary
  .prepare("SELECT value FROM meta WHERE key=?")
  .get("probe_ordinary_key");
ordinary.close();
console.log(
  `OBS ${JSON.stringify({
    scenario,
    threw: outcome.threw,
    code: outcome.code,
    message: outcome.message,
    meta,
    ordinary_key: ordinaryRow ? String(ordinaryRow.value) : null,
    db: outbox.dbPath,
  })}`,
);
