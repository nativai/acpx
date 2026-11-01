import assert from "node:assert/strict";
import test from "node:test";
import { isPersonId } from "../src/session/persistence/person.js";
import {
  isVisibleTemplateKey,
  parseNameKey,
  personNameKey,
} from "../src/session/persistence/template-name-key.js";
import { fixtureIdRow } from "./people-test-helpers.js";

// TEMPLATES CONCEPTION §4.1 — the name-key grammar is an irreversible contract, mirrored byte for byte by
// acpx-ui (`server/templateNameKey.ts`, build block T2). These vectors are the ones T2's mirror must pass.

const LAATZ = "p-fb566154c0bf245b7538"; // PERSON-CONTRACT C1.6 V2
const BRAMMERTZ_LIKE = "p-0123456789abcdef0123";
const BASE_64 = `${"a".repeat(31)}-${"b".repeat(32)}`;

test("parseNameKey: a canonical base with no `/` is machine-wide", () => {
  for (const key of ["reviewer", "intaker", "tmpl-wave-child-relay", "a", "a1-b2", "9", BASE_64]) {
    assert.deepEqual(parseNameKey(key), { owner: "machine", base: key });
  }
  assert.equal(BASE_64.length, 64);
});

test("parseNameKey: `<person-id>/<base>` is that person's, up to the 87-byte maximum", () => {
  assert.deepEqual(parseNameKey(`${LAATZ}/reviewer`), {
    owner: "person",
    personId: LAATZ,
    base: "reviewer",
  });
  const widest = personNameKey(LAATZ, BASE_64);
  assert.equal(Buffer.byteLength(widest), 87);
  assert.deepEqual(parseNameKey(widest), { owner: "person", personId: LAATZ, base: BASE_64 });
});

test("parseNameKey: everything else is INVALID and never machine-wide (ruling B15)", () => {
  const invalid = [
    "", // empty
    "/",
    "/reviewer", // empty owner
    `${LAATZ}/`, // empty base
    `${LAATZ}/reviewer/x`, // more than one `/`
    "a/b/c",
    "!!bad/reviewer", // AC15's hand edit
    "laatz/reviewer", // a handle is a TYPED form; it is never stored
    `P-${LAATZ.slice(2)}/reviewer`, // uppercase prefix
    `p-${LAATZ.slice(2).toUpperCase()}/reviewer`, // uppercase hex
    `p-${LAATZ.slice(2)}0/reviewer`, // 21 hex
    `p-${LAATZ.slice(2, -1)}/reviewer`, // 19 hex
    `${LAATZ}/Reviewer`, // non-canonical base
    `${LAATZ}/re viewer`,
    `${LAATZ}/${"a".repeat(65)}`, // base over 64
    "Reviewer", // a plain key must be canonical too
    "-reviewer",
    "reviewer-",
    "re--viewer",
    "re_viewer",
    " reviewer",
    "reviewer\n",
    "a".repeat(65),
  ];
  for (const key of invalid) {
    assert.equal(parseNameKey(key).owner, "invalid", JSON.stringify(key));
  }
  for (const notAString of [undefined, null, 5, {}, ["reviewer"]]) {
    assert.equal(parseNameKey(notAString).owner, "invalid");
  }
  assert.deepEqual(parseNameKey("a/b/c"), { owner: "invalid", raw: "a/b/c" });
});

test("parseNameKey's person-id pattern agrees with person.ts isPersonId on every vector", async () => {
  const fixtureIds = await Promise.all((["V1", "V2", "V3"] as const).map(fixtureIdRow));
  const candidates = [
    ...fixtureIds.map((row) => row.id),
    LAATZ,
    BRAMMERTZ_LIKE,
    "p-",
    "p-0123456789abcdef012",
    "p-0123456789abcdef01234",
    "p-0123456789ABCDEF0123",
    "p-0123456789abcdef012g",
    "q-0123456789abcdef0123",
    " p-0123456789abcdef0123",
    "p-0123456789abcdef0123\n",
    "reviewer",
  ];
  for (const candidate of candidates) {
    const asKey = parseNameKey(`${candidate}/reviewer`);
    assert.equal(asKey.owner === "person", isPersonId(candidate), JSON.stringify(candidate));
  }
});

test("isVisibleTemplateKey: machine-wide plus the caller's own; nobody else's; no person ⇒ machine only", () => {
  const mine = personNameKey(LAATZ, "reviewer");
  const theirs = personNameKey(BRAMMERTZ_LIKE, "reviewer");
  assert.equal(isVisibleTemplateKey("reviewer", LAATZ), true);
  assert.equal(isVisibleTemplateKey("reviewer", undefined), true);
  assert.equal(
    isVisibleTemplateKey(undefined, LAATZ),
    true,
    "a slug-less legacy template is id-only, machine-wide",
  );
  assert.equal(isVisibleTemplateKey(mine, LAATZ), true);
  assert.equal(
    isVisibleTemplateKey(mine, undefined),
    false,
    "a bare shell never sees a personal template",
  );
  assert.equal(isVisibleTemplateKey(theirs, LAATZ), false);
  assert.equal(isVisibleTemplateKey("!!bad/reviewer", LAATZ), false);
  assert.equal(isVisibleTemplateKey("Weird Name", LAATZ), false);
});
