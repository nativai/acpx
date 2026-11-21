import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyArgv } from "../src/pod/command-classes.js";
import { ownTargetRecordId } from "../src/pod/own-target.js";
import { decidePlacement } from "../src/pod/placement-step.js";
import { agentPodName } from "../src/pod/placement.js";

// brick 7eb9686f, R2-a (LOW, from the A1 re-test, VERIFICATION.md "RE-TEST @ 36f869df"): `own-target`
// answered "own" on INEXACT evidence in 8 shapes. The pass-through now depends on that answer, so
// each shape is a negative row here: an input right in every respect but the one the clause
// protects, asserted NOT own — plus the exact positive each one is the near-miss of.

const BUILT_IN = ["claude", "codex", "pi"];
const OWN = "aaaaaaaa-1111-4222-8333-444444444444";
const OTHER = "cccccccc-0000-4000-8000-000000000a99";
const OWN_SEAT = "11111111-1111-4111-8111-111111111111";
const OTHER_SEAT = "22222222-2222-4222-8222-222222222222";
const CLOSED_SEAT = "33333333-3333-4333-8333-333333333333";
const POD = agentPodName(OWN);

function sessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-own-target-"));
  fs.writeFileSync(
    path.join(dir, "seats.json"),
    JSON.stringify({
      [OWN_SEAT]: { active_holder_id: OWN, closed_at: null },
      [OTHER_SEAT]: { active_holder_id: OTHER, closed_at: null },
      [CLOSED_SEAT]: { active_holder_id: OWN, closed_at: "2026-11-21T10:00:00.000Z" },
    }),
  );
  return dir;
}

/** The own-session answer for an argv, through the REAL classifier — what the placement step asks. */
function ownOf(argv: string[], dir: string): string | null {
  const c = classifyArgv(argv, { builtInAgents: BUILT_IN });
  assert.equal(c.kind, "classified");
  if (c.kind !== "classified") {
    return null;
  }
  return ownTargetRecordId(c.target, POD, dir, { path: c.path, conflict: c.targetConflict });
}

const url = (query: string) => `https://atrium.example/?${query}`;

test("R2-a positives: the exact shapes still answer OWN (the rows below are their near-misses)", () => {
  const dir = sessionsDir();
  assert.equal(ownOf(["status", "--session-id", OWN], dir), OWN);
  assert.equal(ownOf(["status", "--session-url", url(`session=${OWN}`)], dir), OWN);
  assert.equal(ownOf(["status", "--session-url", url(`seat=${OWN_SEAT}`)], dir), OWN);
  assert.equal(ownOf(["status", "--seat", OWN_SEAT], dir), OWN);
  assert.equal(ownOf(["status", "--seat", url(`seat=${OWN_SEAT}`)], dir), OWN);
  // The same flag twice: the LAST wins in acpx's resolver and in the classifier — exact, not a conflict.
  assert.equal(ownOf(["status", "--session-id", OTHER, "--session-id", OWN], dir), OWN);
  // `people set-owner --session <id|url>` is the one command where `--session` is an id.
  assert.equal(ownOf(["people", "set-owner", "x", "--session", OWN], dir), OWN);
});

test("R2-a shape 1: a CLOSED seat names no holder — not own", () => {
  const dir = sessionsDir();
  assert.equal(ownOf(["status", "--seat", CLOSED_SEAT], dir), null);
  assert.equal(ownOf(["status", "--session-url", url(`seat=${CLOSED_SEAT}`)], dir), null);
  // The same seat row, open, is the exact positive: closed_at is what decides.
  const open = sessionsDir();
  assert.equal(ownOf(["status", "--seat", OWN_SEAT], open), OWN);
});

test("R2-a shape 2: a URL carrying BOTH ?session and ?seat — not own, either way round", () => {
  const dir = sessionsDir();
  assert.equal(
    ownOf(["status", "--session-url", url(`session=${OTHER}&seat=${OWN_SEAT}`)], dir),
    null,
  );
  assert.equal(
    ownOf(["status", "--session-url", url(`seat=${OTHER_SEAT}&session=${OWN}`)], dir),
    null,
  );
});

test("R2-a shape 3: two DIFFERENT selector flags — not own, in every pairing and order", () => {
  const dir = sessionsDir();
  const urlOther = url(`session=${OTHER}`);
  for (const argv of [
    ["status", "--session-id", OWN, "--session-url", urlOther],
    ["status", "--session-url", urlOther, "--session-id", OWN],
    ["status", "--session-id", OWN, "--seat", OTHER_SEAT],
    ["status", "--seat", OTHER_SEAT, "--session-id", OWN],
    ["status", "--session-id", OWN, "--seat", OWN_SEAT],
  ]) {
    assert.equal(ownOf(argv, dir), null, argv.join(" "));
  }
});

test("R2-a shape 4: a URL as the value of --session-id — not own (a URL is for --session-url / --seat)", () => {
  const dir = sessionsDir();
  assert.equal(ownOf(["status", "--session-id", url(`session=${OWN}`)], dir), null);
});

test("R2-a shape 5: -s and --session are session NAMES off the people commands — not own", () => {
  const dir = sessionsDir();
  assert.equal(ownOf(["status", "-s", OWN], dir), null);
  assert.equal(ownOf(["status", "--session", OWN], dir), null);
  assert.equal(ownOf(["prompt", "-s", OWN, "hi"], dir), null);
});

test("R2-a: a conflict is a classification fact, so the placement step PASSES THE COMMAND THROUGH", () => {
  const dir = sessionsDir();
  const podFile = { kind: "pod", name: POD } as const;
  const verdict = { mode: "pod" } as const;
  const route = (argv: string[]) => {
    const d = decidePlacement({
      argv,
      verdict,
      podFile,
      builtInAgents: BUILT_IN,
      ownTarget: (c) =>
        ownTargetRecordId(c.target, POD, dir, { path: c.path, conflict: c.targetConflict }),
    });
    return d.kind === "branch" ? d.branch : d.kind;
  };
  // `cancel` is owner-if-pod: own → local; anything inexact → pass-through, where acpx's resolver refuses.
  assert.equal(route(["cancel", "--session-id", OWN]), "local");
  assert.equal(route(["cancel", "--session-id", OWN, "--seat", OTHER_SEAT]), "pass-through");
  assert.equal(route(["cancel", "--seat", CLOSED_SEAT]), "pass-through");
  assert.equal(route(["cancel", "-s", OWN]), "pass-through");
});

test("R2-a: the classifier counts selectors by name, so a repeated flag is not a conflict", () => {
  const same = classifyArgv(["status", "--session-id", "a", "--session-id", "b"], {
    builtInAgents: BUILT_IN,
  });
  const two = classifyArgv(["status", "--session-id", "a", "--seat", "b"], {
    builtInAgents: BUILT_IN,
  });
  assert.equal(same.kind === "classified" && same.targetConflict, false);
  assert.equal(two.kind === "classified" && two.targetConflict, true);
});
