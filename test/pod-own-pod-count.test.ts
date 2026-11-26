import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ensureAgentPod, getAgents } from "../src/pod/broker-client.js";
import { sessionKey } from "../src/pod/placement.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import {
  type BrokerBehavior,
  type BrokerStatus,
  type FakeBroker,
  startFakeBroker,
  wellFormedAgentRequest,
} from "./pod-kit/fake-broker.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import { type Fixture, makeBox, runCli } from "./umq-rig.js";

// brick 5d6e9509 (the acpx half of 8e5a4ea4): a STARTING head never counts its own pod in the pod-plane
// wake gate. A re-drive of a pod_starting head is a control-pod `acpx prompt`; the broker's `live` already
// includes that head's own starting Job, so at cap − 1 the head was refused `agent_cap` by its own pod.
// The contract (infra #17): `GET /v1/agents?exclude=<bare session key>` drops that key's Job from `live`,
// `home.live` and `quota.used` and echoes `excluded: "<key>"`; an older broker ignores the parameter and
// sends no `excluded` — acpx must read that as NOT excluded. Each row seeds a REAL starting Job for the
// head's key into the kit's fake broker (a POST that never finishes) — nothing is scripted around it.

const CLAUDE = "node /opt/claude-agent-acp/release-2/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";
const HEAD = "own-head";
const STRANGER = "own-stranger";
const HEAD_KEY = sessionKey(HEAD);
const STRANGER_KEY = sessionKey(STRANGER);

function podEnv(f: Fixture, brokerUrl: string): NodeJS.ProcessEnv {
  const sa = path.join(f.root, "serviceaccount");
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  return {
    ...f.env,
    NODE_TEST_CONTEXT: "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: f.root,
    ACPX_POD_SA_DIR: sa,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
    NV_AGENT_BROKER_URL: brokerUrl,
  };
}

function writeRecord(f: Fixture, id: string, agentCommand: string): void {
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand,
    cwd: f.root,
  });
  fs.writeFileSync(
    path.join(f.root, ".acpx", "sessions", `${id}.json`),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
  );
}

type Json = Record<string, unknown>;
const lastJson = (stdout: string): Json =>
  JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Json;

const wake = async (f: Fixture, url: string, id: string) =>
  await runCli(
    ["--format", "json", "capacity", "admit-wake", "--session-id", id, "--class", "delivery"],
    podEnv(f, url),
    f.root,
  );

const STARTING: BrokerBehavior = { steps: ["scheduling"], hang: true };

/** A kit broker holding a real STARTING Job for `sessionId` (the head's own pod), figures as scripted. */
async function brokerWithStartingHead(
  sessionId: string,
  status: BrokerStatus,
  placement: "auto" | "home",
  harness: "claude" | "codex",
): Promise<FakeBroker> {
  const key = sessionKey(sessionId);
  // the Job is created while the box has room; the scripted figures (the box AT cap − 1) are set afterwards
  const script = { status, keys: { [key]: STARTING } };
  const broker = await startFakeBroker({
    status: { cap: 100, home: { cap: 100 } },
    keys: script.keys,
  });
  const built = wellFormedAgentRequest(sessionId, { harness, placement, class: "spawn" });
  const seeded = await ensureAgentPod(built.key, built.body as never, {
    origin: broker.url,
    wakeBoundMs: 300,
  });
  assert.equal(seeded.kind, "wake_bound", `the head's Job is starting: ${JSON.stringify(seeded)}`);
  broker.setScript(script);
  const control = await getAgents({ origin: broker.url });
  assert.ok(control.ok);
  assert.equal(control.agents.live >= 1, true, "control: the starting Job is in the broker's live");
  return broker;
}

const getQueries = (broker: FakeBroker): string[] =>
  broker.requests.filter((r) => r.method === "GET" && r.path === "/v1/agents").map((r) => r.query);

// cap 11 less the people's reserve 1 = 10 admit-able; the head's own starting Job is the 10th: cap − 1.
const POOL_AT_CAP_MINUS_1: BrokerStatus = { live: 10, cap: 11 };
// home-only harness: the home cap binds — home 2/2 with the head's own Job one of the two.
const HOME_AT_CAP_MINUS_1: BrokerStatus = { live: 3, cap: 11, home: { live: 2, cap: 2 } };

test("own-pod row 1 (pool): a STARTING head at cap − 1 — its own Job is in `live` — is admitted; the request carries exactly its key", async () => {
  const f = makeBox({});
  writeRecord(f, HEAD, CLAUDE);
  const broker = await brokerWithStartingHead(HEAD, POOL_AT_CAP_MINUS_1, "auto", "claude");
  try {
    const run = await wake(f, broker.url, HEAD);
    assert.equal(run.code, 0, `refused by its own pod: ${run.stdout}\n${run.stderr}`);
    assert.deepEqual(
      [lastJson(run.stdout).decision, lastJson(run.stdout).why],
      ["not-gated", "pod-room"],
    );
    // row 5: the URL the broker received carries exactly the target's bare key — never `ag-<key>`
    const asked = getQueries(broker).at(-1);
    assert.equal(asked, `exclude=${HEAD_KEY}`);
    assert.equal(
      broker.requests.some((r) => r.query.includes(`ag-${HEAD_KEY}`)),
      false,
    );
  } finally {
    await broker.close();
  }
});

test("own-pod row 1 (home): a STARTING home-only head at home cap − 1 — its own Job is in `home.live` — is admitted", async () => {
  const f = makeBox({});
  writeRecord(f, HEAD, CODEX);
  const broker = await brokerWithStartingHead(HEAD, HOME_AT_CAP_MINUS_1, "home", "codex");
  try {
    const run = await wake(f, broker.url, HEAD);
    assert.equal(run.code, 0, `refused by its own pod: ${run.stdout}\n${run.stderr}`);
    assert.equal(getQueries(broker).at(-1), `exclude=${HEAD_KEY}`);
  } finally {
    await broker.close();
  }
});

test("own-pod row 2 NEGATIVE: a STRANGER (another key) still sees the whole `live` — refused, and the request names the stranger's key, not the starting head's", async () => {
  for (const [harness, command, status, placement] of [
    ["claude", CLAUDE, POOL_AT_CAP_MINUS_1, "auto"],
    ["codex", CODEX, HOME_AT_CAP_MINUS_1, "home"],
  ] as const) {
    const f = makeBox({});
    writeRecord(f, STRANGER, command);
    const broker = await brokerWithStartingHead(HEAD, status, placement, harness);
    try {
      const run = await wake(f, broker.url, STRANGER);
      assert.equal(run.code, 75, `${harness}: ${run.stdout}\n${run.stderr}`);
      assert.equal((lastJson(run.stdout).refusal as Json).reason, "agent_cap");
      assert.equal(getQueries(broker).at(-1), `exclude=${STRANGER_KEY}`);
    } finally {
      await broker.close();
    }
  }
});

test("own-pod row 3: the target-less probes send NO `exclude` and answer as before (the whole live count)", async () => {
  const f = makeBox({});
  const broker = await brokerWithStartingHead(HEAD, POOL_AT_CAP_MINUS_1, "auto", "claude");
  try {
    const probe = await runCli(
      ["--format", "json", "capacity", "--class", "automation"],
      podEnv(f, broker.url),
      f.root,
    );
    assert.equal(probe.code, 0, probe.stderr);
    assert.equal(
      (lastJson(probe.stdout).freeSlots as Json).claude,
      0,
      "10 live of 10: no room, own pod or not",
    );
    const need = await runCli(
      ["--format", "json", "capacity", "--class", "automation", "--need", "1"],
      podEnv(f, broker.url),
      f.root,
    );
    assert.equal(need.code, 75, need.stdout);
    const queries = getQueries(broker);
    assert.equal(queries.length >= 3, true, `control: the probes did ask (${queries.length})`);
    assert.deepEqual(
      queries.filter((query) => query !== ""),
      [],
      "no probe sent a query",
    );
  } finally {
    await broker.close();
  }
});

test("own-pod row 4: an OLDER broker ignores `exclude` and sends no `excluded` — today's answer (refused, whole live), no failure", async () => {
  const f = makeBox({});
  writeRecord(f, HEAD, CLAUDE);
  const broker = await brokerWithStartingHead(
    HEAD,
    { ...POOL_AT_CAP_MINUS_1, ignoreExclude: true },
    "auto",
    "claude",
  );
  try {
    const run = await wake(f, broker.url, HEAD);
    assert.equal(run.code, 75, `${run.stdout}\n${run.stderr}`);
    const refusal = lastJson(run.stdout).refusal as Json;
    assert.equal(
      refusal.reason,
      "agent_cap",
      "a refusal in the broker's own numbers, not a failure",
    );
    assert.equal(refusal.live, 10);
    assert.equal(getQueries(broker).at(-1), `exclude=${HEAD_KEY}`, "it did ask");
    const raw = (await (await fetch(`${broker.url}/v1/agents?exclude=${HEAD_KEY}`)).json()) as Json;
    assert.equal(raw.excluded, undefined, "the older broker sends no `excluded` echo");
  } finally {
    await broker.close();
  }
});
