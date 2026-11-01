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
import { resolvePersonRef } from "../src/session/persistence/template-owner.js";
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
    const read = await readPeopleFile(path.join(dir, "people.json"));
    assert.deepEqual(read.rows, []);
    assert.deepEqual(read.skipped, []);
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
  const { rows, skipped } = parsePeopleFile("people.json", text);
  assert.deepEqual(skipped, []);
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
    assert.equal((await readPeopleFile(file)).rows.length, 1, "the control: the intact file reads");
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

test("document-level schema violations are errors, each one on its own (C6.2: v is 1; people is an object)", async () => {
  const { laatz } = await konsiqPair();
  const bad: Array<[string, string, RegExp]> = [
    ["not an object", "[]", /not a JSON object/u],
    ["no version", JSON.stringify({ people: {} }), /schema version/u],
    ["a different version", JSON.stringify({ v: 2, people: {} }), /schema version 2/u],
    ["people missing", JSON.stringify({ v: 1 }), /"people"/u],
    ["people an array", JSON.stringify({ v: 1, people: [] }), /"people"/u],
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
  assert.equal(parsePeopleFile("p.json", peopleDocument([laatz])).rows.length, 1);
});

// O4 (brick 509d3884): a ROW the resolver cannot use is skipped and named, never a refusal of the file —
// atrium keeps such a row and serves the rest, and the two readers of one file must agree (C6.3).
test("a row the resolver cannot use is skipped and NAMED, the valid rows are listed, and nothing is repaired (O4)", async () => {
  const { brammertz, laatz } = await konsiqPair();
  const bad: Array<[string, string, unknown, RegExp]> = [
    [
      "a foreign row keyed by a non-id, no id",
      "p-zz-not-an-id",
      { note: "foreign" },
      /invariant I1/u,
    ],
    ["a row whose id is not its key (I1)", "p-0000000000000000000a", laatz, /invariant I1/u],
    ["a row that is not an object", "p-0000000000000000000b", 3, /is not an object/u],
    ["name not a string", laatz.id, { ...laatz, name: 7 }, /name must be a string/u],
    ["handle missing", laatz.id, { ...laatz, handle: undefined }, /handle must be a string/u],
    ["former_handles not strings", laatz.id, { ...laatz, former_handles: [1] }, /former_handles/u],
  ];
  for (const [label, key, row, pattern] of bad) {
    // the bad row sits BETWEEN two valid ones, so a reader that stops at it loses the second
    const document = JSON.stringify({
      v: 1,
      people: {
        [brammertz.id]: brammertz,
        [key]: row,
        ...(key === laatz.id ? {} : { [laatz.id]: laatz }),
      },
    });
    const read = parsePeopleFile("p.json", document);
    assert.equal(read.skipped.length, 1, label);
    assert.equal(read.skipped[0].key, key, label);
    assert.match(read.skipped[0].reason, pattern, label);
    const expected = key === laatz.id ? [brammertz.id] : [brammertz.id, laatz.id];
    assert.deepEqual(
      read.rows.map((r) => r.id),
      expected,
      label,
    );
  }
  // the positive control for the table: the same builder, undamaged, skips nothing
  assert.deepEqual(parsePeopleFile("p.json", peopleDocument([brammertz, laatz])).skipped, []);
});

test("the template reader agrees with the people verbs: a foreign row does not stop a handle from resolving (O4)", async () => {
  await withDir(async (dir) => {
    const { brammertz, laatz } = await konsiqPair();
    const file = path.join(dir, "people.json");
    const saved = process.env.ACPX_PEOPLE_FILE;
    const stderr = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    process.env.ACPX_PEOPLE_FILE = file;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await fs.writeFile(
        file,
        JSON.stringify({
          v: 1,
          people: { [brammertz.id]: brammertz, "p-zz-template-case": { x: 1 }, [laatz.id]: laatz },
        }),
        "utf8",
      );
      assert.equal(await resolvePersonRef("laatz", { acceptUnlistedId: false }), laatz.id);
      assert.ok(
        written.join("").includes('"p-zz-template-case"'),
        "the skipped row is named on stderr by this reader too",
      );
      // the negative: a document it cannot read is still a refusal, not an empty list
      await fs.writeFile(file, "{not json", "utf8");
      await assert.rejects(resolvePersonRef("laatz", { acceptUnlistedId: false }), /unreadable/u);
    } finally {
      process.stderr.write = stderr;
      if (saved === undefined) {
        delete process.env.ACPX_PEOPLE_FILE;
      } else {
        process.env.ACPX_PEOPLE_FILE = saved;
      }
    }
  });
});

// DISCOVERING, not a hand-kept list: every file under src/ that calls `readPeopleFile(` must also pass what
// it read to `reportSkippedPeopleRows(`, or it would skip a row silently. A fresh reader added later is found
// by the scan with no registration.
test("every reader of the people file reports the rows it skipped (scan of src/)", async () => {
  const root = path.resolve(process.cwd(), "src");
  const sources: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".ts")) {
        sources.push(full);
      }
    }
  }
  await walk(root);
  const readers: string[] = [];
  for (const file of sources) {
    const text = await fs.readFile(file, "utf8");
    if (path.basename(file) === "people-file.ts" || !/\breadPeopleFile\(/u.test(text)) {
      continue;
    }
    readers.push(path.relative(root, file));
    assert.match(text, /\breportSkippedPeopleRows\(/u, `${file} reads the people file`);
  }
  // the scan found the readers it is supposed to find (a scan of nothing proves nothing)
  assert.ok(readers.length >= 3, `found only: ${readers.join(", ")}`);
});

test("an empty people list is valid and is an empty list", () => {
  assert.deepEqual(parsePeopleFile("p.json", JSON.stringify({ v: 1, people: {} })).rows, []);
});
