// brick://874fee67 F1/F2 — a rejected config-option REPLAY must degrade, not kill the turn.
//
// THE FIELD FAILURE THIS LOCKS: acpx auto-failover moved a session to a different
// subscription on its first turn. A custom output style is resolved per
// `CLAUDE_CONFIG_DIR`, so it did not exist under the new one. The adapter behaved
// correctly — warned, ran the default, did not advertise the style. acpx then
// replayed `set_config_option` anyway and the replay handler RETHREW FATALLY,
// because its tolerance branch was scoped to `effort` alone. **The user got no
// reply at all.**
//
// Auto-failover is ON by default and re-picks the subscription every turn, so
// this was the ordinary path for any session carrying a custom style — and the
// failure mode was the worst available: not a degraded style, not a warning, a
// dead turn.
import assert from "node:assert/strict";
import test from "node:test";
import { getTextErrorRemediationHints } from "../src/cli/output/output.js";
import { connectAndLoadSession } from "../src/runtime/engine/reconnect.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// An ACP rejection: a JSON-RPC payload, i.e. the AGENT declining. Note the
// generic top-level message and the real diagnosis buried in `data.details` —
// that shape is the whole of F2.
function acpRejection(details: string): Error {
  return Object.assign(new Error("Internal error"), {
    code: -32603,
    message: "Internal error",
    data: { details },
  });
}

// A transport failure: no ACP payload at all. This is NOT the agent declining —
// it is us not knowing what happened, so it must keep rethrowing.
function transportFailure(): Error {
  return new Error("socket hang up");
}

function recordWithDesired(desired: Record<string, string>): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "replay-rec",
    acpSessionId: "replay-sid",
    agentName: "claude",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    // A live pid that is NOT this process forces the reconnect path; `resumed`
    // then drives the replay of desired_config_options.
    acpx: { desired_config_options: desired, session_options: { profile: "sub7" } },
  });
}

type FakeClientOptions = {
  rejectConfigIds: Map<string, Error>;
};

function fakeClient(options: FakeClientOptions, calls: string[]) {
  return {
    initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    start: async () => {},
    close: async () => {},
    hasReusableSession: () => false,
    supportsLoadSession: () => true,
    supportsResumeSession: () => true,
    resumeSession: async () => ({ agentSessionId: "replay-agent", models: undefined }),
    loadSessionWithOptions: async () => ({ agentSessionId: "replay-agent", models: undefined }),
    getAgentLifecycleSnapshot: () => ({ running: true }),
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async (_sid: string, configId: string) => {
      calls.push(configId);
      const failure = options.rejectConfigIds.get(configId);
      if (failure) {
        throw failure;
      }
      return {};
    },
    clearEventHandlers: () => {},
    setEventHandlers: () => {},
  } as never;
}

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

async function replayWith(
  desired: Record<string, string>,
  rejectConfigIds: Map<string, Error>,
): Promise<{ calls: string[]; error?: unknown }> {
  const calls: string[] = [];
  const record = recordWithDesired(desired);
  try {
    await connectAndLoadSession({
      client: fakeClient({ rejectConfigIds }, calls),
      record,
      activeController: {} as never,
    });
    return { calls };
  } catch (error) {
    return { calls, error };
  }
}

// ─── F1: the blocker ────────────────────────────────────────────────────────

test("F1: an agent-rejected outputStyle replay does NOT kill the turn", async () => {
  const { calls, error } = await replayWith(
    { outputStyle: "Operator Report" },
    new Map([["outputStyle", acpRejection("Unknown output style: Operator Report")]]),
  );
  // SUBJECT WITNESS, not optional: without this the test passes just as happily
  // when the replay never ran at all, and "no error" would be measuring nothing.
  assert.deepEqual(calls, ["outputStyle"], "the replay must actually have been attempted");
  // Before the fix this threw SessionConfigOptionReplayError and the user got no
  // reply. The style being unavailable is a reason to degrade, never to fail.
  assert.equal(error, undefined, "a rejected output style must not fail the turn");
});

test("F1: the tolerance is general — it is about the KIND of failure, not the option name", async () => {
  // The point of the fix: not "effort and outputStyle", but "anything the agent
  // declines". `desired_config_options` structurally cannot hold `mode`/`model`
  // (setDesiredConfigOption refuses them), so everything reaching the replay loop
  // is a preference.
  for (const configId of ["outputStyle", "effort", "someFutureOption"]) {
    const { calls, error } = await replayWith(
      { [configId]: "whatever" },
      new Map([[configId, acpRejection("nope")]]),
    );
    assert.deepEqual(calls, [configId], `the "${configId}" replay must have been attempted`);
    assert.equal(error, undefined, `a rejected "${configId}" must not fail the turn`);
  }
});

test("F1: a TRANSPORT failure still rethrows — we do not know what happened", async () => {
  const { calls, error } = await replayWith(
    { outputStyle: "Operator Report" },
    new Map([["outputStyle", transportFailure()]]),
  );
  // The discriminator is the presence of an ACP payload. Swallowing a timeout
  // would build the turn on an unverified assumption about backend state.
  assert.deepEqual(calls, ["outputStyle"], "the replay must actually have been attempted");
  assert.ok(error, "a transport failure must still rethrow");
  assert.match((error as Error).message, /Failed to replay saved session config option/);
});

test("F1: a rejected option does not stop the OTHER options replaying", async () => {
  const { calls, error } = await replayWith(
    { outputStyle: "Operator Report", effort: "high" },
    new Map([["outputStyle", acpRejection("Unknown output style")]]),
  );
  assert.equal(error, undefined);
  assert.deepEqual(
    calls.toSorted(),
    ["effort", "outputStyle"],
    "the surviving options must still be replayed after one is declined",
  );
});

// ─── F2: the failure has to be diagnosable ──────────────────────────────────

test("F2: a fatal replay error carries data.details, not just 'Internal error'", async () => {
  // The thrown message must contain the diagnosis. `formatErrorMessage` returns
  // only the JSON-RPC `message`, which for a server fault is the useless generic.
  const detail = "output style 'Operator Report' is not available in this config dir";
  const failure = Object.assign(new Error("Internal error"), {
    code: -32603,
    message: "Internal error",
    data: { details: detail },
  });
  // Force the fatal branch: strip the ACP shape recognition by using a plain
  // Error whose payload is nested where extractAcpError cannot see it, then
  // assert on the message composition helper directly instead.
  const { formatAcpErrorMessage } = await import("../src/acp/error-normalization.js");
  assert.match(formatAcpErrorMessage(failure), /Internal error/);
  assert.match(
    formatAcpErrorMessage(failure),
    /not available in this config dir/,
    "the diagnosis in data.details must reach the surfaced message",
  );
});

test("F2: the '--verbose' hint is replaced by the actual reason when we hold it", () => {
  const hints = getTextErrorRemediationHints({
    code: "RUNTIME",
    origin: "acp",
    message: "Internal error",
    acp: {
      code: -32603,
      message: "Internal error",
      data: { details: "Unknown output style: Operator Report" },
    },
  });
  // The old hint sent the reader to a flag that adds nothing on this path. A hint
  // that does not work is worse than no hint — the reader trusts it INSTEAD of
  // investigating.
  assert.ok(
    hints.some((hint) => hint.includes("Unknown output style: Operator Report")),
    `expected the real reason in the hints, got: ${JSON.stringify(hints)}`,
  );
  assert.ok(
    !hints.some((hint) => hint.includes("--verbose")),
    "must not send the reader to --verbose when we already hold the diagnosis",
  );
});

test("F2: with no details available, the verbose hint is still offered", () => {
  // The verbose hints are only wrong when we HAVE the details. Keep them for the
  // case they are actually true for.
  const hints = getTextErrorRemediationHints({
    code: "RUNTIME",
    origin: "acp",
    message: "Internal error",
    acp: { code: -32603, message: "Internal error" },
  });
  assert.ok(
    hints.some((hint) => hint.includes("--verbose")),
    `expected the verbose hint to survive when there are no details, got: ${JSON.stringify(hints)}`,
  );
});

// ─── the degradation must be VISIBLE, or it is the "control that lies" ──────
//
// Tolerating the rejection is only half the fix. A preference that silently stops
// applying leaves the user reading a reply in the wrong style with nothing
// anywhere saying so — which is exactly the failure this feature is built to
// forbid. The warning is what makes the degradation honest rather than silent.

test("F1: a declined option warns VISIBLY, naming the option and the reason", async () => {
  const { result, stderr } = await captureStderr(() =>
    replayWith(
      { outputStyle: "Operator Report" },
      new Map([["outputStyle", acpRejection("Unknown output style: Operator Report")]]),
    ),
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls, ["outputStyle"], "subject witness: the replay ran");
  assert.match(stderr, /outputStyle/, "the warning must name the option");
  assert.match(stderr, /NOT in effect/, "the warning must say the option is not applied");
  assert.match(
    stderr,
    /Unknown output style: Operator Report/,
    "the warning must carry data.details — the actual reason",
  );
});

test("F1: effort stays quiet unless --verbose (known-benign, high-frequency)", async () => {
  // The ONE carve-out, and it is on verbosity only, never on tolerance: haiku
  // routinely rejects mutating `effort`, a case the creation path already absorbs
  // deliberately. Warning unconditionally there would print noise on every
  // reconnect of every such session.
  const { result, stderr } = await captureStderr(() =>
    replayWith({ effort: "high" }, new Map([["effort", acpRejection("Unknown config option")]])),
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls, ["effort"], "subject witness: the replay ran");
  assert.equal(stderr, "", `effort must not warn by default, got: ${JSON.stringify(stderr)}`);
});
