import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentPodName } from "../src/pod/placement.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Block A9, fix round (A9 TE finding K1, CRITICAL): a `prompt` — or a live `set` — of a pod session in
// ITS OWN pod is LOCAL, and with no owner yet (every pod's first prompt: the broker has just started the
// pod) it passes the wake gate (`admitWake`). The first A9 build asserted the A-8 ledger guard there and
// so refused every first message to every pod session with exit 2 `pod_foreign_write file=ledger`.
// These rows run the REAL CLI as that agent pod: place file `ag-<key of the record>`, pod identity, and
// the admission directory where production has it — under the canonical home (`<home>/.acpx/admission`),
// where the guard fires. The adapter is a real-shaped SENTINEL (`…/claude-agent-acp/dist/index.js`): run,
// it appends to SPAWNED and exits 1, so "SPAWNED present" is the proof the wake got past the gate.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a9-own-pod-")));

type Rig = {
  home: string;
  env: NodeJS.ProcessEnv;
  id: string;
  admission: string;
  spawned: () => string[];
};

function rig(): Rig {
  const root = fs.mkdtempSync(path.join(ROOT, "pod-"));
  const home = path.join(root, "home");
  const sa = path.join(root, "sa");
  fs.mkdirSync(path.join(home, ".acpx", "sessions"), { recursive: true });
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  const id = "0f0e0d0c-0b0a-4909-8807-060504030201";
  const pod = agentPodName(id);
  fs.writeFileSync(path.join(home, ".nv-agent"), `${pod}\n`);
  const marker = path.join(root, "SPAWNED");
  const adapter = path.join(root, "claude-agent-acp", "dist", "index.js");
  fs.mkdirSync(path.dirname(adapter), { recursive: true });
  fs.writeFileSync(
    adapter,
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "claude\\n");\nprocess.exit(1);\n`,
  );
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: `node ${adapter}`,
    cwd: root,
  });
  fs.writeFileSync(
    path.join(home, ".acpx", "sessions", `${id}.json`),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
  );
  const admission = path.join(home, ".acpx", "admission");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    NODE_TEST_CONTEXT: "child",
    ACPX_POD_TEST_HOME: home,
    ACPX_POD_SA_DIR: sa,
    ACPX_STATE_HOME: home,
    ACPX_ADMISSION_DIR: admission,
    ACPX_POD_TEST_HOSTNAME: pod,
    NV_POD_NAME: pod,
    NV_POD_UID: "11111111-2222-4333-8444-555555555555",
    NV_NODE_NAME: "node-a",
    NV_AGENT_SESSION_ID: id,
    NV_AGENT_PLACEMENT: "home",
    ACPX_POD_API_URL: "http://127.0.0.1:9", // nothing answers
  };
  return {
    home,
    env,
    id,
    admission,
    spawned: () =>
      fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [],
  };
}

type Run = { code: number | null; out: string };

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stdin.end();
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const CALLERS: Array<[string, NodeJS.ProcessEnv]> = [
  ["a person (no caller identity, no class)", {}],
  ["an agent caller (A-29 identity)", { ACPX_SESSION_RECORD_ID: "caller-aaaa" }],
  ["atrium's routed delivery (class delivery)", { ACPX_ADMISSION_CLASS: "delivery" }],
];

for (const [who, extra] of CALLERS) {
  test(`K1: the FIRST prompt of a pod session in its own pod, from ${who}, passes the wake gate — no pod_foreign_write, adapter started, nothing under admission/`, async () => {
    const r = rig();
    const done = await run(
      ["--format", "json", "prompt", "--session-id", r.id, "hello"],
      { ...r.env, ...extra },
      r.home,
    );
    assert.doesNotMatch(done.out, /pod_foreign_write/u, done.out);
    assert.notEqual(done.code, 2, done.out);
    assert.deepEqual(r.spawned(), ["claude"], "the wake got past the gate and started the adapter");
    assert.equal(fs.existsSync(r.admission), false, "no ledger, lock or log was written");
  });
}

test("K1: a live `set` of a pod session in its own pod (gateSetConnect) passes the wake gate the same way", async () => {
  const r = rig();
  const done = await run(
    ["--format", "json", "claude", "set", "effort", "low", "--session-id", r.id],
    r.env,
    r.home,
  );
  assert.doesNotMatch(done.out, /pod_foreign_write/u, done.out);
  assert.deepEqual(r.spawned(), ["claude"], "the live set started the adapter");
  assert.equal(fs.existsSync(r.admission), false);
});

test("K1 control: `sessions new` run in the pod (class create, passed through) writes no admission byte under the canonical home either", async () => {
  // With no atrium to call home to it ends there; the assertion is only that nothing was written.
  const r = rig();
  await run(
    ["--format", "json", "sessions", "new"],
    { ...r.env, ACPX_SESSION_RECORD_ID: "caller-aaaa" },
    r.home,
  );
  assert.equal(fs.existsSync(r.admission), false);
});
