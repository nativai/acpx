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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapacityRefusedError } from "../src/errors.js";
import { RoutedCallError } from "../src/pod/pod-refusal.js";
import { type RoutedCallOptions, runRoutedCall } from "../src/pod/routed-call.js";

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

function startLoopback(script: string, root: string): Loopback {
  const kv = Object.fromEntries(
    loopback(script, ["start"])
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
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir() },
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
    options: (lb) => ({
      class: "one-shot",
      expectUid: lb.uid,
      argv: ["sleep", "30"],
      deadlineMs: 2000,
      lookup: undefined,
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
  } finally {
    loopback(script, ["stop", lb.dir]);
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(
    `pod-loopback-gate: ${CASES.length - failures}/${CASES.length} cases matched (argocd pin ${ARGOCD_PIN})\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
