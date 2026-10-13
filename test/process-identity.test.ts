import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import {
  captureRecordPidIdentity,
  classifyRecordedIdentity,
  getOwnProcessIdentity,
  getOwnProcessScope,
  identityScope,
  isOwnProcessScopeVerified,
  observeProcessIncarnation,
  parseLegacyStartTimeTicks,
  parseLinuxStatStartTicks,
  parseProcessBirthIdentity,
  parseRecordPidIdentity,
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
  setProcReaderForTests,
  validRecordPidIdentity,
  type LinuxProcessIdentity,
} from "../src/process-identity.js";
import { isProcessDefinitelyDead } from "../src/process-liveness.js";

// brick ae547131 §12.1 A — T01 (codec), T02 (own scope), T03 (observeProcessIncarnation), T35 unit.

const linux = process.platform === "linux";
const BOOT = "919304b9-e1a7-4f88-a74f-81b2ea37b43d";
const SCOPE = {
  bootId: BOOT,
  pidNamespace: "pid:[4026534191]",
  timeNamespace: "time:[4026531834]",
};

function spawnSleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function liveLinuxIdentity(pid: number): LinuxProcessIdentity {
  const identity = readProcessBirthIdentity(pid);
  assert.ok(identity && identity.kind === "linux-proc", `identity of ${pid}`);
  return identity;
}

test("T01 codec: legacy lease kind without scope is legacy, not a birth identity", () => {
  const legacy = { kind: "linux-proc-stat-starttime", startTimeTicks: "144330001" };
  assert.equal(parseProcessBirthIdentity(legacy), undefined);
  assert.equal(parseLegacyStartTimeTicks(legacy), "144330001");
});

test("T01 codec: legacy kind + scope parses to the in-memory linux-proc identity", () => {
  const onDisk = { kind: "linux-proc-stat-starttime", startTimeTicks: "144330001", ...SCOPE };
  assert.deepEqual(parseProcessBirthIdentity(onDisk), {
    kind: "linux-proc",
    ...SCOPE,
    startTicks: "144330001",
  });
  // A pre-0a reader parses only kind + startTimeTicks; both must keep their meaning.
  assert.equal(parseLegacyStartTimeTicks(onDisk), "144330001");
});

test("T01 codec: upstream linux-proc spelling parses (forward compatibility)", () => {
  const upstream = { kind: "linux-proc", ...SCOPE, startTicks: "42" };
  assert.deepEqual(parseProcessBirthIdentity(upstream), upstream);
  assert.equal(parseLegacyStartTimeTicks(upstream), undefined);
});

test("T01 codec: posix-lstart and windows-creation parse only in canonical form", () => {
  assert.deepEqual(
    parseProcessBirthIdentity({ kind: "posix-lstart", value: "2026-10-13T01:02:03.000Z" }),
    { kind: "posix-lstart", value: "2026-10-13T01:02:03.000Z" },
  );
  assert.equal(
    parseProcessBirthIdentity({ kind: "posix-lstart", value: "2026-10-13T01:02:03.123Z" }),
    undefined,
  );
  assert.deepEqual(
    parseProcessBirthIdentity({ kind: "windows-creation", value: "2026-10-13T01:02:03.1234567Z" }),
    { kind: "windows-creation", value: "2026-10-13T01:02:03.1234567Z" },
  );
});

test("T01 codec: a malformed scope is no birth identity — and classifies FOREIGN, never legacy", () => {
  // CONCEPT T01 said "malformed scope ⇒ legacy"; the HoD's 2026-10-13 alignment with acpx-ui made
  // it conservative: scope fields present but not all equal to ours ⇒ foreign (never pid-judged).
  for (const bad of [
    { ...SCOPE, bootId: "not-a-uuid" },
    { ...SCOPE, pidNamespace: "pid:[0]" },
    { ...SCOPE, timeNamespace: "time:[x]" },
  ]) {
    const onDisk = { kind: "linux-proc-stat-starttime", startTimeTicks: "7", ...bad };
    assert.equal(parseProcessBirthIdentity(onDisk), undefined, JSON.stringify(bad));
    // a pre-0a reader still sees its start ticks
    assert.equal(parseLegacyStartTimeTicks(onDisk), "7");
    assert.deepEqual(classifyRecordedIdentity(onDisk), { kind: "scope-only", local: false });
  }
  assert.deepEqual(
    parseProcessBirthIdentity({
      kind: "linux-proc",
      ...SCOPE,
      timeNamespace: "unsupported",
      startTicks: "0",
    }),
    { kind: "linux-proc", ...SCOPE, timeNamespace: "unsupported", startTicks: "0" },
  );
});

test("T01 codec: serialize writes the LEGACY kind plus scope, and round-trips byte-stable", () => {
  const identity: LinuxProcessIdentity = { kind: "linux-proc", ...SCOPE, startTicks: "99" };
  const onDisk = serializeProcessBirthIdentity(identity);
  assert.deepEqual(onDisk, {
    kind: "linux-proc-stat-starttime",
    startTimeTicks: "99",
    ...SCOPE,
  });
  const text = JSON.stringify(onDisk);
  const reparsed = parseProcessBirthIdentity(JSON.parse(text));
  assert.ok(reparsed);
  assert.equal(JSON.stringify(serializeProcessBirthIdentity(reparsed)), text);
});

test("T01 codec: record pid_identity is snake_case, validated, and decoded only for its own pid", () => {
  const onDisk = {
    pid: 4242,
    kind: "linux-proc",
    boot_id: BOOT,
    pid_namespace: SCOPE.pidNamespace,
    time_namespace: SCOPE.timeNamespace,
    start_ticks: "144330002",
    host: "dev-server-b668d8954-kl4ff",
  };
  const parsed = parseRecordPidIdentity(JSON.parse(JSON.stringify(onDisk)));
  assert.deepEqual(parsed, onDisk);
  assert.equal(JSON.stringify(parsed), JSON.stringify(onDisk), "byte-stable");
  assert.deepEqual(validRecordPidIdentity(4242, parsed), {
    kind: "linux-proc",
    ...SCOPE,
    startTicks: "144330002",
  });
  // the validity rule: pid_identity.pid must equal record.pid
  assert.equal(validRecordPidIdentity(4243, parsed), undefined);
  assert.equal(validRecordPidIdentity(undefined, parsed), undefined);
  assert.equal(validRecordPidIdentity(4242, undefined), undefined);
  // malformed ⇒ absent (never signalled), never a record rejection
  assert.equal(parseRecordPidIdentity({ ...onDisk, start_ticks: "x" }), undefined);
  assert.equal(parseRecordPidIdentity({ ...onDisk, pid: 0 }), undefined);
  assert.equal(parseRecordPidIdentity({ ...onDisk, pid_namespace: "pid:[0]" }), undefined);
});

test("T01 stat parser: comm with spaces and parens, field 22", () => {
  const fields = Array.from({ length: 30 }, (_, index) => String(index + 3));
  fields[0] = "S";
  fields[19] = "123456";
  const stat = `77 (we ird) (x) ${fields.join(" ")}`;
  assert.equal(parseLinuxStatStartTicks(stat), "123456");
  assert.equal(parseLinuxStatStartTicks(stat, 77), "123456");
  assert.equal(parseLinuxStatStartTicks(stat, 78), undefined);
});

test("T02 own scope equals the shell-read boot id, pid ns, time ns and own start ticks", (t) => {
  if (!linux) {
    t.skip("linux only");
    return;
  }
  const scope = getOwnProcessScope();
  assert.ok(scope);
  assert.equal(scope.bootId, fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
  assert.equal(
    scope.pidNamespace,
    execFileSync("readlink", ["/proc/self/ns/pid"]).toString().trim(),
  );
  let shellTime = "unsupported";
  try {
    shellTime = fs.readlinkSync("/proc/self/ns/time");
  } catch {
    // kernel without CONFIG_TIME_NS
  }
  assert.equal(scope.timeNamespace, shellTime);
  const own = getOwnProcessIdentity();
  assert.ok(own && own.kind === "linux-proc");
  const stat = fs.readFileSync("/proc/self/stat", "utf8");
  assert.equal(own.startTicks, stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  assert.equal(isOwnProcessScopeVerified(), true);
});

test("T03 observeProcessIncarnation: the full verdict table", async (t) => {
  if (!linux) {
    t.skip("linux only");
    return;
  }
  const sleeper = spawnSleeper();
  const reaped = spawnSleeper();
  try {
    assert.ok(sleeper.pid && reaped.pid);
    const identity = liveLinuxIdentity(sleeper.pid);
    assert.equal(observeProcessIncarnation(sleeper.pid, identity), "matching");
    assert.equal(identityScope(identity), "local");

    const startPlusOne = { ...identity, startTicks: String(BigInt(identity.startTicks) + 1n) };
    assert.equal(observeProcessIncarnation(sleeper.pid, startPlusOne), "gone");

    const reapedIdentity = liveLinuxIdentity(reaped.pid);
    reaped.kill("SIGKILL");
    await waitForExit(reaped);
    assert.equal(isProcessDefinitelyDead(reaped.pid), true);
    assert.equal(observeProcessIncarnation(reaped.pid, reapedIdentity), "gone");

    // THE trap: a pid that is dead HERE but was recorded in another pid namespace.
    const foreign = { ...reapedIdentity, pidNamespace: "pid:[1]" };
    assert.equal(observeProcessIncarnation(reaped.pid, foreign), "unknown");
    assert.equal(identityScope(foreign), "foreign");
    // ...and the same for a LIVE local pid number recorded in a foreign namespace.
    assert.equal(
      observeProcessIncarnation(sleeper.pid, { ...identity, pidNamespace: "pid:[1]" }),
      "unknown",
    );

    const otherTime = { ...identity, timeNamespace: "time:[1]" };
    assert.equal(observeProcessIncarnation(sleeper.pid, otherTime), "unknown");
    assert.equal(identityScope(otherTime), "foreign");

    const otherBoot = { ...identity, bootId: "00000000-0000-4000-8000-000000000000" };
    assert.equal(observeProcessIncarnation(sleeper.pid, otherBoot), "gone");
    assert.equal(identityScope(otherBoot), "other-boot");

    assert.equal(observeProcessIncarnation(sleeper.pid, undefined), "unknown");
    assert.equal(observeProcessIncarnation(0, identity), "unknown");
  } finally {
    sleeper.kill("SIGKILL");
    reaped.kill("SIGKILL");
  }
});

test("T03 captureRecordPidIdentity: matches the live process; undefined for a dead pid", async (t) => {
  if (!linux) {
    t.skip("linux only");
    return;
  }
  const child = spawnSleeper();
  try {
    assert.ok(child.pid);
    const captured = captureRecordPidIdentity(child.pid);
    assert.ok(captured);
    assert.equal(captured.pid, child.pid);
    assert.equal(
      observeProcessIncarnation(child.pid, validRecordPidIdentity(child.pid, captured)),
      "matching",
    );
  } finally {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
  assert.equal(captureRecordPidIdentity(child.pid), undefined);
});

test("T35 /proc self-check: a /proc of another pid namespace makes every observation unknown", async (t) => {
  if (!linux) {
    t.skip("linux only");
    return;
  }
  const child = spawnSleeper();
  try {
    assert.ok(child.pid);
    const identity = liveLinuxIdentity(child.pid);
    setProcReaderForTests({
      readFile: (path) =>
        path === "/proc/self/stat"
          ? fs.readFileSync(path, "utf8").replace(/^\d+ /, `${process.pid + 100000} `)
          : fs.readFileSync(path, "utf8"),
      readLink: (path) => fs.readlinkSync(path),
    });
    assert.equal(isOwnProcessScopeVerified(), false);
    assert.equal(getOwnProcessScope(), undefined);
    assert.equal(observeProcessIncarnation(child.pid, identity), "unknown");
    assert.equal(identityScope(identity), "unverified");
    assert.equal(identityScope(undefined), "unverified");
    assert.equal(getOwnProcessIdentity(), undefined);
  } finally {
    setProcReaderForTests(undefined);
    child.kill("SIGKILL");
    await waitForExit(child);
  }
  assert.equal(isOwnProcessScopeVerified(), true);
});

test("HoD alignment: scope fields WITHOUT start ticks — foreign unless the scope is exactly ours", (t) => {
  if (!linux) {
    t.skip("linux only");
    return;
  }
  const own = getOwnProcessScope();
  assert.ok(own);
  // scope equal to ours, no start ticks ⇒ local-but-unverifiable (never signalled)
  assert.deepEqual(classifyRecordedIdentity({ kind: "linux-proc-stat-starttime", ...own }), {
    kind: "scope-only",
    local: true,
  });
  assert.deepEqual(classifyRecordedIdentity({ kind: "linux-proc", ...own }), {
    kind: "scope-only",
    local: true,
  });
  // scope different from ours (another pid namespace), no start ticks ⇒ foreign
  assert.deepEqual(
    classifyRecordedIdentity({
      kind: "linux-proc-stat-starttime",
      ...own,
      pidNamespace: "pid:[1]",
    }),
    { kind: "scope-only", local: false },
  );
  // a partial scope is "present but not equal" ⇒ foreign
  assert.deepEqual(classifyRecordedIdentity({ kind: "linux-proc", bootId: own.bootId }), {
    kind: "scope-only",
    local: false,
  });
  // complete identity ⇒ birth; no scope at all ⇒ legacy with its ticks
  assert.equal(
    classifyRecordedIdentity({ kind: "linux-proc", ...own, startTicks: "5" }).kind,
    "birth",
  );
  assert.deepEqual(
    classifyRecordedIdentity({ kind: "linux-proc-stat-starttime", startTimeTicks: "5" }),
    { kind: "legacy", startTicks: "5" },
  );
});
