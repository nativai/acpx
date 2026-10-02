/**
 * The Claude adapter's model advertisement — probed, cached in a FILE, keyed by
 * the deployed adapter version (brick ebfe4c3c, CONTRACT §4).
 *
 * WHAT IT IS FOR. Every pre-session surface (acpx-ui's create dialog, template
 * editor, header switcher) and `acpx models` print Claude rows before any session
 * exists, so there is no session record to read a label off. Their source is this
 * file: the RAW `model` options the bundled Claude Code binary advertised on a
 * transient session (no prompt, no tokens, no record — `readTransientAdvertisement`).
 * Labels are derived at READ time (`claude-advertised-label.ts`), so a fix to the
 * derivation never needs a re-probe.
 *
 * Daniel's caching requirements (CONTENT.md), which are why it is shaped this way:
 *   · strongly cached in a file;
 *   · AT MOST ONE PROBE PER DEPLOY — never per session, never per turn;
 *   · stale is acceptable;
 *   · an easy, straightforward manual refresh (`acpx models --refresh`).
 *
 * So a probe runs ONLY when:
 *   · `force`     — `acpx models --refresh`, in the foreground;
 *   · `if-needed` — inside the DETACHED warm child (`acpx models --warm`), when the
 *                   deployed key moved, the cache is missing, or a failed key's
 *                   1 h retry window has passed; a 5 min sentinel bounds racing children.
 * Every other caller passes `never` and only READS the file — which is three
 * small local reads (this cache, `info.json`, the SDK's `package.json`) and is
 * therefore safe on the session-create path. C4 §7.1 forbids blocking a create on
 * a third-party FETCH; nothing here fetches unless the caller asked to probe.
 *
 * 🛑 THERE IS NEVER A HARDCODED VERSION IN ANY STATE. A box with no good probe
 * shows version-free alias names (`state: "none"`); a failed re-probe keeps the
 * LAST GOOD options, labelled with the key they were probed from (`stale`).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_ACP_FORK_COMMAND, resolveClaudeAcpCommand } from "../agent-registry.js";
import {
  advertisedModelOptions,
  parseAdvertisedOptions,
  type AdvertisedModelOption,
} from "./claude-advertised-label.js";
import type { ClaudeAdvertisementStatus } from "./types.js";

export const CLAUDE_ADVERT_SCHEMA = "acpx.claude-advertisement.v1";

/** `ACPX_RUNTIME_INFO_PATH` overrides it — the tests' seam; the suite scrub points it at nothing. */
export const DEFAULT_RUNTIME_INFO_PATH = "/workspace/.runtime/info.json";

/** Measured probe: ~1.4–2.7 s (CONTRACT §4.1 iv). The bound, not the expectation. */
export const CLAUDE_PROBE_TIMEOUT_MS = 60_000;

/** A second AUTOMATIC probe inside this window is suppressed; `force` ignores it. */
export const CLAUDE_PROBE_COOLDOWN_MS = 5 * 60_000;

/** A key whose probe failed is retried automatically only after this long. */
export const CLAUDE_FAILED_KEY_RETRY_MS = 60 * 60_000;

/**
 * The canned-input seam (the `ACPX_TEST_CODEX_QUOTA_JSON` precedent): a FILE whose
 * model options the probe returns instead of spawning the adapter. Set for the whole
 * suite by `scripts/run-tests.mjs`; also the test-engineer's "different
 * advertisement" lever. Rows it produces carry `source: "fixture"`, so a canned
 * advertisement can never pass for a measured one.
 */
export const TEST_ADVERT_ENV = "ACPX_TEST_CLAUDE_ADVERT_JSON";

export type ClaudeAdvertKey = {
  adapterSha: string | null;
  sdkVersion: string | null;
  agentCommand: string;
};

export type ClaudeAdvertSource = "probe" | "fixture";

/**
 * `retryAfter` is the end of the failed key's backoff window, WRITTEN INTO THE
 * RECORD so an operator reading the file sees when the next automatic probe may
 * run. It is bounded: never later than `at` + {@link CLAUDE_FAILED_KEY_RETRY_MS},
 * so a box whose post-deploy probe failed retries on its own and cannot sit on
 * alias-only labels until someone runs `--refresh`.
 */
export type ClaudeAdvertFailure = {
  at: string;
  retryAfter: string;
  message: string;
  key: ClaudeAdvertKey;
};

/** Schema v1 — the RAW advertisement, never labels. */
export type ClaudeAdvertCache = {
  schema: typeof CLAUDE_ADVERT_SCHEMA;
  key: ClaudeAdvertKey | null;
  probedAt: string | null;
  source: ClaudeAdvertSource | null;
  options: AdvertisedModelOption[];
  lastFailure: ClaudeAdvertFailure | null;
};

/** The last GOOD advertisement, as `harnessNativeModels` consumes it. */
export type ClaudeAdvertisementSnapshot = {
  options: AdvertisedModelOption[];
  adapterSha: string | null;
  sdkVersion: string | null;
  probedAt: string;
  source: ClaudeAdvertSource;
};

export type ClaudeProbeMode = "never" | "if-needed" | "force";

export type ClaudeProbeResult = { options: AdvertisedModelOption[]; source: ClaudeAdvertSource };

export type ClaudeAdvertDeps = {
  cachePath?: string;
  runtimeInfoPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** The adapter command the key describes; default `resolveClaudeAcpCommand(env)`. */
  agentCommand?: string;
};

export type EnsureClaudeAdvertisementOptions = ClaudeAdvertDeps & {
  mode: ClaudeProbeMode;
  /** Injected in tests; default {@link probeClaudeAdvertisement}. */
  probe?: (key: ClaudeAdvertKey) => Promise<ClaudeProbeResult>;
};

export type ClaudeAdvertisementView = {
  snapshot: ClaudeAdvertisementSnapshot | null;
  status: ClaudeAdvertisementStatus;
};

// ── Paths ────────────────────────────────────────────────────────────────────

function stateRoot(env: NodeJS.ProcessEnv): string {
  return env.ACPX_STATE_HOME?.trim() || env.HOME?.trim() || os.homedir();
}

/** Same resolution order as `defaultCatalogueCachePath`, including the `env` it is asked about. */
export function defaultClaudeAdvertCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACPX_CLAUDE_ADVERT_CACHE?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(stateRoot(env), ".acpx", "claude-advertisement.json");
}

export function runtimeInfoPathFor(env: NodeJS.ProcessEnv = process.env): string {
  return env.ACPX_RUNTIME_INFO_PATH?.trim() || DEFAULT_RUNTIME_INFO_PATH;
}

/**
 * A NEUTRAL, EMPTY cwd for the probe. A project cwd could carry project-level
 * Claude settings (`availableModels`) that change the advertised list, and this
 * cache is box-wide.
 */
export function claudeProbeCwd(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateRoot(env), ".acpx", "claude-probe");
}

function probingSentinelPath(cachePath: string): string {
  return `${cachePath}.probing`;
}

// ── The version key ──────────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * `info.json` is a FLAT object keyed by project (`{sha,state,ref,deployed}`) —
 * a `.projects[]` read returns nothing.
 */
function readDeployedAdapterSha(runtimeInfoPath: string): string | null {
  const entry = asObject(asObject(readJsonFile(runtimeInfoPath))?.["claude-agent-acp"]);
  return nonEmptyString(entry?.sha);
}

/** `<adapterRoot>/node_modules/@anthropic-ai/claude-agent-sdk/package.json`, adapterRoot = the script's grandparent. */
function readSdkVersion(agentCommand: string): string | null {
  const script = agentCommand
    .split(/\s+/)
    .find((token) => path.isAbsolute(token) && /\.[cm]?js$/.test(token));
  if (script === undefined) {
    return null;
  }
  const adapterRoot = path.dirname(path.dirname(script));
  const manifest = path.join(
    adapterRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "package.json",
  );
  return nonEmptyString(asObject(readJsonFile(manifest))?.version);
}

/**
 * What is deployed NOW. `adapterSha` applies only to the deployed default
 * command: under an `ACPX_CLAUDE_ACP_COMMAND` override, `info.json` describes a
 * different binary, so it is `null` and the key rests on `sdkVersion` +
 * `agentCommand`. ⚠️ Consequence, documented rather than engineered around: an
 * adapter-code-only swap at the same path with no info.json does not re-key — run
 * `acpx models --refresh` after one.
 */
export function currentClaudeAdvertKey(deps: ClaudeAdvertDeps = {}): ClaudeAdvertKey {
  const env = deps.env ?? process.env;
  const agentCommand = deps.agentCommand ?? resolveClaudeAcpCommand(env);
  return {
    adapterSha:
      agentCommand === CLAUDE_ACP_FORK_COMMAND
        ? readDeployedAdapterSha(deps.runtimeInfoPath ?? runtimeInfoPathFor(env))
        : null,
    sdkVersion: readSdkVersion(agentCommand),
    agentCommand,
  };
}

export function sameClaudeAdvertKey(
  a: ClaudeAdvertKey | null | undefined,
  b: ClaudeAdvertKey | null | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.adapterSha === b.adapterSha &&
    a.sdkVersion === b.sdkVersion &&
    a.agentCommand === b.agentCommand
  );
}

// ── The cache file ───────────────────────────────────────────────────────────

function parseKey(value: unknown): ClaudeAdvertKey | null {
  const key = asObject(value);
  const agentCommand = nonEmptyString(key?.agentCommand);
  if (!key || agentCommand === null) {
    return null;
  }
  return {
    adapterSha: nonEmptyString(key.adapterSha),
    sdkVersion: nonEmptyString(key.sdkVersion),
    agentCommand,
  };
}

function parseSource(value: unknown): ClaudeAdvertSource | null {
  return value === "probe" || value === "fixture" ? value : null;
}

function parseFailure(value: unknown): ClaudeAdvertFailure | null {
  const failure = asObject(value);
  const key = parseKey(failure?.key);
  const at = nonEmptyString(failure?.at);
  if (!failure || key === null || at === null) {
    return null;
  }
  return {
    at,
    retryAfter: nonEmptyString(failure.retryAfter) ?? retryAfterFor(Date.parse(at)),
    message: typeof failure.message === "string" ? failure.message : "",
    key,
  };
}

function retryAfterFor(failedAt: number): string {
  const at = Number.isFinite(failedAt) ? failedAt : 0;
  return new Date(at + CLAUDE_FAILED_KEY_RETRY_MS).toISOString();
}

/** Unreadable, garbled or foreign-schema = no cache. Never throws. */
export function readClaudeAdvertCache(cachePath: string): ClaudeAdvertCache | null {
  const parsed = asObject(readJsonFile(cachePath));
  if (!parsed || parsed.schema !== CLAUDE_ADVERT_SCHEMA) {
    return null;
  }
  return {
    schema: CLAUDE_ADVERT_SCHEMA,
    key: parseKey(parsed.key),
    probedAt: nonEmptyString(parsed.probedAt),
    source: parseSource(parsed.source),
    options: Array.isArray(parsed.options) ? parseAdvertisedOptions(parsed.options) : [],
    lastFailure: parseFailure(parsed.lastFailure),
  };
}

/**
 * Atomic: a unique temp file, then `rename`. `pid.Date.now()` alone collides
 * (`session/persistence/index.ts` records the incident), hence the uuid.
 * Multi-process is last-writer-wins, harmless — both writers hold a valid probe.
 */
function writeClaudeAdvertCache(cachePath: string, cache: ClaudeAdvertCache): void {
  const tmp = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
    fs.renameSync(tmp, cachePath);
  } catch {
    // Best-effort: an unwritable cache costs a re-probe later, never a failed
    // listing. The answer this process prints is still the one it just measured.
    fs.rmSync(tmp, { force: true });
  }
}

function hasGoodAdvertisement(cache: ClaudeAdvertCache | null): cache is ClaudeAdvertCache & {
  key: ClaudeAdvertKey;
  probedAt: string;
  source: ClaudeAdvertSource;
} {
  return (
    !!cache &&
    cache.key !== null &&
    cache.probedAt !== null &&
    cache.source !== null &&
    cache.options.length > 0
  );
}

// ── When to probe ────────────────────────────────────────────────────────────

/**
 * The automatic-probe decision, on file content only.
 *
 * ⚠️ A RECENT FAILURE FOR THE DEPLOYED KEY WINS OVER "THE KEY MOVED". After a
 * deploy whose probe fails, the cached key stays the OLD one, so "key ≠ current"
 * stays true — read alone it would re-probe on every warm, i.e. per session
 * create through the side door. The failed key waits its 1 h retry window instead
 * (TEST-MATRIX D-6).
 */
function needsProbe(cache: ClaudeAdvertCache | null, key: ClaudeAdvertKey, now: number): boolean {
  if (cache === null) {
    return true;
  }
  const failure = cache.lastFailure;
  if (failure && sameClaudeAdvertKey(failure.key, key)) {
    return !insideRetryWindow(failure, now);
  }
  return !sameClaudeAdvertKey(cache.key, key);
}

/**
 * Bounded at BOTH ends, like the warm sentinel: a failure stamped in the future
 * (clock step, copied file) does not suppress the retry, and a `retryAfter` past
 * the 1 h bound (a hand-edited file) is capped to it.
 */
function insideRetryWindow(failure: ClaudeAdvertFailure, now: number): boolean {
  const failedAt = Date.parse(failure.at);
  const recorded = Date.parse(failure.retryAfter);
  const retryAt = Math.min(
    Number.isFinite(recorded) ? recorded : Number.POSITIVE_INFINITY,
    failedAt + CLAUDE_FAILED_KEY_RETRY_MS,
  );
  return now >= failedAt && now < retryAt;
}

/** The warm predicate's third term (`catalogueNeedsWarm`): file reads only, no socket, no child. */
export function claudeAdvertisementNeedsProbe(deps: ClaudeAdvertDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  const cache = readClaudeAdvertCache(deps.cachePath ?? defaultClaudeAdvertCachePath(env));
  return needsProbe(cache, currentClaudeAdvertKey({ ...deps, env }), now);
}

/**
 * The sentinel's CONTENT is the epoch-ms stamp — one clock, the caller's `now`
 * (the `warmedRecently` rule in `catalogue-warm.ts`), never the file's mtime.
 */
function probedRecently(sentinel: string, now: number): boolean {
  try {
    const stamped = Number.parseInt(fs.readFileSync(sentinel, "utf8").trim(), 10);
    const elapsed = now - stamped;
    return Number.isFinite(stamped) && elapsed >= 0 && elapsed < CLAUDE_PROBE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function stampProbeSentinel(cachePath: string, now: number): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(probingSentinelPath(cachePath), String(now));
  } catch {
    // Best-effort, like the warm sentinel.
  }
}

/**
 * Claim the next AUTOMATIC probe. An absent sentinel is claimed by an exclusive
 * create, so of N warm children racing a fresh deploy exactly one probes.
 * Residual, by design: two children finding the SAME expired sentinel at the same
 * instant can both proceed — a redundant probe, never a wrong cache.
 */
function claimAutomaticProbe(cachePath: string, now: number): boolean {
  const sentinel = probingSentinelPath(cachePath);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(sentinel, String(now), { flag: "wx" });
    return true;
  } catch {
    // Exists (or unwritable): fall through to the cooldown read.
  }
  if (probedRecently(sentinel, now)) {
    return false;
  }
  stampProbeSentinel(cachePath, now);
  return true;
}

function shouldProbe(
  mode: ClaudeProbeMode,
  cache: ClaudeAdvertCache | null,
  key: ClaudeAdvertKey,
  cachePath: string,
  now: number,
): boolean {
  if (mode === "never") {
    return false;
  }
  if (mode === "force") {
    // `--refresh` stamps the sentinel but ignores it when deciding.
    stampProbeSentinel(cachePath, now);
    return true;
  }
  return needsProbe(cache, key, now) && claimAutomaticProbe(cachePath, now);
}

// ── The probe ────────────────────────────────────────────────────────────────

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The fixture file: `{"options":[{value,name,description}, …]}`, a bare options
 * array, or a `config_options` array carrying the `model` select.
 */
function readFixtureOptions(fixturePath: string): AdvertisedModelOption[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const fromConfig = Array.isArray(parsed) ? advertisedModelOptions(parsed) : undefined;
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  const entries = Array.isArray(parsed) ? parsed : asObject(parsed)?.options;
  if (!Array.isArray(entries)) {
    throw new Error(`${TEST_ADVERT_ENV} fixture ${fixturePath} carries no "options" array`);
  }
  return parseAdvertisedOptions(entries);
}

/**
 * Read the claude adapter's `model` options off a transient session — or off the
 * `ACPX_TEST_CLAUDE_ADVERT_JSON` fixture when that is set.
 *
 * Credentials are the NORMAL spawn resolution (the registry default
 * subscription's config dir) so the probe sees the text sessions see. With none,
 * the binary advertises its API form ("Use the default model (currently Opus
 * 5.5) · $4/$20 per Mtok") — the LABELS are identical either way (CONTRACT §4.1 iii).
 */
export async function probeClaudeAdvertisement(params: {
  agentCommand: string;
  env?: NodeJS.ProcessEnv;
  authCredentials?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ClaudeProbeResult> {
  const env = params.env ?? process.env;
  const fixture = env[TEST_ADVERT_ENV]?.trim();
  if (fixture) {
    return { options: readFixtureOptions(fixture), source: "fixture" };
  }
  const cwd = claudeProbeCwd(env);
  fs.mkdirSync(cwd, { recursive: true });
  // Loaded on demand: the catalogue (and so the session-create path) reads this
  // module for its cache, and must not pay for the ACP client to do so.
  const { readTransientAdvertisement } = await import("../acp/transient-advertisement.js");
  const configOptions = await readTransientAdvertisement({
    agentCommand: params.agentCommand,
    cwd,
    authCredentials: params.authCredentials,
    timeoutMs: params.timeoutMs ?? CLAUDE_PROBE_TIMEOUT_MS,
  });
  return { options: advertisedModelOptions(configOptions) ?? [], source: "probe" };
}

/**
 * A failed probe NEVER touches `options`, `key`, `probedAt` or `source` of the
 * last good one — it only sets `lastFailure`.
 */
async function runProbe(params: {
  probe: (key: ClaudeAdvertKey) => Promise<ClaudeProbeResult>;
  cache: ClaudeAdvertCache | null;
  key: ClaudeAdvertKey;
  cachePath: string;
  now: () => number;
}): Promise<ClaudeAdvertCache> {
  let next: ClaudeAdvertCache;
  try {
    const result = await params.probe(params.key);
    if (result.options.length === 0) {
      throw new Error("the adapter advertised no `model` options");
    }
    next = {
      schema: CLAUDE_ADVERT_SCHEMA,
      key: params.key,
      probedAt: new Date(params.now()).toISOString(),
      source: result.source,
      options: result.options,
      lastFailure: null,
    };
  } catch (error) {
    next = {
      ...(params.cache ?? emptyCache()),
      lastFailure: failureAt(params.now(), asMessage(error), params.key),
    };
  }
  writeClaudeAdvertCache(params.cachePath, next);
  return next;
}

function failureAt(now: number, message: string, key: ClaudeAdvertKey): ClaudeAdvertFailure {
  return { at: new Date(now).toISOString(), retryAfter: retryAfterFor(now), message, key };
}

function emptyCache(): ClaudeAdvertCache {
  return {
    schema: CLAUDE_ADVERT_SCHEMA,
    key: null,
    probedAt: null,
    source: null,
    options: [],
    lastFailure: null,
  };
}

function snapshotOf(cache: ClaudeAdvertCache | null): ClaudeAdvertisementSnapshot | null {
  if (!hasGoodAdvertisement(cache)) {
    return null;
  }
  return {
    options: cache.options,
    adapterSha: cache.key.adapterSha,
    sdkVersion: cache.key.sdkVersion,
    probedAt: cache.probedAt,
    source: cache.source,
  };
}

function stateOf(
  cache: ClaudeAdvertCache | null,
  key: ClaudeAdvertKey,
): ClaudeAdvertisementStatus["state"] {
  if (!hasGoodAdvertisement(cache)) {
    return "none";
  }
  return sameClaudeAdvertKey(cache.key, key) ? "fresh" : "stale";
}

/** The last failure's message — only when it was a failure FOR THE DEPLOYED KEY. */
function currentKeyError(cache: ClaudeAdvertCache | null, key: ClaudeAdvertKey): string | null {
  const failure = cache?.lastFailure;
  return failure && sameClaudeAdvertKey(failure.key, key) ? failure.message : null;
}

function viewOf(cache: ClaudeAdvertCache | null, key: ClaudeAdvertKey): ClaudeAdvertisementView {
  const snapshot = snapshotOf(cache);
  return {
    snapshot,
    status: {
      state: stateOf(cache, key),
      probedAt: snapshot ? snapshot.probedAt : null,
      adapterSha: snapshot ? snapshot.adapterSha : null,
      sdkVersion: snapshot ? snapshot.sdkVersion : null,
      source: snapshot ? snapshot.source : null,
      deployedAdapterSha: key.adapterSha,
      deployedSdkVersion: key.sdkVersion,
      error: currentKeyError(cache, key),
    },
  };
}

/** The envelope for a catalogue built with no advertisement information at all. */
export const CLAUDE_ADVERTISEMENT_UNKNOWN: ClaudeAdvertisementStatus = {
  state: "none",
  probedAt: null,
  adapterSha: null,
  sdkVersion: null,
  source: null,
  deployedAdapterSha: null,
  deployedSdkVersion: null,
  error: null,
};

/**
 * Read the cache and — only when `mode` asks for it — probe first. Returns the
 * snapshot the rows are built from and the envelope that describes it.
 */
export async function ensureClaudeAdvertisement(
  options: EnsureClaudeAdvertisementOptions,
): Promise<ClaudeAdvertisementView> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const cachePath = options.cachePath ?? defaultClaudeAdvertCachePath(env);
  const key = currentClaudeAdvertKey({ ...options, env });
  const cache = readClaudeAdvertCache(cachePath);
  if (!shouldProbe(options.mode, cache, key, cachePath, now())) {
    return viewOf(cache, key);
  }
  const probe =
    options.probe ??
    ((probeKey: ClaudeAdvertKey) =>
      probeClaudeAdvertisement({ agentCommand: probeKey.agentCommand, env }));
  return viewOf(await runProbe({ probe, cache, key, cachePath, now }), key);
}
