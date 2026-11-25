import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyArgv, classifyCall } from "../src/pod/command-classes.js";
import { ownTargetRecordId } from "../src/pod/own-target.js";
import { routeFor } from "../src/pod/placement-step.js";
import { agentPodName } from "../src/pod/placement.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// brick 7686016f — `acpx sessions close --seat <child seat> --after-turn` inside an agent pod was refused
// `pass_through_refused … class-not-passable … target-unresolved`: "sessions close" named no `--seat` target flag.
// The conformance row (every verb that registers --seat lists it) lives in test/pod-command-classes.test.ts.

const BUILT_IN = ["claude", "codex", "pi"];
const OWN = "aaaaaaaa-1111-4222-8333-444444444444";
const CHILD = "cccccccc-0000-4000-8000-000000000a99";
const OWN_SEAT = "11111111-1111-4111-8111-111111111111";
const CHILD_SEAT = "22222222-2222-4222-8222-222222222222";
const CLOSED_SEAT = "33333333-3333-4333-8333-333333333333";
const url = (q: string) => `https://atrium.example/?${q}`;

function seatsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-7686-"));
  const row = (holder: string, closedAt: string | null) => ({
    active_holder_id: holder,
    closed_at: closedAt,
  });
  fs.writeFileSync(
    path.join(dir, "seats.json"),
    JSON.stringify({
      [OWN_SEAT]: row(OWN, null),
      [CHILD_SEAT]: row(CHILD, null),
      [CLOSED_SEAT]: row(CHILD, "2026-11-24T10:00:00.000Z"),
    }),
  );
  return dir;
}

function classify(argv: string[]) {
  const c = classifyArgv(argv, { builtInAgents: BUILT_IN });
  assert.equal(c.kind, "classified", JSON.stringify(argv));
  return c.kind === "classified" ? c : (undefined as never);
}

function ownOf(argv: string[], dir: string): string | null {
  const c = classify(argv);
  return ownTargetRecordId(c.target, agentPodName(OWN), dir, {
    path: c.path,
    conflict: c.targetConflict,
  });
}

test("7686 · `sessions close --seat <seat>` classifies WITH a target: the flag `--seat`, the seat value (red on 85fd1875: no target)", () => {
  const c = classify(["sessions", "close", "--seat", CHILD_SEAT, "--after-turn"]);
  assert.equal(c.path, "sessions close");
  assert.deepEqual(c.target, { via: "flag", flag: "--seat", value: CHILD_SEAT });
  const viaUrl = classify(["sessions", "close", "--seat", url(`seat=${CHILD_SEAT}`)]);
  assert.deepEqual(viaUrl.target, {
    via: "flag",
    flag: "--seat",
    value: url(`seat=${CHILD_SEAT}`),
  });
});

test("7686 · the pair: `sessions close --session-id` and the operand form still classify as before", () => {
  assert.deepEqual(classify(["sessions", "close", "--session-id", CHILD]).target, {
    via: "flag",
    flag: "--session-id",
    value: CHILD,
  });
  assert.deepEqual(classify(["sessions", "close", CHILD]).target, { via: "operand", value: CHILD });
});

test("7686 · two selectors are still two: --seat with --session-id (or the operand) is a conflict, as the CLI itself refuses it", () => {
  assert.equal(
    classify(["sessions", "close", "--seat", CHILD_SEAT, "--session-id", CHILD]).targetConflict,
    true,
  );
  assert.equal(classify(["sessions", "close", "--seat", CHILD_SEAT, CHILD]).targetConflict, true);
  assert.equal(classify(["sessions", "close", "--seat", CHILD_SEAT]).targetConflict, false);
});

test("7686 · from a pod: closing ANOTHER session's seat passes through (not own); closing YOUR OWN seat is own (local); a closed seat and a ?session= URL are not own", () => {
  const dir = seatsDir();
  assert.equal(
    ownOf(["sessions", "close", "--seat", CHILD_SEAT], dir),
    null,
    "the child's seat: not own",
  );
  assert.equal(ownOf(["sessions", "close", "--seat", OWN_SEAT, "--after-turn"], dir), OWN);
  assert.equal(
    ownOf(["sessions", "close", "--seat", url(`seat=${OWN_SEAT}`)], dir),
    OWN,
    'close yourself: --seat "$ACPX_SEAT_URL"',
  );
  assert.equal(
    ownOf(["sessions", "close", "--seat", CLOSED_SEAT], dir),
    null,
    "a closed seat names no holder",
  );
  assert.equal(ownOf(["sessions", "close", "--seat", url(`session=${OWN}`)], dir), null);
  assert.equal(
    ownOf(["sessions", "close", "--seat", OWN_SEAT, "--session-id", CHILD], dir),
    null,
    "two selectors: never own",
  );
  // The same near-misses with --session-id (unchanged).
  assert.equal(ownOf(["sessions", "close", "--session-id", OWN], dir), OWN);
  assert.equal(ownOf(["sessions", "close", "--session-id", CHILD], dir), null);
});

test("7686 · the route: another session's close-by-seat from an agent pod is a pass-through; its own is local", () => {
  const dir = seatsDir();
  const route = (argv: string[]) => {
    const c = classify(argv);
    const own = ownTargetRecordId(c.target, agentPodName(OWN), dir, {
      path: c.path,
      conflict: c.targetConflict,
    });
    return routeFor(c.class, own === null ? "other-pod" : "own-pod");
  };
  const other = route(["sessions", "close", "--seat", CHILD_SEAT, "--after-turn"]);
  assert.deepEqual(other, { kind: "branch", branch: "pass-through" });
  assert.deepEqual(route(["sessions", "close", "--seat", OWN_SEAT]), { kind: "local" });
});

test("7686 · atrium's door: classifyCall RESOLVES the seat to the holder's record id, so passability gets a target; an unknown seat stays unresolved", async () => {
  await withTempHome("acpx-7686-call-", async (home) => {
    await writeSessionRecordFile(
      home,
      makeSessionRecord({
        acpxRecordId: CHILD,
        acpSessionId: CHILD,
        agentCommand: "agent",
        cwd: home,
      }),
    );
    const sessions = path.join(home, ".acpx", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "seats.json"),
      JSON.stringify({
        [CHILD_SEAT]: {
          seat_id: CHILD_SEAT,
          created_at: "2026-11-24T10:00:00.000Z",
          active_holder_id: CHILD,
          next_ordinal: 2,
          closed_at: null,
        },
      }),
    );
    const found = await classifyCall(["sessions", "close", "--seat", CHILD_SEAT, "--after-turn"]);
    assert.equal(found.kind === "classified" && found.targetSessionId, CHILD, "the seat's holder");
    const pair = await classifyCall(["sessions", "close", "--session-id", CHILD]);
    assert.equal(pair.kind === "classified" && pair.targetSessionId, CHILD);
    const unknown = await classifyCall([
      "sessions",
      "close",
      "--seat",
      "99999999-9999-4999-8999-999999999999",
    ]);
    assert.equal(unknown.kind === "classified" && unknown.targetSessionId, null);
  });
});
