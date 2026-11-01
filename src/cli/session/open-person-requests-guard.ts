import {
  readAcpxUiInternalOriginSources,
  resolveAtriumLocalOrigin,
} from "../../acp/acpx-ui-internal-origin.js";
import type { OutputFormat, SessionRecord } from "../../types.js";
import { emitJsonResult } from "../output/json-output.js";
import { callerIsAgent } from "./byway-close-guard.js";

/**
 * `sessions close`'s open-person-request guard (brick 2587d30e, addressing v3 §8.3 / K18 P6).
 *
 * A closing session that still has a flagged message awaiting a PERSON's answer would drop that
 * request silently (atrium's seat-close hook closes the rows `session-closed`). So the close is
 * refused unless the caller adds `--force`, and with `--force` that hook does exactly that.
 *
 * ## The mechanism (O-11): a READ of atrium's rows, not a count in the session record
 *
 * `GET /api/sessions/<id>/person-messages` on the BOX-LOCAL atrium (`resolveAtriumLocalOrigin`,
 * the archive verbs' origin). Chosen over a `metadata` string because it needs no change in
 * acpx-ui, the answer is the store's own at the moment of the close (a count in the record is a
 * copy that a reply or a resolve leaves stale), and it cannot put a non-string into `metadata`
 * (a non-string value there fails the whole record load).
 *
 * ## The three answers a read can give — and what each does to the close
 *
 * ⚠️ `route-absent` IS NOT "0 OPEN". An atrium built before the person-messages routes answers
 * `404 application/json {"error":"Not found"}` on an `/api` path (TEST-PLAN amendment v1.2 / L0-6),
 * and a live route that knows no such session answers `404 {"error":"unknown-session"}`; they look
 * alike to anything that only checks the status. The first means "this atrium cannot hold a person
 * request" — nothing can be lost, so the close PROCEEDS and the fact is said only under
 * `--verbose`; the second is the live store's own answer (nothing open). Keep them apart.
 *
 * `unreachable` (connection refused, timeout, a 5xx, a body that is not the rows shape): acpx
 * cannot know. The close PROCEEDS, said on stderr only under `--verbose` — a close must never be
 * blocked by an atrium that is down (it is what a wrap-up runs against, and on a box with no
 * atrium there is nothing to ask), and atrium's own seat-close hook still closes any rows, visibly
 * as `session-closed`, when it is back. ⚠️ NOT a default warning: every agent-run close on a box
 * or a test rig without a reachable atrium would carry it, and fleet wrap-ups parse the close's
 * stderr (`2>&1 | tail -1`); `test/background-task-close-gate.test.ts` asserts that stderr exactly.
 *
 * ## Where it does NOT fire
 *
 * It guards an AGENT's close only — detected exactly as the byway guard detects it
 * (`callerIsAgent`: any of the identity variables acpx sets on every agent it runs, which atrium
 * strips before it spawns acpx). The silent loss this exists for is an agent (an orchestrator
 * closing its children, a session closing itself) dropping a person's request unseen; a PERSON's
 * close — atrium's UI close delegation, a human at a terminal — is deliberate, and the seat-close
 * hook closes the rows visibly as `session-closed`. So a non-agent caller is never asked and
 * never warned. ⚠️ A self-close by an agent IS guarded (unlike the byway guard's exemption): an
 * agent that closes itself with a request open must resolve it or say `--force`.
 *
 * It is evaluated by the HANDLER, never inside `closeSession()`, so acpx's own internal closes
 * (template enable, handover) are untouched. And it asks only about a session whose close would
 * close the rows: a seat's ACTIVE holder, or a seat-less session. A retired predecessor
 * (`holderActive` false) or a prepared successor (no `holderActive`) leaves the seat — and its
 * rows — to the holder that remains: closing the predecessor after a hand-over (the duty
 * `sessions activate` prints) must never be refused.
 */
export const OPEN_PERSON_REQUESTS_REFUSED = "OPEN_PERSON_REQUESTS";

const READ_TIMEOUT_MS = 2_000;

export type OpenPersonRequest = {
  to: { id: string; name: string; handle?: string };
  messageId: string;
  since: string;
};

export type OpenPersonRequestsRead =
  | { kind: "answered"; open: OpenPersonRequest[] }
  | { kind: "route-absent" }
  | { kind: "unreachable"; reason: string };

export type OpenPersonRequestsFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/** True when closing this record would close the seat's rows (see "Where it does NOT fire"). */
export function closeWouldCloseRows(record: SessionRecord): boolean {
  if (record.closed === true) {
    return false;
  }
  return record.seatId === undefined || record.holderActive === true;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPerson(value: unknown): OpenPersonRequest["to"] | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.handle === "string" ? { handle: value.handle } : {}),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** `null` = a closed row; `undefined` = a row of a shape this reader does not know. */
function readRow(row: unknown): OpenPersonRequest | null | undefined {
  if (!isRecord(row) || typeof row.state !== "string") {
    return undefined;
  }
  const to = readPerson(row.to);
  if (!to) {
    return undefined;
  }
  return row.state === "open"
    ? { to, messageId: stringOr(row.message_id, ""), since: stringOr(row.created_at, "") }
    : null;
}

function readRows(rows: readonly unknown[]): OpenPersonRequestsRead {
  const open: OpenPersonRequest[] = [];
  for (const raw of rows) {
    const row = readRow(raw);
    if (row === undefined) {
      return { kind: "unreachable", reason: "atrium's answer holds a row of an unknown shape" };
    }
    if (row !== null) {
      open.push(row);
    }
  }
  return { kind: "answered", open };
}

/** Classifies one answer of the route. Pure — the unit rows pin every branch. */
export function classifyPersonMessagesAnswer(status: number, text: string): OpenPersonRequestsRead {
  const body = parseJson(text);
  if (status === 404) {
    const known = isRecord(body) && body.error === "unknown-session";
    return known ? { kind: "answered", open: [] } : { kind: "route-absent" };
  }
  if (status !== 200) {
    return { kind: "unreachable", reason: `atrium answered ${status}` };
  }
  if (body === undefined) {
    // 200 without JSON on an /api path is the SPA catch-all of a build without the route.
    return { kind: "route-absent" };
  }
  if (!isRecord(body) || !Array.isArray(body.rows)) {
    return { kind: "unreachable", reason: "atrium's answer is not the person-messages shape" };
  }
  return readRows(body.rows);
}

export async function readOpenPersonRequests(
  origin: string,
  sessionId: string,
  fetchImpl: OpenPersonRequestsFetch = fetch,
): Promise<OpenPersonRequestsRead> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, READ_TIMEOUT_MS);
  try {
    const url = `${origin.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/person-messages`;
    const response = await fetchImpl(url, { signal: controller.signal });
    return classifyPersonMessagesAnswer(response.status, await response.text());
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function openRequestsMessage(sessionId: string, open: readonly OpenPersonRequest[]): string {
  const names = [...new Set(open.map((request) => request.to.name))].join(", ");
  return `${sessionId} has open requests to ${names}; resolve them or add --force`;
}

export type OpenPersonRequestsDecision =
  | { proceed: true; note?: { text: string; verboseOnly: boolean } }
  | { proceed: false; message: string; open: OpenPersonRequest[] };

/** What the close does with each answer — the table in the file comment, as code. */
export function decideOnOpenPersonRequests(
  sessionId: string,
  read: OpenPersonRequestsRead,
): OpenPersonRequestsDecision {
  if (read.kind === "answered") {
    return read.open.length === 0
      ? { proceed: true }
      : { proceed: false, message: openRequestsMessage(sessionId, read.open), open: read.open };
  }
  const text =
    read.kind === "route-absent"
      ? `this atrium has no person-messages route; ${sessionId} closes without an open-request check`
      : `could not check ${sessionId} for open requests to people (${read.reason}); closing without that check`;
  return { proceed: true, note: { text, verboseOnly: true } };
}

function emitNote(
  note: { text: string; verboseOnly: boolean },
  format: OutputFormat,
  verbose: boolean | undefined,
): void {
  if (format !== "quiet" && (!note.verboseOnly || verbose === true)) {
    process.stderr.write(`sessions close: ${note.text}\n`);
  }
}

function emitRefusal(
  sessionId: string,
  message: string,
  open: readonly OpenPersonRequest[],
  format: OutputFormat,
): void {
  const payload = {
    ok: false,
    code: OPEN_PERSON_REQUESTS_REFUSED,
    error: message,
    sessionId,
    openRequests: open.map((request) => ({
      to: request.to,
      messageId: request.messageId,
      since: request.since,
    })),
    forceFlag: "--force",
  };
  if (!emitJsonResult(format, payload) && format !== "quiet") {
    process.stderr.write(`sessions close: ${OPEN_PERSON_REQUESTS_REFUSED}: ${message}\n`);
  }
  process.exitCode = 1;
}

/**
 * The handler's one call: `true` when the close was REFUSED (the refusal is already emitted and
 * `process.exitCode` set); `false` to carry on. Nothing is touched before it.
 */
export async function refuseCloseOverOpenPersonRequests(params: {
  record: SessionRecord;
  force: boolean | undefined;
  format: OutputFormat;
  verbose: boolean | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: OpenPersonRequestsFetch;
}): Promise<boolean> {
  const { record, format } = params;
  const env = params.env ?? process.env;
  if (params.force === true || !callerIsAgent(env) || !closeWouldCloseRows(record)) {
    return false;
  }
  const origin = resolveAtriumLocalOrigin(env, readAcpxUiInternalOriginSources());
  const read = await readOpenPersonRequests(origin, record.acpxRecordId, params.fetchImpl);
  const decision = decideOnOpenPersonRequests(record.acpxRecordId, read);
  if (decision.proceed) {
    if (decision.note) {
      emitNote(decision.note, format, params.verbose);
    }
    return false;
  }
  emitRefusal(record.acpxRecordId, decision.message, decision.open, format);
  return true;
}
