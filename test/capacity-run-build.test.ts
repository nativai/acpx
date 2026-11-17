import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capacityRefusal } from "../src/capacity/admission.js";
import { buildRemainderBytes, buildTest } from "../src/capacity/build.js";
import { BUILD_CONSTANTS, MIB } from "../src/capacity/constants.js";
import {
  containerInstance,
  liveEntries,
  newBuildEntry,
  type PendingEntry,
} from "../src/capacity/ledger.js";
import { type PendingReservation, partitionPending } from "../src/capacity/pending.js";
import { readCapacity } from "../src/capacity/reading.js";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";

// brick e99e1ef6 — `acpx capacity run-build` (CONCEPTION 25479d40 v1.1 §3.2, §3.3, §5.1, §5.2; AC-7
// and §9's committed negatives for B). Every memory source is a FIXTURE tree (podinfo, cgroup,
// /proc), so no row depends on the pod the suite runs on; the ledger lives in each box's own
// ACPX_ADMISSION_DIR. The build children are REAL processes (they must be signalled and observed).

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const GiB = 1024 * MIB;

type BoxOptions = {
  readonly requestMib: number;
  readonly limitMib: number;
  /** `limit` ⇒ the box borrows above its request (B = L > R): the node term applies. */
  readonly basis?: "limit";
  /** C = anon + kernel. */
  readonly committedMib: number;
  readonly memAvailableMib?: number;
};

type Box = { readonly root: string; readonly env: NodeJS.ProcessEnv; readonly child: string };

const CHILD_SOURCE = `import fs from "node:fs";
import { spawn } from "node:child_process";
const [marker, holdMs, rc, grand] = process.argv.slice(2);
const facts = { pid: process.pid, admitted: process.env.ACPX_BUILD_ADMITTED ?? null };
if (grand === "grand") {
  const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  facts.grandPid = g.pid;
}
fs.writeFileSync(marker, JSON.stringify(facts));
setTimeout(() => process.exit(Number(rc)), Number(holdMs));
`;

function makeBox(o: BoxOptions): Box {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-run-build-"));
  const podinfo = path.join(root, "podinfo");
  const cgroup = path.join(root, "cgroup");
  const proc = path.join(root, "proc");
  for (const dir of [
    podinfo,
    cgroup,
    path.join(proc, "4242"),
    path.join(root, ".acpx", "queues"),
    path.join(root, ".acpx", "sessions"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(podinfo, "memory_request"), String(o.requestMib * MIB));
  fs.writeFileSync(path.join(podinfo, "memory_limit"), String(o.limitMib * MIB));
  fs.writeFileSync(
    path.join(podinfo, "annotations"),
    o.basis ? `nativai.de/agent-capacity-basis="${o.basis}"\n` : "",
  );
  fs.writeFileSync(path.join(cgroup, "memory.stat"), `anon ${o.committedMib * MIB}\nkernel 0\n`);
  fs.writeFileSync(path.join(cgroup, "memory.max"), String(o.limitMib * MIB));
  fs.writeFileSync(path.join(cgroup, "memory.current"), String(o.committedMib * MIB));
  fs.writeFileSync(
    path.join(cgroup, "memory.pressure"),
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
  );
  fs.writeFileSync(
    path.join(proc, "meminfo"),
    `MemTotal: 16000000 kB\nMemAvailable: ${(o.memAvailableMib ?? 9000) * 1024} kB\n`,
  );
  fs.writeFileSync(path.join(proc, "loadavg"), "1.00 1.00 1.00 2/300 12345\n");
  // The reading process (/proc/self): 50 MiB, outside every owner tree.
  fs.writeFileSync(
    path.join(proc, "4242", "stat"),
    "4242 (node) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 9000 1000 200 18446744073709551615\n",
  );
  fs.writeFileSync(
    path.join(proc, "4242", "status"),
    "Name:\tnode\nPid:\t4242\nPPid:\t1\nRssAnon:\t51200 kB\nVmPTE:\t0 kB\n",
  );
  fs.symlinkSync("4242", path.join(proc, "self"));
  const child = path.join(root, "child.mjs");
  fs.writeFileSync(child, CHILD_SOURCE);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    ACPX_STATE_HOME: root,
    ACPX_ADMISSION_DIR: path.join(root, "admission"),
    ACPX_CAPACITY_PODINFO_DIR: podinfo,
    ACPX_CAPACITY_CGROUP_ROOT: cgroup,
    ACPX_CAPACITY_PROC_ROOT: proc,
    ACPX_RUN_BUILD_TICK_MS: "100",
  };
  for (const key of [
    "ACPX_SESSION_URL",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_NAME",
    "ACPX_SESSION_RECORD_ID",
    "ACPX_ADMISSION_CLASS",
    "ACPX_BUILD_ADMITTED",
  ]) {
    delete env[key];
  }
  return { root, env, child };
}

const sourcesOf = (box: Box) => ({
  podinfoDir: path.join(box.root, "podinfo"),
  cgroupRoot: path.join(box.root, "cgroup"),
  procRoot: path.join(box.root, "proc"),
  queueDir: path.join(box.root, ".acpx", "queues"),
  sessionsDir: path.join(box.root, ".acpx", "sessions"),
});

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/**
 * `done` waits for the stdio pipes to CLOSE — which the build child, holding the inherited pipes,
 * delays past run-build's own death; `exited` is run-build's own exit.
 */
function startCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): { proc: ChildProcess; done: Promise<Run>; exited: Promise<void> } {
  const proc = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: "pipe" });
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const done = new Promise<Run>((resolve) => {
    const timer = setTimeout(() => proc.kill("SIGKILL"), 90_000);
    let stdout = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    proc.stdin?.end();
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { proc, done, exited };
}

const runCli = (args: string[], env: NodeJS.ProcessEnv): Promise<Run> => startCli(args, env).done;

/** `run-build` around the fixture child: it writes `marker`, holds `holdMs`, exits `rc`. */
function runBuildArgs(
  box: Box,
  marker: string,
  opts: { wait?: number; holdMs?: number; rc?: number; grand?: boolean } = {},
) {
  return [
    "capacity",
    "run-build",
    "--bytes",
    "1000",
    "--wait",
    String(opts.wait ?? 0),
    "--",
    process.execPath,
    box.child,
    marker,
    String(opts.holdMs ?? 0),
    String(opts.rc ?? 0),
    opts.grand ? "grand" : "-",
  ];
}

function ledger(box: Box): PendingEntry[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(box.root, "admission", "pending.json"), "utf8"),
    ) as {
      entries: PendingEntry[];
    };
    return raw.entries;
  } catch {
    return [];
  }
}

const buildEntries = (box: Box) => ledger(box).filter((entry) => entry.kind === "build");

function decisionLog(box: Box): Array<Record<string, unknown>> {
  const dir = path.join(box.root, "admission", "log");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function until<T>(what: string, probe: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers kill(0); its parent (pid 1) reaps it.
  try {
    return !/\) Z /u.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

type CapacityJson = {
  features: string[];
  pendingBytes: number;
  owners: { starting: number };
  build: {
    fits: boolean;
    holder: null | { key: string; phase: string; buildPid: number | null };
  };
};

async function capacityJson(
  box: Box,
  extra: string[] = [],
): Promise<{ run: Run; json: CapacityJson }> {
  const run = await runCli(["--format", "json", "capacity", ...extra], box.env);
  return { run, json: JSON.parse(run.stdout) as CapacityJson };
}

const readMarker = (marker: string) =>
  JSON.parse(fs.readFileSync(marker, "utf8")) as {
    pid: number;
    admitted: string | null;
    grandPid?: number;
  };

const TOKEN =
  /^acpx: REFUSED reason=no_room_for_build nothing_started=true protocol=1 box=\S+ need_mib=1000 room_mib=\d+ waited_s=\d+ live=0\b/mu;

// B = L = 4096, not borrowing: M 512, G 256, M_oom 512 ⇒ room = 3328 − K; K = max(512, C) here.
const FITS: BoxOptions = { requestMib: 4096, limitMib: 4096, committedMib: 1000 };
// room 828 < 1000: the build waits. Without the build one agent slot is free (G1: 4096−962−2500).
const WAITS: BoxOptions = { requestMib: 4096, limitMib: 4096, committedMib: 2500 };

// ---------------------------------------------------------------------------------------------
// The arithmetic (pure)
// ---------------------------------------------------------------------------------------------

const reservation = (over: Partial<PendingReservation> & { key: string }): PendingReservation => ({
  bytes: 1000,
  admitterAlive: false,
  bound: false,
  spent: false,
  ...over,
});

const build = (over: Partial<NonNullable<PendingReservation["build"]>> = {}) => ({
  phase: "building" as const,
  since: "2026-11-17T19:42:00.000Z",
  admitterPid: 1,
  buildPid: 2,
  buildAlive: false,
  ...over,
});

test("partitionPending build: kept while the admitter OR the build child lives; in P, never in starting", () => {
  const result = partitionPending(
    [
      // run-build SIGKILLed, its build still running ⇒ KEPT (review R3)
      reservation({ key: "build:a", build: build({ buildAlive: true, chargedBytes: 700 }) }),
      // run-build alive, waiting ⇒ kept at its full bytes
      reservation({ key: "build:b", admitterAlive: true, build: build({ phase: "waiting" }) }),
      // both gone ⇒ dropped
      reservation({ key: "build:c", build: build() }),
      // an ordinary unbound create, admitter alive ⇒ starting
      reservation({ key: "adm-1", bytes: 450, admitterAlive: true }),
    ],
    new Set(),
  );
  assert.deepEqual([...result.keptKeys].toSorted(), ["adm-1", "build:a", "build:b"]);
  assert.equal(result.buildBytes, 1700);
  assert.equal(result.pendingBytes, 2150);
  assert.equal(result.starting, 1, "a build is never counted in owners.starting (R12)");
  assert.deepEqual(result.builds.map((b) => b.key).toSorted(), ["build:a", "build:b"]);
});

test("NEGATIVE partitionPending build: an entry whose build child is dead and admitter gone is dropped even unexpired", () => {
  const result = partitionPending(
    [reservation({ key: "build:x", build: build({ buildAlive: false }) })],
    new Set(),
  );
  assert.equal(result.keptKeys.size, 0);
  assert.equal(result.pendingBytes, 0);
});

test("buildRemainderBytes: the LARGER of bytes − tree and bytes − (C_now − C_start), clamped to [0, bytes]", () => {
  // A forked tree over-reads (npm ci: 632 tree vs 447 rise): the rise remainder wins.
  assert.equal(
    buildRemainderBytes({
      bytes: 1920,
      treeBytes: 632,
      committedNowBytes: 5447,
      committedAtStartBytes: 5000,
    }),
    1920 - 447,
  );
  // Other sessions grew too (rise 900 > tree 400): the tree remainder wins.
  assert.equal(
    buildRemainderBytes({
      bytes: 1920,
      treeBytes: 400,
      committedNowBytes: 5900,
      committedAtStartBytes: 5000,
    }),
    1520,
  );
  // C fell since the start (sessions idled out): never more than the reservation itself.
  assert.equal(
    buildRemainderBytes({
      bytes: 1920,
      treeBytes: 0,
      committedNowBytes: 4000,
      committedAtStartBytes: 5000,
    }),
    1920,
  );
  // The build outgrew its estimate: nothing left to reserve, never negative.
  assert.equal(
    buildRemainderBytes({
      bytes: 1920,
      treeBytes: 2500,
      committedNowBytes: 7600,
      committedAtStartBytes: 5000,
    }),
    0,
  );
  // No cgroup reading: the tree alone.
  assert.equal(
    buildRemainderBytes({
      bytes: 1920,
      treeBytes: 500,
      committedNowBytes: undefined,
      committedAtStartBytes: 5000,
    }),
    1420,
  );
});

const measured = (
  over: Partial<NonNullable<Parameters<typeof buildTest>[0]["measured"]>> = {},
) => ({
  limitBytes: 4500 * MIB,
  committedBytes: 2585 * MIB,
  marginBytes: 512 * MIB,
  oomMarginBytes: 512 * MIB,
  chargedBytes: 2684 * MIB,
  buildBytes: 0,
  borrowing: false,
  nodeAvailableBytes: 9000 * MIB,
  nodeFloorBytes: 3072 * MIB,
  ...over,
});

test("buildTest: labidio at 18:36Z (§3.5) — line 1,812 MiB, K 2,684 ⇒ waits for ~870 MiB", () => {
  const figure = buildTest({
    needBytes: 1920 * MIB,
    configured: true,
    holder: null,
    measured: measured(),
  });
  assert.equal(figure.growthBytes, 256 * MIB);
  assert.equal(figure.roomBytes, (4500 - 512 - 256 - 2684) * MIB);
  assert.equal(figure.nodeRoomBytes, null, "not borrowing ⇒ no node term");
  assert.equal(figure.fits, false);
  assert.match(figure.reason, /^waits — room 1\.02 GiB, needs 1\.88 GiB/u);
  // Its own entry is not counted against it: K' = K − the build's share of P.
  const own = buildTest({
    needBytes: 1920 * MIB,
    configured: true,
    holder: null,
    measured: measured({ chargedBytes: (1700 + 1920) * MIB, buildBytes: 1920 * MIB }),
  });
  assert.equal(own.fits, true, `K' = 1700 fits under the 1,812 line: ${own.reason}`);
});

test("NEGATIVE buildTest: on a borrowing box the node term binds even when the box term holds (R7)", () => {
  // konsiq at 18:36Z: K 863 fits the box, node MemAvailable 4,362 < 5,299 needed.
  const konsiq = measured({
    limitBytes: 6144 * MIB,
    committedBytes: 863 * MIB,
    chargedBytes: 863 * MIB,
    marginBytes: 614 * MIB,
    borrowing: true,
    nodeAvailableBytes: 4362 * MIB,
  });
  const figure = buildTest({
    needBytes: 1920 * MIB,
    configured: true,
    holder: null,
    measured: konsiq,
  });
  assert.ok((figure.roomBytes ?? 0) >= 1920 * MIB, "the box term alone would admit it");
  assert.ok((figure.nodeRoomBytes ?? Infinity) < 1920 * MIB);
  assert.equal(figure.fits, false);
  assert.match(figure.reason, /node room/u);
  const roomy = buildTest({
    needBytes: 1920 * MIB,
    configured: true,
    holder: null,
    measured: { ...konsiq, nodeAvailableBytes: 5400 * MIB },
  });
  assert.equal(roomy.fits, true, "control: the same box with 5.3 GiB node memory fits");
});

test("buildTest: an unconfigured or unmeasured box never holds a build (fail open)", () => {
  assert.equal(buildTest({ needBytes: GiB, configured: false, holder: null }).fits, true);
  assert.equal(buildTest({ needBytes: GiB, configured: true, holder: null }).fits, true);
});

test("liveEntries build: past expiresAt an entry survives while its build child is PROVABLY that process; a dead one is dropped", async () => {
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  try {
    await until("sleeper identity", () => readProcessBirthIdentity(sleeper.pid ?? 0));
    const identity = readProcessBirthIdentity(sleeper.pid ?? 0);
    const expired = new Date(Date.now() - 60_000).toISOString();
    const base = newBuildEntry({
      key: "build:x",
      bytes: 1000,
      now: new Date(Date.now() - 700_000),
    });
    const foreignAdmitter = { admitterPid: 999_999_999, admitterIdentity: undefined };
    const running: PendingEntry = {
      ...base,
      ...foreignAdmitter,
      expiresAt: expired,
      phase: "building",
      buildPid: sleeper.pid,
      ...(identity ? { buildIdentity: serializeProcessBirthIdentity(identity) } : {}),
    };
    const dead: PendingEntry = { ...running, key: "build:dead", buildPid: 999_999_998 };
    const create: PendingEntry = { ...running, key: "adm-x", kind: "create" };
    const kept = liveEntries([running, dead, create], Date.now()).map((e) => e.key);
    assert.deepEqual(kept, ["build:x"]);
    assert.equal(running.instance, containerInstance());
  } finally {
    sleeper.kill("SIGKILL");
  }
});

test("no_capacity refusal while a build holds the reservation names it (§5.2)", () => {
  const box = makeBox(WAITS);
  const snapshot = readCapacity({
    agent: "claude",
    sources: sourcesOf(box),
    pending: [
      reservation({
        key: "build:held",
        admitterAlive: true,
        build: build({ since: "2026-11-17T19:42:00.000Z", buildPid: undefined, phase: "building" }),
      }),
    ],
  });
  assert.equal(snapshot.build.holder?.key, "build:held");
  const text = capacityRefusal("no_capacity", snapshot).message;
  assert.match(text, /A release build is running on this box \(since 19:42Z\)/u);
  assert.equal(snapshot.owners.starting, 0);
  const plain = readCapacity({ agent: "claude", sources: sourcesOf(box) });
  assert.doesNotMatch(capacityRefusal("no_capacity", plain).message, /release build/u);
});

// ---------------------------------------------------------------------------------------------
// The verb (real child processes)
// ---------------------------------------------------------------------------------------------

test("run-build: room ⇒ the child runs with ACPX_BUILD_ADMITTED, run-build exits with ITS code, the entry is gone after", async () => {
  const box = makeBox(FITS);
  const marker = path.join(box.root, "ran.json");
  const run = await runCli(runBuildArgs(box, marker, { rc: 7 }), box.env);
  assert.equal(run.code, 7, run.stderr);
  const facts = readMarker(marker);
  assert.match(facts.admitted ?? "", /^build:[0-9a-f-]{36}$/u);
  assert.deepEqual(buildEntries(box), []);
  const lines = decisionLog(box).filter((l) => l.kind === "build");
  assert.deepEqual(
    lines.map((l) => l.decision),
    ["started", "done"],
  );
  assert.equal(lines[0].class, "maintenance");
  assert.equal(lines[1].exitCode, 7);
  assert.ok(
    "committedAtPeak" in lines[1] && "peakRise" in lines[1],
    "the calibration fields (§3.3)",
  );
});

test("NEGATIVE run-build: a build test that fails NEVER runs the child — exit 75, no_room_for_build, ledger clean", async () => {
  const box = makeBox(WAITS);
  const marker = path.join(box.root, "ran.json");
  const run = await runCli(runBuildArgs(box, marker, { wait: 1 }), box.env);
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, TOKEN);
  assert.match(run.stderr, /no room for the release build within 1 s .*Nothing was changed/u);
  assert.equal(fs.existsSync(marker), false, "the child never ran");
  assert.deepEqual(buildEntries(box), []);
  assert.ok(decisionLog(box).some((l) => l.kind === "build" && l.decision === "refused"));
});

test("NEGATIVE run-build: on a borrowing box a failing NODE term never runs the child; with node room it runs (control)", async () => {
  // basis limit: B = L = 6144 > R = 640. Box room 6144−512−307−1000 = 4325 fits; node room =
  // MemAvailable − 0 − 307 − 3072 ⇒ 3000 MiB available fails, 9000 fits.
  const tight = makeBox({
    requestMib: 640,
    limitMib: 6144,
    basis: "limit",
    committedMib: 1000,
    memAvailableMib: 3000,
  });
  const marker = path.join(tight.root, "ran.json");
  const refused = await runCli(runBuildArgs(tight, marker), tight.env);
  assert.equal(refused.code, 75, refused.stderr);
  assert.match(refused.stderr, TOKEN);
  assert.match(refused.stderr, / node_room_mib=0\b/u);
  assert.equal(fs.existsSync(marker), false);
  const roomy = makeBox({
    requestMib: 640,
    limitMib: 6144,
    basis: "limit",
    committedMib: 1000,
    memAvailableMib: 9000,
  });
  const ran = path.join(roomy.root, "ran.json");
  const admitted = await runCli(runBuildArgs(roomy, ran), roomy.env);
  assert.equal(admitted.code, 0, admitted.stderr);
  assert.equal(fs.existsSync(ran), true);
});

test("run-build waiting: the entry charges every gated admission (--need 1 flips), is no 'starting', re-stamps, and TERM runs nothing", async () => {
  const box = makeBox(WAITS);
  const before = await capacityJson(box, ["--need", "1"]);
  assert.equal(before.run.code, 0, "one agent slot is free before the build reserves");
  assert.ok(before.json.features.includes("run-build"));
  assert.equal(before.json.build.fits, false);
  const needBuild = await runCli(["capacity", "--need-build"], box.env);
  assert.equal(needBuild.code, 75);
  assert.match(needBuild.stdout, /^need build: NOT MET \(exit 75\) — waits — /mu);

  const marker = path.join(box.root, "ran.json");
  const cli = startCli(runBuildArgs(box, marker, { wait: 60 }), box.env);
  const first = await until("a waiting build entry", () =>
    buildEntries(box).find((e) => e.phase === "waiting"),
  );
  const during = await capacityJson(box, ["--need", "1"]);
  assert.equal(during.run.code, 75, "the build's 1000 MiB take the last agent slot");
  assert.equal(during.json.pendingBytes, 1000 * MIB);
  assert.equal(during.json.owners.starting, 0);
  assert.equal(during.json.build.holder?.phase, "waiting");
  assert.equal(during.json.build.holder?.key, first.key);
  // R6: re-stamped on every evaluation — the LEDGER FILE's expiresAt moves (older readers see it).
  const later = await until("a re-stamp", () =>
    buildEntries(box).find((e) => Date.parse(e.expiresAt) > Date.parse(first.expiresAt)),
  );
  assert.ok(Date.parse(later.expiresAt) - Date.now() > 9 * 60_000);

  cli.proc.kill("SIGTERM");
  const run = await cli.done;
  assert.equal(run.code, 143, run.stderr);
  assert.equal(fs.existsSync(marker), false, "nothing ran");
  assert.deepEqual(buildEntries(box), []);
  const after = await capacityJson(box, ["--need", "1"]);
  assert.equal(after.run.code, 0, "the slot is free again");
});

test("AC-7: SIGKILLed run-build — the entry survives while its build child lives, and is dropped after", async () => {
  const box = makeBox(FITS);
  const marker = path.join(box.root, "ran.json");
  const cli = startCli(runBuildArgs(box, marker, { holdMs: 60_000 }), box.env);
  const entry = await until("a building entry", () =>
    buildEntries(box).find((e) => e.phase === "building"),
  );
  const { pid } = await until("the child's marker", () =>
    fs.existsSync(marker) ? readMarker(marker) : undefined,
  );
  assert.equal(entry.buildPid, pid);
  cli.proc.kill("SIGKILL");
  await cli.exited;
  assert.ok(alive(pid), "the build child outlives its SIGKILLed run-build");
  try {
    const held = await capacityJson(box);
    assert.equal(held.json.build.holder?.phase, "building", "kept: the build still runs");
    assert.equal(held.json.build.holder?.buildPid, pid);
    assert.equal(held.json.pendingBytes, 1000 * MIB);
    assert.equal(held.json.owners.starting, 0);
  } finally {
    process.kill(pid, "SIGKILL");
  }
  await until("the build child reaped", () => (alive(pid) ? undefined : true));
  await cli.done;
  const gone = await capacityJson(box);
  assert.equal(gone.json.build.holder, null, "dropped within one read once both are gone");
  assert.equal(gone.json.pendingBytes, 0);
});

test("AC-7: SIGTERM to run-build mid-build — the build's whole process group is gone within 5 s, the entry removed, and run-build exits promptly after SIGTERM", async () => {
  const box = makeBox(FITS);
  const marker = path.join(box.root, "ran.json");
  const cli = startCli(runBuildArgs(box, marker, { holdMs: 60_000, grand: true }), box.env);
  await until("a building entry", () => buildEntries(box).find((e) => e.phase === "building"));
  const facts = await until("the child's marker", () =>
    fs.existsSync(marker) ? readMarker(marker) : undefined,
  );
  assert.ok(facts.grandPid, "the child started a grandchild in its group");
  const t0 = Date.now();
  cli.proc.kill("SIGTERM");
  await cli.exited;
  // run-build exits promptly after SIGTERM: no armed grace timer may hold its event loop (it lingered
  // 3 s when the exit was raced against a plain sleep).
  assert.ok(Date.now() - t0 < 2000, `run-build exited ${Date.now() - t0} ms after SIGTERM`);
  const run = await cli.done;
  await until(
    "child and grandchild gone",
    () => (alive(facts.pid) || alive(facts.grandPid ?? 0) ? undefined : true),
    5000,
  );
  assert.ok(Date.now() - t0 <= 5000);
  assert.equal(run.code, 143, run.stderr);
  assert.deepEqual(buildEntries(box), []);
  assert.ok(decisionLog(box).some((l) => l.kind === "build" && l.decision === "signalled"));
});

test("AC-7: a build past its 10 min keeps its entry — the LEDGER's expiresAt is re-stamped while building (skew-safe, R6/K5)", async () => {
  const box = makeBox(FITS);
  const env = { ...box.env, ACPX_RUN_BUILD_RESTAMP_MS: "200" };
  const marker = path.join(box.root, "ran.json");
  const cli = startCli(runBuildArgs(box, marker, { holdMs: 60_000 }), env);
  try {
    const entry = await until("a building entry", () =>
      buildEntries(box).find((e) => e.phase === "building"),
    );
    // Age the entry past its expiry, as 10 minutes of building would: an OLDER reader, with no
    // liveness exemption, would drop it now. The re-stamp must move it back into the future.
    const file = path.join(box.root, "admission", "pending.json");
    const aged = { ...entry, expiresAt: new Date(Date.now() - 1000).toISOString() };
    fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [aged] }));
    const restamped = await until("a re-stamped expiresAt", () =>
      buildEntries(box).find((e) => Date.parse(e.expiresAt) > Date.now() + 9 * 60_000),
    );
    assert.equal(restamped.key, entry.key);
    assert.equal(restamped.phase, "building");
    // And if an older reader pruned it outright, the re-stamp puts it back.
    fs.writeFileSync(file, JSON.stringify({ schema: 1, entries: [] }));
    await until("the entry restored", () => buildEntries(box).find((e) => e.key === entry.key));
  } finally {
    cli.proc.kill("SIGTERM");
    await cli.done;
  }
  assert.deepEqual(buildEntries(box), [], "no late re-stamp resurrects it after the end");
});

test("nested: ACPX_BUILD_ADMITTED set ⇒ runs at once on a box with no room, takes no second reservation, logs it", async () => {
  const box = makeBox(WAITS);
  const marker = path.join(box.root, "ran.json");
  const run = await runCli(runBuildArgs(box, marker, { rc: 3 }), {
    ...box.env,
    ACPX_BUILD_ADMITTED: "build:outer",
  });
  assert.equal(run.code, 3, run.stderr);
  assert.equal(readMarker(marker).admitted, "build:outer");
  assert.deepEqual(buildEntries(box), []);
  assert.ok(
    decisionLog(box).some(
      (l) => l.kind === "build" && l.decision === "nested" && l.admittedKey === "build:outer",
    ),
  );
});

test("K4: run-build around a refresh.sh whose --status says running ⇒ exit 75 DENIED at once, nothing reserved or run", async () => {
  const box = makeBox(FITS);
  const bin = path.join(box.root, "bin");
  fs.mkdirSync(bin);
  const script = path.join(bin, "refresh.sh");
  const marker = path.join(box.root, "refreshed");
  const write = (status: number) =>
    fs.writeFileSync(
      script,
      `#!/bin/sh\nif [ "$1" = --status ]; then echo "running (pid 1, since x, by y)"; exit ${status}; fi\ntouch ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );
  write(75);
  const denied = await runCli(["capacity", "run-build", "--wait", "30", "--", script], box.env);
  assert.equal(denied.code, 75);
  assert.match(denied.stderr, /DENIED: another refresh is already running \(running \(pid 1/u);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(buildEntries(box), []);
  write(0);
  const ran = await runCli(["capacity", "run-build", "--wait", "30", "--", script], box.env);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(fs.existsSync(marker), true, "control: an idle refresh runs");
});

test("run-build: a missing command is a usage error (exit 2), never a run", async () => {
  const box = makeBox(FITS);
  const run = await runCli(["capacity", "run-build"], box.env);
  assert.equal(run.code, 2);
});

// ---------------------------------------------------------------------------------------------
// Static imports only (§3.2 step 7)
// ---------------------------------------------------------------------------------------------

const SPECIFIER = /(?:^|[\s;}])(?:import|export)\s*(?:[\w*{}\s,$]*?\bfrom\s*)?["']([^"']+)["']/gmu;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/gu;

/**
 * Modules run-build's graph reaches that DO hold a lazy import, each on a path run-build never takes
 * after its child starts. A NEW one turns the row red: read it, and either keep it off the post-start
 * path (and list it here with the reason) or make it static.
 */
const KNOWN_LAZY: Record<string, string> = {
  "models/claude-advertisement.js":
    "model advertisement reads (transient advertisement, subscriptions) — reached through the session store, never called by run-build",
};

test("run-build: the module graph it reaches holds no dynamic import beyond the known, off-path ones", () => {
  const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const entry = path.join(srcRoot, "capacity", "run-build.js");
  const seen = new Set<string>();
  const lazy: string[] = [];
  const stack = [entry];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    // Comments out: JSDoc `{@link import("./x.js")}` is not a load.
    const source = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    for (const match of source.matchAll(SPECIFIER)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (match[1].startsWith(".") && fs.existsSync(target)) {
        stack.push(target);
      }
    }
    if ([...source.matchAll(DYNAMIC)].length > 0) {
      lazy.push(path.relative(srcRoot, file));
    }
  }
  assert.ok(seen.size > 20, `walked ${seen.size} modules`);
  for (const own of [
    "capacity/run-build.js",
    "capacity/build.js",
    "capacity/ledger.js",
    "capacity/pending.js",
    "capacity/reading.js",
  ]) {
    assert.ok(seen.has(path.join(srcRoot, own)), `${own} is in the walk`);
  }
  assert.deepEqual(lazy.toSorted(), Object.keys(KNOWN_LAZY).toSorted());
});

test("BUILD_CONSTANTS: the §3.3 figures", () => {
  assert.equal(BUILD_CONSTANTS.buildReserveBytes, 1920 * MIB);
  assert.equal(BUILD_CONSTANTS.buildGrowthFraction, 0.5);
  assert.equal(BUILD_CONSTANTS.buildWaitDefaultS, 900);
  assert.equal(BUILD_CONSTANTS.buildExpiryRestampS, 600);
});
