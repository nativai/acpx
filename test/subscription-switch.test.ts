import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import {
  SubscriptionSwitchError,
  switchSessionSubscription,
} from "../src/runtime/engine/subscription-switch.js";
import type { SessionRecord } from "../src/types.js";

async function withTempHome(
  run: (ctx: {
    homeDir: string;
    registryPath: string;
    subDir: (id: string) => string;
  }) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-switch-"));
  const subsDir = path.join(homeDir, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const subDir = (id: string) => path.join(subsDir, id);
  try {
    await fs.mkdir(subDir("subA"), { recursive: true });
    await fs.mkdir(subDir("subB"), { recursive: true });
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        default: "subA",
        subscriptions: [
          { id: "subA", label: "A", configDir: subDir("subA") },
          { id: "subB", label: "B", configDir: subDir("subB") },
        ],
      }),
    );
    await run({ homeDir, registryPath, subDir });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    acpxRecordId: "rec-1",
    cwd: "/work/proj",
    agentCommand: "claude",
    ...overrides,
  } as SessionRecord;
}

test("switchSessionSubscription updates the record + writes the breadcrumb", async () => {
  await withTempHome(async ({ registryPath }) => {
    const record = makeRecord({
      acpx: { session_options: { subscription: "subA" } },
    });

    const result = await switchSessionSubscription({
      record,
      targetSubId: "subB",
      reason: "manual",
      loadOpts: { registryPath },
    });

    assert.equal(result.from, "subA");
    assert.equal(result.to, "subB");
    assert.equal(record.acpx?.session_options?.subscription, "subB");
    const sw = record.acpx?.session_options?.subscription_switch;
    assert.ok(sw);
    assert.equal(sw.from, "subA");
    assert.equal(sw.to, "subB");
    assert.equal(sw.reason, "manual");
    assert.match(sw.at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("switchSessionSubscription ports the transcript JSONL src -> dst", async () => {
  await withTempHome(async ({ registryPath, subDir }) => {
    const acpSessionId = "sess-uuid";
    const record = makeRecord({
      acpSessionId,
      acpx: { session_options: { subscription: "subA" } },
    });

    const src = transcriptJsonlPath(subDir("subA"), record.cwd, acpSessionId);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, "HALIBUT-7\n");

    const result = await switchSessionSubscription({
      record,
      targetSubId: "subB",
      reason: "failover",
      loadOpts: { registryPath },
    });

    assert.equal(result.transcriptCopied, true);
    const dst = transcriptJsonlPath(subDir("subB"), record.cwd, acpSessionId);
    assert.equal(await fs.readFile(dst, "utf8"), "HALIBUT-7\n");
    assert.equal(record.acpx?.session_options?.subscription_switch?.reason, "failover");
  });
});

test("switchSessionSubscription no-ops the copy for a fresh session (no acpSessionId)", async () => {
  await withTempHome(async ({ registryPath }) => {
    const record = makeRecord({ acpx: { session_options: { subscription: "subA" } } });
    const result = await switchSessionSubscription({
      record,
      targetSubId: "subB",
      reason: "manual",
      loadOpts: { registryPath },
    });
    assert.equal(result.transcriptCopied, false);
    assert.equal(record.acpx?.session_options?.subscription, "subB");
  });
});

test("switchSessionSubscription from-default has no `from` breadcrumb", async () => {
  await withTempHome(async ({ registryPath }) => {
    // No explicit subscription on the record => prior selection was the default.
    const record = makeRecord();
    const result = await switchSessionSubscription({
      record,
      targetSubId: "subB",
      reason: "failover",
      loadOpts: { registryPath },
    });
    assert.equal(result.from, undefined);
    assert.equal(record.acpx?.session_options?.subscription_switch?.from, undefined);
    assert.equal(record.acpx?.session_options?.subscription_switch?.to, "subB");
  });
});

test("switchSessionSubscription rejects an unknown target id", async () => {
  await withTempHome(async ({ registryPath }) => {
    const record = makeRecord();
    await assert.rejects(
      () =>
        switchSessionSubscription({
          record,
          targetSubId: "ghost",
          reason: "manual",
          loadOpts: { registryPath },
        }),
      SubscriptionSwitchError,
    );
  });
});
