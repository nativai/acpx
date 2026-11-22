import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { lockPodIdentity, podModeRequested } from "../src/pod/identity.js";
import {
  CANONICAL_HOME,
  PID1_STAND_IN_ENV,
  effectiveEnv,
  podModeVerdict,
  type HostFacts,
  type PodFacts,
  type PodModeVerdict,
} from "../src/pod/placement.js";

// A-26 (brick a25b06e8, built in A5's lane): the switch and the pod's identity are FACTS OF THE POD,
// not of the calling process. (a) On a control-role host that carries the place file, the place file
// stands for the switch. (b) What the process's own environment lacks of ACPX_OWNER_PLACEMENT,
// NV_POD_NAME, NV_POD_UID and NV_NODE_NAME is read from PID 1's environment — own value first, only
// the value `pod` is the switch. Under the honoured seam nothing real is read (a test gives PID 1 a
// stand-in). The six committed cases of CONTRACTS-r4 C1.1 A-26 are the rows headed "CASE n".

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
