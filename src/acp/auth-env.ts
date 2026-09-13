import { mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteBricksCredentialEnv } from "../bricks-credential.js";
import {
  hasKnownDeadAccounts,
  hasKnownDeadSubs,
  isAccountKnownDead,
  isSubscriptionKnownDead,
} from "../config/known-dead-subscriptions.js";
import {
  ensureProfileOsHarnessProvisioning,
  registryMayConfigureProvisioning,
  type ProvisioningWarningHandler,
} from "../config/os-harness-provisioning.js";
import {
  buildClaudeHomeMap,
  findProfile,
  getValidEffortsForProfile,
  isSubscriptionProfileLocked,
  loadProfileRegistry,
  transcriptAnchorDir,
  type ChatGptProfileEntry,
  type ClaudeHomeProfileEntry,
  type OpenRouterProfileEntry,
  type ProfileEntry,
  type ProfileRegistry,
  type SubscriptionProfileEntry,
} from "../config/profiles.js";
import { loadBoxProviders, resolveBoxProviderKey } from "../config/providers.js";
import type { SubscriptionLookupOptions } from "../config/subscriptions.js";
import {
  chooseSubscriptionConfigDir,
  findSubscription,
  isSubscriptionLocked,
  loadSubscriptionRegistry,
  subscriptionConfigDirExists,
} from "../config/subscriptions.js";
import type {
  ConfigDirChoice,
  SubscriptionEntry,
  SubscriptionRegistry,
} from "../config/subscriptions.js";
import { SubscriptionLockedError } from "../errors.js";
import type { AcpClientOptions } from "../types.js";
import { isClaudeFamilyAgent, isClaudePtyAgentCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";
import { isCodexAcpCommand } from "./codex-compat.js";
import { harnessIdForAgentCommand } from "./harness-capabilities.js";
import { isAcpxPerSessionConfigDir } from "./harness-config-dir.js";
import { ATTRIBUTION_LOG_FILENAME } from "./openrouter-attribution.js";
import { reportRoutingPolicyWarning, resolveBoxRouting } from "./openrouter-provider-policy.js";
import type { ShimHandle } from "./openrouter-shim.js";
import { spawnOpenRouterShim } from "./openrouter-shim.js";

const AUTH_ENV_PREFIX = "ACPX_AUTH_";
export const ACPX_EFFECTIVE_PROFILE_ENV = "ACPX_EFFECTIVE_PROFILE";
export const ACPX_EFFECTIVE_ACCOUNT_ENV = "ACPX_EFFECTIVE_ACCOUNT";
export const ACPX_EFFECTIVE_ADAPTER_ENV = "ACPX_EFFECTIVE_ADAPTER";
export const ACPX_EFFECTIVE_AUTH_MODE_ENV = "ACPX_EFFECTIVE_AUTH_MODE";
export const ACPX_EFFECTIVE_ANCHOR_ENV = "ACPX_EFFECTIVE_ANCHOR";
// The bricks-realm credential family and its strip live in ONE place for this repo — and they have
// to, because this file is only LAYER 2 of three. The two sites that spawn the brick CLI itself
// never reach this file at all. See src/bricks-credential.ts.
export { ACPX_BRICKS_CREDENTIAL_ENV_PREFIX } from "../bricks-credential.js";

export type EffectiveAccountMetadata = {
  effectiveAccount: string;
  effectiveProfile?: string;
  effectiveAdapter?: string;
  effectiveAuthMode?: string;
  effectiveAnchor?: string;
  effectiveResolutionMethod?: "path" | "selection";
};

/**
 * The claude-pty bridge's published session/new `_meta` selector key
 * (independent-claude-acp). This exact string is the bridge interface —
 * never introduce a second name.
 */
export const INDEPENDENT_CLAUDE_HOME_META_KEY = "independent-claude-acp/home";

/**
 * The claude-pty bridge's session/new `_meta` key carrying the parent session's
 * acpx-ui URL (lineage). The bridge reads this (parentSessionUrlFromMeta) and
 * forwards it to the claude child as ACPX_PARENT_SESSION_URL so the child can
 * message its parent back. Unlike the SDK claude adapter (which inherits the
 * parent from the spawn PROCESS env), one bridge PROCESS serves many ACP
 * sessions, so the parent must be delivered PER session — via this `_meta` —
 * not via the process env. This exact string is the bridge interface. (FW-18)
 */
export const INDEPENDENT_CLAUDE_PARENT_SESSION_URL_META_KEY =
  "independent-claude-acp/parent-session-url";

/** The bridge's server-side HOME allow-list env (JSON {id → abs home path}). */
export const INDEPENDENT_CLAUDE_HOME_MAP_ENV = "INDEPENDENT_CLAUDE_HOME_MAP";

function toEnvToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function nonEmptyEnvString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function effectiveResolutionMethod(authMode: string | undefined): "path" | "selection" | undefined {
  if (authMode === undefined) {
    return undefined;
  }
  return authMode === "openrouter" ? "selection" : "path";
}

export function effectiveAccountMetadataFromEnv(
  env: NodeJS.ProcessEnv,
): EffectiveAccountMetadata | undefined {
  const effectiveAccount = nonEmptyEnvString(env[ACPX_EFFECTIVE_ACCOUNT_ENV]);
  if (effectiveAccount === undefined) {
    return undefined;
  }
  const effectiveAuthMode = nonEmptyEnvString(env[ACPX_EFFECTIVE_AUTH_MODE_ENV]);
  return {
    effectiveAccount,
    ...(nonEmptyEnvString(env[ACPX_EFFECTIVE_PROFILE_ENV]) !== undefined
      ? { effectiveProfile: nonEmptyEnvString(env[ACPX_EFFECTIVE_PROFILE_ENV]) }
      : {}),
    ...(nonEmptyEnvString(env[ACPX_EFFECTIVE_ADAPTER_ENV]) !== undefined
      ? { effectiveAdapter: nonEmptyEnvString(env[ACPX_EFFECTIVE_ADAPTER_ENV]) }
      : {}),
    ...(effectiveAuthMode !== undefined ? { effectiveAuthMode } : {}),
    ...(nonEmptyEnvString(env[ACPX_EFFECTIVE_ANCHOR_ENV]) !== undefined
      ? { effectiveAnchor: nonEmptyEnvString(env[ACPX_EFFECTIVE_ANCHOR_ENV]) }
      : {}),
    ...(effectiveResolutionMethod(effectiveAuthMode) !== undefined
      ? { effectiveResolutionMethod: effectiveResolutionMethod(effectiveAuthMode) }
      : {}),
  };
}

function buildAuthEnvKey(methodId: string): string | undefined {
  const token = toEnvToken(methodId);
  return token.length > 0 ? `${AUTH_ENV_PREFIX}${token}` : undefined;
}

const authEnvKeyCache = new Map<string, string | undefined>();

function authEnvKey(methodId: string): string | undefined {
  const cached = authEnvKeyCache.get(methodId);
  if (cached !== undefined) {
    return cached;
  }
  const key = buildAuthEnvKey(methodId);
  authEnvKeyCache.set(methodId, key);
  return key;
}

export function readEnvCredential(methodId: string): string | undefined {
  const key = authEnvKey(methodId);
  if (!key) {
    return undefined;
  }
  const value = process.env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function promotePrefixedAuthEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(AUTH_ENV_PREFIX)) {
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }

    const normalized = key.slice(AUTH_ENV_PREFIX.length);
    if (!normalized || env[normalized] != null) {
      continue;
    }

    env[normalized] = value;
  }
}

/** PID 1's environment — NUL-separated `KEY=value`. */
export const PID1_ENVIRON_FILE = "/proc/1/environ";
/** The in-pod authoritative namespace (`dev-<box>`). */
export const SERVICE_ACCOUNT_NAMESPACE_FILE =
  "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
const RESOLV_CONF_FILE = "/etc/resolv.conf";

/** `search dev-<box>.svc.cluster.local …` → the `<box>` token. */
function boxTokenFromResolvConf(resolvConf: string): string | undefined {
  const match = resolvConf.match(/^search\s+(\S+)/m);
  if (!match) {
    return undefined;
  }
  return match[1].match(/^dev-([a-z0-9-]+)\.svc\.cluster\.local$/i)?.[1];
}

/** `search dev-konsiq.svc.cluster.local …` → `dev-konsiq`. Pure. */
export function parseNamespaceFromResolvConf(resolvConf: string): string | undefined {
  const box = boxTokenFromResolvConf(resolvConf);
  return box ? `dev-${box}` : undefined;
}

/** `KEY=value\0KEY2=value2\0` → the value of `name`. Pure. */
export function envValueFromEnviron(environ: string, name: string): string | undefined {
  for (const pair of environ.split("\0")) {
    const eq = pair.indexOf("=");
    if (eq <= 0 || pair.slice(0, eq) !== name) {
      continue;
    }
    const value = pair.slice(eq + 1).trim();
    if (value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * The box's CANONICAL public base URL from acpx-ui's hostmap cache — the entry
 * matching this namespace whose `source` is not `"alias"`. Mirrors acpx-ui's
 * `canonicalPublicBaseForNamespace` (`packages/hostmap/core/map.ts`), including
 * its `source !== "alias"` test, so a sourceless entry still counts as canonical.
 * acpx cannot import that package (different repo, no dependency on it), so the
 * ~15 lines are duplicated here rather than shared. Pure; any malformed or
 * unexpected shape is a miss, never a throw.
 */
function canonicalHostFromCacheEntry(entry: unknown, namespace: string): string | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { host, namespace: entryNamespace, source } = entry as Record<string, unknown>;
  if (entryNamespace !== namespace || source === "alias" || typeof host !== "string") {
    return undefined;
  }
  return nonEmptyEnvString(host);
}

export function canonicalBaseUrlFromHostmapCache(
  cacheJson: string,
  namespace: string,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cacheJson);
  } catch {
    return undefined;
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) {
    return undefined;
  }
  for (const entry of entries) {
    const host = canonicalHostFromCacheEntry(entry, namespace);
    if (host) {
      return `https://${host}`;
    }
  }
  return undefined;
}

/** The file contents each derivation rung consumes. Absent = that rung misses. */
export type BoxBaseUrlSources = {
  pid1Environ?: string;
  namespaceFile?: string;
  resolvConf?: string;
  hostmapCache?: string;
};

/** This box's namespace: the service-account file if present, else resolv.conf. */
function namespaceFromSources(sources: BoxBaseUrlSources): string | undefined {
  return (
    nonEmptyEnvString(sources.namespaceFile) ??
    (sources.resolvConf ? parseNamespaceFromResolvConf(sources.resolvConf) : undefined)
  );
}

/**
 * Rungs 2–3 of the ladder on `resolveAcpxUiBaseUrl`, as a pure function of the
 * file contents — so the ordering is testable without a filesystem or a box.
 * Undefined when both miss; the caller then throws rather than inventing a host.
 *
 * ⚠️ DO NOT ADD A RUNG THAT BUILDS A HOSTNAME OUT OF THE NAMESPACE. It reads as a
 * free safety net and it is the bug this function was cut back to remove. A rule
 * of the shape `https://acpx.${box}.nativai.de` hardcodes two things that are
 * CONFIGURATION, not structure: the service label (`acpx.`) and the order
 * (`nativai.de`). It is already the WRONG host on konsiq, labidio and tubeyakker,
 * which are canonically served at `acpx.devbox.konsiq.de` / `.labidio.de` /
 * `.tubeyakker.com` — a third TLD no hostname rule can reach — and it mints a DEAD
 * host on every box the moment the service label moves (brick f29ba473). resolv.conf
 * still feeds this ladder, but only the NAMESPACE, which is a key into the map of
 * hosts the fleet actually published — never a hostname of our own invention.
 * Red on reintroduction: "ladder: resolv.conf alone yields NOTHING — it supplies a
 * namespace, not a hostname" in `test/canonical-box-base-url.test.ts`.
 */
export function deriveBoxBaseUrlFrom(sources: BoxBaseUrlSources): string | undefined {
  const fromPid1 = sources.pid1Environ
    ? envValueFromEnviron(sources.pid1Environ, "ACPX_UI_BASE_URL")
    : undefined;
  if (fromPid1) {
    return fromPid1;
  }
  const namespace = namespaceFromSources(sources);
  return namespace && sources.hostmapCache
    ? canonicalBaseUrlFromHostmapCache(sources.hostmapCache, namespace)
    : undefined;
}

/** Read a file as UTF-8, or undefined when missing / unreadable. Never throws. */
function readFileOrUndefined(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * acpx-ui's hostmap cache. `ACPX_HOSTMAP_CACHE_FILE` overrides the default, matching
 * the knob acpx-ui's own `resolveHostmapCacheFile` honours when it WRITES the file —
 * if the two disagreed on the path we would read a cache nobody writes.
 */
function hostmapCacheFile(env: NodeJS.ProcessEnv): string {
  const explicit = nonEmptyEnvString(env.ACPX_HOSTMAP_CACHE_FILE);
  return explicit ? resolvePath(explicit) : join(homedir(), ".acpx", "hostmap-cache.json");
}

// Cache the box's files: none of them changes within a process, and this resolver
// runs on every spawn. Undefined = not yet read.
let cachedBoxBaseUrlSources: BoxBaseUrlSources | undefined;

function boxBaseUrlSources(env: NodeJS.ProcessEnv): BoxBaseUrlSources {
  cachedBoxBaseUrlSources ??= {
    pid1Environ: readFileOrUndefined(PID1_ENVIRON_FILE),
    namespaceFile: readFileOrUndefined(SERVICE_ACCOUNT_NAMESPACE_FILE),
    resolvConf: readFileOrUndefined(RESOLV_CONF_FILE),
    hostmapCache: readFileOrUndefined(hostmapCacheFile(env)),
  };
  return cachedBoxBaseUrlSources;
}

/**
 * What the warning below says. Every rung missed, so the ONE thing that can fix it
 * is configuration — name it, name the paths that were tried, and say plainly that
 * acpx declines to guess, so the reader does not "helpfully" add the guess back.
 * Carries NO example hostname on purpose: a "did you mean" here would be the
 * fabrication coming back in through the diagnostic.
 */
export function unresolvedBaseUrlMessage(hostmapCachePath: string): string {
  return [
    "[acpx] cannot determine this box's acpx-ui base URL —",
    "ACPX_SESSION_URL and ACPX_UI_BASE_URL will be left UNSET for spawned agents.",
    `Tried, in order: $ACPX_UI_BASE_URL; ACPX_UI_BASE_URL in ${PID1_ENVIRON_FILE};`,
    `the canonical host for this box's namespace in acpx-ui's hostmap cache (${hostmapCachePath}).`,
    "Fix: set ACPX_UI_BASE_URL to this box's acpx-ui URL (the box's own pod env is where it belongs).",
    "acpx will not build a hostname out of the Kubernetes namespace: the service label and the",
    "domain are configuration, not structure, so a constructed host is already wrong on the",
    "product boxes and dead on every box once the service label moves.",
  ].join(" ");
}

/**
 * Rung 1 plus `deriveBoxBaseUrlFrom`, as a pure function of an env and the box's
 * file contents — so the whole ladder, including its miss, is testable without a
 * filesystem or a box. Undefined when every rung misses; PURE, so the warning is
 * the impure caller's job.
 */
export function acpxUiBaseUrlFrom(
  env: NodeJS.ProcessEnv,
  sources: BoxBaseUrlSources,
): string | undefined {
  const raw = env.ACPX_UI_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : deriveBoxBaseUrlFrom(sources);
  return base ? base.replace(/\/+$/, "") : undefined;
}

// One warning per process: the resolver runs on every spawn, and a per-spawn repeat
// would bury the line it is trying to make visible.
let warnedUnresolvedBaseUrl = false;

/**
 * The acpx-ui base URL for THIS box. Every session URL acpx composes funnels
 * through here, so this is the single point that decides the host agents see.
 * Precedence, first hit wins:
 *   1. explicit ACPX_UI_BASE_URL env (operator override / test seam)
 *   2. ACPX_UI_BASE_URL out of /proc/1/environ — the box's OWN answer. `ssh` does
 *      not carry the container env, so a shell reached as `ssh-remote <box> -- …`
 *      sees an empty $ACPX_UI_BASE_URL while PID 1 still holds the real one.
 *   3. the CANONICAL host for this namespace from acpx-ui's hostmap cache
 *   4. there is no rung 4 — it returns UNDEFINED and warns once.
 *
 * ⚠️ UNDEFINED IS AN ANSWER; DO NOT GIVE IT A FALLBACK. Two used to sit below
 * rung 3 — a structural guess `https://acpx.<box>.nativai.de` built from the
 * namespace, and a literal `https://acpx.devbox.nativai.de` default — and both
 * mint a host that is merely PLAUSIBLE. The literal names another box outright;
 * the guess is already wrong for konsiq, labidio and tubeyakker, canonically
 * served at `acpx.devbox.konsiq.de` / `.labidio.de` / `.tubeyakker.com` (a third
 * TLD, which is why no hostname rule can cover the fleet), and BOTH name a service
 * label that stops existing when it moves. A fabricated URL is worse than a missing
 * one: it is well-formed, it is stored forever in session records, commit trailers
 * and `GIT_AUTHOR_EMAIL`, and nothing downstream can tell it from a real one.
 * brick f29ba473.
 *
 * ⚠️ AND IT MUST NOT THROW EITHER — a throw here would block EVERY spawn on a host
 * where no rung resolves, and the rung-5 literal's own comment ("non-cluster /
 * unknown namespace") records that its authors expected exactly such a host to
 * exist. The `string | undefined` return is deliberate: it makes every caller
 * decide, under the typechecker, between omitting the URL and inventing one. This
 * is the same rule the OS states for agents — with no session URL, SKIP the URL
 * rather than guess — and the callers already had the shape for it
 * (`applyGitCommitAttribution` has always returned early on an unusable host).
 * Rungs 1–3 cover all five boxes today (measured 2026-09-11: rung 1 or 2 hits on
 * every one), so the degraded path is unreachable in the deployed configuration.
 *
 * ⚠️ Kept SYNCHRONOUS deliberately: every rung is a `readFileSync`, and the call
 * sites are synchronous. acpx-ui's equivalent ladder has a further
 * `GET 127.0.0.1:3456/api/config` rung — do NOT port it here, it would force an
 * async refactor of every caller for a case rungs 2–3 already cover on all five
 * boxes.
 */
export function resolveAcpxUiBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const base = acpxUiBaseUrlFrom(env, boxBaseUrlSources(env));
  if (!base && !warnedUnresolvedBaseUrl) {
    warnedUnresolvedBaseUrl = true;
    process.stderr.write(`${unresolvedBaseUrlMessage(hostmapCacheFile(env))}\n`);
  }
  return base;
}

/**
 * Absolute path to the acpx-shipped git hooks directory (repo-root `git-hooks/`),
 * resolved relative to the bundled dist entry (dist/cli.js → ../git-hooks). The
 * deployed acpx is a full git checkout, so the committed hook is present on disk.
 * Returns undefined if resolution somehow yields a non-absolute path (guarded so
 * we never activate core.hooksPath with a half-formed value).
 */
export function resolveAcpxHooksDir(): string | undefined {
  try {
    const dir = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "git-hooks");
    return isAbsolute(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Append one git config override via the additive GIT_CONFIG_COUNT/KEY_n/VALUE_n
 * env protocol (git ≥ 2.31), never clobbering a pre-existing count. This is the
 * `-c key=value`-style path — unlike GIT_CONFIG_GLOBAL it preserves the user's
 * global config (e.g. the `url.insteadOf` GitHub-token rewrite).
 */
function appendGitConfigEnv(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const count = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}

/**
 * Automatic commit attribution (brick fc36b374): make every git commit an
 * acpx-spawned agent authors carry the agent identity as the git author/committer,
 * and activate the shipped prepare-commit-msg hook (which appends `Session:` /
 * `Message:` trailers) via env-scoped core.hooksPath. Gated on a resolvable acpx
 * record id; no-op-safe — if any input is missing we skip that piece rather than
 * emit a half-formed value. Scope is exactly "processes acpx spawned": humans and
 * non-agent git are untouched (no global config, no repo .git/hooks change).
 */
function applyGitCommitAttribution(
  env: NodeJS.ProcessEnv,
  sessionContext: AgentSessionContext,
  baseUrl: string,
): void {
  const recordId = sessionContext.acpxRecordId?.trim();
  if (!recordId) {
    return;
  }
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return;
  }
  if (!host) {
    return;
  }
  const email = `${recordId}@${host}`;
  const name =
    nonEmptyEnvString(sessionContext.sessionName ?? undefined) ?? `acpx:${recordId.slice(0, 8)}`;
  env.GIT_AUTHOR_NAME = name;
  env.GIT_AUTHOR_EMAIL = email;
  env.GIT_COMMITTER_NAME = name;
  env.GIT_COMMITTER_EMAIL = email;
  const hooksDir = resolveAcpxHooksDir();
  if (hooksDir) {
    appendGitConfigEnv(env, "core.hooksPath", hooksDir);
  }
}

export type AgentSessionContext = {
  acpxRecordId: string;
  sessionName?: string | null;
  parentSessionId?: string | null;
  /**
   * The parent session's FULL acpx-ui URL (host + id), used for cross-machine
   * lineage. When the parent lives on another box, its bare id cannot identify
   * it locally — only the URL carries the host. Set from `--parent-session-url`
   * or the spawning agent's ACPX_SESSION_URL at creation. When absent, the
   * parent URL is derived from parentSessionId against the LOCAL base URL
   * (correct same-box). Carried into the bridge's session/new `_meta`. (FW-19)
   */
  parentSessionUrl?: string | null;
  taskFolder?: string | null;
  brick?: string | null;
  brickPath?: string | null;
  agentFolder?: string | null;
  /**
   * Selected Claude subscription id (from ~/.acpx/subscriptions/registry.json).
   * When set and resolvable, buildAgentEnvironment points the adapter at that
   * subscription's CLAUDE_CONFIG_DIR. Unset means raw global ~/.claude; registry
   * defaults are resolved earlier by the session binding layer, not here.
   * Mirrors how per-session `model` flows from the session record.
   */
  subscriptionId?: string | null;
  /**
   * Profile id from session_options.profile — takes priority over subscriptionId
   * when set. The profile-based auth is applied asynchronously after the
   * synchronous env build (see applyProfileAuth in client.ts usage).
   */
  profileId?: string | null;
  /**
   * Per-session reasoning effort override. Overrides profile.reasoningEffort when
   * set. For openrouter profiles only — passed to spawnOpenRouterShim via the
   * shim's OR_REASONING_EFFORT env var. Must be in the profile's valid effort set.
   */
  reasoningEffort?: string | null;
};

/**
 * `ACPX_AGENT_TYPE` — the harness the session's agent process is, named at the
 * acpx layer for the agent itself (brick://aa74cb34).
 *
 * WHY this exists: acpx injected nine session facts and never the one an agent
 * needs to reason about its own spawns. Measured on the deployed build, the
 * environment of a live pi session named its box, its session, its parent and
 * its brick, but nothing named its harness — so the only cross-harness
 * self-identification an agent had was inference.
 *
 * `ACPX_EFFECTIVE_ADAPTER` is NOT that signal and must not be mistaken for it.
 * It is stamped by `stampEffectiveAccount` on the Claude-credential path and
 * names the AUTH adapter, not the harness. Measured against live pi adapters'
 * /proc environs it fails in BOTH directions: **absent** in a pi session
 * spawned from the UI, and **present, reading `claude`**, in a pi session
 * spawned by a claude parent — it is not cleared below, so it survives the
 * `{...process.env}` copy. A variable that looks authoritative, is right for
 * one harness, and is either missing or confidently wrong for the rest. (That
 * leak is a separate defect and is deliberately NOT fixed here.)
 *
 * The value is the {@link HarnessId} for `agentCommand`, resolved through the
 * single adapter classifier. This is deliberately NOT a second classifier and
 * must not become one — `harnessIdForAgentCommand` delegates to
 * `acpAdapterKind`, and re-deriving the answer here is exactly the duplication
 * that module's own contract forbids.
 *
 * ⚠️ UNSET IS THE HONEST ANSWER for an adapter the descriptor does not
 * classify — never a default, never a guess. `harnessIdForAgentCommand` returns
 * `undefined` meaning *"acpx cannot say"*, and an agent that reads a confidently
 * WRONG harness is worse off than one that reads nothing: absence is legible as
 * "I must find out another way", while a wrong value is acted upon. That is the
 * same failure this variable exists to end, so it must not be reintroduced here.
 */
function applyAgentTypeEnvironment(env: NodeJS.ProcessEnv, agentCommand: string | undefined): void {
  const harnessId = harnessIdForAgentCommand(agentCommand);
  if (harnessId !== undefined) {
    env.ACPX_AGENT_TYPE = harnessId;
  }
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
  sessionContext?: AgentSessionContext,
  lookupOptions?: SubscriptionLookupOptions,
  agentCommand?: string,
  onProvisioningWarning?: ProvisioningWarningHandler,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  promotePrefixedAuthEnvironment(env);
  // FW-07: never inherit stale acpx process context from {...process.env}
  // (e.g. a long-lived queue-owner that served a different session). Clear these,
  // then set only from THIS spawn context below so a bridge session can never
  // carry another session identity.
  delete env.ACPX_SESSION_URL;
  delete env.ACPX_PARENT_SESSION_URL;
  delete env.ACPX_SESSION_NAME;
  delete env.ACPX_TASK_FOLDER;
  delete env.ACPX_BRICK;
  delete env.ACPX_BRICK_PATH;
  // ── THE BRICKS-REALM CREDENTIAL — STRIPPED BY PREFIX, NOT BY NAME ────────────────────────────
  //
  // ⚠️ A NEW NAME ADDED TO THE LIST ABOVE WOULD NOT BE GOOD ENOUGH, AND THIS FILE IS ITS OWN
  // EVIDENCE. The list is ALLOW-BY-OMISSION: a variable nobody names is inherited. Three separate
  // bricks have now fixed variables it missed — brick://6530d3b4 (the account stamp),
  // brick://1820be37 (CLAUDE_CONFIG_DIR) and brick://cb214e48 — each one a name someone had to
  // think of first. A prefix rule cannot be defeated by a SECOND credential variable added later,
  // which a name list can, and historically does.
  //
  // 🛑 THE `S` IS WHAT MAKES THIS SAFE, AND WIDENING IT TO `ACPX_BRICK` IS A FLEET-WIDE OUTAGE.
  // `ACPX_BRICKS_*` (with the S) is the credential family — `ACPX_BRICKS_CREDENTIAL_FILE` today.
  // `ACPX_BRICK_*` (no S) is ordinary, legitimately-inherited configuration: ACPX_BRICK_POOL_DIR,
  // ACPX_BRICK_DB_PATH, ACPX_BRICK_DB_EXPORT_DIR, ACPX_BRICK_REALM. Stripping on `ACPX_BRICK`
  // would take the pool dir out of every agent on every box and break `brick context` everywhere.
  // The two families were named apart deliberately so that this rule could be a prefix.
  //
  // Stated boundary, kept honest: this guarantees NO AGENT'S ENVIRONMENT CARRIES THE TOKEN. It does
  // NOT guarantee no agent can obtain it — every agent runs as the same uid and the credential is a
  // mounted file, so a same-uid process can read it. That is an accidental-cross-realm tripwire, not
  // adversarial isolation, and claiming the stronger property would be false.
  deleteBricksCredentialEnv(env);
  delete env.ACPX_OWNER_LOG;
  delete env.ACPX_AGENT_TYPE;
  // brick://6530d3b4 — the ACCOUNT stamp is spawn context too, and was missing
  // from the list above. Measured on devbox: a pi child of a claude parent
  // inherited ACPX_SUBSCRIPTION=sub7, ACPX_EFFECTIVE_ACCOUNT=sub7,
  // ACPX_EFFECTIVE_ADAPTER=claude, ACPX_EFFECTIVE_PROFILE=sub7 and
  // ACPX_EFFECTIVE_ANCHOR=…/subscriptions/sub7 — a full Claude credential
  // identity, for a session authenticated by an OpenRouter box key that never
  // touched that account. Worse than useless: ACPX_EFFECTIVE_ADAPTER then reads
  // `claude` INSIDE a pi session, so an agent using it to identify its own
  // harness is told the wrong answer with no way to tell (brick://aa74cb34).
  //
  // The rule already exists elsewhere and simply never reached here:
  // applyClaudeHomeProfileAuth and applyChatGptProfileAuth both drop
  // ACPX_SUBSCRIPTION for the same reason, and the non-Claude branch below
  // warns that a subscription is inert for a non-Claude agent — but that guard
  // only fires for an explicitly STORED selection, so a leak through the env
  // passes underneath it silently.
  //
  // Safe to clear unconditionally because every legitimate value is written
  // AFTER this point, by whichever path applies a selection:
  // applySubscriptionConfigDir → verifyAppliedSubscription →
  // verifySubscriptionEffectiveAccount → stampEffectiveAccount (sync,
  // subscription sessions), or applyProfileAuth → stampProfileEffectiveAccount
  // (async, profile sessions — client.ts calls it before the adapter spawns).
  // The one in-file READER, ensureProvisioningForResolvedSubscription, consumes
  // ACPX_EFFECTIVE_PROFILE two lines after applySubscriptionConfigDir writes it,
  // never the inherited value. A session with neither selection legitimately has
  // no account identity, and absent is the truthful answer for it.
  delete env.ACPX_SUBSCRIPTION;
  delete env[ACPX_EFFECTIVE_PROFILE_ENV];
  delete env[ACPX_EFFECTIVE_ACCOUNT_ENV];
  delete env[ACPX_EFFECTIVE_ADAPTER_ENV];
  delete env[ACPX_EFFECTIVE_AUTH_MODE_ENV];
  delete env[ACPX_EFFECTIVE_ANCHOR_ENV];
  // brick://1820be37 — and CLAUDE_CONFIG_DIR with them, which is the OPERATIVE
  // one. The six above are descriptive: they mislead a reader about which
  // account a session used. This one POINTS AT THE CREDENTIALS — measured on
  // devbox, a pi child of a claude parent inherited
  // `CLAUDE_CONFIG_DIR=/home/node/.acpx/subscriptions/sub7`, a directory holding
  // that subscription's `.credentials.json`, for a session authenticated by an
  // OpenRouter box key that never touched the account.
  //
  // ⚠️ NOT a privilege escalation, and it should not be described as one: every
  // agent on a box runs as the same uid and the path is conventional, so the
  // variable grants no access the process did not already have. It is a SCOPING
  // defect — and it is one acpx already legislated against elsewhere and never
  // generalised here: `applyChatGptProfileAuth` deletes exactly this variable,
  // its comment reading *"the bridge strips leaked SDK env defensively, but acpx
  // must not emit it"*, and `applyClaudeHomeProfileAuth` does the same.
  //
  // Safe to clear for the same reason as the six above — every legitimate value
  // is written after this point, `applySubscriptionConfigDir` (sync) or
  // `applyProfileAuth` (async, before the adapter spawns). Measured before
  // changing it: 1456 of 1458 claude sessions on devbox carry a profile or
  // subscription, so default-account-binding really does bind before spawn as
  // the branch below claims; the 2 unbound are closed OpenRouter-model sessions
  // that never used a Claude account at all.
  //
  // It also makes claude-pty match its own documentation. The branch below says
  // a claude-pty session gets "no CLAUDE_CONFIG_DIR" because the bridge owns
  // auth via its HOME selector — but it never cleared the INHERITED one, so a
  // claude-pty child of a subscription-bound parent silently received one.
  //
  // The `CLAUDE_CODE_*` family (CLAUDECODE, CLAUDE_CODE_MESSAGING_SOCKET/TOKEN,
  // CLAUDE_CODE_EXECPATH …) leaks the same way and is DELIBERATELY LEFT ALONE:
  // acpx does not emit those — it inherits them from a parent Claude Code SDK
  // process — and some are plausibly load-bearing for a claude child. Stripping
  // them is a separate, larger question than this one.
  delete env.CLAUDE_CONFIG_DIR;
  // brick://cb214e48 — pi's DATA dir is spawn context too, and it is OPERATIVE in
  // the same way CLAUDE_CONFIG_DIR above is. Measured on devbox 2026-09-09: a pi
  // child of a pi parent inherited `PI_CODING_AGENT_DIR=/tmp/acpx-pi-<parent>`
  // (pi exports its whole environment into every tool subprocess, and this
  // function starts from `{...process.env}`), and acpx then treated it as the BOX
  // agent dir — writing the child's ONLY transcript into a directory removed at
  // the parent's close. Eight JSONLs, three ancestor dirs, four of them
  // grandchildren.
  //
  // `PI_CODING_AGENT_SESSION_DIR` goes UNCONDITIONALLY: `writePiConfigDir` is its
  // only writer in this system and its value is inherently cwd-specific, so a
  // box-level one would force every session of every cwd into one folder. Deleting
  // it also cleans a claude/codex child of a pi parent, which carries it today for
  // no reason at all.
  //
  // `PI_CODING_AGENT_DIR` goes CONDITIONALLY — an unconditional delete would break
  // a box that legitimately relocates pi's agent dir. Same predicate as the writer
  // ({@link isAcpxPerSessionConfigDir}), ONE implementation: two spellings of one
  // rule is how the writer and the scrubber come to disagree.
  delete env.PI_CODING_AGENT_SESSION_DIR;
  if (isAcpxPerSessionConfigDir(env.PI_CODING_AGENT_DIR)) {
    delete env.PI_CODING_AGENT_DIR;
  }
  // brick://27894f40 — pi's five DESCRIPTIVE session variables, for the same
  // stated reason as every delete above: never inherit stale acpx process
  // context. They are not operative — the cb214e48 conception deferred them on
  // exactly that ground — but they MIS-ATTRIBUTE A CHILD TO ITS PARENT in
  // /proc-based forensics, the same class as the ACPX_EFFECTIVE_* family.
  //
  // Measured on devbox 2026-09-09 (cb214e48 EVIDENCE §1b): the pi-acp adapter of
  // the child session `w8-depth-gate` reported PI_SESSION_ID and PI_SESSION_FILE
  // naming the Wave 8 HoD's pi session and JSONL — so a debugger reading
  // /proc/<child-adapter>/environ is told to open the PARENT's transcript, with
  // nothing in the dump to reveal the mistake.
  //
  // Safe to clear UNCONDITIONALLY, and the reason is stronger than for the two
  // above: nothing in this system READS them. Re-measured 2026-09-10 against pi
  // 0.84.4's shipped bundle, pi-acp `70ee6c7` and this repo — each name occurs
  // exactly twice in pi, both inside one function, `resolveSpawnContext`:
  //
  //   let env2={...getShellEnv()};
  //   delete env2.PI_SESSION_ID, delete env2.PI_SESSION_FILE, delete env2.PI_PROVIDER,
  //   delete env2.PI_MODEL, delete env2.PI_REASONING_LEVEL,
  //   exposeSessionEnvironment&&ctx && (… env2.PI_SESSION_ID=ctx.sessionManager.getSessionId() …
  //    ctx.thinkingLevel&&(env2.PI_REASONING_LEVEL=ctx.thinkingLevel))
  //
  // i.e. write-only: pi drops all five and re-derives them from the LIVE session
  // for every tool subprocess. So deleting them here cannot starve pi — a pi
  // session still publishes its own five to its own tools, which is the only
  // place they were ever meant to be read. Zero occurrences in pi-acp's src or
  // dist, and zero readers here (the only other mention in this repo is a
  // docstring in cli/session/inherited-metadata.ts).
  //
  // ⚠️ NOT a config seam, so there is no box-level value to preserve and no
  // conditional to write: unlike PI_CODING_AGENT_DIR, whose box-level form is
  // legitimate and is why THAT delete is gated, these five are per-session
  // outputs of a running pi. A value present at spawn is always some other
  // session's. Deleting them for EVERY harness is deliberate — a claude or codex
  // child of a pi parent inherits the same five today, for no reason at all.
  //
  // pi's grep trap does NOT apply here (cb214e48 EVIDENCE §2): pi assembles
  // `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` at runtime from its
  // rebrandable `APP_NAME`, but these five are literal in the bundle, and a
  // suffix search (`toUpperCase()}_SESSION_ID` etc.) returns zero — so the
  // literal-name census above is complete, not a false negative.
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_MODEL;
  delete env.PI_PROVIDER;
  delete env.PI_REASONING_LEVEL;
  applyAgentTypeEnvironment(env, agentCommand);
  const baseUrl = resolveAcpxUiBaseUrl(env);
  // ⚠️ HAND THE RESOLVED VALUE DOWN — this line is why the adapters do not each own
  // a copy of the ladder above. claude-pty-acp used to carry a byte-for-byte port of
  // it (`parseBoxBaseUrlFromResolvConf`, same devbox literal) purely because acpx
  // resolved the host and then did not tell the child what it had decided: with
  // ACPX_UI_BASE_URL unset in the pod env, acpx would answer from /proc/1/environ
  // while the bridge answered from its own guess, and the child's OWN session URL
  // could name a different host from its parent's. The two are now one answer by
  // construction. Writing it here also NORMALIZES a trailing-slash or padded value,
  // so the child sees exactly the string acpx used.
  // ⚠️ And when nothing resolved, DELETE rather than leave the inherited value: the
  // only way to reach this branch with the key still present is a blank/whitespace
  // one (a usable value is rung 1 and cannot miss), and a blank ACPX_UI_BASE_URL is
  // worse than an absent one — the bridge's own guard reads "unset" as fatal-and-
  // legible but would have to special-case "set to nothing".
  // Red on removal: "adapter env carries acpx's resolved base URL (the seam
  // claude-pty-acp consumes)" in test/claude-pty-agent.test.ts.
  if (baseUrl) {
    env.ACPX_UI_BASE_URL = baseUrl;
  } else {
    delete env.ACPX_UI_BASE_URL;
  }
  if (baseUrl && sessionContext && typeof sessionContext.acpxRecordId === "string") {
    const trimmed = sessionContext.acpxRecordId.trim();
    if (trimmed.length > 0) {
      env.ACPX_SESSION_URL = `${baseUrl}/?session=${trimmed}`;
    }
  }
  if (sessionContext && typeof sessionContext.sessionName === "string") {
    const trimmedName = sessionContext.sessionName.trim();
    if (trimmedName.length > 0) {
      env.ACPX_SESSION_NAME = trimmedName;
    }
  }
  // brick://c6e3618b — ONE composition, shared with the bridge's session/new `_meta`
  // (buildClaudeParentSessionMeta). These two paths used to differ: the bridge
  // preferred the explicit parentSessionUrl while this one always recomposed
  // `${baseUrl}/?session=${parentId}` against the LOCAL base, silently re-hosting a
  // cross-box parent onto this box — a well-formed URL for a session that does not
  // exist here, which a child then reports back into. The FW-19 comment on
  // resolveParentSessionUrl claimed the two were "byte-identical"; they now are.
  const parentSessionUrl = resolveParentSessionUrl(sessionContext, baseUrl);
  if (parentSessionUrl) {
    env.ACPX_PARENT_SESSION_URL = parentSessionUrl;
  }
  if (sessionContext && typeof sessionContext.taskFolder === "string") {
    const trimmedTaskFolder = sessionContext.taskFolder.trim();
    if (trimmedTaskFolder.length > 0) {
      env.ACPX_TASK_FOLDER = trimmedTaskFolder;
    }
  }
  if (sessionContext && typeof sessionContext.brick === "string") {
    const trimmedBrick = sessionContext.brick.trim();
    if (trimmedBrick.length > 0) {
      env.ACPX_BRICK = trimmedBrick;
      if (typeof sessionContext.brickPath === "string") {
        const trimmedBrickPath = sessionContext.brickPath.trim();
        if (trimmedBrickPath.length > 0) {
          env.ACPX_BRICK_PATH = trimmedBrickPath;
        }
      }
    }
  }
  if (sessionContext && typeof sessionContext.agentFolder === "string") {
    const trimmedAgentFolder = sessionContext.agentFolder.trim();
    if (trimmedAgentFolder.length > 0) {
      env.ACPX_AGENT_FOLDER = trimmedAgentFolder;
    }
  }
  // No base URL means no host for `<recordId>@<host>` — the function's own
  // unusable-host guard already skips in that case; the `baseUrl &&` is what makes
  // that visible to the typechecker rather than relying on the guard.
  if (baseUrl && sessionContext) {
    applyGitCommitAttribution(env, sessionContext, baseUrl);
  }
  // When a profileId is set the async applyProfileAuth path (called from
  // client.ts after this synchronous env build) handles all auth env setup.
  // Skip subscription resolution here to avoid clobbering what applyProfileAuth
  // will write. Subscription-only sessions (no profileId) continue to use this
  // synchronous path, but ONLY when the record carries a concrete subscription.
  // An unbound record deliberately stays raw here: registry defaults are
  // snapshotted onto sessions by default-account-binding before spawn, not
  // late-resolved inside the env builder.
  // For the claude-pty bridge agent, subscription configDir resolution does not
  // apply at all: an explicit --subscription is rejected (setup-tokens would
  // wedge interactive Claude at the login picker) and the unselected default
  // is skipped silently (no CLAUDE_CONFIG_DIR, no "no subscription selected"
  // banner — the bridge owns auth via its HOME selector).
  if (!sessionContext?.profileId?.trim()) {
    const subscriptionId = sessionContext?.subscriptionId?.trim();
    if (agentCommand !== undefined && isClaudePtyAgentCommand(agentCommand)) {
      rejectExplicitSubscriptionForClaudePty(subscriptionId);
    } else if (agentCommand !== undefined && subscriptionId && !isClaudeFamilyAgent(agentCommand)) {
      // CONCEPTION §5.5 / §9.1, I3 §2.4: `subscription` is a Claude-family
      // field. `CLAUDE_CONFIG_DIR` means nothing to a harness that does not read
      // it, and setting it SILENTLY is the half of this defect that is easy to
      // miss — nothing fails, so nothing says the selection was inert.
      //
      // Skipped when the caller cannot supply the agent command, matching
      // `validateProfileAgentCompatibility`'s convention in this file: an absent
      // command is "not told", not "not Claude". Every production spawn path
      // passes it.
      warnSubscriptionIgnoredForNonClaudeAgent(subscriptionId, agentCommand);
    } else if (subscriptionId) {
      applySubscriptionConfigDir(env, subscriptionId, lookupOptions);
      ensureProvisioningForResolvedSubscription(env, lookupOptions, onProvisioningWarning);
    }
  }
  if (!authCredentials) {
    return env;
  }

  for (const [methodId, credential] of Object.entries(authCredentials)) {
    assignAuthCredentialEnv(env, methodId, credential);
  }

  return env;
}

function ensureProvisioningForResolvedSubscription(
  env: NodeJS.ProcessEnv,
  lookupOptions?: SubscriptionLookupOptions,
  onProvisioningWarning?: ProvisioningWarningHandler,
): void {
  if (!env[ACPX_EFFECTIVE_PROFILE_ENV] || !registryMayConfigureProvisioning(lookupOptions)) {
    return;
  }
  const registry = loadProfileRegistry(lookupOptions);
  const profile = findProfile(env[ACPX_EFFECTIVE_PROFILE_ENV], registry);
  if (!profile) {
    return;
  }
  ensureProfileOsHarnessProvisioning({
    registry,
    profile,
    env,
    onWarning: onProvisioningWarning,
  });
}

type ResolvedSubscription = {
  registry: SubscriptionRegistry;
  choice: ConfigDirChoice;
  defaultId: string | undefined;
};

type EffectiveAccountStamp = {
  profileId: string;
  account: string;
  adapter: string;
  authMode: string;
  anchor: string;
};

function normalizedFsPath(value: string): string {
  return resolvePath(value);
}

function findSubscriptionByConfigDir(
  configDir: string,
  registry: SubscriptionRegistry,
): SubscriptionEntry | undefined {
  const normalized = normalizedFsPath(configDir);
  return registry.subscriptions.find((entry) => normalizedFsPath(entry.configDir) === normalized);
}

function findSubscriptionProfileByConfigDir(
  configDir: string,
  registry: ProfileRegistry,
): ProfileEntry | undefined {
  const normalized = normalizedFsPath(configDir);
  return registry.profiles.find(
    (entry) =>
      entry.authMode === "subscription" && normalizedFsPath(entry.credentialSource) === normalized,
  );
}

function findClaudeHomeProfileByAnchor(
  anchor: string,
  registry: ProfileRegistry,
): ProfileEntry | undefined {
  const normalized = normalizedFsPath(anchor);
  return registry.profiles.find((entry) => {
    if (entry.authMode !== "claude-home") {
      return false;
    }
    const profileAnchor = transcriptAnchorDir(entry);
    return profileAnchor !== null && normalizedFsPath(profileAnchor) === normalized;
  });
}

function findChatGptProfileByCodexHome(
  codexHome: string,
  registry: ProfileRegistry,
): ProfileEntry | undefined {
  const normalized = normalizedFsPath(codexHome);
  return registry.profiles.find(
    (entry) => entry.authMode === "chatgpt" && normalizedFsPath(entry.codexHome) === normalized,
  );
}

function stampEffectiveAccount(env: NodeJS.ProcessEnv, stamp: EffectiveAccountStamp): void {
  env.ACPX_SUBSCRIPTION = stamp.profileId;
  env[ACPX_EFFECTIVE_PROFILE_ENV] = stamp.profileId;
  env[ACPX_EFFECTIVE_ACCOUNT_ENV] = stamp.account;
  env[ACPX_EFFECTIVE_ADAPTER_ENV] = stamp.adapter;
  env[ACPX_EFFECTIVE_AUTH_MODE_ENV] = stamp.authMode;
  env[ACPX_EFFECTIVE_ANCHOR_ENV] = stamp.anchor;
}

function throwAccountMismatch(params: {
  expectedAccount: string;
  selectionKind: "subscription" | "profile";
  selectionId: string;
  physicalAccount: string;
  anchor: string;
}): never {
  throw new Error(
    `[acpx] recorded account "${params.expectedAccount}" for ${params.selectionKind} "${params.selectionId}" ` +
      `does not match the physically resolved account "${params.physicalAccount}" at ${params.anchor}; ` +
      `refusing to spawn on the wrong account`,
  );
}

function assertPhysicalAccount(params: {
  expectedAccount: string;
  selectionKind: "subscription" | "profile";
  selectionId: string;
  physicalAccount: string;
  anchor: string;
}): void {
  if (params.physicalAccount !== params.expectedAccount) {
    throwAccountMismatch(params);
  }
}

function verifySubscriptionEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedEntry: SubscriptionEntry,
  registry: SubscriptionRegistry,
  configDir: string,
): void {
  const physicalEntry = findSubscriptionByConfigDir(configDir, registry) ?? expectedEntry;
  assertPhysicalAccount({
    expectedAccount: expectedEntry.account,
    selectionKind: "subscription",
    selectionId: expectedEntry.id,
    physicalAccount: physicalEntry.account,
    anchor: configDir,
  });
  stampEffectiveAccount(env, {
    profileId: expectedEntry.id,
    account: expectedEntry.account,
    adapter: "claude",
    authMode: "subscription",
    anchor: configDir,
  });
}

function stampProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  profile: ProfileEntry,
  anchor: string,
): void {
  stampEffectiveAccount(env, {
    profileId: profile.id,
    account: profile.account,
    adapter: profile.adapter,
    authMode: profile.authMode,
    anchor,
  });
}

function verifySubscriptionProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedProfile: SubscriptionProfileEntry,
  registry: ProfileRegistry,
): void {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (!configDir) {
    throw new Error(
      `[acpx] profile "${expectedProfile.id}" resolved as subscription but no CLAUDE_CONFIG_DIR was applied`,
    );
  }
  const physicalProfile =
    findSubscriptionProfileByConfigDir(configDir, registry) ?? expectedProfile;
  assertPhysicalAccount({
    expectedAccount: expectedProfile.account,
    selectionKind: "profile",
    selectionId: expectedProfile.id,
    physicalAccount: physicalProfile.account,
    anchor: configDir,
  });
  stampProfileEffectiveAccount(env, expectedProfile, configDir);
}

function verifyClaudeHomeProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedProfile: ClaudeHomeProfileEntry,
  registry: ProfileRegistry,
): void {
  const anchor = transcriptAnchorDir(expectedProfile) ?? expectedProfile.homePath;
  const physicalProfile = findClaudeHomeProfileByAnchor(anchor, registry) ?? expectedProfile;
  assertPhysicalAccount({
    expectedAccount: expectedProfile.account,
    selectionKind: "profile",
    selectionId: expectedProfile.id,
    physicalAccount: physicalProfile.account,
    anchor,
  });
  stampProfileEffectiveAccount(env, expectedProfile, anchor);
}

function verifyChatGptProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedProfile: ChatGptProfileEntry,
  registry: ProfileRegistry,
): void {
  const codexHome = env.CODEX_HOME ?? expectedProfile.codexHome;
  const physicalProfile = findChatGptProfileByCodexHome(codexHome, registry) ?? expectedProfile;
  assertPhysicalAccount({
    expectedAccount: expectedProfile.account,
    selectionKind: "profile",
    selectionId: expectedProfile.id,
    physicalAccount: physicalProfile.account,
    anchor: codexHome,
  });
  stampProfileEffectiveAccount(env, expectedProfile, codexHome);
}

function verifyProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedProfile: ProfileEntry,
  registry: ProfileRegistry,
): void {
  switch (expectedProfile.authMode) {
    case "subscription":
      return verifySubscriptionProfileEffectiveAccount(env, expectedProfile, registry);
    case "claude-home":
      return verifyClaudeHomeProfileEffectiveAccount(env, expectedProfile, registry);
    case "chatgpt":
      return verifyChatGptProfileEffectiveAccount(env, expectedProfile, registry);
    case "openrouter":
      return stampProfileEffectiveAccount(env, expectedProfile, env.CLAUDE_CONFIG_DIR ?? "");
  }
}

// Load the registry and resolve the choice, emitting the legacy log lines. Returns
// undefined when there is no configDir to apply (no registry / unusable default /
// registry read failure) — i.e. the caller leaves CLAUDE_CONFIG_DIR unset.
function resolveSubscriptionChoice(
  explicitId: string | null | undefined,
  lookupOptions: SubscriptionLookupOptions | undefined,
): ResolvedSubscription | undefined {
  let resolved: ResolvedSubscription;
  try {
    const registry = loadSubscriptionRegistry(lookupOptions);
    resolved = {
      registry,
      defaultId: registry.default,
      choice: chooseSubscriptionConfigDir(explicitId, registry, subscriptionConfigDirExists),
    };
  } catch (error) {
    emitRegistryReadFailure(explicitId, error);
    return undefined;
  }
  if (resolved.choice.explicitRejection) {
    if (resolved.choice.explicitRejection.kind === "locked") {
      throw new SubscriptionLockedError(resolved.choice.explicitRejection.id);
    }
    throw new Error(formatExplicitRejection(resolved.choice.explicitRejection));
  }
  return resolved.choice.configDir === undefined ? undefined : resolved;
}

type AppliedSubscriptionChoice = {
  resolvedId: string | undefined;
  configDir: string;
  substituted: boolean;
};

function applySubscriptionChoiceAvoidance(
  explicitId: string | null | undefined,
  resolved: ResolvedSubscription,
): AppliedSubscriptionChoice {
  const baseResolvedId =
    resolved.choice.resolvedId ??
    (resolved.choice.source === "explicit" ? explicitId?.trim() : resolved.defaultId);
  return applyPreSpawnAvoidance(
    resolved.registry,
    baseResolvedId,
    resolved.choice.configDir as string,
    resolved.choice.source !== "explicit",
  );
}

function maybeEmitDefaultApplied(
  resolved: ResolvedSubscription,
  applied: AppliedSubscriptionChoice,
): void {
  if (resolved.choice.source !== "default" || !resolved.defaultId || applied.substituted) {
    return;
  }
  if (resolved.choice.resolvedId && resolved.choice.resolvedId !== resolved.defaultId) {
    process.stderr.write(
      `[acpx] registry default "${resolved.defaultId}" is locked; using unlocked subscription "${resolved.choice.resolvedId}" instead (CLAUDE_CONFIG_DIR=${resolved.choice.configDir})\n`,
    );
    return;
  }
  emitDefaultApplied(
    resolved.defaultId,
    resolved.choice.configDir as string,
    resolved.choice.explicitRejection !== undefined,
  );
}

function verifyAppliedSubscription(
  env: NodeJS.ProcessEnv,
  resolved: ResolvedSubscription,
  applied: AppliedSubscriptionChoice,
): void {
  const expectedEntry = applied.resolvedId
    ? findSubscription(applied.resolvedId, resolved.registry)
    : undefined;
  if (expectedEntry) {
    verifySubscriptionEffectiveAccount(env, expectedEntry, resolved.registry, applied.configDir);
  }
}

// Resolve which CLAUDE_CONFIG_DIR a concrete subscription selection should use
// and set it on the env. Normal spawn paths call this only with a stored
// subscription id; unbound sessions are bound earlier by
// default-account-binding. Also sets ACPX_SUBSCRIPTION to the resolved id (E.2)
// and applies process-local known-dead avoidance (§4.1.4) before committing the
// dir.
//
// BACKWARD SAFETY: the legacy rejection lines for an explicit id are emitted
// verbatim. The default-applied note remains only for legacy direct callers that
// still pass a null selection; buildAgentEnvironment no longer does that for an
// unbound session.
function applySubscriptionConfigDir(
  env: NodeJS.ProcessEnv,
  explicitId: string | null | undefined,
  lookupOptions?: SubscriptionLookupOptions,
): void {
  const resolved = resolveSubscriptionChoice(explicitId, lookupOptions);
  if (!resolved) {
    return;
  }
  const applied = applySubscriptionChoiceAvoidance(explicitId, resolved);

  env.CLAUDE_CONFIG_DIR = applied.configDir;
  // Export the RESOLVED subscription id so the agent (and its children) can read
  // its own sub and inherit it (ACPX_SUBSCRIPTION, beside ACPX_TASK_FOLDER).
  if (applied.resolvedId) {
    env.ACPX_SUBSCRIPTION = applied.resolvedId;
  }
  // Only emit the "default applied" note when we used the default verbatim (no
  // failover substitution kicked in), to keep the existing message accurate.
  maybeEmitDefaultApplied(resolved, applied);
  verifyAppliedSubscription(env, resolved, applied);
}

// Pre-spawn avoidance (§4.1.4): if the resolved sub failed over earlier in this
// process, substitute the first registered, dir-present sub that is NOT
// known-dead — a cheap registry walk, no probe. Best-effort; the durable signal
// is the persisted record (which failover already updated). When nothing is
// known-dead this is a no-op that returns the inputs unchanged (backward safety).
function applyPreSpawnAvoidance(
  registry: SubscriptionRegistry,
  resolvedId: string | undefined,
  configDir: string,
  allowSubstitution = true,
): { resolvedId: string | undefined; configDir: string; substituted: boolean } {
  const target = avoidanceTarget(registry, resolvedId, allowSubstitution);
  if (!target) {
    return { resolvedId, configDir, substituted: false };
  }
  const healthy = firstHealthySubscription(registry, target.id, target.account);
  if (!healthy) {
    return { resolvedId, configDir, substituted: false };
  }
  process.stderr.write(
    `[acpx] subscription "${target.id}" recently failed over; using "${healthy.id}" for this spawn (CLAUDE_CONFIG_DIR=${healthy.configDir})\n`,
  );
  return { resolvedId: healthy.id, configDir: healthy.configDir, substituted: true };
}

function avoidanceTarget(
  registry: SubscriptionRegistry,
  resolvedId: string | undefined,
  allowSubstitution: boolean,
): { id: string; account?: string } | undefined {
  if (!allowSubstitution || !resolvedId || !hasKnownDeadCredentialState()) {
    return undefined;
  }
  const failedEntry = findSubscription(resolvedId, registry);
  if (!isResolvedSubscriptionDead(resolvedId, failedEntry)) {
    return undefined;
  }
  return { id: resolvedId, ...(failedEntry !== undefined ? { account: failedEntry.account } : {}) };
}

function hasKnownDeadCredentialState(): boolean {
  return hasKnownDeadSubs() || hasKnownDeadAccounts();
}

function isResolvedSubscriptionDead(
  resolvedId: string,
  entry: SubscriptionEntry | undefined,
): boolean {
  return (
    isSubscriptionKnownDead(resolvedId) ||
    (entry !== undefined && isAccountKnownDead(entry.account))
  );
}

// First registered subscription whose dir exists and is not known-dead, skipping
// `avoidId`. Pure registry walk (no probe) for pre-spawn avoidance (§4.1.4).
function firstHealthySubscription(
  registry: SubscriptionRegistry,
  avoidId: string,
  avoidAccount?: string,
): { id: string; configDir: string } | undefined {
  for (const entry of registry.subscriptions) {
    if (
      entry.id === avoidId ||
      entry.account === avoidAccount ||
      isSubscriptionLocked(entry, registry) ||
      isSubscriptionKnownDead(entry.id) ||
      isAccountKnownDead(entry.account)
    ) {
      continue;
    }
    if (subscriptionConfigDirExists(entry.configDir)) {
      return { id: entry.id, configDir: entry.configDir };
    }
  }
  return undefined;
}

// loadSubscriptionRegistry never throws; this defends the explicit-id path
// against a surprising fs error from the existence check, matching the legacy
// behavior (and staying silent for unselected spawns, which never logged here).
function emitRegistryReadFailure(explicitId: string | null | undefined, error: unknown): void {
  const trimmed = explicitId?.trim();
  if (!trimmed) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[acpx] failed to read subscription registry for "${trimmed}" (${message}); using default Claude config\n`,
  );
}

// Explicit selections are apply-or-loud. Falling through to a default would make
// the session record lie about the account that physically ran the agent.
function formatExplicitRejection(
  rejection: NonNullable<ConfigDirChoice["explicitRejection"]>,
): string {
  if (rejection.kind === "unknown") {
    return `[acpx] subscription "${rejection.id}" not found in registry; refusing to spawn on a different account`;
  }
  if (rejection.kind === "locked") {
    return `[acpx] subscription "${rejection.id}" is locked; refusing to spawn on a locked account`;
  }
  return `[acpx] subscription "${rejection.id}" configDir not found at ${rejection.configDir}; refusing to spawn on a different account`;
}

// NEW note — only reachable when a usable default produced the configDir, i.e.
// never on a no-default box.
function emitDefaultApplied(defaultId: string, configDir: string, viaRejection: boolean): void {
  const lead = viaRejection
    ? `using registry default "${defaultId}" instead`
    : `no subscription selected; using registry default "${defaultId}"`;
  process.stderr.write(`[acpx] ${lead} (CLAUDE_CONFIG_DIR=${configDir})\n`);
}

function assignAuthCredentialEnv(
  env: NodeJS.ProcessEnv,
  methodId: string,
  credential: string,
): void {
  if (typeof credential !== "string" || credential.trim().length === 0) {
    return;
  }

  if (!methodId.includes("=") && !methodId.includes("\u0000") && env[methodId] == null) {
    env[methodId] = credential;
  }

  const normalized = toEnvToken(methodId);
  if (normalized) {
    assignIfMissing(env, `${AUTH_ENV_PREFIX}${normalized}`, credential);
    assignIfMissing(env, normalized, credential);
  }
}

function assignIfMissing(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (env[key] == null) {
    env[key] = value;
  }
}

export function resolveConfiguredAuthCredential(
  methodId: string,
  authCredentials: AcpClientOptions["authCredentials"],
): string | undefined {
  const configCredentials = authCredentials ?? {};
  return configCredentials[methodId] ?? configCredentials[toEnvToken(methodId)];
}

/**
 * Apply profile-based authentication to the env dict and return a ShimHandle
 * for openrouter profiles (caller must stop it when the session closes), or
 * null for subscription profiles. Called asynchronously after the synchronous
 * env build so the shim port is known before the adapter process spawns.
 *
 * reasoningEffortOverride: per-session effort from --reasoning-effort; overrides
 * the profile's default reasoningEffort for openrouter profiles. Validated
 * against the profile's valid effort set — throws on mismatch so the caller
 * gets a clear error rather than a silently wrong effort level.
 *
 * Constraint: openRouterApiKey must never appear in logs or process output.
 */
// Validate that an explicit effort override is in the selected profile's valid
// set; throws with a clear, user-facing error listing the valid levels.
function normalizedReasoningEffortOverride(
  effortOverride: string | null | undefined,
): string | undefined {
  const trimmedEffort = effortOverride?.trim();
  // Persisted/UI state may use the literal "default" to mean "no override".
  // Profile auth validation must not treat that sentinel as an effort level.
  return trimmedEffort && trimmedEffort !== "default" ? trimmedEffort : undefined;
}

function validateProfileReasoningEffort(
  profileId: string,
  profile: ProfileEntry,
  effortOverride: string | null | undefined,
): void {
  const trimmedEffort = normalizedReasoningEffortOverride(effortOverride);
  if (!trimmedEffort) {
    return;
  }
  const validEfforts = getValidEffortsForProfile(profile);
  if (!validEfforts) {
    throw new Error(
      `[acpx] profile "${profileId}" does not support --reasoning-effort. ` +
        `Remove --reasoning-effort to use this profile without a reasoning override.`,
    );
  }
  if (!validEfforts.includes(trimmedEffort)) {
    throw new Error(
      `[acpx] --reasoning-effort "${trimmedEffort}" is not valid for profile "${profileId}" ` +
        `(${profile.authMode}). Valid levels: ${validEfforts.join(", ")}`,
    );
  }
}

// Fail-fast guard for v1 subscription selection on the claude-pty bridge.
// Unselected spawns pass silently (the bridge owns auth via its HOME selector);
// an explicit id is a configuration error worth stopping the spawn over —
// subscription configDirs hold headless setup-tokens, which interactive Claude
// rejects at its login picker (a wedged TUI, not a clean error).
function rejectExplicitSubscriptionForClaudePty(subscriptionId: string | null | undefined): void {
  const trimmed = subscriptionId?.trim();
  if (!trimmed) {
    return;
  }
  throw new Error(
    `[acpx] subscription "${trimmed}" cannot be used with the claude-pty bridge agent: ` +
      `subscription configDirs hold headless setup-tokens, which interactive Claude does not accept. ` +
      `Use a claude-home profile instead (--profile <id>).`,
  );
}

// The loud half of the `--subscription` family gate: say once, on stderr, that
// the selection is not being applied. Never an error — a subscription id on a
// non-Claude session is a no-op, not a configuration failure, and a throw would
// break sessions that carry a leftover id from before this gate existed.
function warnSubscriptionIgnoredForNonClaudeAgent(
  subscriptionId: string,
  agentCommand: string,
): void {
  process.stderr.write(
    `[acpx] subscription "${subscriptionId}" is not applied for agent command "${agentCommand}": ` +
      `subscriptions select a Claude account (CLAUDE_CONFIG_DIR), which this harness does not read.\n`,
  );
}

function assertClaudePtyProfileCompatibility(params: {
  profileId: string;
  profile: ProfileEntry;
  agentCommand: string;
  claudePty: boolean;
}): void {
  if (params.profile.authMode === "claude-home" && !params.claudePty) {
    throw new Error(
      `[acpx] profile "${params.profileId}" (authMode "claude-home") requires the claude-pty bridge agent; ` +
        `this session's agent command is "${params.agentCommand}". ` +
        `Create the session with the claude-pty agent to use this profile.`,
    );
  }
  if (params.profile.authMode !== "claude-home" && params.claudePty) {
    throw new Error(
      `[acpx] profile "${params.profileId}" (authMode "${params.profile.authMode}") cannot be used with the ` +
        `claude-pty bridge agent: its credentials are not an interactive Claude login ` +
        `(interactive Claude would wedge at the login picker). Use a claude-home profile.`,
    );
  }
}

function assertCodexProfileCompatibility(params: {
  profileId: string;
  profile: ProfileEntry;
  agentCommand: string;
  codex: boolean;
}): void {
  if (params.profile.authMode === "chatgpt" && !params.codex) {
    throw new Error(
      `[acpx] profile "${params.profileId}" (authMode "chatgpt") requires the codex adapter; ` +
        `this session's agent command is "${params.agentCommand}". Create the session with the codex agent.`,
    );
  }
  if (params.profile.authMode !== "chatgpt" && params.codex) {
    throw new Error(
      `[acpx] profile "${params.profileId}" (authMode "${params.profile.authMode}") cannot be used with the ` +
        `codex adapter. Use a chatgpt profile for codex auth.`,
    );
  }
}

// Both-directions profile↔agent compatibility gate, evaluated on EVERY spawn
// (create / recover / keepwarm — applyProfileAuth is on the single resolution
// path). claude-home profiles only work on the claude-pty bridge (interactive
// HOME logins); every other authMode must stay off the bridge (their
// credentials are not an interactive Claude login). Skipped when the caller
// cannot supply the agent command (no silent false negatives — every
// production spawn path passes it).
function validateProfileAgentCompatibility(
  profileId: string,
  profile: ProfileEntry,
  agentCommand: string | undefined,
): void {
  if (agentCommand === undefined) {
    return;
  }
  const split = splitCommandLine(agentCommand);
  const claudePty = isClaudePtyAgentCommand(agentCommand);
  const codex = isCodexAcpCommand(split.command, split.args);
  assertClaudePtyProfileCompatibility({ profileId, profile, agentCommand, claudePty });
  assertCodexProfileCompatibility({ profileId, profile, agentCommand, codex });
}

// claude-home branch of applyProfileAuth: the bridge owns auth via its HOME
// selector. Inject the full allow-list map (ALL claude-home profiles in the
// registry) so the bridge's unknown-selector diagnostics stay meaningful; the
// per-session selection travels as session/new _meta (buildClaudeHomeSelectorMeta),
// never as env. No CLAUDE_CONFIG_DIR: subscription configDir resolution does
// not apply to interactive-home credentials (the bridge strips leaked SDK env
// defensively, but acpx must not emit it). ACPX_SUBSCRIPTION is re-stamped
// later as the unified selection id for child-spawn compatibility. The map
// holds paths only, never credential contents.
function applyClaudeHomeProfileAuth(env: NodeJS.ProcessEnv, registry: ProfileRegistry): void {
  env[INDEPENDENT_CLAUDE_HOME_MAP_ENV] = JSON.stringify(buildClaudeHomeMap(registry));
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ACPX_SUBSCRIPTION;
}

function applyChatGptProfileAuth(env: NodeJS.ProcessEnv, profile: ProfileEntry): void {
  if (profile.authMode !== "chatgpt") {
    return;
  }
  env.CODEX_HOME = profile.codexHome;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ACPX_SUBSCRIPTION;
  delete env[INDEPENDENT_CLAUDE_HOME_MAP_ENV];
}

/**
 * The `_meta` fragment selecting the bridge HOME for a claude-home profile
 * session: { "independent-claude-acp/home": <profile id> }. Undefined for
 * non-claude-home (or unknown) profiles. Re-resolved from the registry on
 * every call, so each spawn stays record-driven (restart safety): a missing
 * selector would NOT error bridge-side — it silently falls back to the box
 * default HOME (wrong credentials) — so callers attach this on every
 * session/new (and session/load, for when the bridge advertises loadSession).
 */
export function buildClaudeHomeSelectorMeta(
  profileId: string | null | undefined,
  lookupOptions?: SubscriptionLookupOptions,
): Record<string, unknown> | undefined {
  const trimmed = profileId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const profile = findProfile(trimmed, loadProfileRegistry(lookupOptions));
  if (profile?.authMode !== "claude-home") {
    return undefined;
  }
  return { [INDEPENDENT_CLAUDE_HOME_META_KEY]: trimmed };
}

/**
 * FW-18/FW-19: the parent session's acpx-ui URL for a spawn. Prefers the explicit
 * full `parentSessionUrl`, which carries the REAL host for a cross-box parent;
 * otherwise derives `${baseUrl}/?session=${parentSessionId}` against the local base
 * URL, which is correct for a same-box parent and only for one.
 *
 * ⚠️ DO NOT "simplify" this back to always composing from `parentSessionId`. The id
 * is a bare uuid and sessions never resolve cross-box, so recomposing it locally
 * produces a well-formed URL for a session that does not exist on this box — and
 * the child handed it sends its whole report-back contract into a 404 while
 * believing it reported upward. That was brick://c6e3618b. `test/parent-session-url
 * .test.ts` goes red if the preference is removed.
 *
 * Used by BOTH spawn paths, which is the point: the SDK claude adapter inherits its
 * parent from the process env (ACPX_PARENT_SESSION_URL via buildAgentEnvironment),
 * while the claude-pty bridge serves many ACP sessions per process and must learn
 * each session's parent per-`session/new` via `_meta`. They previously disagreed.
 */
function resolveParentSessionUrl(
  sessionContext: AgentSessionContext | undefined,
  baseUrl: string | undefined,
): string | undefined {
  const explicitUrl = sessionContext?.parentSessionUrl?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }
  const parentId = sessionContext?.parentSessionId?.trim();
  // An id with no base is not composable into a URL, and a parent id alone is not
  // a URL — so there is nothing to report. The explicit URL above still works: it
  // arrived whole and never needed this box's host.
  if (!parentId || !baseUrl) {
    return undefined;
  }
  return `${baseUrl}/?session=${parentId}`;
}

/**
 * The bridge-only `_meta` fragment carrying the parent session URL. Returns
 * undefined when there is no parent or the agent is not the bridge (the namespaced
 * key is harmless to other adapters, but gating keeps the contract explicit).
 */
export function buildClaudeParentSessionMeta(
  sessionContext: AgentSessionContext | undefined,
  agentCommand: string | undefined,
): Record<string, unknown> | undefined {
  if (agentCommand === undefined || !isClaudePtyAgentCommand(agentCommand)) {
    return undefined;
  }
  const url = resolveParentSessionUrl(sessionContext, resolveAcpxUiBaseUrl(process.env));
  return url ? { [INDEPENDENT_CLAUDE_PARENT_SESSION_URL_META_KEY]: url } : undefined;
}

// Handles the openrouter authMode branch of applyProfileAuth.
//
// Precedence, unchanged at the top and extended only at the bottom:
//   1. `openRouterApiKeyEnv` resolved against THIS process's environment
//   2. the box provider credential DECLARING that same variable name
//   3. the literal `openRouterApiKey`
//
// ⚠️ STEP 2 IS WHY A PROFILE CAN POINT AT THE BOX KEY AT ALL, and without it the
// indirection silently cannot reach it. `applyBoxProviderEnv` writes into the
// CHILD spawn env; this function runs in the acpx PARENT and reads `process.env`,
// which the child env never touches. So a profile carrying
// `openRouterApiKeyEnv: "OPENROUTER_API_KEY"` on a box whose only copy of that
// variable lives in providers.json would fall through to the literal — i.e. to
// the second copy of the key that "one key on the box, one place it lives" exists
// to eliminate. Matching on the provider's DECLARED `env` name (not on a
// hardcoded provider id) keeps one convention: the profile names a VARIABLE, and
// providers.json is what supplies that variable.
//
// Step 3 stays last so every profile that ships a literal today is untouched.
//
// Exported ONLY so `test/box-provider-profile-fallback.test.ts` can assert the
// precedence directly. It is deliberately tested through its REAL resolution
// (ACPX_STATE_HOME → providers.json) rather than through an injected path, so
// the test cannot pass on a seam production does not use.
export function resolveOpenRouterApiKey(profile: OpenRouterProfileEntry): string | undefined {
  if (profile.openRouterApiKeyEnv) {
    const envValue = process.env[profile.openRouterApiKeyEnv];
    if (typeof envValue === "string" && envValue.trim().length > 0) {
      return envValue;
    }
    const boxProvider = loadBoxProviders().providers.find(
      (entry) => entry.env === profile.openRouterApiKeyEnv,
    );
    if (boxProvider) {
      const boxKey = resolveBoxProviderKey(boxProvider);
      if (boxKey) {
        return boxKey;
      }
    }
  }
  return profile.openRouterApiKey;
}

async function applyOpenRouterProfileAuth(
  env: NodeJS.ProcessEnv,
  profileId: string,
  sessionId: string,
  profile: OpenRouterProfileEntry,
  reasoningEffortOverride: string | null | undefined,
): Promise<ShimHandle | null> {
  const apiKey = resolveOpenRouterApiKey(profile);
  const model = profile.model;
  if (!apiKey || !model) {
    throw new Error(
      `[acpx] profile "${profileId}" is missing OpenRouter credentials or model; refusing to spawn under a different account`,
    );
  }

  // Validate then resolve effort: per-session override > profile default.
  const trimmedEffort = normalizedReasoningEffortOverride(reasoningEffortOverride);
  const resolvedEffort = trimmedEffort ?? profile.reasoningEffort;

  return await startOpenRouterShimForSession(env, sessionId, apiKey, model, resolvedEffort);
}

/**
 * Start the OpenRouter shim for a session and shape the spawn env around it.
 *
 * ⚠️ EXTRACTED SO THE TWO ROUTES CANNOT DRIFT (brick 007eaac8). The legacy
 * PROFILE route and the picker route differ in exactly two inputs — which
 * credential, and which model — and in nothing else: both need the same isolated
 * `CLAUDE_CONFIG_DIR`, the same `ANTHROPIC_BASE_URL`, the same `ANTHROPIC_AUTH_TOKEN`
 * placeholder and the same `ANTHROPIC_CUSTOM_HEADERS` removal. Duplicating this
 * body would have made a future fix to one route silently miss the other; the
 * `CLAUDE_CONFIG_DIR` isolation especially, whose absence would let the adapter
 * inherit the box's real Claude OAuth while talking to OpenRouter.
 *
 * ⚠️ `apiKey` IS A SECRET AND STAYS A PARAMETER. It goes into the SHIM CHILD's
 * environment (`spawnOpenRouterShim`) and nowhere else — never the agent env,
 * never a log line, never the session record.
 */
export async function startOpenRouterShimForSession(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  apiKey: string,
  model: string,
  reasoningEffort: string | undefined,
): Promise<ShimHandle> {
  // Isolate Claude config in a per-session temp dir (no OAuth inheritance).
  const configDir = join(tmpdir(), `or-${sessionId}`);
  mkdirSync(configDir, { recursive: true });
  env.CLAUDE_CONFIG_DIR = configDir;

  // The box's provider-routing policy, resolved ONCE HERE — synchronously, from
  // the env this spawn was asked about, with no network hop (brick 4c272cab).
  //
  // ⚠️ THIS IS THE SINGLE POINT FOR BOTH CLAUDE ROUTES, for the same reason the
  // function itself was extracted (brick 007eaac8): the legacy PROFILE route and
  // the picker route both arrive here, so a policy applied further up would
  // silently cover one and not the other.
  //
  // ⚠️ AND IT IS RESOLVED AGAINST THE MODEL THE SHIM WILL ACTUALLY SEND, not the
  // alias Claude Code thinks it is using — `perModel` is keyed by the OpenRouter
  // slug, which is exactly what `model` is here.
  //
  // ⚠️ AND THE WARNING IS CARRIED OUT, NOT SWALLOWED (TE finding F-1). A settings
  // file this validator rejects is dropped WHOLE — the right call, a partial
  // policy being a shape nobody authored — but measured end-to-end the gear then
  // showed a policy in force while the box applied nothing, with no error on
  // either side. The stderr line is said here; the record breadcrumb rides the
  // handle to the client, which puts it on the lifecycle snapshot.
  const routing = resolveBoxRouting(env, model);
  reportRoutingPolicyWarning(routing.warning);
  const shim = await spawnOpenRouterShim(apiKey, model, {
    reasoningEffort,
    providerObject: routing.provider,
    attributionLogPath: join(configDir, ATTRIBUTION_LOG_FILENAME),
  });

  pointAdapterAtShim(env, shim.port);

  return routing.warning ? { ...shim, routingPolicyWarning: routing.warning } : shim;
}

/**
 * The token handed to Claude Code so it considers itself authenticated against a
 * custom `ANTHROPIC_BASE_URL`. **It is a PLACEHOLDER, never a credential.**
 *
 * ⚠️ IT IS NON-BLANK, AND THAT IS THE WHOLE FIX. This was `" "` — a single space —
 * with the comment *"bypass the Bun availability / key check"*. That was TRUE when
 * written and became FALSE when `claude-agent-acp 0d5ab3ab` (2026-09-01) bumped
 * the SDK to Claude Code 2.1.257: **the code kept doing something that no longer
 * worked while the comment still explained why it should.**
 *
 * MEASURED (hp-pi-secondturn, two-arm probe, one variable, dummy loopback server,
 * no real credential): arm A `" "` → `Not logged in · Please run /login` and
 * **ZERO `POST /v1/messages` ever reaches the server**; arm B any non-blank
 * literal → proceeds and calls the API. Confirmed on disk across five sessions on
 * today's build — every one `authentication_failed`, `input_tokens: 0`, model
 * `<synthetic>`: **Claude Code generated the refusal itself and sent nothing.**
 *
 * ⚠️ WHY A PLACEHOLDER IS THE RIGHT VALUE AND NOT A COMPROMISE — SOURCE, not
 * inference: the shim **overwrites** the header unconditionally
 * (`fwdHeaders['authorization'] = 'Bearer ' + API_KEY`, `openrouter-shim-code.ts`),
 * so whatever the adapter sends is **discarded before anything leaves the box**.
 * The real OpenRouter key lives only in the shim child's own environment. A value
 * here therefore has exactly one job — be non-blank — and must be **obviously
 * synthetic**, so it can never be mistaken for, or mistakenly replaced by, a
 * credential.
 *
 * ⚠️ WHAT IS *NOT* ESTABLISHED, so nobody builds on it: the SDK's exact predicate
 * (trim-then-empty? a format check?) was **not** read out of the binary. The two
 * measured arms and the discard above are what license this value — *"past the
 * local login check"* is also **not** *"the route serves"*: only a real turn
 * against the real shim can show that.
 *
 * ## 🛑 THE REASON, WRITTEN SO IT CANNOT EXPIRE THE WAY THE LAST ONE DID
 *
 * The comment this replaces named a **mechanism** — *"bypass the Bun availability
 * / key check"* — and a mechanism is exactly the kind of claim a vendor bump
 * silently falsifies. It did, on 2026-09-01, and the line kept executing while its
 * justification had quietly become fiction. So the reason below is written as a
 * REQUIREMENT and a CONSEQUENCE, neither of which depends on how any SDK version
 * happens to implement its check:
 *
 *   **REQUIREMENT.** Claude Code will not talk to a custom `ANTHROPIC_BASE_URL`
 *   until it considers itself authenticated. Something must satisfy that local
 *   precondition. The real credential MUST NOT be that something, because the
 *   shim — not the adapter — is what authenticates to the provider.
 *   ⇒ a synthetic value belongs here, in every SDK version, whatever the check is.
 *
 *   **CONSEQUENCE, and this is the part that shortens the next diagnosis.** If a
 *   future SDK stops accepting this value, the failure is a LOCAL REFUSAL WITH NO
 *   HTTP AT ALL: an `authentication_failed` turn, `input_tokens: 0`, a
 *   `<synthetic>` model, and **nothing in the shim's or the provider's logs**. That
 *   signature means *"the local login precondition rejected our placeholder"* — it
 *   does **not** mean a bad key, a broken shim, or an OpenRouter outage. Re-measure
 *   what the SDK accepts and change ONLY this constant.
 *
 * ⇒ **If you are reading this because OpenRouter sessions stopped working: check
 * whether any request left the box before you touch anything downstream.** That
 * one question is what took a day to ask last time.
 */
export const OPENROUTER_SHIM_AUTH_PLACEHOLDER = "acpx-openrouter-shim-placeholder";

/**
 * Point a claude adapter's spawn env at an already-running shim.
 *
 * ⚠️ ONE FUNCTION BECAUSE THERE ARE TWO CALLERS AND FIXING ONE IS THE BUG. This
 * shaping was duplicated: here for the FIRST spawn, and in
 * `AcpClient.reinjectRunningShim` for the RECONNECT. Both carried their own
 * `" "`, so repairing only the spawn copy would have left **every resumed
 * OpenRouter session** — legacy profile and picker route alike — still refusing
 * locally, with the create path looking fixed. That is the same
 * shipped-in-one-of-two-places failure that produced the turn-path outage this
 * branch also fixes; it is not repeated a third time.
 */
export function pointAdapterAtShim(env: NodeJS.ProcessEnv, port: number): void {
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  env.ANTHROPIC_AUTH_TOKEN = OPENROUTER_SHIM_AUTH_PLACEHOLDER;
  // Remove any custom headers set by the subscription path —
  // the shim injects Authorization itself.
  delete env.ANTHROPIC_CUSTOM_HEADERS;
}

export async function applyProfileAuth(
  env: NodeJS.ProcessEnv,
  profileId: string,
  sessionId: string,
  reasoningEffortOverride?: string | null,
  lookupOptions?: SubscriptionLookupOptions,
  agentCommand?: string,
  onProvisioningWarning?: ProvisioningWarningHandler,
): Promise<ShimHandle | null> {
  const trimmedId = profileId.trim();
  if (!trimmedId) {
    return null;
  }
  const registry = loadProfileRegistry(lookupOptions);
  const profile = findProfile(trimmedId, registry);
  if (!profile) {
    throw new Error(
      `[acpx] profile "${trimmedId}" not found in registry; refusing to spawn under a different account. ` +
        `Restore the profile in ~/.acpx/subscriptions/registry.json or recreate the session.`,
    );
  }

  validateProfileAgentCompatibility(trimmedId, profile, agentCommand);
  validateProfileReasoningEffort(trimmedId, profile, reasoningEffortOverride);
  if (isSubscriptionProfileLocked(profile, registry)) {
    throw new SubscriptionLockedError(trimmedId);
  }

  if (profile.authMode === "claude-home") {
    applyClaudeHomeProfileAuth(env, registry);
    verifyProfileEffectiveAccount(env, profile, registry);
    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env,
      onWarning: onProvisioningWarning,
    });
    return null;
  }

  if (profile.authMode === "subscription") {
    // Behave exactly like applySubscriptionConfigDir for subscription profiles.
    applySubscriptionConfigDir(env, trimmedId, lookupOptions);
    verifyProfileEffectiveAccount(env, profile, registry);
    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env,
      onWarning: onProvisioningWarning,
    });
    return null;
  }

  if (profile.authMode === "openrouter") {
    const shim = await applyOpenRouterProfileAuth(
      env,
      trimmedId,
      sessionId,
      profile,
      reasoningEffortOverride,
    );
    verifyProfileEffectiveAccount(env, profile, registry);
    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env,
      onWarning: onProvisioningWarning,
    });
    return shim;
  }

  if (profile.authMode === "chatgpt") {
    applyChatGptProfileAuth(env, profile);
    verifyProfileEffectiveAccount(env, profile, registry);
    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env,
      onWarning: onProvisioningWarning,
    });
    return null;
  }

  return null;
}

export function buildAgentSpawnOptions(
  cwd: string,
  authCredentials: Record<string, string> | undefined,
  sessionContext?: AgentSessionContext,
  lookupOptions?: SubscriptionLookupOptions,
  agentCommand?: string,
  onProvisioningWarning?: ProvisioningWarningHandler,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  return {
    cwd,
    env: buildAgentEnvironment(
      authCredentials,
      sessionContext,
      lookupOptions,
      agentCommand,
      onProvisioningWarning,
    ),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}
