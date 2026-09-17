/**
 * Wedge-detection probe (brick 7d03eca1) — one scenario per invocation, in a scratch HOME.
 *
 * Reproduces the 2026-09-15 outage shape directly: an outbox binds to instance A, then
 * instance.json is RE-MINTED to instance B while the binding survives (a HOME wipe, a mismatched
 * restore, or a re-provisioned PVC — see brick 7d03eca1's own "When it WOULD bite"). Every
 * session-mutating operation on that HOME then fails with `outbox-instance-mismatch`.
 *
 * `norotate-save-record` is the POSITIVE CONTROL: it proves `saveRecord` genuinely reaches the
 * projection path (via `identityForRecord`) rather than short-circuiting to `writeOwnedRecord` —
 * without it, `rotate-save-record` throwing would prove nothing about which code path failed.
 *
 * Usage: HOME=<scratch> node --import tsx test/fixtures/wedge-detect-worker.ts <scenario>
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BrickOutbox, type DiskRecord } from "../../src/brick-outbox.js";

const SCRATCH_ROOT = "/workspace/wedge-detect-probe";

// 🛑 NEVER RUN AGAINST THE BOX'S REAL HOME — see bind-guard-worker.ts for why.
assert.ok(
  os.homedir().startsWith(`${SCRATCH_ROOT}/`),
  `refusing to run outside ${SCRATCH_ROOT}: HOME resolved to ${os.homedir()}`,
);

const INSTANCE_A = "i-aaaaaaaaaaaa";
const INSTANCE_B = "i-bbbbbbbbbbbb";
const RECORD_ID = "33333333-3333-4333-8333-333333333333";
const BRICK_ID = "44444444-4444-4444-8444-444444444444";

function writeInstanceJson(instanceId: string): void {
  const dir = path.join(os.homedir(), ".acpx");
  fs.mkdirSync(dir, { recursive: true });
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

function outboxRowCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

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

// Common setup for both scenarios: mint instance A, bind the outbox to it (production shape —
// bootInstanceRecord then the trigger owner's first bind), so isBound() is true and saveRecord
// routes through identityForRecord rather than the unguarded writeOwnedRecord fast path.
writeInstanceJson(INSTANCE_A);
const outbox = new BrickOutbox();
outbox.bindIdentity({
  instance_id: INSTANCE_A,
  box: "devbox.nativai.de",
  public_base_url: "https://atrium.devbox.nativai.de",
});

let outcome: { threw: boolean; code: string | null; message: string };

if (scenario === "norotate-save-record") {
  // POSITIVE CONTROL: no rotation. This must succeed and actually write an outbox row, or the
  // rotated arm's failure would not be attributable to the rotation at all.
  outcome = attempt(() => outbox.saveRecord(record()));
} else if (scenario === "rotate-save-record") {
  // THE PRODUCTION SHAPE: instance.json is re-minted to B while the binding (A) survives —
  // exactly the 2026-09-15 outage precondition (brick 507a1c38 / 7d03eca1).
  writeInstanceJson(INSTANCE_B);
  outcome = attempt(() => outbox.saveRecord(record()));
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

console.log(
  `OBS ${JSON.stringify({
    scenario,
    threw: outcome.threw,
    code: outcome.code,
    message: outcome.message,
    outbox_rows: outboxRowCount(outbox.dbPath),
    db: outbox.dbPath,
  })}`,
);
