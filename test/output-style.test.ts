// brick://874fee67 — output style as a per-session option.
//
// This field class fails by OMISSION ACROSS LEGS (brick://07dd62c9 found four
// drops on four different legs), so these tests drive the REAL transformation
// functions and the REAL FileSessionStore / session-index round-trips. A direct
// floor-function call or an in-memory-store assertion FALSE-PASSES every leg,
// which is exactly how the class kept slipping past the gate before.
//
// The index-entry pair gets a STRUCTURAL check rather than a hand-listed one:
// per the same lesson, a hand-maintained field list survives its own violation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  withInheritedOutputStyle,
  withInheritedReasoningEffort,
} from "../src/cli/session/inherited-metadata.js";
import { createFileSessionStore } from "../src/runtime.js";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import {
  mergeSessionOptions,
  persistSessionOptions,
  sessionOptionsFromRecord,
} from "../src/runtime/engine/session-options.js";
import { persistRequestedOutputStyle } from "../src/session/config-option-application.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import {
  mergeLatestDurableAcpxPreferences,
  setDesiredConfigOption,
} from "../src/session/mode-preference.js";
import {
  appliedOutputStyle,
  assertOutputStyleAdvertised,
  availableOutputStyles,
  desiredOutputStyle,
  normalizeOutputStyle,
  outputStyleChangePending,
  stampAppliedOutputStyle,
} from "../src/session/output-style.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import type { SessionAcpxState, SessionRecord } from "../src/types.js";
import {
  createRuntimeOptions,
  InMemorySessionStore,
  makeSessionRecord,
} from "./runtime-test-helpers.js";

const STYLE = "Operator Report";
// A second style whose name contains a space AND non-uniform casing, so any
// slugging or case-folding anywhere on the path shows up as a mismatch.
const OTHER_STYLE = "Nativai Probe Shared";

function styledRecord(overrides: Partial<SessionAcpxState> = {}): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "os-rec",
    acpSessionId: "os-sid",
    agentName: "claude",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {
      current_model_id: "opus",
      session_options: {
        model: "opus",
        effort: "high",
        output_style: STYLE,
        // A non-default profile: the CLI folds an explicit --subscription into
        // `.profile`, which is where the fleet majority of sessions store it, so
        // a default-sub fixture exercises only the minority path. `sub7` is a
        // REAL profile and the box default is `sub5` — verified with
        // `acpx profiles list`, because a fixture whose comment claims a fact
        // about the fleet should not invent the id (`sub6` does not exist).
        profile: "sub7",
      },
      desired_config_options: { effort: "high", outputStyle: STYLE },
      applied_output_style: STYLE,
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// The derived predicate (the whole state model)
// ---------------------------------------------------------------------------

test('normalize: absent and the literal "default" are the SAME state', () => {
  assert.equal(normalizeOutputStyle(undefined), normalizeOutputStyle("default"));
  // ...and neither is confused with a real style.
  assert.notEqual(normalizeOutputStyle(undefined), normalizeOutputStyle(STYLE));
});

test("normalize does NOT case-fold or slug (built-ins are not uniformly cased)", () => {
  assert.equal(normalizeOutputStyle("Explanatory"), "Explanatory");
  assert.equal(normalizeOutputStyle(OTHER_STYLE), OTHER_STYLE);
  // `default` is lowercase while the rest are capitalised; a validator that
  // lowercased, or a UI that title-cased, would break one end or the other.
  assert.notEqual(normalizeOutputStyle("Default"), normalizeOutputStyle("default"));
});

test("pending is FALSE when desired matches applied", () => {
  assert.equal(outputStyleChangePending(styledRecord()), false);
});

test("pending is TRUE when the desired style differs from what the query was built with", () => {
  const record = styledRecord({ applied_output_style: "Explanatory" });
  assert.equal(outputStyleChangePending(record), true);
});

test("pending is FALSE on a legacy record with neither field (back-compat)", () => {
  const record = makeSessionRecord({
    acpxRecordId: "legacy",
    acpSessionId: "legacy-sid",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: { session_options: { model: "opus" } },
  });
  // Absent desired vs absent applied → both normalize to "default" → not pending.
  // Getting this wrong would recycle the owner of EVERY unstyled session, forever.
  assert.equal(outputStyleChangePending(record), false);
});

test('pending is FALSE for an unstyled session whose applied was stamped "default"', () => {
  const record = styledRecord({
    session_options: { model: "opus" },
    applied_output_style: "default",
  });
  assert.equal(outputStyleChangePending(record), false);
});

// AC-TB4 — the case that distinguishes this model from an intent queue.
test("AC-TB4: setting the style BACK to what is applied clears pending (no recycle)", () => {
  const record = styledRecord({ applied_output_style: STYLE });
  setDesiredConfigOption(record, "outputStyle", "Explanatory");
  assert.equal(outputStyleChangePending(record), true, "changed away → pending");
  setDesiredConfigOption(record, "outputStyle", STYLE);
  assert.equal(
    outputStyleChangePending(record),
    false,
    "changed back → pending clears itself; an intent queue would still recycle here",
  );
});

// AC-TB5 — last-write-wins, no conflict state.
test("AC-TB5: a second change while pending simply replaces the desired value", () => {
  const record = styledRecord({ applied_output_style: "Explanatory" });
  setDesiredConfigOption(record, "outputStyle", "Learning");
  setDesiredConfigOption(record, "outputStyle", OTHER_STYLE);
  assert.equal(desiredOutputStyle(record), OTHER_STYLE);
  assert.equal(outputStyleChangePending(record), true);
});

test('stamp writes applied unconditionally, normalizing absent to "default"', () => {
  const record = styledRecord();
  stampAppliedOutputStyle(record, undefined);
  // NOT left absent: an absent applied on a live session is indistinguishable
  // from "unknown" and would force a spurious recycle.
  assert.equal(appliedOutputStyle(record), "default");
});

// ---------------------------------------------------------------------------
// Live/durable sync — the field's single most load-bearing edit
// ---------------------------------------------------------------------------

test("setDesiredConfigOption(outputStyle) writes BOTH the live and the durable layer", () => {
  const record = styledRecord({ session_options: { model: "opus" }, desired_config_options: {} });
  setDesiredConfigOption(record, "outputStyle", STYLE);
  assert.equal(record.acpx?.desired_config_options?.outputStyle, STYLE, "live layer");
  // Without the durable half, the live setter writes only the live layer and the
  // next owner respawn — which rebuilds session_options from the spawn flags —
  // silently reverts the style.
  assert.equal(record.acpx?.session_options?.output_style, STYLE, "durable layer");
});

test("clearing the desired option clears both layers", () => {
  const record = styledRecord();
  setDesiredConfigOption(record, "outputStyle", undefined);
  assert.equal(record.acpx?.desired_config_options?.outputStyle, undefined);
  assert.equal(record.acpx?.session_options?.output_style, undefined);
});

// ---------------------------------------------------------------------------
// The transform legs, each driven through its REAL function
// ---------------------------------------------------------------------------

test("leg: cloneSessionAcpxState preserves output_style AND applied_output_style", () => {
  const cloned = cloneSessionAcpxState(styledRecord().acpx);
  assert.equal(cloned?.session_options?.output_style, STYLE);
  // Dropped here, every turn's clone would report "no style applied" — which the
  // pending predicate reads as a pending change, i.e. a recycle per turn.
  assert.equal(cloned?.applied_output_style, STYLE);
  assert.equal(cloned?.session_options?.effort, "high"); // control
});

test("leg: cloneSessionOptions does not create an undefined own-key when unset", () => {
  const cloned = cloneSessionAcpxState({ session_options: { model: "opus" } });
  // Conditional spread, per the TE-Finding-#2 discipline: an absent value must
  // not become an own-key that deepStrictEqual / Object.keys can see.
  assert.equal(
    Object.prototype.hasOwnProperty.call(cloned?.session_options ?? {}, "output_style"),
    false,
  );
});

test("leg: mergeSessionOptions carries outputStyle forward and lets preferred win", () => {
  assert.equal(
    mergeSessionOptions({ outputStyle: OTHER_STYLE }, { outputStyle: STYLE })?.outputStyle,
    OTHER_STYLE,
  );
  assert.equal(mergeSessionOptions({}, { outputStyle: STYLE })?.outputStyle, STYLE);
});

test("leg: persistSessionOptions writes output_style, and it alone keeps the block alive", () => {
  const record = makeSessionRecord({
    acpxRecordId: "p",
    acpSessionId: "p",
    agentCommand: "claude",
    cwd: "/workspace",
    acpx: {},
  });
  persistSessionOptions(record, { outputStyle: STYLE });
  // output_style is a real user setting (unlike model_source, which is
  // subordinate to `model`), so it must be a PERSISTED_CONTENT_KEY — otherwise a
  // style-only session drops the whole session_options block on persist.
  assert.equal(record.acpx?.session_options?.output_style, STYLE);
});

test("leg: carry-forward keeps output_style across a respawn that omits it", () => {
  const record = styledRecord();
  // A respawn rebuilds session_options from the spawn flags, which do NOT carry a
  // style set later via `set outputStyle`.
  persistSessionOptions(record, { model: "opus" });
  assert.equal(record.acpx?.session_options?.output_style, STYLE);
});

test("leg: carry-forward does NOT override an explicit new value", () => {
  const record = styledRecord();
  persistSessionOptions(record, { model: "opus", outputStyle: OTHER_STYLE });
  assert.equal(record.acpx?.session_options?.output_style, OTHER_STYLE);
});

test("leg: sessionOptionsFromRecord reads output_style back out", () => {
  assert.equal(sessionOptionsFromRecord(styledRecord())?.outputStyle, STYLE);
});

test("leg: durable overlay lets a disk-side style change beat a stale turn snapshot", () => {
  // The in-flight turn's snapshot still holds the OLD style...
  const pending: SessionAcpxState = { session_options: { model: "opus", output_style: STYLE } };
  // ...while the store has the new one, written by `set outputStyle` mid-turn.
  const latest: SessionAcpxState = {
    session_options: { model: "opus", output_style: OTHER_STYLE },
  };
  const merged = mergeLatestDurableAcpxPreferences(pending, latest);
  assert.equal(merged?.session_options?.output_style, OTHER_STYLE);
});

test("leg: the overlay's paired PREDICATE fires for a style-ONLY change", () => {
  // hasLatestDurableSessionOptions gates whether the overlay runs at all. Miss it
  // and the overlay above never executes for a change that touches only the style
  // — the exact half-fix shape this pair is prone to.
  const pending: SessionAcpxState = { session_options: { output_style: STYLE } };
  const latest: SessionAcpxState = { session_options: { output_style: OTHER_STYLE } };
  const merged = mergeLatestDurableAcpxPreferences(pending, latest);
  assert.equal(merged?.session_options?.output_style, OTHER_STYLE);
});

// ---------------------------------------------------------------------------
// Real FileSessionStore round-trip (write → parse-on-load)
// ---------------------------------------------------------------------------

test("REAL FileSessionStore round-trip preserves output_style + applied_output_style", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-output-style-store-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const store = createFileSessionStore({ stateDir });
  await store.save(styledRecord());
  const loaded = await store.load("os-rec");
  assert.ok(loaded, "record must load");

  // serialize writes the whole acpx object, but parse reconstructs it field by
  // field from a whitelist — so a field parse.ts does not know is STRIPPED on
  // every disk load, i.e. on every queue-owner delivery and owner respawn.
  assert.equal(loaded.acpx?.session_options?.output_style, STYLE);
  assert.equal(loaded.acpx?.applied_output_style, STYLE);
  assert.equal(loaded.acpx?.desired_config_options?.outputStyle, STYLE);
  assert.equal(loaded.acpx?.session_options?.profile, "sub7"); // non-default-profile control
  assert.equal(loaded.acpx?.session_options?.effort, "high"); // control

  // And the predicate still reads correctly after a cold load — the property that
  // actually matters, rather than mere field presence.
  assert.equal(outputStyleChangePending(loaded), false);
});

test("REAL round-trip: a style set while a DIFFERENT style is applied stays pending", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-output-style-pending-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  const store = createFileSessionStore({ stateDir });
  await store.save(styledRecord({ applied_output_style: "Explanatory" }));
  const loaded = await store.load("os-rec");
  assert.ok(loaded);
  // AC-TB2's durability core: the pending state lives entirely in the record, so
  // it survives the owner dying at any moment.
  assert.equal(outputStyleChangePending(loaded), true);
});

// ---------------------------------------------------------------------------
// BOTH index-entry legs — structurally, not by hand-listed field
// ---------------------------------------------------------------------------

test("REAL session-index round-trip: projection and parser agree on EVERY field", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-output-style-index-"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const record = styledRecord({
    config_options: [
      {
        id: "outputStyle",
        name: "Output style",
        description: "Response role, tone and format",
        category: "mode",
        type: "select",
        currentValue: STYLE,
        // The SDK's real select shape: every option carries BOTH `value` and
        // `name`. Fixtures here use it verbatim — a `{value}`-only shortcut would
        // have been the convenient shape, not production's.
        options: [
          { value: "default", name: "Default" },
          { value: STYLE, name: STYLE },
          { value: OTHER_STYLE, name: OTHER_STYLE },
        ],
      },
    ],
  });
  const projected = toSessionIndexEntry(record, "os-rec.json");
  await writeSessionIndex(stateDir, { files: ["os-rec.json"], entries: [projected] });
  const index = await readSessionIndex(stateDir);
  const parsed = index?.entries[0];
  assert.ok(parsed, "index entry must parse back");

  // STRUCTURAL, not a field list: this compares the projection to what survives
  // the parser, so ANY field added to toSessionIndexEntry and forgotten in
  // parseIndexEntry fails here — including fields nobody thought to enumerate.
  // A hand-maintained list would survive its own violation.
  assert.deepEqual(
    parsed,
    projected,
    "parseIndexEntry dropped a field toSessionIndexEntry projects — an acpx-ui-written entry would be stripped on the next daemon rewrite",
  );

  // And the specific values, so a projection that silently emitted nothing at all
  // could not pass the structural check vacuously.
  assert.equal(parsed.outputStyleDesired, STYLE);
  assert.equal(parsed.outputStyleApplied, STYLE);
  assert.equal(parsed.outputStyleSupported, true);
});

test("index projection: support is THREE-valued and derived from the advertisement", () => {
  // Advertised → supported.
  assert.equal(
    toSessionIndexEntry(
      styledRecord({ config_options: [advertisedOption("outputStyle")] }),
      "f.json",
    ).outputStyleSupported,
    true,
  );
  // Advertises OTHER options but not this one → genuinely unsupported (codex).
  assert.equal(
    toSessionIndexEntry(styledRecord({ config_options: [advertisedOption("effort")] }), "f.json")
      .outputStyleSupported,
    false,
  );
  // Never captured config_options at all → UNKNOWN, and it must stay undefined.
  // Rendering unknown as "supported" gives a control that silently does nothing;
  // rendering it as "unsupported" hides a working feature.
  assert.equal(toSessionIndexEntry(styledRecord(), "f.json").outputStyleSupported, undefined);
});

// ---------------------------------------------------------------------------
// Validation — AC-5, the defence against a control that lies
// ---------------------------------------------------------------------------

// Minimal-but-REAL advertised option: `SessionConfigSelect` requires
// `currentValue` and `options`, and each option requires `name` as well as
// `value`. Building fixtures from the SDK types rather than from memory is what
// keeps these tests measuring production's shape.
function advertisedOption(id: string, values: string[] = []): SessionConfigOption {
  return {
    id,
    name: id,
    type: "select",
    currentValue: values[0] ?? "default",
    options: values.map((value) => ({ value, name: value })),
  };
}

const ADVERTISED: SessionConfigOption[] = [
  advertisedOption("outputStyle", ["default", "Explanatory", OTHER_STYLE]),
];

test("AC-5: a style outside the advertised list is REFUSED", () => {
  // Claude Code itself accepts this and echoes it back as the active style, so
  // this refusal is entirely ours — and it is the whole difference between a typo
  // and a session that reports a style it does not have.
  assert.throws(
    () => assertOutputStyleAdvertised(ADVERTISED, "NoSuchStyle", "claude"),
    /Unknown output style/,
  );
});

test("AC-5: an advertised style is accepted, spaces and casing intact", () => {
  assertOutputStyleAdvertised(ADVERTISED, OTHER_STYLE, "claude");
  assertOutputStyleAdvertised(ADVERTISED, "default", "claude");
});

test("AC-5: case differences are NOT waved through", () => {
  assert.throws(
    () => assertOutputStyleAdvertised(ADVERTISED, "explanatory", "claude"),
    /Unknown output style/,
  );
});

test("an agent that advertises no outputStyle option is refused as unsupported", () => {
  assert.throws(
    () => assertOutputStyleAdvertised([advertisedOption("effort")], STYLE, "codex"),
    /does not support output styles/,
  );
});

test("advertised-but-empty option list is accepted, not refused", () => {
  // An empty list means "this adapter did not tell us", not "no styles exist";
  // refusing everything on that basis would break a working feature.
  assertOutputStyleAdvertised([advertisedOption("outputStyle")], STYLE, "claude");
});

test("availableOutputStyles never invents a list", () => {
  assert.deepEqual(availableOutputStyles(ADVERTISED), ["default", "Explanatory", OTHER_STYLE]);
  assert.deepEqual(availableOutputStyles(undefined), []);
  assert.deepEqual(availableOutputStyles([advertisedOption("outputStyle")]), []);
});

// ---------------------------------------------------------------------------
// The creation flag — honest degradation
// ---------------------------------------------------------------------------

test("creation flag: writes nothing on an agent that does not advertise the option", () => {
  const record = makeSessionRecord({
    acpxRecordId: "codex-rec",
    acpSessionId: "codex-sid",
    agentName: "codex",
    agentCommand: "node /opt/codex-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {},
  });
  persistRequestedOutputStyle({
    record,
    outputStyle: STYLE,
    advertised: [advertisedOption("effort")],
    agentLabel: "codex",
  });
  // A silent no-op — no error, and crucially NO WRITE. Persisting a style for a
  // session that can never honour one is the failure this gate prevents.
  assert.equal(record.acpx?.session_options?.output_style, undefined);
  assert.equal(record.acpx?.desired_config_options?.outputStyle, undefined);
});

test("creation flag: persists both layers on an advertising agent", () => {
  const record = makeSessionRecord({
    acpxRecordId: "c",
    acpSessionId: "c",
    agentName: "claude",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {},
  });
  persistRequestedOutputStyle({
    record,
    outputStyle: OTHER_STYLE,
    advertised: ADVERTISED,
    agentLabel: "claude",
  });
  assert.equal(record.acpx?.session_options?.output_style, OTHER_STYLE);
  assert.equal(record.acpx?.desired_config_options?.outputStyle, OTHER_STYLE);
});

test("creation flag: a bogus style on an advertising agent throws rather than persisting", () => {
  const record = makeSessionRecord({
    acpxRecordId: "c2",
    acpSessionId: "c2",
    agentName: "claude",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {},
  });
  assert.throws(
    () =>
      persistRequestedOutputStyle({
        record,
        outputStyle: "NoSuchStyle",
        advertised: ADVERTISED,
        agentLabel: "claude",
      }),
    /Unknown output style/,
  );
  assert.equal(record.acpx?.session_options?.output_style, undefined, "nothing persisted");
});

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

test("inheritance: a child with no explicit style inherits the parent's", () => {
  assert.equal(withInheritedOutputStyle(undefined, STYLE), STYLE);
});

test("inheritance: an explicit child style always wins", () => {
  assert.equal(withInheritedOutputStyle(OTHER_STYLE, STYLE), OTHER_STYLE);
});

test("inheritance: no parent style leaves the child unset (box default governs)", () => {
  assert.equal(withInheritedOutputStyle(undefined, undefined), undefined);
  assert.equal(withInheritedOutputStyle(undefined, "   "), undefined);
});

test("inheritance: the helper behaves exactly like its effort sibling", () => {
  // Same rule, deliberately — output style being the single exception to the
  // spawn-property inheritance convention is what would need justifying.
  for (const [child, parent] of [
    [undefined, "a"],
    ["b", "a"],
    [undefined, undefined],
    ["b", undefined],
  ] as const) {
    assert.equal(
      withInheritedOutputStyle(child, parent),
      withInheritedReasoningEffort(child, parent),
    );
  }
});

// ---------------------------------------------------------------------------
// The fresh-create seed leg (found UNCOVERED by the mutation probe, not by review)
// ---------------------------------------------------------------------------
//
// A fresh-create respawn (reset_on_next_ensure / recover / resume-id mismatch)
// rebuilds the record from scratch, so the persist-time breadcrumb carry-forward
// has no prior session_options to read — the style has to be SEEDED from the
// prior on-disk record. Without it a style set via `set outputStyle` silently
// reverts across a TTL reap, which is the same class of silent revert the
// carry-forward exists for.
//
// SCOPE: these drive the real `ensureSession` path but through an in-memory
// store, so they prove the SEEDING DECISION only. The disk fidelity of the value
// they seed is covered separately by the real FileSessionStore round-trip above —
// an in-memory store never exercises parse and would false-pass that leg.

function freshCreateManager(store: InMemorySessionStore): AcpRuntimeManager {
  return new AcpRuntimeManager(createRuntimeOptions({ cwd: "/workspace", sessionStore: store }), {
    clientFactory: () =>
      ({
        initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        start: async () => {},
        close: async () => {},
        // Must ADVERTISE the option: support is derived from the advertisement,
        // so a fake that advertises nothing is a fake of an agent that does not
        // support styles — and the F3 strip would (correctly) drop the pin.
        createSession: async () => ({
          sessionId: "os-new-sid",
          agentSessionId: "os-agent",
          configOptions: [
            {
              id: "outputStyle",
              name: "Output style",
              type: "select",
              currentValue: "default",
              options: [
                { value: STYLE, name: STYLE },
                { value: OTHER_STYLE, name: OTHER_STYLE },
              ],
            },
          ],
        }),
        loadSession: async () => ({ agentSessionId: "unused" }),
        hasReusableSession: () => false,
        supportsLoadSession: () => true,
        supportsResumeSession: () => false,
        loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
        getAgentLifecycleSnapshot: () => ({ running: true }),
        prompt: async () => ({ stopReason: "end_turn" }),
        requestCancelActivePrompt: async () => false,
        hasActivePrompt: () => false,
        setSessionMode: async () => {},
        setSessionConfigOption: async () => {},
        clearEventHandlers: () => {},
        setEventHandlers: () => {},
      }) as never,
  });
}

function priorStyledRecord(
  sessionOptions: NonNullable<SessionRecord["acpx"]>["session_options"],
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "os-respawn",
    acpSessionId: "os-respawn-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
    acpx: { reset_on_next_ensure: true, session_options: sessionOptions },
  });
}

function ensureRespawn(
  manager: AcpRuntimeManager,
  sessionOptions?: Parameters<AcpRuntimeManager["ensureSession"]>[0]["sessionOptions"],
): Promise<SessionRecord> {
  return manager.ensureSession({
    sessionKey: "os-respawn",
    agent: "codex",
    mode: "persistent",
    sessionOptions,
  });
}

test("seed: a fresh-create respawn preserves output_style when the spawn flags omit it", async () => {
  const store = new InMemorySessionStore([
    priorStyledRecord({ output_style: STYLE, profile: "sub7" }),
  ]);
  const record = await ensureRespawn(freshCreateManager(store), { profile: "sub7" });
  assert.equal(record.acpx?.session_options?.output_style, STYLE);
  const saved = await store.load("os-respawn");
  assert.equal(saved?.acpx?.session_options?.output_style, STYLE);
});

test("seed: an explicit spawn --output-style still wins over the prior pin", async () => {
  const store = new InMemorySessionStore([
    priorStyledRecord({ output_style: STYLE, profile: "sub7" }),
  ]);
  const record = await ensureRespawn(freshCreateManager(store), {
    profile: "sub7",
    outputStyle: OTHER_STYLE,
  });
  assert.equal(record.acpx?.session_options?.output_style, OTHER_STYLE);
});

test("seed: a genuinely NEW session gets no output_style (the cascade governs)", async () => {
  const record = await ensureRespawn(freshCreateManager(new InMemorySessionStore()), {
    profile: "sub7",
  });
  // Absent must stay absent — writing "default" here would convert unset into an
  // explicit pin and permanently defeat any future box- or role-level default.
  assert.equal(record.acpx?.session_options?.output_style, undefined);
});

// ---------------------------------------------------------------------------
// F3 — an unsupported agent must record NOTHING (the TE's own control shape)
// ---------------------------------------------------------------------------
//
// THE SHIPPED BUG: `acpx sessions new --output-style X` against CODEX printed
// "[acpx] --output-style applies to claude; ignoring for agent codex" and then
// persisted output_style AND applied_output_style anyway. It said one thing to
// the operator and recorded another.
//
// Worse than untidiness because of WHICH field it corrupted: applied is "the
// style the current live query was built with" and is what the UI labels its
// chip from, precisely because it is our own action record rather than an
// untrustworthy harness readback. It asserted an action that never happened,
// with pending:false claiming the state was settled.
//
// The TE's control: create WITH and WITHOUT the flag, everything else equal, and
// assert the two records differ only where they legitimately should.

function codexManager(store: InMemorySessionStore): AcpRuntimeManager {
  return new AcpRuntimeManager(createRuntimeOptions({ cwd: "/workspace", sessionStore: store }), {
    clientFactory: () =>
      ({
        initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        start: async () => {},
        close: async () => {},
        // Codex advertises NO outputStyle option — support is derived from this
        // and nothing else, never from the agent name.
        createSession: async () => ({
          sessionId: "codex-sid",
          agentSessionId: "codex-agent",
          configOptions: [
            { id: "effort", name: "effort", type: "select", currentValue: "high", options: [] },
          ],
        }),
        loadSession: async () => ({ agentSessionId: "unused" }),
        hasReusableSession: () => false,
        supportsLoadSession: () => true,
        supportsResumeSession: () => false,
        loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
        getAgentLifecycleSnapshot: () => ({ running: true }),
        prompt: async () => ({ stopReason: "end_turn" }),
        requestCancelActivePrompt: async () => false,
        hasActivePrompt: () => false,
        setSessionMode: async () => {},
        setSessionConfigOption: async () => {},
        clearEventHandlers: () => {},
        setEventHandlers: () => {},
      }) as never,
  });
}

async function createCodexSession(withStyle: boolean): Promise<SessionRecord> {
  const store = new InMemorySessionStore();
  return await codexManager(store).ensureSession({
    sessionKey: `codex-${withStyle ? "styled" : "plain"}`,
    agent: "codex",
    mode: "persistent",
    sessionOptions: withStyle ? { outputStyle: STYLE } : {},
  });
}

test("F3: a codex session does NOT persist a style it was told is being ignored", async () => {
  const styled = await createCodexSession(true);
  assert.equal(
    styled.acpx?.session_options?.output_style,
    undefined,
    "acpx warned it was ignoring the flag — it must not then record it",
  );
});

test("F3: applied_output_style must never claim an action that did not happen", async () => {
  const styled = await createCodexSession(true);
  // `applied` is THE trustworthy field — the one the UI labels its chip from.
  // "default" is correct and expected here (stamp-unconditionally); the defect
  // was the non-default, provably-never-applied value.
  assert.equal(styled.acpx?.applied_output_style, "default");
  assert.equal(
    outputStyleChangePending(styled),
    false,
    "and pending must stay false — desired is absent, applied is the default",
  );
});

test("F3 CONTROL: with-flag and without-flag codex records are identical", async () => {
  const [withFlag, withoutFlag] = await Promise.all([
    createCodexSession(true),
    createCodexSession(false),
  ]);
  // The whole point of the control: passing a flag the agent cannot honour must
  // leave NO trace at all, so the two records agree on every style field.
  assert.equal(
    withFlag.acpx?.session_options?.output_style,
    withoutFlag.acpx?.session_options?.output_style,
  );
  assert.equal(withFlag.acpx?.applied_output_style, withoutFlag.acpx?.applied_output_style);
  assert.equal(
    withFlag.acpx?.desired_config_options?.outputStyle,
    withoutFlag.acpx?.desired_config_options?.outputStyle,
  );
});

test("F3: a CLAUDE session (which advertises the option) still persists normally", async () => {
  // The negative half of the control — proving the strip is scoped to the
  // unsupported case and has not simply broken the feature everywhere.
  const store = new InMemorySessionStore();
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/workspace", sessionStore: store }),
    {
      clientFactory: () =>
        ({
          initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
          start: async () => {},
          close: async () => {},
          createSession: async () => ({
            sessionId: "claude-sid",
            agentSessionId: "claude-agent",
            configOptions: [
              {
                id: "outputStyle",
                name: "Output style",
                type: "select",
                currentValue: "default",
                options: [{ value: STYLE, name: STYLE }],
              },
            ],
          }),
          loadSession: async () => ({ agentSessionId: "unused" }),
          hasReusableSession: () => false,
          supportsLoadSession: () => true,
          supportsResumeSession: () => false,
          loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
          getAgentLifecycleSnapshot: () => ({ running: true }),
          prompt: async () => ({ stopReason: "end_turn" }),
          requestCancelActivePrompt: async () => false,
          hasActivePrompt: () => false,
          setSessionMode: async () => {},
          setSessionConfigOption: async () => {},
          clearEventHandlers: () => {},
          setEventHandlers: () => {},
        }) as never,
    },
  );
  const record = await manager.ensureSession({
    sessionKey: "claude-styled",
    agent: "claude",
    mode: "persistent",
    sessionOptions: { outputStyle: STYLE },
  });
  assert.equal(record.acpx?.session_options?.output_style, STYLE);
});
