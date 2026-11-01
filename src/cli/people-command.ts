/**
 * `acpx people` — the box's people list and "whom does this session work for", read OFFLINE
 * (PERSON-CONTRACT v3.1 C4.3, C8.6; CONCEPTION §4.1; brick b0968426). Read-only: atrium does not need to be
 * running, and no verb here writes `people.json` or a session record.
 *
 *   people list                         exit 0
 *   people resolve <ref>                0 ok · 3 unknown · 4 ambiguous · 5 another box
 *   people principal [--session <id|url>]
 *                                       0 recorded (the principal may be null) · 6 not recorded · 2 unknown session
 *
 * Exit 1 is a people file that cannot be read as the C6.2 schema (never an empty list); exit 2 is a usage
 * error. A single row that cannot be used is not exit 1: it is skipped and named on stderr, as atrium keeps
 * it and serves the rest (`people-file.ts`, brick 509d3884 O4). The matching itself is `matchRef` in `person.ts` (byte-identical with acpx-ui).
 *
 * ⚠️ A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS: this one, and `"people"` in `TOP_LEVEL_VERBS`
 * (`src/cli-core.ts`). Without the second, `acpx people resolve laatz` is absorbed as an AGENT NAME and, in a
 * session-bearing cwd, the rest of the line becomes a prompt delivery.
 */
import type { Command } from "commander";
import { SessionNotFoundError, SessionResolutionError } from "../errors.js";
import {
  PeopleFileError,
  type PeopleFileRow,
  readPeopleFile,
  reportSkippedPeopleRows,
} from "../session/persistence/people-file.js";
import { type MatchResult, type PersonHit, matchRef } from "../session/persistence/person.js";
import { type RecordedPrincipal, recordedPrincipalOf } from "../session/persistence/principal.js";
import { resolveSessionRecord } from "../session/persistence/repository.js";
import { EXIT_CODES } from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { resolveGlobalFlags } from "./flags.js";
import { parseSessionIdFromUrl } from "./session-selector.js";

/** The exit codes of CONCEPTION §4.1. 0/1/2 are the CLI-wide ones; 3–6 are this verb family's own. */
export const PEOPLE_EXIT = {
  OK: EXIT_CODES.SUCCESS,
  ERROR: EXIT_CODES.ERROR,
  USAGE: EXIT_CODES.USAGE,
  UNKNOWN: 3,
  AMBIGUOUS: 4,
  OTHER_BOX: 5,
  NOT_RECORDED: 6,
} as const;

type Printer = {
  json: boolean;
  out(text: string): void;
  err(text: string): void;
};

function printerFor(format: string): Printer {
  return {
    json: format === "json",
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
}

function exitWith(code: number): void {
  if (code !== PEOPLE_EXIT.OK) {
    process.exitCode = code;
  }
}

/** `handle (Name) id` — the one-line form of a person, and of every candidate and suggestion. */
function personLine(person: PersonHit): string {
  return `${person.handle} (${person.name}) ${person.id}`;
}

/** A people file that cannot be read: reported with its cause, exit 1, nothing on stdout. */
async function withPeople(
  printer: Printer,
  run: (rows: PeopleFileRow[]) => void | Promise<void>,
): Promise<void> {
  try {
    const read = await readPeopleFile();
    reportSkippedPeopleRows(read);
    await run(read.rows);
  } catch (error) {
    if (!(error instanceof PeopleFileError)) {
      throw error;
    }
    printer.err(`acpx people: ${error.message}`);
    exitWith(PEOPLE_EXIT.ERROR);
  }
}

function listText(rows: readonly PeopleFileRow[]): string[] {
  const handleWidth = Math.max(...rows.map((row) => row.handle.length));
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  return rows.map((row) => {
    const seen =
      typeof row.last_seen_at === "string" && row.last_seen_at !== "" ? row.last_seen_at : "-";
    return `${row.handle.padEnd(handleWidth)}  ${row.name.padEnd(nameWidth)}  ${row.id}  last seen ${seen}`;
  });
}

function handleList(printer: Printer): Promise<void> {
  return withPeople(printer, (rows) => {
    if (printer.json) {
      printer.out(JSON.stringify(rows));
    } else if (rows.length === 0) {
      printer.err("acpx people: no people are registered on this box");
    } else {
      listText(rows).forEach((line) => printer.out(line));
    }
  });
}

type ResolveFailure = Exclude<MatchResult, { ok: true }>;

function failureCode(answer: ResolveFailure): number {
  switch (answer.error) {
    case "ambiguous":
      return PEOPLE_EXIT.AMBIGUOUS;
    case "other-box":
      return PEOPLE_EXIT.OTHER_BOX;
    default:
      return PEOPLE_EXIT.UNKNOWN;
  }
}

/** The human lines of a failed resolve: a heading, then every candidate or suggestion, one per line. */
function failureLines(ref: string, answer: ResolveFailure): string[] {
  const quoted = JSON.stringify(ref);
  if (answer.error === "other-box") {
    return [`acpx people: ${quoted} names another box (${answer.box}); people are per box`];
  }
  if (answer.error === "ambiguous") {
    return [
      `acpx people: ${quoted} is ambiguous — it matches:`,
      ...answer.candidates.map(personLine),
    ];
  }
  const note = answer.note === undefined ? "" : ` (${answer.note})`;
  const heading = `acpx people: no person matches ${quoted}${note}`;
  return answer.suggestions.length === 0
    ? [heading]
    : [`${heading}; did you mean:`, ...answer.suggestions.map(personLine)];
}

/** The JSON of a failed resolve — the same `{error, …}` bodies the server's `/api/people/resolve` answers. */
function failureJson(answer: ResolveFailure): unknown {
  if (answer.error === "other-box") {
    return { error: "other-box", box: answer.box };
  }
  if (answer.error === "ambiguous") {
    return { error: "ambiguous", candidates: answer.candidates };
  }
  return {
    error: "unknown",
    suggestions: answer.suggestions,
    ...(answer.note === undefined ? {} : { note: answer.note }),
  };
}

function handleResolve(printer: Printer, ref: string): Promise<void> {
  return withPeople(printer, (rows) => {
    const answer = matchRef(rows, ref);
    if (answer.ok) {
      const { person, note } = answer;
      printer.out(
        printer.json
          ? JSON.stringify(note === undefined ? person : { ...person, note })
          : personLine(person),
      );
      if (note !== undefined && !printer.json) {
        printer.err(`acpx people: ${note}`);
      }
      return;
    }
    failureLines(ref, answer).forEach((line) => printer.err(line));
    if (printer.json) {
      printer.out(JSON.stringify(failureJson(answer)));
    }
    exitWith(failureCode(answer));
  });
}

/** `--session` as an id or as an acpx-ui URL carrying `?session=<id>`; else the caller's own `$ACPX_SESSION_URL`. */
function sessionIdToRead(flag: string | undefined): string | undefined {
  const given = flag?.trim();
  if (given) {
    return given.includes("://") || given.includes("?") ? parseSessionIdFromUrl(given) : given;
  }
  return parseSessionIdFromUrl(process.env.ACPX_SESSION_URL?.trim() || undefined);
}

function noSessionMessage(flag: string | undefined): string {
  return flag?.trim()
    ? `acpx people principal: ${JSON.stringify(flag)} names no session (expected an id or a URL with ?session=<id>)`
    : "acpx people principal: no session given and $ACPX_SESSION_URL names none — pass --session <id|url>";
}

/** The record's metadata, or undefined (already reported, exit 2) when the session is unknown or ambiguous. */
async function metadataOfSession(
  printer: Printer,
  sessionId: string,
): Promise<{ metadata: unknown } | undefined> {
  try {
    return { metadata: (await resolveSessionRecord(sessionId)).metadata };
  } catch (error) {
    if (error instanceof SessionNotFoundError || error instanceof SessionResolutionError) {
      printer.err(`acpx people principal: ${error.message}`);
      exitWith(PEOPLE_EXIT.USAGE);
      return undefined;
    }
    throw error;
  }
}

function printPrincipal(printer: Printer, recorded: RecordedPrincipal): void {
  const principal =
    recorded.id === null
      ? null
      : { id: recorded.id, ...(recorded.name === null ? {} : { name: recorded.name }) };
  if (printer.json) {
    printer.out(JSON.stringify({ principal, via: recorded.via, from: recorded.from }));
    return;
  }
  const who = principal === null ? "nobody" : `${principal.name ?? "(unnamed)"} ${principal.id}`;
  const from = recorded.from === null ? "" : ` from ${recorded.from}`;
  printer.out(`${who} · via ${recorded.via}${from}`);
}

async function handlePrincipal(printer: Printer, sessionFlag: string | undefined): Promise<void> {
  const sessionId = sessionIdToRead(sessionFlag);
  if (sessionId === undefined) {
    printer.err(noSessionMessage(sessionFlag));
    exitWith(PEOPLE_EXIT.USAGE);
    return;
  }
  const loaded = await metadataOfSession(printer, sessionId);
  if (loaded === undefined) {
    return;
  }
  const recorded = recordedPrincipalOf(loaded.metadata);
  if (recorded === null) {
    const hint = `session ${sessionId} predates principal recording; atrium can answer by walking its lineage: GET /api/sessions/${sessionId}/principal`;
    printer.err(`acpx people principal: not recorded — ${hint}`);
    if (printer.json) {
      printer.out(JSON.stringify({ error: "not-recorded", hint }));
    }
    exitWith(PEOPLE_EXIT.NOT_RECORDED);
    return;
  }
  printPrincipal(printer, recorded);
}

// Subcommands are created before `program.exitOverride()` runs in `main`, and commander copies that setting
// at creation, so each level rethrows itself: a usage error then reaches `handleProgramParseError` and exits
// 2 (§4.1), where commander's own default would exit 1.
function rethrow(error: Error): never {
  throw error;
}

export function registerPeopleCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const people = parent
    .command("people")
    .description(
      "The box's people and whom a session works for — offline, read-only (list, resolve, principal)",
    )
    .exitOverride(rethrow);

  people
    .command("list")
    .description("List the people registered on this box: handle, name, id, last seen")
    .exitOverride(rethrow)
    .action(async function (this: Command) {
      await handleList(printerFor(resolveGlobalFlags(this, config).format));
    });

  people
    .command("resolve <ref>")
    .description(
      "Resolve a person id, handle (@laatz) or full name to one person. Exit 0 found · 3 unknown " +
        "(suggestions are listed, never chosen) · 4 ambiguous · 5 names another box (handle@box)",
    )
    .exitOverride(rethrow)
    .action(async function (this: Command, ref: string) {
      await handleResolve(printerFor(resolveGlobalFlags(this, config).format), ref);
    });

  people
    .command("principal")
    .description(
      "Whom a session works for, as recorded when it was created — your own session by default. " +
        "Exit 0 recorded (the principal may be null) · 6 not recorded · 2 unknown session",
    )
    .option(
      "--session <id|url>",
      "A session id or acpx-ui session URL (default: $ACPX_SESSION_URL)",
    )
    .exitOverride(rethrow)
    .action(async function (this: Command, flags: { session?: string }) {
      await handlePrincipal(printerFor(resolveGlobalFlags(this, config).format), flags.session);
    });
}
