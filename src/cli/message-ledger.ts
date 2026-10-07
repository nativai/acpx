// CLI message ledger — contract v1 (brick c6bab3aa, LEDGER-CONTRACT.md; acpx writes, acpx-ui
// reads). A prompt this CLI hands to a queue owner over the local socket reaches no other
// store, so without this line an agent's `acpx <agent> prompt --seat …` — the orchestrators'
// main send path — is invisible in every message history.
//
// ⚠️ THE LINE FORMAT AND THE GATE ARE A CROSS-REPO CONTRACT: acpx-ui ingests these files by
// byte offset and keys rows on `id`. Change either only in lockstep with acpx-ui, and bump
// `v` on any incompatible change.
//
// ⚠️ NEVER CALL THIS FROM THE QUEUE-OWNER RUNTIME. An owner inherits its SPAWNER's env, so its
// `ACPX_SESSION_URL` names the wrong sender. The hook below runs in the CLI process on the
// client side of the socket (`onSubmitAccepted`, fired from the IPC ack).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOutputError } from "../acp/error-normalization.js";
import { sessionBaseDir } from "../session/persistence.js";
import type { PromptInput } from "../types.js";
import { parseSeatIdFromUrl, parseSessionIdFromUrl } from "./session-selector.js";

export type MessageLedgerKind = "prompt" | "template-prompt" | "fork-notice";

export type MessageLedgerCaller = { session: string; seat: string | null; url: string | null };

export type MessageLedgerSend = {
  kind: MessageLedgerKind;
  to: { session: string; seat: string | null };
  addressedAs: "seat" | "session";
  prompt: PromptInput;
  /** acpx-ui's own delivery invocations carry one; those are recorded by acpx-ui, never here. */
  messageId?: string;
};

export type MessageLedgerLine = {
  v: 1;
  id: string;
  at: string;
  kind: MessageLedgerKind;
  from: MessageLedgerCaller;
  to: { session: string; seat: string | null };
  addressedAs: "seat" | "session";
  outcome: "accepted" | "refused";
  failureCode: string | null;
  text: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The calling AGENT, or `undefined` for any other caller (a human shell, a script) — which
 * is never recorded. Identity comes only from the variables acpx itself sets on an agent:
 * `ACPX_SESSION_URL` carrying a `?session=<uuid>`, else `ACPX_SESSION_RECORD_ID`.
 */
export function resolveLedgerCaller(
  env: NodeJS.ProcessEnv = process.env,
): MessageLedgerCaller | undefined {
  const url = nonEmpty(env.ACPX_SESSION_URL);
  const fromUrl = parseSessionIdFromUrl(url);
  const session =
    fromUrl !== undefined && UUID_RE.test(fromUrl) ? fromUrl : nonEmpty(env.ACPX_SESSION_RECORD_ID);
  if (session === undefined) {
    return undefined;
  }
  return {
    session,
    seat: parseSeatIdFromUrl(nonEmpty(env.ACPX_SEAT_URL)) ?? null,
    url: url ?? null,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** `<state home>/message-ledger` — the SAME home `sessions/` resolves from (`ACPX_STATE_HOME`). */
export function messageLedgerDir(): string {
  return path.join(path.dirname(sessionBaseDir()), "message-ledger");
}

/** Text blocks joined, untrimmed — a single text prompt is recorded byte for byte. */
function ledgerText(prompt: PromptInput): string {
  return prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
}

function failureCodeOf(error: unknown): string {
  const normalized = normalizeOutputError(error);
  return normalized.detailCode ?? normalized.code;
}

/**
 * Appends ONE line in ONE `write()` on an `O_APPEND` descriptor, so concurrent writers never
 * interleave and the reader never sees a partial line it could mistake for a whole one. Never
 * throws: a failure is one stderr line, and the command's exit code, stdout and prompt are
 * untouched.
 */
export function appendMessageLedgerLine(line: MessageLedgerLine): void {
  try {
    const dir = messageLedgerDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${line.at.slice(0, 10)}.ndjson`);
    const bytes = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
      0o600,
    );
    try {
      const written = fs.writeSync(fd, bytes);
      if (written !== bytes.length) {
        throw new Error(`short write (${written} of ${bytes.length} bytes) to ${file}`);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`acpx: message ledger not written: ${reason.replace(/\s+/g, " ")}\n`);
  }
}

/**
 * Runs `deliver` and records its send: `accepted` the moment the owner acknowledges the
 * submit (`onSubmitAccepted`), else `refused` with the error's acpx code when it throws
 * first. At most one line per call — a submit acknowledged and then retried is one send.
 * Errors after the ack (a failed turn) are not a refusal and add nothing. `deliver`'s
 * result and errors pass through unchanged.
 */
export async function withMessageLedger<T>(
  send: MessageLedgerSend,
  deliver: (onSubmitAccepted: () => void) => Promise<T>,
): Promise<T> {
  const caller = send.messageId === undefined ? resolveLedgerCaller() : undefined;
  if (caller === undefined) {
    return await deliver(() => undefined);
  }
  let recorded = false;
  const record = (outcome: MessageLedgerLine["outcome"], failureCode: string | null) => {
    if (recorded) {
      return;
    }
    recorded = true;
    appendMessageLedgerLine({
      v: 1,
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: send.kind,
      from: caller,
      to: send.to,
      addressedAs: send.addressedAs,
      outcome,
      failureCode,
      text: ledgerText(send.prompt),
    });
  };
  try {
    const result = await deliver(() => record("accepted", null));
    record("accepted", null);
    return result;
  } catch (error) {
    record("refused", failureCodeOf(error));
    throw error;
  }
}
