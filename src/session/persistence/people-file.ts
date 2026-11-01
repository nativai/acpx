/**
 * The box's people list, read offline (PERSON-CONTRACT v3.1 C6; brick b0968426).
 *
 * `<state>/.acpx/people.json`, written ONLY by atrium (C6.3). acpx is a reader: it never creates, repairs
 * or rewrites the file. `<state>` is the root rule the session store already uses
 * (`ACPX_STATE_HOME || os.homedir()`, `sessionBaseDir`); `ACPX_PEOPLE_FILE` overrides the path for tests
 * and devN slots (C6.1).
 *
 * An ABSENT file is an empty list. An unreadable, unparseable or malformed DOCUMENT is an ERROR carrying
 * the cause, never an empty list: the resolver fails loud by design (C4), and "nobody is registered" would
 * make every addressing attempt read as "unknown person" instead of "the list is broken".
 *
 * A malformed ROW is not a malformed document. Atrium keeps such a row (C6.3: "carry unknown keys and rows
 * over unchanged") and serves the rest, so acpx does the same: the row is left out of the list, NAMED in
 * `skipped`, and never repaired. Refusing the whole file for one hand-edited row made the two readers of
 * one file disagree (brick 509d3884, O4). The row test is "can the resolver use it": an object keyed by its
 * own person id, with string `name` and `handle`, and string `former_handles` if any.
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

/** A row the reader left out of the list, and why. */
export type SkippedPeopleRow = { key: string; reason: string };

/** The usable rows in file order, and the rows left out (named, never repaired). */
export type PeopleFileRead = {
  file: string;
  rows: PeopleFileRow[];
  skipped: SkippedPeopleRow[];
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

/** Why the resolver cannot use the fields of this keyed object row, or undefined when it can. */
function fieldProblem(key: string, raw: Record<string, unknown>): string | undefined {
  for (const field of ["name", "handle"]) {
    if (typeof raw[field] !== "string") {
      return `people.${key}.${field} must be a string`;
    }
  }
  const former = raw.former_handles;
  if (
    former !== undefined &&
    !(Array.isArray(former) && former.every((h) => typeof h === "string"))
  ) {
    return `people.${key}.former_handles must be an array of strings`;
  }
  return undefined;
}

/** Why the resolver cannot use this row, or undefined when it can. Nothing is repaired. */
function rowProblem(key: string, raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return `people.${key} is not an object`;
  }
  // I1: each key is the row's id.
  if (!isPersonId(raw.id) || raw.id !== key) {
    return `people.${key}.id must be the row's key, a person id (invariant I1)`;
  }
  return fieldProblem(key, raw);
}

/** Parses the document; throws {@link PeopleFileError} on anything but a C6.2 v1 document. */
export function parsePeopleFile(file: string, text: string): PeopleFileRead {
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
  const rows: PeopleFileRow[] = [];
  const skipped: SkippedPeopleRow[] = [];
  for (const [key, raw] of Object.entries(document.people)) {
    const reason = rowProblem(key, raw);
    if (reason === undefined) {
      rows.push(raw as PeopleFileRow);
    } else {
      skipped.push({ key, reason });
    }
  }
  return { file, rows, skipped };
}

const reportedSkips = new Set<string>();

/**
 * Names every skipped row on stderr, once per process and row. EVERY caller of {@link readPeopleFile} passes
 * what it read through here: a reader that dropped the report would skip a row silently, the one thing the
 * skip must not be. `test/people-file.test.ts` finds the callers by scanning `src/` for `readPeopleFile(`.
 */
export function reportSkippedPeopleRows(read: PeopleFileRead): void {
  for (const { key, reason } of read.skipped) {
    const line = `acpx: ${read.file}: skipped row ${JSON.stringify(key)} — ${reason}; left in the file, not listed`;
    if (!reportedSkips.has(line)) {
      reportedSkips.add(line);
      process.stderr.write(`${line}\n`);
    }
  }
}

/**
 * The usable rows of the people file, in file order, with the rows left out. Absent file → no rows.
 * Anything else that stops the file being read — a permission error, a directory in its place, a bad
 * document — throws {@link PeopleFileError}. Pass the result to {@link reportSkippedPeopleRows}.
 */
export async function readPeopleFile(file: string = peopleFilePath()): Promise<PeopleFileRead> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { file, rows: [], skipped: [] };
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw violation(file, `cannot be read (${cause})`);
  }
  return parsePeopleFile(file, text);
}
