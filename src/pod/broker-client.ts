import { readFileSync } from "node:fs";
import { parseNamespaceFromResolvConf, SERVICE_ACCOUNT_NAMESPACE_FILE } from "../acp/auth-env.js";

/**
 * C4 — the caller side of the broker's API for kind `agent` (port 8081).
 * Model: `workbench-exec`'s `wbx3_broker_post` (argocd-master-application,
 * tool-containers/dev-server-common/workbench-exec).
 *
 * The caller may stop reading at any time and the Job continues: `ensureAgentPod` stops at the
 * wake bound and says which step it had reached. A second POST for the same key follows the same Job.
 */

export const AGENT_BROKER_PORT = 8081;
export const AGENT_BROKER_CONTRACT = 1;
/** C2 "wake bound" — spike (g), set. Fault runs may still move it: this constant is the one place. */
export const WAKE_BOUND_MS = 20_000;
/** How long the broker may take to start answering at all before it counts as "did not answer". */
const BROKER_CONNECT_BOUND_MS = 5_000;
const GET_AGENTS_BOUND_MS = 5_000;

export const BROKER_STEPS = [
  "scheduling",
  "scaling-up",
  "pool-at-maximum",
  "pulling",
  "starting",
] as const;
export type BrokerStep = (typeof BROKER_STEPS)[number];

export const BROKER_REFUSED_REASONS = ["agent_cap", "quota", "home_full", "too_big"] as const;
export type BrokerRefusedReason = (typeof BROKER_REFUSED_REASONS)[number];

export type AgentHarness = "claude" | "pi" | "codex" | "claude-pty" | "utility";
export type AgentPlacement = "pool" | "home" | "auto";
export type BrokerAgentClass = "interactive" | "spawn" | "automation" | "utility";

/** The C4 request body of `POST /v1/agents/<key>`. */
export type BrokerAgentRequest = {
  contract: typeof AGENT_BROKER_CONTRACT;
  sessionId: string;
  seat: string;
  harness: AgentHarness;
  placement: AgentPlacement;
  class: BrokerAgentClass;
  /** C9: `{"<tool>":"<release directory name>"}`. */
  releases: Record<string, string>;
  sessionUrl?: string;
  sessionName?: string;
  brick?: string;
};

export type BrokerEnsureResult =
  | {
      kind: "ready";
      ip: string;
      pod: string;
      uid: string;
      node: string;
      placement: "pool" | "home";
    }
  | { kind: "refused"; reason: BrokerRefusedReason; live: number; cap: number }
  /** A named failure of the request itself: `unsupported_contract`, `template_rejected`, `start_failed`, … */
  | { kind: "error"; reason: string; detail: string }
  /** The wake bound passed while the Job was still on its way; `phase` is the last step the broker sent. */
  | { kind: "wake_bound"; phase: BrokerStep | undefined }
  /** The broker did not answer, or answered with something that is no answer (→ `admission_busy`). */
  | { kind: "unavailable"; detail: string };

export type BrokerAgentsSnapshot = {
  live: number;
  cap: number;
  reserve: number;
  quota: { used: number; hard: number };
  home: { live: number; cap: number };
  pool: { state: string };
};

export type BrokerAgentsResult =
  | { ok: true; agents: BrokerAgentsSnapshot }
  | { ok: false; detail: string };

export type BrokerClientOptions = {
  /** `http://workbench-broker.<namespace>.svc.cluster.local:8081` — see `resolveAgentBrokerOrigin`. */
  origin: string;
  fetchImpl?: typeof fetch;
  wakeBoundMs?: number;
  /** Called once per distinct progress step, in order. */
  onStep?: (step: BrokerStep) => void;
};

const AGENT_KEY_RE = /^([0-9a-f]{24}|util-pool|util-home)$/;

export type AgentBrokerOriginSources = { namespaceFile?: string; resolvConf?: string };

function readOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function readAgentBrokerOriginSources(): AgentBrokerOriginSources {
  return {
    namespaceFile: readOrUndefined(SERVICE_ACCOUNT_NAMESPACE_FILE),
    resolvConf: readOrUndefined("/etc/resolv.conf"),
  };
}

/** This box's namespace (`dev-<box>`): the service-account file, else resolv.conf's search line. */
export function namespaceFromSources(sources: AgentBrokerOriginSources): string | undefined {
  const fromFile = sources.namespaceFile?.trim();
  if (fromFile) {
    return fromFile;
  }
  return sources.resolvConf ? parseNamespaceFromResolvConf(sources.resolvConf) : undefined;
}

/**
 * The broker's agent listener. `NV_AGENT_BROKER_URL` steers it ONLY under `NODE_TEST_CONTEXT`
 * (the test seam of C1.1's kind); in production the address is built from the box's namespace and
 * nothing in the environment can point acpx at another broker.
 */
export function resolveAgentBrokerOrigin(
  env: NodeJS.ProcessEnv,
  sources: AgentBrokerOriginSources,
): string | undefined {
  if (env.NODE_TEST_CONTEXT !== undefined) {
    const seam = env.NV_AGENT_BROKER_URL?.trim().replace(/\/+$/, "");
    if (seam) {
      return seam;
    }
  }
  const namespace = namespaceFromSources(sources);
  return namespace
    ? `http://workbench-broker.${namespace}.svc.cluster.local:${AGENT_BROKER_PORT}`
    : undefined;
}

/** `dev-<box>` → `<box>`; the `box=` field of the `agent_cap` line. */
export function boxOfNamespace(namespace: string | undefined): string {
  return namespace?.replace(/^dev-/, "") || "unknown";
}

type ParsedLine = {
  event: string;
  tokens: Map<string, string>;
  positional: string[];
  text: string;
};

/** `<event> [<word>] key=value … [-- free text]`, as `wbx3_event` reads a seat's stream. */
function parseLine(raw: string): ParsedLine | undefined {
  const line = raw.replace(/\r$/, "");
  if (line.length === 0) {
    return undefined;
  }
  const sep = line.indexOf(" -- ");
  const head = sep >= 0 ? line.slice(0, sep) : line;
  const text = sep >= 0 ? line.slice(sep + 4) : "";
  const words = head.split(/\s+/).filter((word) => word.length > 0);
  const tokens = new Map<string, string>();
  const positional: string[] = [];
  for (const word of words.slice(1)) {
    const eq = word.indexOf("=");
    if (eq > 0) {
      tokens.set(word.slice(0, eq), word.slice(eq + 1));
    } else {
      positional.push(word);
    }
  }
  return { event: words[0] ?? "", tokens, positional, text };
}

function cleanText(value: string): string {
  // Broker free text reaches a terminal and a record: printable ASCII, bounded.
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
}

function intToken(parsed: ParsedLine, name: string): number | undefined {
  const raw = parsed.tokens.get(name);
  return raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : undefined;
}

type Terminal = Exclude<BrokerEnsureResult, { kind: "wake_bound" } | { kind: "unavailable" }>;

const IP_RE = /^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-fA-F]*:[0-9a-fA-F:]+$/;

function malformed(reason: string, detail: string): Terminal {
  return { kind: "error", reason, detail };
}

function isReadyComplete(
  ip: string,
  uid: string,
  pod: string,
  placement: string | undefined,
): placement is "pool" | "home" {
  const known = IP_RE.test(ip) && /^[0-9a-f-]{36}$/.test(uid) && pod.length > 0;
  return known && (placement === "pool" || placement === "home");
}

function readyTerminal(parsed: ParsedLine): Terminal {
  const ip = parsed.tokens.get("ip") ?? "";
  const pod = parsed.tokens.get("pod") ?? "";
  const uid = parsed.tokens.get("uid") ?? "";
  const node = parsed.tokens.get("node") ?? "";
  const placement = parsed.tokens.get("placement");
  if (!isReadyComplete(ip, uid, pod, placement)) {
    return malformed("malformed_ready", "the broker's ready line is incomplete");
  }
  return { kind: "ready", ip, pod, uid, node, placement };
}

function refusedTerminal(parsed: ParsedLine): Terminal {
  const reason = parsed.tokens.get("reason") ?? "";
  const live = intToken(parsed, "live");
  const cap = intToken(parsed, "cap");
  if (
    !(BROKER_REFUSED_REASONS as readonly string[]).includes(reason) ||
    live === undefined ||
    cap === undefined
  ) {
    return malformed("malformed_refused", "the broker's refusal is incomplete");
  }
  return { kind: "refused", reason: reason as BrokerRefusedReason, live, cap };
}

function terminalOf(parsed: ParsedLine): Terminal | undefined {
  if (parsed.event === "ready") {
    return readyTerminal(parsed);
  }
  if (parsed.event === "refused") {
    return refusedTerminal(parsed);
  }
  if (parsed.event === "error") {
    return {
      kind: "error",
      reason: parsed.positional[0] ?? "error",
      detail: cleanText(parsed.text),
    };
  }
  return undefined;
}

function isStep(value: string): value is BrokerStep {
  return (BROKER_STEPS as readonly string[]).includes(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Reads the streamed lines; the first final line wins; the abort of the wake bound ends it. */
class StreamReader {
  phase: BrokerStep | undefined;
  private pending = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly onStep: ((step: BrokerStep) => void) | undefined) {}

  /** One line: a final answer, or undefined (progress, an unknown line, an empty one). */
  line(raw: string): Terminal | undefined {
    const parsed = parseLine(raw);
    if (!parsed) {
      return undefined;
    }
    const terminal = terminalOf(parsed);
    if (terminal) {
      return terminal;
    }
    // Unknown progress is forward-compatible and ignored (C4 rule 2).
    if (isStep(parsed.event) && parsed.event !== this.phase) {
      this.phase = parsed.event;
      this.onStep?.(parsed.event);
    }
    return undefined;
  }

  chunk(value: Uint8Array, done: boolean): Terminal | undefined {
    this.pending += this.decoder.decode(value, { stream: !done });
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const terminal = this.line(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      if (terminal) {
        return terminal;
      }
      newline = this.pending.indexOf("\n");
    }
    return undefined;
  }

  rest(): Terminal | undefined {
    return this.line(this.pending);
  }
}

/** Reads until a final line, the end of the stream, or the abort of the wake bound. */
async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stream: StreamReader,
): Promise<Terminal | "ended" | BrokerEnsureResult> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const terminal = value ? stream.chunk(value, done) : undefined;
      if (terminal) {
        return terminal;
      }
      if (done) {
        return "ended";
      }
    }
  } catch (error) {
    if (isAbort(error)) {
      return { kind: "wake_bound", phase: stream.phase };
    }
    return { kind: "unavailable", detail: "the answer broke off" };
  }
}

async function readAnswer(response: Response, stream: StreamReader): Promise<BrokerEnsureResult> {
  const reader = response.body?.getReader();
  if ((!response.ok && response.status >= 500) || !reader) {
    return { kind: "unavailable", detail: `http ${response.status}` };
  }
  const drained = await drain(reader, stream);
  if (drained !== "ended") {
    return drained;
  }
  const last = stream.rest();
  if (last) {
    return last;
  }
  if (!response.ok) {
    // A 4xx that names nothing: the request itself was not accepted.
    return {
      kind: "error",
      reason: `http_${response.status}`,
      detail: "the broker refused the request",
    };
  }
  return { kind: "unavailable", detail: "the answer ended without a result" };
}

/** Aborts the request at the wake bound, and earlier when nothing has answered at all. */
function boundsOf(controller: AbortController, wakeBoundMs: number) {
  let gotHeaders = false;
  const wake = setTimeout(() => controller.abort(), wakeBoundMs);
  const connect = setTimeout(
    () => {
      if (!gotHeaders) {
        controller.abort();
      }
    },
    Math.min(BROKER_CONNECT_BOUND_MS, wakeBoundMs),
  );
  return {
    answered: () => {
      gotHeaders = true;
      clearTimeout(connect);
    },
    clear: () => {
      clearTimeout(wake);
      clearTimeout(connect);
    },
  };
}

async function postEnsure(
  url: string,
  request: BrokerAgentRequest,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response | BrokerEnsureResult> {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    return { kind: "unavailable", detail: isAbort(error) ? "no answer" : "connection failed" };
  }
}

/**
 * `POST /v1/agents/<key>`: streamed `text/plain`, one line per step, then exactly one final line.
 * Stops reading at the wake bound; the Job continues. Never throws: every way it can end is a result.
 */
export async function ensureAgentPod(
  key: string,
  request: BrokerAgentRequest,
  options: BrokerClientOptions,
): Promise<BrokerEnsureResult> {
  if (!AGENT_KEY_RE.test(key)) {
    return { kind: "error", reason: "invalid_key", detail: "not a session key" };
  }
  const controller = new AbortController();
  const bounds = boundsOf(controller, options.wakeBoundMs ?? WAKE_BOUND_MS);
  try {
    const url = `${options.origin}/v1/agents/${key}`;
    const response = await postEnsure(url, request, options.fetchImpl ?? fetch, controller.signal);
    if (!(response instanceof Response)) {
      return response;
    }
    bounds.answered();
    return await readAnswer(response, new StreamReader(options.onStep));
  } finally {
    bounds.clear();
    controller.abort();
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

type Obj = Record<string, unknown>;

function objOf(value: unknown): Obj | undefined {
  return value !== null && typeof value === "object" ? (value as Obj) : undefined;
}

const AGENT_COUNT_PATHS = [
  ["live"],
  ["cap"],
  ["reserve"],
  ["quota", "used"],
  ["quota", "hard"],
  ["home", "live"],
  ["home", "cap"],
] as const;

function parseAgents(body: unknown): BrokerAgentsSnapshot | undefined {
  const at = (path: readonly string[]) =>
    path.reduce<unknown>((value, key) => objOf(value)?.[key], body);
  const counts = AGENT_COUNT_PATHS.map(at);
  const poolState = at(["pool", "state"]);
  if (!counts.every(isCount) || typeof poolState !== "string") {
    return undefined;
  }
  const [live, cap, reserve, used, hard, homeLive, homeCap] = counts;
  return {
    live,
    cap,
    reserve,
    quota: { used, hard },
    home: { live: homeLive, cap: homeCap },
    pool: { state: poolState },
  };
}

/** `GET /v1/agents` — for A9; also what `agent_cap` at the wake bound reads its figures from. */
export async function getAgents(
  options: Pick<BrokerClientOptions, "origin" | "fetchImpl">,
): Promise<BrokerAgentsResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.origin}/v1/agents`, {
      signal: AbortSignal.timeout(GET_AGENTS_BOUND_MS),
    });
    if (!response.ok) {
      return { ok: false, detail: `http ${response.status}` };
    }
    const agents = parseAgents(await response.json());
    return agents ? { ok: true, agents } : { ok: false, detail: "malformed answer" };
  } catch {
    return { ok: false, detail: "no answer" };
  }
}
