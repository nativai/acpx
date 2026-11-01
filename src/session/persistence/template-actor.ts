/**
 * Attribution on a template block: `created_actor` / `updated_actor` (TEMPLATES CONCEPTION §4.2, K9; brick
 * 4608e926; build block T1 of brick fcef527e).
 *
 * The actor is an actor-contract object (brick 47e89f5c §2.2: `{kind:'human'|'agent'|…, …}`, snake_case
 * keys). acpx treats it as OPAQUE: it keeps a plain object whose JSON is at most 4,096 bytes and whose keys
 * all satisfy the persisted-key policy, and drops anything else FIELD-ONLY (never the block, never the
 * record). It never reads `kind`, so a kind this acpx has not heard of is kept whole.
 *
 * Who is recorded for a CLI write (CONCEPTION §8.1), in order:
 *   1. `ACPX_ACTOR_B64` — base64url JSON, the actor contract's `x-acpx-actor` encoding. Set only on the acpx
 *      children atrium spawns for template writes, from `res.locals.actor`; never in an agent's environment.
 *   2. `{kind:'agent', session_id, session_url}` from the caller's `ACPX_SESSION_URL`.
 *   3. Nothing.
 * ⚠️ ATTRIBUTION, NEVER AUTHORIZATION: forging `ACPX_ACTOR_B64` only spoofs a label (the same class as
 * forging headers against :3456). Nothing may grant or deny on a stored actor.
 */
import { findPersistedKeyPolicyViolations } from "../../persisted-key-policy.js";
import type { PersistedActor } from "../../types.js";

/** A serialised actor is at most this many bytes (actor contract 2.1-5). */
export const MAX_ACTOR_BYTES = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The actor as stored, or undefined when `raw` is not a policy-clean plain object within the size cap. */
export function parsePersistedActor(raw: unknown): PersistedActor | undefined {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    return undefined;
  }
  const json = JSON.stringify(raw);
  if (Buffer.byteLength(json, "utf8") > MAX_ACTOR_BYTES) {
    return undefined;
  }
  return findPersistedKeyPolicyViolations(raw).length === 0 ? raw : undefined;
}

function decodeActorHeader(value: string): PersistedActor | undefined {
  try {
    return parsePersistedActor(JSON.parse(Buffer.from(value.trim(), "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function sessionIdOfUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("session") ?? undefined;
  } catch {
    return undefined;
  }
}

/** The actor for a template write by this process, or undefined when none can be named. */
export function templateActorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PersistedActor | undefined {
  const header = env.ACPX_ACTOR_B64?.trim();
  if (header) {
    const decoded = decodeActorHeader(header);
    if (decoded) {
      return decoded;
    }
  }
  const sessionUrl = env.ACPX_SESSION_URL?.trim();
  if (!sessionUrl) {
    return undefined;
  }
  const sessionId = sessionIdOfUrl(sessionUrl);
  return {
    kind: "agent",
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    session_url: sessionUrl,
  };
}
