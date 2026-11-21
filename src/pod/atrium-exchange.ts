import http from "node:http";

/**
 * One HTTP exchange with atrium, classified by how far it got (UMQ D1, CONTRACTS-r4 C6). Node
 * builtins only: both `src/cli/prompt-routing.ts` (which re-exports it) and the pod's call-home client
 * (`call-home.ts`, reached before acpx loads the world) use this one implementation.
 *
 * What an HTTP exchange with atrium came to. Only `connect-failure` means nothing was ever sent.
 */
export type AtriumExchange =
  /** An answer, whatever its status. `retryAfterS`: the `Retry-After` header, when it carried seconds. */
  | { kind: "response"; status: number; body: unknown; retryAfterS?: number }
  /** No connection was ever made: nothing was sent, the direct path is safe. */
  | { kind: "connect-failure"; reason: string }
  /** Connected, but no complete answer in time (or the connection broke): indeterminate — ask atrium. */
  | { kind: "no-answer"; reason: string };

/** `no-answer`'s reason when the answer timer (not a broken connection) ended the wait. */
export const NO_ANSWER_IN_TIME = "no answer in time";

/** Seconds the CLI waits for atrium's answer once connected (CONCEPTION §7.2). */
const ANSWER_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5_000;

/** A seam for rigs and tests only: the answer timeout in ms. */
function answerTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.ACPX_ROUTED_PROMPT_ANSWER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ANSWER_TIMEOUT_MS;
}

function retryAfterSeconds(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function atriumRequest(params: {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  env?: NodeJS.ProcessEnv;
  /** Overrides the answer wait (the pass-through waits for its own `deadline_ms` plus slack). */
  answerTimeoutMs?: number;
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
            const retryAfterS = retryAfterSeconds(response.headers["retry-after"]);
            finish({
              kind: "response",
              status: response.statusCode ?? 0,
              body,
              ...(retryAfterS === undefined ? {} : { retryAfterS }),
            });
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
      () => finish({ kind: "no-answer", reason: NO_ANSWER_IN_TIME }),
      params.answerTimeoutMs ?? answerTimeoutMs(env),
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
