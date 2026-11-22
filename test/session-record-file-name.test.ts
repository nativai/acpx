import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isSessionRecordFileName } from "../src/session/persistence/session-dir-files.js";

// brick 99bf1c0d — the ONE predicate for "is this name a session record file?", and the conformance rows
// that keep every enumeration of the sessions directory behind it (see test/delivery-json-sidecar.test.ts for
// the behavioural negatives per enumeration).

test("the predicate: `<id>.json` with a dot-free id — uuid, uuidv7, `ses_…` and slug ids alike", () => {
  for (const name of [
    "11111111-aaaa-4aaa-8aaa-111111111111.json",
    "019edbeb-53e3-7a83-a3d0-ab305b914d2a.json", // uuidv7
    "ses_f84bb7041ffeOayX6OGKPn4Elu.json", // real opaque ids on devbox: a uuid test would drop these
    "mid-turn-injection.json", // the archive's slug-id record
  ]) {
    assert.equal(isSessionRecordFileName(name), true, name);
  }
});

test("the predicate NEGATIVES: every sidecar and store that ends in `.json`, and the shapes around them", () => {
  for (const name of [
    "11111111-aaaa-4aaa-8aaa-111111111111.delivery.json", // acpx-ui's delivery store
    "11111111-aaaa-4aaa-8aaa-111111111111.queue.json", // its legacy siblings
    "11111111-aaaa-4aaa-8aaa-111111111111.inflight.json",
    "11111111-aaaa-4aaa-8aaa-111111111111.anything-new.json", // a sidecar nobody has named yet
    "index.json", // acpx's own stores
    "seats.json",
    ".json", // no id part
    "a.b.json",
    "x.json.tmp",
    "x.json.bak-mig-2026-10-06T191739004Z",
    "x.json.123.456.tmp",
    "dir/x.json", // a path, not a bare name
    "..\\x.json",
    "x.JSON.tmp",
    "",
  ]) {
    assert.equal(isSessionRecordFileName(name), false, JSON.stringify(name));
  }
});

// ---- the conformance row: no enumeration falls back to a `.json` suffix test ------------------------------

const SRC = path.resolve("src");

/** Per-file reasons a `.json` filter exists WITHOUT meaning "session record files of the sessions dir". */
const JSON_FILTER_EXEMPT: Readonly<Record<string, string>> = {
  "session/persistence/session-dir-files.ts": "defines the predicate",
  "session/archive/archive-index.ts": "ARCHIVE-INDEX shard names `YYYY-MM.json`",
  "session/persistence/seat-archive.ts":
    "the seat-archive directory (`<seatId>.json`), not the sessions dir",
  "acp/pi-model-knowledge.ts": "derives a sibling path of a cache file",
  "capacity/waiting.ts": "the capacity waiting-queue directory",
  "capacity/governor/notify.ts": "the governor's notification outbox",
  "capacity/governor/record.ts": "the governor's dated log files",
};

/** The `.json`-suffix filter signature: `endsWith(".json")` or a regex ending in `\.json$` — comments skipped. */
const JSON_FILTER = /endsWith\(\s*["'`]\.json["'`]\s*\)|\\\.json\$\/|\.json\$\//u;

function* tsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* tsFiles(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

function codeLines(file: string): string[] {
  return fs
    .readFileSync(file)
    .toString("latin1")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line));
}

/** Files (relative to `root`) holding a `.json` filter that is not exempt — PER OCCURRENCE, so an import of the predicate beside a leftover suffix test does not excuse it. */
export function unexemptJsonFilters(
  root: string,
  exempt: Readonly<Record<string, string>>,
): string[] {
  const found: string[] = [];
  for (const file of tsFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (exempt[relative] === undefined && codeLines(file).some((line) => JSON_FILTER.test(line))) {
      found.push(relative);
    }
  }
  return found.toSorted();
}

test("CONFORMANCE: no file under src/ filters on a `.json` suffix except the listed non-sessions-dir ones — discovered, per occurrence", () => {
  assert.deepEqual(unexemptJsonFilters(SRC, JSON_FILTER_EXEMPT), []);
  // every exemption is a real filter site (a stale entry would silently widen the exemption)
  for (const exempted of Object.keys(JSON_FILTER_EXEMPT)) {
    assert.ok(
      codeLines(path.join(SRC, exempted)).some((line) => JSON_FILTER.test(line)),
      `stale exemption: ${exempted}`,
    );
  }
});

test("CONFORMANCE NEGATIVE: a fresh enumerator with a suffix filter is flagged without being registered anywhere, even beside an import of the predicate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-dj-conformance-"));
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(
    path.join(root, "nested", "fresh-enumerator.ts"),
    'import { isSessionRecordFileName } from "../session-dir-files.js";\nexport const names = (all: string[]) => all.filter((n) => n.endsWith(".json"));\n',
  );
  fs.writeFileSync(path.join(root, "regex-filter.ts"), "export const shape = /^[^.]+\\.json$/u;\n");
  fs.writeFileSync(
    path.join(root, "clean.ts"),
    'export const ok = (n: string) => n.endsWith(".ndjson");\n// a comment may say endsWith(".json")\n',
  );
  assert.deepEqual(unexemptJsonFilters(root, {}), [
    "nested/fresh-enumerator.ts",
    "regex-filter.ts",
  ]);
  assert.deepEqual(unexemptJsonFilters(root, { "regex-filter.ts": "x" }), [
    "nested/fresh-enumerator.ts",
  ]);
});

// ---- the inventory of readdir sites: each is either a record enumerator behind the predicate or says why not ----

/** Files under src/ that call readdir/opendir (generated: `grep -rlE "readdir(Sync)?\\(|opendir(Sync)?\\("`), and what each lists. */
const READDIR_INVENTORY: Readonly<
  Record<string, { records: true } | { records: false; lists: string }>
> = {
  "session/persistence/index.ts": { records: true },
  "session/archive/retention.ts": { records: true },
  "cli/transcripts-dedup.ts": { records: true },
  "session/persistence/repository.ts": {
    records: false,
    lists: "per-id stream-file lookups (delete/prune), by id prefix",
  },
  "session/persistence/seat-archive.ts": {
    records: false,
    lists: "the seat-archive dir; a Set of hot names for existence checks",
  },
  "session/persistence/identity-file-lock.ts": { records: false, lists: "lock directories" },
  "session/archive/archive-index.ts": { records: false, lists: "ARCHIVE-INDEX shards" },
  "session/archive/compression-reconcile.ts": {
    records: false,
    lists: "archive dir, claimed to ids by longest prefix",
  },
  "session/archive/compress-sweep.ts": {
    records: false,
    lists: "archive/hot dir claimed to ids by longest prefix; COMPRESSION dir",
  },
  "session/archive/operations.ts": {
    records: false,
    lists: "archive dir claimed to ids by longest prefix; archive measurement",
  },
  "session/archive/thaw.ts": {
    records: false,
    lists: "archive dir claimed to ids by longest prefix",
  },
  "cli/session/agent-folders-migrate.ts": {
    records: false,
    lists: "the agent-folders tree (the sessions dir through listSessionRecordFiles)",
  },
  "cli/session/owner-exit-transcript-reap.ts": { records: false, lists: "/proc" },
  "config/transcript-dedup.ts": { records: false, lists: "transcript directories and /proc" },
  "acp/claude-fork-index.ts": { records: false, lists: "the claude subagents directory" },
  "acp/harness-config-dir.ts": { records: false, lists: "harness config/holder directories" },
  "capacity/governor/notify.ts": { records: false, lists: "the governor outbox" },
  "capacity/governor/record.ts": { records: false, lists: "the governor log dir" },
  "capacity/governor/run.ts": { records: false, lists: "the governor queue dir" },
  "capacity/governor/scan.ts": { records: false, lists: "/proc" },
  "capacity/leases.ts": { records: false, lists: "capacity leases and /proc" },
  "capacity/ledger.ts": { records: false, lists: "the capacity log dir" },
  "capacity/waiting.ts": { records: false, lists: "the capacity waiting dir" },
  "pod/routed-call.ts": { records: false, lists: "the routed-call payload dir" },
  "process-population.ts": { records: false, lists: "/proc" },
  "process-tree-reap.ts": { records: false, lists: "/proc" },
  "session/scratch-reaper.ts": { records: false, lists: "session scratch directories" },
};

const READDIR = /\b(?:readdir|readdirSync|opendir|opendirSync)\(/u;

export function readdirFiles(root: string): string[] {
  return [...tsFiles(root)]
    .filter((file) => codeLines(file).some((line) => READDIR.test(line)))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .toSorted();
}

test("CONFORMANCE: every file under src/ that lists a directory is classified — a new one must say whether it lists session records", () => {
  assert.deepEqual(readdirFiles(SRC), Object.keys(READDIR_INVENTORY).toSorted());
});

test("CONFORMANCE: a classified record enumerator really uses the predicate (and the readdir inventory flags a fresh file)", () => {
  for (const [file, entry] of Object.entries(READDIR_INVENTORY)) {
    if (entry.records) {
      assert.match(
        fs.readFileSync(path.join(SRC, file), "utf8"),
        /\bisSessionRecordFileName\b/u,
        `${file} enumerates session records without isSessionRecordFileName`,
      );
    }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-dj-readdir-"));
  fs.writeFileSync(
    path.join(root, "fresh.ts"),
    'import fs from "node:fs";\nexport const all = (d: string) => fs.readdirSync(d);\n',
  );
  assert.deepEqual(readdirFiles(root), ["fresh.ts"]);
});
