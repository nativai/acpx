import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readWaiting, WAITING_FRESH_MS, waitingDirOf } from "../src/capacity/waiting.js";

// brick e8abe1e8 — the waiting dir's contract (CONCEPTION §3.2.3, §5; schema in the header of
// src/capacity/waiting.ts). The shared fixture is the ONE body both repos test against: acpx-ui
// copies it byte-identical, so a schema drift on either side reds here or there.

const FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/capacity/waiting/atrium-example.json", import.meta.url),
);

function admissionDirWith(files: Record<string, string>, mtime?: Date): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-waiting-"));
  fs.mkdirSync(waitingDirOf(dir));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(waitingDirOf(dir), name);
    fs.writeFileSync(file, body);
    if (mtime) {
      fs.utimesSync(file, mtime, mtime);
    }
  }
  return dir;
}

const fixtureBody = (): string => fs.readFileSync(FIXTURE, "utf8");

test("waiting: the shared fixture reads as 2 items, oldest first, with the item fields acpx shows", () => {
  const queue = readWaiting(admissionDirWith({ "atrium-3f9c2a1e.json": fixtureBody() }));
  assert.equal(queue.count, 2);
  assert.deepEqual(queue.items, [
    {
      key: "wakeup:wk_0f3d9b2c",
      kind: "wakeup",
      ref: "wk_0f3d9b2c",
      label: "re-baker-2026-10-31",
      harness: "claude",
      since: "2026-10-31T01:00:00.000Z",
    },
    {
      key: "trigger-run:3f2a1c7e-5b8d-4e21-9a0f-6c1d2e3b4a59",
      kind: "trigger-run",
      ref: "3f2a1c7e-5b8d-4e21-9a0f-6c1d2e3b4a59",
      label: "Implement X",
      harness: "codex",
      since: "2026-10-31T01:02:30.000Z",
    },
  ]);
});

test("waiting: two writers' files are summed and merged in since order", () => {
  const second = JSON.stringify({
    schema: 1,
    writer: "rig",
    writtenAt: new Date().toISOString(),
    items: [{ key: "wakeup:rig-1", kind: "wakeup", ref: "rig-1", since: "2026-10-31T01:01:00Z" }],
  });
  const queue = readWaiting(
    admissionDirWith({ "atrium-3f9c2a1e.json": fixtureBody(), "rig.json": second }),
  );
  assert.equal(queue.count, 3);
  assert.deepEqual(
    queue.items.map((item) => item.ref),
    ["wk_0f3d9b2c", "rig-1", "3f2a1c7e-5b8d-4e21-9a0f-6c1d2e3b4a59"],
  );
});

test("NEGATIVE waiting: a file older than 5 min is ignored — a dead writer fails open", () => {
  const now = new Date();
  const stale = new Date(now.getTime() - WAITING_FRESH_MS - 1_000);
  assert.equal(readWaiting(admissionDirWith({ "a.json": fixtureBody() }, stale), now).count, 0);
  // Control: the SAME file, 4 min old, counts.
  const fresh = new Date(now.getTime() - 4 * 60_000);
  assert.equal(readWaiting(admissionDirWith({ "a.json": fixtureBody() }, fresh), now).count, 2);
});

test("NEGATIVE waiting: a file dated in the FUTURE is ignored, so a clock step cannot hold agents back forever", () => {
  const now = new Date();
  const future = new Date(now.getTime() + 60_000);
  assert.equal(readWaiting(admissionDirWith({ "a.json": fixtureBody() }, future), now).count, 0);
});

test("NEGATIVE waiting: malformed files are ignored as a whole (fail open)", () => {
  const body = JSON.parse(fixtureBody()) as Record<string, unknown>;
  const dir = admissionDirWith({
    "not-json.json": "{ this is not json",
    "other-schema.json": JSON.stringify({ ...body, schema: 2 }),
    "no-items.json": JSON.stringify({ ...body, items: "two" }),
    "array.json": "[]",
  });
  assert.equal(readWaiting(dir).count, 0);
});

test("NEGATIVE waiting: an item without string key/kind/ref is skipped; its valid siblings still count", () => {
  const body = JSON.parse(fixtureBody()) as { items: unknown[] };
  const items = [...body.items, { kind: "wakeup", ref: "no-key" }, "a string", null];
  const queue = readWaiting(admissionDirWith({ "a.json": JSON.stringify({ ...body, items }) }));
  assert.equal(queue.count, 2);
});

test("waiting: unknown keys are tolerated, top level and per item", () => {
  const body = JSON.parse(fixtureBody()) as { items: Array<Record<string, unknown>> };
  for (const item of body.items) {
    Object.assign(item, { priority: 3, extra: ["x"] });
  }
  const extended = { ...body, futureTopLevel: { anything: true } };
  assert.equal(readWaiting(admissionDirWith({ "a.json": JSON.stringify(extended) })).count, 2);
});

test("waiting: only *.json is read — a writer's temp file never counts", () => {
  const dir = admissionDirWith({ "atrium.json.1234.tmp": fixtureBody(), "atrium.json~": "x" });
  assert.equal(readWaiting(dir).count, 0);
});

test("waiting: no waiting dir at all is an empty queue", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-waiting-none-"));
  assert.deepEqual(readWaiting(dir), { count: 0, items: [] });
});
