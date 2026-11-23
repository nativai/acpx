import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSeatActiveHolder } from "../src/cli/session-selector.js";
import { installReadEvidenceOnly } from "../src/pod/armed-guards.js";
import {
  armTargetVerdict,
  disarmTargetVerdictForTests,
  toldEvents,
} from "../src/pod/target-verdict.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { agentPodEnv, agentPodHome, CLI, runCli, type ChildRun } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";

// K5 round 4 follow-ups (brick 3543498a; source: the K5R4 TE round 2, brick 46b827ba). Three guarantees of the armed
// verdict child's READ EVIDENCE (`src/pod/armed-guards.ts`) that no row could fail on:
//
//   F2 seat file      a truncated `seats.json`: the store refuses it on its own (`SeatStoreUnhealthyError`), so the
//                     guarantee is held twice, and only the PARENT's half — `differs`, so the door's refusal stands
//                     instead of the child's complaint about a pod-local file — depends on the evidence.
//   ensureSessionDir  `mkdir -p` on an EXISTING sessions directory is a write to a permission-checked runtime: DENIED.
//   store spelling    one store file has one spelling to the evidence, however a reader reached it.
//
// Every row here carries its own RED TREE, built in the test, never by editing the product: the check a row makes is
// a function, and the same function is asserted to THROW on the red tree's output (`assert.throws(() => check(red))`).

const ID = "99999999-0000-4000-8000-0000000000f9";
const SEAT = "22222222-2222-4222-8222-2222222222cc";
const TRUNCATED_RECORD = '{"acpxRecordId":"9999';

async function makeHome(): Promise<string> {
  // realpath: os.tmpdir() may itself be an alias, and the spelling rows must name the alias themselves
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acpx-evidence-")));
  await fs.mkdir(path.join(home, ".acpx", "sessions"), { recursive: true });
  return home;
}

const sessionsOf = (home: string): string => path.join(home, ".acpx", "sessions");

async function withStateHome<T>(
  home: string,
  run: () => Promise<T>,
  extra: Record<string, string> = {},
): Promise<T> {
  const names = ["HOME", "ACPX_STATE_HOME", ...Object.keys(extra)];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.ACPX_STATE_HOME = home;
  Object.assign(process.env, extra);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

type Told = { differs: boolean; answer: unknown };

/** One armed read under the read evidence (optionally with the test-local seam laid over it). */
async function armedRead(
  home: string,
  read: () => Promise<unknown>,
  options: { install?: () => () => void; env?: Record<string, string> } = {},
): Promise<Told> {
  disarmTargetVerdictForTests();
  armTargetVerdict({ values: ["x"], kind: "not-found" });
  const restore = (options.install ?? installReadEvidenceOnly)();
  try {
    let answer: unknown;
    await withStateHome(
      home,
      async () => {
        answer = await read().then(
          (value) => value,
          (error: unknown) => error,
        );
      },
      options.env,
    );
    return { differs: toldEvents().has("differs"), answer };
  } finally {
    restore();
    disarmTargetVerdictForTests();
  }
}

// ---- F2 seat file: the evidence is what stands between a truncated seats.json and "no such seat" -----------------------

const fsPromises = fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

/**
 * THE TEST-LOCAL SEAM: the read evidence, with every read of `seats.json` routed PAST it — the tree in which the seat
 * file is not evidence-checked. Built over the product's own install, so everything else stays watched (a record read
 * is still flagged: the red below is attributable to the seat leg alone).
 */
function evidenceBlindToSeats(): () => void {
  const unwatched = fsPromises.readFile as (...args: unknown[]) => Promise<unknown>;
  const restoreEvidence = installReadEvidenceOnly();
  const watched = fsPromises.readFile as (...args: unknown[]) => Promise<unknown>;
  fsPromises.readFile = (file: unknown, ...rest: unknown[]) =>
    String(file).endsWith(`${path.sep}seats.json`)
      ? unwatched(file, ...rest)
      : watched(file, ...rest);
  return () => {
    fsPromises.readFile = watched;
    restoreEvidence();
  };
}

async function seatLookupOnTruncatedSeatFile(seam: boolean): Promise<Told> {
  const home = await makeHome();
  await fs.writeFile(path.join(sessionsOf(home), "seats.json"), '{"2222');
  return await armedRead(home, () => resolveSeatActiveHolder("--seat", SEAT), {
    install: seam ? evidenceBlindToSeats : undefined,
  });
}

/** What the row asserts: the truncated seat file was told `differs`, so the parent keeps the door's refusal. */
function assertSeatFileWatched(told: Told): void {
  assert.equal(told.differs, true, "a truncated seats.json must be told `differs`");
}

// ⚠️ WHY THIS LEG NEEDS ITS OWN ROW. `seatFromStore` already REFUSES an unhealthy seat file (`SeatStoreUnhealthyError`:
// "this is NOT an empty store and NOT a missing seat"), so a seat lookup never answers "no such seat" off a truncated
// file — the guarantee is held TWICE, and a row that only checks the door's refusal cannot tell which of the two held
// (K5R4 TE round 2). What the evidence adds is the PARENT's half: without `differs`, the child's refusal about the
// POD-LOCAL seats.json is a finished, non-zero answer and `judgeChild` RELAYS it, where the pod's file is not the box's.

test("F2 seat file: a truncated seats.json is told `differs` by the read evidence — on top of the store's own refusal", async () => {
  const told = await seatLookupOnTruncatedSeatFile(false);
  assertSeatFileWatched(told);
  assert.equal(
    (told.answer as Error).name,
    "SeatStoreUnhealthyError",
    "the store refuses on its own",
  );
});

test("F2 seat file (the row can fail): on the tree where seats.json is NOT evidence-checked the SAME lookup tells nothing — the store's refusal alone — and the row's own check throws", async () => {
  const red = await seatLookupOnTruncatedSeatFile(true);
  assert.equal(red.differs, false, "the seam leaves seats.json unwatched");
  assert.equal((red.answer as Error).name, "SeatStoreUnhealthyError");
  assert.throws(() => assertSeatFileWatched(red), /must be told `differs`/u);
});

test("F2 seat file (the seam removes the seat leg ONLY): with the seam laid over the evidence a truncated RECORD is still told `differs`", async () => {
  const home = await makeHome();
  await fs.writeFile(path.join(sessionsOf(home), `${ID}.json`), TRUNCATED_RECORD);
  const told = await armedRead(home, () => resolveSessionRecord(ID), {
    install: evidenceBlindToSeats,
  });
  assert.equal(told.differs, true);
});

// END TO END, through the real CLI in an agent pod: the same seam, laid over the REAL armed child by a test-local entry
// (`ACPX_POD_VERDICT_CHILD_ENTRY`, honoured under `node --test` only). The wrapper makes `fs.promises.readFile` an
// accessor, so the guards' own assignment lands UNDER a dispatcher that sends `seats.json` reads past them.

const SEAT_BLIND_ENTRY = `import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
const cli = process.env.FIXTURE_CLI;
const original = fsp.readFile;
let current = original;
let installed = false;
// Until the guards assign, the getter hands them the REAL readFile (so the guards wrap it, not this dispatcher); after,
// a read of seats.json goes to the real one and every other read goes through the guards.
const dispatch = (file, ...rest) =>
  String(file).endsWith("/seats.json") ? original(file, ...rest) : current(file, ...rest);
Object.defineProperty(fsp, "readFile", {
  configurable: true,
  enumerable: true,
  get: () => (installed ? dispatch : original),
  set: (value) => {
    current = value;
    installed = true;
  },
});
process.argv[1] = cli;
await import(pathToFileURL(cli).href);
`;

const STILL_REFUSED_TARGET =
  /^acpx: REFUSED reason=pass_through_refused nothing_started=true protocol=1 status=400 error=class-not-passable detail=target-unresolved$/u;

function assertDoorRefusal(run: ChildRun): void {
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr.split("\n")[0] ?? "", STILL_REFUSED_TARGET);
  assert.doesNotMatch(run.stdout + run.stderr, /does not parse|Session not found/u);
}

async function podStatusOfSeatWithTruncatedSeatFile(blind: boolean): Promise<ChildRun> {
  const atriumHome = await makeHome(); // atrium's store: the seat is nowhere in it
  const { home } = agentPodHome();
  await fs.mkdir(sessionsOf(home), { recursive: true });
  await fs.writeFile(path.join(sessionsOf(home), "seats.json"), '{"2222');
  const entry = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "acpx-evidence-entry-")),
    "blind.mjs",
  );
  await fs.writeFile(entry, SEAT_BLIND_ENTRY);
  const atrium = await startRecordedAtrium({ stateHome: atriumHome });
  try {
    return await runCli(
      ["claude", "status", "--seat", SEAT],
      agentPodEnv(home, atrium.url, {
        ACPX_CALL_HOME_BUDGET_MS: "20000",
        ...(blind ? { ACPX_POD_VERDICT_CHILD_ENTRY: entry, FIXTURE_CLI: CLI } : {}),
      }),
      { cwd: home },
    );
  } finally {
    await atrium.close();
  }
}

test("F2 seat file (end to end): a pod's `status --seat` with a truncated pod-local seats.json ends in the door's refusal", async () => {
  assertDoorRefusal(await podStatusOfSeatWithTruncatedSeatFile(false));
});

test("F2 seat file (end to end, the row can fail): with seats.json reads routed past the evidence in the real child, the pod RELAYS the pod-local file's complaint — and the row's own check throws", async () => {
  const red = await podStatusOfSeatWithTruncatedSeatFile(true);
  assert.match(
    red.stderr + red.stdout,
    /does not parse/u,
    "the child's own refusal reached the user",
  );
  assert.notEqual(red.status, 2);
  assert.throws(() => assertDoorRefusal(red));
});

// ---- ensureSessionDir: a stat before the mkdir — what the read-only child needs ----------------------------------------

type MkdirCalls = Array<{ dir: string; recursive: boolean }>;

/** Run `run` with `fs.mkdir` counted (the calls still go through). */
async function countingMkdir(run: () => Promise<unknown>): Promise<MkdirCalls> {
  const calls: MkdirCalls = [];
  const original = fsPromises.mkdir as (...args: unknown[]) => Promise<unknown>;
  fsPromises.mkdir = (dir: unknown, options: unknown) => {
    calls.push({
      dir: String(dir),
      recursive: (options as { recursive?: boolean } | undefined)?.recursive === true,
    });
    return original(dir, options);
  };
  try {
    await run();
  } finally {
    fsPromises.mkdir = original;
  }
  return calls;
}

/** The old shape of `ensureSessionDir`, test-local: the mkdir with no stat in front of it. */
const mkdirFirst = (dir: string): Promise<unknown> => fs.mkdir(dir, { recursive: true });

/** What the row asserts: an EXISTING sessions directory is never handed to `mkdir`. */
function assertNoMkdir(calls: MkdirCalls, dir: string): void {
  assert.deepEqual(
    calls.filter((call) => call.dir === dir),
    [],
    `mkdir -p was called on the existing sessions dir ${dir}: a write, denied in the read-only child`,
  );
}

test("ensureSessionDir: resolving an id against an EXISTING sessions dir never calls mkdir on it; against a MISSING one it calls mkdir -p exactly once", async () => {
  const existing = await makeHome();
  const calls = await countingMkdir(() =>
    withStateHome(existing, () => resolveSessionRecord("nobody").catch(() => undefined)),
  );
  assertNoMkdir(calls, sessionsOf(existing));

  const missing = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-evidence-missing-"));
  const created = await countingMkdir(() =>
    withStateHome(missing, () => resolveSessionRecord("nobody").catch(() => undefined)),
  );
  assert.deepEqual(
    created.filter((call) => call.dir === sessionsOf(missing)),
    [{ dir: sessionsOf(missing), recursive: true }],
    "a missing directory is still created, once, recursively",
  );
});

test("ensureSessionDir (the row can fail): the SAME count on the old shape — a mkdir with no stat in front — finds the call, and the row's own check throws", async () => {
  const existing = await makeHome();
  const red = await countingMkdir(() => mkdirFirst(sessionsOf(existing)));
  assert.equal(red.length, 1, "the counter sees a mkdir -p on an existing directory");
  assert.throws(() => assertNoMkdir(red, sessionsOf(existing)), /mkdir -p was called/u);
});

test("ensureSessionDir (why it matters): under the read-only permission model `mkdir -p` on an EXISTING directory is DENIED, a stat and the product's own lookup are not", async () => {
  const home = await makeHome();
  // a store WITH its index, so resolving a missing id writes nothing else (a missing index is rebuilt, and persisted)
  const reindexed = await runCli(
    ["sessions", "reindex"],
    { PATH: process.env.PATH, HOME: home, ACPX_STATE_HOME: home, NODE_TEST_CONTEXT: "child" },
    { cwd: home },
  );
  assert.equal(reindexed.status, 0, reindexed.stderr);
  const productModule = pathToFileURL(
    fileURLToPath(new URL("../src/session/persistence.js", import.meta.url)),
  ).href;
  const script = path.join(home, "probe.mjs");
  await fs.writeFile(
    script,
    `import fs from "node:fs/promises";
const dir = process.argv[2];
const code = (error) => (error && error.code) || (error && error.name) || "ok";
const out = {};
out.mkdirFirst = await fs.mkdir(dir, { recursive: true }).then(() => "ok", code);
out.stat = await fs.stat(dir).then((s) => String(s.isDirectory()), code);
const { resolveSessionRecord } = await import(${JSON.stringify(productModule)});
out.product = await resolveSessionRecord("nobody").then(() => "found", code);
console.log(JSON.stringify(out));
`,
  );
  const run = spawnSync(
    process.execPath,
    ["--permission", "--allow-fs-read=*", script, sessionsOf(home)],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ACPX_STATE_HOME: home,
        NODE_TEST_CONTEXT: "child",
      },
      cwd: home,
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
  assert.equal(out.mkdirFirst, "ERR_ACCESS_DENIED", "the old shape is denied here");
  assert.equal(out.stat, "true");
  assert.equal(
    out.product,
    "SessionNotFoundError",
    "the product's lookup is the store's own not-found, not a denial",
  );
});

// ---- store file spelling: one store file, one spelling, however the reader reached it ----------------------------------

/** Does a read through `spelling(home)` of the truncated store file `<file>` get told `differs`? */
async function flaggedThrough(
  setup: (home: string) => Promise<{
    read: () => Promise<unknown>;
    stateHome?: string;
    env?: Record<string, string>;
  }>,
): Promise<boolean> {
  const home = await makeHome();
  const plan = await setup(home);
  const told = await armedRead(plan.stateHome ?? home, plan.read, { env: plan.env });
  return told.differs;
}

const record = (home: string): string => path.join(sessionsOf(home), `${ID}.json`);
const truncatedRecord = async (home: string): Promise<void> => {
  await fs.writeFile(record(home), TRUNCATED_RECORD);
};

type Spelling = {
  name: string;
  expectFlagged: boolean;
  setup: Parameters<typeof flaggedThrough>[0];
};

const SPELLINGS: Spelling[] = [
  {
    name: "the canonical spelling (control)",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      return { read: () => fs.readFile(record(home), "utf8") };
    },
  },
  {
    name: "a `..` folded by the path (`sessions/../sessions/<id>.json`)",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      return {
        read: () => fs.readFile(`${sessionsOf(home)}/../sessions/${ID}.json`, "utf8"),
      };
    },
  },
  {
    name: "a trailing slash on the file (the read fails ENOTDIR, which is not absence)",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      return { read: () => fs.readFile(`${record(home)}/`, "utf8") };
    },
  },
  {
    name: "a trailing slash on the state home",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      return { read: () => fs.readFile(record(home), "utf8"), stateHome: `${home}/` };
    },
  },
  {
    name: "a symlinked HOME: the store is configured through the link, the reader reaches it by the real path",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      const link = `${home}-link`;
      await fs.symlink(home, link);
      return { read: () => fs.readFile(record(home), "utf8"), stateHome: link };
    },
  },
  {
    name: "a symlinked HOME the other way: the store is configured by the real path, the reader reaches it through the link",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      const link = `${home}-link`;
      await fs.symlink(home, link);
      return { read: () => fs.readFile(record(link), "utf8") };
    },
  },
  {
    name: "a `..` AFTER a link (`link/../<id>.json`, where the link points INTO the store): the OS reads the store file, the path folds to somewhere else",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      await fs.mkdir(path.join(sessionsOf(home), "sub"));
      await fs.symlink(path.join(sessionsOf(home), "sub"), path.join(home, "link"));
      return { read: () => fs.readFile(`${home}/link/../${ID}.json`, "utf8") };
    },
  },
  {
    name: "a link to the FILE itself, under another name outside the store",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      await fs.symlink(record(home), path.join(home, "alias.json"));
      return { read: () => fs.readFile(path.join(home, "alias.json"), "utf8") };
    },
  },
  {
    name: "a file: URL naming a home with a character the URL escapes (`%20`)",
    expectFlagged: true,
    setup: async (home) => {
      const spaced = `${home} with space`;
      await fs.mkdir(sessionsOf(spaced), { recursive: true });
      await truncatedRecord(spaced);
      return { read: () => fs.readFile(pathToFileURL(record(spaced))), stateHome: spaced };
    },
  },
  {
    name: "the synchronous reader (`readFileSync`) through a symlinked home",
    expectFlagged: true,
    setup: async (home) => {
      await truncatedRecord(home);
      const link = `${home}-link`;
      await fs.symlink(home, link);
      return {
        read: async () => fsSync.readFileSync(record(link), "utf8"),
      };
    },
  },
  {
    name: "seats.json through a symlinked HOME",
    expectFlagged: true,
    setup: async (home) => {
      await fs.writeFile(path.join(sessionsOf(home), "seats.json"), '{"2222');
      const link = `${home}-link`;
      await fs.symlink(home, link);
      return { read: () => fs.readFile(path.join(sessionsOf(link), "seats.json"), "utf8") };
    },
  },
  {
    name: "index.json through a symlinked HOME",
    expectFlagged: true,
    setup: async (home) => {
      await fs.writeFile(path.join(sessionsOf(home), "index.json"), '{"entries":[');
      const link = `${home}-link`;
      await fs.symlink(home, link);
      return { read: () => fs.readFile(path.join(sessionsOf(link), "index.json"), "utf8") };
    },
  },
  {
    name: "the ARCHIVE directory through a symlink",
    expectFlagged: true,
    setup: async (home) => {
      const archive = path.join(home, "archive-real");
      await fs.mkdir(archive);
      await fs.writeFile(path.join(archive, `${ID}.json`), TRUNCATED_RECORD);
      await fs.symlink(archive, path.join(home, "archive-link"));
      return {
        read: () => fs.readFile(path.join(home, "archive-link", `${ID}.json`), "utf8"),
        env: { ACPX_SESSIONS_ARCHIVE_DIR: archive },
      };
    },
  },
  {
    name: "NOT a store file: a truncated record in another directory is not flagged (no over-flagging)",
    expectFlagged: false,
    setup: async (home) => {
      await fs.mkdir(path.join(home, "elsewhere"));
      await fs.writeFile(path.join(home, "elsewhere", `${ID}.json`), TRUNCATED_RECORD);
      return { read: () => fs.readFile(path.join(home, "elsewhere", `${ID}.json`), "utf8") };
    },
  },
  {
    name: "NOT a store file, though it LOOKS like one after folding: `sessions/link/../<id>.json` where the link points OUT of the store",
    expectFlagged: false,
    setup: async (home) => {
      await fs.mkdir(path.join(home, "elsewhere", "deep"), { recursive: true });
      await fs.writeFile(path.join(home, "elsewhere", `${ID}.json`), TRUNCATED_RECORD);
      await fs.symlink(
        path.join(home, "elsewhere", "deep"),
        path.join(sessionsOf(home), "outbound"),
      );
      return {
        read: () => fs.readFile(`${sessionsOf(home)}/outbound/../${ID}.json`, "utf8"),
      };
    },
  },
];

for (const spelling of SPELLINGS) {
  test(`store file spelling — ${spelling.name}: ${spelling.expectFlagged ? "told `differs`" : "not flagged"}`, async () => {
    assert.equal(await flaggedThrough(spelling.setup), spelling.expectFlagged);
  });
}
