/**
 * A6's tier-0 gate step: the routed call (C2) through the REAL `agent-exec` and the REAL pod-side
 * entry, on the loopback agent pod of infra's test kit. NOT a `pnpm test` row: it needs infra's
 * checkout, and a row that skips without it would be a silent pass.
 *
 *   pnpm run pod:loopback-gate        (in a workbench; unprivileged)
 *
 * Exit 0 = every case matched · 1 = a case did not match · 3 = NOT RUNNABLE HERE (the argocd
 * checkout or the pin is missing) — never a pass.
 *
 * The loopback is materialised from the local `.bare` at ONE pin (below) with `git archive`;
 * nothing of infra's is vendored. When infra moves the pin, only ARGOCD_PIN changes.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { CapacityRefusedError } from "../src/errors.js";
import { RoutedCallError } from "../src/pod/pod-refusal.js";
import { agentPodKey, type RoutedCallOptions, runRoutedCall } from "../src/pod/routed-call.js";
import { makeSessionRecord, writeSessionRecordFile } from "../test/runtime-test-helpers.js";

const ARGOCD_PIN = "7c7e34e4";
const ARGOCD_BARE = "/workspace/projects/argocd-master-application/.bare";
const LOOPBACK_PATH = "tool-containers/dev-server-common";
const NOT_RUNNABLE = 3;

type Loopback = { dir: string; wrapper: string; key: string; uid: string; payloadDir: string };

function sh(command: string, args: string[], cwd?: string): string {
  const r = spawnSync(command, args, { encoding: "utf8", cwd });
  if (r.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} → ${r.status}: ${r.stderr.slice(0, 300)}`);
  }
  return r.stdout;
}

function notRunnable(why: string): never {
  process.stderr.write(`pod-loopback-gate: NOT RUNNABLE HERE — ${why}\n`);
  process.exit(NOT_RUNNABLE);
}

function materialise(): string {
  if (!fs.existsSync(ARGOCD_BARE)) {
    notRunnable(
      `${ARGOCD_BARE} does not exist (the argocd-master-application checkout lives on devbox)`,
    );
  }
  const has = spawnSync("git", [
    "--git-dir",
    ARGOCD_BARE,
    "cat-file",
    "-e",
    `${ARGOCD_PIN}^{commit}`,
  ]);
  if (has.status !== 0) {
    notRunnable(
      `commit ${ARGOCD_PIN} is not in ${ARGOCD_BARE} (the pin lives on devbox's branch ap-transport)`,
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pod-loopback-gate-"));
  const tar = path.join(root, "src.tar");
  sh("git", ["--git-dir", ARGOCD_BARE, "archive", "-o", tar, ARGOCD_PIN, LOOPBACK_PATH]);
  sh("tar", ["-x", "-f", tar, "-C", root]);
  return root;
}

function loopback(script: string, args: string[]): string {
  return sh(script, args);
}

/** The session the CLI rows are about; the loopback pod is started under ITS key. */
const CLI_SESSION = "11111111-1111-4111-8111-111111111111";

function startLoopback(script: string, root: string, key = agentPodKey(CLI_SESSION)): Loopback {
  const kv = Object.fromEntries(
    loopback(script, ["start", "--key", key])
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return {
    dir: kv.LOOPBACK_DIR ?? "",
    wrapper: kv.ACPX_AGENT_EXEC ?? "",
    key: kv.AGENT_KEY ?? "",
    uid: kv.AGENT_POD_UID ?? "",
    // Never the box's real ~/.acpx/routed: this gate runs with its own state (COMMON.md "Live state").
    payloadDir: path.join(root, "routed"),
  };
}

type Sink = { text: string; write(chunk: string | Uint8Array): boolean };
const sink = (): Sink => ({
  text: "",
  write(chunk) {
    this.text += chunk.toString();
    return true;
  },
});

type Observed = { verdict: string; stdout: string; stderr: string };

async function observe(lb: Loopback, overrides: Partial<RoutedCallOptions>): Promise<Observed> {
  const out = sink();
  const err = sink();
  let verdict: string;
  try {
    const r = await runRoutedCall({
      class: "owner-if-pod",
      key: lb.key,
      target: { sessionId: "gate-session", seat: "gate-seat", harness: "claude" },
      argv: ["true"],
      cwd: "/workspace",
      // The WHOLE caller environment, canaries included, as production hands it over: acpx's own wall
      // (`buildTransportEnv`) has to keep them out, not a pre-scrubbed copy (TE I-1).
      env: process.env,
      lookup: async () => ({
        state: "exists",
        uid: lb.uid,
        ready: true,
        readyAtMs: Date.now(),
        ip: "127.0.0.1",
      }),
      transportPath: lb.wrapper,
      payloadDir: lb.payloadDir,
      stdout: out as unknown as NodeJS.WritableStream,
      stderr: err as unknown as NodeJS.WritableStream,
      ...overrides,
    });
    verdict = r.kind === "completed" ? `completed exit=${r.exitCode}` : r.kind;
  } catch (error) {
    verdict =
      error instanceof CapacityRefusedError || error instanceof RoutedCallError
        ? error.stderrLine
        : `unexpected ${String(error)}`;
  }
  return { verdict, stdout: out.text, stderr: err.text };
}

type Setting = Array<[string, string]>;
type Case = {
  label: string;
  /** `agent-loopback set` calls made before the call, and the ones that put the pod right after. */
  set?: (lb: Loopback) => Setting;
  restore?: (lb: Loopback) => Setting;
  options?: (lb: Loopback) => Partial<RoutedCallOptions>;
  expect: (o: Observed) => string | undefined;
};

const re = (want: RegExp) => (o: Observed) =>
  want.test(o.verdict) ? undefined : `verdict ${o.verdict}`;
const TURNOVER =
  /^acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=gate-session$/;

const CASES: Case[] = [
  {
    label: "echo through the pod: exit 0, stdout relayed",
    options: () => ({ argv: ["echo", "hello-from-pod"] }),
    expect: (o) =>
      o.verdict === "completed exit=0" && o.stdout === "hello-from-pod\n"
        ? undefined
        : JSON.stringify(o),
  },
  {
    label: "the command's own exit code, stdout and stderr pass through",
    options: () => ({ argv: ["sh", "-c", "echo out; echo err >&2; exit 3"] }),
    expect: (o) =>
      o.verdict === "completed exit=3" && o.stdout === "out\n" && o.stderr.startsWith("err\n")
        ? undefined
        : JSON.stringify(o),
  },
  {
    label: "pod ending → pod_starting phase=turnover",
    set: () => [["ending", "on"]],
    restore: () => [["ending", "off"]],
    expect: re(TURNOVER),
  },
  {
    label: "contract older than the call needs → turnover",
    set: () => [["contract", "0"]],
    restore: () => [["contract", "1"]],
    expect: re(TURNOVER),
  },
  {
    // rc 69 `identity` (infra 831a7a93): an authenticated pod whose identity marker is not its own.
    label: "a pod whose identity marker is wrong → not_run identity",
    set: () => [["marker", "not-this-pod"]],
    restore: (lb) => [["marker", `ag-${lb.key}`]],
    expect: re(/^acpx: ROUTED outcome=not_run reason=identity call_id=\S+$/),
  },
  {
    label: "a pod whose role is not control → not_run identity",
    set: () => [["role", "workbench"]],
    restore: () => [["role", "control"]],
    expect: re(/^acpx: ROUTED outcome=not_run reason=identity call_id=\S+$/),
  },
  {
    label: "a pod with another uid → not_run uid_mismatch",
    set: () => [["pod-uid", "00000000-0000-4000-8000-000000000000"]],
    restore: (lb) => [["pod-uid", lb.uid]],
    expect: re(/^acpx: ROUTED outcome=not_run reason=uid_mismatch call_id=\S+$/),
  },
  {
    label: "cwd not under a shared root → not_run",
    options: () => ({ cwd: "/tmp" }),
    expect: re(/^acpx: ROUTED outcome=not_run reason=cwd_not_shared call_id=\S+$/),
  },
  {
    label: "a command past its deadline → unknown deadline",
    // The gate's loopback pod is a SESSION's pod (its identity marker names `lb.key`), so the deadline is the
    // `owner-if-pod` call's own. (The case once passed `class: "one-shot"` with a Claude session's target, which
    // A-7's utility-scope check refuses before anything runs — the one-shot form has its own rows in
    // `test/pod-routed-call.test.ts`.)
    options: () => ({
      argv: ["sleep", "30"],
      deadlineMs: 2000,
    }),
    expect: re(/^acpx: ROUTED outcome=unknown reason=deadline call_id=\S+$/),
  },
  {
    label: "the payload file is visible in the pod, at the path ACPX_ROUTED_PAYLOAD names",
    options: () => ({ payload: "payload-body", argv: ["sh", "-c", 'cat "$ACPX_ROUTED_PAYLOAD"'] }),
    expect: (o) =>
      o.verdict === "completed exit=0" && o.stdout === "payload-body"
        ? undefined
        : JSON.stringify(o),
  },
  {
    label:
      "the environment wall: the per-call values arrive, the caller's secrets and settings do not",
    options: () => ({
      argv: ["env"],
      callerIdentity: { ACPX_SESSION_URL: "https://h/?session=gate" },
    }),
    expect: (o) => {
      const names = new Set(o.stdout.split("\n").map((line) => line.split("=")[0]));
      const missing = [
        "ACPX_ROUTED",
        "ACPX_ROUTED_CALL_ID",
        "ACPX_ROUTED_DEADLINE_MS",
        "ACPX_SESSION_URL",
      ].filter((n) => !names.has(n));
      const leaked = ["GATE_SECRET_TOKEN", "ACPX_STATE_HOME", "ACPX_ROUTED_PAYLOAD_FORGED"].filter(
        (n) => names.has(n),
      );
      return o.verdict === "completed exit=0" && missing.length === 0 && leaked.length === 0
        ? undefined
        : `missing=${missing.join(",")} leaked=${leaked.join(",")} verdict=${o.verdict}`;
    },
  },
];

// ───────────── the one-shot (utility-scope) cases (brick 27b28c68, L-557-1 / TE F-1) ─────────────

/**
 * A one-shot's call carries a utility key (`util-pool` / `util-home`: `assertUtilityTarget`) and a utility target
 * (no session, no seat), and the pod-side entry checks the key against the pod's identity. The loopback only STARTS
 * under a 24-hex session key — but its own `set` verbs retarget it: `set <dir> hostname ag-util-pool` and
 * `set <dir> marker ag-util-pool` give it a utility pod's identity, and the call is handed the pod by uid
 * (`expectUid`) the way a one-shot is handed a Ready pod. The cases run on a loopback of their own, in order: the
 * FIRST is the refusal BEFORE the retarget (the host is still `ag-<24 hex>`), the rest run after it.
 */
const UTILITY_KEY = "util-pool";
const UTILITY_SESSION = "22222222-2222-4222-8222-222222222222";
const utilityOptions = (lb: Loopback): Partial<RoutedCallOptions> => ({
  class: "one-shot",
  key: UTILITY_KEY,
  target: { sessionId: "", seat: "", harness: "utility" },
  expectUid: lb.uid,
  lookup: undefined,
  deadlineMs: 20_000, // a one-shot carries its own deadline (C2); the deadline case shortens it
});

const UTILITY_CASES: Case[] = [
  {
    label: "one-shot before the pod is retargeted (its host is still ag-<hex>) → not_run identity",
    options: (lb) => ({ ...utilityOptions(lb), argv: ["echo", "must-not-run"] }),
    expect: (o) =>
      /^acpx: ROUTED outcome=not_run reason=identity call_id=\S+$/.test(o.verdict) &&
      o.stdout === ""
        ? undefined
        : JSON.stringify(o),
  },
  {
    label: "one-shot through the utility pod: exit 0, stdout relayed",
    set: () => [
      ["hostname", "ag-util-pool"],
      ["marker", "ag-util-pool"],
    ],
    options: (lb) => ({ ...utilityOptions(lb), argv: ["echo", "hello-from-utility"] }),
    expect: (o) =>
      o.verdict === "completed exit=0" && o.stdout === "hello-from-utility\n"
        ? undefined
        : JSON.stringify(o),
  },
  {
    label: "one-shot: the command's own exit code and streams pass through",
    options: (lb) => ({
      ...utilityOptions(lb),
      argv: ["sh", "-c", "echo out; echo err >&2; exit 7"],
    }),
    expect: (o) =>
      o.verdict === "completed exit=7" && o.stdout === "out\n" && o.stderr.startsWith("err\n")
        ? undefined
        : JSON.stringify(o),
  },
  {
    label: "one-shot to a pod with another uid → not_run uid_mismatch",
    options: (lb) => ({
      ...utilityOptions(lb),
      expectUid: "00000000-0000-4000-8000-000000000000",
      argv: ["echo", "must-not-run"],
    }),
    expect: (o) =>
      /^acpx: ROUTED outcome=not_run reason=uid_mismatch call_id=\S+$/.test(o.verdict) &&
      o.stdout === ""
        ? undefined
        : JSON.stringify(o),
  },
  {
    label: "one-shot past its OWN deadline → unknown deadline",
    options: (lb) => ({
      ...utilityOptions(lb),
      argv: ["sleep", "30"],
      deadlineMs: 2000,
    }),
    expect: re(/^acpx: ROUTED outcome=unknown reason=deadline call_id=\S+$/),
  },
  {
    label: "one-shot for util-home against the util-pool pod → not_run identity",
    options: (lb) => ({ ...utilityOptions(lb), key: "util-home", argv: ["echo", "must-not-run"] }),
    expect: re(/^acpx: ROUTED outcome=not_run reason=identity call_id=\S+$/),
  },
];

async function runCase(lb: Loopback, script: string, testCase: Case): Promise<string | undefined> {
  for (const [what, value] of testCase.set?.(lb) ?? []) {
    loopback(script, ["set", lb.dir, what, value]);
  }
  try {
    return testCase.expect(await observe(lb, testCase.options?.(lb) ?? {}));
  } finally {
    for (const [what, value] of testCase.restore?.(lb) ?? []) {
      loopback(script, ["set", lb.dir, what, value]);
    }
  }
}

// ───────────── the REAL CLI → REAL agent-exec → REAL pod entry → an `acpx` in the pod (TE F-1) ─────────────

const POD_STUB_ACPX = `#!/usr/bin/env bash
printf 'STUB-ACPX routed=%s canary=%s\\n' "$ACPX_ROUTED" "\${GATE_SECRET_TOKEN:-none}"
printf '%s\\n' "$@"
`;

type PodApi = { url: string; close(): void };

/** A fake API server that says the loopback pod is Ready (the lookup's one question). */
async function startFakeApi(lb: Loopback): Promise<PodApi> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        items: [
          {
            metadata: { uid: lb.uid },
            status: {
              phase: "Running",
              podIP: "127.0.0.1",
              conditions: [
                { type: "Ready", status: "True", lastTransitionTime: new Date().toISOString() },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

type CliCase = { label: string; argv: string[]; want: string[] };

const CLI_CASES: CliCase[] = [
  {
    label: "CLI `claude prompt` → the pod runs `acpx claude prompt …` (the verb arrives)",
    argv: ["claude", "prompt", "--session-id", CLI_SESSION, "hello"],
    want: ["claude", "prompt", "--session-id", CLI_SESSION, "hello"],
  },
  {
    label: "CLI `prompt` → the pod runs `acpx prompt …`",
    argv: ["prompt", "--session-id", CLI_SESSION, "hello"],
    want: ["prompt", "--session-id", CLI_SESSION, "hello"],
  },
  {
    label: "CLI `cancel` (owner-if-pod) → the pod runs `acpx cancel …`",
    argv: ["cancel", "--session-id", CLI_SESSION],
    want: ["cancel", "--session-id", CLI_SESSION],
  },
];

function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function runCliCase(
  lb: Loopback,
  api: PodApi,
  home: string,
  saDir: string,
  testCase: CliCase,
): Promise<string | undefined> {
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  // ASYNC spawn: the fake API server lives in THIS process, so a blocking spawn would starve it.
  const result = await runChild(tsx, ["src/cli.ts", ...testCase.argv], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    // The seams of A1's pod mode, honoured only under node --test: the CLI is run as a test child.
    NODE_TEST_CONTEXT: "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: home,
    NV_POD_NAME: "dev-server-gate",
    NV_POD_UID: "ctl-uid-gate",
    NV_NODE_NAME: "node-gate",
    ACPX_POD_SA_DIR: saDir,
    ACPX_POD_API_URL: api.url,
    ACPX_AGENT_EXEC: lb.wrapper,
    ACPX_UI_BASE_URL: "https://atrium.gate.invalid",
    // A canary handed to the CLI: acpx's own wall must keep it out of the pod.
    GATE_SECRET_TOKEN: "must-not-travel",
  });
  const wantOut = `STUB-ACPX routed=1 canary=none\n${testCase.want.join("\n")}\n`;
  if (result.status !== 0) {
    return `exit ${result.status}: ${result.stderr.slice(0, 300)}`;
  }
  return result.stdout === wantOut ? undefined : `stdout ${JSON.stringify(result.stdout)}`;
}

async function runCliCases(lb: Loopback, script: string, root: string): Promise<number> {
  const stubDir = path.join(root, "pod-bin");
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "acpx"), POD_STUB_ACPX, { mode: 0o755 });
  // The pod resolves `acpx` on its PATH (C2/C8): put the stub first — through the pod's environment file.
  loopback(script, ["set", lb.dir, "env-add", `PATH=${stubDir}:/usr/local/bin:/usr/bin:/bin`]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pod-loopback-gate-home-"));
  const saDir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-loopback-gate-sa-"));
  fs.writeFileSync(path.join(saDir, "namespace"), "dev-gate\n");
  fs.writeFileSync(path.join(saDir, "token"), "gate-token\n");
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: CLI_SESSION,
      acpSessionId: CLI_SESSION,
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace",
    }),
  );
  const api = await startFakeApi(lb);
  let failures = 0;
  try {
    for (const testCase of CLI_CASES) {
      const problem = await runCliCase(lb, api, home, saDir, testCase);
      process.stdout.write(
        `${problem === undefined ? "ok     " : "FAILED "} ${testCase.label}${problem ? ` — ${problem}` : ""}\n`,
      );
      failures += problem === undefined ? 0 : 1;
    }
  } finally {
    api.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(saDir, { recursive: true, force: true });
  }
  return failures;
}

async function main(): Promise<void> {
  process.env.GATE_SECRET_TOKEN = "must-not-travel";
  process.env.ACPX_STATE_HOME = "/tmp/must-not-travel";
  process.env.ACPX_ROUTED_PAYLOAD_FORGED = "must-not-travel";
  const root = materialise();
  const script = path.join(root, LOOPBACK_PATH, "tests", "agent-loopback");
  const lb = startLoopback(script, root);
  let failures = 0;
  try {
    for (const testCase of CASES) {
      const problem = await runCase(lb, script, testCase);
      process.stdout.write(
        `${problem === undefined ? "ok     " : "FAILED "} ${testCase.label}${problem ? ` — ${problem}` : ""}\n`,
      );
      failures += problem === undefined ? 0 : 1;
    }
    failures += await runCliCases(lb, script, root);
    const utility = startLoopback(script, root, agentPodKey(UTILITY_SESSION));
    try {
      for (const testCase of UTILITY_CASES) {
        const problem = await runCase(utility, script, testCase);
        process.stdout.write(
          `${problem === undefined ? "ok     " : "FAILED "} ${testCase.label}${problem ? ` — ${problem}` : ""}\n`,
        );
        failures += problem === undefined ? 0 : 1;
      }
    } finally {
      loopback(script, ["stop", utility.dir]);
    }
  } finally {
    loopback(script, ["stop", lb.dir]);
    fs.rmSync(root, { recursive: true, force: true });
  }
  const total = CASES.length + CLI_CASES.length + UTILITY_CASES.length;
  process.stdout.write(
    `pod-loopback-gate: ${total - failures}/${total} cases matched (argocd pin ${ARGOCD_PIN})\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
