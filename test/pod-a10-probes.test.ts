import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveAgentCommand } from "../src/agent-registry.js";
import { warmCatalogueInBackground } from "../src/models/catalogue-warm.js";
import {
  claudeAdvertisementNeedsProbe,
  ensureClaudeAdvertisement,
  currentClaudeAdvertKey,
} from "../src/models/claude-advertisement.js";
import { classifyArgv } from "../src/pod/command-classes.js";
import type { PlacementDecision } from "../src/pod/placement-step.js";
import {
  admissionBusyRefusal,
  agentCapRefusal,
  podStartingRefusal,
} from "../src/pod/pod-refusal.js";
import {
  newestRecordAdvertisement,
  peekAgentStartedAt,
  RECORD_ADVERTISEMENT_MAX_READS,
  scanHeadForStart,
  START_PEEK_BYTES,
  type RecordAdvertisement,
} from "../src/pod/probe-records.js";
import type { RoutedCallOptions } from "../src/pod/routed-call.js";
import {
  dispatchUtility,
  deadlineMsFor,
  flagValue,
  RECORD_SERVED_PATHS,
  utilityKeyFor,
  UTILITY_PROBE_DEADLINE_MS,
  UTILITY_RUN_DEADLINE_MS,
  UTILITY_TIMEOUT_GRACE_MS,
  type UtilityDeps,
} from "../src/pod/utility-branch.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import type { SessionRecord } from "../src/types.js";
import { startFakeApiServer, type PodSeed } from "./pod-kit/fake-apiserver.js";
import { startFakeBroker, type BrokerStatus } from "./pod-kit/fake-broker.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

// Block A10 (brick a68c45a9): probes from records, the utility pod as a one-shot's only start (A-7),
// no detached warm in pod mode, the exec / flow rules. Unit rows with injected dependencies, then the
// REAL CLI in pod mode (A1's seam) against X1's kit fakes (broker, kube API).

const CLAUDE = "node /opt/claude-agent-acp/release-2/dist/index.js";
const CLAUDE_OLD = "node /opt/claude-agent-acp/release-1/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "a10-probes-"));

const styleOption = (...values: string[]) => ({
  id: "outputStyle",
  name: "Output style",
  type: "select" as const,
  currentValue: "default",
  options: values.map((value) => ({ value, name: value })),
});
const modelOption = (...values: string[]) => ({
  id: "model",
  name: "Model",
  type: "select" as const,
  currentValue: values[0] ?? "default",
  options: values.map((value) => ({
    value,
    name: value.toUpperCase(),
    description: `${value} · x`,
  })),
});

// ───────────────────────── newestRecordAdvertisement ─────────────────────────

type Seed = {
  id: string;
  command: string;
  lastUsedAt: string;
  acpSessionId?: string;
  kind?: "session" | "subagent";
  configOptions?: unknown[];
  models?: string[];
  profile?: string;
  startedAt?: string;
};

function store(seeds: Seed[]) {
  const loaded: string[] = [];
  const entries = async () =>
    seeds.map((seed) => ({
      file: `${seed.id}.json`,
      acpxRecordId: seed.id,
      acpSessionId: seed.acpSessionId ?? `acp-${seed.id}`,
      agentCommand: seed.command,
      cwd: "/workspace",
      closed: false,
      lastUsedAt: seed.lastUsedAt,
      ...(seed.kind ? { kind: seed.kind } : {}),
    }));
  const load = async (id: string): Promise<SessionRecord> => {
    loaded.push(id);
    const seed = seeds.find((s) => s.id === id);
    assert.ok(seed);
    return {
      ...(seed.startedAt ? { agentStartedAt: seed.startedAt } : {}),
      acpx: {
        config_options: seed.configOptions,
        available_models: seed.models,
        current_model_id: seed.models?.[0],
        ...(seed.profile ? { session_options: { profile: seed.profile } } : {}),
      },
    } as unknown as SessionRecord;
  };
  // The ranking's own read: the start time alone. Tracks how many run at once and how many in all.
  const peeked: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const peekStart = async (entry: { acpxRecordId: string }): Promise<string | undefined> => {
    peeked.push(entry.acpxRecordId);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return seeds.find((seed) => seed.id === entry.acpxRecordId)?.startedAt;
  };
  return { entries, load, loaded, peekStart, peeked, maxInFlight: () => maxInFlight };
}

test("records: the NEWEST session of the same harness that carries the advertisement answers; its id is named", async () => {
  const s = store([
    {
      id: "old",
      command: CLAUDE,
      lastUsedAt: "2026-11-01T00:00:00Z",
      configOptions: [styleOption("a")],
    },
    {
      id: "new",
      command: CLAUDE,
      lastUsedAt: "2026-11-20T00:00:00Z",
      configOptions: [styleOption("b")],
    },
  ]);
  const found = await newestRecordAdvertisement(
    { agentCommand: CLAUDE, need: "config_options" },
    { entries: s.entries as never, load: s.load, peekStart: s.peekStart },
  );
  assert.equal(found?.recordId, "new");
  // both are peeked for the ranking; only the one that answers is loaded in full
  assert.deepEqual(s.peeked.toSorted(), ["new", "old"]);
  assert.deepEqual(s.loaded, ["new"]);
});

test("records (negative): a sleeping record, a sub-agent, another harness and a record without the advertisement never answer", async () => {
  const s = store([
    {
      id: "sleeping",
      command: CLAUDE,
      lastUsedAt: "2026-11-22T00:00:00Z",
      acpSessionId: "",
      configOptions: [styleOption("x")],
    },
    {
      id: "sub",
      command: CLAUDE,
      lastUsedAt: "2026-11-21T10:00:00Z",
      kind: "subagent",
      configOptions: [styleOption("x")],
    },
    {
      id: "codex",
      command: CODEX,
      lastUsedAt: "2026-11-21T09:00:00Z",
      configOptions: [styleOption("x")],
    },
    { id: "bare", command: CLAUDE, lastUsedAt: "2026-11-21T08:00:00Z", configOptions: [] },
  ]);
  const deps = { entries: s.entries as never, load: s.load, peekStart: s.peekStart };
  assert.equal(
    await newestRecordAdvertisement({ agentCommand: CLAUDE, need: "config_options" }, deps),
    undefined,
  );
  assert.deepEqual(s.loaded, ["bare"], "only the one candidate that could qualify was opened");
  // an agent no detector knows has no harness, so no record is "of its harness"
  assert.equal(
    await newestRecordAdvertisement(
      { agentCommand: "node ./mystery.js", need: "config_options" },
      deps,
    ),
    undefined,
  );
});

test("records: adapter_match — the very command the box launches is `exact`; a different command string of the same harness (an adapter deployed since) is `harness`", async () => {
  const s = store([
    {
      id: "r",
      command: CLAUDE_OLD,
      lastUsedAt: "2026-11-20T00:00:00Z",
      configOptions: [styleOption("a")],
    },
  ]);
  const deps = { entries: s.entries as never, load: s.load, peekStart: s.peekStart };
  assert.equal(
    (await newestRecordAdvertisement({ agentCommand: CLAUDE_OLD, need: "config_options" }, deps))
      ?.match,
    "exact",
  );
  assert.equal(
    (await newestRecordAdvertisement({ agentCommand: CLAUDE, need: "config_options" }, deps))
      ?.match,
    "harness",
  );
});

test("records: --profile narrows the model list to records started under that profile; without it any record answers", async () => {
  const s = store([
    {
      id: "other",
      command: CODEX,
      lastUsedAt: "2026-11-21T00:00:00Z",
      models: ["gpt-a"],
      profile: "p1",
    },
    {
      id: "mine",
      command: CODEX,
      lastUsedAt: "2026-11-20T00:00:00Z",
      models: ["gpt-b"],
      profile: "p2",
    },
  ]);
  const deps = { entries: s.entries as never, load: s.load, peekStart: s.peekStart };
  assert.equal(
    (
      await newestRecordAdvertisement(
        { agentCommand: CODEX, need: "available_models", profile: "p2" },
        deps,
      )
    )?.recordId,
    "mine",
  );
  assert.equal(
    (await newestRecordAdvertisement({ agentCommand: CODEX, need: "available_models" }, deps))
      ?.recordId,
    "other",
  );
  assert.equal(
    await newestRecordAdvertisement(
      { agentCommand: CODEX, need: "available_models", profile: "nobody" },
      deps,
    ),
    undefined,
  );
});

test("records: at most RECORD_ADVERTISEMENT_MAX_READS candidates are opened before 'records cannot answer'", async () => {
  const seeds: Seed[] = Array.from({ length: RECORD_ADVERTISEMENT_MAX_READS + 10 }, (_, i) => ({
    id: `r${i}`,
    command: CLAUDE,
    lastUsedAt: `2026-11-01T00:00:${String(i).padStart(2, "0")}Z`,
    configOptions: [],
  }));
  const s = store(seeds);
  assert.equal(
    await newestRecordAdvertisement(
      { agentCommand: CLAUDE, need: "config_options" },
      { entries: s.entries as never, load: s.load, peekStart: s.peekStart },
    ),
    undefined,
  );
  assert.equal(s.loaded.length, RECORD_ADVERTISEMENT_MAX_READS);
});

test("probe speed: the pool is bounded at 25 PEEKS, 8 at a time; full records load in RANK order and stop at the first that answers", async () => {
  // r15..r39 are the pool (newest use first); r30 started last but advertises nothing, r20 started next.
  const seeds: Seed[] = Array.from({ length: RECORD_ADVERTISEMENT_MAX_READS + 15 }, (_, i) => ({
    id: `r${i}`,
    command: CLAUDE,
    lastUsedAt: `2026-11-01T00:${String(i).padStart(2, "0")}:00Z`,
    configOptions: i === 20 ? [styleOption("answer")] : [],
    ...(i === 30 ? { startedAt: "2026-11-22T00:00:00Z" } : {}),
    ...(i === 20 ? { startedAt: "2026-11-21T00:00:00Z" } : {}),
    ...(i === 5 ? { startedAt: "2026-11-23T00:00:00Z" } : {}), // outside the pool: never even peeked
  }));
  const s = store(seeds);
  const found = await newestRecordAdvertisement(
    { agentCommand: CLAUDE, need: "config_options" },
    { entries: s.entries as never, load: s.load, peekStart: s.peekStart },
  );
  assert.equal(found?.recordId, "r20");
  assert.equal(s.peeked.length, RECORD_ADVERTISEMENT_MAX_READS, "25 peeks, no more");
  assert.ok(!s.peeked.includes("r5"), "a record outside the pool is not read at all");
  assert.ok(s.maxInFlight() <= 8, `at most 8 at once (saw ${s.maxInFlight()})`);
  assert.ok(s.maxInFlight() > 1, "and they really overlap (positive control for the bound)");
  assert.deepEqual(s.loaded, ["r30", "r20"], "rank order, and the 23 others never load in full");
});

test("probe speed: `agent_started_at` is read from the first bytes — pinned to the serializer's key order, with a real record file", async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "peek-"));
  const record = makeSessionRecord({
    acpxRecordId: "99999999-9999-4999-8999-999999999991",
    acpSessionId: "acp-peek",
    agentCommand: CLAUDE,
    cwd: "/workspace",
    agentStartedAt: "2026-11-20T10:00:00.000Z",
    acpx: { config_options: Array.from({ length: 4000 }, (_, i) => styleOption(`v${i}`)) } as never,
  });
  const onDisk = JSON.stringify(serializeSessionRecordForDisk(record, { messages: "split-tail" }));
  const at = (key: string) => onDisk.indexOf(`"${key}":`);
  assert.ok(
    onDisk.length > 10 * START_PEEK_BYTES,
    "a large record: the advertisement is far past the peek",
  );
  assert.ok(
    at("agent_started_at") > 0 && at("agent_started_at") < at("messages"),
    "field before messages",
  );
  assert.ok(at("messages") < at("acpx"), "and messages before the acpx object");
  assert.ok(
    at("messages") < START_PEEK_BYTES,
    "so the peek always reaches `messages` on a normal record",
  );
  const file = path.join(dir, "with.json");
  fs.writeFileSync(file, onDisk);
  assert.equal(await peekAgentStartedAt(file), "2026-11-20T10:00:00.000Z");
  // no field → undefined (ranks last), not an error
  const bare = path.join(dir, "bare.json");
  fs.writeFileSync(
    bare,
    JSON.stringify(
      serializeSessionRecordForDisk(
        { ...record, agentStartedAt: undefined },
        { messages: "split-tail" },
      ),
    ),
  );
  assert.equal(await peekAgentStartedAt(bare), undefined);
  // a record whose key order is NOT the serializer's (the field past the peek, no `messages` before it) is found by the fallback parse
  const odd = path.join(dir, "odd.json");
  fs.writeFileSync(
    odd,
    JSON.stringify({
      padding: "x".repeat(2 * START_PEEK_BYTES),
      agent_started_at: "2026-11-19T00:00:00.000Z",
    }),
  );
  assert.equal(await peekAgentStartedAt(odd), "2026-11-19T00:00:00.000Z");
  // a missing or unparsable file is "no start time", never a throw
  assert.equal(await peekAgentStartedAt(path.join(dir, "absent.json")), undefined);
  const junk = path.join(dir, "junk.json");
  fs.writeFileSync(junk, "x".repeat(2 * START_PEEK_BYTES));
  assert.equal(await peekAgentStartedAt(junk), undefined);
});

// ---- brick c2b7358d, R1: the peek accepts `agent_started_at` only as a key of the record's OWN top-level object ----

function peekOf(text: string): Promise<string | undefined> {
  const dir = fs.mkdtempSync(path.join(ROOT, "peek-r1-"));
  const file = path.join(dir, "record.json");
  fs.writeFileSync(file, text);
  return peekAgentStartedAt(file);
}

const REAL_START = "2026-11-19T00:00:00.000Z";
const DECOY = "2099-01-01T00:00:00.000Z";

test("R1a: a NESTED `agent_started_at` is never the record's start — in a tool call's input, in `agent_capabilities._meta`, or inside a string — and with no top-level one the record ranks last", async () => {
  const bodies: string[] = [
    // a nested object in the head, no top-level field; messages follow
    JSON.stringify({
      schema: "x",
      agent_capabilities: { _meta: { agent_started_at: DECOY } },
      messages: [{ tool_use: { input: { agent_started_at: DECOY } } }],
      acpx: {},
    }),
    // the same inside an ARRAY element's object, before the top-level keys end
    JSON.stringify({ items: [{ agent_started_at: DECOY }], acpx: {} }),
    // an escaped copy inside a string value
    JSON.stringify({ title: `x "agent_started_at": "${DECOY}" y`, acpx: {} }),
  ];
  for (const text of bodies) {
    assert.equal(await peekOf(text), undefined, text.slice(0, 80));
  }
  // The decoy is really in the head (so the old text scan WOULD have read it): positive control for the rows.
  assert.ok(bodies[0]?.includes(`"agent_started_at":"${DECOY}"`));
});

test("R1a: a nested decoy BEFORE the real top-level field does not hide it; a decoy AFTER does not replace it", async () => {
  assert.equal(
    await peekOf(
      JSON.stringify({
        a: { agent_started_at: DECOY },
        agent_started_at: REAL_START,
        messages: [],
      }),
    ),
    REAL_START,
  );
  assert.equal(
    await peekOf(
      JSON.stringify({ agent_started_at: REAL_START, messages: [{ agent_started_at: DECOY }] }),
    ),
    REAL_START,
  );
  // braces and quotes inside strings do not move the depth
  assert.equal(
    await peekOf(
      JSON.stringify({
        title: '}{ "agent_started_at": "' + DECOY + '" [[',
        agent_started_at: REAL_START,
      }),
    ),
    REAL_START,
  );
});

test("R1b: a top-level `agent_started_at` that comes AFTER a large `messages` (past the peek) is found, not ranked last — `messages` is not conclusive", async () => {
  const big = JSON.stringify({
    messages: [{ text: "x".repeat(3 * START_PEEK_BYTES) }],
    agent_started_at: REAL_START,
  });
  assert.ok(big.indexOf("agent_started_at") > START_PEEK_BYTES, "the key lies past the peek");
  assert.equal(await peekOf(big), REAL_START);
  // a normal record (start before messages) is still settled by the head: its tail is never parsed
  const settled = `{"agent_started_at":"${REAL_START}","messages":["${"y".repeat(3 * START_PEEK_BYTES)}`; // torn tail
  assert.equal(
    await peekOf(settled),
    REAL_START,
    "found in the head — a full parse would have thrown",
  );
  // The same torn record with the field past the peek is NOT found (the full parse fails) — and never throws.
  assert.equal(await peekOf(`{"messages":["${"y".repeat(3 * START_PEEK_BYTES)}`), undefined);
});

test("R1: a key straddling the peek boundary, a non-string value and an empty one are handled", async () => {
  for (const pad of [START_PEEK_BYTES - 40, START_PEEK_BYTES - 20, START_PEEK_BYTES - 5]) {
    const text = JSON.stringify({ padding: "p".repeat(pad), agent_started_at: REAL_START });
    assert.equal(await peekOf(text), REAL_START, `pad ${pad}`);
  }
  assert.equal(await peekOf(JSON.stringify({ agent_started_at: null })), undefined);
  assert.equal(await peekOf(JSON.stringify({ agent_started_at: 5 })), undefined);
  assert.equal(await peekOf(JSON.stringify({ agent_started_at: "" })), undefined);
  assert.equal(await peekOf("not json at all"), undefined);
});

test("R1 the head scan itself: found / absent / unsure, with the depth rule", () => {
  assert.deepEqual(scanHeadForStart(`{"agent_started_at":"${REAL_START}"}`, true), {
    kind: "found",
    value: REAL_START,
  });
  assert.deepEqual(scanHeadForStart('{"a":1}', true), { kind: "absent" });
  assert.deepEqual(scanHeadForStart('{"a":{"agent_started_at":"x"}}', true), { kind: "absent" });
  assert.deepEqual(scanHeadForStart('{"a":1', false), { kind: "unsure" }, "the head ended first");
  assert.deepEqual(
    scanHeadForStart('{"a":1}', false),
    { kind: "unsure" },
    "a head that is not the whole file cannot say absent",
  );
  assert.deepEqual(scanHeadForStart('{"agent_star', false), { kind: "unsure" });
  assert.deepEqual(scanHeadForStart("", true), { kind: "unsure" });
});

test("round 2 / F-A: a Codex record with NO profile (what a default-profile session writes) answers --profile <the default>; an explicit OTHER profile does not; a no-profile record answers nothing when the asked profile is not the default", async () => {
  const s = store([
    { id: "plain", command: CODEX, lastUsedAt: "2026-11-21T00:00:00Z", models: ["g[low]"] },
    {
      id: "other",
      command: CODEX,
      lastUsedAt: "2026-11-22T00:00:00Z",
      models: ["x[low]"],
      profile: "elsewhere",
    },
  ]);
  const base = { entries: s.entries as never, load: s.load, peekStart: s.peekStart };
  const query = { agentCommand: CODEX, need: "available_models" as const, profile: "codexgpt" };
  // codexgpt IS what "no profile" means here → the newer explicit-other record is skipped, the plain one serves
  const served = await newestRecordAdvertisement(query, {
    ...base,
    noProfileMatches: (p) => p === "codexgpt",
  });
  assert.equal(served?.recordId, "plain");
  // negative: asked for another profile than the default → the plain record must NOT answer it
  assert.equal(
    await newestRecordAdvertisement(
      { ...query, profile: "someone" },
      { ...base, noProfileMatches: (p) => p === "codexgpt" },
    ),
    undefined,
  );
  // negative: a box where no profile means "nothing matches" serves only explicit-profile records
  assert.equal(
    await newestRecordAdvertisement(query, { ...base, noProfileMatches: () => false }),
    undefined,
  );
  // an explicit profile equal to the asked one always answers, whatever the default
  assert.equal(
    (
      await newestRecordAdvertisement(
        { ...query, profile: "elsewhere" },
        { ...base, noProfileMatches: () => false },
      )
    )?.recordId,
    "other",
  );
});

test("rank by agent_started_at: a session that started BEFORE an update does not look new although it was used last; a record with no start time ranks last and is still served when it is the only one", async () => {
  const s = store([
    {
      id: "long-running",
      command: CLAUDE,
      lastUsedAt: "2026-11-22T00:00:00Z", // used a minute ago …
      startedAt: "2026-11-01T00:00:00Z", // … but its adapter started three weeks ago
      configOptions: [styleOption("old")],
    },
    {
      id: "recent-start",
      command: CLAUDE,
      lastUsedAt: "2026-11-15T00:00:00Z",
      startedAt: "2026-11-20T00:00:00Z",
      configOptions: [styleOption("new")],
    },
    {
      id: "no-start-time",
      command: CLAUDE,
      lastUsedAt: "2026-11-22T12:00:00Z", // the newest use of all
      configOptions: [styleOption("unknown")],
    },
  ]);
  const query = { agentCommand: CLAUDE, need: "config_options" as const };
  const served = await newestRecordAdvertisement(query, {
    entries: s.entries as never,
    load: s.load,
    peekStart: s.peekStart,
  });
  assert.equal(served?.recordId, "recent-start");
  assert.equal(served?.agentStartedAt, "2026-11-20T00:00:00Z");
  assert.equal(
    served?.lastUsedAt,
    "2026-11-15T00:00:00Z",
    "record_last_used_at stays the record's own",
  );
  // negative twin: with the start times swapped the other record wins — the order is the start time
  const swapped = store([
    {
      id: "a",
      command: CLAUDE,
      lastUsedAt: "2026-11-01T00:00:00Z",
      startedAt: "2026-11-20T00:00:00Z",
      configOptions: [styleOption("x")],
    },
    {
      id: "b",
      command: CLAUDE,
      lastUsedAt: "2026-11-22T00:00:00Z",
      startedAt: "2026-11-02T00:00:00Z",
      configOptions: [styleOption("y")],
    },
  ]);
  assert.equal(
    (
      await newestRecordAdvertisement(query, {
        entries: swapped.entries as never,
        load: swapped.load,
        peekStart: swapped.peekStart,
      })
    )?.recordId,
    "a",
  );
  // a record without the field alone is an answer — without a start time, and never ahead of one that has it
  const only = store([
    {
      id: "only",
      command: CLAUDE,
      lastUsedAt: "2026-11-22T12:00:00Z",
      configOptions: [styleOption("z")],
    },
  ]);
  const alone = await newestRecordAdvertisement(query, {
    entries: only.entries as never,
    load: only.load,
    peekStart: only.peekStart,
  });
  assert.equal(alone?.recordId, "only");
  assert.equal(alone?.agentStartedAt, undefined);
  // ties on the start time fall back to the newest use
  const tie = store([
    {
      id: "t1",
      command: CLAUDE,
      lastUsedAt: "2026-11-10T00:00:00Z",
      startedAt: "2026-11-05T00:00:00Z",
      configOptions: [styleOption("x")],
    },
    {
      id: "t2",
      command: CLAUDE,
      lastUsedAt: "2026-11-12T00:00:00Z",
      startedAt: "2026-11-05T00:00:00Z",
      configOptions: [styleOption("y")],
    },
  ]);
  assert.equal(
    (
      await newestRecordAdvertisement(query, {
        entries: tie.entries as never,
        load: tie.load,
        peekStart: tie.peekStart,
      })
    )?.recordId,
    "t2",
  );
});

test("rank by agent_started_at never lifts a `harness` record over an `exact` one: the tier comes first", async () => {
  const s = store([
    {
      id: "exact-old-start",
      command: CLAUDE,
      lastUsedAt: "2026-11-01T00:00:00Z",
      startedAt: "2026-10-01T00:00:00Z",
      configOptions: [styleOption("e")],
    },
    {
      id: "rig-new-start",
      command: "node /workspace/projects/claude-agent-acp/sdk-1/dist/index.js",
      lastUsedAt: "2026-11-22T00:00:00Z",
      startedAt: "2026-11-22T00:00:00Z",
      configOptions: [styleOption("r")],
    },
  ]);
  const served = await newestRecordAdvertisement(
    { agentCommand: CLAUDE, need: "config_options" },
    { entries: s.entries as never, load: s.load, peekStart: s.peekStart },
  );
  assert.equal(served?.recordId, "exact-old-start");
  assert.equal(served?.match, "exact");
});

test("claude advertisement from records: an `exact` record WITHOUT agent_started_at is `stale`, never fresh; with it, `fresh` and the start time is on the status", async () => {
  const where = claudeAdvertDir();
  const unknownAge = await ensureClaudeAdvertisement({
    ...where,
    env: {},
    mode: "never",
    servedFromRecords: () => true,
    recordAdvertisement: async () => recordOf("exact", null),
  });
  assert.equal(unknownAge.status.state, "stale");
  assert.equal(unknownAge.status.recordAgentStartedAt, undefined);
  const known = await ensureClaudeAdvertisement({
    ...where,
    env: {},
    mode: "never",
    servedFromRecords: () => true,
    recordAdvertisement: async () => recordOf("exact"),
  });
  assert.equal(known.status.state, "fresh");
  assert.equal(known.status.recordAgentStartedAt, "2026-11-20T00:00:00.000Z");
});

test("claude advertisement from records: `adapterMatch` says exact / harness beside `state` — an exact record without agent_started_at is stale AND exact; a harness record is harness; no record served leaves the key absent", async () => {
  const where = claudeAdvertDir();
  const served = (found: ReturnType<typeof recordOf>) =>
    ensureClaudeAdvertisement({
      ...where,
      env: {},
      mode: "never",
      servedFromRecords: () => true,
      recordAdvertisement: async () => found,
    });
  // the case atrium could not tell apart: stale because the age is unknown, yet the box's own command
  const exactNoStart = await served(recordOf("exact", null));
  assert.equal(exactNoStart.status.state, "stale");
  assert.equal(exactNoStart.status.adapterMatch, "exact");
  assert.equal(exactNoStart.status.recordAgentStartedAt, undefined);
  // an exact record with a start: fresh and exact (the existing values of `state` are unchanged)
  const exactKnown = await served(recordOf("exact"));
  assert.equal(exactKnown.status.state, "fresh");
  assert.equal(exactKnown.status.adapterMatch, "exact");
  // a harness record: stale (always) and harness — with or without a start
  for (const startedAt of [undefined, null] as const) {
    const harness = await served(
      startedAt === null ? recordOf("harness", null) : recordOf("harness"),
    );
    assert.equal(harness.status.state, "stale");
    assert.equal(harness.status.adapterMatch, "harness");
  }
  // no record served: the key is ABSENT (not null, not empty) and `state` is whatever it was
  const none = await ensureClaudeAdvertisement({
    ...where,
    env: {},
    mode: "never",
    servedFromRecords: () => true,
    recordAdvertisement: async () => undefined,
  });
  assert.equal("adapterMatch" in none.status, false);
  assert.equal(none.status.state, "none");
  // and it survives the JSON the catalogue prints
  assert.equal(JSON.parse(JSON.stringify(exactNoStart.status)).adapterMatch, "exact");
});

test("round 2 / F-B + F-G: a record of the box's own adapter command answers even when a NEWER record of another command (a dev or rig adapter) exists — a newer rig record never hides the deployed adapter's output styles", async () => {
  const s = store([
    {
      id: "deployed",
      command: CLAUDE,
      lastUsedAt: "2026-11-10T00:00:00Z",
      configOptions: [styleOption("default", "Explanatory")],
    },
    {
      id: "rig",
      command: "node /workspace/projects/claude-agent-acp/sdk-0.3.325/dist/index.js",
      lastUsedAt: "2026-11-22T00:00:00Z",
      configOptions: [modelOption("opus")],
    },
  ]);
  const found = await newestRecordAdvertisement(
    { agentCommand: CLAUDE, need: "config_options" },
    { entries: s.entries as never, load: s.load, peekStart: s.peekStart },
  );
  assert.equal(found?.recordId, "deployed");
  assert.equal(found?.match, "exact");
  assert.deepEqual(s.loaded, ["deployed"], "the newer rig record is not even opened");
  // control: with no record of the box's own command the rig record is the (labelled) answer
  const only = store([
    {
      id: "rig",
      command: CLAUDE_OLD,
      lastUsedAt: "2026-11-22T00:00:00Z",
      configOptions: [modelOption("opus")],
    },
  ]);
  const fallback = await newestRecordAdvertisement(
    { agentCommand: CLAUDE, need: "config_options" },
    { entries: only.entries as never, load: only.load, peekStart: only.peekStart },
  );
  assert.equal(fallback?.match, "harness");
});

test("round 2 / F-F: a utility pod's refusals say neither session nor message; a session's keep their wording; `tokenLine` is in every pod-plane refusal's JSON detail", () => {
  const cap = agentCapRefusal({ live: 5, cap: 5, box: "devbox", why: "cap" });
  assert.doesNotMatch(cap.capacityRefusal.message ?? "", /session|message|queued/i);
  assert.match(cap.capacityRefusal.message ?? "", /utility pod/);
  assert.equal(cap.capacityRefusal.tokenLine, cap.stderrLine);
  const busy = admissionBusyRefusal({ utility: true });
  assert.doesNotMatch(busy.capacityRefusal.message ?? "", /session|message|queued/i);
  assert.match(busy.capacityRefusal.message ?? "", /utility pod/);
  assert.equal(busy.capacityRefusal.tokenLine, busy.stderrLine);
  assert.match(busy.stderrLine, /^acpx: REFUSED reason=admission_busy /);
  const starting = podStartingRefusal({ phase: "starting" });
  assert.equal(starting.capacityRefusal.tokenLine, starting.stderrLine);
  // negative control: a session's wake keeps the session wording
  assert.match(
    agentCapRefusal({ live: 5, cap: 5, box: "devbox", why: "cap", wake: "r1" }).capacityRefusal
      .message ?? "",
    /message stays queued/,
  );
  assert.match(
    admissionBusyRefusal().capacityRefusal.message ?? "",
    /session's agent pod[\s\S]*message stays queued/,
  );
  assert.match(
    podStartingRefusal({ phase: "starting", wake: "r1" }).capacityRefusal.message ?? "",
    /session's agent pod/,
  );
});

// ───────────────────────── the Claude advertisement, with no probe ─────────────────────────

function claudeAdvertDir() {
  const dir = fs.mkdtempSync(path.join(ROOT, "advert-"));
  return {
    cachePath: path.join(dir, "claude-advertisement.json"),
    runtimeInfoPath: path.join(dir, "none.json"),
  };
}

const recordOf = (
  match: "exact" | "harness",
  started: string | null = "2026-11-20T00:00:00.000Z",
): RecordAdvertisement => ({
  recordId: "rec-1",
  agentCommand: CLAUDE,
  lastUsedAt: "2026-11-21T00:00:00.000Z",
  agentStartedAt: started ?? undefined,
  match,
  configOptions: [modelOption("opus", "sonnet")] as never,
  availableModels: [],
  currentModelId: undefined,
});

test("claude advertisement where probes are served from records: NO probe runs whatever the mode (force, if-needed, never); the names come from the newest Claude record", async () => {
  for (const mode of ["force", "if-needed", "never"] as const) {
    const where = claudeAdvertDir();
    const view = await ensureClaudeAdvertisement({
      ...where,
      env: {},
      mode,
      servedFromRecords: () => true,
      recordAdvertisement: async () => recordOf("exact"),
      probe: async () => {
        throw new Error("a probe ran on the control pod in pod mode");
      },
    });
    assert.equal(view.status.state, "fresh", mode);
    assert.equal(view.status.source, "records");
    assert.deepEqual(
      view.snapshot?.options.map((o) => o.value),
      ["opus", "sonnet"],
    );
    assert.equal(fs.existsSync(where.cachePath), false, "read-only: nothing is cached");
  }
});

test("claude advertisement from records: a record of another adapter command is `stale`; no record at all is `none`; with no seam the probe still runs (pod mode off)", async () => {
  const where = claudeAdvertDir();
  const stale = await ensureClaudeAdvertisement({
    ...where,
    env: {},
    mode: "force",
    servedFromRecords: () => true,
    recordAdvertisement: async () => recordOf("harness"),
  });
  assert.equal(stale.status.state, "stale");
  const none = await ensureClaudeAdvertisement({
    ...where,
    env: {},
    mode: "force",
    servedFromRecords: () => true,
    recordAdvertisement: async () => undefined,
  });
  assert.equal(none.status.state, "none");
  assert.equal(none.snapshot, null);
  // negative control: outside the seam (pod mode off) a forced probe DOES run
  let probed = 0;
  await ensureClaudeAdvertisement({
    ...where,
    env: {},
    mode: "force",
    servedFromRecords: () => false,
    probe: async () => {
      probed += 1;
      return {
        options: [{ value: "opus", name: "Opus", description: "Opus 9 · x" }],
        source: "fixture",
      };
    },
  });
  assert.equal(probed, 1);
  assert.equal(claudeAdvertisementNeedsProbe({ ...where, env: {} }), false);
  void currentClaudeAdvertKey;
});

// ───────────────────────── no detached warm in pod mode ─────────────────────────

function recordingSpawn() {
  const calls: string[][] = [];
  const spawnFn = (_command: string, args: string[]): ChildProcess => {
    calls.push(args);
    return {
      unref() {},
      on() {
        return this;
      },
    } as unknown as ChildProcess;
  };
  return { spawnFn, calls };
}

test("no detached warm in pod mode: with pod mode on (or refused) nothing is spawned, in either scope; with it off the same call spawns (control)", () => {
  for (const mode of ["pod", "refuse"] as const) {
    for (const scope of ["all", "claude-advertisement"] as const) {
      const dir = fs.mkdtempSync(path.join(ROOT, "warm-"));
      fs.mkdirSync(path.join(dir, "dist"));
      fs.writeFileSync(path.join(dir, "dist", "cli.js"), "");
      const rec = recordingSpawn();
      warmCatalogueInBackground({
        cachePath: path.join(dir, "models-cache.json"),
        spawn: rec.spawnFn,
        argv: ["node", path.join(dir, "dist", "cli.js")],
        env: {},
        scope,
        podMode: () => ({ mode }),
      });
      assert.equal(rec.calls.length, 0, `${mode}/${scope}`);
      assert.equal(
        fs.existsSync(path.join(dir, "models-cache.json.warming")),
        false,
        "no sentinel is stamped either",
      );
    }
  }
  const dir = fs.mkdtempSync(path.join(ROOT, "warm-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "cli.js"), "");
  const rec = recordingSpawn();
  warmCatalogueInBackground({
    cachePath: path.join(dir, "models-cache.json"),
    spawn: rec.spawnFn,
    argv: ["node", path.join(dir, "dist", "cli.js")],
    env: {},
    podMode: () => ({ mode: "off" }),
  });
  assert.equal(rec.calls.length, 1, "control: with pod mode off the warm spawns as always");
});

// ───────────────────────── dispatchUtility (injected dependencies) ─────────────────────────

type Dispatch = {
  deps: UtilityDeps;
  runs: RoutedCallOptions[];
  failures: unknown[];
  out: string[];
  stdinReads: number;
};

function decisionFor(argv: string[]): PlacementDecision & { kind: "branch" } {
  const classification = classifyArgv(argv, { builtInAgents: ["claude", "codex", "pi"] });
  assert.equal(classification.kind, "classified");
  return {
    kind: "branch",
    branch: "utility-pod",
    place: "control",
    classification,
    output: classification.kind === "classified" ? classification.output : "text",
  } as never;
}

function dispatcher(
  argv: string[],
  over: Partial<UtilityDeps> & {
    env?: NodeJS.ProcessEnv;
    agentCommand?: string | undefined;
    answerable?: boolean;
  } = {},
): Dispatch {
  const d: Dispatch = { deps: undefined as never, runs: [], failures: [], out: [], stdinReads: 0 };
  d.deps = {
    argv: () => argv,
    env: over.env ?? { PATH: "/usr/bin" },
    cwd: () => "/workspace",
    isTty: () => false,
    readStdin: async () => {
      d.stdinReads += 1;
      return "from stdin";
    },
    agentCommandOf: async () => ("agentCommand" in over ? over.agentCommand : CLAUDE),
    harnessOf: (command) =>
      command.includes("codex") ? "codex" : command.includes("claude") ? "claude" : undefined,
    poolPlacement: async () => "pool",
    recordsCanAnswer: async () => over.answerable ?? false,
    lookup: async () => ({ state: "absent" }),
    releases: () => ({ ok: true, releases: { acpx: "r1" } }),
    admissionClass: () => undefined,
    run: async (options) => {
      d.runs.push(options);
      return { kind: "completed", exitCode: 0, callId: options.callId ?? "c" };
    },
    fail: async (error) => {
      d.failures.push(error);
      return 1;
    },
    stderr: (t) => d.out.push(t),
    ...over,
  };
  return d;
}

const context = (out: string[]) => ({
  argv: [],
  write: (l: string) => out.push(l),
  writeStdout: (l: string) => out.push(l),
});

test("utility branch: a probe the records can answer is answered HERE (`proceed`) — no routed call, no broker, no pod", async () => {
  for (const argv of [
    ["claude", "output-styles"],
    ["codex", "model-catalogue", "--profile", "p"],
  ]) {
    const d = dispatcher(argv, { answerable: true });
    assert.equal(
      await dispatchUtility(decisionFor(argv), context(d.out), d.deps),
      "proceed",
      argv.join(" "),
    );
    assert.equal(d.runs.length, 0);
  }
  // negative: ONLY the two probe verbs have a record-served form — `exec` and `flow run` never proceed, however answerable
  assert.deepEqual([...RECORD_SERVED_PATHS].toSorted(), ["model-catalogue", "output-styles"]);
  for (const argv of [
    ["exec", "hi"],
    ["flow", "run", "f.ts"],
    ["sessions", "list"],
  ]) {
    const d = dispatcher(argv, { answerable: true });
    assert.equal(
      await dispatchUtility(decisionFor(argv), context(d.out), d.deps),
      0,
      argv.join(" "),
    );
    assert.equal(d.runs.length, 1, `${argv.join(" ")} goes to the utility pod`);
  }
});

test("utility branch: records cannot answer → ONE routed call to the utility pod — class one-shot, harness utility, no session, no seat, argv[0] is `acpx`, the probe deadline", async () => {
  const argv = ["claude", "output-styles", "--format", "json"];
  const d = dispatcher(argv);
  assert.equal(await dispatchUtility(decisionFor(argv), context(d.out), d.deps), 0);
  assert.equal(d.runs.length, 1);
  const run = d.runs[0];
  assert.ok(run);
  assert.equal(run.class, "one-shot");
  assert.equal(run.key, "util-pool");
  assert.equal(run.target.harness, "utility");
  assert.equal(run.target.sessionId, "");
  assert.equal(run.target.seat, "");
  assert.deepEqual(run.argv, ["acpx", ...argv]);
  assert.equal(run.deadlineMs, UTILITY_PROBE_DEADLINE_MS);
  assert.equal(run.payload, undefined);
});

test("utility branch, C1.2 placement per harness: Codex and Pi → ag-util-home (Pi until P1, A-44); claude → ag-util-pool; an agent no detector knows → pool; the terminal harness → pool (A-39)", async () => {
  const cases: Array<[string | undefined, string]> = [
    [resolveAgentCommand("codex"), "util-home"],
    [resolveAgentCommand("claude"), "util-pool"],
    [resolveAgentCommand("pi"), "util-home"],
    [undefined, "util-pool"],
  ];
  for (const [command, key] of cases) {
    const argv = ["exec", "hi"];
    const d = dispatcher(argv, {
      agentCommand: command,
      harnessOf: (c) =>
        c.includes("codex")
          ? "codex"
          : c.includes("claude")
            ? "claude"
            : c.includes("pi")
              ? "pi"
              : undefined,
    });
    await dispatchUtility(decisionFor(argv), context(d.out), d.deps);
    assert.equal(d.runs[0]?.key, key, `${command}`);
  }
  assert.equal(
    utilityKeyFor("claude-pty"),
    "util-pool",
    "A-39: the terminal harness is not home-placed",
  );
  assert.equal(utilityKeyFor("codex"), "util-home");
  assert.equal(utilityKeyFor("claude"), "util-pool");
  assert.equal(
    utilityKeyFor("pi"),
    "util-home",
    "A-44: Pi one-shots go home until P1 gives pool pods a Pi store",
  );
  assert.equal(utilityKeyFor(undefined), "util-pool");
});

test("utility branch, deadlines: the caller's own `--timeout S` plus the grace; else 30 s for a probe and 15 min for a run — never zero, never unbounded", () => {
  assert.equal(
    deadlineMsFor("exec", ["exec", "--timeout", "90", "x"]),
    90_000 + UTILITY_TIMEOUT_GRACE_MS,
  );
  assert.equal(deadlineMsFor("exec", ["--timeout=7", "exec"]), 7_000 + UTILITY_TIMEOUT_GRACE_MS);
  assert.equal(deadlineMsFor("exec", ["exec", "x"]), UTILITY_RUN_DEADLINE_MS);
  assert.equal(deadlineMsFor("flow run", ["flow", "run", "f"]), UTILITY_RUN_DEADLINE_MS);
  assert.equal(
    deadlineMsFor("output-styles", ["claude", "output-styles"]),
    UTILITY_PROBE_DEADLINE_MS,
  );
  // negative: a nonsense `--timeout` falls back to the default; a flag after `--` is prompt text, not ours
  assert.equal(deadlineMsFor("exec", ["exec", "--timeout", "0"]), UTILITY_RUN_DEADLINE_MS);
  assert.equal(deadlineMsFor("exec", ["exec", "--timeout", "abc"]), UTILITY_RUN_DEADLINE_MS);
  assert.equal(flagValue(["exec", "--", "--timeout", "5"], "--timeout"), undefined);
});

test("utility branch, `exec` with no prompt argument reads stdin HERE and sends it as the payload file (C2: the call has no stdin); a terminal and no prompt is the usage error, nothing started", async () => {
  const argv = ["exec"];
  const d = dispatcher(argv);
  assert.equal(await dispatchUtility(decisionFor(argv), context(d.out), d.deps), 0);
  const run = d.runs[0];
  assert.ok(run);
  assert.equal(run.payload, "from stdin");
  assert.equal(typeof run.argv, "function");
  assert.deepEqual(
    (run.argv as (p: string | undefined) => string[])("/home/node/.acpx/routed/x.payload"),
    ["acpx", "exec", "--file", "/home/node/.acpx/routed/x.payload"],
  );
  const tty = dispatcher(argv, { isTty: () => true });
  assert.equal(await dispatchUtility(decisionFor(argv), context(tty.out), tty.deps), 2);
  assert.equal(tty.runs.length, 0);
  assert.match(tty.out.join(""), /Prompt is required/);
});

test("utility branch: a call that arrived routed is never routed again (`routed_twice`, exit 2), nothing run; a refusal of the routed call is the command's exit code and output mode", async () => {
  const argv = ["exec", "hi"];
  const twice = dispatcher(argv, { env: { ACPX_ROUTED: "1" } });
  assert.equal(await dispatchUtility(decisionFor(argv), context(twice.out), twice.deps), 2);
  assert.match(twice.out.join("\n"), /reason=routed_twice/);
  assert.equal(twice.runs.length, 0);
  const refusal = podStartingRefusal({ phase: "pulling" });
  const refused = dispatcher(argv, {
    run: async () => {
      throw refusal;
    },
  });
  assert.equal(await dispatchUtility(decisionFor(argv), context(refused.out), refused.deps), 1);
  assert.deepEqual(refused.failures, [refusal]);
  assert.equal(
    refusal.stderrLine,
    "acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=15 phase=pulling",
    "a utility pod's refusal carries no wake=",
  );
});

// ───────────────────────── the REAL CLI in pod mode, against the kit fakes ─────────────────────────

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const script = JSON.parse(fs.readFileSync(path.join(dir, "script.json"), "utf8"));
const argv = process.argv.slice(2);
const at = argv.indexOf("--payload");
const payload = at >= 0 && fs.existsSync(argv[at + 1]) ? fs.readFileSync(argv[at + 1], "utf8") : undefined;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, payload }) + "\\n");
if (script.stdout) process.stdout.write(script.stdout);
process.exitCode = script.exit ?? 0;
`;

type Rig = {
  home: string;
  env: NodeJS.ProcessEnv;
  calls(): Array<{ argv: string[]; payload?: string }>;
  broker: Awaited<ReturnType<typeof startFakeBroker>>;
  close(): Promise<void>;
};

async function rig(opts: {
  records?: Array<Parameters<typeof makeSessionRecord>[0]>;
  brokerReady?: boolean;
  stub?: { exit?: number; stdout?: string };
  place?: "control" | "agent-pod";
  /** Tools whose control-pod release link is left out (C9). */
  withoutLinks?: string[];
  /** The kit broker's home cap (default 5): 0 makes `util-home` answer `home_full`. */
  homeCap?: number;
  /** Extra environment for the CLI (the P1 test seam, A-44). */
  extraEnv?: NodeJS.ProcessEnv;
  /** Pods the kit's API server already shows (a Ready utility pod, A-43 (b)). */
  pods?: PodSeed[];
  /** The kit broker's `GET /v1/agents` answer beyond the home cap: the pool state, `forced`, an older broker's missing field (M1 F-B). */
  brokerStatus?: Omit<BrokerStatus, "home">;
  /** `GET /v1/agents` fails (the broker's capacity answer is unreadable) while POST still works (M1 F-B). */
  statusFails?: boolean;
  /** `GET /v1/agents` is never answered (a hung broker) while POST still works (M1 F-B fix round 1). */
  statusHangs?: boolean;
  /** The POST's stream never finishes after `scheduling`: the pod never wakes (M1 F-B fix round 2). */
  postHangs?: boolean;
}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(ROOT, "home-"));
  const stubDir = fs.mkdtempSync(path.join(ROOT, "stub-"));
  fs.writeFileSync(path.join(stubDir, "agent-exec"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, "script.json"), JSON.stringify(opts.stub ?? {}));
  const runtime = fs.mkdtempSync(path.join(ROOT, "runtime-"));
  for (const tool of [
    "acpx",
    "acpx-ui",
    "claude-agent-acp",
    "codex-acp",
    "claude-pty-acp",
    "pi",
    "pi-acp",
  ]) {
    if (opts.withoutLinks?.includes(tool)) {
      continue;
    }
    fs.mkdirSync(path.join(runtime, ".releases", tool, "r"), { recursive: true });
    fs.symlinkSync(`.releases/${tool}/r`, path.join(runtime, tool));
  }
  const sa = fs.mkdtempSync(path.join(ROOT, "sa-"));
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  fs.writeFileSync(path.join(sa, "token"), "tok-1\n");
  const api = await startFakeApiServer({ namespace: "dev-devbox", pods: opts.pods ?? [] });
  const broker = await startFakeBroker({
    // The kit's home cap is the real broker's default, 0: `util-home` then answers `home_full`.
    status: { ...opts.brokerStatus, home: { live: 0, cap: opts.homeCap ?? 5 } },
    ...(opts.statusFails ? { statusFails: true } : {}),
    ...(opts.statusHangs ? { statusHangs: true } : {}),
    default: {
      steps: ["scheduling"],
      ...(opts.postHangs ? { hang: true } : {}),
      final: {
        ready: {
          ip: "10.1.2.3",
          pod: "ag-util-pool-abcde",
          uid: "44444444-4444-4444-8444-444444444444",
          node: "n1",
          placement: "pool",
        },
      },
    },
  });
  for (const record of opts.records ?? []) {
    await writeSessionRecordFile(home, makeSessionRecord(record));
  }
  if (opts.place === "agent-pod") {
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-0123456789abcdef01234567\n");
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    NODE_TEST_CONTEXT: "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: home,
    NV_POD_NAME: "dev-server-abc",
    NV_POD_UID: "ctl-uid-1",
    NV_NODE_NAME: "node-a",
    ACPX_POD_SA_DIR: sa,
    ACPX_POD_API_URL: api.url,
    NV_AGENT_BROKER_URL: broker.url,
    ACPX_AGENT_EXEC: path.join(stubDir, "agent-exec"),
    ACPX_TEST_RUNTIME_DIR: runtime,
    ...opts.extraEnv,
  };
  for (const name of [
    "ACPX_SESSION_URL",
    "ACPX_SESSION_NAME",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_RECORD_ID",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_STATE_HOME",
    "ACPX_ROUTED",
    "ACPX_ADMISSION_CLASS",
    "ACPX_DEFAULT_OWNER",
    "ACPX_SESSION_ROOT",
  ]) {
    delete env[name];
  }
  return {
    home,
    env,
    broker,
    calls: () => {
      const file = path.join(stubDir, "calls.jsonl");
      return fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { argv: string[]; payload?: string })
        : [];
    },
    close: async () => {
      await api.close();
      await broker.close();
    },
  };
}

type Cli = { code: number | null; stdout: string; stderr: string };

function cli(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<Cli> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd: "/workspace",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

const record = (
  id: string,
  command: string,
  acpx: Record<string, unknown>,
  lastUsedAt = "2026-11-10T00:00:00.000Z",
  agentStartedAt?: string,
) => ({
  ...(agentStartedAt ? { agentStartedAt } : {}),
  acpxRecordId: id,
  acpSessionId: `acp-${id}`,
  agentCommand: command,
  cwd: "/workspace",
  lastUsedAt,
  acpx: acpx as never,
});

const SEEN_ARGV = (call: { argv: string[] } | undefined) =>
  call?.argv.slice((call?.argv.indexOf("--") ?? -1) + 1);

test("REAL CLI, pod mode: `claude output-styles --format json` is answered from the newest Claude record — source records, the record id, adapter_match — and NOTHING starts: no broker call, no routed call, no bridge", async () => {
  const r = await rig({
    records: [
      record("22222222-2222-4222-8222-222222222222", CLAUDE, {
        config_options: [styleOption("default", "Explanatory")],
      }),
    ],
  });
  try {
    const result = await cli(
      ["--approve-all", "--agent", CLAUDE, "--format", "json", "output-styles"],
      r.env,
    );
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(json.action, "output_styles_list");
    assert.deepEqual(json.available, ["default", "Explanatory"]);
    assert.equal(json.supported, true);
    assert.equal(json.source, "records");
    assert.equal(json.record_id, "22222222-2222-4222-8222-222222222222");
    assert.equal(json.adapter_match, "exact");
    assert.equal(r.broker.requests.length, 0, "the broker was not asked");
    assert.equal(r.calls().length, 0, "nothing was sent to a pod");
  } finally {
    await r.close();
  }
});

test("REAL CLI, pod mode: a record of an OLDER adapter command answers as adapter_match `harness`; a record that advertises no outputStyle is the truthful `supported:false`", async () => {
  const r = await rig({
    records: [
      record("33333333-3333-4333-8333-333333333333", CLAUDE_OLD, {
        config_options: [modelOption("opus")],
      }),
    ],
  });
  try {
    const result = await cli(["--agent", CLAUDE, "--format", "json", "output-styles"], r.env);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(json.adapter_match, "harness");
    assert.equal(json.supported, false);
    assert.deepEqual(json.available, []);
  } finally {
    await r.close();
  }
});

test("REAL CLI, pod mode: `codex model-catalogue` is served from the newest Codex record with that --profile; a record of another profile does not answer", async () => {
  const r = await rig({
    records: [
      record("44444444-4444-4444-8444-444444444441", CODEX, {
        available_models: ["gpt-5[low]", "gpt-5[high]"],
        current_model_id: "gpt-5[low]",
        session_options: { profile: "codexgpt" },
      }),
      record("44444444-4444-4444-8444-444444444442", CODEX, {
        available_models: ["other[low]"],
        session_options: { profile: "elsewhere" },
      }),
    ],
  });
  try {
    const result = await cli(
      ["--agent", CODEX, "--profile", "codexgpt", "--format", "json", "model-catalogue"],
      r.env,
    );
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as {
      source?: string;
      record_id?: string;
      advertisedModelCatalogue?: { models: Array<{ family: string; efforts: string[] }> };
    };
    assert.equal(json.source, "records");
    assert.equal(json.record_id, "44444444-4444-4444-8444-444444444441");
    assert.deepEqual(
      json.advertisedModelCatalogue?.models.map((m) => m.family),
      ["gpt-5"],
    );
    assert.equal(r.broker.requests.length, 0);
    assert.equal(r.calls().length, 0);
  } finally {
    await r.close();
  }
});

test("REAL CLI, pod mode: NO record can answer → the box's utility pod is started through the broker (no sessionId, no seat, class utility, placement pool) and the probe runs there as ONE routed call", async () => {
  const r = await rig({ stub: { exit: 0, stdout: '{"action":"output_styles_list"}\n' } });
  try {
    const result = await cli(["--agent", CLAUDE, "--format", "json", "output-styles"], r.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '{"action":"output_styles_list"}\n');
    const post = r.broker.requests.find((q) => q.method === "POST");
    assert.ok(post);
    assert.equal(post.key, "util-pool");
    assert.deepEqual(post.problems, [], "the kit judges the body as the real broker does");
    assert.equal(post.body?.harness, "utility");
    assert.equal(post.body?.class, "utility");
    assert.equal(post.body?.placement, "pool");
    assert.equal("sessionId" in (post.body ?? {}), false);
    assert.equal("seat" in (post.body ?? {}), false);
    const calls = r.calls();
    assert.equal(calls.length, 1);
    assert.deepEqual(SEEN_ARGV(calls[0]), [
      "acpx",
      "--agent",
      CLAUDE,
      "--format",
      "json",
      "output-styles",
    ]);
    assert.equal(calls[0]?.argv[calls[0].argv.indexOf("--key") + 1], "util-pool");
  } finally {
    await r.close();
  }
});

test("REAL CLI, pod mode: `exec` goes to the utility pod — Codex to the HOME pod — with its stdin prompt as the payload file; `flow run` too; and a full box is `agent_cap` exit 75 with no wake=", async () => {
  const r = await rig({ stub: { exit: 0, stdout: "ran\n" } });
  try {
    const exec = await cli(["--agent", CODEX, "exec"], r.env, "do the thing");
    assert.equal(exec.code, 0, exec.stderr);
    assert.equal(exec.stdout, "ran\n");
    const post = r.broker.requests.find((q) => q.method === "POST");
    assert.equal(post?.key, "util-home");
    assert.equal(post?.body?.placement, "home");
    const call = r.calls()[0];
    assert.equal(call?.payload, "do the thing");
    const tail = SEEN_ARGV(call) ?? [];
    assert.deepEqual(tail.slice(0, 4), ["acpx", "--agent", CODEX, "exec"]);
    assert.equal(tail[4], "--file");
    const flow = await cli(["flow", "run", "/workspace/flow.ts"], r.env);
    assert.equal(flow.code, 0, flow.stderr);
    assert.deepEqual(SEEN_ARGV(r.calls()[1]), ["acpx", "flow", "run", "/workspace/flow.ts"]);
  } finally {
    await r.close();
  }
  const full = await rig({});
  try {
    full.broker.setScript({
      default: { final: { refused: { reason: "agent_cap", live: 5, cap: 5 } } },
    });
    const result = await cli(["--agent", CLAUDE, "exec", "hi"], full.env);
    assert.equal(result.code, 75, result.stderr);
    assert.match(
      result.stderr.split("\n")[0] ?? "",
      /^acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 .* why=cap$/,
    );
    assert.equal(full.calls().length, 0, "nothing ran");
  } finally {
    await full.close();
  }
});

test("REAL CLI, pod mode (A-7 negatives): a call that is already routed is refused `routed_twice` for exec; and in an AGENT pod control-pod maintenance exits 2 `control_pod_only` while an agent's own exec runs locally — neither starts anything", async () => {
  const control = await rig({});
  try {
    const twice = await cli(["--agent", CLAUDE, "exec", "hi"], {
      ...control.env,
      ACPX_ROUTED: "1",
    });
    assert.equal(twice.code, 2);
    assert.match(twice.stderr, /reason=routed_twice/);
    assert.equal(control.broker.requests.length, 0);
  } finally {
    await control.close();
  }
  const pod = await rig({ place: "agent-pod" });
  try {
    pod.env.NV_POD_NAME = "ag-0123456789abcdef01234567";
    const maintenance = await cli(["governor", "scan"], pod.env);
    assert.equal(maintenance.code, 2);
    assert.equal(maintenance.stderr.split("\n")[0], "acpx: REFUSED reason=control_pod_only");
    // an agent's own one-shot is its own load, local (C1.2): it is NOT routed anywhere
    await cli(["--agent", "node -e 0", "exec", "hi"], pod.env);
    assert.equal(pod.broker.requests.length, 0, "an agent pod never asks the broker for anything");
    assert.equal(pod.calls().length, 0);
  } finally {
    await pod.close();
  }
});

/**
 * `devbox`: one chatgpt profile on the native `~/.codex`. `s1` (F-A2): the same, plus `codexalt` on a
 * home of its own, BOUND AS THE DEFAULT — so a create with no profile writes `profile:"codexalt"`, and
 * a record with none ran on the native home.
 */
function writeRegistry(home: string, shape: "devbox" | "s1" = "devbox"): void {
  const dir = path.join(home, ".acpx", "subscriptions");
  fs.mkdirSync(dir, { recursive: true });
  const chatgpt = (id: string, codexHome: string) => ({
    id,
    label: id,
    authMode: "chatgpt",
    adapter: "codex",
    account: id,
    codexHome,
  });
  fs.writeFileSync(
    path.join(dir, "registry.json"),
    JSON.stringify({
      version: 3,
      ...(shape === "s1" ? { default: "codexalt" } : {}),
      profiles: [
        chatgpt("codexgpt", path.join(home, ".codex")),
        ...(shape === "s1" ? [chatgpt("codexalt", path.join(home, "alt-codex-home"))] : []),
      ],
    }),
  );
}

const ATRIUM_CODEX_ARGV = (cwd: string, profile = "codexgpt") => [
  "--format",
  "json",
  "--profile",
  profile,
  "--cwd",
  cwd,
  "--agent",
  CODEX,
  "model-catalogue",
];

test("REAL CLI, round 2 / F-A: atrium's exact Codex argv (--profile <active> --cwd <empty dir>) is served from Codex records WITHOUT a profile — the shape 233 of 236 real records have — with the record's age and a null currentModelId when it has none", async () => {
  const r = await rig({
    records: [
      record(
        "55555555-5555-4555-8555-555555555551",
        CODEX,
        { available_models: ["gpt-5[low]", "gpt-5[high]"] },
        "2026-11-20T14:36:00.000Z",
      ),
    ],
  });
  try {
    writeRegistry(r.home);
    const cwd = fs.mkdtempSync(path.join(ROOT, "empty-"));
    const result = await cli(ATRIUM_CODEX_ARGV(cwd), r.env);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(json.source, "records");
    assert.equal(json.record_id, "55555555-5555-4555-8555-555555555551");
    assert.equal(json.record_last_used_at, "2026-11-20T14:36:00.000Z");
    assert.equal(
      json.currentModelId,
      null,
      "null, as the transient path answers — never an empty string",
    );
    assert.equal(r.broker.requests.length, 0);
    assert.equal(r.calls().length, 0);
  } finally {
    await r.close();
  }
});

test("REAL CLI, round 2 / F-A (negative): an explicit OTHER profile on the only Codex record is not served for atrium's argv — it routes to the home utility pod instead", async () => {
  const r = await rig({
    records: [
      record("55555555-5555-4555-8555-555555555552", CODEX, {
        available_models: ["gpt-5[low]"],
        session_options: { profile: "elsewhere" },
      }),
    ],
    stub: { exit: 0, stdout: "{}\n" },
  });
  try {
    writeRegistry(r.home);
    const cwd = fs.mkdtempSync(path.join(ROOT, "empty-"));
    const result = await cli(ATRIUM_CODEX_ARGV(cwd), r.env);
    assert.equal(result.code, 0, result.stderr);
    const post = r.broker.requests.find((q) => q.method === "POST");
    assert.equal(
      post?.key,
      "util-home",
      "Codex is home-placed (C1.2): its probe cannot run on the pool pod",
    );
    assert.equal(r.calls().length, 1);
  } finally {
    await r.close();
  }
});

test("REAL CLI, F-A2 (shape S1: the default is bound to a NON-native profile): a no-profile Codex record ran on the native home — it answers the native profile and NOT the bound one", async () => {
  const noProfile = record("77777777-7777-4777-8777-777777777771", CODEX, {
    available_models: ["gpt-5[low]"],
  });
  const r = await rig({ records: [noProfile], stub: { exit: 0, stdout: "{}\n" } });
  try {
    writeRegistry(r.home, "s1");
    const cwd = fs.mkdtempSync(path.join(ROOT, "empty-"));
    // the profile the create path binds (codexalt): the record does NOT answer for it — one record, one account
    const bound = await cli(ATRIUM_CODEX_ARGV(cwd, "codexalt"), r.env);
    assert.equal(bound.code, 0, bound.stderr);
    assert.equal(
      r.broker.requests.find((q) => q.method === "POST")?.key,
      "util-home",
      "routed to the home utility pod, not served from the native-home record",
    );
    assert.equal(r.calls().length, 1);
    // the native profile: served from that very record, exact
    const native = await cli(ATRIUM_CODEX_ARGV(cwd, "codexgpt"), r.env);
    assert.equal(native.code, 0, native.stderr);
    const json = JSON.parse(native.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(json.source, "records");
    assert.equal(json.record_id, "77777777-7777-4777-8777-777777777771");
    assert.equal(r.calls().length, 1, "no second routed call: the native profile did not need one");
  } finally {
    await r.close();
  }
});

test("REAL CLI: the answer carries record_agent_started_at, and the record whose adapter started LAST answers although another was used later; a record without the field adds none", async () => {
  const r = await rig({
    records: [
      record(
        "88888888-8888-4888-8888-888888888881",
        CLAUDE,
        { config_options: [styleOption("default", "Long")] },
        "2026-11-22T00:00:00.000Z", // used most recently …
        "2026-11-01T00:00:00.000Z", // … adapter started three weeks ago
      ),
      record(
        "88888888-8888-4888-8888-888888888882",
        CLAUDE,
        { config_options: [styleOption("default", "Fresh")] },
        "2026-11-15T00:00:00.000Z",
        "2026-11-20T00:00:00.000Z",
      ),
    ],
  });
  try {
    const result = await cli(["--agent", CLAUDE, "--format", "json", "output-styles"], r.env);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(json.record_id, "88888888-8888-4888-8888-888888888882");
    assert.equal(json.record_agent_started_at, "2026-11-20T00:00:00.000Z");
    assert.equal(json.record_last_used_at, "2026-11-15T00:00:00.000Z");
  } finally {
    await r.close();
  }
  const bare = await rig({
    records: [
      record("88888888-8888-4888-8888-888888888883", CLAUDE, {
        config_options: [styleOption("default", "NoStart")],
      }),
    ],
  });
  try {
    const result = await cli(["--agent", CLAUDE, "--format", "json", "output-styles"], bare.env);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(json.source, "records");
    assert.equal(
      "record_agent_started_at" in json,
      false,
      "no field, not a null or an empty string",
    );
  } finally {
    await bare.close();
  }
});

test("REAL CLI, round 2 / F-B + F-G: an older record of the box's own claude command answers atrium's output-styles call although a NEWER record of a rig adapter lacks the style option — `supported:true`, never a hidden row — and carries its age", async () => {
  const r = await rig({
    records: [
      record(
        "66666666-6666-4666-8666-666666666661",
        CLAUDE,
        { config_options: [styleOption("default", "Explanatory")] },
        "2026-11-10T00:00:00.000Z",
      ),
      record(
        "66666666-6666-4666-8666-666666666662",
        "node /workspace/projects/claude-agent-acp/sdk-0.3.325/dist/index.js",
        { config_options: [modelOption("opus")] },
        "2026-11-22T00:00:00.000Z",
      ),
    ],
  });
  try {
    const result = await cli(
      ["--approve-all", "--agent", CLAUDE, "--format", "json", "output-styles"],
      r.env,
    );
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(json.supported, true);
    assert.deepEqual(json.available, ["default", "Explanatory"]);
    assert.equal(json.adapter_match, "exact");
    assert.equal(json.record_last_used_at, "2026-11-10T00:00:00.000Z");
  } finally {
    await r.close();
  }
});

test("REAL CLI, round 2 / F-F: a utility refusal in JSON carries tokenLine == stderr line 1 and nothingStarted, and its sentence names no session or message", async () => {
  const r = await rig({});
  try {
    r.broker.setScript({
      default: { final: { refused: { reason: "agent_cap", live: 5, cap: 5 } } },
      status: { home: { live: 0, cap: 5 } },
    });
    const result = await cli(["--format", "json", "--agent", CLAUDE, "exec", "hi"], r.env);
    assert.equal(result.code, 75, result.stderr);
    const error = (
      JSON.parse(result.stdout.trim().split("\n")[0] ?? "{}") as {
        error: { message: string; data: Record<string, unknown> };
      }
    ).error;
    assert.equal(error.data.tokenLine, result.stderr.split("\n")[0]);
    assert.equal(error.data.nothingStarted, true);
    assert.equal(error.data.reason, "agent_cap");
    assert.doesNotMatch(String(error.data.message), /session|message|queued/i);
  } finally {
    await r.close();
  }
});

// ───────────────────────── A-43 / A-44: a Pi one-shot without `pi` (rows 43.1–43.3), Pi goes home ─────────────────────────

const PI = "node /opt/pi-acp/dist/index.js";
const PI_LINE = /^acpx: ROUTED outcome=not_run reason=release_unresolved tool=pi call_id=\S+$/;

/** A Ready utility pod for `util-pool`, as the broker would have started it, with the given releases annotation. */
function utilityPod(releases: string | undefined): PodSeed {
  return {
    name: "ag-util-pool-abcde",
    uid: "55555555-5555-4555-8555-555555555555",
    podIP: "10.1.2.9",
    labels: { "workbench.nativai.de/session-key": "util-pool" },
    ...(releases === undefined ? {} : { annotations: { "runtime.nativai.de/releases": releases } }),
  };
}

const POSTS = (r: Rig) => r.broker.requests.filter((q) => q.method === "POST");

test("A-43 row 43.1: no utility pod, the control pod's `pi` link absent — a Pi `exec` is refused `release_unresolved tool=pi`, the broker receives no request; a Claude `exec` in the same rig is routed to util-pool with `releases` lacking `pi`", async () => {
  const r = await rig({ withoutLinks: ["pi"], stub: { exit: 0, stdout: "ran\n" } });
  try {
    const pi = await cli(["--agent", PI, "exec", "hi"], r.env);
    assert.equal(pi.code, 1, pi.stderr);
    assert.match(pi.stderr.split("\n")[0] ?? "", PI_LINE);
    assert.equal(r.broker.requests.length, 0, "the broker was never asked");
    assert.equal(r.calls().length, 0);
    const claude = await cli(["--agent", CLAUDE, "exec", "hi"], r.env);
    assert.equal(claude.code, 0, claude.stderr);
    const [post, ...more] = POSTS(r);
    assert.equal(more.length, 0);
    assert.equal(post?.key, "util-pool");
    const releases = (post?.body?.releases ?? {}) as Record<string, string>;
    assert.equal("pi" in releases, false, "releases lacks pi");
    assert.equal("acpx" in releases, true);
    assert.equal(r.calls().length, 1);
  } finally {
    await r.close();
  }
});

test("A-43 row 43.1, the positive side: with `pi` linked a Pi `exec` is routed — to the HOME utility pod (A-44)", async () => {
  const r = await rig({ stub: { exit: 0, stdout: "ran\n" } });
  try {
    const pi = await cli(["--agent", PI, "exec", "hi"], r.env);
    assert.equal(pi.code, 0, pi.stderr);
    assert.equal(POSTS(r)[0]?.key, "util-home");
    assert.equal(POSTS(r)[0]?.body?.placement, "home");
    assert.equal("pi" in ((POSTS(r)[0]?.body?.releases ?? {}) as object), true);
  } finally {
    await r.close();
  }
});

test("A-43 row 43.2: a Ready utility pod whose releases annotation lacks `pi` (or cannot be read) is never reached by a Pi call; with `pi` in the annotation it is", async () => {
  // The pod serves util-home for Pi: the key the Pi one-shot goes to (A-44).
  const home = (releases: string | undefined): PodSeed => ({
    ...utilityPod(releases),
    name: "ag-util-home-abcde",
    labels: { "workbench.nativai.de/session-key": "util-home" },
  });
  const full = JSON.stringify({ acpx: "r", "pi-acp": "r", pi: "r" });
  const cases: Array<[string, string | undefined]> = [
    ["lacking pi", JSON.stringify({ acpx: "r", "pi-acp": "r" })],
    ["no annotation at all", undefined],
    ["unparseable", "{not json"],
    ["not an object of strings", JSON.stringify({ pi: 7 })],
    ["pi is the EMPTY string", JSON.stringify({ acpx: "r", pi: "" })],
    ["pi is not a release-shaped name", JSON.stringify({ acpx: "r", pi: "../../etc" })],
    ["pi is whitespace", JSON.stringify({ acpx: "r", pi: "  " })],
  ];
  for (const [label, annotation] of cases) {
    const r = await rig({ pods: [home(annotation)] });
    try {
      const result = await cli(["--agent", PI, "exec", "hi"], r.env);
      assert.equal(result.code, 1, `${label}: ${result.stderr}`);
      assert.match(result.stderr.split("\n")[0] ?? "", PI_LINE, label);
      assert.equal(r.broker.requests.length, 0, `${label}: the broker was not asked`);
      assert.equal(r.calls().length, 0, `${label}: the call was not routed`);
    } finally {
      await r.close();
    }
  }
  const named = await rig({ pods: [home(full)], stub: { exit: 0, stdout: "ran\n" } });
  try {
    const result = await cli(["--agent", PI, "exec", "hi"], named.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(named.calls().length, 1, "routed to the Ready pod");
    assert.equal(named.broker.requests.length, 0, "a Ready pod needs no broker");
  } finally {
    await named.close();
  }
  // The same lacking-pi pod does NOT stop a Claude call: it is the Pi call that needs `pi`.
  const claudeRig = await rig({
    pods: [utilityPod(JSON.stringify({ acpx: "r" }))],
    stub: { exit: 0, stdout: "ran\n" },
  });
  try {
    const result = await cli(["--agent", CLAUDE, "exec", "hi"], claudeRig.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(claudeRig.calls().length, 1);
  } finally {
    await claudeRig.close();
  }
});

test("A-43 row 43.3: a Pi `model-catalogue` that no record answers must be routed — and with the `pi` link absent it is refused (exit 1, nothing started); a usable Pi record answers it with no line and nothing routed", async () => {
  const none = await rig({ withoutLinks: ["pi"] });
  try {
    const result = await cli(["--agent", PI, "model-catalogue"], none.env);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr.split("\n")[0] ?? "", PI_LINE);
    assert.equal(none.broker.requests.length, 0);
    assert.equal(none.calls().length, 0);
  } finally {
    await none.close();
  }
  const served = await rig({
    withoutLinks: ["pi"],
    records: [
      record("66666666-6666-4666-8666-666666666661", PI, {
        available_models: ["pi-a", "pi-b"],
        current_model_id: "pi-a",
      }),
    ],
  });
  try {
    const result = await cli(["--agent", PI, "model-catalogue"], served.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.includes("release_unresolved"), false, result.stderr);
    assert.equal(served.broker.requests.length, 0, "answered from the record: nothing routed");
    assert.equal(served.calls().length, 0);
  } finally {
    await served.close();
  }
});

test("A-43 unit: a call whose agent is Pi carries `agentIsPi`; a Claude or Codex one-shot does not", async () => {
  for (const [command, expected] of [
    [PI, true],
    [CLAUDE, false],
    [CODEX, false],
  ] as const) {
    const argv = ["exec", "hi"];
    const d = dispatcher(argv, {
      agentCommand: command,
      harnessOf: (c) => (c.includes("pi-acp") ? "pi" : c.includes("codex") ? "codex" : "claude"),
    });
    await dispatchUtility(decisionFor(argv), context(d.out), d.deps);
    assert.equal(d.runs[0]?.agentIsPi === true, expected, command);
    assert.equal(d.runs[0]?.target.harness, "utility", "the pod's harness stays utility");
  }
});

// ───────────────────────── A-44 (rows 44.1–44.3): Pi goes home until P1 is on THIS box ─────────────────────────

test("A-44 row 44.1: P1 not on the box, home cap 1 — a Pi `exec` posts util-home with placement home and is routed; a Claude `exec` posts util-pool", async () => {
  const r = await rig({ homeCap: 1, stub: { exit: 0, stdout: "ran\n" } });
  try {
    const pi = await cli(["--agent", PI, "exec", "hi"], r.env);
    assert.equal(pi.code, 0, pi.stderr);
    assert.equal(POSTS(r).length, 1);
    assert.equal(POSTS(r)[0]?.key, "util-home");
    assert.equal(POSTS(r)[0]?.body?.placement, "home");
    assert.equal(r.calls().length, 1, "routed");
    const claude = await cli(["--agent", CLAUDE, "exec", "hi"], r.env);
    assert.equal(claude.code, 0, claude.stderr);
    assert.equal(POSTS(r)[1]?.key, "util-pool");
    assert.equal(
      POSTS(r).filter((post) => post.key === "util-pool").length,
      1,
      "a Pi one-shot never went to the pool",
    );
  } finally {
    await r.close();
  }
});

test("A-44 row 44.2: home cap 0 — a Pi `exec` is refused agent_cap why=home_full (exit 75), nothing started; a Pi probe with a usable record is still answered from it", async () => {
  const r = await rig({
    homeCap: 0,
    records: [
      record("77777777-7777-4777-8777-777777777771", PI, {
        available_models: ["pi-a"],
        current_model_id: "pi-a",
      }),
    ],
  });
  try {
    r.broker.setScript({
      default: { final: { refused: { reason: "home_full", live: 0, cap: 0 } } },
    });
    const exec = await cli(["--agent", PI, "exec", "hi"], r.env);
    assert.equal(exec.code, 75, exec.stderr);
    assert.match(
      exec.stderr.split("\n")[0] ?? "",
      /^acpx: REFUSED reason=agent_cap .*why=home_full/,
    );
    assert.equal(r.calls().length, 0, "nothing started");
    assert.equal(POSTS(r)[0]?.key, "util-home", "it asked for the HOME pod, not the pool");
    const probe = await cli(["--agent", PI, "model-catalogue"], r.env);
    assert.equal(probe.code, 0, probe.stderr);
    assert.equal(POSTS(r).length, 1, "the probe asked the broker for nothing");
  } finally {
    await r.close();
  }
});

test("A-44 row 44.3 (CLI): a Pi one-shot goes home on a box WITHOUT P1's signal — the acpx release alone never moves Pi — and to the pool on a box WITH it; codex stays home, claude pool", async () => {
  // The seam is honoured only under node --test, so the rig's env carries NODE_TEST_CONTEXT; without the
  // signal (absent, or set to anything but "1") Pi stays home.
  for (const extraEnv of [{}, { ACPX_TEST_P1_ON_BOX: "0" }, { ACPX_TEST_P1_ON_BOX: "yes" }]) {
    const r = await rig({ extraEnv, stub: { exit: 0 } });
    try {
      await cli(["--agent", PI, "exec", "hi"], r.env);
      assert.equal(POSTS(r)[0]?.key, "util-home", JSON.stringify(extraEnv));
    } finally {
      await r.close();
    }
  }
  const p1 = await rig({ extraEnv: { ACPX_TEST_P1_ON_BOX: "1" }, stub: { exit: 0 } });
  try {
    await cli(["--agent", PI, "exec", "hi"], p1.env);
    await cli(["--agent", CODEX, "exec", "hi"], p1.env);
    await cli(["--agent", CLAUDE, "exec", "hi"], p1.env);
    assert.deepEqual(
      POSTS(p1).map((post) => post.key),
      ["util-pool", "util-home", "util-pool"],
      "with P1's signal: Pi → pool, codex stays home, claude pool",
    );
  } finally {
    await p1.close();
  }
});

// ───────────────────────── M1 F-B (brick 8d5b723e): a utility call follows A-49 — home while the pool is not ready ─────────────────────────

// podlab's pool templates carry this annotation (M1 TE, brick f1da52b3): `pool.state` is not `ready`.
const TEMPLATE_GAPS = { state: "template-gaps:D2-node-selection,M1-state-mounts" };
const AGENTS_GETS = (r: Rig) => r.broker.requests.filter((q) => q.method === "GET");

test("M1 F-B unit: while the pool is not ready (broker places home) a Claude one-shot is routed to util-home; ready → util-pool as today; unreadable → util-pool as today", async () => {
  const argv = ["exec", "hi"];
  const keyFor = async (poolPlacement: UtilityDeps["poolPlacement"]) => {
    const d = dispatcher(argv, { poolPlacement });
    await dispatchUtility(decisionFor(argv), context(d.out), d.deps);
    return d.runs[0]?.key;
  };
  assert.equal(await keyFor(async () => "home"), "util-home");
  assert.equal(await keyFor(async () => "pool"), "util-pool");
  assert.equal(await keyFor(async () => undefined), "util-pool");
});

test("M1 F-B fix round 1 unit: the routed call's clock starts BEFORE the capacity read — `startedAtMs` is the time before it, not after, so the read counts against the call's deadline", async () => {
  const argv = ["exec", "hi"];
  const before = Date.now();
  const d = dispatcher(argv, {
    poolPlacement: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return "pool";
    },
  });
  await dispatchUtility(decisionFor(argv), context(d.out), d.deps);
  const run = d.runs[0];
  assert.ok(run);
  assert.ok(run.startedAtMs !== undefined, "the clock start is passed");
  assert.ok(
    run.startedAtMs >= before && run.startedAtMs < before + 100,
    `${run.startedAtMs - before}`,
  );
});

test("M1 F-B unit: a home-only harness (codex) is util-home and the broker's capacity is never read for it", async () => {
  const argv = ["exec", "hi"];
  let reads = 0;
  const d = dispatcher(argv, {
    agentCommand: CODEX,
    poolPlacement: async () => {
      reads += 1;
      return "pool";
    },
  });
  await dispatchUtility(decisionFor(argv), context(d.out), d.deps);
  assert.equal(d.runs[0]?.key, "util-home");
  assert.equal(reads, 0, "nothing to decide, nothing read");
});

test("M1 F-B REAL CLI: pool.state not ready (template gaps) — a Claude `exec` posts util-home with placement home and RUNS; it never asks the pool pod (red before the fix: template_rejected, nothing ran)", async () => {
  const r = await rig({
    brokerStatus: { pool: TEMPLATE_GAPS },
    stub: { exit: 0, stdout: "ran\n" },
  });
  try {
    const result = await cli(["--agent", CLAUDE, "exec", "hi"], r.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "ran\n");
    assert.deepEqual(
      POSTS(r).map((post) => [post.key, post.body?.placement, post.body?.class]),
      [["util-home", "home", "utility"]],
    );
    assert.deepEqual(POSTS(r)[0]?.problems, []);
    assert.equal(r.calls().length, 1, "routed");
    assert.equal(r.calls()[0]?.argv[r.calls()[0].argv.indexOf("--key") + 1], "util-home");
  } finally {
    await r.close();
  }
});

test("M1 F-B REAL CLI: a utility PROBE no record answers (`output-styles`) goes home too while the pool is not ready", async () => {
  const r = await rig({
    brokerStatus: { pool: TEMPLATE_GAPS },
    stub: { exit: 0, stdout: '{"action":"output_styles_list"}\n' },
  });
  try {
    const result = await cli(["--agent", CLAUDE, "--format", "json", "output-styles"], r.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      POSTS(r).map((post) => post.key),
      ["util-home"],
    );
  } finally {
    await r.close();
  }
});

test("M1 F-B REAL CLI: pool not ready AND home full — refused exit 75 `agent_cap … why=home_full`, nothing started, no wake=; the ask was the HOME pod, so the refusal is attributable to the home cap", async () => {
  const r = await rig({ brokerStatus: { pool: TEMPLATE_GAPS }, homeCap: 0, stub: { exit: 0 } });
  try {
    const result = await cli(["--agent", CLAUDE, "exec", "hi"], r.env);
    assert.equal(result.code, 75, result.stderr);
    const first = result.stderr.split("\n")[0] ?? "";
    assert.match(
      first,
      /^acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 .* why=home_full$/,
    );
    assert.doesNotMatch(first, /wake=/);
    assert.equal(r.calls().length, 0, "nothing ran");
    assert.deepEqual(
      POSTS(r).map((post) => post.key),
      ["util-home"],
      "the pool was never asked",
    );
  } finally {
    await r.close();
  }
});

test("M1 F-B REAL CLI: pool ready → util-pool as today (placement pool); a home-only harness (codex) → util-home with NO read of GET /v1/agents", async () => {
  const r = await rig({ stub: { exit: 0 } });
  try {
    await cli(["--agent", CLAUDE, "exec", "hi"], r.env);
    assert.deepEqual(
      POSTS(r).map((post) => [post.key, post.body?.placement]),
      [["util-pool", "pool"]],
    );
    assert.equal(AGENTS_GETS(r).length, 1, "the pool-capable harness read the capacity once");
  } finally {
    await r.close();
  }
  const home = await rig({ brokerStatus: { pool: TEMPLATE_GAPS }, stub: { exit: 0 } });
  try {
    await cli(["--agent", CODEX, "exec", "hi"], home.env);
    assert.deepEqual(
      POSTS(home).map((post) => [post.key, post.body?.placement]),
      [["util-home", "home"]],
    );
    assert.equal(AGENTS_GETS(home).length, 0, "codex has nothing to decide");
  } finally {
    await home.close();
  }
});

test("M1 F-B REAL CLI: the broker FORCES home (A-49) while the pool is ready — a Claude `exec` posts util-home, as the capacity answer judges every request against the home cap", async () => {
  const r = await rig({ brokerStatus: { placement: { forced: "home" } }, stub: { exit: 0 } });
  try {
    const result = await cli(["--agent", CLAUDE, "exec", "hi"], r.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      POSTS(r).map((post) => [post.key, post.body?.placement]),
      [["util-home", "home"]],
    );
  } finally {
    await r.close();
  }
});

test("M1 F-B REAL CLI: an OLDER broker (no `placement` field) with the pool not ready reads as not-forced and the pool unusable → util-home; with the pool ready → util-pool", async () => {
  const gaps = await rig({
    brokerStatus: { pool: TEMPLATE_GAPS, placement: { omit: true } },
    stub: { exit: 0 },
  });
  try {
    await cli(["--agent", CLAUDE, "exec", "hi"], gaps.env);
    assert.deepEqual(
      POSTS(gaps).map((post) => post.key),
      ["util-home"],
    );
  } finally {
    await gaps.close();
  }
  const ready = await rig({ brokerStatus: { placement: { omit: true } }, stub: { exit: 0 } });
  try {
    await cli(["--agent", CLAUDE, "exec", "hi"], ready.env);
    assert.deepEqual(
      POSTS(ready).map((post) => post.key),
      ["util-pool"],
    );
  } finally {
    await ready.close();
  }
});

test("M1 F-B REAL CLI: the capacity answer CANNOT be read (GET fails) — the key stays util-pool and the broker decides at the POST, exactly as a create (which never refuses for a broker it cannot read); no new refusal", async () => {
  const r = await rig({ statusFails: true, stub: { exit: 0, stdout: "ran\n" } });
  try {
    const result = await cli(["--agent", CLAUDE, "exec", "hi"], r.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(AGENTS_GETS(r).length, 1, "it did try to read");
    assert.deepEqual(
      POSTS(r).map((post) => post.key),
      ["util-pool"],
    );
  } finally {
    await r.close();
  }
});

test("M1 F-B fix round 1 REAL CLI: a HANGING capacity read counts against the call's deadline — the routed call's absolute deadline is `--timeout` + grace from the CLI's START, not from after the read; the call still places util-pool and runs (red before the fix: the deadline sat ~5 s later)", async () => {
  const r = await rig({ statusHangs: true, stub: { exit: 0, stdout: "ran\n" } });
  try {
    const startedAt = Date.now();
    const result = await cli(["--agent", CLAUDE, "--timeout", "1", "exec", "hi"], r.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      POSTS(r).map((post) => post.key),
      ["util-pool"],
      "an unreadable answer keeps util-pool and the POST places it",
    );
    assert.equal(AGENTS_GETS(r).length, 1);
    assert.equal(AGENTS_GETS(r)[0]?.outcome, "status_hung");
    const call = r.calls()[0];
    assert.ok(call);
    const deadlineAt = Number(call.argv[call.argv.indexOf("--deadline-ms") + 1]);
    const own = UTILITY_TIMEOUT_GRACE_MS + 1_000; // `--timeout 1` + the grace
    // The CLI's own start-up before the clock is a fraction of a second; the 5 s read must NOT be on top of it.
    assert.ok(deadlineAt - startedAt >= own - 50, `${deadlineAt - startedAt}`);
    assert.ok(deadlineAt - startedAt < own + 3_500, `${deadlineAt - startedAt}`);
  } finally {
    await r.close();
  }
});

test("M1 F-B fix round 2 REAL CLI: a HANGING capacity read AND a pod that never wakes — the call ends inside the WAKE BOUND measured from the CLI's start (exit 75 pod_starting), the read does not sit on top of it (red before the fix: ~read-bound later)", async () => {
  const WAKE_BOUND_MS = 8_000; // the test seam shortens the production 20 s; the read's own bound is 5 s
  const r = await rig({
    statusHangs: true,
    postHangs: true,
    extraEnv: { ACPX_TEST_WAKE_BOUND_MS: String(WAKE_BOUND_MS) },
    stub: { exit: 0 },
  });
  try {
    const startedAt = Date.now();
    const result = await cli(["--agent", CLAUDE, "--timeout", "1", "exec", "hi"], r.env);
    const took = Date.now() - startedAt;
    assert.equal(result.code, 75, result.stderr);
    assert.match(
      result.stderr.split("\n")[0] ?? "",
      /^acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 /,
    );
    assert.equal(AGENTS_GETS(r)[0]?.outcome, "status_hung");
    assert.equal(r.calls().length, 0, "nothing ran");
    // Start-up of the CLI is a fraction of a second; the 5 s read must not come on top of the 8 s bound.
    assert.ok(took >= WAKE_BOUND_MS - 500, `${took}`);
    assert.ok(took < WAKE_BOUND_MS + 2_500, `${took}`);
  } finally {
    await r.close();
  }
});
