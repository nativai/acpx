import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PeopleFileError,
  parsePeopleFile,
  peopleFilePath,
  readPeopleFile,
} from "../src/session/persistence/people-file.js";
import { konsiqPair, peopleDocument } from "./people-test-helpers.js";

// PERSON-CONTRACT C6.1 (where the file is) and C6.3 (readers: an absent file is an empty list, an
// unreadable one is an error to the caller, never "empty").

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-people-file-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("C6.1: <state>/.acpx/people.json with the session store's root rule; ACPX_PEOPLE_FILE overrides it", () => {
  assert.equal(
    peopleFilePath({ ACPX_STATE_HOME: "/state", HOME: "/home/x" }),
    "/state/.acpx/people.json",
  );
  assert.equal(
    peopleFilePath({ HOME: os.homedir() }),
    path.join(os.homedir(), ".acpx", "people.json"),
  );
  assert.equal(
    peopleFilePath({ ACPX_STATE_HOME: "/state", ACPX_PEOPLE_FILE: "/elsewhere/p.json" }),
    "/elsewhere/p.json",
  );
  // a blank override is no override
  assert.equal(
    peopleFilePath({ ACPX_STATE_HOME: "/state", ACPX_PEOPLE_FILE: "   " }),
    "/state/.acpx/people.json",
  );
});

test("an absent file is an empty list", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readPeopleFile(path.join(dir, "people.json")), []);
  });
});

test("rows come back in file order with every unknown key kept (readers never repair or drop)", async () => {
  const { brammertz, laatz } = await konsiqPair();
  const text = JSON.stringify({
    v: 1,
    future_top_level: { a: 1 },
    people: {
      [brammertz.id]: { ...brammertz, future_row_key: "kept" },
      [laatz.id]: { ...laatz, telegram: { user_id: 5, future: true } },
    },
  });
  const rows = parsePeopleFile("people.json", text);
  assert.deepEqual(
    rows.map((row) => row.handle),
    ["brammertz", "laatz"],
  );
  assert.equal(rows[0].future_row_key, "kept");
  assert.deepEqual(rows[1].telegram, { user_id: 5, future: true });
});

test("a valid file truncated by one byte is an error naming the file, never an empty list (committed negative)", async () => {
  await withDir(async (dir) => {
    const { laatz } = await konsiqPair();
    const good = peopleDocument([laatz]);
    const file = path.join(dir, "people.json");
    await fs.writeFile(file, good, "utf8");
    assert.equal((await readPeopleFile(file)).length, 1, "the control: the intact file reads");
    await fs.writeFile(file, good.slice(0, -1), "utf8");
    await assert.rejects(readPeopleFile(file), (error: unknown) => {
      assert.ok(error instanceof PeopleFileError);
      assert.ok(error.message.includes(file), error.message);
      assert.match(error.message, /not valid JSON/u);
      return true;
    });
  });
});

test("an unreadable file (a directory in its place) is an error, not an empty list", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "people.json");
    await fs.mkdir(file);
    await assert.rejects(readPeopleFile(file), PeopleFileError);
  });
});

test("schema violations are reported, each one on its own (C6.2: v is 1; rows keyed by their own id)", async () => {
  const { laatz } = await konsiqPair();
  const bad: Array<[string, string, RegExp]> = [
    ["not an object", "[]", /not a JSON object/u],
    ["no version", JSON.stringify({ people: {} }), /schema version/u],
    ["a different version", JSON.stringify({ v: 2, people: {} }), /schema version 2/u],
    ["people missing", JSON.stringify({ v: 1 }), /"people"/u],
    ["people an array", JSON.stringify({ v: 1, people: [] }), /"people"/u],
    ["row not an object", JSON.stringify({ v: 1, people: { [laatz.id]: 3 } }), /not an object/u],
    [
      "key differs from the row's id (I1)",
      JSON.stringify({ v: 1, people: { "p-0000000000000000000a": laatz } }),
      /invariant I1/u,
    ],
    [
      "name not a string",
      JSON.stringify({ v: 1, people: { [laatz.id]: { ...laatz, name: 7 } } }),
      /name must be a string/u,
    ],
    [
      "handle missing",
      JSON.stringify({ v: 1, people: { [laatz.id]: { ...laatz, handle: undefined } } }),
      /handle must be a string/u,
    ],
    [
      "former_handles not strings",
      JSON.stringify({ v: 1, people: { [laatz.id]: { ...laatz, former_handles: [1] } } }),
      /former_handles/u,
    ],
  ];
  for (const [label, text, pattern] of bad) {
    assert.throws(
      () => parsePeopleFile("p.json", text),
      (error: unknown) => {
        assert.ok(error instanceof PeopleFileError, label);
        assert.match(error.message, pattern, label);
        return true;
      },
      label,
    );
  }
  // the positive control for the whole table: the same builder, undamaged, parses
  assert.equal(parsePeopleFile("p.json", peopleDocument([laatz])).length, 1);
});

test("an empty people list is valid and is an empty list", () => {
  assert.deepEqual(parsePeopleFile("p.json", JSON.stringify({ v: 1, people: {} })), []);
});
