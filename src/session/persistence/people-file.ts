/**
 * The box's people list, read offline (PERSON-CONTRACT v3.1 C6; brick b0968426).
 *
 * `<state>/.acpx/people.json`, written ONLY by atrium (C6.3). acpx is a reader: it never creates, repairs
 * or rewrites the file. `<state>` is the root rule the session store already uses
 * (`ACPX_STATE_HOME || os.homedir()`, `sessionBaseDir`); `ACPX_PEOPLE_FILE` overrides the path for tests
 * and devN slots (C6.1).
 *
 * An ABSENT file is an empty list. An unreadable, unparseable or malformed one is an ERROR carrying the
 * cause, never an empty list: the resolver fails loud by design (C4), and "nobody is registered" would
 * make every addressing attempt read as "unknown person" instead of "the list is broken".
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PersonListEntry } from "./person.js";
import { isPersonId } from "./person.js";

/** A people list that cannot be read as the C6.2 schema. The message says which file and why. */
export class PeopleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeopleFileError";
  }
}

/** One row as the file holds it: the fields the resolver reads, and every other key kept as it was. */
export type PeopleFileRow = PersonListEntry & {
  last_seen_at?: string;
  [extra: string]: unknown;
};

export function peopleFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ACPX_PEOPLE_FILE?.trim();
  if (override) {
    return override;
  }
  return path.join(env.ACPX_STATE_HOME || os.homedir(), ".acpx", "people.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function violation(file: string, what: string): PeopleFileError {
  return new PeopleFileError(`${file}: ${what}`);
}

function requireString(file: string, key: string, raw: Record<string, unknown>, field: string) {
  if (typeof raw[field] !== "string") {
    throw violation(file, `people.${key}.${field} must be a string`);
  }
}

function rowFrom(file: string, key: string, raw: unknown): PeopleFileRow {
  if (!isRecord(raw)) {
    throw violation(file, `people.${key} is not an object`);
  }
  // I1: each key is the row's id. A reader reports a violation and never repairs it.
  if (!isPersonId(raw.id) || raw.id !== key) {
    throw violation(file, `people.${key}.id must be the row's key, a person id (invariant I1)`);
  }
  requireString(file, key, raw, "name");
  requireString(file, key, raw, "handle");
  const former = raw.former_handles;
  if (
    former !== undefined &&
    !(Array.isArray(former) && former.every((h) => typeof h === "string"))
  ) {
    throw violation(file, `people.${key}.former_handles must be an array of strings`);
  }
  return raw as PeopleFileRow;
}

/** Parses the document; throws {@link PeopleFileError} on anything but a C6.2 v1 file. */
export function parsePeopleFile(file: string, text: string): PeopleFileRow[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw violation(file, `not valid JSON (${cause}) — the file is left untouched`);
  }
  if (!isRecord(document)) {
    throw violation(file, "the document is not a JSON object");
  }
  // I6: `v` is 1. A different value is a breaking change under a new file name (C6.2), so refuse it.
  if (document.v !== 1) {
    throw violation(file, `unsupported schema version ${JSON.stringify(document.v)} (expected 1)`);
  }
  if (!isRecord(document.people)) {
    throw violation(file, '"people" is missing or is not an object');
  }
  return Object.entries(document.people).map(([key, raw]) => rowFrom(file, key, raw));
}

/**
 * Every row of the people file, in file order. Absent file → `[]`. Anything else that stops the file
 * being read — a permission error, a directory in its place, a bad document — throws
 * {@link PeopleFileError}.
 */
export async function readPeopleFile(file: string = peopleFilePath()): Promise<PeopleFileRow[]> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw violation(file, `cannot be read (${cause})`);
  }
  return parsePeopleFile(file, text);
}
