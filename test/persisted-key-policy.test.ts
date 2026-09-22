import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import {
  assertPersistedKeyPolicy,
  findPersistedKeyPolicyViolations,
} from "../src/persisted-key-policy.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

function makeRecord(): SessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "record-1",
    acpSessionId: "session-1",
    agentSessionId: "agent-1",
    agentCommand: AGENT_REGISTRY.codex,
    cwd: "/tmp/project",
    createdAt: "2026-02-27T00:00:00.000Z",
    lastUsedAt: "2026-02-27T00:00:00.000Z",
    lastSeq: 4,
    lastRequestId: "req-1",
    eventLog: {
      active_path: "/tmp/record-1.stream.ndjson",
      segment_count: 2,
      max_segment_bytes: 1024,
      max_segments: 2,
      last_write_at: "2026-02-27T00:00:00.000Z",
      last_write_error: null,
    },
    closed: false,
    title: null,
    messages: [
      {
        User: {
          id: "user-1",
          content: [{ Text: "hello" }, { Audio: { source: "UklGRg==", mime_type: "audio/wav" } }],
        },
      },
      {
        Agent: {
          content: [
            { Text: "world" },
            {
              ToolUse: {
                id: "call_1",
                name: "run_command",
                raw_input: '{"command":"ls"}',
                input: {
                  command: "ls",
                },
                is_input_complete: true,
                thought_signature: null,
              },
            },
          ],
          tool_results: {
            call_1: {
              tool_use_id: "call_1",
              tool_name: "run_command",
              is_error: false,
              content: {
                Text: "ok",
              },
              output: {
                exitCode: 0,
              },
            },
          },
        },
      },
    ],
    updated_at: "2026-02-27T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {
      "5cf39f6d-9c4f-4d20-9e4b-739abc4b2554": {
        input_tokens: 1,
      },
    },
    acpx: {
      current_mode_id: "code",
      available_commands: ["run"],
    },
  };
}

test("serialized session record satisfies persisted key policy", () => {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  assertPersistedKeyPolicy(persisted);
});

test("persisted key policy rejects camelCase acpx-owned keys", () => {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  persisted.requestId = "bad";

  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(violations.includes("requestId"), true);
  assert.throws(() => {
    assertPersistedKeyPolicy(persisted);
  }, /snake_case/);
});

test("persisted key policy allows pinned account_switch seam keys", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    session_options: {
      profile: "subB",
      account_switch: {
        fromProfile: "subA",
        toProfile: "subB",
        fromAccount: "acct-a",
        toAccount: "acct-b",
        effectiveAccount: "acct-a",
        effectiveProfile: "subA",
        effectiveAuthMode: "subscription",
        effectiveAnchor: "/tmp/subA",
        effectiveResolutionMethod: "path",
        reason: "failover",
        at: "2026-06-13T00:00:00.000Z",
      },
    },
  };

  const persisted = serializeSessionRecordForDisk(record);
  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  assertPersistedKeyPolicy(persisted);
});

/**
 * brick://48aca560 — the assert lives INSIDE serializeSessionRecordForDisk, not
 * in its callers, so no writer can bypass it. The tests' own record writers
 * (`test/cli.test.ts`, `test/runtime-test-helpers.ts`) call serialize and
 * `fs.writeFile` directly; while the assert sat in `repository.ts` they wrote
 * shapes production could never persist, and the suite stayed green.
 */
/**
 * ⚠️ THE SYNTHETIC FIELD NAME IS LOAD-BEARING — DO NOT SWAP IT FOR A REAL ONE.
 *
 * These two rows simulate "a field some future author adds", so they must not be
 * anchored to a field that actually exists: the moment another branch gives that
 * field a real element type, the row stops COMPILING and takes the whole suite
 * with it. That is not hypothetical — this pair originally used `cost_units`, and
 * brick://5026423b (which types it as `CostUnit[]`) broke it. Neither branch fails
 * alone; only the merge does, and `pnpm run typecheck` cannot see it because
 * `tsconfig.json` excludes `test/` while `tsconfig.test.json` includes it.
 */
test("serializeSessionRecordForDisk itself throws on a camelCase acpx key", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    future_block: { camelKey: 1 },
  } as unknown as SessionRecord["acpx"];

  assert.throws(() => {
    serializeSessionRecordForDisk(record);
  }, /acpx\.future_block\.camelKey/);
});

test("serializeSessionRecordForDisk accepts the same record once the key is snake_case", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    future_block: { camel_key: 1 },
  } as unknown as SessionRecord["acpx"];

  // CONTROL for the test above: the rejection must be about the KEY NAME, not
  // about `future_block` being unknown to the policy.
  assert.deepEqual(findPersistedKeyPolicyViolations(serializeSessionRecordForDisk(record)), []);
});

test("serializeSessionRecordForDisk rejects the provisioning_warning breadcrumb's old key names", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    session_options: {
      provisioning_warning: {
        at: "2026-06-13T12:00:00.000Z",
        profileId: "home1",
        authMode: "claude-home",
        message: "hook install failed",
      },
    },
  } as SessionRecord["acpx"];

  // This shape shipped from 2026-06-13 and could never be written. It is pinned
  // so the rename cannot be quietly reverted by a future edit to the emitter.
  assert.throws(() => {
    serializeSessionRecordForDisk(record);
  }, /provisioning_warning\.profileId/);
});

// --- served_via_shim through the REAL policy (brick://a89c3cd4) -------------
// The hazard this guards is not "the field is missing": `assertPersistedKeyPolicy`
// throws INSIDE the record write, before `fs.writeFile`, and the throw is
// swallowed — so one camelCase key freezes the whole record on disk, taking
// unrelated pre-existing fields with it, under a green suite (brick://48aca560).
// So the field is driven through the real policy, with a control proving the
// policy can still reject — a passing acceptance test alone would look identical
// if the policy had stopped working.

test("served_via_shim passes the real persisted key policy", () => {
  const record = makeRecord();
  record.acpx = {
    ...record.acpx,
    session_options: { ...record.acpx?.session_options, served_via_shim: true },
  };

  const persisted = serializeSessionRecordForDisk(record);
  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  assertPersistedKeyPolicy(persisted);

  // and it actually survives serialization — a key the policy accepts but the
  // serializer drops would pass the two assertions above while never reaching disk
  const sessionOptions = (persisted.acpx as { session_options?: Record<string, unknown> })
    ?.session_options;
  assert.equal(sessionOptions?.served_via_shim, true);
});

test("CONTROL: the policy still rejects the camelCase form of this same field", () => {
  const record = makeRecord();
  // Seed the snake_case field so `session_options` EXISTS on the serialized
  // record — `makeRecord()` has none, and injecting into `undefined` throws
  // before the policy is ever consulted (which is how this control first failed
  // for a reason having nothing to do with the policy).
  record.acpx = {
    ...record.acpx,
    session_options: { ...record.acpx?.session_options, served_via_shim: true },
  };
  const persisted = serializeSessionRecordForDisk(record);
  const sessionOptions = (persisted.acpx as { session_options?: Record<string, unknown> })
    ?.session_options as Record<string, unknown>;
  sessionOptions.servedViaShim = true;

  // NOTE the PATH form: violations are reported as `acpx.session_options.<key>`,
  // not as a bare key — the `requestId` case above matches a bare name only
  // because that key is top-level. Asserting the bare name here failed while the
  // policy was working perfectly, which is precisely what this control caught.
  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(violations.includes("acpx.session_options.servedViaShim"), true);
  assert.throws(() => {
    assertPersistedKeyPolicy(persisted);
  }, /snake_case/);
});

// --- the MESSAGE subtree must stay WALKED (brick://94b6f8fb) ----------------
// `serializeSessionRecordForDisk` passes `messages` through WHOLESALE, so every
// key under it reaches disk verbatim. On 2026-09-19 acpx began writing the
// adapter's camelCase `_meta.claudeUuid` straight onto `messages.Agent`; the
// policy threw inside the write and 69 sessions silently stopped persisting —
// and inter-agent DELIVERY broke with them, because delivering a message
// persists the RECIPIENT's record (34 lost deliveries on 2026-09-22).
//
// The correct fix maps the wire spelling onto `claude_uuid` at the read site
// (`conversation-model.ts`). The TEMPTING WRONG ONE is to make the policy stop
// looking here — an entry in ZED_TAG_KEYS-style allowlisting, or `messages` in
// OPAQUE_VALUE_PATHS. These two rows pin the subtree as walked so that cannot
// happen quietly, and they pin the exact historical path so the regression
// cannot return unnamed.
//
// ⚠️ THESE ARE NOT A REGRESSION TEST FOR THE 09-19 DEFECT — they pass on the
// broken build too, because the runtime policy caught it correctly all along.
// What failed was the FAILURE MODE and the fact that nothing caught it earlier.
// The guard that would have caught it before it shipped is the compile-time
// `PersistedMessageKeysAreSnakeCase` in `src/persisted-key-policy.ts`.

function agentEntryOf(persisted: Record<string, unknown>): Record<string, unknown> {
  const messages = persisted.messages as { Agent?: Record<string, unknown> }[];
  const agent = messages.find((entry) => entry.Agent)?.Agent;
  if (!agent) {
    throw new Error("fixture must carry an Agent message entry or these rows prove nothing");
  }
  return agent;
}

test("persisted key policy rejects a camelCase key in the message subtree", () => {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  agentEntryOf(persisted).claudeUuid = "d0fe0ebd-f63b-4249-91c9-57d9a87fe745";

  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(violations.includes("messages.Agent.claudeUuid"), true);
  assert.throws(() => {
    assertPersistedKeyPolicy(persisted);
  }, /messages\.Agent\.claudeUuid/);
});

test("CONTROL: the same message-subtree key passes in snake_case", () => {
  // Proves the rejection above is about the KEY NAME, not about the policy
  // refusing any unknown field under `messages`.
  const persisted = serializeSessionRecordForDisk(makeRecord());
  agentEntryOf(persisted).claude_uuid = "d0fe0ebd-f63b-4249-91c9-57d9a87fe745";

  assert.deepEqual(findPersistedKeyPolicyViolations(persisted), []);
  assertPersistedKeyPolicy(persisted);
});

// --- the single-assignment-path invariant (brick://a89c3cd4) ----------------
// `servedViaShim` is recorded inside `AcpClient.setShimHandle`, so the fact is
// captured no matter WHICH shim-start site fires. That only holds while the
// setter is the sole assignment path — and the failure it prevents is one a
// behavioural test cannot catch, because a picker-only implementation plus a
// picker-only test is green, and both would be written by the same person in
// the same sitting. So the invariant is asserted directly.
//
// ⚠️ LIMITATION, stated so nobody trusts this further than it goes: it is a TEXT
// match. A rename of the field, a destructuring assignment, or any other spelling
// slips past it. It catches the specific regression that matters — someone adding
// a third shim-start site with a raw assignment, copying the two that were there
// before — and nothing wider.

test("AcpClient assigns shimHandle ONLY through setShimHandle (single-path invariant)", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  // Resolved from the REPO ROOT (process.cwd()), not from import.meta.url: the
  // compiled test runs out of dist-test/test/, so a URL-relative path lands on
  // the emitted .js instead of the source this invariant is about.
  const source = await fs.readFile(path.join(process.cwd(), "src/acp/client.ts"), "utf8");

  const assignments = source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => /^this\.shimHandle\s*=/.test(line));

  // Exactly one: the assignment inside setShimHandle itself.
  assert.deepEqual(
    assignments.map(({ line }) => line),
    ["this.shimHandle = handle;"],
    `raw this.shimHandle assignments outside setShimHandle at line(s) ${assignments
      .map(({ lineNumber }) => lineNumber)
      .join(", ")} — route them through setShimHandle so the served-via-shim fact is recorded`,
  );
});
