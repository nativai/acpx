import { AcpxOperationalError, SessionClosedError } from "../errors.js";
import {
  atriumAwayFailure,
  callHome,
  waitingLine,
  callHomeUnknownFailure,
  type CallHomeFailure,
} from "../pod/call-home.js";
import type { PromptInput, SessionRecord } from "../types.js";
import {
  atriumRequest,
  type AtriumExchange,
  buildMessageRouteBody,
  mintDeliveryId,
  type AgentPromptRoute,
  type MessageRouteAnswer,
} from "./prompt-routing.js";
import type { MemberTaskOptions } from "./queue/messages.js";
import {
  persistRoutedSendOwnerOptions,
  validateRoutedSendOwnerOptions,
  type SendOwnerOptionInputs,
} from "./session/queue-owner-runtime.js";

/**
 * UMQ D1 (CONCEPTION §7.2) — what became of a routed agent prompt.
 *
 *  - `sent`: atrium accepted it (2xx) or, after a timeout, already had it (`GET …/delivery/<id>`);
 *    the owner options are persisted, the caller prints the answer.
 *  - `direct`: deliver it on the direct path. `connect-failure` = nothing was ever sent (plain
 *    direct send, ledger line and all). `not-found` = atrium was reached but never answered and does
 *    not know the id: deliver directly WITH `--message-id <id>`, so if atrium appends it later too,
 *    the owner deduplicates the second copy by message id (`runtime.ts` message-id dedup).
 */
export type RoutedPromptOutcome =
  | { kind: "sent"; answer: MessageRouteAnswer }
  /**
   * Call-home mode only (an agent pod): atrium did not take the message within the budget. There is
   * no direct path — the caller prints the failure and exits with its code (C7.2).
   */
  | { kind: "failed"; failure: CallHomeFailure }
  | {
      kind: "direct";
      deliveryId: string;
      messageId: string | undefined;
      why: "connect-failure" | "not-found";
    };

type RoutedPromptParams = {
  route: AgentPromptRoute;
  record: SessionRecord;
  /** The seat the caller addressed (late binding kept: the seat route), else undefined. */
  addressedSeat: string | undefined;
  prompt: PromptInput;
  taskOptions: MemberTaskOptions | undefined;
  ownerInputs: SendOwnerOptionInputs;
  /** `--json-strict`: stderr stays machine-clean, so a call-home wait prints no progress line. */
  jsonStrict?: boolean;
  env?: NodeJS.ProcessEnv;
};

export async function runRoutedPrompt(params: RoutedPromptParams): Promise<RoutedPromptOutcome> {
  const { record, route } = params;
  const env = params.env ?? process.env;
  // Refusals first, exactly as `sendSession` orders them: a closed target is refused before any
  // write; the owner options are RESOLVED (they can refuse) here and WRITTEN only after the 2xx.
  if (record.closed) {
    throw new SessionClosedError(record.acpxRecordId);
  }
  validateRoutedSendOwnerOptions(record, params.ownerInputs);

  const deliveryId = mintDeliveryId();
  const base = route.atrium.internalUrl;
  if (route.callHome) {
    return await runCallHomePrompt({ ...params, deliveryId, base, env });
  }
  const exchange = await atriumRequest({
    method: "POST",
    url: `${base}${messageRoutePath(record, params.addressedSeat)}`,
    headers: { "x-source-session": env.ACPX_SESSION_URL?.trim() || "anonymous" },
    body: buildMessageRouteBody({
      prompt: params.prompt,
      deliveryId,
      taskOptions: params.taskOptions,
    }),
    env,
  });
  return await outcomeOfExchange(exchange, { ...params, deliveryId, base, env });
}

/**
 * A prompt for another session from an agent pod (C6.1, C7.2): the same message route and the same
 * body, in the call-home loop. The send is idempotent by `delivery_id`, so a send whose answer never
 * came is settled by asking atrium for that id (`settle`): known → its answer; unknown → send again.
 * Never `direct`: after the budget the outcome is `failed` (`atrium_away`, nothing queued).
 */
async function runCallHomePrompt(
  params: RoutedPromptParams & { deliveryId: string; base: string; env: NodeJS.ProcessEnv },
): Promise<RoutedPromptOutcome> {
  const { record, env, base, deliveryId } = params;
  const url = `${base}${messageRoutePath(record, params.addressedSeat)}`;
  const body = buildMessageRouteBody({
    prompt: params.prompt,
    deliveryId,
    taskOptions: params.taskOptions,
  });
  const outcome = await callHome({
    send: () =>
      atriumRequest({
        method: "POST",
        url,
        headers: { "x-source-session": env.ACPX_SESSION_URL?.trim() || "anonymous" },
        body,
        env,
      }),
    settle: async () => {
      const status = await atriumRequest({
        method: "GET",
        url: `${base}/api/sessions/${encodeURIComponent(record.acpxRecordId)}/delivery/${encodeURIComponent(deliveryId)}`,
        env,
      });
      return status.kind === "response" && status.status >= 200 && status.status < 300
        ? { kind: "answered", status: status.status, body: status.body }
        : { kind: "retry" };
    },
    env,
    ...(params.jsonStrict === true
      ? {}
      : {
          onWait: (info: Parameters<typeof waitingLine>[0]) =>
            void process.stderr.write(`${waitingLine(info)}\n`),
        }),
  });
  if (outcome.kind === "away") {
    return { kind: "failed", failure: atriumAwayFailure(outcome.waitedMs) };
  }
  if (outcome.kind === "unknown") {
    return {
      kind: "failed",
      failure: callHomeUnknownFailure(outcome.reason, deliveryId, {
        kind: "check",
        how: "a prompt is re-sent with its delivery id until atrium answers, so this should not occur; ask `acpx sessions history` of the recipient whether the message arrived before repeating it.",
      }),
    };
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    // Not a 503: a refusal (a 403 is FINAL — never retried), reported as the direct path would.
    throw refusalOf(outcome.status, outcome.body, record);
  }
  // ⚠️ NO `persistRoutedSendOwnerOptions` HERE, unlike the direct route below: it writes the
  // RECIPIENT's record, and an agent pod never writes another session's record (one writing machine
  // per file, C10). The options this command line carried travel in `task_options`.
  return { kind: "sent", answer: parseAnswer(outcome.body, deliveryId) };
}

async function outcomeOfExchange(
  exchange: AtriumExchange,
  params: RoutedPromptParams & { deliveryId: string; base: string; env: NodeJS.ProcessEnv },
): Promise<RoutedPromptOutcome> {
  if (exchange.kind === "connect-failure") {
    return {
      kind: "direct",
      deliveryId: params.deliveryId,
      messageId: undefined,
      why: "connect-failure",
    };
  }
  if (exchange.kind === "no-answer") {
    return await settleUnansweredSend(params);
  }
  if (exchange.status < 200 || exchange.status >= 300) {
    throw refusalOf(exchange.status, exchange.body, params.record);
  }
  await persistRoutedSendOwnerOptions(params.ownerInputs);
  return { kind: "sent", answer: parseAnswer(exchange.body, params.deliveryId) };
}

/** The seat route when the caller addressed a seat (late binding kept), else the session route. */
function messageRoutePath(record: SessionRecord, addressedSeat: string | undefined): string {
  return addressedSeat === undefined
    ? `/api/sessions/${encodeURIComponent(record.acpxRecordId)}/message`
    : `/api/seats/${encodeURIComponent(addressedSeat)}/message`;
}

/**
 * Connected, but no complete answer (a timeout, or the connection broke): the message may or may not
 * be stored. Ask atrium by the id the CLI minted — found: it is atrium's; not found (or atrium cannot
 * say): deliver directly with that id as the message id.
 */
async function settleUnansweredSend(
  params: RoutedPromptParams & { deliveryId: string; base: string; env: NodeJS.ProcessEnv },
): Promise<RoutedPromptOutcome> {
  const status = await atriumRequest({
    method: "GET",
    url: `${params.base}/api/sessions/${encodeURIComponent(params.record.acpxRecordId)}/delivery/${encodeURIComponent(params.deliveryId)}`,
    env: params.env,
  });
  if (status.kind === "response" && status.status >= 200 && status.status < 300) {
    await persistRoutedSendOwnerOptions(params.ownerInputs);
    return { kind: "sent", answer: parseAnswer(status.body, params.deliveryId) };
  }
  return {
    kind: "direct",
    deliveryId: params.deliveryId,
    messageId: params.deliveryId,
    why: "not-found",
  };
}

/** The route's 202 — or, when atrium's status route answered, that item's current state. */
function parseAnswer(body: unknown, deliveryId: string): MessageRouteAnswer {
  const value = asObject(body);
  const held = parseHeld(value.held);
  return {
    delivery_id: stringField(value, "delivery_id") ?? deliveryId,
    ...optionalString("from", stringField(value, "from")),
    to: stringField(value, "to") ?? "",
    ...optionalString("to_seat", stringField(value, "to_seat")),
    status: "queued",
    ...(held
      ? {
          held,
          ...optionalString(
            "message",
            stringField(value, "message") ?? stringField(asObject(value.held), "message"),
          ),
        }
      : {}),
  };
}

function textOf(body: unknown): string {
  return typeof body === "string" && body.length > 0 ? body : "no detail";
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

function parseHeld(raw: unknown): MessageRouteAnswer["held"] | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const held = asObject(raw);
  return {
    since: stringField(held, "since") ?? "",
    reason: stringField(held, "reason") ?? "no_capacity",
    ahead: aheadOf(held),
  };
}

/** `ahead` from the 202; the status route's `position` (1-based) when that answered. */
function aheadOf(held: Record<string, unknown>): number {
  if (typeof held.ahead === "number") {
    return held.ahead;
  }
  return typeof held.position === "number" ? Math.max(0, held.position - 1) : 0;
}

/** atrium answered, and not with a 2xx: report it as the direct path would have, never fall back. */
function refusalOf(status: number, body: unknown, record: SessionRecord): Error {
  const value = asObject(body);
  const code = stringField(value, "code");
  if (code === "SESSION_CLOSED") {
    return new SessionClosedError(record.acpxRecordId);
  }
  const text = stringField(value, "error") ?? stringField(value, "message") ?? textOf(body);
  return new AcpxOperationalError(
    `atrium's message queue refused the message (HTTP ${status}${code ? ` ${code}` : ""}): ${text}`,
    {
      outputCode: status === 404 ? "NO_SESSION" : "RUNTIME",
      ...(code ? { detailCode: code } : {}),
      origin: "runtime",
    },
  );
}
