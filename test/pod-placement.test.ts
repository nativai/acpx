import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queueKeyForSession } from "../src/cli/queue/paths.js";
import { COMMAND_TABLE } from "../src/pod/command-classes.js";
import { decidePlacement, refusalFor, type PlacementDecision } from "../src/pod/placement-step.js";
import {
  agentPodName,
  canonicalHome,
  CANONICAL_HOME,
  placeOf,
  podModeVerdict,
  readAgentPodFile,
  sessionKey,
  TEST_HOME_ENV,
  type HostFacts,
  type PodModeVerdict,
} from "../src/pod/placement.js";

// brick b479441f — C1.1 (the switch, "where am I"), its amendment (NV_POD_UID), C1.2's dispatch and
// C7.2's `unclassified_command`. Every guarantee has a negative case: an input right in every other
// respect and wrong in exactly what the clause protects.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acpx-pod-"));
}

/** A service-account directory holding a namespace file (A5's `ACPX_POD_SA_DIR` seam). */
function saDir(namespace = "dev-devbox"): string {
  const dir = tmpDir();
  if (namespace !== "") {
    fs.writeFileSync(path.join(dir, "namespace"), `${namespace}\n`);
  }
  return dir;
}

const IDENTITY = (sa = saDir()): NodeJS.ProcessEnv => ({
  NODE_TEST_CONTEXT: "child",
  NV_POD_NAME: "dev-server-abc",
  NV_POD_UID: "uid-1",
  NV_NODE_NAME: "node-a",
  ACPX_POD_SA_DIR: sa,
});

function facts(over: Partial<HostFacts> & { env?: NodeJS.ProcessEnv } = {}): HostFacts {
  return {
    controlRole: true,
    homedir: CANONICAL_HOME,
    ...over,
    env: { ACPX_OWNER_PLACEMENT: "pod", ...IDENTITY(), ...over.env },
  };
}

const mode = (verdict: PodModeVerdict) =>
  verdict.mode === "pod"
    ? "pod"
    : verdict.mode === "off"
      ? `off:${verdict.why}`
      : `refuse:${verdict.reason}`;

// ─── C1.1: the switch ────────────────────────────────────────────────────────────────────────────

test("C1.1 all three conditions hold → pod mode", () => {
  assert.equal(mode(podModeVerdict(facts())), "pod");
});

test("C1.1 negatives: the switch or the host or the state home wrong alone → off (today)", () => {
  assert.equal(
    mode(podModeVerdict(facts({ env: { ACPX_OWNER_PLACEMENT: undefined } }))),
    "off:switch-unset",
  );
  assert.equal(
    mode(podModeVerdict(facts({ env: { ACPX_OWNER_PLACEMENT: "Pod" } }))),
    "off:switch-unset",
  );
  assert.equal(
    mode(podModeVerdict(facts({ env: { ACPX_OWNER_PLACEMENT: "1" } }))),
    "off:switch-unset",
  );
  assert.equal(mode(podModeVerdict(facts({ controlRole: false }))), "off:not-control-role");
  assert.equal(
    mode(podModeVerdict(facts({ homedir: "/tmp/elsewhere" }))),
    "off:non-canonical-state-home",
  );
  assert.equal(
    mode(podModeVerdict(facts({ homedir: "/home/node/sub" }))),
    "off:non-canonical-state-home",
  );
  assert.equal(
    mode(podModeVerdict(facts({ env: { ACPX_STATE_HOME: "/tmp/elsewhere" } }))),
    "off:non-canonical-state-home",
    "an override that resolves elsewhere leaves pod mode",
  );
});

test("C1.1 A-5: the state home is compared RESOLVED — an override that resolves to the canonical home stays in pod mode", () => {
  assert.equal(mode(podModeVerdict(facts({ env: { ACPX_STATE_HOME: "/home/node" } }))), "pod");
  assert.equal(mode(podModeVerdict(facts({ env: { ACPX_STATE_HOME: "/home/node/." } }))), "pod");
  assert.equal(
    mode(podModeVerdict(facts({ env: { ACPX_STATE_HOME: "" } }))),
    "pod",
    "empty = no override",
  );
  // Through a symlink, inside the seam's sandbox (the real /home/node cannot be linked from a test).
  const home = tmpDir();
  const link = path.join(tmpDir(), "link-to-home");
  fs.symlinkSync(home, link);
  const seam = { ACPX_POD_TEST_HOME: home };
  assert.equal(mode(podModeVerdict(facts({ homedir: link, env: seam }))), "pod");
  assert.equal(
    mode(podModeVerdict(facts({ homedir: "/x", env: { ...seam, ACPX_STATE_HOME: link } }))),
    "pod",
  );
});

test("C1.1 A-5: each identity part missing alone → refuse pod_identity_missing, never either mode", () => {
  for (const missing of ["NV_POD_NAME", "NV_POD_UID", "NV_NODE_NAME"]) {
    assert.equal(
      mode(podModeVerdict(facts({ env: { [missing]: undefined } }))),
      "refuse:pod_identity_missing",
      missing,
    );
    assert.equal(
      mode(podModeVerdict(facts({ env: { [missing]: "  " } }))),
      "refuse:pod_identity_missing",
      missing,
    );
  }
  assert.equal(
    mode(podModeVerdict(facts({ env: { ACPX_POD_SA_DIR: saDir("") } }))),
    "refuse:pod_identity_missing",
    "no namespace file",
  );
  assert.equal(
    mode(podModeVerdict(facts({ env: { ACPX_POD_SA_DIR: saDir(" ") } }))),
    "refuse:pod_identity_missing",
    "blank namespace",
  );
  // Pod mode off: the identity is irrelevant — present or absent, off.
  assert.equal(
    mode(podModeVerdict(facts({ controlRole: false, env: { NV_POD_UID: undefined } }))),
    "off:not-control-role",
  );
});

test("C1.1 A-6: the seam is honoured only under node --test, and leads only into its sandbox", () => {
  assert.equal(canonicalHome({ [TEST_HOME_ENV]: "/tmp/seam" }), CANONICAL_HOME);
  assert.equal(
    canonicalHome({ NODE_TEST_CONTEXT: "child", [TEST_HOME_ENV]: "/tmp/seam" }),
    "/tmp/seam",
  );
  const home = tmpDir();
  // Under the seam the host counts as control-role …
  assert.equal(
    mode(
      podModeVerdict(facts({ controlRole: false, homedir: home, env: { [TEST_HOME_ENV]: home } })),
    ),
    "pod",
  );
  // … and a state home outside the sandbox — the real one included — refuses.
  assert.equal(
    mode(podModeVerdict(facts({ homedir: CANONICAL_HOME, env: { [TEST_HOME_ENV]: home } }))),
    "refuse:test_seam_outside_sandbox",
  );
  // Outside node --test the seam is nothing: a workbench host stays off.
  assert.equal(
    mode(
      podModeVerdict(
        facts({
          controlRole: false,
          homedir: home,
          env: { NODE_TEST_CONTEXT: undefined, [TEST_HOME_ENV]: home },
        }),
      ),
    ),
    "off:not-control-role",
  );
});

// ─── C1.1: where am I ────────────────────────────────────────────────────────────────────────────

test("the session key is the lease key: SHA-256 hex, first 24 chars", () => {
  assert.equal(sessionKey("rec-1"), queueKeyForSession("rec-1"));
  assert.match(sessionKey("rec-1"), /^[0-9a-f]{24}$/u);
  assert.equal(agentPodName("rec-1"), `ag-${queueKeyForSession("rec-1")}`);
});

test("the pod file: only ENOENT is absent; empty or unreadable is NOT the control pod", () => {
  const dir = tmpDir();
  assert.deepEqual(readAgentPodFile(path.join(dir, "missing")), { kind: "absent" });
  fs.writeFileSync(path.join(dir, "named"), "ag-abc\n");
  assert.deepEqual(readAgentPodFile(path.join(dir, "named")), { kind: "pod", name: "ag-abc" });
  fs.writeFileSync(path.join(dir, "empty"), "\n");
  assert.deepEqual(readAgentPodFile(path.join(dir, "empty")), { kind: "unreadable" });
  fs.mkdirSync(path.join(dir, "a-dir"));
  assert.deepEqual(readAgentPodFile(path.join(dir, "a-dir")), { kind: "unreadable" });
});

test("three places: control / the session's own pod / another agent pod", () => {
  const own = { kind: "pod", name: agentPodName("rec-1") } as const;
  assert.equal(placeOf({ kind: "absent" }, "rec-1"), "control");
  assert.equal(placeOf({ kind: "absent" }, undefined), "control");
  assert.equal(placeOf(own, "rec-1"), "own-pod");
  assert.equal(placeOf(own, "rec-2"), "other-pod", "another session's key");
  assert.equal(placeOf(own, undefined), "other-pod", "an unresolved target is never own");
  assert.equal(placeOf({ kind: "pod", name: "ag-util-pool" }, "rec-1"), "other-pod");
  assert.equal(placeOf({ kind: "unreadable" }, "rec-1"), "other-pod");
});

// ─── C1.2: the dispatch, pure ────────────────────────────────────────────────────────────────────

function decide(
  argv: string[],
  over: { verdict?: PodModeVerdict; pod?: string; target?: string | null } = {},
): PlacementDecision {
  return decidePlacement({
    argv,
    verdict: over.verdict ?? { mode: "pod" },
    podFile: over.pod ? { kind: "pod", name: over.pod } : { kind: "absent" },
    builtInAgents: ["claude", "codex", "pi"],
    env: {},
    ...(over.target !== undefined ? { resolvedTarget: over.target } : {}),
  });
}

function summary(d: PlacementDecision): string {
  return d.kind === "branch" ? `branch:${d.branch}` : d.kind;
}

test("control pod: each class takes its C1.2 cell", () => {
  assert.equal(summary(decide(["prompt", "--session-id", "r", "hi"])), "branch:routed-ensure");
  assert.equal(summary(decide(["claude", "hi"])), "branch:routed-ensure");
  assert.equal(summary(decide(["sessions", "new"])), "branch:record-only-create");
  assert.equal(summary(decide(["status", "--session-id", "r"])), "branch:routed-if-pod");
  assert.equal(summary(decide(["set", "model", "x", "--session-id", "r"])), "branch:routed-if-pod");
  assert.equal(summary(decide(["exec", "hi"])), "branch:utility-pod");
  assert.equal(summary(decide(["sessions", "list"])), "branch:utility-pod");
  assert.equal(summary(decide(["sessions", "list", "--local"])), "local");
  assert.equal(
    summary(decide(["sessions", "set-metadata", "k", "v", "--session-id", "r"])),
    "local",
  );
  assert.equal(summary(decide(["seats", "rename", "s", "n"])), "local");
  assert.equal(summary(decide(["seats", "list"])), "local");
  assert.equal(summary(decide(["governor", "status"])), "local");
  assert.equal(summary(decide(["prompt", "--help"])), "local", "help runs nothing");
});

test("agent pod: a target-dependent class waits for the resolved target, then decides by it", () => {
  const pod = agentPodName("rec-own");
  assert.equal(summary(decide(["prompt", "--session-id", "x", "hi"], { pod })), "resolve-target");
  assert.equal(summary(decide(["prompt", "hi"], { pod, target: "rec-own" })), "local");
  assert.equal(
    summary(decide(["prompt", "hi"], { pod, target: "rec-other" })),
    "branch:message-route",
  );
  assert.equal(summary(decide(["prompt", "hi"], { pod, target: null })), "branch:message-route");
  assert.equal(
    summary(decide(["sessions", "set-os", "x", "default"], { pod, target: "rec-own" })),
    "local",
  );
  assert.equal(
    summary(decide(["sessions", "set-os", "x", "default"], { pod, target: "rec-other" })),
    "branch:pass-through",
  );
  assert.equal(summary(decide(["cancel"], { pod, target: "rec-other" })), "branch:pass-through");
  // Not target-dependent: decided at once.
  assert.equal(summary(decide(["sessions", "new"], { pod })), "branch:pass-through");
  assert.equal(summary(decide(["seats", "rename", "s", "n"], { pod })), "branch:pass-through");
  assert.equal(summary(decide(["exec", "hi"], { pod })), "local");
  assert.equal(summary(decide(["sessions", "show"], { pod })), "local");
});

test("A-7: control-pod maintenance refuses in an agent pod (control_pod_only), runs on the control pod", () => {
  const pod = agentPodName("rec-own");
  for (const argv of [
    ["governor", "status"],
    ["governor", "scan"],
    ["capacity", "run-build", "x"],
  ]) {
    const d = decide(argv, { pod });
    assert.equal(d.kind, "refuse-control-pod-only", JSON.stringify(argv));
    assert.equal(refusalFor(d)?.exitCode, 2);
    assert.equal(refusalFor(d)?.lines[0], "acpx: REFUSED reason=control_pod_only");
    assert.equal(decide(argv).kind, "local", `${JSON.stringify(argv)} on the control pod`);
  }
  // Ordinary `local` commands still run in an agent pod.
  assert.equal(decide(["help"], { pod }).kind, "local");
  assert.equal(decide(["--version"], { pod }).kind, "local");
});

test("unclassified refuses: exit 2 and the C7.2 line, exactly", () => {
  const d = decide(["seats", "zzz-new-verb"]);
  assert.equal(d.kind, "refuse-unclassified");
  const refusal = refusalFor(d);
  assert.equal(refusal?.exitCode, 2);
  assert.equal(refusal?.lines[0], "acpx: REFUSED reason=unclassified_command");
});

test("identity missing: everything but `local` refuses with exit 2 and the C7.2 line", () => {
  const verdict: PodModeVerdict = { mode: "refuse", reason: "pod_identity_missing" };
  // C7.2 (A-5): exit 2 and exactly this line.
  for (const argv of [
    ["prompt", "hi"],
    ["sessions", "show"],
    ["seats", "list"],
    ["sessions", "new"],
  ]) {
    const d = decide(argv, { verdict });
    assert.equal(d.kind, "refuse-pod-identity", JSON.stringify(argv));
    assert.equal(refusalFor(d)?.exitCode, 2);
    assert.equal(refusalFor(d)?.lines[0], "acpx: REFUSED reason=pod_identity_missing");
  }
  for (const argv of [["--version"], ["help"], ["governor", "status"], ["sessions", "new", "-h"]]) {
    assert.equal(decide(argv, { verdict }).kind, "local", JSON.stringify(argv));
  }
});

test("pod mode off: the step decides nothing", () => {
  assert.equal(
    decide(["prompt", "hi"], { verdict: { mode: "off", why: "switch-unset" } }).kind,
    "off",
  );
});

// ─── The real CLI, in a child process ────────────────────────────────────────────────────────────

type Run = { status: number | null; stdout: string; stderr: string };

function podHome(opts: { podFile?: string } = {}): string {
  const home = tmpDir();
  if (opts.podFile !== undefined) {
    fs.writeFileSync(path.join(home, ".nv-agent"), `${opts.podFile}\n`);
  }
  return home;
}

/** A child env: pod mode by the product's own seam (A-6), with a complete identity, unless overridden. */
function podEnv(home: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ACPX_OWNER_PLACEMENT: "pod",
    ...IDENTITY(),
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "child",
    [TEST_HOME_ENV]: home,
    ...over,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  if (!("ACPX_STATE_HOME" in over)) {
    delete env.ACPX_STATE_HOME;
  }
  return env;
}

function run(argv: string[], env: NodeJS.ProcessEnv): Run {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    env,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Whatever a started bridge or owner leaves in the state home. */
function startedAnything(home: string): string[] {
  const acpx = path.join(home, ".acpx");
  return ["queues", "sessions"].filter((d) => {
    const dir = path.join(acpx, d);
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => !f.startsWith("index"));
  });
}

test("CLI: EVERY bridge-capable path refuses on the control pod in pod mode, nothing started", () => {
  const home = podHome();
  const env = podEnv(home);
  const bridgeCapable = Object.entries(COMMAND_TABLE).filter(
    ([p, e]) =>
      p !== "" &&
      p !== "<agent>" &&
      ["owner-ensure", "owner-if-pod", "create", "one-shot"].includes(e.class),
  );
  assert.ok(bridgeCapable.length >= 15, "vacuous");
  for (const [p] of bridgeCapable) {
    // No operands: the placement step refuses before commander would ask for them.
    const r = run(p.split(" "), env);
    assert.equal(r.status, 2, `${p}: ${r.stderr}`);
    assert.match(
      r.stderr.split("\n")[0],
      /^acpx: REFUSED reason=pod_branch_unbuilt nothing_started=true protocol=1 branch=/u,
      p,
    );
  }
  const prompt = run(["claude", "fix", "it"], env);
  assert.equal(prompt.status, 2);
  assert.match(
    prompt.stderr,
    /branch=routed-ensure class=owner-ensure place=control path=<agent>/u,
  );
  assert.deepEqual(startedAnything(home), []);
});

test("CLI: an unclassified command refuses with exit 2 and the exact first line", () => {
  const r = run(["seats", "zzz-new-verb"], podEnv(podHome()));
  assert.equal(r.status, 2);
  assert.equal(r.stderr.split("\n")[0], "acpx: REFUSED reason=unclassified_command");
});

test("CLI: an incomplete identity → exit 2, the C7.2 line; `--version` and help still answer", () => {
  const home = podHome();
  const env = podEnv(home, { NV_POD_UID: undefined });
  for (const argv of [
    ["sessions", "new"],
    ["sessions", "list", "--local"],
    ["prompt", "hi"],
  ]) {
    const r = run(argv, env);
    assert.equal(r.status, 2, JSON.stringify(argv));
    assert.equal(r.stderr.split("\n")[0], "acpx: REFUSED reason=pod_identity_missing");
  }
  assert.equal(run(["--version"], env).status, 0);
  assert.equal(run(["sessions", "--help"], env).status, 0);
  assert.deepEqual(startedAnything(home), []);
});

test("CLI: a local-routed command runs as today in pod mode (the step lets it through)", () => {
  const r = run(["--format", "json", "sessions", "list", "--local"], podEnv(podHome()));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /REFUSED/u);
});

test("CLI: agent pod — a record command about an unresolvable session is passed through (refused until A3)", () => {
  const home = podHome({ podFile: agentPodName("rec-own") });
  const r = run(["sessions", "set-os", "rec-nobody", "default"], podEnv(home));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /branch=pass-through class=record place=other-pod/u);
});

const DETERMINISTIC: string[][] = [
  ["--format", "json", "sessions", "list", "--local"],
  ["prompt", "hi"],
  ["seats", "zzz-new-verb"],
  ["sessions", "new", "--help"],
];

test("pod mode OFF is byte-identical to today, whether or not NV_POD_* / the switch are set", () => {
  // A fresh home per run (the first run in a home rebuilds its index and says so), with the home's
  // path masked, so the comparison sees only what the environment changes.
  const today = (home: string) =>
    podEnv(home, {
      ACPX_OWNER_PLACEMENT: undefined,
      NV_POD_NAME: undefined,
      NV_POD_UID: undefined,
      NV_NODE_NAME: undefined,
      ACPX_POD_SA_DIR: undefined,
      [TEST_HOME_ENV]: undefined,
    });
  const variants: Array<(home: string) => NodeJS.ProcessEnv> = [
    // the identity set, the switch not (the rollout order: identity first, A-5)
    (home) => ({
      ...today(home),
      ...IDENTITY(),
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "child",
    }),
    // the switch and the identity set, NOT honoured: no seam → a temp home is not canonical
    (home) => podEnv(home, { [TEST_HOME_ENV]: undefined }),
    // the switch set on a workbench-role host, no seam
    (home) => podEnv(home, { [TEST_HOME_ENV]: undefined, NV_DEV_SERVER_ROLE: "workbench" }),
    // the seam set, the switch not
    (home) => podEnv(home, { ACPX_OWNER_PLACEMENT: undefined }),
  ];
  const masked = (argv: string[], envOf: (home: string) => NodeJS.ProcessEnv): Run => {
    const home = podHome();
    const r = run(argv, envOf(home));
    return {
      ...r,
      stdout: r.stdout.replaceAll(home, "<HOME>"),
      stderr: r.stderr.replaceAll(home, "<HOME>"),
    };
  };
  for (const argv of DETERMINISTIC) {
    const base = masked(argv, today);
    for (const envOf of variants) {
      assert.deepEqual(masked(argv, envOf), base, JSON.stringify(argv));
    }
  }
});

test("the seam does nothing outside node --test: no pod mode from a temp home", () => {
  const env = podEnv(podHome());
  delete env.NODE_TEST_CONTEXT;
  const r = run(["prompt", "hi"], env);
  assert.doesNotMatch(r.stderr, /pod_branch_unbuilt/u);
  assert.notEqual(r.status, 2);
});

test("the spawn tripwire: on the control pod in pod mode the adapter/owner spawn sites refuse", () => {
  const placement = fileURLToPath(new URL("../src/pod/placement.js", import.meta.url));
  const probe = (env: NodeJS.ProcessEnv) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(placement)}); try { m.assertBridgeMayStartHere("owner"); console.log("ALLOWED"); } catch (e) { console.log(e.stderrLine); }`,
      ],
      { env, encoding: "utf8" },
    ).stdout.trim();
  assert.equal(
    probe(podEnv(podHome())),
    "acpx: REFUSED reason=bridge_on_control_pod nothing_started=true protocol=1 what=owner",
  );
  assert.match(probe(podEnv(podHome(), { NV_POD_UID: undefined })), /bridge_on_control_pod/u);
  assert.equal(probe(podEnv(podHome({ podFile: agentPodName("r") }))), "ALLOWED", "agent pod");
  assert.equal(probe(podEnv(podHome(), { ACPX_OWNER_PLACEMENT: undefined })), "ALLOWED", "off");
});
