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
/** A foreign id that PASSES readLocalIdentity's `i-` + 12-hex shape check. See the boundary rows. */
const WELL_FORMED_FOREIGN = "i-bbbbbbbbbbbb";
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
/**
 * Set only by the reentrant-tojson scenario: what the re-entrant write did. Read through
 * `reentryResult()` rather than directly — the only assignment is inside a `toJSON` closure, which
 * control-flow analysis does not track, so a direct read at the bottom of this file narrows to
 * `null` and then to `never`. `build:test` catches that; `pnpm run typecheck` does NOT (different
 * tsconfig), and the stale `dist-test/` left behind then reports a green tally for code nobody has.
 */
let reentry: { threw: boolean; code: string | null; message: string } | null = null;
function reentryResult(): { threw: boolean; code: string | null; message: string } | null {
  return reentry;
}

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
} else if (scenario === "forged-instance-record") {
  // BOUNDARY, MEASURED RATHER THAN INFERRED: the guard compares the bind against instance.json,
  // so something that FORGES instance.json in the HOME it is binding against is PERMITTED. That
  // is a different and worse attack — it corrupts the box's identity record itself — and this
  // brick does not defend against it. Recorded so no reader infers a guarantee that was not made.
  // ⚠️ The forged id is WELL-FORMED (i- + 12 hex) on purpose. A first version of this probe forged
  // `i-twin0000001` and was refused — by readLocalIdentity's SHAPE check, not by anything to do
  // with the boundary — which would have recorded a guarantee that does not exist.
  mintInstanceRecord(WELL_FORMED_FOREIGN);
  outbox = new BrickOutbox();
  outcome = attempt(() => outbox.bindIdentity({ ...FIXTURE, instance_id: WELL_FORMED_FOREIGN }));
} else if (scenario === "copied-instance-record") {
  // The near neighbour of the above, and it does NOT get through: a record COPIED from another
  // box carries that box's `home`, and readLocalIdentity refuses on the home mismatch. The id is
  // well-formed here so the refusal is attributable to the HOME alone.
  const dir = path.join(os.homedir(), ".acpx");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "instance.json"),
    JSON.stringify({
      instance_id: WELL_FORMED_FOREIGN,
      created_at: new Date().toISOString(),
      home: "/home/node",
      machine_id: "f".repeat(64),
    }),
  );
  outbox = new BrickOutbox();
  outcome = attempt(() => outbox.bindIdentity({ ...FIXTURE, instance_id: WELL_FORMED_FOREIGN }));
} else if (scenario === "malformed-instance-record") {
  // Why the outage's OWN identity cannot be laundered through a forgery: `i-twin0000001` is not
  // `i-` + 12 hex, so readLocalIdentity refuses the record itself before any comparison happens.
  mintInstanceRecord(FIXTURE.instance_id);
  outbox = new BrickOutbox();
  outcome = attempt(() => outbox.bindIdentity(FIXTURE));
} else if (scenario === "tojson-payload-swap") {
  // THE ROW THAT ACTUALLY DECIDES. `projection_identity` — not the scalar — is what
  // `identityForRecord` compares against instance.json, so it is the row whose poisoning wedges
  // the box. The scalar handed to the guard is LOCAL and passes honestly; `toJSON` then returns a
  // completely different identity, so the ARGUMENT and the SERIALISED BYTES disagree.
  // Found by an independent test-engineer attacking the guard, and it reproduced the outage error
  // exactly: measured at acpx 6a0ab15 the bind SUCCEEDED, `projection_identity` held
  // i-twin0000001/f32-twin/https://fixture.invalid, and the next identityForRecord threw
  // "identity binding differs from instance.json".
  mintInstanceRecord();
  outbox = new BrickOutbox();
  const swapped = {
    instance_id: LOCAL_INSTANCE,
    box: "devbox.nativai.de",
    public_base_url: "https://atrium.devbox.nativai.de",
    toJSON: () => FIXTURE,
  };
  outcome = attempt(() =>
    outbox.bindIdentity(
      swapped as unknown as { instance_id: string; box: string; public_base_url: string },
    ),
  );
} else if (scenario === "reentrant-tojson") {
  // RE-ENTRY: the admission window is a per-instance boolean, so anything that runs caller code
  // INSIDE it can write an unchecked identity. `JSON.stringify(projection)` is the only such
  // evaluation there was — `toJSON` is caller code. The bind's own identity is LOCAL, so the
  // check passes and the window genuinely opens; only the ORDER of the serialisation decides
  // whether the re-entrant write lands.
  mintInstanceRecord();
  outbox = new BrickOutbox();
  const write = (outbox as unknown as Record<string, (k: string, v: string) => void>).setMeta.bind(
    outbox,
  );
  const hostile = {
    instance_id: LOCAL_INSTANCE,
    box: "devbox.nativai.de",
    public_base_url: "https://atrium.devbox.nativai.de",
    toJSON(): Record<string, string> {
      reentry = attempt(() => write("instance_id", FIXTURE.instance_id));
      return {
        instance_id: LOCAL_INSTANCE,
        box: "devbox.nativai.de",
        public_base_url: "https://atrium.devbox.nativai.de",
      };
    },
  };
  outcome = attempt(() =>
    outbox.bindIdentity(
      hostile as unknown as { instance_id: string; box: string; public_base_url: string },
    ),
  );
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
    reentry_refused: reentryResult()?.threw ?? null,
    reentry_code: reentryResult()?.code ?? null,
    db: outbox.dbPath,
  })}`,
);
