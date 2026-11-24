import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queueKeyForSession } from "../src/cli/queue/paths.js";
import { COMMAND_TABLE } from "../src/pod/command-classes.js";
import {
  decidePlacement,
  refusalFor,
  refusalJson,
  type PlacementDecision,
} from "../src/pod/placement-step.js";
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
import { runCli } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

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
    // A-26: an unseamed control-role host asks PID 1 for what the process lacks — these rows must
    // not read the box they run on, so PID 1 is a stand-in that carries nothing.
    pid1: () => undefined,
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

test("the predicate judges the state home acpx ACTUALLY uses — the realpath of its `.acpx` directory", () => {
  const seamHome = tmpDir();
  fs.mkdirSync(path.join(seamHome, ".acpx"));
  const seam = { ACPX_POD_TEST_HOME: seamHome };
  // `<ASH>/.acpx` is a symlink to the canonical `.acpx` (ASH itself is elsewhere) → ON.
  const ash = tmpDir();
  fs.symlinkSync(path.join(seamHome, ".acpx"), path.join(ash, ".acpx"));
  assert.equal(
    mode(podModeVerdict(facts({ homedir: "/x", env: { ...seam, ACPX_STATE_HOME: ash } }))),
    "pod",
  );
  // The same ASH whose `.acpx` is a plain directory → it is not the canonical one.
  const other = tmpDir();
  fs.mkdirSync(path.join(other, ".acpx"));
  assert.equal(
    mode(podModeVerdict(facts({ homedir: "/x", env: { ...seam, ACPX_STATE_HOME: other } }))),
    "refuse:test_seam_outside_sandbox",
  );
});

test("whitespace-only ACPX_STATE_HOME: the predicate does what acpx's resolver does (a relative path → not canonical)", async () => {
  const { acpxStateRoot, sessionBaseDir } =
    await import("../src/session/persistence/session-base-dir.js");
  // Agreement by construction: the session store's directory sits in the root the predicate judges.
  const saved = process.env.ACPX_STATE_HOME;
  try {
    for (const value of [" ", "", "/home/node", "/tmp/x"]) {
      process.env.ACPX_STATE_HOME = value;
      assert.equal(path.dirname(sessionBaseDir()), acpxStateRoot(), JSON.stringify(value));
    }
  } finally {
    if (saved === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = saved;
    }
  }
  assert.equal(
    acpxStateRoot({ ACPX_STATE_HOME: " " }, "/home/node"),
    path.join(" ", ".acpx"),
    "used as a path, not ignored",
  );
  assert.equal(
    mode(podModeVerdict(facts({ env: { ACPX_STATE_HOME: " " } }))),
    "off:non-canonical-state-home",
    "acpx would use `<cwd>/ /.acpx`, so pod mode is off — even though HOME is canonical",
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

/** `target`: what the own-session check answers (counted in `ownTargetCalls`). */
let ownTargetCalls = 0;
function decide(
  argv: string[],
  over: { verdict?: PodModeVerdict; pod?: string; target?: string | null } = {},
): PlacementDecision {
  return decidePlacement({
    argv,
    verdict: over.verdict ?? { mode: "pod" },
    podFile: over.pod ? { kind: "pod", name: over.pod } : { kind: "absent" },
    builtInAgents: ["claude", "codex", "pi"],
    ownTarget: () => {
      ownTargetCalls += 1;
      return over.target ?? null;
    },
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

test("agent pod: a target-dependent class decides by the own-session check, asked only then", () => {
  const pod = agentPodName("rec-own");
  ownTargetCalls = 0;
  assert.equal(
    summary(decide(["prompt", "--session-id", "x", "hi"], { pod })),
    "branch:message-route",
  );
  assert.equal(ownTargetCalls, 1);
  for (const argv of [
    ["sessions", "new"],
    ["exec", "hi"],
    ["seats", "zzz"],
    ["governor", "status"],
  ]) {
    decide(argv, { pod });
  }
  assert.equal(ownTargetCalls, 1, "F2: no target lookup where the route does not depend on it");
  decide(["prompt", "hi"], { target: "rec-own" });
  assert.equal(ownTargetCalls, 1, "F2: never on the control pod");
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
    // A-71: the lease census / removal dates leases by the CONTROL pod's start; in an agent pod it never runs.
    ["sessions", "unparsable-leases"],
    ["sessions", "unparsable-leases", "--apply"],
  ]) {
    const d = decide(argv, { pod });
    assert.equal(d.kind, "refuse-control-pod-only", JSON.stringify(argv));
    assert.equal(refusalFor(d)?.exitCode, 2);
    assert.equal(refusalFor(d)?.lines[0], "acpx: REFUSED reason=control_pod_only");
    assert.equal(decide(argv).kind, "local", `${JSON.stringify(argv)} on the control pod`);
  }
  // Ordinary `local` commands still run in an agent pod.
  assert.equal(decide(["seats", "help"], { pod }).kind, "local");
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
  for (const argv of [
    ["--version"],
    ["seats", "help"],
    ["governor", "status"],
    ["sessions", "new", "-h"],
  ]) {
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

/**
 * A3 built the `pass-through` and `message-route` branches: an agent pod's command now CALLS HOME.
 * These rows ask what the branch did, against lane X1's recorded atrium, with the call-home budget
 * compressed by its test-only seam (honoured only under NODE_TEST_CONTEXT, `pod-call-home.test.ts`).
 */
async function runCallingHome(
  argv: string[],
  home: string,
  script: Parameters<typeof startRecordedAtrium>[0] = {},
) {
  const atrium = await startRecordedAtrium(script);
  try {
    const result = await runCli(
      argv,
      podEnv(home, {
        ACPX_UI_INTERNAL_URL: atrium.url,
        ACPX_CALL_HOME_BUDGET_MS: "600",
        ACPX_CALL_HOME_RETRY_MS: "100",
        ACPX_CALL_HOME_ANSWER_TIMEOUT_MS: "600",
        ACPX_ROUTED_PROMPT_ANSWER_TIMEOUT_MS: "600",
      }),
    );
    return { result, requests: atrium.requests };
  } finally {
    await atrium.close();
  }
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
  // Class `create` is built (block A2, `record-only-create`): on the control pod it writes the record
  // only — asserted below as "nothing started, never the unbuilt-branch refusal"; the record-only
  // behaviour itself is held by `test/pod-create-plan.test.ts`.
  const bridgeCapable = Object.entries(COMMAND_TABLE).filter(
    ([p, e]) =>
      p !== "" && p !== "<agent>" && ["owner-ensure", "owner-if-pod", "one-shot"].includes(e.class),
  );
  assert.ok(bridgeCapable.length >= 11, "vacuous");
  const creates = Object.entries(COMMAND_TABLE).filter(([, e]) => e.class === "create");
  assert.ok(creates.length >= 4, "vacuous");
  // In a home of their own: a create WRITES a record (that is its job), so "started" there means a
  // queue lease — never one.
  const createHome = podHome();
  for (const [p] of creates) {
    const r = run(p.split(" "), podEnv(createHome));
    assert.doesNotMatch(r.stderr, /pod_branch_unbuilt/u, p);
  }
  assert.ok(!startedAnything(createHome).includes("queues"), "a create started no owner");
  for (const [p, entry] of bridgeCapable) {
    // No operands: the placement step refuses before commander would ask for them.
    const r = run(p.split(" "), env);
    const first = r.stderr.split("\n")[0];
    if (entry.class === "owner-ensure" || entry.class === "owner-if-pod") {
      // A6 builds these branches (routed-ensure / routed-if-pod): with no session named there is
      // nothing to route to, and the call is refused by name — still nothing started.
      assert.equal(r.status, 1, `${p}: ${r.stderr}`);
      assert.match(
        first,
        /^acpx: ROUTED outcome=not_run reason=target_unresolved call_id=\S+$/u,
        p,
      );
    } else {
      // A10 builds `utility-pod`: a one-shot on the control pod goes to the box's utility pod by one
      // routed call. This rig has no API server, so the pod cannot be looked up — refused by name
      // (`admission_busy`, exit 75), still nothing started and never the unbuilt-branch refusal.
      assert.equal(r.status, 75, `${p}: ${r.stderr}`);
      assert.match(first, /^acpx: REFUSED reason=admission_busy nothing_started=true /u, p);
    }
  }
  const prompt = run(["claude", "fix", "it"], env);
  assert.equal(prompt.status, 1);
  assert.match(
    prompt.stderr.split("\n")[0],
    /^acpx: ROUTED outcome=not_run reason=target_unresolved call_id=\S+$/u,
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

test("CLI: agent pod — a record command about an unresolvable session answers as the control pod does: exit 4 `Session not found` (K5; brick 75956474)", async () => {
  // The recorded atrium has no `resolveTargetAs` here, so it refuses `400 class-not-passable` +
  // `target-unresolved` exactly as the real one does for an id it cannot resolve (the old row scripted a world
  // the real atrium never produces, and so hid X1 TE round 2 P1: exit 2 and a policy-refusal sentence).
  const home = podHome({ podFile: agentPodName("rec-own") });
  // a real pod's home holds the box's store AND its index (the verdict child reads them; it may not create them)
  fs.mkdirSync(path.join(home, ".acpx", "sessions"), { recursive: true });
  run(["sessions", "reindex"], {
    PATH: process.env.PATH,
    HOME: home,
    ACPX_STATE_HOME: home,
    NODE_TEST_CONTEXT: "child",
  });
  const argv = ["sessions", "set-os", "rec-nobody", "default"];
  const { result, requests } = await runCallingHome(argv, home, {});
  // The control pod's answer, MEASURED: the same verb outside any pod, in a home whose index already exists.
  const controlHome = tmpDir();
  const controlEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: controlHome,
    ACPX_STATE_HOME: controlHome,
    NODE_TEST_CONTEXT: "child",
  };
  run(argv, controlEnv); // builds the index (and says so, once)
  const control = run(argv, controlEnv);
  assert.equal(control.status, 4, "the measure: the control pod says not-found, exit 4");
  assert.match(control.stderr, /^Session not found: rec-nobody\n/u);
  assert.equal(result.status, control.status, result.stderr);
  assert.equal(result.stderr, control.stderr);
  assert.equal(result.stdout, control.stdout);
  assert.doesNotMatch(result.stderr, /pass_through_refused/u);
  const calls = requests.filter((q) => q.route === "call");
  assert.equal(calls.length, 1, "it reached atrium once, and nothing ran in the pod");
  assert.deepEqual(calls[0]?.body?.argv, argv);
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

// ─── The tripwire AT EACH SITE (not only the predicate) ─────────────────────────────────────────

/** Run an ESM snippet in a child with `env`; it prints one line. */
function probeSite(code: string, env: NodeJS.ProcessEnv): string {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  }).stdout.trim();
}

test("tripwire site 1 — the adapter spawn: AcpClient.start() refuses on the control pod in pod mode, and nothing is spawned", () => {
  const client = fileURLToPath(new URL("../src/acp/client.js", import.meta.url));
  const dir = tmpDir();
  const marker = path.join(dir, "adapter-started");
  const adapter = path.join(dir, "adapter.mjs");
  // A stand-in adapter whose only act is to prove it was spawned.
  fs.writeFileSync(
    adapter,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "x");\n`,
  );
  const code = `
    const { AcpClient } = await import(${JSON.stringify(client)});
    const c = new AcpClient({ agentCommand: ${JSON.stringify(`${process.execPath} ${adapter}`)}, cwd: ${JSON.stringify(dir)}, permissionMode: "approve-all" });
    try { await c.start(); console.log("STARTED"); } catch (e) { console.log(e?.stderrLine ?? "OTHER " + String(e?.message).split("\\n")[0]); }
    finally { await c.close().catch(() => {}); }`;
  assert.equal(
    probeSite(code, podEnv(podHome())),
    "acpx: REFUSED reason=bridge_on_control_pod nothing_started=true protocol=1 what=adapter",
  );
  assert.equal(fs.existsSync(marker), false, "the adapter was spawned on the control pod");
  // Positive control: pod mode off, the same call DOES spawn the adapter — so the check above can fail.
  probeSite(code, podEnv(podHome(), { ACPX_OWNER_PLACEMENT: undefined }));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.equal(fs.existsSync(marker), true, "control: with pod mode off the adapter is spawned");
});

test("tripwire site 2 — the owner spawn: spawnQueueOwnerProcess refuses on the control pod in pod mode", () => {
  const owner = fileURLToPath(
    new URL("../src/cli/session/queue-owner-process.js", import.meta.url),
  );
  const code = `
    const { spawnQueueOwnerProcess } = await import(${JSON.stringify(owner)});
    try { spawnQueueOwnerProcess({ sessionId: "never-spawned" }); console.log("SPAWNED"); }
    catch (e) { console.log(e?.stderrLine ?? "OTHER " + String(e?.message).split("\\n")[0]); }`;
  assert.equal(
    probeSite(code, podEnv(podHome())),
    "acpx: REFUSED reason=bridge_on_control_pod nothing_started=true protocol=1 what=owner",
  );
  assert.equal(
    probeSite(code, podEnv(podHome(), { NV_POD_UID: undefined })),
    "acpx: REFUSED reason=bridge_on_control_pod nothing_started=true protocol=1 what=owner",
    "identity missing is fail-closed too",
  );
});

// ─── The A1 verification's findings (VERIFICATION.md at 045b3d71) ────────────────────────────────

/** A sandbox home with one open record in its store (written the way acpx's tests write records). */
async function homeWithRecord(recordId: string, acpId: string, podFile?: string): Promise<string> {
  const home = podHome(podFile === undefined ? {} : { podFile });
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: recordId,
      acpSessionId: acpId,
      agentCommand: "agent",
      cwd: home,
    }),
  );
  return home;
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        out.push(path.relative(dir, p));
      }
    }
  };
  walk(dir);
  return out.toSorted();
}

test("F1 CLI: `help` in a prompt, in ANOTHER agent pod, is routed (message-route) — no owner starts", async () => {
  const rec = "2c3a1f4e-0b5d-4c6e-9f70-81a2b3c4d5e6";
  const home = await homeWithRecord(
    rec,
    "5e4d3c2b-1a09-4887-a665-544332211000",
    "ag-0123456789abcdef01234567",
  );
  const before = tree(home);
  const { result: r, requests } = await runCallingHome(
    ["--approve-all", "claude", "--session-id", rec, "--no-wait", "help", "me"],
    home,
  );
  assert.equal(r.status, 0, r.stderr);
  // A3: the message-route branch posted it — `help me` is prompt TEXT, routed, never the help command.
  const sent = requests.filter((q) => q.route === "session_message");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.body?.text, "help me");
  assert.deepEqual(tree(home), before, "nothing written: no lease, no stream, no ledger, no index");
});

test("F1 CLI: `acpx help …` on the control pod is a prompt — refused at the step, before any write", () => {
  const home = podHome();
  // `help` words with NO session named: refused by name in A6's branch before any read or write.
  for (const argv of [
    ["help"],
    ["help", "sessions"],
    ["claude", "--session-id", "X", "help", "me"],
  ]) {
    const r = run(argv, podEnv(home));
    // A6 builds routed-ensure: a `help` prompt names no session, so it is refused by name there —
    // before any write, as before (it is a PROMPT, not help).
    assert.equal(r.status, 1, JSON.stringify(argv));
    assert.match(
      r.stderr.split("\n")[0],
      /^acpx: ROUTED outcome=not_run reason=target_unresolved call_id=\S+$/u,
      JSON.stringify(argv),
    );
  }
  // A6: the third form NAMES a session, so the control pod resolves it (its own session store, which
  // may rebuild its own index); the first two name none and write nothing. Run them in a fresh home.
  const fresh = podHome();
  for (const argv of [["help"], ["help", "sessions"]]) {
    run(argv, podEnv(fresh));
  }
  assert.deepEqual(
    tree(fresh),
    [],
    "no index, no ledger — a help prompt that names no session writes nothing",
  );
  // The form that NAMES a session resolves it on the control pod (its own store): at most its own
  // session index may appear — never a ledger, a lease, a queue or any started owner (TE L-1).
  const named = podHome();
  const third = run(["claude", "--session-id", "X", "help", "me"], podEnv(named));
  assert.equal(third.status, 1);
  assert.deepEqual(
    tree(named).filter((f) => f !== ".acpx/sessions/index.json"),
    [],
    "a help prompt naming a session writes at most the control pod's own index",
  );
  // And under pod_identity_missing a `help` prompt is NOT "diagnosable": it refuses.
  const r = run(["help", "me"], podEnv(podHome(), { NV_POD_UID: undefined }));
  assert.equal(r.status, 2);
  assert.equal(r.stderr.split("\n")[0], "acpx: REFUSED reason=pod_identity_missing");
});

test("F2 CLI: in an agent pod the REFUSED token is stderr line 1, and no index is written", async () => {
  // No index at all: today's resolver would rebuild it (and say so on stderr) — the step must not.
  const empty = podHome({ podFile: "ag-0123456789abcdef01234567" });
  fs.mkdirSync(path.join(empty, ".acpx", "sessions"), { recursive: true });
  // (A3: the placement decision still comes first and writes nothing — the command is passed through,
  // and with atrium away its refusal token is stderr line 1.)
  const { result: r1 } = await runCallingHome(["sessions", "set-os", "nobody", "default"], empty, {
    phases: [{ mode: "away" }],
  });
  assert.equal(r1.status, 75);
  assert.equal(
    r1.stderr.split("\n")[0].startsWith("acpx: REFUSED reason=atrium_away"),
    true,
    r1.stderr,
  );
  assert.equal(fs.existsSync(path.join(empty, ".acpx", "sessions", "index.json")), false);
  // A store with a record and an index: the bytes are untouched.
  const rec = "7d6c5b4a-3928-4170-8e6d-5c4b3a291807";
  const home = await homeWithRecord(
    rec,
    "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
    "ag-0123456789abcdef01234567",
  );
  const index = path.join(home, ".acpx", "sessions", "index.json");
  fs.writeFileSync(index, JSON.stringify({ schema: "x", entries: [], files: [] }));
  const bytes = fs.readFileSync(index, "utf8");
  const { result: r2 } = await runCallingHome(
    ["sessions", "set-metadata", "k", "v", "--session-id", rec],
    home,
    { phases: [{ mode: "away" }] },
  );
  assert.equal(
    r2.stderr.split("\n")[0].startsWith("acpx: REFUSED reason=atrium_away"),
    true,
    r2.stderr,
  );
  assert.equal(fs.readFileSync(index, "utf8"), bytes, "index.json untouched");
});

test("F2: the own-session check answers OWN only on exact evidence, read-only", async () => {
  const { ownTargetRecordId } = await import("../src/pod/own-target.js");
  const dir = tmpDir();
  const rec = "aaaaaaaa-1111-4222-8333-444444444444";
  const acp = "bbbbbbbb-5555-4666-8777-888888888888";
  const pod = agentPodName(rec);
  fs.writeFileSync(
    path.join(dir, "index.json"),
    JSON.stringify({
      entries: [
        { acpxRecordId: rec, acpSessionId: acp },
        {
          acpxRecordId: "cccccccc-0000-4000-8000-000000000a99",
          acpSessionId: "dddddddd-0000-4000-8000-000000000a99",
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "seats.json"),
    JSON.stringify({ "seat-1": { active_holder_id: rec } }),
  );
  const own = (target: Parameters<typeof ownTargetRecordId>[0]) =>
    ownTargetRecordId(target, pod, dir);
  assert.equal(own({ via: "flag", flag: "--session-id", value: rec }), rec, "record id");
  assert.equal(own({ via: "operand", value: rec }), rec, "operand");
  assert.equal(
    own({ via: "flag", flag: "--session-url", value: `https://a/?session=${rec}` }),
    rec,
  );
  assert.equal(own({ via: "flag", flag: "--seat", value: "seat-1" }), rec, "seat → active holder");
  assert.equal(own({ via: "flag", flag: "--session-url", value: "https://a/?seat=seat-1" }), rec);
  assert.equal(own({ via: "flag", flag: "--session-id", value: acp }), rec, "ACP id via the index");
  assert.equal(
    own({ via: "flag", flag: "--session-id", value: "444444444444" }),
    rec,
    "unique suffix",
  );
  // Negatives: another session, an ambiguous suffix, nothing, unreadable files.
  assert.equal(
    own({ via: "flag", flag: "--session-id", value: "cccccccc-0000-4000-8000-000000000a99" }),
    null,
  );
  assert.equal(own({ via: "flag", flag: "--session-id", value: "a99" }), null, "ambiguous suffix");
  assert.equal(ownTargetRecordId(undefined, pod, dir), null);
  assert.equal(
    ownTargetRecordId({ via: "flag", flag: "--seat", value: "seat-1" }, pod, tmpDir()),
    null,
  );
  assert.deepEqual(fs.readdirSync(dir).toSorted(), ["index.json", "seats.json"], "read-only");
});

test("F3 CLI: --format json carries the placement refusal in error.data (C7.2)", () => {
  const home = podHome();
  // `exec` is built since A10 (utility-pod); `sessions import` stands for no branch left unbuilt, so the
  // JSON carriage is held on a placement refusal that still exists: the unclassified command below, and
  // the routed-call refusal here (the same C7.2 wire format, the token line on both streams).
  const r = run(["--format", "json", "exec", "hi"], podEnv(home));
  assert.equal(r.status, 75);
  const out = JSON.parse(r.stdout.trim().split("\n")[0] ?? "{}") as {
    error: { data: Record<string, unknown> };
  };
  assert.equal(out.error.data.reason, "admission_busy");
  assert.equal(r.stderr.split("\n")[0]?.startsWith("acpx: REFUSED reason=admission_busy"), true);
  // Restored (A10 round 2, TE F-H): line 1 stays on stderr AND is `error.data.tokenLine`; nothing started.
  assert.equal(out.error.data.tokenLine, r.stderr.split("\n")[0], "line 1 stays on stderr too");
  assert.equal(out.error.data.nothingStarted, true);
  const u = run(["--format", "json", "seats", "zzz"], podEnv(home));
  const unclassified = JSON.parse(u.stdout) as {
    error: { data: { reason: string; tokenLine: string } };
  };
  assert.equal(unclassified.error.data.reason, "unclassified_command");
  assert.equal(unclassified.error.data.tokenLine, u.stderr.split("\n")[0]);
  const pod = podEnv(podHome({ podFile: "ag-0123456789abcdef01234567" }));
  const leaf = run(["governor", "status", "--format", "json"], pod);
  assert.equal(
    (JSON.parse(leaf.stdout) as { error: { data: { reason: string } } }).error.data.reason,
    "control_pod_only",
  );
  // --json-strict: JSON on stdout, nothing on stderr.
  const strict = run(["--format", "json", "--json-strict", "exec", "hi"], podEnv(home));
  assert.equal(strict.stderr, "");
  assert.equal(
    (
      JSON.parse(strict.stdout.trim().split("\n")[0] ?? "{}") as {
        error: { data: { reason: string } };
      }
    ).error.data.reason,
    "admission_busy",
  );
  // Text mode: nothing on stdout.
  assert.equal(run(["exec", "hi"], podEnv(home)).stdout, "");
});

test("F3 successor (A10 round 2, TE F-H): a placement-step branch refusal's JSON carries nothing_started and tokenLine == line 1 — the row `exec` held until its branch was built", () => {
  const d = decide(["exec", "hi"]);
  assert.equal(d.kind, "branch");
  const refusal = refusalFor(d);
  assert.ok(refusal);
  const json = JSON.parse(refusalJson(refusal)) as {
    error: { code: number; data: Record<string, unknown> };
  };
  assert.equal(json.error.code, -32602);
  assert.equal(json.error.data.reason, "pod_branch_unbuilt");
  assert.equal(json.error.data.branch, "utility-pod");
  assert.equal(json.error.data.nothing_started, true);
  assert.equal(json.error.data.tokenLine, refusal.lines[0], "line 1 is repeated in error.data");
});

test('F5: NODE_TEST_CONTEXT="" honours NEITHER seam (home and service account agree)', () => {
  const home = tmpDir();
  assert.equal(canonicalHome({ NODE_TEST_CONTEXT: "", [TEST_HOME_ENV]: home }), CANONICAL_HOME);
  const verdict = podModeVerdict(
    facts({
      controlRole: false,
      homedir: home,
      env: { NODE_TEST_CONTEXT: "", [TEST_HOME_ENV]: home },
    }),
  );
  assert.equal(mode(verdict), "off:not-control-role", "the home seam is off, as the SA seam is");
});

test("F6: a DANGLING `.acpx` symlink to the canonical `.acpx` is followed — judged canonical", () => {
  const seamHome = tmpDir(); // its `.acpx` does not exist yet
  const ash = tmpDir();
  fs.symlinkSync(path.join(seamHome, ".acpx"), path.join(ash, ".acpx"));
  assert.equal(
    mode(
      podModeVerdict(
        facts({ homedir: "/x", env: { ACPX_POD_TEST_HOME: seamHome, ACPX_STATE_HOME: ash } }),
      ),
    ),
    "pod",
  );
  const elsewhere = tmpDir();
  const ash2 = tmpDir();
  fs.symlinkSync(path.join(elsewhere, ".acpx"), path.join(ash2, ".acpx"));
  assert.equal(
    mode(
      podModeVerdict(
        facts({ homedir: "/x", env: { ACPX_POD_TEST_HOME: seamHome, ACPX_STATE_HOME: ash2 } }),
      ),
    ),
    "refuse:test_seam_outside_sandbox",
    "a dangling link elsewhere is still elsewhere",
  );
});

test("ruling Q: archive MAINTENANCE is control_pod_only in an agent pod; archiving named sessions is passed through", () => {
  const pod = agentPodName("rec-own");
  for (const argv of [
    ["sessions", "archive", "--apply"],
    ["sessions", "archive", "--compress", "--apply"],
    ["sessions", "archive", "--decompress", "--all", "--apply"],
    ["sessions", "archive", "--status"],
    ["sessions", "prune", "--older-than", "3"],
  ]) {
    assert.equal(summary(decide(argv, { pod })), "refuse-control-pod-only", JSON.stringify(argv));
    assert.equal(summary(decide(argv)), "local", `${JSON.stringify(argv)} on the control pod`);
  }
  assert.equal(
    summary(decide(["sessions", "archive", "--ids", "a", "b", "--apply"], { pod })),
    "branch:pass-through",
  );
  assert.equal(summary(decide(["sessions", "restore", "a"], { pod })), "branch:pass-through");
});
