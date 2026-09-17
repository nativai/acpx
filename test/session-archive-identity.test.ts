import assert from "node:assert/strict";
import test from "node:test";
import {
  claimArchiveFileSets,
  claimFileSets,
  claimOrphanFileSets,
  findRecordFile,
  hasActiveSidecar,
  isDeliveryFamilyFile,
  isHostileFileName,
  isRecordWriteArtifact,
  recordFileNameFor,
} from "../src/session/archive/identity.js";

/**
 * Cold-archive tier — identity and file-set claiming (conception
 * `archive-formats.md` §1 R1.4, §2).
 *
 * ⚠️ WHY THESE EXIST AT ALL. Every behavioural guarantee this feature has lived,
 * until now, in a brick-level rig that CI will never run — so a green suite said
 * nothing about `src/session/archive/*` and the next person to touch it would get
 * a silent pass. These target the invariants a refactor breaks SILENTLY, not
 * coverage: each one below is a case that was measured wrong at least once, by an
 * implementation or a spec, during this feature's construction.
 *
 * Envelope-independent by construction: pure functions and in-memory string
 * arrays only. No live agent, no network, no real store — so they pass on a
 * freshly-wiped workbench.
 */

const UUID_A = "0027b16c-7b7a-4e26-a50f-381299ff59ba";
const UUID_B = "5fe6b660-6cec-4016-ab30-e7ea573b8cd2";
/** A real opencode id shape. 18 such id groups are live on devbox. */
const SES_ID = "ses_f84bb7041ffeOayX6OGKPn4Elu";

test("claiming: a delivery sidecar's token must never out-claim the real id", () => {
  // ⚠️ THE BUG THIS PINS COST A RESTORE-SIDE DATA LOSS, and both lanes reached
  // for the same wrong shape independently. `<id>.delivery.json` ends in `.json`,
  // so a candidate set built from filenames mints the pseudo-token
  // `<id>.delivery` — which is LONGER than `<id>` and therefore wins the
  // longest-prefix rule and steals the file from its own session. Measured
  // consequence: three orphans archived WITH their delivery sidecar restored
  // WITHOUT it, the file left stranded in the archive with nothing pointing at
  // it. It passed the plan check, the applied-directory check and `--verify`.
  const files = [`${UUID_A}.json`, `${UUID_A}.delivery.json`, `${UUID_A}.messages.ndjson`];
  const claimed = claimArchiveFileSets(files);

  assert.deepEqual(
    claimed.get(UUID_A)?.toSorted(),
    files.toSorted(),
    "all three files must belong to the one real id",
  );
  assert.equal(
    claimed.has(`${UUID_A}.delivery`),
    false,
    "`<id>.delivery` must never appear as an id of its own",
  );
});

test("claiming: an orphan's delivery sidecar travels with it (no record present)", () => {
  // The same trap, in the shape it actually occurred: a record-less id, where
  // there is no `<id>.json` to anchor the candidate set at all.
  const files = [`${UUID_A}.delivery.json`, `${UUID_A}.messages.ndjson`];
  const claimed = claimArchiveFileSets(files);
  assert.deepEqual(claimed.get(UUID_A)?.toSorted(), files.toSorted());
});

test("claiming: longest prefix wins when one real id is a strict prefix of another", () => {
  // ⚠️ Zero live specimens; catchable only here and in the rig. A naive match
  // hands the longer id's files to the shorter session.
  const base = UUID_A;
  const sub = `${UUID_A}.sub`;
  const files = [`${base}.json`, `${sub}.json`, `${sub}.stream.ndjson`, `${base}.stream.ndjson`];

  const { claimed } = claimFileSets(files, new Set([base, sub]));
  assert.deepEqual(claimed.get(base)?.toSorted(), [`${base}.json`, `${base}.stream.ndjson`]);
  assert.deepEqual(claimed.get(sub)?.toSorted(), [`${sub}.json`, `${sub}.stream.ndjson`]);
});

test("claiming: an id may itself contain dots, including a literal `.stream.`", () => {
  // acpx's own `indexStreamFilesBySafeId` guards this case with a named
  // regression test ("a safeId may itself contain `.stream.`"). A first-dot split
  // attributes every file below to the pseudo-id "agent".
  const dotted = "agent.stream.probe-7";
  const files = [`${dotted}.json`, `${dotted}.stream.ndjson`, `${dotted}.timestamps.ndjson`];
  const { claimed, unclaimed } = claimFileSets(files, new Set([dotted]));
  assert.deepEqual(claimed.get(dotted)?.toSorted(), files.toSorted());
  assert.deepEqual(unclaimed, []);
});

test("reserved names are decided by LITERAL R1.4 name, never by id shape", () => {
  // The two live devbox ids that escape archiving BY ACCIDENT rather than by
  // design, plus the deletion manifest — which is the sharp one: `idOf` yields
  // `deletions`, no `deletions.json` record exists, and an `--orphans` policy
  // would sweep acpx's own prune audit trail into the archive.
  const reserved = [
    "index.json",
    "index.json.lock",
    "index.json.4242.1757000000000.tmp",
    "brick-remote-links.json",
    "deletions.ndjson",
    "MANIFEST.tsv",
    "README.md",
  ];
  const { orphans, ignored } = claimOrphanFileSets(reserved);
  assert.equal(orphans.size, 0, "no reserved name may become an orphan id");
  assert.deepEqual(ignored.toSorted(), reserved.toSorted());
});

test("a `ses_*` opencode id IS archivable — a uuid-only regex leaves 18 live sessions hot forever", () => {
  const { orphans } = claimOrphanFileSets([`${SES_ID}.messages.ndjson`, `${SES_ID}.stream.ndjson`]);
  assert.deepEqual(orphans.get(SES_ID)?.toSorted(), [
    `${SES_ID}.messages.ndjson`,
    `${SES_ID}.stream.ndjson`,
  ]);
});

test("archive-side reading is LENIENT: an arbitrary-slug id still resolves", () => {
  // ⚠️ THE STRICT-INGEST / LENIENT-READ ASYMMETRY (formats §2 C2.4), and an
  // implementer reaches for symmetry by instinct. `mid-turn-injection` is a
  // legacy codex record with no uuid and no `ses_` prefix that is ALREADY in the
  // production archive. A reader enforcing the hot-dir id shape would drop it
  // from the list, fail to resolve it, and leave it unrestorable in plain sight.
  const slug = "mid-turn-injection";
  const claimed = claimArchiveFileSets([`${slug}.json`, `${slug}.messages.ndjson`]);
  assert.deepEqual(claimed.get(slug)?.toSorted(), [`${slug}.json`, `${slug}.messages.ndjson`]);
});

test("archive-side reading still refuses the literal reserved names", () => {
  // Lenient on ID SHAPE is not lenient on everything: the archive legitimately
  // holds its own MANIFEST.tsv, and that must never read as a session.
  const claimed = claimArchiveFileSets(["MANIFEST.tsv", "README.md", `${UUID_B}.json`]);
  assert.deepEqual([...claimed.keys()], [UUID_B]);
});

test("record presence is the one orphan test, and it is exact", () => {
  assert.equal(recordFileNameFor(UUID_A), `${UUID_A}.json`);
  assert.equal(findRecordFile(UUID_A, [`${UUID_A}.json`]), `${UUID_A}.json`);
  // A delivery sidecar is NOT a record — this is the distinction whose loss
  // makes a complete session degrade into residue.
  assert.equal(findRecordFile(UUID_A, [`${UUID_A}.delivery.json`]), undefined);
});

test("the active-sidecar predicate matches the three exact suffixes, not the family", () => {
  assert.equal(hasActiveSidecar(UUID_A, [`${UUID_A}.delivery.json`]), true);
  assert.equal(hasActiveSidecar(UUID_A, [`${UUID_A}.queue.json`]), true);
  assert.equal(hasActiveSidecar(UUID_A, [`${UUID_A}.inflight.json`]), true);
  assert.equal(hasActiveSidecar(UUID_A, [`${UUID_A}.messages.ndjson`]), false);
  // A stale base64 delivery LOCK is in the family but is not itself an active
  // sidecar: it must not permanently block an id whose delivery is long gone.
  assert.equal(hasActiveSidecar(UUID_A, [`${UUID_A}.delivery.json.YWJj.delivery.lock`]), false);
});

test("the delivery FAMILY is broader than the blocker, and that is deliberate", () => {
  // Used only to EXCLUDE mtimes from T4's age anchor, never to block.
  assert.equal(isDeliveryFamilyFile(UUID_A, `${UUID_A}.delivery.json.YWJj.delivery.lock`), true);
  assert.equal(isDeliveryFamilyFile(UUID_A, `${UUID_A}.queue.json`), true);
  assert.equal(isDeliveryFamilyFile(UUID_A, `${UUID_A}.messages.ndjson`), false);
});

test("record-write artifacts are an EXCLUSION, which is why `.json.<pid>.<ts>.tmp` is caught", () => {
  // ⚠️ 49 orphan ids carry a record-write temp. A "transcript sidecars only"
  // ALLOWLIST misses them by omission rather than by rule; an exclusion catches
  // them. This is the measurement that dissolved the allowlist question.
  assert.equal(isRecordWriteArtifact(UUID_A, `${UUID_A}.json`), true);
  assert.equal(isRecordWriteArtifact(UUID_A, `${UUID_A}.json.4242.1757000000000.tmp`), true);
  assert.equal(isRecordWriteArtifact(UUID_A, `${UUID_A}.json.bak-mig-20260101`), true);
  assert.equal(isRecordWriteArtifact(UUID_A, `${UUID_A}.messages.ndjson`), false);
});

test("hostile filenames are detected so they can be REFUSED, never escaped", () => {
  // `MANIFEST.tsv`'s `file` column round-trips UNESCAPED — a restore reads it
  // back as a path — so escaping would silently break restore. ext4 permits all
  // three bytes in a filename.
  assert.equal(isHostileFileName(`${UUID_A}.messages\t.ndjson`), true);
  assert.equal(isHostileFileName(`${UUID_A}.messages\r.ndjson`), true);
  assert.equal(isHostileFileName(`${UUID_A}.messages\n.ndjson`), true);
  assert.equal(isHostileFileName(`${UUID_A}.messages.ndjson`), false);
});
