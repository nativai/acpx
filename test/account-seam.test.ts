import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import {
  getAccountHealth,
  markSubscriptionDead,
  switchSessionAccount,
} from "../src/runtime/engine/account-seam.js";
import { toSessionIndexEntry } from "../src/session/persistence/index.js";
import { parseSessionRecord } from "../src/session/persistence/parse.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

type SeamRegistryContext = {
  homeDir: string;
  registryPath: string;
  profileDir: (id: string) => string;
};

async function withSeamRegistry(run: (ctx: SeamRegistryContext) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-account-seam-"));
  const subsDir = path.join(homeDir, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const profileDir = (id: string) => path.join(subsDir, id);
  try {
    await fs.mkdir(profileDir("subA"), { recursive: true });
    await fs.mkdir(profileDir("subB"), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 3,
          profiles: [
            {
              id: "subA",
              label: "A",
              authMode: "subscription",
              adapter: "claude",
              account: "acct-a",
              credentialSource: profileDir("subA"),
            },
            {
              id: "subB",
              label: "B",
              authMode: "subscription",
              adapter: "claude",
              account: "acct-b",
              credentialSource: profileDir("subB"),
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await run({ homeDir, registryPath, profileDir });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
    resetKnownDeadSubs();
  }
}

test("account seam health: deprecated subscription marker forwards to account health", async () => {
  await withSeamRegistry(async (ctx) => {
    markSubscriptionDead("subA", "test", undefined, {
      homeDir: ctx.homeDir,
      registryPath: ctx.registryPath,
    });

    const health = await getAccountHealth("acct-a");
    assert.equal(health.deadUntil, "9999-12-31T23:59:59.999Z");
  });
});

test("switchSessionAccount rewrites profile, ports transcript, and preserves account_switch", async () => {
  await withSeamRegistry(async (ctx) => {
    const cwd = path.join(ctx.homeDir, "work");
    const acpSessionId = "agent-session-1";
    const record = makeSessionRecord({
      acpxRecordId: "rec-1",
      acpSessionId,
      agentCommand: "claude",
      cwd,
      acpx: { session_options: { profile: "subA", subscription: "legacy-sub" } },
    });
    const src = transcriptJsonlPath(ctx.profileDir("subA"), record.cwd, acpSessionId);
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, "ACCOUNT-SEAM\n");

    const result = await switchSessionAccount(record, "subB", "failover", {
      homeDir: ctx.homeDir,
      registryPath: ctx.registryPath,
    });

    assert.equal(result.transcriptCopied, true);
    assert.equal(record.acpx?.session_options?.profile, "subB");
    assert.equal(record.acpx?.session_options?.subscription, undefined);
    assert.equal(record.acpx?.session_options?.subscription_switch, undefined);
    assert.deepEqual(record.acpx?.session_options?.account_switch, {
      fromProfile: "subA",
      toProfile: "subB",
      fromAccount: "acct-a",
      toAccount: "acct-b",
      reason: "failover",
      at: record.acpx?.session_options?.account_switch?.at,
    });
    assert.match(record.acpx?.session_options?.account_switch?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);

    const dst = transcriptJsonlPath(ctx.profileDir("subB"), record.cwd, acpSessionId);
    assert.equal(await fs.readFile(dst, "utf8"), "ACCOUNT-SEAM\n");

    const parsed = parseSessionRecord(serializeSessionRecordForDisk(record));
    assert.equal(parsed?.acpx?.session_options?.account_switch?.toProfile, "subB");
    const indexEntry = toSessionIndexEntry(record, "rec-1.json");
    assert.equal(indexEntry.accountSwitch?.toProfile, "subB");
  });
});

test("switchSessionAccount fails loudly when a non-fresh session has no portable transcript", async () => {
  await withSeamRegistry(async (ctx) => {
    const record = makeSessionRecord({
      acpxRecordId: "rec-missing",
      acpSessionId: "agent-session-missing",
      agentCommand: "claude",
      cwd: path.join(ctx.homeDir, "work"),
      messages: [
        {
          Agent: {
            content: [{ Text: "prior response" }],
            tool_results: {},
          },
        },
      ],
      acpx: { session_options: { profile: "subA" } },
    });

    await assert.rejects(
      async () =>
        await switchSessionAccount(record, "subB", "failover", {
          homeDir: ctx.homeDir,
          registryPath: ctx.registryPath,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "AccountSwitchError");
        assert.match(error.message, /cannot switch session agent-session-missing/);
        assert.match(error.message, /missing transcript at/);
        return true;
      },
    );

    assert.equal(record.acpx?.session_options?.profile, "subA");
    assert.equal(record.acpx?.session_options?.account_switch, undefined);
  });
});
