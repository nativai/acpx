import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeTranscriptConfigDir,
  transcriptCwdHash,
} from "../src/config/subscription-transcript.js";
import type { SubscriptionRegistry } from "../src/config/subscriptions.js";
import { ModelFloorUnmetError } from "../src/errors.js";
import { enforceModelFloorPostServe } from "../src/session/model-floor-enforce.js";
import { captureServedState, readLastServedModel } from "../src/session/model-floor.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const CLAUDE = "node /opt/claude-agent-acp/dist/index.js";

// TE Finding #4 (brick://07dd62c9) + the latent brick://08ac840f PROD gap it exposes.
// The CLI folds `--subscription` into the unified session_options.PROFILE slot for the
// fleet majority (~1655 in .profile vs ~62 in .subscription), and the adapter
// (auth-env applyProfileAuth) sets a subscription profile's CLAUDE_CONFIG_DIR by
// feeding the PROFILE id into chooseSubscriptionConfigDir — the SAME resolver
// activeTranscriptConfigDir uses. subscriptionIdFromRecord read `.subscription` ONLY,
// so for profile-based sessions the transcript dir mis-resolved to the registry
// default: served-capture read the wrong account's transcript (served=null → the floor
// check fails OPEN → a --floor-hard CE on a non-default sub served below floor was
// SILENTLY ACCEPTED — the incident specimen bbb50865 was a sub4/non-default CE), and
// the 08ac840f transcript-porting ported to the wrong dir. Fixed: profile-first.

function registryOf(
  entries: Array<{ id: string; configDir: string }>,
  def?: string,
): SubscriptionRegistry {
  return {
    default: def,
    subscriptions: entries.map((e) => ({
      id: e.id,
      label: e.id,
      configDir: e.configDir,
      account: e.id,
    })),
  };
}

async function writeAssistantTranscript(
  configDir: string,
  cwd: string,
  acpSessionId: string,
  model: string,
): Promise<void> {
  const dir = path.join(configDir, "projects", transcriptCwdHash(cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${acpSessionId}.jsonl`),
    `{"type":"assistant","message":{"role":"assistant","model":"${model}","content":[]}}\n`,
  );
}

test("activeTranscriptConfigDir resolves the transcript dir from session_options.PROFILE (08ac840f + F#4)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-subprof-"));
  try {
    const sub6Dir = path.join(root, "sub6");
    const defDir = path.join(root, "sub-default");
    await fs.mkdir(sub6Dir, { recursive: true });
    await fs.mkdir(defDir, { recursive: true });
    const registry = registryOf(
      [
        { id: "sub6", configDir: sub6Dir },
        { id: "sub-default", configDir: defDir },
      ],
      "sub-default",
    );
    const opts = { homeDir: root, registry };

    // Profile-based session (the fleet majority) → the PROFILE's sub dir, not default.
    assert.equal(
      activeTranscriptConfigDir({ acpx: { session_options: { profile: "sub6" } } }, opts),
      sub6Dir,
    );
    // Legacy `.subscription` still resolves.
    assert.equal(
      activeTranscriptConfigDir({ acpx: { session_options: { subscription: "sub6" } } }, opts),
      sub6Dir,
    );
    // Profile takes precedence (matches the adapter: it uses profileId when present).
    assert.equal(
      activeTranscriptConfigDir(
        { acpx: { session_options: { profile: "sub6", subscription: "sub-default" } } },
        opts,
      ),
      sub6Dir,
    );
    // No selection → registry default (the pre-fix path that mis-served profile sessions).
    assert.equal(activeTranscriptConfigDir({ acpx: { session_options: {} } }, opts), defDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readLastServedModel reads the transcript of a NON-DEFAULT sub selected via PROFILE (F#4 core)", async () => {
  await withTempHome("acpx-subprof-", async (home) => {
    const subsDir = path.join(home, ".acpx", "subscriptions");
    const sub6Dir = path.join(subsDir, "sub6");
    const defDir = path.join(subsDir, "sub-default");
    await fs.mkdir(sub6Dir, { recursive: true });
    await fs.mkdir(defDir, { recursive: true });
    await fs.writeFile(
      path.join(subsDir, "registry.json"),
      JSON.stringify(
        registryOf(
          [
            { id: "sub6", configDir: sub6Dir },
            { id: "sub-default", configDir: defDir },
          ],
          "sub-default",
        ),
      ),
    );

    const cwd = "/workspace/proj";
    const acpSessionId = "sess-nondefault-sub";
    const record = makeSessionRecord({
      acpxRecordId: "nondefault-rec",
      acpSessionId,
      agentCommand: CLAUDE,
      cwd,
      acpx: {
        session_options: { profile: "sub6", model: "fable", effort: "max" },
        desired_config_options: { effort: "max" },
      },
    });
    // The served-below-floor transcript lives under the PROFILE's sub dir (sub6),
    // NOT the registry default — pre-fix this resolved sub-default → served=null.
    await writeAssistantTranscript(sub6Dir, cwd, acpSessionId, "claude-sonnet-4-6");

    assert.equal(await readLastServedModel(record), "claude-sonnet-4-6");
    const served = await captureServedState(record);
    assert.equal(served, "claude-sonnet-4-6");
    assert.equal(record.acpx?.served?.model, "claude-sonnet-4-6");
  });
});

test("bbb50865 scenario: a --floor-hard CE on a NON-DEFAULT (profile) sub served sonnet is NOT accepted", async () => {
  await withTempHome("acpx-subprof-", async (home) => {
    const subsDir = path.join(home, ".acpx", "subscriptions");
    const sub4Dir = path.join(subsDir, "sub4");
    const defDir = path.join(subsDir, "sub-default");
    await fs.mkdir(sub4Dir, { recursive: true });
    await fs.mkdir(defDir, { recursive: true });
    await fs.writeFile(
      path.join(subsDir, "registry.json"),
      JSON.stringify(
        registryOf(
          [
            { id: "sub4", configDir: sub4Dir },
            { id: "sub-default", configDir: defDir },
          ],
          "sub-default",
        ),
      ),
    );

    const cwd = "/workspace/ce";
    const acpSessionId = "sess-bbb50865-like";
    const record = makeSessionRecord({
      acpxRecordId: "bbb-like-rec",
      acpSessionId,
      agentCommand: CLAUDE,
      cwd,
      acpx: {
        session_options: { profile: "sub4", model: "fable", effort: "max", floor_hard: true },
        desired_config_options: { effort: "max" },
      },
    });
    await writeSessionRecordFile(home, record);
    // Served sonnet on sub4 (the non-default, profile-selected account).
    await writeAssistantTranscript(sub4Dir, cwd, acpSessionId, "claude-sonnet-4-6");

    // Served-capture now reaches sub4's transcript (was the FAIL-OPEN gap).
    const served = await captureServedState(record);
    assert.equal(served, "claude-sonnet-4-6");
    // --floor-hard → the below-floor turn is NOT accepted (the guarantee now holds
    // on a non-default sub — the exact class of the incident specimen).
    const verdict = await enforceModelFloorPostServe(record, { servedModel: served });
    assert.equal(verdict.accept, false);
    assert.ok(!verdict.accept && verdict.error instanceof ModelFloorUnmetError);
    assert.equal(record.acpx?.session_options?.model, "fable"); // pin unmutated
  });
});
