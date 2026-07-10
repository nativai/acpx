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
