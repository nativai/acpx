import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Box-scoped provider credentials — `~/.acpx/providers.json`, mode 0600.
//
// WHAT THIS FILE IS: the answer to "what can THIS BOX talk to", one entry per
// provider credential the box holds. Written by an infra agent on the box it
// belongs to (never copied between boxes); read by acpx itself — the Claude
// OpenRouter shim's key (`resolveOpenRouterBoxCredential`), generation lookups,
// and pi's per-session `auth.json`, which points at this file by command instead
// of holding the key (`writePiAuthFile`).
//
// ⚠️ NO ENTRY IS EVER PUT INTO AN AGENT'S ENVIRONMENT (brick 1dc24c1c, Daniel
// 2026-10-24). This file used to be delivered as `OPENROUTER_API_KEY` into every
// adapter spawn, so every agent's shell, every `workbench-exec` command and every
// dev server it started carried the box key — and a project's own `.env` value
// for the same name lost to it, because `dotenv` / `@next/env` never override a
// set variable. The variable is now stripped from every agent env
// (`AGENT_STRIPPED_CREDENTIAL_ENV`); do not reintroduce env delivery for any
// harness. `env` on an entry is kept as the provider's conventional variable
// name (a redaction input, `boxProviderEnvNames`), not as a delivery target.
//
// ⚠️ IT IS DELIBERATELY *NOT* `registry.json`. That file is a FIXED cross-repo
// contract whose every entry is a PER-SESSION SELECTABLE PROFILE — acpx-ui
// serves it from `GET /api/profiles` into a picker. A box-level credential is a
// category error there: it must never be selectable, and there is no
// `--provider` flag. A box either can reach a provider or it cannot.
// (C4 CONCEPTION §4.1 option 2, rejected; §4.2 decision.)
//
// ⚠️ THREAT MODEL, STATED RATHER THAN IMPLIED. Mode 0600 does NOT isolate agents
// from each other on these boxes: every agent runs as the same `node` uid, so
// any agent on the box can read this file — and equally can read the ambient
// variant out of /proc/*/environ. THE PER-BOX KEY IS A BOX-LEVEL SECRET, NOT AN
// AGENT-LEVEL ONE. That is acceptable only because of what contains it: the key
// is budget-capped monthly, natively expiring, individually revocable by
// `keyHash`, and attributable to exactly one box. A FLEET-WIDE key would not be
// acceptable, which is what per-box minting avoids. Nothing here should be read
// as a stronger guarantee than that.

/** `providers.<name>` — one provider credential this box holds. */
export type BoxProviderEntry = {
  /** The map key, carried onto the entry so callers can name what they got. */
  name: string;
  /** The provider's conventional variable name (e.g. `OPENROUTER_API_KEY`). Never set on an agent env. */
  env: string;
  /**
   * The literal credential. ⚠️ SECRET — never log it, never render it, never
   * write it anywhere but this file. `describeBoxProviders()` exists precisely
   * so a diagnostic surface cannot reach it.
   */
  apiKey?: string;
  /**
   * Indirection: read the credential from THIS process's environment under the
   * named variable instead of storing a literal. Beats `apiKey` when it resolves
   * — the same precedence the profile schema already uses for
   * `openRouterApiKeyEnv` over `openRouterApiKey` (auth-env.ts
   * `resolveOpenRouterApiKey`). One convention, not two.
   */
  apiKeyEnv?: string;
  /** How the credential was obtained. */
  source?: string;
  /** Cardea grant id — an audit back-reference. NOT a secret. */
  grantId?: string;
  /** Provider-side key hash. NOT a secret: it exists so a key can be revoked without holding it. */
  keyHash?: string;
  budgetUsd?: number;
  limitReset?: string;
  /** Native provider-side `expires_at` — the real deadline. Drives the expiry warning. */
  expiresAt?: string;
  mintedAt?: string;
};

export type BoxProviders = {
  version: number;
  /** The box this file was minted for — attribution plus a sanity check on a stray copy. */
  box?: string;
  providers: BoxProviderEntry[];
};

const PROVIDERS_FILENAME = "providers.json";

/**
 * Raise the expiry warning at 14 days. Not polish: when the key expires and
 * nothing renews it, EVERY Pi session on the box fails at the
 * provider with a 401 that surfaces as an unhelpful `UnknownError`. This is what
 * turns a silent fleet-wide outage into a two-week warning, and it is the whole
 * reason `expiresAt` is stored rather than inferred.
 */
export const BOX_PROVIDER_EXPIRY_WARNING_DAYS = 14;

export type BoxProviderLookupOptions = {
  /** Root the resolution somewhere else (tests, an isolated HOME). */
  homeDir?: string;
  /** Bypass `homeDir` entirely and read this exact file. */
  providersPath?: string;
  /** Environment consulted for `apiKeyEnv` indirection. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

function defaultHomeDir(): string {
  return process.env.ACPX_STATE_HOME || os.homedir();
}

export function boxProvidersPath(homeDir: string = defaultHomeDir()): string {
  return path.join(homeDir, ".acpx", PROVIDERS_FILENAME);
}

function emptyProviders(): BoxProviders {
  return { version: 1, providers: [] };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The optional string fields, as a table rather than a chain of conditional
 * spreads — one place to add a field for PARSING.
 *
 * 🛑 **THIS IS NOT THE ONLY LIST. `STATUS_FIELDS` BELOW DRIVES THE PROJECTION, AND
 * A FIELD MISSING FROM EITHER IS DROPPED SILENTLY** — absent from a parsed entry, or
 * present on the entry and invisible to `acpx providers`, with nothing failing in
 * either direction. `apiKey` / `apiKeyEnv` are in this list and deliberately NOT in
 * that one (they are secret); **every other field belongs in both**, and
 * `test/box-providers.test.ts` round-trips one through parsing AND the projection for
 * exactly this reason.
 */
const OPTIONAL_STRING_FIELDS = [
  "apiKey",
  "apiKeyEnv",
  "source",
  "grantId",
  "keyHash",
  "limitReset",
  "expiresAt",
  "mintedAt",
] as const;

function parseEntry(name: string, raw: unknown): BoxProviderEntry | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const env = nonEmptyString(value.env);
  if (!env) {
    // The schema requires the variable name; drop a malformed entry rather
    // than half-honor it.
    return undefined;
  }
  const entry: BoxProviderEntry = { name, env };
  for (const field of OPTIONAL_STRING_FIELDS) {
    const parsed = nonEmptyString(value[field]);
    if (parsed !== undefined) {
      entry[field] = parsed;
    }
  }
  const budgetUsd = finiteNumber(value.budgetUsd);
  if (budgetUsd !== undefined) {
    entry.budgetUsd = budgetUsd;
  }
  return entry;
}

/** The file's parsed root, or undefined for every "no usable file" case. */
function readProvidersFile(providersPath: string): Record<string, unknown> | undefined {
  if (!existsSync(providersPath)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(providersPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Load the box's provider credentials.
 *
 * ⚠️ AN ABSENT FILE IS THE NORMAL CASE, NOT AN ERROR. Most boxes will not have
 * one, and this is read on the session-creation path — a missing, unreadable or
 * malformed file degrades to "this box has no provider credential" and MUST
 * NEVER throw into session creation.
 */
export function loadBoxProviders(options?: BoxProviderLookupOptions): BoxProviders {
  const providersPath = options?.providersPath ?? boxProvidersPath(options?.homeDir);
  const root = readProvidersFile(providersPath);
  if (!root) {
    return emptyProviders();
  }
  const loaded: BoxProviders = {
    version: finiteNumber(root.version) ?? 1,
    providers: parseProviderMap(root.providers),
  };
  const box = nonEmptyString(root.box);
  if (box !== undefined) {
    loaded.box = box;
  }
  return loaded;
}

function parseProviderMap(rawProviders: unknown): BoxProviderEntry[] {
  if (typeof rawProviders !== "object" || rawProviders === null) {
    return [];
  }
  const providers: BoxProviderEntry[] = [];
  for (const [name, raw] of Object.entries(rawProviders as Record<string, unknown>)) {
    const entry = parseEntry(name, raw);
    if (entry) {
      providers.push(entry);
    }
  }
  return providers;
}

/**
 * The credential for one entry. `apiKeyEnv` beats a literal `apiKey`, mirroring
 * the profile schema's existing precedence.
 *
 * ⚠️ Returns a SECRET. Callers may hand it to the one child that needs it (the
 * OpenRouter shim) and nowhere else — never an AGENT environment, a log line, an
 * error message, a session record or an evidence file.
 */
export function resolveBoxProviderKey(
  entry: BoxProviderEntry,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (entry.apiKeyEnv) {
    const indirect = env[entry.apiKeyEnv];
    if (typeof indirect === "string" && indirect.trim().length > 0) {
      return indirect;
    }
  }
  return entry.apiKey;
}

/**
 * The comparison handle for a credential. ⚠️ NEVER A PREFIX OF THE VALUE — a
 * truncated SHA-256 of a high-entropy key is not reversible, whereas the first
 * eight characters of the key itself would be exactly the leak
 * `BoxProviderStatus` is shaped to prevent. 16 hex chars is the same width the
 * programme's own field measurements used (`174e5d29d299b4c2`), so a warning
 * line and a `/proc` census can be compared by eye.
 */
export function fingerprintCredential(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * The declared env variable NAMES, whether or not a credential resolves for
 * them. This is the set an evidence redactor must cover: a name is declared here
 * before anyone remembers to add it to a redaction list, which is exactly when a
 * value leaks.
 */
export function boxProviderEnvNames(options?: BoxProviderLookupOptions): string[] {
  return loadBoxProviders(options).providers.map((entry) => entry.env);
}

/**
 * A provider's status, with NO credential field of any kind.
 *
 * ⚠️ THE ABSENCE OF `apiKey` HERE IS STRUCTURAL, NOT A `delete`. `grantId` and
 * `keyHash` ARE safe to render (`keyHash` exists precisely so a key can be
 * revoked without holding it); `apiKey` is not, and the way to keep it that way
 * is for the diagnostic type to have no slot for it.
 */
export type BoxProviderStatus = {
  name: string;
  env: string;
  source?: string;
  grantId?: string;
  keyHash?: string;
  budgetUsd?: number;
  limitReset?: string;
  expiresAt?: string;
  mintedAt?: string;
  /** Whether a credential actually resolves — the boolean, never the value. */
  hasCredential: boolean;
  /** Whole days until `expiresAt`; negative once past. Undefined when unstamped. */
  expiresInDays?: number;
  /** `expiresInDays <= 14` (and not yet expired). */
  expiringSoon: boolean;
  expired: boolean;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The acpx-side read behind "this box's OpenRouter credential expires in N
 * days". Renders no credential — see `BoxProviderStatus`.
 *
 * ⚠️ CARRIER: DO NOT ADD THE KEY, OR A PREFIX OF IT, TO THIS RETURN TYPE. It
 * looks like a harmless "which key is this?" affordance and it is the leak: this
 * is the surface a UI mounts and a diagnostic dumps. `keyHash` already answers
 * "which key" without holding one. `test/box-providers.test.ts` asserts the
 * serialized status contains no `sk-`-shaped value and goes red if it does.
 */
export function describeBoxProviders(
  options?: BoxProviderLookupOptions & { now?: Date },
): BoxProviderStatus[] {
  const now = options?.now ?? new Date();
  const sourceEnv = options?.env ?? process.env;
  return loadBoxProviders(options).providers.map((entry) => describeEntry(entry, now, sourceEnv));
}

/**
 * ⚠️ THE COPY IS FIELD-BY-FIELD FROM AN EXPLICIT LIST, NOT `{...entry}`. A spread
 * would carry `apiKey` straight into the diagnostic surface the moment anyone
 * refactored this, which is precisely the leak `BoxProviderStatus` is shaped to
 * make impossible. `apiKey` and `apiKeyEnv` are absent from the list on purpose.
 */
const STATUS_FIELDS = [
  "source",
  "grantId",
  "keyHash",
  "limitReset",
  "expiresAt",
  "mintedAt",
] as const;

/**
 * ⚠️ AN UNSTAMPED OR UNPARSEABLE `expiresAt` IS `undefined`, NEVER 0 AND NEVER A
 * WARNING. Both wrong answers are actively harmful: 0 would read as "expires
 * today" and a negative as "already expired", either of which manufactures an
 * outage report for a key that is fine.
 */
function expiryOf(
  expiresAt: string | undefined,
  now: Date,
): { expiresInDays?: number; expiringSoon: boolean; expired: boolean } {
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) {
    return { expiringSoon: false, expired: false };
  }
  const expiresInDays = Math.floor((expiresAtMs - now.getTime()) / MS_PER_DAY);
  const expired = expiresInDays < 0;
  return {
    expiresInDays,
    expiringSoon: !expired && expiresInDays <= BOX_PROVIDER_EXPIRY_WARNING_DAYS,
    expired,
  };
}

function describeEntry(
  entry: BoxProviderEntry,
  now: Date,
  sourceEnv: NodeJS.ProcessEnv,
): BoxProviderStatus {
  const expiry = expiryOf(entry.expiresAt, now);
  const resolved = resolveBoxProviderKey(entry, sourceEnv);
  const status: BoxProviderStatus = {
    name: entry.name,
    env: entry.env,
    hasCredential: resolved !== undefined,
    expiringSoon: expiry.expiringSoon,
    expired: expiry.expired,
  };
  for (const field of STATUS_FIELDS) {
    const value = entry[field];
    if (value !== undefined) {
      status[field] = value;
    }
  }
  if (entry.budgetUsd !== undefined) {
    status.budgetUsd = entry.budgetUsd;
  }
  if (expiry.expiresInDays !== undefined) {
    status.expiresInDays = expiry.expiresInDays;
  }
  return status;
}
