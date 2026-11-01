import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  RESERVED_HANDLES,
  handleCandidates,
  isPersonId,
  isValidHandle,
  matchRef,
  personIdOf,
  type PersonListEntry,
} from "../src/session/persistence/person.js";

// P0 (brick 7c69df5c) — the person module, ONE TEXT AND ONE FIXTURE in acpx-ui and acpx.
//
// Both repos pin `person.ts` and `person.fixture.json` to the same sha256 and run every case below through
// their own copy. Changing either file in only one repo reds the digest row in the repo you did not touch.
// Changing a pinned file means changing both copies to the same bytes, updating BOTH digests in BOTH
// repos' tests, and (for the fixture, a contract change) going through the programme lead.
//   acpx-ui: shared/person.ts · shared/__fixtures__/person.fixture.json · shared/person.test.ts
//   acpx:    src/session/persistence/person.ts · test/fixtures/person.fixture.json · test/person.test.ts
const SOURCE_PATH = path.resolve(process.cwd(), "src/session/persistence/person.ts");
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/person.fixture.json");
// ---- everything below this line is the same in both repos' person tests ----
const PERSON_TS_SHA256 = "61dbd0575cec8b02c80b2de63f1c63b4286f957d8e3e0d9c63787e074ee33d9b";
const FIXTURE_SHA256 = "898ab29f987ae27a40c9b29775de1886fb090bc863575dab330765870853b032";

interface IdRow {
  label: string;
  how: string;
  issuer: string;
  subject: string;
  id: string;
  sha256?: string;
}
interface HandleRow {
  name: string;
  issuer: string;
  subject: string;
  id: string;
  taken: string[];
  expect: string;
}
interface TelegramRow {
  label: string;
  how: string;
  actor: unknown;
  id: string | null;
}
interface Fixture {
  ids: IdRow[];
  not_ids: { label: string; values: string[] };
  telegram_actors: TelegramRow[];
  handles: HandleRow[];
}

const sha256Of = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const readFixture = (): Fixture => JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const human = (issuer: string, subject: string) => ({
  kind: "human",
  channel: "web",
  verified: true,
  issuer,
  subject,
});
const take = (generator: Generator<string, void, undefined>, count: number): string[] => {
  const out: string[] = [];
  for (const candidate of generator) {
    out.push(candidate);
    if (out.length >= count) {
      break;
    }
  }
  return out;
};
const firstFree = (name: string, id: string, taken: readonly string[]): string => {
  for (const candidate of handleCandidates(name, id)) {
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
  throw new Error("handleCandidates ended");
};

const V1 = "p-9df6e3afab610ff30d1a";
const V2 = "p-fb566154c0bf245b7538";
const SOME_ID = "p-0123456789abcdef0123";

// ---------------------------------------------------------------------------
// The mirror and the fixture are pinned (P0-1, P0-2)
// ---------------------------------------------------------------------------

/** What the pin check reports for a buffer: `null` when it is the pinned text, else the mismatch message. */
const mirrorMismatch = (bytes: Buffer): string | null => {
  const actual = sha256Of(bytes);
  return actual === PERSON_TS_SHA256
    ? null
    : `person.ts digest ${actual} is not the pinned ${PERSON_TS_SHA256}`;
};

test("person.ts is the pinned text (sha256) — the same bytes as the other repo's copy", () => {
  assert.equal(
    mirrorMismatch(fs.readFileSync(SOURCE_PATH)),
    null,
    "person.ts changed — make the same edit in the other repo's copy (acpx-ui shared/person.ts <-> acpx " +
      "src/session/persistence/person.ts) and update PERSON_TS_SHA256 in BOTH person tests",
  );
});

test("the pin check reports a mismatch for a copy that differs by one byte in a code line (and in a comment)", () => {
  const original = fs.readFileSync(SOURCE_PATH, "utf8");
  const code = ": `p-${sha256Hex(`${dns.issuer}\\n${dns.subject}`).slice(0, 20)}`;";
  assert.ok(original.includes(code), "the code line this case edits is gone — update the case");
  const changedCode = Buffer.from(
    original.replace(code, code.replace("slice(0, 20)", "slice(0, 21)")),
  );
  assert.match(mirrorMismatch(changedCode) ?? "", /not the pinned/);
  const changedComment = Buffer.from(original.replace("FROZEN CROSS-REPO", "FROZEN CROSS-REPA"));
  assert.match(mirrorMismatch(changedComment) ?? "", /not the pinned/);
  assert.equal(mirrorMismatch(Buffer.from(original)), null, "the unedited copy still passes");
});

test("person.fixture.json is the pinned file (sha256) and holds the rows the plan counts", () => {
  assert.equal(
    sha256Of(fs.readFileSync(FIXTURE_PATH)),
    FIXTURE_SHA256,
    "person.fixture.json changed — copy it byte-for-byte into the other repo and update FIXTURE_SHA256 in " +
      "BOTH person tests (and tell the programme lead: the fixture is the contract's vectors)",
  );
  const fixture = readFixture();
  const idRows = fixture.ids.length + 1; // V1-V3 and N1-N7, plus the N8 row
  console.log(
    `person fixture: ${idRows} id rows (V1-V3, N1-N7, N8: ${fixture.not_ids.values.length} strings), ` +
      `${fixture.handles.length} handle rows`,
  );
  assert.deepEqual(
    fixture.ids.map((row) => row.label),
    ["V1", "V2", "V3", "N1", "N2", "N3", "N4", "N5", "N6", "N7"],
  );
  assert.equal(fixture.not_ids.label, "N8");
  assert.equal(idRows, 11);
  assert.deepEqual(
    fixture.telegram_actors.map((row) => row.label),
    ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"],
  );
  assert.equal(fixture.handles.length, 9);
});

// ---------------------------------------------------------------------------
// C1 · person id
// ---------------------------------------------------------------------------

test("C1.1/C1.6: V1-V3 give the listed ids (and the sha256 the contract lists), computed by an independent hash", () => {
  const rows = readFixture().ids.filter((row) => row.label.startsWith("V"));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const actor = human(row.issuer, row.subject);
    assert.equal(personIdOf(actor), row.id, row.label);
    const digest = createHash("sha256")
      .update(`${row.issuer}\n${row.subject}`, "utf8")
      .digest("hex");
    assert.equal(`p-${digest.slice(0, 20)}`, row.id, `${row.label}: node:crypto agrees`);
    assert.equal(digest, row.sha256, `${row.label}: full digest`);
  }
  assert.deepEqual(
    rows.map((row) => row.id),
    [V1, V2, "p-cb72b9ef849cac8723cb"],
  );
});

test("C1.6 negatives: N1-N7 are well-formed but each gives the listed DIFFERENT id", () => {
  const all = readFixture().ids;
  const negatives = all.filter((row) => row.label.startsWith("N"));
  const listed: Record<string, string> = {
    N1: "p-482dc2f510c67eef32f0",
    N2: "p-230813b5190c13d06ea8",
    N3: "p-cd0f4ad9047f7f9b47a2",
    N4: "p-24a61ebf78cf8f018b46",
    N5: "p-3c316f7eb3710280931e",
    N6: "p-85ab0b45a5ad7e9e06c3",
    N7: "p-61a9aa7410516922385d",
  };
  assert.equal(negatives.length, 7);
  for (const row of negatives) {
    const id = personIdOf(human(row.issuer, row.subject));
    assert.equal(id, listed[row.label], row.label);
    assert.ok(isPersonId(id), `${row.label} is itself a well-formed id`);
  }
  const ids = all.map((row) => personIdOf(human(row.issuer, row.subject)));
  assert.equal(new Set(ids).size, ids.length, "no two vectors share an id");
  // each negative differs from V2 (or, for N6, from V1 and V2) in exactly the property C1.1 fixes
  const v2 = all.find((row) => row.label === "V2");
  assert.ok(v2);
  for (const row of negatives.filter((candidate) => candidate.label !== "N6")) {
    assert.notEqual(personIdOf(human(row.issuer, row.subject)), V2, row.label);
  }
});

test("C1.1: issuer and subject are not normalised — no trim, no case-folding, no re-ordering", () => {
  const issuer = "C=DE,O=NativAI,CN=konsiq-dev-ca";
  const subject = "C=DE,O=NativAI,CN=Daniel Laatz";
  assert.equal(personIdOf(human(issuer, subject)), V2);
  assert.notEqual(personIdOf(human(` ${issuer}`, subject)), V2);
  assert.notEqual(personIdOf(human(issuer, `${subject} `)), V2);
  assert.notEqual(personIdOf(human(issuer.toLowerCase(), subject)), V2);
  assert.notEqual(personIdOf(human(issuer, subject.toUpperCase())), V2);
  assert.notEqual(personIdOf(human(issuer, subject)), personIdOf(human(subject, issuer)));
});

test("C1.1: the pure SHA-256 equals node:crypto at every padding boundary and on non-ASCII text", () => {
  const issuer = "C=DE,O=NativAI,CN=CA";
  const subjects = [
    ...Array.from({ length: 200 }, (_, length) => "x".repeat(length + 1)),
    "李雷",
    "J\u00fcrgen \u0141\u00f3d\u017a",
    "\u{1F600}\u{1F4A9}",
    "a\u0000b",
    "lone \ud800 surrogate",
    "é".repeat(70),
  ];
  const nodeId = (message: string): string =>
    `p-${createHash("sha256").update(message, "utf8").digest("hex").slice(0, 20)}`;
  for (const subject of subjects) {
    assert.equal(
      personIdOf(human(issuer, subject)),
      nodeId(`${issuer}\n${subject}`),
      JSON.stringify(subject),
    );
  }
  for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128]) {
    const longIssuer = "i".repeat(length);
    assert.equal(
      personIdOf(human(longIssuer, "s")),
      nodeId(`${longIssuer}\ns`),
      `issuer length ${length}`,
    );
  }
});

test("C1.6 N8: the three lookalike strings are not ids — no padding, case-folding or prefix match", () => {
  const { not_ids } = readFixture();
  assert.deepEqual(not_ids.values, [
    "p_fb566154c0bf245b7538",
    "P-FB566154C0BF245B7538",
    "p-fb566154c0",
  ]);
  for (const value of not_ids.values) {
    assert.equal(isPersonId(value), false, value);
  }
  for (const value of [
    `${V2}\n`,
    ` ${V2}`,
    `${V2} `,
    `${V2}0`,
    `p-${V2.slice(2, 21)}`,
    `p-${"g".repeat(20)}`,
    `p-${"A".repeat(20)}`,
    "",
    "p-",
    V2.replace("p-", "p_"),
  ]) {
    assert.equal(isPersonId(value), false, JSON.stringify(value));
  }
  for (const value of [undefined, null, 5, {}, [V2], true]) {
    assert.equal(isPersonId(value), false);
  }
  for (const id of [V1, V2, SOME_ID]) {
    assert.equal(isPersonId(id), true, id);
  }
});

test("C2.1: only a verified human carrying both DNs has an id", () => {
  const issuer = "C=DE,O=NativAI,CN=konsiq-dev-ca";
  const subject = "C=DE,O=NativAI,CN=Daniel Laatz";
  assert.equal(personIdOf(human(issuer, subject)), V2);
  const refused: unknown[] = [
    { kind: "agent", session_id: "s", issuer, subject },
    { kind: "system", component: "wakeups", issuer, subject },
    { kind: "human", channel: "web", verified: false, issuer, subject },
    { kind: "human", channel: "web", issuer, subject },
    { kind: "human", channel: "web", verified: "true", issuer, subject },
    { kind: "human", channel: "web", verified: true, subject },
    { kind: "human", channel: "web", verified: true, issuer },
    { kind: "human", channel: "web", verified: true, issuer: "", subject },
    { kind: "human", channel: "web", verified: true, issuer, subject: "" },
    { kind: "human", channel: "web", verified: true, issuer: 1, subject },
    { kind: "Human", verified: true, issuer, subject },
    { kind: "telegram-user", verified: true, issuer, subject },
    {},
    [],
    null,
    undefined,
    "human",
    42,
  ];
  for (const actor of refused) {
    assert.equal(personIdOf(actor), null, JSON.stringify(actor) ?? String(actor));
  }
});

test("Telegram leg (Telegram CONCEPTION 5.5, K7): T1 gives its stored id, T2-T12 give null", () => {
  const rows = readFixture().telegram_actors;
  assert.equal(rows.length, 12);
  for (const row of rows) {
    assert.equal(personIdOf(row.actor), row.id, `${row.label}: ${row.how}`);
  }
  assert.deepEqual(
    rows.filter((row) => row.id !== null).map((row) => row.label),
    ["T1"],
  );
});

test("Telegram leg: the certificate path still wins, and a certificate-less human is a person only by the leg", () => {
  const issuer = "C=DE,O=NativAI,CN=konsiq-dev-ca";
  const subject = "C=DE,O=NativAI,CN=Daniel Laatz";
  const other = "p-0123456789abcdef0123";
  // C2.1: a verified human with both DNs is the hash, even when it also carries a telegram person_id
  assert.equal(
    personIdOf({
      kind: "human",
      channel: "telegram",
      verified: true,
      issuer,
      subject,
      person_id: other,
    }),
    V2,
  );
  // an unverified human with DNs and no telegram channel stays null, whatever else it carries
  assert.equal(
    personIdOf({ kind: "human", channel: "web", verified: false, issuer, subject }),
    null,
  );
  assert.equal(
    personIdOf({ kind: "human", channel: "telegram", verified: false, issuer, subject }),
    null,
    "DNs without a person_id are not a Telegram person",
  );
  // the leg returns the stored id, never a hash of it or of the other fields
  assert.equal(personIdOf({ kind: "human", channel: "telegram", person_id: other }), other);
  const notActors: unknown[] = [null, undefined, "telegram", 42, [], {}];
  for (const actor of notActors) {
    assert.equal(personIdOf(actor), null, JSON.stringify(actor) ?? String(actor));
  }
});

// ---------------------------------------------------------------------------
// C3 · handle grammar and C7.3 reserved words
// ---------------------------------------------------------------------------

test("C3.1: the handle grammar accepts 2-20 lowercase letters/digits/hyphens, letter first, letter or digit last", () => {
  for (const handle of [
    "laatz",
    "dl",
    "a1",
    "a0",
    "daniel-laatz",
    "x-y-z",
    "a".repeat(20),
    "box-2",
  ]) {
    assert.equal(isValidHandle(handle), true, handle);
  }
});

test("C3.1 negatives: each of these is well-formed except the one property the grammar fixes", () => {
  const rejected: [string, string][] = [
    ["laatz]", "a closing bracket"],
    ["l", "one character"],
    ["a".repeat(21), "21 characters"],
    ["daniel_l", "an underscore"],
    [V2, "a person id"],
    ["Laatz", "an uppercase letter (callers lowercase first)"],
    ["-ab", "a leading hyphen"],
    ["ab-", "a trailing hyphen"],
    ["1ab", "a leading digit"],
    ["", "empty"],
    ["ab\n", "a trailing line feed (a `$` that tolerates one is the classic hole)"],
    ["\nab", "a leading line feed"],
    ["ä", "non-ASCII"],
    ["lääz", "non-ASCII inside"],
  ];
  for (const [handle, why] of rejected) {
    assert.equal(isValidHandle(handle), false, `${JSON.stringify(handle)}: ${why}`);
  }
  for (const char of ["[", "]", "·", "/", ":", "_", "@", " ", "\r", "\n", "\t", ".", ","]) {
    assert.equal(isValidHandle(`la${char}tz`), false, `inside: ${JSON.stringify(char)}`);
  }
  for (const value of [undefined, null, 5, {}, ["laatz"]]) {
    assert.equal(isValidHandle(value), false);
  }
});

test("C7.3: RESERVED_HANDLES is exactly the contract's twenty words, immutable, and never a handle", () => {
  assert.deepEqual(
    [...RESERVED_HANDLES],
    [
      "everyone",
      "all",
      "box",
      "machine",
      "system",
      "agent",
      "agents",
      "human",
      "humans",
      "anonymous",
      "unknown",
      "nobody",
      "none",
      "me",
      "you",
      "self",
      "admin",
      "root",
      "person",
      "people",
    ],
  );
  assert.equal(Object.isFrozen(RESERVED_HANDLES), true);
  assert.throws(() => (RESERVED_HANDLES as string[]).push("laatz"), TypeError);
  assert.equal(RESERVED_HANDLES.includes("laatz"), false);
});

test("C7.3: every reserved word is a well-formed handle, so only the explicit check keeps it out of handleCandidates", () => {
  for (const word of RESERVED_HANDLES) {
    assert.equal(
      isValidHandle(word),
      true,
      `${word} has the handle format (isValidHandle is format only)`,
    );
    const named = take(handleCandidates(word[0].toUpperCase() + word.slice(1), SOME_ID), 10);
    assert.equal(named.includes(word), false, `${word} is never offered: ${named.join(",")}`);
    assert.ok(named.length > 0 && named[0].startsWith(`${word}-`), `${word} -> ${named[0]}`);
    const asLastName = take(handleCandidates(`Pat ${word}`, SOME_ID), 10);
    assert.equal(asLastName.includes(word), false, `a family name ${word} is never offered`);
    assert.equal(asLastName[0], `pat-${word}`.slice(0, 20));
  }
});

test("C7.3 positive control: the reserved check is an exact match — boxer and rooted are offered", () => {
  assert.equal(handleCandidates("Boxer", SOME_ID).next().value, "boxer");
  assert.equal(handleCandidates("Rooted", SOME_ID).next().value, "rooted");
  assert.equal(handleCandidates("Everyone Else", SOME_ID).next().value, "else");
});

// ---------------------------------------------------------------------------
// C3.3 · handle derivation
// ---------------------------------------------------------------------------

test("C3.3: every row of the CONCEPTION 5.2 handle table, and each row's id is what its certificate hashes to", () => {
  const rows = readFixture().handles;
  assert.equal(rows.length, 9);
  for (const row of rows) {
    assert.equal(personIdOf(human(row.issuer, row.subject)), row.id, `${row.name}: id`);
    assert.equal(firstFree(row.name, row.id, row.taken), row.expect, row.name);
  }
  const wang = rows.find((row) => row.name === "王伟");
  assert.ok(wang);
  assert.equal(wang.expect, `person-${wang.id.slice(2, 8)}`);
});

test("C3.3: konsiq's pair gets brammertz and laatz in either arrival order; nobody holds daniel", () => {
  const brammertz = V1;
  const laatz = V2;
  assert.equal(firstFree("Daniel Brammertz", brammertz, []), "brammertz");
  assert.equal(firstFree("Daniel Laatz", laatz, ["brammertz"]), "laatz");
  assert.equal(firstFree("Daniel Laatz", laatz, []), "laatz");
  assert.equal(firstFree("Daniel Brammertz", brammertz, ["laatz"]), "brammertz");
});

test("C3.3 negative: a third Daniel Brammertz gets daniel-brammertz — a bare given name is never offered", () => {
  assert.equal(firstFree("Daniel Brammertz", SOME_ID, ["brammertz"]), "daniel-brammertz");
  assert.equal(
    firstFree("Daniel Brammertz", SOME_ID, ["brammertz", "daniel-brammertz"]),
    "daniel-brammertz-2",
  );
  for (const name of [
    "Daniel Brammertz",
    "Daniel Laatz",
    "Anna Maria Schmidt",
    "Dr. Daniel Q. Public",
  ]) {
    assert.equal(take(handleCandidates(name, SOME_ID), 50).includes("daniel"), false, name);
  }
  assert.equal(take(handleCandidates("Cher", SOME_ID), 3).join(","), "cher,cher-2,cher-3");
});

test("C3.3: candidate order is family name, first-last, first-last-2, first-last-3", () => {
  assert.deepEqual(take(handleCandidates("Daniel Laatz", SOME_ID), 4), [
    "laatz",
    "daniel-laatz",
    "daniel-laatz-2",
    "daniel-laatz-3",
  ]);
  assert.deepEqual(take(handleCandidates("Anna Maria Schmidt", SOME_ID), 3), [
    "schmidt",
    "anna-schmidt",
    "anna-schmidt-2",
  ]);
  assert.deepEqual(take(handleCandidates("john.smith", SOME_ID), 2), ["smith", "john-smith"]);
  assert.deepEqual(take(handleCandidates("-Anna- -Lee-", SOME_ID), 2), ["lee", "anna-lee"]);
});

test("C3.3: the name is folded to ASCII before it is split (NFKD, marks dropped, seven extra letters)", () => {
  const cases: [string, string][] = [
    ["Straße", "strasse"],
    ["Æsir", "aesir"],
    ["Søren", "soren"],
    ["Łukasz", "lukasz"],
    ["Đorđe", "dorde"],
    ["Þór", "thor"],
    ["Œuvre", "oeuvre"],
    ["ẞ", "ss"],
    ["Ｊｕｌｉａ", "julia"],
    ["ﬁsher", "fisher"],
    ["Zoë Brontë", "bronte"],
    ["José Ñandú", "nandu"],
    ["Jürgen Müller-Łódź", "muller-lodz"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(handleCandidates(name, SOME_ID).next().value, expected, name);
  }
});

test("C3.3: only the part before an @ is used", () => {
  assert.equal(
    handleCandidates("konsiq-validation@konsiq", SOME_ID).next().value,
    "konsiq-validation",
  );
  assert.equal(handleCandidates("Daniel Laatz@konsiq", SOME_ID).next().value, "laatz");
});

test("C3.3: a name with no usable token gets person-<first 6 hex of the id>, then a numbered series", () => {
  for (const name of ["王伟", "", "   ", "@konsiq", "---", "!!!"]) {
    assert.deepEqual(
      take(handleCandidates(name, SOME_ID), 3),
      ["person-012345", "person-012345-2", "person-012345-3"],
      JSON.stringify(name),
    );
  }
  assert.equal(firstFree("王伟", SOME_ID, ["person-012345"]), "person-012345-2");
});

test("C3.3: a candidate that would be invalid is skipped, never offered (single letter, leading digit)", () => {
  assert.deepEqual(take(handleCandidates("Daniel L", SOME_ID), 2), ["daniel-l", "daniel-l-2"]);
  assert.deepEqual(take(handleCandidates("3M", SOME_ID), 2), ["person-012345", "person-012345-2"]);
  assert.deepEqual(take(handleCandidates("Q", SOME_ID), 2), ["q-2", "q-3"]);
  assert.deepEqual(take(handleCandidates("3M Corp", SOME_ID), 3), ["corp", "corp-2", "corp-3"]);
});

test("C3.3: every candidate is valid, not reserved, at most 20 characters, and never repeats; a suffix is never cut off", () => {
  const names = [
    "Daniel Laatz",
    "Box",
    "Bartholomew Montgomery-Featherstonehaugh",
    "Bartholomew-Montgomery Featherstonehaugh-Smythe",
    "Abcdefghijklmnopqrst Abcdefghijklmnopqrst",
    "aaaaaaaaaaaaaaaaaaa-bbb",
    "Anna Maria Schmidt",
    "王伟",
    "x",
  ];
  for (const name of names) {
    const seen = take(handleCandidates(name, SOME_ID), 120);
    assert.equal(seen.length, 120, name);
    assert.equal(new Set(seen).size, 120, `${name}: unique`);
    for (const candidate of seen) {
      assert.ok(isValidHandle(candidate), `${name}: ${candidate} is valid`);
      assert.ok(candidate.length <= 20, `${name}: ${candidate} <= 20`);
      assert.equal(RESERVED_HANDLES.includes(candidate), false, `${name}: ${candidate}`);
    }
    assert.ok(seen.includes(seen[seen.length - 1]));
    assert.match(
      seen[seen.length - 1],
      /-\d+$/,
      `${name}: the numbered series reaches the end of the stream`,
    );
  }
  assert.equal(handleCandidates("aaaaaaaaaaaaaaaaaaa-bbb", SOME_ID).next().value, "a".repeat(19));
  const long = take(handleCandidates("Bartholomew Montgomery-Featherstonehaugh", SOME_ID), 14);
  assert.equal(long[0].length, 20);
  assert.equal(long[1].length, 20);
  assert.match(long[2], /-2$/);
  assert.match(long[13], /-13$/);
});

test("C3.3: handleCandidates refuses an id that is not a person id, at the call (not at the first next())", () => {
  for (const id of ["", "p-xyz", V2.toUpperCase(), `${V2}\n`, "p_fb566154c0bf245b7538"]) {
    assert.throws(() => handleCandidates("Daniel Laatz", id), TypeError, JSON.stringify(id));
  }
});

// ---------------------------------------------------------------------------
// C4 · matchRef
// ---------------------------------------------------------------------------

const BRAMMERTZ: PersonListEntry = {
  id: V1,
  name: "Daniel Brammertz",
  handle: "brammertz",
  former_handles: [],
};
const LAATZ: PersonListEntry = {
  id: V2,
  name: "Daniel Laatz",
  handle: "laatz",
  former_handles: [],
};
const KONSIQ = [BRAMMERTZ, LAATZ];
const hit = (entry: PersonListEntry) => ({ id: entry.id, name: entry.name, handle: entry.handle });

test("C4.1: an id, a handle, a @handle, any case, and a full name (whitespace collapsed) each reach the one person", () => {
  for (const ref of [
    V2,
    "laatz",
    "LAATZ",
    "Laatz",
    "@laatz",
    "@LAATZ",
    " laatz ",
    "Daniel Laatz",
    "daniel laatz",
    "Daniel  Laatz",
    "DANIEL\tLAATZ",
    " Daniel Laatz ",
  ]) {
    assert.deepEqual(matchRef(KONSIQ, ref), { ok: true, person: hit(LAATZ) }, JSON.stringify(ref));
  }
  assert.deepEqual(matchRef(KONSIQ, "brammertz"), { ok: true, person: hit(BRAMMERTZ) });
});

test("C4.1: the person is exactly {id, name, handle} — a list row's other fields never leak into an answer", () => {
  const rich = {
    ...LAATZ,
    issuer: "C=DE,O=NativAI,CN=konsiq-dev-ca",
    subject: "x",
    telegram: { user_id: 1 },
  };
  const answer = matchRef([rich], "laatz");
  assert.deepEqual(answer, { ok: true, person: hit(LAATZ) });
  const ambiguous = matchRef([rich, { ...rich, id: SOME_ID }], "daniel laatz");
  assert.ok(!ambiguous.ok && ambiguous.error === "ambiguous");
  assert.deepEqual(
    new Set(Object.keys(ambiguous.candidates[0])),
    new Set(["handle", "id", "name"]),
  );
});

test("C4.1 negatives: no prefix, no substring, no first name, no fuzzy match — each is unknown, and suggestions are never chosen", () => {
  const unknown = (ref: string) => {
    const answer = matchRef(KONSIQ, ref);
    assert.ok(
      !answer.ok && answer.error === "unknown",
      `${JSON.stringify(ref)} -> ${JSON.stringify(answer)}`,
    );
    return answer.suggestions;
  };
  assert.deepEqual(unknown("laat"), [hit(LAATZ)]);
  assert.deepEqual(unknown("aat"), [hit(LAATZ)]);
  assert.deepEqual(unknown("daniel"), [hit(BRAMMERTZ), hit(LAATZ)]);
  assert.deepEqual(unknown("Daniel"), [hit(BRAMMERTZ), hit(LAATZ)]);
  assert.deepEqual(unknown("lats"), []);
  assert.deepEqual(unknown("daniel l"), []);
  assert.deepEqual(unknown("laatzz"), []);
  assert.deepEqual(matchRef([LAATZ], "daniel").ok, false);
});

test("C4.1/C4.2: an empty reference is unknown with no suggestions — an empty needle must not match everyone", () => {
  for (const ref of ["", "   ", "@", "\n"]) {
    assert.deepEqual(
      matchRef(KONSIQ, ref),
      { ok: false, error: "unknown", suggestions: [] },
      JSON.stringify(ref),
    );
  }
  assert.deepEqual(matchRef(KONSIQ, undefined as unknown as string), {
    ok: false,
    error: "unknown",
    suggestions: [],
  });
});

test("C4.1/C1.6 N8: an id is matched exactly — an unknown well-formed id says people are per box; lookalikes match nothing", () => {
  assert.deepEqual(matchRef(KONSIQ, SOME_ID), {
    ok: false,
    error: "unknown",
    suggestions: [],
    note: "people are per box",
  });
  for (const lookalike of [
    "p_fb566154c0bf245b7538",
    "P-FB566154C0BF245B7538",
    "p-fb566154c0",
    `${V2}0`,
  ]) {
    const answer = matchRef(KONSIQ, lookalike);
    assert.ok(!answer.ok && answer.error === "unknown", lookalike);
    assert.equal("note" in answer, false, lookalike);
  }
});

test("C4.4: ref@box is never resolved here — other-box, even when the handle exists on this box", () => {
  assert.deepEqual(matchRef(KONSIQ, "laatz@konsiq"), {
    ok: false,
    error: "other-box",
    box: "konsiq",
  });
  assert.deepEqual(matchRef(KONSIQ, "@laatz@konsiq.nativai.de"), {
    ok: false,
    error: "other-box",
    box: "konsiq.nativai.de",
  });
  assert.deepEqual(matchRef(KONSIQ, `${V2}@konsiq`), {
    ok: false,
    error: "other-box",
    box: "konsiq",
  });
  assert.deepEqual(matchRef([], "anyone@devbox"), { ok: false, error: "other-box", box: "devbox" });
  // not box-qualified: nothing on one side of the @
  for (const ref of ["laatz@", "@@x", "@"]) {
    const answer = matchRef(KONSIQ, ref);
    assert.ok(!answer.ok && answer.error === "unknown", ref);
  }
  // a pinned consequence of the frozen rule: a display name with an @ in it is read as box-qualified
  assert.deepEqual(
    matchRef(
      [{ id: SOME_ID, name: "konsiq-validation@konsiq", handle: "konsiq-validation" }],
      "konsiq-validation@konsiq",
    ),
    {
      ok: false,
      error: "other-box",
      box: "konsiq",
    },
  );
});

test("C4.2: two people with one display name are ambiguous, listed in full; their handles still resolve each", () => {
  const second: PersonListEntry = { id: SOME_ID, name: "Daniel Laatz", handle: "daniel-laatz" };
  const list = [LAATZ, second];
  assert.deepEqual(matchRef(list, "Daniel Laatz"), {
    ok: false,
    error: "ambiguous",
    candidates: [hit(LAATZ), hit(second)],
  });
  assert.deepEqual(matchRef(list, "daniel  LAATZ").ok, false);
  assert.deepEqual(matchRef(list, "laatz"), { ok: true, person: hit(LAATZ) });
  assert.deepEqual(matchRef(list, "daniel-laatz"), { ok: true, person: hit(second) });
  assert.deepEqual(matchRef(list, SOME_ID), { ok: true, person: hit(second) });
});

test("C4.2: a list that breaks handle uniqueness is ambiguous, never resolved by picking the first", () => {
  const twin: PersonListEntry = { id: SOME_ID, name: "Someone Else", handle: "laatz" };
  assert.deepEqual(matchRef([LAATZ, twin], "laatz"), {
    ok: false,
    error: "ambiguous",
    candidates: [hit(LAATZ), hit(twin)],
  });
});

test("C4.1/C3.4: a former handle still resolves, with the note `now <handle>`; a current handle outranks anyone's former one", () => {
  const renamed: PersonListEntry = { ...LAATZ, handle: "dl", former_handles: ["laatz"] };
  assert.deepEqual(matchRef([renamed], "laatz"), {
    ok: true,
    person: hit(renamed),
    note: "now dl",
  });
  assert.deepEqual(matchRef([renamed], "@LAATZ"), {
    ok: true,
    person: hit(renamed),
    note: "now dl",
  });
  assert.deepEqual(matchRef([renamed], "dl"), { ok: true, person: hit(renamed) });
  const newcomer: PersonListEntry = { id: SOME_ID, name: "New Person", handle: "laatz" };
  assert.deepEqual(matchRef([renamed, newcomer], "laatz"), { ok: true, person: hit(newcomer) });
  const other: PersonListEntry = {
    id: "p-aaaaaaaaaaaaaaaaaaaa",
    name: "O",
    handle: "oo",
    former_handles: ["laatz"],
  };
  const both = matchRef([renamed, other], "laatz");
  assert.ok(!both.ok && both.error === "ambiguous");
  assert.equal("note" in both, false);
});

test("C4.2: at most five suggestions, in list order; a name token or a handle may contain the input", () => {
  const crowd: PersonListEntry[] = Array.from({ length: 7 }, (_, index) => ({
    id: `p-${String(index).repeat(20)}`,
    name: `Person ${index}`,
    handle: `dan${index}`,
  }));
  const answer = matchRef(crowd, "dan");
  assert.ok(!answer.ok && answer.error === "unknown");
  assert.deepEqual(
    answer.suggestions.map((entry) => entry.handle),
    ["dan0", "dan1", "dan2", "dan3", "dan4"],
  );
  const byToken = matchRef([{ id: SOME_ID, name: "Jürgen Müller", handle: "mueller" }], "ürg");
  assert.ok(!byToken.ok && byToken.error === "unknown" && byToken.suggestions.length === 1);
  assert.deepEqual(
    matchRef([{ id: SOME_ID, name: "Jürgen Müller", handle: "mueller" }], "JÜRGEN müller").ok,
    true,
  );
});

test("C4: matching reads the list as given — an empty list resolves nobody", () => {
  assert.deepEqual(matchRef([], "laatz"), { ok: false, error: "unknown", suggestions: [] });
  assert.deepEqual(matchRef([], V2), {
    ok: false,
    error: "unknown",
    suggestions: [],
    note: "people are per box",
  });
});
