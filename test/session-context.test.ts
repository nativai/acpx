import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAndEnsureAgentFolder } from "../src/cli/session/agent-folder.js";
import { resolveSessionBrickContext } from "../src/cli/session/brick-link.js";
import { principalContextFields } from "../src/session/persistence/principal.js";
import { seatDisplayName } from "../src/session/seat-display-name.js";
import {
  type RecordSessionContext,
  sessionContextFromRecord,
} from "../src/session/session-context.js";
import type { SessionRecord } from "../src/types.js";

// P3a §6 (C12): the four record-backed `sessionContext` literals (queue owner, prompt turn, and the two
// branches of withConnectedSession) became ONE builder. This file holds a verbatim copy of the old
// literal and asserts the builder produces the same object, so the merge is behaviour-neutral by test,
// not by inspection. The only planned difference: the owner / connected-session literals carried no
// `reasoningEffort` key, the builder carries `reasoningEffort: null` — equivalent for every reader
// (`client.ts` reads it as `trimmedOrUndefined(ctx?.reasoningEffort)` and `ctx?.reasoningEffort ?? null`).

/** The OS fields P3a adds on top of the merge — not part of the pre-merge literal. */
const NEW_FIELDS = ["osChoice", "osPrimerError"] as const;

function withoutNewFields(context: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...context };
  for (const key of NEW_FIELDS) {
    delete copy[key];
  }
  return copy;
}

/** VERBATIM the pre-merge literal (`runtime.ts:4039-4055` @282b05e8, the prompt-turn variant). */
async function oldLiteral(record: SessionRecord, reasoningEffort?: string | null) {
  const displayName = await seatDisplayName(record);
  const { brick, brickPath } = await resolveSessionBrickContext(record);
  const agentFolders = resolveAndEnsureAgentFolder(record, brickPath);
  return {
    acpxRecordId: record.acpxRecordId,
    sessionName: displayName ?? null,
    parentSessionId: record.parentSessionId ?? null,
    parentSessionUrl: record.parentSessionUrl ?? null,
    brick,
    brickPath,
    agentFolder: agentFolders?.agentFolder ?? null,
    seatFolder: agentFolders?.seatFolder ?? null,
    subscriptionId: record.acpx?.session_options?.subscription ?? null,
    profileId: record.acpx?.session_options?.profile ?? null,
    reasoningEffort: reasoningEffort ?? null,
    seatId: record.seatId ?? null,
    seatOrdinal: record.holderOrdinal ?? null,
    parentSeatId: record.parentSeatId ?? null,
    ...principalContextFields(record.metadata),
  };
}

async function withStateHome(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-session-context-"));
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function fullRecord(brickDir: string): SessionRecord {
  return {
    acpxRecordId: "5e55c0de-1111-2222-3333-444444444444",
    parentSessionId: "9a9a9a9a-1111-2222-3333-444444444444",
    parentSessionUrl: "https://atrium.example.test/?session=9a9a9a9a-1111-2222-3333-444444444444",
    seatId: "be72fb23-84c9-4bea-b0d9-efaafc5db649",
    holderOrdinal: 3,
    parentSeatId: "0c9b6ef7-b560-44e1-8d61-66507615ac4a",
    acpx: { session_options: { subscription: "sub8", profile: "or-1" } },
    metadata: {
      brick: brickDir,
      principal_id: "p-9df6e3afab610ff30d1a",
      principal_name: "Some Person",
      principal_via: "explicit",
      atrium_os: "/workspace/projects/os/wt",
    },
  } as unknown as SessionRecord;
}

test("sessionContextFromRecord equals the pre-merge literal on a full record (turn variant)", async () => {
  await withStateHome(async (dir) => {
    const brickDir = path.join(dir, "brick");
    await fsp.mkdir(brickDir, { recursive: true });
    const record = fullRecord(brickDir);
    const expected = await oldLiteral(record, "high");
    const actual = await sessionContextFromRecord(record, { reasoningEffort: "high" });
    assert.deepEqual(withoutNewFields(actual), expected);
  });
});

test("sessionContextFromRecord equals the owner / connected-session literal (no effort → null)", async () => {
  await withStateHome(async (dir) => {
    const brickDir = path.join(dir, "brick");
    await fsp.mkdir(brickDir, { recursive: true });
    const record = fullRecord(brickDir);
    assert.deepEqual(withoutNewFields(await sessionContextFromRecord(record)), {
      ...(await oldLiteral(record)),
      reasoningEffort: null,
    });
  });
});

test("sessionContextFromRecord equals the pre-merge literal on a bare record", async () => {
  await withStateHome(async () => {
    const record = { acpxRecordId: "b4e0b4e0-1111-2222-3333-444444444444" } as SessionRecord;
    const actual = await sessionContextFromRecord(record);
    assert.deepEqual(withoutNewFields(actual), await oldLiteral(record));
    // every field present (the `-?` guard's runtime face): no key is merely absent
    for (const value of Object.values(actual)) {
      assert.notEqual(value, undefined);
    }
  });
});

test("RecordSessionContext rejects a context that leaves a field out (the compile-time guard)", () => {
  // @ts-expect-error — every AgentSessionContext field is required here; a builder that forgets one
  // (the drop the merge exists to prevent) does not compile. Remove a field from the builder and
  // `pnpm run build:test` / `typecheck` go red; this line proves the type itself still enforces it.
  const incomplete: RecordSessionContext = { acpxRecordId: "x" };
  assert.equal(incomplete.acpxRecordId, "x");
});
