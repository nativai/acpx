import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { isPersonId } from "../src/session/persistence/person.js";
import {
  isVisibleTemplateKey,
  parseNameKey,
  personNameKey,
} from "../src/session/persistence/template-name-key.js";
import { fixtureIdRow } from "./people-test-helpers.js";

// TEMPLATES CONCEPTION §4.1 — the name-key grammar is an irreversible contract, mirrored byte for byte by
// acpx-ui (`server/templateNameKey.ts`, build block T2). The module and its vectors are PINNED, so the
// mirror cannot drift without one of the two repos' tests going red.
//   acpx-ui: server/templateNameKey.ts · server/__fixtures__/template-name-key.vectors.json · its test
//   acpx:    src/session/persistence/template-name-key.ts · test/fixtures/template-name-key.vectors.json · this file
// Changing either means changing both copies to the same bytes and updating BOTH digests in BOTH tests.
const SOURCE_PATH = path.resolve(process.cwd(), "src/session/persistence/template-name-key.ts");
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/template-name-key.vectors.json");
// ---- everything below this line is the same in both repos' name-key tests ----
const TEMPLATE_NAME_KEY_TS_SHA256 =
  "b5514204dbc07ffca56f1a21cc600e87f6f7db91ba59a3ce008e1e819c35f67c";
const TEMPLATE_NAME_KEY_FIXTURE_SHA256 =
  "d3c2e1ec49e92237179bd1803357df20bc92e6d40a9a80239ef7081871b93dba";

const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface Vectors {
  machine: string[];
  person: Array<{ key: string; personId: string; base: string }>;
  invalid: string[];
  visibility: Array<{ key: string | null; person: string | null; visible: boolean }>;
}

const vectors = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as Vectors;
const LAATZ = "p-fb566154c0bf245b7538"; // PERSON-CONTRACT C1.6 V2
const BASE_64 = `${"a".repeat(31)}-${"b".repeat(32)}`;

test("the name-key module and its vectors are the pinned text (sha256) — the same bytes as the other repo's copies", () => {
  assert.equal(
    sha256Of(fs.readFileSync(SOURCE_PATH)),
    TEMPLATE_NAME_KEY_TS_SHA256,
    "template-name-key.ts changed — make the same edit in acpx-ui server/templateNameKey.ts and update the digest in BOTH tests",
  );
  assert.equal(
    sha256Of(fs.readFileSync(FIXTURE_PATH)),
    TEMPLATE_NAME_KEY_FIXTURE_SHA256,
    "the vectors changed — a grammar change is a contract change; edit both repos' copies and BOTH digests",
  );
});

test("the pin check reports a mismatch for a copy that differs by one byte (in code, and in a comment)", () => {
  const original = fs.readFileSync(SOURCE_PATH, "utf8");
  const code = "const PERSON_ID_PATTERN = /^p-[0-9a-f]{20}$/;";
  assert.ok(original.includes(code), "the code line this case edits is gone — update the case");
  assert.notEqual(
    sha256Of(Buffer.from(original.replace(code, code.replace("20", "21")))),
    TEMPLATE_NAME_KEY_TS_SHA256,
  );
  assert.notEqual(sha256Of(Buffer.from(`${original} `)), TEMPLATE_NAME_KEY_TS_SHA256);
  assert.notEqual(
    sha256Of(Buffer.from(`${fs.readFileSync(FIXTURE_PATH, "utf8")} `)),
    TEMPLATE_NAME_KEY_FIXTURE_SHA256,
  );
});

test("parseNameKey: a canonical base with no `/` is machine-wide", () => {
  for (const key of vectors.machine) {
    assert.deepEqual(parseNameKey(key), { owner: "machine", base: key });
  }
  assert.ok(vectors.machine.includes(BASE_64));
});

test("parseNameKey: `<person-id>/<base>` is that person's, up to the 87-byte maximum", () => {
  for (const row of vectors.person) {
    assert.deepEqual(parseNameKey(row.key), {
      owner: "person",
      personId: row.personId,
      base: row.base,
    });
  }
  const widest = personNameKey(LAATZ, BASE_64);
  assert.equal(Buffer.byteLength(widest), 87);
  assert.ok(vectors.person.some((row) => row.key === widest));
});

test("parseNameKey: everything else is INVALID and never machine-wide (ruling B15)", () => {
  for (const key of vectors.invalid) {
    assert.deepEqual(parseNameKey(key), { owner: "invalid", raw: key }, JSON.stringify(key));
  }
  for (const notAString of [undefined, null, 5, {}, ["reviewer"]]) {
    assert.equal(parseNameKey(notAString).owner, "invalid");
  }
});

test("parseNameKey's person-id pattern agrees with person.ts isPersonId on every vector", async () => {
  const fixtureIds = await Promise.all((["V1", "V2", "V3"] as const).map(fixtureIdRow));
  const candidates = [
    ...fixtureIds.map((row) => row.id),
    LAATZ,
    "p-0123456789abcdef0123",
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
  for (const row of vectors.visibility) {
    assert.equal(
      isVisibleTemplateKey(row.key ?? undefined, row.person ?? undefined),
      row.visible,
      JSON.stringify(row),
    );
  }
});
