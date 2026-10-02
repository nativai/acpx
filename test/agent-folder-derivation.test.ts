import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { deriveAgentFolders } from "../src/cli/session/agent-folder.js";

// C7 (brick 09197f03) acceptance row 2 — ONE SHARED FIXTURE, byte-identical in acpx and acpx-ui.
//
// "Both repos read one derivation" is realised across two repos with no shared package by pinning the
// SAME fixture file in each repo to the SAME sha256 and running every case through each repo's own
// derivation. Changing either copy of the fixture without the other reds the sha row in the repo that
// was not changed; changing either derivation reds the case rows. The acpx-ui copy lives at
// `brick/module/__fixtures__/agent-folder-derivation.fixture.json` — `server/index-lock.ts` is the
// existing precedent for hand-kept cross-repo parity. Change one, change both.
const FIXTURE_PATH = path.resolve(
  process.cwd(),
  "test/fixtures/agent-folder-derivation.fixture.json",
);
const FIXTURE_SHA256 = "9f510bae7cdeb0282917471b6e5b703c02d87eff9c42e0bf1e4c0d18e8b60707";

type FixtureCase = {
  name: string;
  brickPath: string;
  sessionId: string;
  seatId: string | null;
  agentFolder: string;
  seatFolder: string | null;
};

function readFixture(): { bytes: Buffer; cases: FixtureCase[] } {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  const parsed = JSON.parse(bytes.toString("utf8")) as { cases: FixtureCase[] };
  return { bytes, cases: parsed.cases };
}

test("the shared C7 fixture is byte-identical to the pinned acpx-ui copy (sha256)", () => {
  const { bytes } = readFixture();
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    FIXTURE_SHA256,
    "agent-folder-derivation.fixture.json changed — re-copy it byte-for-byte into acpx-ui's " +
      "brick/module/__fixtures__/ and update FIXTURE_SHA256 in BOTH repos' tests",
  );
});

test("the shared C7 fixture still carries a seated case and a seat-less case (it cannot be emptied)", () => {
  const { cases } = readFixture();
  assert.ok(cases.length >= 4, `fixture has ${cases.length} cases`);
  assert.ok(cases.some((c) => c.seatFolder !== null));
  assert.ok(cases.some((c) => c.seatFolder === null));
});

test("every shared-fixture case derives the SAME LITERAL path (rows 1, 2, 4)", () => {
  const { cases } = readFixture();
  for (const fixtureCase of cases) {
    assert.deepEqual(
      deriveAgentFolders({
        brickPath: fixtureCase.brickPath,
        sessionId: fixtureCase.sessionId,
        seatId: fixtureCase.seatId,
      }),
      { agentFolder: fixtureCase.agentFolder, seatFolder: fixtureCase.seatFolder },
      `case "${fixtureCase.name}"`,
    );
  }
});

test("a seat-less input (seatId absent) derives the id-only full-uuid folder and NEVER a seat path", () => {
  const derived = deriveAgentFolders({
    brickPath: "/tmp/pool/b3",
    sessionId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  });
  assert.deepEqual(derived, {
    agentFolder: "/tmp/pool/b3/agents/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    seatFolder: null,
  });
});

test("the derivation takes no name input: the same ids give the same path whatever the session is called", () => {
  // The derivation's input type has no `name`; smuggling one in through a wider object must change nothing.
  const base = {
    brickPath: "/tmp/pool/b4",
    sessionId: "aaaaaaaa-1111-4222-8333-444444444444",
    seatId: "bbbbbbbb-5555-4666-8777-888888888888",
  };
  const renamed = { ...base, name: "A completely different name" } as typeof base;
  assert.deepEqual(deriveAgentFolders(renamed), deriveAgentFolders(base));
  assert.equal(
    deriveAgentFolders(renamed).agentFolder,
    "/tmp/pool/b4/agents/bbbbbbbb/holders/aaaaaaaa",
  );
});
