import assert from "node:assert/strict";
import test from "node:test";
import { printServedBelowFloorWarning } from "../src/cli/output/render.js";
import { enforceModelFloorPostServe } from "../src/session/model-floor-enforce.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// brick://c327efb5 half (b) — a served-vs-pinned model mismatch must be VISIBLE at
// the point of use. Detection already worked and persisted `served_below_floor`;
// nothing rendered it on the CLI turn output, so a user asked for model X, was
// served model Y, and read `[done] end_turn` + exit 0 with no indication.
//
// These tests drive the REAL detector (`enforceModelFloorPostServe`) and feed its
// output to the REAL renderer, rather than hand-building a breadcrumb. A test that
// stamps the breadcrumb itself would still pass if the two halves stopped
// connecting — which is the failure this whole brick is about.

function pinnedRecord(pin: string): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "c327-rec",
    acpSessionId: "c327-sid",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: { session_options: { model: pin } },
  });
}

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/** Run a real post-serve floor evaluation, then render whatever it stamped. */
async function serveAndRender(params: {
  pin: string;
  servedModel: string | undefined;
  format?: "text" | "json" | "quiet";
  jsonStrict?: boolean;
}): Promise<string> {
  return await withTempHome("acpx-c327-", async () => {
    const record = pinnedRecord(params.pin);
    await enforceModelFloorPostServe(record, { servedModel: params.servedModel });
    return captureStderr(() =>
      printServedBelowFloorWarning(record, params.format ?? "text", params.jsonStrict ?? false),
    );
  });
}

// ─── The core property: the mismatch reaches the user ───────────────────────

test("c327efb5 (b): a below-floor turn PRINTS the mismatch with each model in its OWN slot", async () => {
  const stderr = await serveAndRender({ pin: "opus", servedModel: "claude-sonnet-5" });

  // ⚠️ DO NOT WEAKEN THESE BACK TO `assert.match(stderr, /claude-sonnet-5/)` +
  // `/opus/`. That shape is what this test used to be, and it is the whole
  // failure it now exists to prevent: presence-only assertions cannot tell the
  // two ids APART, so SWAPPING them in the message passes every one of them.
  // An independent test-engineer's mutant did exactly that — printing
  // `served "opus" but pinned to "claude-sonnet-5"` — and survived the entire
  // suite, even though it names the wrong model as served and tells the user to
  // re-pin to the model they were just served: the exact inverse of the recovery
  // action. A message whose ONLY job is to say which model you got must be
  // pinned by POSITION. (`/opus/` was doubly weak — it also matches inside
  // `claude-opus-5`.)
  assert.match(stderr, /was served "claude-sonnet-5"/);
  assert.match(stderr, /pinned to "opus"/);
  // The recovery action must name the PIN, never the served model — telling the
  // user to re-pin to what they were just served is worse than saying nothing.
  assert.match(stderr, /set model opus /);
});

test("c327efb5 (b): the rendered sentence is EXACT — every slot pinned at once", async () => {
  // One full-string assertion, deliberately brittle. Slot regexes above catch a
  // swap; this catches a slot being silently dropped or re-ordered in a way no
  // individual regex covers. If a wording change makes this fail, read the new
  // string and confirm each id is still in the slot it belongs in before
  // updating it — do not update it reflexively.
  const stderr = await serveAndRender({ pin: "opus", servedModel: "claude-sonnet-5" });

  assert.equal(
    stderr,
    '[acpx] ⚠ served-model mismatch: this turn was served "claude-sonnet-5" but the session ' +
      'is pinned to "opus". The answer above came from claude-sonnet-5. Re-pin with ' +
      "`acpx claude set model opus --session-id c327-rec`, or use --floor-hard to refuse a " +
      "mismatched turn instead of accepting it.\n",
  );
});

test("c327efb5 (b): the printed line is NOT gated on --verbose", async () => {
  // The pre-existing surface (`logFloor`) was verbose-only AND written by the
  // queue-owner process, so it never reached the user's terminal at all. Nothing
  // in this path may take a verbosity flag: the renderer has no such parameter,
  // and this asserts the line appears with no verbosity anywhere in play.
  const stderr = await serveAndRender({ pin: "opus", servedModel: "claude-sonnet-5" });
  assert.match(stderr, /⚠ served-model mismatch/);
});

test("c327efb5 (b): the effort dip is named when effort was authored down", async () => {
  const stderr = await withTempHome("acpx-c327-", async () => {
    const record = makeSessionRecord({
      acpxRecordId: "c327-effort",
      acpSessionId: "c327-sid",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace",
      acpx: {
        session_options: { model: "opus", effort: "max" },
        desired_config_options: { effort: "max" },
      },
    });
    await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-5" });
    // Only rendered when the detector actually recorded a differing served effort.
    record.acpx!.served_below_floor!.served_effort = "high";
    return captureStderr(() => printServedBelowFloorWarning(record, "text", false));
  });

  assert.match(stderr, /effort max→high/);
});

// ─── HoD constraint (i): must not be noisy on legitimate cases ───────────────
//
// Each silence assertion below is PAIRED with a firing case through the same
// helper. An absence assertion whose instrument is dead passes for the wrong
// reason; the pair proves the instrument could have spoken.

test("c327efb5 (b): ordinary alias resolution is SILENT (pin opus, served claude-opus-5)", async () => {
  const quiet = await serveAndRender({ pin: "opus", servedModel: "claude-opus-5" });
  assert.equal(quiet, "", `alias resolution must not warn, got: ${quiet}`);

  // Positive control on the same path: a real mismatch DOES speak, so the
  // silence above is a verdict and not a broken instrument.
  const loud = await serveAndRender({ pin: "opus", servedModel: "claude-sonnet-5" });
  assert.match(loud, /served-model mismatch/);
});

// ─── HoD constraint (ii): never warn about a mismatch not established ────────

test("c327efb5 (b): an UNKNOWN served model is SILENT — no mismatch was established", async () => {
  // `evaluateModelFloor` classifies an unreadable served model `unknown`, which
  // never stamps the breadcrumb. Warning here would invent a mismatch from a
  // transient transcript-read miss.
  const quiet = await serveAndRender({ pin: "opus", servedModel: undefined });
  assert.equal(quiet, "", `unknown served model must not warn, got: ${quiet}`);

  const loud = await serveAndRender({ pin: "opus", servedModel: "claude-sonnet-5" });
  assert.match(loud, /served-model mismatch/);
});

test("c327efb5 (b): an unpinned session is SILENT — there is no floor to be below", async () => {
  const quiet = await withTempHome("acpx-c327-", async () => {
    const record = makeSessionRecord({
      acpxRecordId: "c327-nopin",
      acpSessionId: "c327-sid",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace",
      acpx: {},
    });
    await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-5" });
    return captureStderr(() => printServedBelowFloorWarning(record, "text", false));
  });
  assert.equal(quiet, "", `unpinned session must not warn, got: ${quiet}`);

  const loud = await serveAndRender({ pin: "opus", servedModel: "claude-sonnet-5" });
  assert.match(loud, /served-model mismatch/);
});

// ─── Output-policy suppression: same rules as the session banner ─────────────

test("c327efb5 (b): --format quiet suppresses the warning", async () => {
  const stderr = await serveAndRender({
    pin: "opus",
    servedModel: "claude-sonnet-5",
    format: "quiet",
  });
  assert.equal(stderr, "", `quiet must emit nothing, got: ${stderr}`);
});

test("c327efb5 (b): --json-strict suppresses the warning (non-JSON stderr would corrupt it)", async () => {
  const stderr = await serveAndRender({
    pin: "opus",
    servedModel: "claude-sonnet-5",
    format: "json",
    jsonStrict: true,
  });
  assert.equal(stderr, "", `json-strict must emit nothing, got: ${stderr}`);
});

test("c327efb5 (b): plain --format json still warns on stderr (stdout stays clean JSON)", async () => {
  // Mirrors printPromptSessionBanner: only STRICT json silences stderr. The
  // warning goes to stderr, so machine-parsed stdout is unaffected either way.
  const stderr = await serveAndRender({
    pin: "opus",
    servedModel: "claude-sonnet-5",
    format: "json",
    jsonStrict: false,
  });
  assert.match(stderr, /served-model mismatch/);
});

// ─── Episode semantics ──────────────────────────────────────────────────────

test("c327efb5 (b): a recovered (at-floor) turn clears the episode and goes silent again", async () => {
  const { during, after } = await withTempHome("acpx-c327-", async () => {
    const record = pinnedRecord("opus");
    await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-5" });
    const during = captureStderr(() => printServedBelowFloorWarning(record, "text", false));
    // The next at-floor serve auto-clears the breadcrumb.
    await enforceModelFloorPostServe(record, { servedModel: "claude-opus-5" });
    const after = captureStderr(() => printServedBelowFloorWarning(record, "text", false));
    return { during, after };
  });

  assert.match(during, /served-model mismatch/);
  assert.equal(after, "", `a recovered session must go silent, got: ${after}`);
});

test("c327efb5 (b): a SECOND consecutive below-floor turn warns AGAIN (not debounced)", async () => {
  // The `.messages.ndjson` mirror debounces per episode because a parent agent
  // reads it once. This line is read by whoever ran THIS command — debouncing it
  // would hide the mismatch from the user whose turn is the second of an episode,
  // which is the exact silence this brick fixes.
  const { first, second } = await withTempHome("acpx-c327-", async () => {
    const record = pinnedRecord("opus");
    await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-5" });
    const first = captureStderr(() => printServedBelowFloorWarning(record, "text", false));
    await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-5" });
    const second = captureStderr(() => printServedBelowFloorWarning(record, "text", false));
    return { first, second };
  });

  assert.match(first, /served-model mismatch/);
  assert.match(second, /served-model mismatch/);
});
