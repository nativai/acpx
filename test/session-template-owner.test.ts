import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { SessionResolutionError } from "../src/errors.js";
import {
  parseSessionRecord,
  persistTemplateMark,
  resolveSessionRecord,
  serializeSessionRecordForDisk,
} from "../src/session/persistence.js";
import { MAX_ACTOR_BYTES } from "../src/session/persistence/template-actor.js";
import { planMarkKey } from "../src/session/persistence/template-owner.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// TEMPLATES CONCEPTION §4.2 (actors), K8 (the owner is fixed), §11.5 #5 (actors survive). In-process, on a
// real temp store: the same persistTemplateMark the CLI verb calls.

const LAATZ = "p-fb566154c0bf245b7538";
const OTHER = "p-0123456789abcdef0123";
const HUMAN = { kind: "human", channel: "web", verified: true, name: "Daniel Laatz" };
const AGENT = {
  kind: "agent",
  session_id: "s-1",
  session_url: "https://atrium.example/?session=s-1",
};

function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  return withTempHomeFixture("acpx-t1-owner-", run);
}

function candidate(
  homeDir: string,
  id: string,
  template?: SessionRecord["template"],
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "agent-a",
    cwd: path.join(homeDir, "workspace"),
    closed: true,
    template: template ?? {
      enabled: true,
      created_at: "2026-06-10T00:00:00.000Z",
      source_session_id: `${id}-acp`,
    },
  });
}

async function reread(id: string): Promise<NonNullable<SessionRecord["template"]>> {
  const template = (await resolveSessionRecord(id)).template;
  assert.ok(template, `record ${id} lost its template block`);
  return template;
}

// ---------------------------------------------------------------------------
// planMarkKey — the owner rule, pure
// ---------------------------------------------------------------------------

test("planMarkKey: --owner applies on the first mark and composes <person-id>/<base>", () => {
  assert.equal(planMarkKey(undefined, LAATZ, "reviewer"), `${LAATZ}/reviewer`);
  assert.equal(planMarkKey(undefined, undefined, "reviewer"), "reviewer");
  assert.equal(planMarkKey(undefined, undefined, undefined), undefined);
});

test("planMarkKey: a re-mark keeps the owner; a different owner is refused (K8)", () => {
  const mine = `${LAATZ}/reviewer`;
  assert.equal(planMarkKey(mine, undefined, "other-base"), `${LAATZ}/other-base`);
  assert.equal(planMarkKey(mine, LAATZ, "reviewer"), mine, "the SAME owner is not a change");
  assert.throws(() => planMarkKey(mine, OTHER, "reviewer"), /owner is fixed/);
  // a machine-wide template cannot be given an owner by a re-mark, and a personal one cannot lose it
  assert.throws(() => planMarkKey("reviewer", LAATZ, "reviewer"), /owner is fixed/);
  assert.equal(
    planMarkKey(mine, undefined, "x"),
    `${LAATZ}/x`,
    "no --owner never turns a personal key machine-wide",
  );
});

test("planMarkKey: --owner without a base is refused; an invalid stored key belongs to nobody", () => {
  assert.throws(() => planMarkKey(undefined, LAATZ, undefined), /--owner needs --slug/);
  // an invalid key has no owner to keep: its first valid key takes the requested one
  assert.equal(planMarkKey("!!bad/reviewer", LAATZ, "reviewer"), `${LAATZ}/reviewer`);
  assert.equal(planMarkKey("!!bad/reviewer", undefined, "reviewer"), "reviewer");
});

// ---------------------------------------------------------------------------
// persistTemplateMark — owner, version per owner, actors
// ---------------------------------------------------------------------------

test("a personal chain is versioned on its own: laatz's first reviewer is v1 beside a machine-wide v5", async () => {
  await withTempHome(async (homeDir) => {
    for (const [id, version] of [
      ["m-1", 1],
      ["m-5", 5],
    ] as const) {
      await writeSessionRecordFile(
        homeDir,
        candidate(homeDir, id, {
          enabled: true,
          created_at: "2026-06-01T00:00:00.000Z",
          slug: "reviewer",
          version,
        }),
      );
    }
    const first = candidate(homeDir, "p-1");
    await writeSessionRecordFile(homeDir, first);
    await persistTemplateMark(first, { slug: "Reviewer", owner: LAATZ });
    const stored = await reread("p-1");
    assert.equal(stored.slug, `${LAATZ}/reviewer`);
    assert.equal(stored.version, 1);

    const second = candidate(homeDir, "p-2");
    await writeSessionRecordFile(homeDir, second);
    await persistTemplateMark(second, { slug: "reviewer", owner: LAATZ });
    assert.equal((await reread("p-2")).version, 2);
    assert.equal((await reread("m-5")).slug, "reviewer", "the machine-wide chain is untouched");
  });
});

test("a re-mark of a personal record keeps its owner and its version (no --owner needed)", async () => {
  await withTempHome(async (homeDir) => {
    const record = candidate(homeDir, "p-1");
    await writeSessionRecordFile(homeDir, record);
    await persistTemplateMark(record, { slug: "reviewer", owner: LAATZ });
    const again = await resolveSessionRecord("p-1");
    again.template = { ...again.template };
    await persistTemplateMark(again, { slug: "reviewer" });
    const stored = await reread("p-1");
    assert.equal(stored.slug, `${LAATZ}/reviewer`);
    assert.equal(stored.version, 1, "an idempotent re-mark does not bump the version");
    const refused = await resolveSessionRecord("p-1");
    await assert.rejects(
      () => persistTemplateMark(refused, { slug: "reviewer", owner: OTHER }),
      SessionResolutionError,
    );
    assert.equal(
      (await reread("p-1")).slug,
      `${LAATZ}/reviewer`,
      "a refused re-mark writes nothing",
    );
  });
});

test("a new version records its creator; a re-mark keeps it and updates updated_actor (TPL-R5)", async () => {
  await withTempHome(async (homeDir) => {
    const record = candidate(homeDir, "p-1");
    await writeSessionRecordFile(homeDir, record);
    await persistTemplateMark(record, { slug: "reviewer", owner: LAATZ, actor: HUMAN });
    let stored = await reread("p-1");
    assert.deepEqual(stored.created_actor, HUMAN);
    assert.deepEqual(stored.updated_actor, HUMAN);

    const again = await resolveSessionRecord("p-1");
    await persistTemplateMark(again, { slug: "reviewer", actor: AGENT });
    stored = await reread("p-1");
    assert.deepEqual(stored.created_actor, HUMAN, "the creator of THIS version never changes");
    assert.deepEqual(stored.updated_actor, AGENT);

    // an unnamed writer erases nothing
    const unnamed = await resolveSessionRecord("p-1");
    await persistTemplateMark(unnamed, { slug: "reviewer" });
    stored = await reread("p-1");
    assert.deepEqual(stored.created_actor, HUMAN);
    assert.deepEqual(stored.updated_actor, AGENT);
  });
});

test("a NEW key starts a new version with its own creator, never the previous version's", async () => {
  await withTempHome(async (homeDir) => {
    const record = candidate(homeDir, "p-1");
    await writeSessionRecordFile(homeDir, record);
    await persistTemplateMark(record, { slug: "reviewer", owner: LAATZ, actor: HUMAN });
    const renamed = await resolveSessionRecord("p-1");
    await persistTemplateMark(renamed, { slug: "triage", actor: AGENT });
    const stored = await reread("p-1");
    assert.equal(stored.slug, `${LAATZ}/triage`, "the owner survives a new --slug");
    assert.deepEqual(stored.created_actor, AGENT);

    const unnamedRename = await resolveSessionRecord("p-1");
    await persistTemplateMark(unnamedRename, { slug: "audit" });
    assert.equal(
      (await reread("p-1")).created_actor,
      undefined,
      "the carried creator named the OLD version",
    );
  });
});

// ---------------------------------------------------------------------------
// parse — an actor is kept whole or dropped alone
// ---------------------------------------------------------------------------

function onDisk(template: Record<string, unknown>): unknown {
  const record = serializeSessionRecordForDisk(
    makeSessionRecord({ acpxRecordId: "r", acpSessionId: "r", agentCommand: "a", cwd: "/tmp/x" }),
  ) as Record<string, unknown>;
  return { ...record, template };
}

test("parse keeps a clean actor — including a kind this acpx has never heard of", () => {
  const unknown = { kind: "robot", extra_field: { nested_key: 1 } };
  const parsed = parseSessionRecord(
    onDisk({ enabled: true, slug: "x", created_actor: unknown, updated_actor: HUMAN }),
  );
  assert.deepEqual(parsed?.template?.created_actor, unknown);
  assert.deepEqual(parsed?.template?.updated_actor, HUMAN);
});

test("parse drops a malformed actor ALONE: the block, its slug and the record load", () => {
  const tooBig = { kind: "agent", note: "x".repeat(MAX_ACTOR_BYTES) };
  const camel = { kind: "human", sessionId: "not-snake-case" };
  const nestedCamel = { kind: "human", extra: { someKey: 1 } };
  for (const bad of [tooBig, camel, nestedCamel, [], "human", 7, null, {}]) {
    const parsed = parseSessionRecord(
      onDisk({ enabled: true, slug: "x", version: 3, created_actor: bad, updated_actor: AGENT }),
    );
    assert.ok(parsed, `record failed to load with actor ${JSON.stringify(bad)?.slice(0, 40)}`);
    assert.equal(parsed.template?.slug, "x");
    assert.equal(parsed.template?.version, 3);
    assert.equal(parsed.template?.created_actor, undefined);
    assert.deepEqual(parsed.template?.updated_actor, AGENT);
  }
});

test("an actor exactly at the byte cap is kept (the boundary is inclusive)", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ kind: "agent", note: "" }));
  const atCap = { kind: "agent", note: "x".repeat(MAX_ACTOR_BYTES - overhead) };
  assert.equal(Buffer.byteLength(JSON.stringify(atCap)), MAX_ACTOR_BYTES);
  assert.deepEqual(
    parseSessionRecord(onDisk({ enabled: true, created_actor: atCap }))?.template?.created_actor,
    atCap,
  );
});
