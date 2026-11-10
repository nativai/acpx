import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CAPACITY_CONSTANTS } from "../capacity/constants.js";
import { readerIsInsideLiveOwnerTree } from "../capacity/leases.js";
import { capacitySourcesFromEnv } from "../capacity/reading.js";
import { sessionBaseDir } from "../session/persistence.js";
import type { PromptInput } from "../types.js";
import type { MessageLedgerCaller } from "./message-ledger.js";
import type { MemberTaskOptions } from "./queue/messages.js";

/**
 * UMQ D1 (CONCEPTION §7.2, CONTRACTS §3.2, §5.5, §10) — an AGENT's `acpx prompt` is routed through
 * atrium's one message queue: atrium decides deliver-now vs hold, and the CLI only posts the message
 * and reports the answer.
 *
 * THE FIRST DEFAULT SWITCH POINT (PLAN §1): {@link shouldRouteAgentPrompt} is the only place that
 * decides "routed or direct". Back door — make its body `return false`: every prompt then takes
 * today's direct path (`handlePrompt` → `sendSession`), and nothing else changes.
 */

/** The three features atrium's executor must advertise for a routed prompt (K9). */
export const ATRIUM_REQUIRED_FEATURES = [
  "message-content",
  "message-delivery-id",
  "message-task-options",
] as const;

/** `<state home>/atrium.json`, written by atrium's executor (K9): where THIS home's atrium listens. */
export type AtriumJsonV1 = {
  schema: 1;
  /** Base URL the CLI posts to, e.g. "http://127.0.0.1:3456" (a devN rig: "http://127.0.0.1:300N"). */
  internalUrl: string;
  /** The instance id (capacityQueue writer name). */
  writer: string;
  features: string[];
  writtenAt: string;
};

/** `−2 s ≤ now − mtime < 5 min` (K9): a stale file is an atrium that stopped writing. */
const ATRIUM_JSON_MAX_AGE_MS = 5 * 60_000;
const ATRIUM_JSON_MAX_FUTURE_SKEW_MS = 2_000;

export function atriumJsonPath(): string {
  return path.join(path.dirname(sessionBaseDir()), "atrium.json");
}

/**
 * The atrium that owns this acpx state home, or `undefined` (absent, stale, unparseable, wrong
 * schema, or a URL that is not http(s)). A rig with its own `HOME` therefore reaches its own atrium,
 * never production's. ⚠️ The origin ladder (`acpx-ui-internal-origin.ts`) is deliberately NOT a
 * fallback here: it names an atrium but cannot attest its features, and routing requires all of
 * them — an older atrium must get today's direct path.
 */
export function readAtriumJson(nowMs: number = Date.now()): AtriumJsonV1 | undefined {
  try {
    const file = atriumJsonPath();
    const ageMs = nowMs - fs.statSync(file).mtimeMs;
    if (ageMs < -ATRIUM_JSON_MAX_FUTURE_SKEW_MS || ageMs >= ATRIUM_JSON_MAX_AGE_MS) {
      return undefined;
    }
    return parseAtriumJson(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

export function parseAtriumJson(raw: unknown): AtriumJsonV1 | undefined {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const internalUrl = httpBaseUrl(value.internalUrl);
  const features = stringList(value.features);
  if (
    value.schema !== 1 ||
    internalUrl === undefined ||
    typeof value.writer !== "string" ||
    typeof value.writtenAt !== "string" ||
    features === undefined
  ) {
    return undefined;
  }
  return { schema: 1, internalUrl, writer: value.writer, features, writtenAt: value.writtenAt };
}

/** An http(s) base URL, trailing slashes stripped. */
function httpBaseUrl(value: unknown): string | undefined {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\/[^/\s]+/u.test(url) ? url.replace(/\/+$/u, "") : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function hasRoutingFeatures(atrium: AtriumJsonV1 | undefined): boolean {
  return (
    atrium !== undefined &&
    ATRIUM_REQUIRED_FEATURES.every((feature) => atrium.features.includes(feature))
  );
}

export type RouteInput = {
  /** `resolveLedgerCaller()`: the calling AGENT, absent for a shell or a script. */
  caller: MessageLedgerCaller | undefined;
  /** The caller sits inside a live queue owner's process tree. */
  insideOwnerTree: boolean;
  /** `--message-id`: acpx-ui's own delivery invocations carry one — a second fence against a loop. */
  messageId?: string;
  /** `--batch-file`: atrium's batch spawn. */
  batchFile: boolean;
  atrium: AtriumJsonV1 | undefined;
};

/**
 * Is this prompt routed through atrium's queue? True iff the caller is an agent, inside an owner tree,
 * with neither `--message-id` nor `--batch-file`, and the atrium that owns this home advertises every
 * required feature.
 *
 * ⚠️ LOOP SAFETY IS THE FIRST CONJUNCT, NOT A CHECK AFTER IT. atrium's own spawns strip the caller
 * identity (`withoutCallerIdentity`, `promptChildEnv.ts`), so a prompt atrium delivers can never come
 * back into atrium under any version mix; `--message-id` is the second fence. Test: "loop safety" in
 * test/prompt-routing.test.ts runs the real child env against a stub atrium that fails on any request.
 */
export function shouldRouteAgentPrompt(input: RouteInput): boolean {
  return (
    input.caller !== undefined &&
    input.insideOwnerTree &&
    input.messageId === undefined &&
    !input.batchFile &&
    hasRoutingFeatures(input.atrium)
  );
}

export type AgentPromptRoute = { atrium: AtriumJsonV1; caller: MessageLedgerCaller };

/**
 * Gathers {@link shouldRouteAgentPrompt}'s inputs cheapest-first: the identity and the file are
 * free, the owner-tree check costs a lease scan and a few `/proc` reads (R12), so it runs only when
 * everything else already says "route". The predicate is monotone in `insideOwnerTree`, so asking
 * it first with `true` can only over-approximate — the real answer follows.
 */
export function decideAgentPromptRoute(params: {
  caller: MessageLedgerCaller | undefined;
  messageId?: string;
  batchFile: boolean;
  nowMs?: number;
  insideOwnerTree?: () => boolean;
}): AgentPromptRoute | undefined {
  const atrium = readAtriumJson(params.nowMs);
  const base = {
    caller: params.caller,
    messageId: params.messageId,
    batchFile: params.batchFile,
    atrium,
  };
  if (!shouldRouteAgentPrompt({ ...base, insideOwnerTree: true })) {
    return undefined;
  }
  const inside = (params.insideOwnerTree ?? readerInsideOwnerTreeNow)();
  if (!shouldRouteAgentPrompt({ ...base, insideOwnerTree: inside })) {
    return undefined;
  }
  return atrium && params.caller ? { atrium, caller: params.caller } : undefined;
}

/** The wake gate's own question ("inferred" class), asked from the caller's ancestry. */
export function readerInsideOwnerTreeNow(env: NodeJS.ProcessEnv = process.env): boolean {
  const sources = capacitySourcesFromEnv(env);
  return readerIsInsideLiveOwnerTree({
    queueDir: sources.queueDir,
    procRoot: sources.procRoot,
    nowMs: Date.now(),
    freshMs: CAPACITY_CONSTANTS.leaseFreshMs,
  });
}

// ─── the wire ─────────────────────────────────────────────────────────────────────────────────

/** `POST /api/{seats,sessions}/:id/message` — CONTRACTS §5.1. */
export type MessageRouteBody = {
  text: string;
  content?: PromptInput;
  delivery_id: string;
  task_options?: MemberTaskOptions;
};

/** The 202 (CONTRACTS §5.2). */
export type MessageRouteAnswer = {
  delivery_id: string;
  from?: string;
  to: string;
  to_seat?: string;
  status: "queued";
  held?: { since: string; reason: string; ahead: number };
  message?: string;
};

/** The route body for a prompt: `content` only when it is more than text (images, resources). */
export function buildMessageRouteBody(params: {
  prompt: PromptInput;
  deliveryId: string;
  taskOptions: MemberTaskOptions | undefined;
}): MessageRouteBody {
  const text = params.prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n");
  const moreThanText = params.prompt.some((block) => block.type !== "text");
  return {
    text,
    ...(moreThanText ? { content: params.prompt } : {}),
    delivery_id: params.deliveryId,
    ...(params.taskOptions ? { task_options: params.taskOptions } : {}),
  };
}

export function mintDeliveryId(): string {
  return randomUUID();
}

/** What an HTTP exchange with atrium came to. Only `connect-failure` may fall back to the direct path. */
export type AtriumExchange =
  /** An answer, whatever its status. */
  | { kind: "response"; status: number; body: unknown }
  /** No connection was ever made: nothing was sent, the direct path is safe. */
  | { kind: "connect-failure"; reason: string }
  /** Connected, but no complete answer in time (or the connection broke): indeterminate — ask atrium. */
  | { kind: "no-answer"; reason: string };

/** Seconds the CLI waits for atrium's answer once connected (CONCEPTION §7.2). */
const ANSWER_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5_000;

/** A seam for rigs and tests only: the answer timeout in ms. */
function answerTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.ACPX_ROUTED_PROMPT_ANSWER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ANSWER_TIMEOUT_MS;
}

export function atriumRequest(params: {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<AtriumExchange> {
  const env = params.env ?? process.env;
  const payload = params.body === undefined ? undefined : JSON.stringify(params.body);
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const finish = (exchange: AtriumExchange) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(answerTimer);
        request.destroy();
        resolve(exchange);
      }
    };
    let request: http.ClientRequest;
    try {
      request = http.request(
        params.url,
        {
          method: params.method,
          headers: {
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
            ...params.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = text;
            try {
              body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
            } catch {
              // a non-JSON body is reported as text
            }
            finish({ kind: "response", status: response.statusCode ?? 0, body });
          });
          response.on("error", (error) => finish({ kind: "no-answer", reason: error.message }));
        },
      );
    } catch (error) {
      resolve({
        kind: "connect-failure",
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const connectTimer = setTimeout(
      () => !connected && finish({ kind: "connect-failure", reason: "connect timed out" }),
      CONNECT_TIMEOUT_MS,
    );
    const answerTimer = setTimeout(
      () => finish({ kind: "no-answer", reason: "no answer in time" }),
      answerTimeoutMs(env),
    );
    request.on("socket", (socket) => {
      if (!socket.connecting) {
        connected = true;
        return;
      }
      socket.once("connect", () => {
        connected = true;
      });
    });
    request.on("error", (error) =>
      finish(
        connected
          ? { kind: "no-answer", reason: error.message }
          : { kind: "connect-failure", reason: error.message },
      ),
    );
    request.end(payload);
  });
}

// ─── the words ─────────────────────────────────────────────────────────────────────────────────

/** UX spec §11: `next in line` at 0, `<k> ahead` otherwise — never `0 ahead`. */
export function formatAhead(ahead: number): string {
  return ahead <= 0 ? "next in line" : `${ahead} ahead`;
}

/** stdout of a routed prompt (CONTRACTS §5.5). */
export function routedPromptLine(answer: MessageRouteAnswer, label: string): string {
  const id = answer.delivery_id;
  return answer.held
    ? `[queued for room] delivery ${id} (${formatAhead(answer.held.ahead)}) → ${label}`
    : `[sent] delivery ${id} → ${label}`;
}

/** The fallback branch's last line when the direct path's wake gate then refused (CONTRACTS §5.5, A-10). */
export function atriumDownRefusalLine(who: string): string {
  return `acpx: no room to wake ${who}, and atrium's message queue did not answer, so nothing was queued; it must be sent again once atrium answers ('acpx capacity' shows the box).`;
}

/** stderr line of a direct fallback that delivered (CONTRACTS §5.5). */
export function deliveredDirectlyLine(deliveryId: string): string {
  return `acpx: atrium's message queue did not answer; delivered directly (delivery ${deliveryId})`;
}

/** Wait mode, recipient not running: the routed send does not stream a reply. */
export const ROUTED_WAIT_MODE_LINE =
  "acpx: the recipient had no running agent, so this prompt went to atrium's message queue and was not waited for; its reply arrives as a message.";
