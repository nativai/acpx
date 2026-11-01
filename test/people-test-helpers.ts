import fs from "node:fs/promises";
import path from "node:path";
import { personIdOf } from "../src/session/persistence/person.js";

// The two people of the shared fixture (PERSON-CONTRACT C1.6 V1 and V2), as rows of a C6.2 people.json.
// The ids are COMPUTED from the fixture's issuer and subject by the module under pin, so a row here can
// never carry an id the contract does not give it.
type FixtureIdRow = { label: string; issuer: string; subject: string; id: string };
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/person.fixture.json");

export type PeopleRow = {
  id: string;
  issuer: string;
  subject: string;
  name: string;
  handle: string;
  former_handles: string[];
  first_seen_at: string;
  last_seen_at: string;
  telegram: Record<string, unknown>;
};

export async function fixtureIdRow(label: "V1" | "V2" | "V3"): Promise<FixtureIdRow> {
  const fixture = JSON.parse(await fs.readFile(FIXTURE_PATH, "utf8")) as { ids: FixtureIdRow[] };
  const row = fixture.ids.find((entry) => entry.label === label);
  if (!row) {
    throw new Error(`fixture has no ${label}`);
  }
  return row;
}

export function personRow(base: FixtureIdRow, name: string, handle: string): PeopleRow {
  const id = personIdOf({
    kind: "human",
    verified: true,
    issuer: base.issuer,
    subject: base.subject,
  });
  if (id !== base.id) {
    throw new Error(`fixture row ${base.label} does not hash to its own id`);
  }
  return {
    id,
    issuer: base.issuer,
    subject: base.subject,
    name,
    handle,
    former_handles: [],
    first_seen_at: "2026-10-14T15:20:00Z",
    last_seen_at: "2026-10-17T21:58:00Z",
    telegram: {},
  };
}

/** Brammertz (V1) and Laatz (V2): konsiq's pair, `brammertz` and `laatz` (CONCEPTION §5.2). */
export async function konsiqPair(): Promise<{ brammertz: PeopleRow; laatz: PeopleRow }> {
  return {
    brammertz: personRow(await fixtureIdRow("V1"), "Daniel Brammertz", "brammertz"),
    laatz: personRow(await fixtureIdRow("V2"), "Daniel Laatz", "laatz"),
  };
}

/** A C6.2 document. No trailing newline, so truncating its last byte always breaks the JSON. */
export function peopleDocument(
  rows: readonly PeopleRow[],
  extra: Record<string, unknown> = {},
): string {
  const people: Record<string, PeopleRow> = {};
  for (const row of rows) {
    people[row.id] = row;
  }
  return JSON.stringify({ v: 1, people, ...extra });
}
