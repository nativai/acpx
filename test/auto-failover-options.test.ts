import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setSessionAutoFailover } from "../src/cli/session/session-control.js";
import {
  autoFailoverEnabledForRecord,
  failoverEnabledForRecord,
} from "../src/runtime/engine/failover.js";
import {
  mergeSessionOptions,
  persistSessionOptions,
  sessionOptionsFromRecord,
} from "../src/runtime/engine/session-options.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { mergeLatestDurableAcpxPreferences } from "../src/session/mode-preference.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import { resolveSessionRecord } from "../src/session/persistence/repository.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempDir,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

function recordWithAutoFailover(value: boolean | undefined): SessionRecord {
  return makeSessionRecord(
    {
      acpxRecordId: "auto-fo",
      acpSessionId: "auto-fo-acp",
      agentCommand: "claude",
      cwd: "/workspace/auto-fo",
      acpx: {
        session_options: {
          ...(value !== undefined ? { auto_failover: value } : {}),
          model: "sonnet",
        },
      },
    },
    { resolveCwd: false },
  );
}

test("auto_failover round-trips through parse, clone, session options, persist, and merge", () => {
  const parsed = parseSessionRecord(serializeSessionRecordForDisk(recordWithAutoFailover(false)));
  assert.ok(parsed);
  assert.equal(parsed.acpx?.session_options?.auto_failover, false);

  const cloned = cloneSessionAcpxState(parsed.acpx);
  assert.equal(cloned?.session_options?.auto_failover, false);

  const options = sessionOptionsFromRecord(parsed);
  assert.deepEqual(options, { model: "sonnet", autoFailover: false });

  const merged = mergeSessionOptions({ autoFailover: false }, { model: "opus" });
  assert.deepEqual(merged, { model: "opus", autoFailover: false });

  const persisted = makeSessionRecord({
    acpxRecordId: "persist-auto-fo",
    acpSessionId: "persist-auto-fo-acp",
    agentCommand: "claude",
    cwd: "/workspace/auto-fo",
    acpx: {},
  });
  persistSessionOptions(persisted, { autoFailover: false });
  assert.equal(persisted.acpx?.session_options?.auto_failover, false);
});

test("persistSessionOptions carries a persisted auto_failover:false across an owner-respawn rebuild", () => {
  // An owner respawn rebuilds session_options purely from the spawn flags
  // (model/profile/effort). Those options carry NO autoFailover, so without the
  // breadcrumb-style carry-forward the explicit `off` policy would be dropped
  // and silently revert to default-on (brick://71af1351).
  const record = recordWithAutoFailover(false);
  persistSessionOptions(record, { model: "opus", profile: "sub6", reasoningEffort: "high" });

  assert.equal(record.acpx?.session_options?.auto_failover, false);
  // The rebuild still applies the incoming spawn flags.
  assert.equal(record.acpx?.session_options?.model, "opus");
  assert.equal(record.acpx?.session_options?.profile, "sub6");
  assert.equal(record.acpx?.session_options?.effort, "high");
  // And the gate honours the carried policy — the exact regression the fix targets.
  assert.equal(autoFailoverEnabledForRecord(record), false);
});

test("an explicit options.autoFailover overrides the persisted policy in both directions", () => {
  // off -> on: an explicit spawn/set that re-enables failover must win.
  const reEnable = recordWithAutoFailover(false);
  persistSessionOptions(reEnable, { model: "opus", autoFailover: true });
  assert.equal(reEnable.acpx?.session_options?.auto_failover, true);

  // (absent) -> off: an explicit disable persists even with no prior policy.
  const disable = recordWithAutoFailover(undefined);
  persistSessionOptions(disable, { model: "opus", autoFailover: false });
  assert.equal(disable.acpx?.session_options?.auto_failover, false);
});

test("a fresh session with no prior auto_failover stays default (undefined -> enabled)", () => {
  const record = makeSessionRecord(
    {
      acpxRecordId: "fresh-auto-fo",
      acpSessionId: "fresh-auto-fo-acp",
      agentCommand: "claude",
      cwd: "/workspace/auto-fo",
      acpx: {},
    },
    { resolveCwd: false },
  );
  persistSessionOptions(record, { model: "opus", profile: "sub6" });

  assert.equal(record.acpx?.session_options?.auto_failover, undefined);
  assert.equal(autoFailoverEnabledForRecord(record), true);
});

test("carry-forward preserves auto_failover AND the subscription_switch breadcrumb together", () => {
  const record = makeSessionRecord(
    {
      acpxRecordId: "carry-both",
      acpSessionId: "carry-both-acp",
      agentCommand: "claude",
      cwd: "/workspace/auto-fo",
      acpx: {
        session_options: {
          auto_failover: false,
          model: "sonnet",
          subscription_switch: {
            from: "sub6",
            to: "sub2",
            reason: "failover",
            at: "2026-07-13T00:00:00.000Z",
          },
        },
      },
    },
    { resolveCwd: false },
  );
  persistSessionOptions(record, { model: "opus", profile: "sub6", reasoningEffort: "high" });

  assert.equal(record.acpx?.session_options?.auto_failover, false);
  assert.deepEqual(record.acpx?.session_options?.subscription_switch, {
    from: "sub6",
    to: "sub2",
    reason: "failover",
    at: "2026-07-13T00:00:00.000Z",
  });
});

test("auto_failover:false is preserved against stale durable preference snapshots", () => {
  const merged = mergeLatestDurableAcpxPreferences(
    {
      session_options: {
        model: "old-model",
        auto_failover: true,
      },
    },
    {
      session_options: {
        model: "new-model",
        auto_failover: false,
      },
    },
  );

  assert.equal(merged?.session_options?.model, "new-model");
  assert.equal(merged?.session_options?.auto_failover, false);
});

test("cross-session list readback surfaces a respawn-rebuilt auto_failover:false for OTHER sessions", () => {
  // The brick's literal claim: a cross-session readback (the `acpx sessions`
  // list / acpx-ui, which projects OTHER sessions from their index entries)
  // must report the policy for a session that is not `self`. The index entry is
  // projected straight from session_options.auto_failover, so it is only correct
  // if the field survives the owner-respawn rebuild.
  const other = recordWithAutoFailover(false);
  // Simulate the respawn rebuild: session_options rebuilt from spawn flags only.
  persistSessionOptions(other, { model: "opus", profile: "sub6", reasoningEffort: "high" });

  const entry = toSessionIndexEntry(other, "other-session.json");
  // Pre-fix the rebuild dropped auto_failover -> this projected to `undefined`
  // (read cross-session as default-on); the carry-forward keeps it false.
  assert.equal(entry.autoFailover, false);
});

test("session index projects and preserves autoFailover", async () => {
  await withTempDir("acpx-auto-fo-index-", async (dir) => {
    const entry = toSessionIndexEntry(recordWithAutoFailover(false), "auto-fo.json");
    assert.equal(entry.autoFailover, false);

    await writeSessionIndex(dir, { files: ["auto-fo.json"], entries: [entry] });
    const index = await readSessionIndex(dir);
    assert.equal(index?.entries[0]?.autoFailover, false);
  });
});

test("auto_failover defaults enabled and explicit false gates failover", async () => {
  await withTempHome("acpx-auto-fo-gate-", async (homeDir) => {
    const profileDir = path.join(homeDir, ".acpx", "subscriptions", "sub-a");
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "subscriptions", "registry.json"),
      JSON.stringify({
        version: 3,
        default: "sub-a",
        profiles: [
          {
            id: "sub-a",
            label: "Sub A",
            authMode: "subscription",
            adapter: "claude",
            account: "acct-a",
            credentialSource: profileDir,
          },
        ],
      }),
    );

    const enabledRecord = makeSessionRecord({
      acpxRecordId: "enabled-auto-fo",
      acpSessionId: "enabled-auto-fo-acp",
      agentCommand: "claude",
      cwd: "/workspace/auto-fo",
      acpx: { session_options: { profile: "sub-a" } },
    });
    const disabledRecord = makeSessionRecord({
      acpxRecordId: "disabled-auto-fo",
      acpSessionId: "disabled-auto-fo-acp",
      agentCommand: "claude",
      cwd: "/workspace/auto-fo",
      acpx: { session_options: { profile: "sub-a", auto_failover: false } },
    });

    assert.equal(autoFailoverEnabledForRecord(enabledRecord), true);
    assert.equal(failoverEnabledForRecord(enabledRecord, { homeDir }), true);
    assert.equal(autoFailoverEnabledForRecord(disabledRecord), false);
    assert.equal(failoverEnabledForRecord(disabledRecord, { homeDir }), false);
  });
});

test("integration: an owner-respawn re-persist keeps auto_failover:false across a disk round-trip", async () => {
  await withTempHome("acpx-auto-fo-respawn-", async (homeDir) => {
    const record = makeSessionRecord({
      acpxRecordId: "respawn-auto-fo",
      acpSessionId: "respawn-auto-fo-acp",
      agentCommand: "claude",
      cwd: homeDir,
      acpx: { session_options: { auto_failover: false, model: "sonnet", profile: "sub6" } },
    });
    await writeSessionRecordFile(homeDir, record);

    // A respawning owner reloads the record from disk, then re-persists
    // session_options from the spawn-flag options (model/profile/effort) — which
    // carry NO autoFailover. This is the exact rebuild that used to drop the
    // explicit `off` policy.
    const loaded = await resolveSessionRecord("respawn-auto-fo");
    persistSessionOptions(loaded, { model: "opus", profile: "sub6", reasoningEffort: "high" });
    await writeSessionRecordFile(homeDir, loaded);

    const reloaded = await resolveSessionRecord("respawn-auto-fo");
    assert.equal(reloaded.acpx?.session_options?.auto_failover, false);
    assert.equal(autoFailoverEnabledForRecord(reloaded), false);
    assert.equal(reloaded.acpx?.session_options?.model, "opus");
    assert.equal(reloaded.acpx?.session_options?.effort, "high");
  });
});

test("setSessionAutoFailover writes explicit policy without recycling a live-idle owner", async () => {
  await withTempHome("acpx-auto-fo-set-", async (homeDir) => {
    const record = makeSessionRecord({
      acpxRecordId: "set-auto-fo",
      acpSessionId: "set-auto-fo-acp",
      agentCommand: "claude",
      cwd: homeDir,
      acpx: {},
    });
    await writeSessionRecordFile(homeDir, record);

    const off = await setSessionAutoFailover({
      sessionId: "set-auto-fo",
      autoFailover: false,
    });
    assert.equal(off.autoFailover, false);

    const onDiskOff = JSON.parse(
      await fs.readFile(sessionFilePath(homeDir, "set-auto-fo"), "utf8"),
    ) as { acpx?: { session_options?: { auto_failover?: unknown } } };
    assert.equal(onDiskOff.acpx?.session_options?.auto_failover, false);

    await setSessionAutoFailover({
      sessionId: "set-auto-fo",
      autoFailover: true,
    });
    const resolved = await resolveSessionRecord("set-auto-fo");
    assert.equal(resolved.acpx?.session_options?.auto_failover, true);
  });
});
