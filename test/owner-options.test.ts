import assert from "node:assert/strict";
import test from "node:test";
import {
  ownerOptionsToInput,
  persistSessionOwnerOptions,
  resolveSessionOwnerOptions,
} from "../src/session/owner-options.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

test("resolveSessionOwnerOptions restores persisted behavioral owner payload", () => {
  const record = makeHistoryRecord({
    permission_mode: "deny-all",
    non_interactive_permissions: "fail",
    auth_policy: "fail",
    terminal: true,
  });

  const resolved = resolveSessionOwnerOptions(record, {
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    terminal: false,
  });

  assert.deepEqual(resolved, {
    permission_mode: "deny-all",
    non_interactive_permissions: "fail",
    auth_policy: "fail",
    terminal: true,
  });
});

test("resolveSessionOwnerOptions lets an explicit permission flag override stored mode only", () => {
  const record = makeHistoryRecord({
    permission_mode: "approve-reads",
    auth_policy: "fail",
  });

  const resolved = resolveSessionOwnerOptions(
    record,
    {
      permissionMode: "approve-all",
      authPolicy: "skip",
    },
    { permissionModeExplicit: true },
  );

  assert.deepEqual(resolved, {
    permission_mode: "approve-all",
    auth_policy: "fail",
  });
});

test("resolveSessionOwnerOptions fails loudly when history has no stored permission mode", () => {
  const record = makeSessionRecord({
    acpxRecordId: "legacy-history",
    acpSessionId: "provider-session",
    agentCommand: "agent",
    cwd: "/tmp/workspace",
    messages: [
      {
        Agent: {
          content: [{ Text: "prior response" }],
          tool_results: {},
        },
      },
    ],
    acpx: {},
  });

  assert.throws(
    () =>
      resolveSessionOwnerOptions(record, {
        permissionMode: "approve-reads",
      }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.name, "SessionOwnerRestoreError");
      assert.match(error.message, /no persisted owner permission_mode/);
      return true;
    },
  );
});

test("session owner options round-trip through persisted acpx.owner_options", () => {
  const record = makeSessionRecord({
    acpxRecordId: "owner-roundtrip",
    acpSessionId: "provider-session",
    agentCommand: "agent",
    cwd: "/tmp/workspace",
  });
  const ownerOptions = persistSessionOwnerOptions(record, {
    permissionMode: "approve-all",
    nonInteractivePermissions: "fail",
    authPolicy: "skip",
    terminal: false,
  });

  const parsed = parseSessionRecord(serializeSessionRecordForDisk(record));

  assert.deepEqual(ownerOptionsToInput(ownerOptions), {
    permissionMode: "approve-all",
    nonInteractivePermissions: "fail",
    authPolicy: "skip",
    terminal: false,
  });
  assert.deepEqual(parsed?.acpx?.owner_options, ownerOptions);
});

function makeHistoryRecord(
  ownerOptions: NonNullable<ReturnType<typeof makeSessionRecord>["acpx"]>["owner_options"],
) {
  return makeSessionRecord({
    acpxRecordId: "history-record",
    acpSessionId: "provider-session",
    agentCommand: "agent",
    cwd: "/tmp/workspace",
    messages: [
      {
        Agent: {
          content: [{ Text: "prior response" }],
          tool_results: {},
        },
      },
    ],
    acpx: {
      owner_options: ownerOptions,
    },
  });
}

test("resolveSessionOwnerOptions takes the fresh-session path for a breadcrumb-only record (brick://509b4ee1)", () => {
  // A guard-forced fresh session's only Agent entry is the (legacy, untagged)
  // breadcrumb — that is not agent history, so a first prompt without a stored
  // permission mode must NOT trip the restore-guard hard error.
  const record = makeSessionRecord({
    acpxRecordId: "breadcrumb-only",
    acpSessionId: "provider-session",
    agentCommand: "agent",
    cwd: "/tmp/workspace",
    messages: [
      {
        Agent: {
          content: [
            {
              Text:
                '⚠ implicit Fable blocked → forced opus: this session would have resolved to "fable" by ' +
                "inheritance/default, but Fable is never inherited automatically (brick://5bac5564). The model " +
                'was rewritten to "opus". Pass `--model fable` explicitly if a Fable session was actually intended.',
            },
          ],
          tool_results: {},
        },
      },
    ],
    acpx: {},
  });

  const resolved = resolveSessionOwnerOptions(record, {
    permissionMode: "approve-reads",
  });
  assert.equal(resolved.permission_mode, "approve-reads");
});
