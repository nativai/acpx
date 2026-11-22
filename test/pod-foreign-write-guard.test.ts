import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withAdmissionLock, writeLedgerFile } from "../src/capacity/ledger.js";
import { setDefaultSubscriptionAutoWeeklyCeiling } from "../src/config/subscriptions.js";
import { assertBoxWideWriteAllowed, PodForeignWriteError } from "../src/pod/foreign-write-guard.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { setPodLockDepsForTests } from "../src/session/persistence/identity-file-lock.js";
import {
  loadOrRebuildSessionIndex,
  sessionIndexPath,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import { SEAT_STORE_NO_CHANGE, withSeatStoreWrite } from "../src/session/persistence/seat-store.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// block A8 / C1.2 A-8: writers of box-wide files fail closed in an agent pod
// (`acpx: REFUSED reason=pod_foreign_write file=…`). The agent pod here is the C1.1 test seam:
// `ACPX_POD_TEST_HOME` leads into a sandbox whose `.nv-agent` is the place file, and the state home
// IS that sandbox (`<sandbox>/.acpx`). The pod's own record writes must NOT trip it (no index half).

const SAVED = {
  HOME: process.env.HOME,
  ACPX_STATE_HOME: process.env.ACPX_STATE_HOME,
  ACPX_POD_TEST_HOME: process.env.ACPX_POD_TEST_HOME,
};

function sandbox(place: "agent-pod" | "control"): { home: string; sessions: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-fwg-")));
  if (place === "agent-pod") {
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-fwg\n");
  }
  process.env.HOME = home;
  delete process.env.ACPX_STATE_HOME;
  process.env.ACPX_POD_TEST_HOME = home;
  const sessions = path.join(home, ".acpx", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  return { home, sessions };
}

test.afterEach(() => {
  setPodLockDepsForTests(undefined);
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const refused = (file: string) => (error: unknown) =>
  error instanceof PodForeignWriteError &&
  error.file === file &&
  error.message.startsWith(`acpx: REFUSED reason=pod_foreign_write file=${file}`) &&
  error.outputCode === "USAGE";

test("the index writer throws in an agent pod and writes nothing", async () => {
  const { sessions } = sandbox("agent-pod");
  await assert.rejects(writeSessionIndex(sessions, { files: [], entries: [] }), refused("index"));
  assert.equal(fs.existsSync(sessionIndexPath(sessions)), false);
});

test("the seat-store writer throws in an agent pod before it takes its lock or writes", async () => {
  const { sessions } = sandbox("agent-pod");
  await assert.rejects(
    withSeatStoreWrite(sessions, () => ({ mutation: SEAT_STORE_NO_CHANGE, result: 1 })),
    refused("seat-store"),
  );
  assert.deepEqual(fs.readdirSync(sessions), [], "no lock file, no store");
});

test("the registry writer throws in an agent pod and leaves the file as it was", () => {
  const { home } = sandbox("agent-pod");
  const registry = path.join(home, ".acpx", "subscriptions", "registry.json");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  const before = JSON.stringify({ subscriptions: [] });
  fs.writeFileSync(registry, before);
  assert.throws(
    () => setDefaultSubscriptionAutoWeeklyCeiling(0.5, { homeDir: home }),
    refused("registry"),
  );
  assert.equal(fs.readFileSync(registry, "utf8"), before);
});

test("the admission ledger's writer and its lock throw in an agent pod", async () => {
  const { home } = sandbox("agent-pod");
  const dir = path.join(home, ".acpx", "admission");
  await assert.rejects(writeLedgerFile(dir, []), refused("ledger"));
  await assert.rejects(
    withAdmissionLock(dir, async () => 1),
    refused("ledger"),
  );
  assert.equal(fs.existsSync(dir), false, "not even the directory");
});

test("NEGATIVE: the same writers work on the control pod (the guard is the agent pod's alone)", async () => {
  const { sessions, home } = sandbox("control");
  await writeSessionIndex(sessions, { files: [], entries: [] });
  assert.equal(fs.existsSync(sessionIndexPath(sessions)), true);
  const admission = path.join(home, ".acpx", "admission");
  fs.mkdirSync(admission, { recursive: true });
  await writeLedgerFile(admission, []);
  assert.equal(fs.existsSync(path.join(admission, "pending.json")), true);
});

test("NEGATIVE: an agent pod writing a state home OF ITS OWN (a suite, a rig) is not stopped (A-26)", async () => {
  sandbox("agent-pod");
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-fwg-own-"));
  assert.doesNotThrow(() => assertBoxWideWriteAllowed("index", path.join(own, "index.json")));
  await writeSessionIndex(own, { files: [], entries: [] });
});

test("an agent pod's OWN record write succeeds and writes no index half; a plain read builds in memory and persists nothing", async () => {
  const { sessions } = sandbox("agent-pod");
  // The pod's own record lock names the pod (A-25): give this process one.
  const pod = { name: "ag-fwg", uid: "uid-fwg", node: "node-a", namespace: "ns" };
  setPodLockDepsForTests({ ownPod: () => pod, lockPod: () => pod });
  const record = makeSessionRecord({
    acpxRecordId: "own-session",
    acpSessionId: "acp-own",
    agentCommand: "agent",
    cwd: "/tmp/own",
  });
  await writeSessionRecord(record);
  assert.equal(
    fs.existsSync(path.join(sessions, "own-session.json")),
    true,
    "the record is written",
  );
  assert.equal(fs.existsSync(sessionIndexPath(sessions)), false, "no index half (C10)");
  const index = await loadOrRebuildSessionIndex(sessions);
  assert.deepEqual(
    index.entries.map((entry) => entry.acpxRecordId),
    ["own-session"],
    "the read still answers, from the records",
  );
  assert.equal(fs.existsSync(sessionIndexPath(sessions)), false, "and wrote nothing");
});

test("NEGATIVE: on the control pod the same record write DOES write its index half", async () => {
  const { sessions } = sandbox("control");
  await writeSessionRecord(
    makeSessionRecord({
      acpxRecordId: "ctl-session",
      acpSessionId: "acp-ctl",
      agentCommand: "agent",
      cwd: "/tmp/ctl",
    }),
  );
  assert.equal(fs.existsSync(sessionIndexPath(sessions)), true);
});

// ---- discovery: no writer of a box-wide file is left without the guard ----

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const WRITE_PRIMITIVE =
  /\b(?:writeFile|writeFileSync|rename|renameSync|appendFile|copyFileSync)\s*\(/u;
const BOX_WIDE_NAMES =
  /\bsessionIndexPath\b|\bSESSION_INDEX_FILE\b|\bseatStorePath\b|\bSEAT_STORE_FILE\b|\bpending\.json\b|\bregistryPath\b|\bsubscriptionRegistryPath\b/u;
const GUARD = /\bassertBoxWideWriteAllowed\s*\(|\bisBoxWideFileInAgentPod\s*\(/u;
/** The file's text if it is a box-wide writer lacking the guard. */
export function unguardedBoxWideWriter(text: string): boolean {
  return WRITE_PRIMITIVE.test(text) && BOX_WIDE_NAMES.test(text) && !GUARD.test(text);
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

test("DISCOVERY: every src file that names a box-wide path and writes carries the guard", () => {
  const scanned: string[] = [];
  const unguarded: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    scanned.push(rel);
    if (unguardedBoxWideWriter(fs.readFileSync(file, "utf8"))) {
      unguarded.push(rel);
    }
  }
  assert.ok(scanned.length > 200, `positive control: scanned ${scanned.length} files`);
  assert.deepEqual(unguarded, [], "a box-wide writer without assertBoxWideWriteAllowed");
});

test("DISCOVERY negative case: a FRESH unguarded writer, registered nowhere, is flagged", () => {
  const fresh = `import fs from "node:fs/promises";\nexport const f = (d) => fs.writeFile(sessionIndexPath(d), "x");\n`;
  assert.equal(unguardedBoxWideWriter(fresh), true);
  assert.equal(
    unguardedBoxWideWriter(`${fresh}\nassertBoxWideWriteAllowed("index", p);`),
    false,
    "the same writer with the guard is not flagged",
  );
});

// ---- discovery, widened to LOCK paths (TE finding F3): a lock file in the box's state home is a box-wide
// write too — and the fault report's mount stalls make an agent pod holding one a stall for the control pod.
const LOCK_ACQUIRE =
  /\b(?:acquireIdentityFileLock|acquireIdentityFileLockDetailed|withIdentityFileLock)\s*\(/u;
/**
 * The files that take an identity lock DIRECTLY and are allowed to in an agent pod, each for a reason that
 * is a per-SESSION file bound to the session's own pod (C3.2: "Locks two pods can hold: a session's record
 * lock; its lease guard; the fork-source stage lock") — plus the primitive itself.
 */
const SESSION_LOCKS = new Map<string, string>([
  ["session/persistence/identity-file-lock.ts", "the primitive"],
  ["session/persistence/record-file-lock.ts", "the session's record lock"],
  ["cli/queue/lease-mutation.ts", "the session's lease guard"],
  ["acp/fork-source-staging.ts", "the fork-source stage lock"],
  ["session/events.ts", "the session's stream lock (one writing pod, C10)"],
]);

/** True for a direct lock taker that is neither registered as a per-session lock nor guarded. */
export function unguardedLockTaker(rel: string, text: string): boolean {
  return LOCK_ACQUIRE.test(text) && !SESSION_LOCKS.has(rel) && !GUARD.test(text);
}

test("DISCOVERY (locks): every src file that takes an identity lock directly is a registered per-session lock or carries the guard", () => {
  const unguarded: string[] = [];
  const takers: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    const text = fs.readFileSync(file, "utf8");
    if (LOCK_ACQUIRE.test(text)) {
      takers.push(rel);
    }
    if (unguardedLockTaker(rel, text)) {
      unguarded.push(rel);
    }
  }
  assert.ok(takers.length >= 8, `positive control: ${takers.length} direct lock takers found`);
  assert.deepEqual(unguarded, [], "a box-wide lock taker without assertBoxWideWriteAllowed");
  // the registry holds only files that really take a lock (no stale entry)
  for (const registered of SESSION_LOCKS.keys()) {
    assert.ok(takers.includes(registered), `${registered} no longer takes a lock — drop its entry`);
  }
});

test("DISCOVERY (locks) negative case: a FRESH unregistered, unguarded lock taker is flagged", () => {
  const fresh = `import { withIdentityFileLock } from "./identity-file-lock.js";\nexport const f = () => withIdentityFileLock(p, policy, async () => 1);\n`;
  assert.equal(unguardedLockTaker("session/new-store.ts", fresh), true);
  assert.equal(
    unguardedLockTaker("session/new-store.ts", `${fresh}\nassertBoxWideWriteAllowed("index", p);`),
    false,
  );
});

test("F3: withSessionIndexLock refuses in an agent pod before it creates the lock file; `sessions template <own id>`'s write path is that call", async () => {
  const { withSessionIndexLock } = await import("../src/session/persistence/index-lock.js");
  const { persistTemplateMark } = await import("../src/session/persistence.js");
  const { sessions } = sandbox("agent-pod");
  await assert.rejects(
    withSessionIndexLock(sessions, async () => 1),
    refused("index"),
  );
  assert.deepEqual(fs.readdirSync(sessions), [], "no index.json.lock was created");
  // the reachable path TE measured: a record-class command taking the lock around its record write
  const marked = makeSessionRecord({
    acpxRecordId: "tmpl-own",
    acpSessionId: "acp-tmpl",
    agentCommand: "agent",
    cwd: "/tmp/tmpl",
  });
  marked.template = { enabled: true, created_at: "2026-11-22T00:00:00.000Z" } as never;
  await assert.rejects(persistTemplateMark(marked, {}), refused("index"));
  assert.equal(fs.existsSync(path.join(sessions, "index.json.lock")), false);
  // NEGATIVE: the control pod takes it as before
  sandbox("control");
  const control = process.env.HOME ?? "";
  const controlSessions = path.join(control, ".acpx", "sessions");
  assert.equal(await withSessionIndexLock(controlSessions, async () => 7), 7);
});
