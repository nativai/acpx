import type { Classification } from "./command-classes.js";
import { cleanLine, type Line, type LineVerb } from "./command-line-check.js";

/**
 * K5 — a routed command answers as if it ran locally (A9 round, brick 75956474, X1 TE round 2 P1).
 *
 * atrium refuses a passed-through command whose TARGET SESSION it cannot resolve with
 * `400 class-not-passable` + `reason: target-unresolved`. The control pod answers the SAME mistake
 * differently — `Session not found: <id>` (+ the hint), exit 4 — so a typo in a pod read as a policy
 * refusal and branched a script the other way. `answerLikeLocal` renders THE CONTROL POD'S ANSWER for the
 * verb, in-process, with the real error renderers (`normalizeOutputError`, the output formatter, the
 * remediation hints): nothing runs, nothing is written, and no second copy of the wording lives here for
 * the common case. `set-parent` renders its own refusal shape; its two sentences are copied from
 * `session-reparent.ts` and held against the real control pod by `test/pod-not-found.test.ts`, which
 * measures the control answer in the test, never as a literal.
 *
 * ⚠️ ONLY THE SHAPES MEASURED TO BE A PLAIN NOT-FOUND LOCALLY ARE MAPPED (the table below, one row per verb
 * and the selector forms it takes). Everything else — a name where an id belongs (`sessions close <name>`
 * is a usage refusal locally), `--seat` (a seat's own wording), `-s` — keeps the door's refusal, as does
 * every other refusal: do not widen this to "any 400". Known limit: with a bad PERSON or a bad PARENT as
 * well as a bad session, the control pod reports the person / the parent first (it checks them first); the
 * pod, whose atrium resolved only the session, reports the session.
 */

type Rendering = "plain" | "set-parent";
type Verb = LineVerb & {
  /**
   * With NO selector the control pod answers `No acpx session found: no session id was given` (exit 4) for an
   * EXPLICIT agent (`acpx claude status`); the agent-less form names the config's default agent, which the pod
   * does not read, so it is not mapped (K5 round 3, F5).
   */
  readonly noSelector?: true;
  /** Selector flags this verb takes that name the session by id (or by a `?session=` URL). */
  readonly flags: readonly string[];
  /** The operand is an id (not a name that the verb refuses). */
  readonly operand?: true;
  readonly rendering?: Rendering;
};

const ID_OR_URL = ["--session-id", "--session-url"] as const;
const nonEmpty = (value: string): boolean => value.trim() !== "";
const isDefaultOsChoice = (value: string): boolean => ["", "default"].includes(value.trim());

/** Per `Classification.path`. Measured on the control pod for every row (see the test). */
export const NOT_FOUND_VERBS: Readonly<Record<string, Verb>> = {
  cancel: { flags: ID_OR_URL, values: ID_OR_URL, booleans: [], operands: [0, 0], noSelector: true },
  "set-mode": {
    flags: ID_OR_URL,
    values: ID_OR_URL,
    booleans: [],
    operands: [1, 1],
    noSelector: true,
  },
  set: { flags: ID_OR_URL, values: ID_OR_URL, booleans: [], operands: [2, 2], noSelector: true },
  status: { flags: ID_OR_URL, values: ID_OR_URL, booleans: [], operands: [0, 0], noSelector: true },
  "sessions close": { flags: ID_OR_URL, values: ID_OR_URL, booleans: [], operands: [0, 0] },
  "sessions reopen": { flags: [], operand: true, values: [], booleans: [], operands: [1, 1] },
  "sessions recover": { flags: [], operand: true, values: [], booleans: [], operands: [1, 1] },
  "sessions owner-status": {
    flags: [],
    operand: true,
    values: [],
    booleans: [],
    operands: [1, 1],
    jsonStrictAlone: true,
  },
  "sessions set-os": {
    flags: [],
    operand: true,
    values: [],
    booleans: ["--dry-run"],
    operands: [2, 2],
    // `<session>` is `parseNonEmptyValue`; `<choice>` is `validateOsChoice`, which accepts `default` or an empty
    // choice without looking at the disk — any explicit path (a relative one is refused there) keeps the refusal.
    operandRules: [nonEmpty, isDefaultOsChoice],
  },
  "sessions set-metadata": {
    flags: ID_OR_URL,
    values: ID_OR_URL,
    booleans: [],
    operands: [2, 2],
    // `<key>` and `<value>` are both `parseNonEmptyValue` (trimmed, non-empty) before the session is looked up
    operandRules: [nonEmpty, nonEmpty],
  },
  "sessions set-parent": {
    flags: ["--session-id", "--children-of"],
    rendering: "set-parent",
    values: ["--session-id", "--children-of", "--parent-id"],
    // no parent flag, or an empty one, is refused (USAGE / PARENT_DETACH_UNSUPPORTED) before any session lookup
    requiredValues: ["--parent-id"],
    booleans: [],
    operands: [0, 0],
    leafFormat: true,
  },
  "people set-owner": {
    flags: ["--session"],
    values: ["--session"],
    booleans: [],
    operands: [1, 1],
  },
};

type Classified = Extract<Classification, { kind: "classified" }>;

/** Is this selector one the verb takes as an id (an operand it does not refuse as a name, or a mapped flag)? */
function isMappedSelector(verb: Verb, target: NonNullable<Classified["target"]>): boolean {
  return target.via === "operand" ? verb.operand === true : verb.flags.includes(target.flag);
}

/** The id of a `--session-url` / `--session` value, read as the control pod reads it. */
async function idOfFlag(flag: string, value: string): Promise<string | undefined> {
  const selector = await import("../cli/session-selector.js");
  if (flag === "--session-url") {
    return selector.parseSeatIdFromUrl(value) === undefined
      ? selector.parseSessionIdFromUrl(value)
      : undefined;
  }
  if (flag === "--session") {
    const given = value.trim();
    const isUrl = given.includes("://") || given.includes("?");
    return (isUrl ? selector.parseSessionIdFromUrl(given) : given) || undefined;
  }
  return value || undefined;
}

/**
 * The id the control pod would name — read with ITS OWN helpers (`session-selector.ts`, and
 * `people-command.ts`'s `sessionIdToRead` rule), never a copy: a `?session=` URL is read untrimmed, a URL that
 * ALSO carries `?seat=` is a usage error there (so: unmapped here, K5 TE F1b), and `people set-owner --session`
 * takes an id or a URL.
 */
async function unresolvedId(classification: Classified): Promise<string | undefined> {
  const verb = NOT_FOUND_VERBS[classification.path];
  const target = classification.target;
  if (!verb || !target || classification.targetConflict || !isMappedSelector(verb, target)) {
    return undefined;
  }
  return target.via === "operand"
    ? operandId(target.value)
    : await idOfFlag(target.flag, target.value);
}

/** An operand the control pod trims (`parseNonEmptyValue`) is named TRIMMED there: a padded one keeps the refusal. */
function operandId(value: string): string | undefined {
  return value === value.trim() && value !== "" ? value : undefined;
}

export type LocalAnswerWriters = {
  /** One stderr line. */
  write: (line: string) => void;
  /** One stdout line. */
  writeStdout: (line: string) => void;
};

/** `set-parent`'s own refusal, as `emitSetParentRefusal` prints it (exit 4: `SESSION_NOT_FOUND`). */
function setParentAnswer(
  classification: Classified,
  id: string,
  line: Line,
  io: LocalAnswerWriters,
): number {
  const byChildren =
    classification.target?.via === "flag" && classification.target.flag === "--children-of";
  const message = byChildren
    ? `--children-of refers to unknown session: ${id}`
    : `no session matches: ${id}`;
  if (line.format === "json") {
    io.writeStdout(JSON.stringify({ ok: false, code: "SESSION_NOT_FOUND", error: message }));
  } else if (line.format === "text") {
    io.write(`set-parent: SESSION_NOT_FOUND: ${message}`);
  } // quiet: nothing is printed, the exit code is the answer
  return 4;
}

/** What atrium said about the target: no match, or (A-52) acpx's resolver will not choose — with ITS sentence. */
export type TargetFailure = { kind: "not-found" } | { kind: "ambiguous"; message: string };

/** The ambiguity sentence goes to a terminal: bounded printable text, or it is not shown (the refusal is). */
const SAFE_SENTENCE = /^[^\p{Cc}]{1,1000}$/u;

/**
 * The control pod's answer to this command about a session it cannot take — written through `io`, and the
 * exit code to return — or `undefined` when this shape is not one the table maps, or the command line is not
 * one the control pod would get as far as resolving (the caller then prints the door's refusal as before).
 * `argv` is the whole line after `node acpx`.
 *
 * `not-found` is the control pod's `SessionNotFoundError` (exit 4); `ambiguous` is its `SessionResolutionError`
 * (exit 1, `message` the resolver's own sentence from atrium — never a copy), rendered by the same renderers.
 * `set-parent` renders ONLY a not-found as its own refusal: an ambiguity reaches the top-level error path
 * there too (`resolveSessionRecord` throws it, `session-reparent.ts` rethrows what is not a not-found).
 */
/** What the control pod's error is about: a session id nobody has, or no selector at all (an explicit agent). */
type Subject = { id: string } | { noSelectorAgent: string };
type Prepared = { verb: Verb; line: Line; subject: Subject };

/** How many words name the command after the program's own options: `[agent] verb…`. */
const commandWords = (classification: Classified): number =>
  (classification.agent === undefined ? 0 : 1) + classification.path.split(" ").length;

/** The subject: the unresolved id, or — for a verb that maps it — `no selector` with an explicit agent. */
async function subjectOf(
  verb: Verb,
  classification: Classified,
  failure: TargetFailure,
): Promise<Subject | undefined> {
  if (classification.target === undefined) {
    const agent = classification.agent;
    const mapped =
      verb.noSelector === true && failure.kind === "not-found" && !classification.targetConflict;
    return mapped && agent !== undefined ? { noSelectorAgent: agent } : undefined;
  }
  const id = await unresolvedId(classification);
  return id === undefined ? undefined : { id };
}

/** The verb, the clean line and the subject — or undefined when any of the three is not one this module answers. */
async function prepare(
  classification: Classified,
  argv: readonly string[],
  failure: TargetFailure,
): Promise<Prepared | undefined> {
  const verb = NOT_FOUND_VERBS[classification.path];
  const line = verb ? cleanLine(verb, argv, commandWords(classification)) : undefined;
  const subject =
    verb && line && showable(failure) ? await subjectOf(verb, classification, failure) : undefined;
  return verb && line && subject ? { verb, line, subject } : undefined;
}

export async function answerLikeLocal(
  classification: Classified,
  argv: readonly string[],
  io: LocalAnswerWriters,
  failure: TargetFailure = { kind: "not-found" },
): Promise<number | undefined> {
  const ready = await prepare(classification, argv, failure);
  if (ready === undefined) {
    return undefined;
  }
  return failure.kind === "not-found" &&
    "id" in ready.subject &&
    ready.verb.rendering === "set-parent"
    ? setParentAnswer(classification, ready.subject.id, ready.line, io)
    : await renderError(failure, ready.subject, ready.line, io);
}

const showable = (failure: TargetFailure): boolean =>
  failure.kind === "not-found" || SAFE_SENTENCE.test(failure.message);

/** The control pod's error object for this subject, built by its own classes and its own sentence. */
async function localError(failure: TargetFailure, subject: Subject): Promise<Error> {
  const errors = await import("../errors.js");
  if (failure.kind === "ambiguous") {
    return new errors.SessionResolutionError(failure.message);
  }
  if ("id" in subject) {
    return new errors.SessionNotFoundError(subject.id);
  }
  const selector = await import("../cli/session-selector.js");
  return new selector.NoSessionError(selector.noSessionIdMessage(subject.noSelectorAgent));
}

/** `emitRequestedError` (cli-core), for the formats a pod can be in, with the control pod's own error object. */
async function renderError(
  failure: TargetFailure,
  subject: Subject,
  line: Line,
  io: LocalAnswerWriters,
): Promise<number> {
  const [error, normalizer, rendering] = await Promise.all([
    localError(failure, subject),
    import("../acp/error-normalization.js"),
    import("../cli/output/output.js"),
  ]);
  const normalized = normalizer.normalizeOutputError(error, { origin: "cli" });
  if (line.format === "json") {
    const formatter = rendering.createOutputFormatter("json", {
      jsonContext: { sessionId: "unknown" },
      suppressReads: false,
    });
    formatter.onError(normalized);
    formatter.flush();
  } else {
    io.write(normalized.message);
    const hints = line.format === "text" ? rendering.getTextErrorRemediationHints(normalized) : [];
    hints.forEach((hint) => io.write(hint));
  }
  return normalizer.exitCodeForOutputErrorCode(normalized.code);
}
