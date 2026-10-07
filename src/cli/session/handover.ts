/**
 * `acpx sessions handover --brief <file>` — item F of proactive succession (brick f74abb05;
 * Daniel's decision, brick 7f61daf9 DECISION.md item F).
 *
 * One command for the agent at its context alarm: the successor is created in the CALLER's
 * seat with the caller's exact settings (`sessions new --from <caller>` — model incl. Fable,
 * effort, cwd, brick, parent), activated (`sessions activate`), and handed ONE turn: the
 * activation notice followed by the standard handover prompt that points at the brief. It
 * never forks and never closes the caller. The pure parts live here; the composition with the
 * create and activate internals is `handleSessionsHandover` in command-handlers.ts.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Above this the brief is accepted with a warning — every byte is the successor's first read. */
export const HANDOVER_BRIEF_WARN_BYTES = 20 * 1024;
/** The fixed first line of the handover prompt; the successor and acpx-ui can key on it. */
export const HANDOVER_PROMPT_MARKER = "⟦HANDOVER⟧";

export class HandoverRefusalError extends Error {
  constructor(
    readonly code: "BRIEF_MISSING" | "BRIEF_UNREADABLE" | "BRIEF_EMPTY" | "NO_CALLER" | "NO_SEAT",
    message: string,
  ) {
    super(message);
    this.name = "HandoverRefusalError";
  }
}

export type HandoverBrief = { readonly path: string; readonly bytes: number };

/**
 * The brief, checked BEFORE anything is created: it must exist, be a readable regular file and
 * not be empty — a successor pointed at nothing has nothing to continue from.
 */
export async function readHandoverBrief(file: string, cwd = process.cwd()): Promise<HandoverBrief> {
  const absolute = path.resolve(cwd, file);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new HandoverRefusalError(
      "BRIEF_MISSING",
      `the brief ${absolute} does not exist — write it first; nothing was created`,
    );
  }
  if (!stat.isFile()) {
    throw new HandoverRefusalError(
      "BRIEF_UNREADABLE",
      `the brief ${absolute} is not a regular file; nothing was created`,
    );
  }
  let content: Buffer;
  try {
    content = await fs.readFile(absolute);
  } catch (error) {
    throw new HandoverRefusalError(
      "BRIEF_UNREADABLE",
      `the brief ${absolute} cannot be read (${error instanceof Error ? error.message : String(error)}); nothing was created`,
    );
  }
  if (content.toString("utf8").trim().length === 0) {
    throw new HandoverRefusalError(
      "BRIEF_EMPTY",
      `the brief ${absolute} is empty; nothing was created`,
    );
  }
  return { path: absolute, bytes: content.byteLength };
}

/** The stderr warning for a brief over 20 KB, or nothing. */
export function handoverBriefSizeWarning(brief: HandoverBrief): string | undefined {
  return brief.bytes > HANDOVER_BRIEF_WARN_BYTES
    ? `⚠ the brief is ${brief.bytes.toLocaleString("en-US")} bytes, over 20 KB — your successor ` +
        `reads every byte before it starts. Link files from the brief rather than pasting them.`
    : undefined;
}

/**
 * THE STANDARD HANDOVER PROMPT. Delivered right after the activation notice, in the same turn
 * — the notice says what the successor now IS, this says what to DO, and the brief is the
 * whole of the work's context.
 */
export function composeHandoverPrompt(params: {
  readonly predecessorId: string;
  readonly briefPath: string;
}): string {
  return (
    `${HANDOVER_PROMPT_MARKER}\n` +
    `Your predecessor ${params.predecessorId} handed this seat to you and wrote your brief: ` +
    `${params.briefPath}\n` +
    `Read the brief in full before you do anything else. It is your whole context: the ` +
    `mandate, the state of the work, live children, open threads and the gaps it knows of. ` +
    `Then carry on from the next step it names. Your model, effort, brick and parent are ` +
    `your predecessor's.\n`
  );
}
