import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { lockHostPlace, lockPodIdentity, podModeRequested } from "../src/pod/identity.js";
import { decidePlacement, refusalFor } from "../src/pod/placement-step.js";
import {
  CANONICAL_HOME,
  PID1_STAND_IN_ENV,
  agentPodName,
  effectiveEnv,
  podFactValue,
  placeOf,
  podModeVerdict,
  readAgentPodFile,
  readPodFileWithWitness,
  type HostFacts,
  type PodFacts,
  type PodModeVerdict,
} from "../src/pod/placement.js";
import { makeServiceAccountDir, makeTestHome, runInPod } from "./pod-kit/two-pods.js";

// A-26 (brick a25b06e8, built in A5's lane): the switch and the pod's identity are FACTS OF THE POD,
// not of the calling process. (a) On a control-role host that carries the place file, the place file
// stands for the switch. (b) What the process's own environment lacks of ACPX_OWNER_PLACEMENT,
// NV_POD_NAME, NV_POD_UID and NV_NODE_NAME is read from PID 1's environment — own value first, only
// the value `pod` is the switch. Under the honoured seam nothing real is read (a test gives PID 1 a
// stand-in). The six committed cases of CONTRACTS-r4 C1.1 A-26 are the rows headed "CASE n".

const CHILD = fileURLToPath(new URL("./fixtures/pod-lock-child.js", import.meta.url));

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acpx-a26-"));
}

const FULL_PID1: PodFacts = {
  ACPX_OWNER_PLACEMENT: "pod",
  NV_POD_NAME: "dev-server-abc",
  NV_POD_UID: "uid-pid1",
  NV_NODE_NAME: "node-pid1",
};

/** A sandboxed control-role host: the seam's home, a service-account directory with a namespace. */
function sandbox(placeFile: boolean) {
  const home = tmp();
  if (placeFile) {
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-0123456789abcdef01234567\n");
  }
  const sa = tmp();
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  const env = (own: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    NODE_TEST_CONTEXT: "child",
    ACPX_POD_TEST_HOME: home,
    ACPX_POD_SA_DIR: sa,
    ACPX_STATE_HOME: home, // `<home>/.acpx` IS the canonical state home under the seam
    ...own,
  });
  return { home, sa, env };
}

function hostFacts(
  env: NodeJS.ProcessEnv,
  pid1: PodFacts | undefined,
  reads: { count: number },
  over: Partial<HostFacts> = {},
): HostFacts {
  return {
    env,
    controlRole: true,
    homedir: CANONICAL_HOME,
    pid1: () => {
      reads.count += 1;
      return pid1;
    },
    ...over,
  };
}

const mode = (verdict: PodModeVerdict): string =>
  verdict.mode === "refuse" ? `refuse:${verdict.reason}` : verdict.mode;

test("CASE 1: a control-role host with the switch and the identity ONLY in PID 1's stand-in → pod mode", () => {
  const box = sandbox(false);
  const reads = { count: 0 };
  const verdict = podModeVerdict(hostFacts(box.env(), FULL_PID1, reads));
  assert.equal(mode(verdict), "pod");
  assert.equal(reads.count, 1);
  // …and the pod's identity is PID 1's, for the locks too
  const merged = effectiveEnv(hostFacts(box.env(), FULL_PID1, reads), false);
  assert.equal(merged.NV_POD_UID, "uid-pid1");
});

test("CASE 2: an agent pod (place file) with NO switch anywhere and a complete identity → pod mode", () => {
  const box = sandbox(true);
  const reads = { count: 0 };
  const own = { NV_POD_NAME: "n", NV_POD_UID: "u", NV_NODE_NAME: "k" };
  const verdict = podModeVerdict(hostFacts(box.env(own), { ...own }, reads));
  assert.equal(mode(verdict), "pod");
  assert.equal(
    reads.count,
    0,
    "the place file stands for the switch and the process has the identity: no PID 1 read",
  );
});

test("CASE 3: the same agent pod with ONE identity source missing everywhere → pod_identity_missing, never local mode", () => {
  const box = sandbox(true);
  for (const lacking of ["NV_POD_NAME", "NV_POD_UID", "NV_NODE_NAME"] as const) {
    const own: NodeJS.ProcessEnv = { NV_POD_NAME: "n", NV_POD_UID: "u", NV_NODE_NAME: "k" };
    delete own[lacking];
    const pid1: PodFacts = { ...own }; // PID 1 lacks it too
    const reads = { count: 0 };
    assert.equal(
      mode(podModeVerdict(hostFacts(box.env(own), pid1, reads))),
      "refuse:pod_identity_missing",
      lacking,
    );
  }
  // the service-account namespace is the fourth source: a file, so also "everywhere"
  const noNamespace = sandbox(true);
  fs.rmSync(path.join(noNamespace.sa, "namespace"));
  const own = { NV_POD_NAME: "n", NV_POD_UID: "u", NV_NODE_NAME: "k" };
  assert.equal(
    mode(podModeVerdict(hostFacts(noNamespace.env(own), own, { count: 0 }))),
    "refuse:pod_identity_missing",
  );
});

test("CASE 4: ACPX_OWNER_PLACEMENT=off (or anything but `pod`) in the process beside a PID 1 that says `pod` → pod mode: a process cannot opt out", () => {
  for (const claim of ["off", "0", "false", "", " ", "POD", "podx"]) {
    const box = sandbox(false);
    const verdict = podModeVerdict(
      hostFacts(box.env({ ACPX_OWNER_PLACEMENT: claim }), FULL_PID1, { count: 0 }),
    );
    assert.equal(mode(verdict), "pod", JSON.stringify(claim));
  }
  // the converse is a CLAIM, not a loss: the process may still set `pod` itself, as today
  const box = sandbox(false);
  const own = { ACPX_OWNER_PLACEMENT: "pod", NV_POD_NAME: "n", NV_POD_UID: "u", NV_NODE_NAME: "k" };
  assert.equal(mode(podModeVerdict(hostFacts(box.env(own), undefined, { count: 0 }))), "pod");
});

test("CASE 5: a control pod whose PID 1 has no switch → off, byte-identical to today; it costs exactly ONE PID 1 read", () => {
  const box = sandbox(false);
  const reads = { count: 0 };
  const verdict = podModeVerdict(hostFacts(box.env(), { NV_POD_NAME: "x" }, reads));
  assert.deepEqual(verdict, { mode: "off", why: "switch-unset" });
  assert.equal(reads.count, 1);
  assert.equal(podModeRequested(box.env()), false, "no lock refusal either");
  // PID 1 unreadable (another user): only the process's own environment, i.e. today's behaviour
  assert.deepEqual(podModeVerdict(hostFacts(box.env(), undefined, { count: 0 })), {
    mode: "off",
    why: "switch-unset",
  });
});

test("CASE 6: with the seam honoured the REAL PID 1 is never read — the stand-in, or nothing", () => {
  const box = sandbox(false);
  const real = fs.readFileSync;
  let realReads = 0;
  const spy = mock.method(fs, "readFileSync", ((
    target: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (target === "/proc/1/environ") {
      realReads += 1;
    }
    return (real as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync);
  try {
    // no injected PID 1 at all: the seam is honoured, so only the stand-in FILE can speak
    const standIn = path.join(tmp(), "pid1.environ");
    fs.writeFileSync(
      standIn,
      `${Object.entries(FULL_PID1)
        .map(([k, v]) => `${k}=${v}`)
        .join("\0")}\0PATH=/secret/path\0TOKEN=hunter2\0`,
    );
    const withFile = box.env({ [PID1_STAND_IN_ENV]: standIn });
    const live: HostFacts = { env: withFile, controlRole: true, homedir: CANONICAL_HOME };
    assert.equal(mode(podModeVerdict(live)), "pod", "the stand-in file is PID 1 under the seam");
    assert.equal(mode(podModeVerdict({ ...live, env: box.env() })), "off", "no stand-in: nothing");
    assert.equal(realReads, 0, "the real /proc/1/environ was never read under the seam");
    // the stand-in was filtered at read time: only the four names survive
    const merged = effectiveEnv(live, true);
    assert.equal(merged.TOKEN, undefined);
    assert.equal(merged.PATH, withFile.PATH);
    assert.equal(merged.NV_POD_UID, "uid-pid1");
  } finally {
    spy.mock.restore();
  }
});

test("NODE_TEST_CONTEXT ALONE is no seam (H1 class): the real PID 1 stays in force — one read, and nothing of the real pod is hidden", () => {
  const real = fs.readFileSync;
  let realReads = 0;
  const spy = mock.method(fs, "readFileSync", ((
    target: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (target === "/proc/1/environ") {
      realReads += 1;
    }
    return (real as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync);
  try {
    for (const leaked of ["child", " ", "0", "false"]) {
      realReads = 0;
      // controlRole true, NO ACPX_POD_TEST_HOME: a leaked context only
      const env = { NODE_TEST_CONTEXT: leaked };
      effectiveEnv({ env, controlRole: true, homedir: CANONICAL_HOME }, true);
      assert.ok(realReads <= 1, `${leaked}: at most one real read (memoised), got ${realReads}`);
    }
    // and the stand-in variable is dead without the seam
    const standIn = path.join(tmp(), "pid1.environ");
    fs.writeFileSync(
      standIn,
      "ACPX_OWNER_PLACEMENT=pod\0NV_POD_NAME=n\0NV_POD_UID=u\0NV_NODE_NAME=k\0",
    );
    const merged = effectiveEnv(
      {
        env: { NODE_TEST_CONTEXT: "child", [PID1_STAND_IN_ENV]: standIn },
        controlRole: true,
        homedir: CANONICAL_HOME,
      },
      true,
    );
    assert.notEqual(
      merged.NV_POD_UID,
      "u",
      "the stand-in is honoured only under the explicit seam",
    );
  } finally {
    spy.mock.restore();
  }
});

test("(a) a caller's OWN state home behaves as today (off, no refusal), even beside a PID 1 that says `pod` — and a NON-control-role host reads nothing at all", () => {
  const box = sandbox(true);
  const own = { NV_POD_NAME: "n", NV_POD_UID: "u", NV_NODE_NAME: "k" };
  // an ACPX_STATE_HOME outside the seam's home is refused under the seam (the seam leads only into it)…
  const outside = box.env({ ...own, ACPX_STATE_HOME: tmp() });
  assert.equal(
    mode(podModeVerdict(hostFacts(outside, undefined, { count: 0 }))),
    "refuse:test_seam_outside_sandbox",
  );
  // …and without a seam a non-canonical state home is today's behaviour
  const reads = { count: 0 };
  const rig = podModeVerdict({
    env: { NODE_TEST_CONTEXT: "child", ACPX_STATE_HOME: tmp(), ...own },
    controlRole: true,
    homedir: os.homedir(),
    pid1: () => {
      reads.count += 1;
      return FULL_PID1;
    },
  });
  // (unseamed there is no place file at the real path, so this host is the control pod: PID 1's switch
  // is honoured, and a state home of the caller's own is today's behaviour — `off`, never a refusal)
  assert.deepEqual(rig, { mode: "off", why: "non-canonical-state-home" });
  assert.equal(reads.count, 1);
  // a workbench / rig / suite (not control-role, no seam): off, and PID 1 is never asked
  const workbenchReads = { count: 0 };
  const workbench = podModeVerdict({
    env: { ACPX_OWNER_PLACEMENT: "off" },
    controlRole: false,
    homedir: os.homedir(),
    pid1: () => {
      workbenchReads.count += 1;
      return FULL_PID1;
    },
  });
  assert.deepEqual(workbench, { mode: "off", why: "switch-unset" });
  assert.equal(workbenchReads.count, 0);
});

test("the locks see the pod's facts too: a control-role host whose process lost NV_POD_* but whose PID 1 has them writes `pod` — consistent with pod mode", () => {
  const box = sandbox(false);
  const merged = effectiveEnv(hostFacts(box.env(), FULL_PID1, { count: 0 }), false);
  const identity = lockPodIdentityFrom(merged);
  assert.deepEqual(identity, {
    name: "dev-server-abc",
    uid: "uid-pid1",
    node: "node-pid1",
    namespace: "dev-devbox",
  });
  // positive control: without PID 1 the same process has no identity
  assert.equal(lockPodIdentityFrom(box.env()), undefined);
});

function lockPodIdentityFrom(env: NodeJS.ProcessEnv) {
  // `lockPodIdentity(env)` merges PID 1 itself; under the seam with no stand-in it adds nothing,
  // so `env` is the whole world — which is what these rows want.
  return lockPodIdentity(env);
}

// ---- the place file's content: SURROUNDING WHITESPACE is stripped (A-28; the ssh entry does the same) ----

const SESSION = "11111111-1111-4111-8111-111111111111";

function placeOfContent(content: string): { kind: string; own: string } {
  const file = path.join(tmp(), ".nv-agent");
  fs.writeFileSync(file, content);
  const read = readAgentPodFile(file);
  return { kind: read.kind, own: placeOf(read, SESSION) };
}

test("place file: `ag-<key>` (a downwardAPI mount writes no newline), with a newline, and with any surrounding whitespace all read as the session's own pod", () => {
  const name = agentPodName(SESSION);
  for (const content of [name, `${name}\n`, `${name}\n\n`, ` ${name}`, `\t${name} \r\n`]) {
    assert.deepEqual(
      placeOfContent(content),
      { kind: "pod", own: "own-pod" },
      JSON.stringify(content),
    );
  }
});

test("place file NEVER: whitespace INSIDE the name or another name matches nothing — it reads as another agent pod, never the own pod or the control pod", () => {
  const name = agentPodName(SESSION);
  for (const content of [`${name} x`, `x${name}`, `ag-${"0".repeat(24)}`, name.slice(0, -1)]) {
    const read = placeOfContent(content);
    assert.equal(read.kind, "pod", JSON.stringify(content));
    assert.equal(read.own, "other-pod", JSON.stringify(content));
  }
});

test("place file: an empty or whitespace-only file is an agent pod that is unreadable (the fail-safe side); a MISSING file is absent — no fallback", () => {
  for (const content of ["", "\n", "  \n\t "]) {
    assert.equal(placeOfContent(content).kind, "unreadable", JSON.stringify(content));
  }
  assert.deepEqual(readAgentPodFile(path.join(tmp(), "no-such-file")), { kind: "absent" });
});

// ---- A-28: the kernel hostname is a SECOND WITNESS for "this is an agent pod" ----

const NAME = agentPodName(SESSION);

/** A seam host whose hostname is `host`; the place file per `placeFile` (undefined ⇒ missing). */
function witnessHost(host: string, placeFile: string | undefined | { directory: true }) {
  const box = sandbox(false);
  const file = path.join(box.home, ".nv-agent");
  if (typeof placeFile === "object") {
    fs.mkdirSync(file); // unreadable: a directory where the file should be
  } else if (placeFile !== undefined) {
    fs.writeFileSync(file, placeFile);
  }
  return { box, hostname: () => host };
}

const argvNotLocal = ["sessions", "list"]; // any command that is not class `local`

function decisionFor(
  host: ReturnType<typeof witnessHost>,
  own: NodeJS.ProcessEnv,
  argv: readonly string[] = argvNotLocal,
) {
  const env = host.box.env(own);
  const reads = { count: 0 };
  const facts = hostFacts(env, undefined, reads, { hostname: host.hostname });
  const verdict = podModeVerdict(facts);
  const podFile = readPodFileWithWitness(env, host.hostname);
  return {
    verdict,
    podFile,
    decision: decidePlacement({ argv, verdict, podFile, builtInAgents: ["claude"] }),
  };
}

const IDENTITY_OWN = { NV_POD_NAME: "n", NV_POD_UID: "u", NV_NODE_NAME: "k" };

test("A-28 CASE 1: hostname `ag-…` and NO place file → pod_place_missing (exit 2), no local mode, nothing started", () => {
  for (const host of [`ag-${"a".repeat(24)}`, "ag-util-pool"]) {
    const { podFile, decision } = decisionFor(witnessHost(host, undefined), IDENTITY_OWN);
    assert.deepEqual(podFile, { kind: "place-missing" }, host);
    assert.equal(decision.kind, "refuse-pod-place", host);
    const refusal = refusalFor(decision);
    assert.equal(refusal?.exitCode, 2);
    assert.equal(refusal?.lines[0], "acpx: REFUSED reason=pod_place_missing");
  }
});

test("A-28 CASE 2: the same with an EMPTY (or unreadable) place file → pod_place_missing", () => {
  for (const content of ["", "\n", { directory: true }] as const) {
    const { podFile, decision } = decisionFor(witnessHost("ag-abc", content), IDENTITY_OWN);
    assert.deepEqual(podFile, { kind: "place-missing" }, JSON.stringify(content));
    assert.equal(decision.kind, "refuse-pod-place", JSON.stringify(content));
  }
});

test("A-28 CASE 3: hostname `ag-…` and a place file that NAMES the pod → as before (its own session's pod, by the key)", () => {
  const { podFile, verdict, decision } = decisionFor(
    witnessHost("ag-x", `${NAME}\n`),
    IDENTITY_OWN,
    ["status"],
  );
  assert.deepEqual(podFile, { kind: "pod", name: NAME });
  assert.equal(mode(verdict), "pod");
  assert.notEqual(decision.kind, "refuse-pod-place");
  // and a place file naming a pod beats ANY hostname, `ag-` or not
  assert.deepEqual(decisionFor(witnessHost("dev-server-abc", NAME), IDENTITY_OWN).podFile, {
    kind: "pod",
    name: NAME,
  });
});

test("A-28 CASE 4: ANOTHER hostname and no place file → the control pod, byte-identical to today (unswitched ⇒ off, switched ⇒ the control place)", () => {
  const unswitched = decisionFor(witnessHost("dev-server-bddbc4b49-wjpr6", undefined), {});
  assert.deepEqual(unswitched.podFile, { kind: "absent" });
  assert.deepEqual(unswitched.verdict, { mode: "off", why: "switch-unset" });
  assert.deepEqual(unswitched.decision, { kind: "off" });
  const switched = decisionFor(witnessHost("dev-server-bddbc4b49-wjpr6", undefined), {
    ...IDENTITY_OWN,
    ACPX_OWNER_PLACEMENT: "pod",
  });
  assert.deepEqual(switched.podFile, { kind: "absent" });
  assert.equal(placeOf(switched.podFile, undefined), "control");
});

test("A-28: a place file that EXISTS but is empty under a non-`ag-` hostname stays 'another agent pod' (A-25), not a refusal", () => {
  const { podFile, decision } = decisionFor(witnessHost("dev-server-abc", ""), IDENTITY_OWN);
  assert.deepEqual(podFile, { kind: "unreadable" });
  assert.notEqual(decision.kind, "refuse-pod-place");
  assert.equal(placeOf(podFile, SESSION), "other-pod");
});

test("A-28: `ag-…` under pod_place_missing still lets a class `local` command and a help request run, so an operator can diagnose", () => {
  const host = witnessHost("ag-abc", undefined);
  const local = decisionFor(host, IDENTITY_OWN, ["agent-folders"]);
  assert.equal(local.decision.kind, "local");
  const help = decisionFor(host, IDENTITY_OWN, ["sessions", "list", "--help"]);
  assert.equal(help.decision.kind, "local");
});

test("A-28 CASE 5: a rig's own state home, hostname `ag-…`, no place file, no identity → the lock writer refuses pod_identity_missing (any state home)", async () => {
  const dir = tmp();
  const record = path.join(dir, "state", "rec.json");
  fs.mkdirSync(path.dirname(record), { recursive: true });
  const run = await runInPod(undefined, CHILD, ["record-acquire", record], {
    saDir: makeServiceAccountDir(dir),
    testHome: makeTestHome(dir, "control"), // no place file: the file witness says control …
    hostname: "ag-0123456789abcdef01234567", // … the hostname witness says agent pod
    stateHome: path.join(dir, "state"), // a rig's own state home, not the canonical one
    timeoutMs: 20_000,
  });
  assert.equal(JSON.parse(run.stdout).code, "pod_identity_missing", run.stdout + run.stderr);
  assert.deepEqual(fs.readdirSync(path.dirname(record)), [], "nothing was written");
  // positive control: the same host with an ordinary hostname writes today's body
  const control = await runInPod(undefined, CHILD, ["record-acquire", record], {
    saDir: makeServiceAccountDir(dir),
    testHome: makeTestHome(dir, "control"),
    hostname: "dev-server-bddbc4b49-wjpr6",
    stateHome: path.join(dir, "state"),
    timeoutMs: 20_000,
  });
  assert.deepEqual(JSON.parse(control.stdout), { acquired: true }, control.stdout + control.stderr);
});

test("A-28 CASE 6: with the seam honoured the REAL hostname is not read; NODE_TEST_CONTEXT alone leaves it in force", () => {
  const real = os.hostname;
  let reads = 0;
  const spy = mock.method(os, "hostname", () => {
    reads += 1;
    return real.call(os);
  });
  try {
    const box = sandbox(false);
    // seam honoured, no stand-in: nothing is read, and the answer is the control pod's
    assert.deepEqual(readPodFileWithWitness(box.env()), { kind: "absent" });
    assert.equal(reads, 0, "the real hostname was never read under the seam");
    // the stand-in variable speaks under the seam …
    assert.deepEqual(readPodFileWithWitness(box.env({ ACPX_POD_TEST_HOSTNAME: "ag-x" })), {
      kind: "place-missing",
    });
    assert.equal(reads, 0);
    // … and is dead without it: a leaked context alone reads the REAL hostname
    readPodFileWithWitness({ NODE_TEST_CONTEXT: "child", ACPX_POD_TEST_HOSTNAME: "ag-x" });
    assert.equal(reads, 1, "no seam: the real hostname is read, the stand-in ignored");
  } finally {
    spy.mock.restore();
  }
});

test("A-28: the lock writer's place takes the same two witnesses for ANY state home", () => {
  const withHost = (host: string, placeFile?: string) => {
    const h = witnessHost(host, placeFile);
    return lockHostPlace(h.box.env({ ACPX_POD_TEST_HOSTNAME: host }));
  };
  assert.equal(withHost("ag-x"), "agent-pod", "hostname witness alone");
  assert.equal(withHost("dev-server-abc", NAME), "agent-pod", "file witness alone");
  assert.equal(withHost("dev-server-abc"), "control", "neither");
});

// ---- the two extra facts: NV_AGENT_PLACEMENT and NV_RUNTIME_RELEASES (program HoD §11 #2) ----

const RELEASES = '{"acpx":"rel-from-pid1","claude-agent-acp":"rel-2"}';

test("extra facts: the process's OWN value wins over PID 1's", () => {
  const box = sandbox(false);
  const reads = { count: 0 };
  const facts = hostFacts(
    box.env({ NV_AGENT_PLACEMENT: "home", NV_RUNTIME_RELEASES: '{"acpx":"own"}' }),
    { NV_AGENT_PLACEMENT: "pool", NV_RUNTIME_RELEASES: RELEASES },
    reads,
  );
  assert.equal(podFactValue("NV_AGENT_PLACEMENT", facts), "home");
  assert.equal(podFactValue("NV_RUNTIME_RELEASES", facts), '{"acpx":"own"}');
  assert.equal(reads.count, 0, "an own value costs no PID 1 read");
});

test("extra facts: missing or EMPTY in the process → PID 1's; missing in both → undefined", () => {
  const box = sandbox(false);
  const pid1 = { NV_AGENT_PLACEMENT: "pool", NV_RUNTIME_RELEASES: RELEASES };
  for (const own of [{}, { NV_AGENT_PLACEMENT: "", NV_RUNTIME_RELEASES: "  " }]) {
    const facts = hostFacts(box.env(own), pid1, { count: 0 });
    assert.equal(podFactValue("NV_AGENT_PLACEMENT", facts), "pool", JSON.stringify(own));
    assert.equal(podFactValue("NV_RUNTIME_RELEASES", facts), RELEASES, JSON.stringify(own));
  }
  assert.equal(
    podFactValue("NV_AGENT_PLACEMENT", hostFacts(box.env(), {}, { count: 0 })),
    undefined,
  );
  assert.equal(
    podFactValue("NV_AGENT_PLACEMENT", hostFacts(box.env(), undefined, { count: 0 })),
    undefined,
  );
});

test("extra facts NEVER: a workbench / rig / suite (not control-role, no seam) has only its own value — PID 1 is never asked", () => {
  const reads = { count: 0 };
  const facts: HostFacts = {
    env: {},
    controlRole: false,
    homedir: os.homedir(),
    pid1: () => {
      reads.count += 1;
      return { NV_AGENT_PLACEMENT: "pool" };
    },
  };
  assert.equal(podFactValue("NV_AGENT_PLACEMENT", facts), undefined);
  assert.equal(reads.count, 0);
  assert.equal(
    podFactValue("NV_AGENT_PLACEMENT", { ...facts, env: { NV_AGENT_PLACEMENT: "home" } }),
    "home",
  );
});

test("extra facts under the honoured seam: the stand-in file speaks, the REAL PID 1 is never read, and only the named variables survive the read", () => {
  const box = sandbox(false);
  const real = fs.readFileSync;
  let realReads = 0;
  const spy = mock.method(fs, "readFileSync", ((
    target: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (target === "/proc/1/environ") {
      realReads += 1;
    }
    return (real as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync);
  try {
    const standIn = path.join(tmp(), "pid1.environ");
    fs.writeFileSync(
      standIn,
      `NV_AGENT_PLACEMENT=home\0NV_RUNTIME_RELEASES=${RELEASES}\0SECRET=hunter2\0`,
    );
    const live = (extra: NodeJS.ProcessEnv): HostFacts => ({
      env: box.env(extra),
      controlRole: true,
      homedir: CANONICAL_HOME,
    });
    const withFile = { [PID1_STAND_IN_ENV]: standIn };
    assert.equal(podFactValue("NV_AGENT_PLACEMENT", live(withFile)), "home");
    assert.equal(
      podFactValue("NV_RUNTIME_RELEASES", live(withFile)),
      RELEASES,
      "a value containing `=` and `:` survives",
    );
    assert.equal(podFactValue("NV_AGENT_PLACEMENT", live({})), undefined, "no stand-in: nothing");
    assert.equal(realReads, 0, "the real /proc/1/environ was never read under the seam");
    // without the seam a leaked NODE_TEST_CONTEXT leaves the stand-in dead and the real PID 1 in force
    realReads = 0;
    podFactValue("NV_AGENT_PLACEMENT", {
      env: { NODE_TEST_CONTEXT: "child", ...withFile },
      controlRole: true,
      homedir: CANONICAL_HOME,
    });
    assert.ok(
      realReads <= 1,
      "no seam: the real PID 1 (memoised) is the source, the stand-in is ignored",
    );
    assert.notEqual(
      podFactValue("NV_AGENT_PLACEMENT", {
        env: { NODE_TEST_CONTEXT: "child", ...withFile },
        controlRole: true,
        homedir: CANONICAL_HOME,
      }),
      "home",
      "the stand-in's value is not returned without the seam",
    );
  } finally {
    spy.mock.restore();
  }
});
