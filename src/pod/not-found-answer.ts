import type { Classification, OutputMode } from "./command-classes.js";

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
type Verb = {
  /** Selector flags this verb takes that name the session by id (or by a `?session=` URL). */
  readonly flags: readonly string[];
  /** The operand is an id (not a name that the verb refuses). */
  readonly operand?: true;
  readonly rendering?: Rendering;
};

const ID_OR_URL = ["--session-id", "--session-url"] as const;

/** Per `Classification.path`. Measured on the control pod, `te`-style, for every row (see the test). */
export const NOT_FOUND_VERBS: Readonly<Record<string, Verb>> = {
  cancel: { flags: ID_OR_URL },
  "set-mode": { flags: ID_OR_URL },
  set: { flags: ID_OR_URL },
  status: { flags: ID_OR_URL },
  "sessions close": { flags: ID_OR_URL },
  "sessions reopen": { flags: [], operand: true },
  "sessions recover": { flags: [], operand: true },
  "sessions owner-status": { flags: [], operand: true },
  "sessions set-os": { flags: [], operand: true },
  "sessions set-metadata": { flags: ID_OR_URL },
  "sessions set-parent": { flags: ["--session-id", "--children-of"], rendering: "set-parent" },
  "people set-owner": { flags: ["--session"] },
};

type Classified = Extract<Classification, { kind: "classified" }>;

/** The `?session=` of a URL, or undefined. */
function sessionOfUrl(value: string): string | undefined {
  try {
    return new URL(value).searchParams.get("session")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Is this selector one the verb takes as an id (an operand it does not refuse as a name, or a mapped flag)? */
function isMappedSelector(verb: Verb, target: NonNullable<Classified["target"]>): boolean {
  return target.via === "operand" ? verb.operand === true : verb.flags.includes(target.flag);
}

/** The id the control pod would name: the selector's value, or the `?session=` of a URL. */
function unresolvedId(classification: Classified): string | undefined {
  const verb = NOT_FOUND_VERBS[classification.path];
  const target = classification.target;
  if (!verb || !target || classification.targetConflict || !isMappedSelector(verb, target)) {
    return undefined;
  }
  const byUrl = target.via === "flag" && target.flag === "--session-url";
  return (byUrl ? sessionOfUrl(target.value) : target.value) || undefined;
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
  output: OutputMode,
  io: LocalAnswerWriters,
): number {
  const byChildren =
    classification.target?.via === "flag" && classification.target.flag === "--children-of";
  const message = byChildren
    ? `--children-of refers to unknown session: ${id}`
    : `no session matches: ${id}`;
  if (output === "text") {
    io.write(`set-parent: SESSION_NOT_FOUND: ${message}`);
  } else {
    io.writeStdout(JSON.stringify({ ok: false, code: "SESSION_NOT_FOUND", error: message }));
  }
  return 4;
}

/**
 * The control pod's answer to this command about a session nobody can find — written through `io`, and the
 * exit code to return — or `undefined` when this shape is not one the table maps (the caller then prints
 * the door's refusal as before).
 */
export async function answerLikeLocal(
  classification: Classified,
  output: OutputMode,
  io: LocalAnswerWriters,
): Promise<number | undefined> {
  const id = unresolvedId(classification);
  if (id === undefined) {
    return undefined;
  }
  if (NOT_FOUND_VERBS[classification.path]?.rendering === "set-parent") {
    return setParentAnswer(classification, id, output, io);
  }
  const [{ SessionNotFoundError }, errors, rendering] = await Promise.all([
    import("../errors.js"),
    import("../acp/error-normalization.js"),
    import("../cli/output/output.js"),
  ]);
  const error = new SessionNotFoundError(id);
  const normalized = errors.normalizeOutputError(error, { origin: "cli" });
  // `emitRequestedError` (cli-core), for the formats a pod can be in.
  if (output === "text") {
    io.write(normalized.message);
    for (const hint of rendering.getTextErrorRemediationHints(normalized)) {
      io.write(hint);
    }
  } else {
    const formatter = rendering.createOutputFormatter("json", {
      jsonContext: { sessionId: "unknown" },
      suppressReads: false,
    });
    formatter.onError(normalized);
    formatter.flush();
  }
  return errors.exitCodeForOutputErrorCode(normalized.code);
}
