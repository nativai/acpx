import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildClaudeParentSessionMeta } from "../src/acp/auth-env.js";
import { buildAgentSpawnOptions } from "../src/acp/client.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// brick://c6e3618b — a cross-box parent session URL must keep its ORIGIN host.
//
// A parent id is a BARE UUID and sessions never resolve cross-box: each box runs
// its own acpx-ui over its own store. So recomposing `${localBase}/?session=${id}`
// for a parent that lives on ANOTHER box yields a well-formed URL for a session
// that does not exist here — and the child handed it sends its whole report-back
// contract into a 404 while believing it reported upward.
//
// Measured before the fix (deployed acpx 9566e7c / branch base 69b0485):
//   passed  https://acpx.devbox.konsiq.de/?session=deadbeef-...
//   child   https://acpx.devbox.nativai.de/?session=deadbeef-...   <- re-hosted
// and the record persisted NO parent_session_url at all: the key was ABSENT from
// 2288 of 2291 session records on devbox (the 3 that had it were written by
// acpx-ui, the only writer in the fleet), and ABSENT from all 1907 index entries
// carrying a parentSessionId.
//
// ⚠️ Every assertion below is a TRANSITION with both hosts named. DO NOT relax one
// to "is a valid acpx url" — both hosts are valid; which one survives IS the defect.

const FOREIGN_HOST = "https://acpx.devbox.konsiq.de";
const LOCAL_HOST = "https://acpx.devbox.nativai.de";
const PARENT_ID = "deadbeef-1111-4111-8111-111111111111";
const FOREIGN_PARENT_URL = `${FOREIGN_HOST}/?session=${PARENT_ID}`;
// The bridge agent — `_meta` is emitted only for this command (claude-pty-agent.test.ts).
const CLAUDE_PTY_COMMAND = "node /opt/claude-pty-acp/dist/index.js";

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(previous)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Simulate on-disk JSON: undefined keys are dropped. */
function toDisk(persisted: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>;
}

function recordWithParent(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    ...makeSessionRecord(
      {
        acpxRecordId: "child-1",
        acpSessionId: "acp-child-1",
        agentCommand: "node /opt/claude-agent-acp/dist/index.js",
        cwd: "/workspace/x",
      },
      { resolveCwd: false },
    ),
    kind: "session",
    parentSessionId: PARENT_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Leg 1 — the spawn PROCESS env (ACPX_PARENT_SESSION_URL)
// ---------------------------------------------------------------------------

test("c6e3618b: a foreign parent URL reaches the child with its ORIGIN host intact", () => {
  withEnv({ ACPX_UI_BASE_URL: LOCAL_HOST }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-1",
      parentSessionId: PARENT_ID,
      parentSessionUrl: FOREIGN_PARENT_URL,
    });
    assert.equal(options.env.ACPX_PARENT_SESSION_URL, FOREIGN_PARENT_URL);
    // The precise regression: the local base must NOT have been substituted in.
    assert.equal(
      options.env.ACPX_PARENT_SESSION_URL?.startsWith(LOCAL_HOST),
      false,
      "parent URL was re-hosted onto the local box",
    );
  });
});

test("c6e3618b control: a SAME-box parent (id only) still derives against the local base", () => {
  withEnv({ ACPX_UI_BASE_URL: LOCAL_HOST }, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-1",
      parentSessionId: PARENT_ID,
    });
    assert.equal(options.env.ACPX_PARENT_SESSION_URL, `${LOCAL_HOST}/?session=${PARENT_ID}`);
  });
});

test("c6e3618b: no parent at all → no ACPX_PARENT_SESSION_URL, and a blank url does not win", () => {
  withEnv({ ACPX_UI_BASE_URL: LOCAL_HOST }, () => {
    assert.equal(
      buildAgentSpawnOptions("/tmp/acpx-agent", undefined, { acpxRecordId: "child-1" }).env
        .ACPX_PARENT_SESSION_URL,
      undefined,
    );
    // A whitespace-only url must fall through to the id, not emit an empty host.
    assert.equal(
      buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-1",
        parentSessionId: PARENT_ID,
        parentSessionUrl: "   ",
      }).env.ACPX_PARENT_SESSION_URL,
      `${LOCAL_HOST}/?session=${PARENT_ID}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Leg 2 — the claude-pty bridge's session/new `_meta`
// Both spawn paths now share one composition. This pins that they AGREE, which
// is what the FW-19 comment already claimed while they silently diverged.
// ---------------------------------------------------------------------------

test("c6e3618b: the bridge _meta and the process env agree on the foreign parent URL", () => {
  withEnv({ ACPX_UI_BASE_URL: LOCAL_HOST }, () => {
    const context = {
      acpxRecordId: "child-1",
      parentSessionId: PARENT_ID,
      parentSessionUrl: FOREIGN_PARENT_URL,
    };
    const meta = buildClaudeParentSessionMeta(context, CLAUDE_PTY_COMMAND);
    const envUrl = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, context).env
      .ACPX_PARENT_SESSION_URL;
    assert.equal(meta?.["independent-claude-acp/parent-session-url"], FOREIGN_PARENT_URL);
    assert.equal(meta?.["independent-claude-acp/parent-session-url"], envUrl);
  });
});

// ---------------------------------------------------------------------------
// Leg 3 — the session RECORD (serialize → disk → parse)
// ---------------------------------------------------------------------------

test("c6e3618b: parent_session_url round-trips serialize → disk → parse", () => {
  const persisted = serializeSessionRecordForDisk(
    recordWithParent({ parentSessionUrl: FOREIGN_PARENT_URL }),
  );
  assert.equal(persisted.parent_session_url, FOREIGN_PARENT_URL);

  const reparsed = parseSessionRecord(toDisk(persisted));
  assert.ok(reparsed);
  assert.equal(reparsed.parentSessionUrl, FOREIGN_PARENT_URL);
  assert.equal(reparsed.parentSessionId, PARENT_ID);
});

test("c6e3618b: a same-box parent writes NO parent_session_url key (absent, not null)", () => {
  // Absent is what acpx-ui's reader expects for a same-box parent — a literal null
  // would be a new value it has never seen. This also keeps every pre-existing
  // record byte-identical through a rewrite.
  const onDisk = toDisk(serializeSessionRecordForDisk(recordWithParent()));
  assert.equal("parent_session_url" in onDisk, false);
  const reparsed = parseSessionRecord(onDisk);
  assert.ok(reparsed);
  assert.equal(reparsed.parentSessionUrl, undefined);
  assert.equal(reparsed.parentSessionId, PARENT_ID);
});

test("c6e3618b: a malformed parent_session_url rejects the record rather than half-parsing it", () => {
  const persisted = serializeSessionRecordForDisk(recordWithParent());
  persisted.parent_session_url = 42;
  assert.equal(parseSessionRecord(toDisk(persisted)), null);
});

// ---------------------------------------------------------------------------
// Leg 4 — index.json. acpx-ui's own SessionIndexEntry documents this field as
// "projected by acpx into index.json"; before this fix acpx never projected it,
// so acpx-ui's LIST path read undefined for every session ever created.
// ---------------------------------------------------------------------------

test("c6e3618b: toSessionIndexEntry projects parentSessionUrl into index.json", () => {
  const entry = toSessionIndexEntry(
    recordWithParent({ parentSessionUrl: FOREIGN_PARENT_URL }),
    "child-1.json",
  );
  assert.equal(entry.parentSessionUrl, FOREIGN_PARENT_URL);
  assert.equal(entry.parentSessionId, PARENT_ID);
  // Same-box parent → the key drops out on disk, so old readers see absent.
  const plain = toSessionIndexEntry(recordWithParent(), "child-1.json");
  assert.equal(plain.parentSessionUrl, undefined);
  assert.equal("parentSessionUrl" in toDisk(plain as unknown as Record<string, unknown>), false);
});

test("c6e3618b: parentSessionUrl survives an index write → read round-trip", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-parent-url-"));
  try {
    const entry = toSessionIndexEntry(
      recordWithParent({ parentSessionUrl: FOREIGN_PARENT_URL }),
      "child-1.json",
    );
    await writeSessionIndex(dir, { files: ["child-1.json"], entries: [entry] });
    const reloaded = await readSessionIndex(dir);
    assert.ok(reloaded);
    // Load-bearing, same reason the enrichment fields are: the daemon writes every
    // entry back exactly as parsed here, so a drop on THIS leg strips the field off
    // every other session whenever one entry is rebuilt.
    assert.equal(reloaded.entries[0]?.parentSessionUrl, FOREIGN_PARENT_URL);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
