const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;

const ZED_TAG_KEYS = new Set([
  "User",
  "Agent",
  "Resume",
  "Text",
  "Mention",
  "Image",
  "Audio",
  "Thinking",
  "RedactedThinking",
  "ToolUse",
]);

const MAP_OBJECT_PATHS = new Set(["request_token_usage", "messages.Agent.tool_results"]);

const ACCOUNT_SWITCH_KEYS = new Set([
  "fromProfile",
  "toProfile",
  "fromAccount",
  "toAccount",
  "effectiveAccount",
  "effectiveProfile",
  "effectiveAuthMode",
  "effectiveAnchor",
  "effectiveResolutionMethod",
]);

const OPAQUE_VALUE_PATHS = new Set([
  "agent_capabilities",
  "messages.Agent.content.ToolUse.input",
  "acpx.desired_config_options",
  "acpx.config_options",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function joinPath(path: string[]): string {
  return path.join(".");
}

function isAllowedKey(path: string[], key: string): boolean {
  if (ZED_TAG_KEYS.has(key)) {
    return true;
  }
  if (joinPath(path) === "acpx.session_options.account_switch" && ACCOUNT_SWITCH_KEYS.has(key)) {
    return true;
  }

  return false;
}

function shouldSkipKeyRule(path: string[]): boolean {
  return MAP_OBJECT_PATHS.has(joinPath(path));
}

function shouldSkipDescend(path: string[]): boolean {
  return OPAQUE_VALUE_PATHS.has(joinPath(path)) || isToolResultOutputPath(path);
}

function isToolResultOutputTail(path: string[], toolResultsIndex: number): boolean {
  return toolResultsIndex !== -1 && toolResultsIndex + 2 === path.length - 1;
}

function isToolResultOutputPath(path: string[]): boolean {
  if (path.length < 5 || path[path.length - 1] !== "output") {
    return false;
  }

  const toolResultsIndex = path.lastIndexOf("tool_results");
  if (!isToolResultOutputTail(path, toolResultsIndex)) {
    return false;
  }

  const parentPath = path.slice(0, toolResultsIndex + 1).join(".");
  return parentPath === "messages.Agent.tool_results";
}

function collectViolations(value: unknown, path: string[], violations: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectViolations(entry, path, violations);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const skipKeyRule = shouldSkipKeyRule(path);
  for (const [key, child] of Object.entries(value)) {
    collectKeyViolation(child, key, path, skipKeyRule, violations);
  }
}

function collectKeyViolation(
  child: unknown,
  key: string,
  path: string[],
  skipKeyRule: boolean,
  violations: string[],
): void {
  if (!skipKeyRule && !SNAKE_CASE_KEY.test(key) && !isAllowedKey(path, key)) {
    violations.push(`${joinPath(path)}.${key}`.replace(/^\./, ""));
  }

  const childPath = [...path, key];
  if (!shouldSkipDescend(childPath)) {
    collectViolations(child, childPath, violations);
  }
}

export function findPersistedKeyPolicyViolations(value: unknown): string[] {
  const violations: string[] = [];
  collectViolations(value, [], violations);
  return violations;
}

export function assertPersistedKeyPolicy(value: unknown): void {
  const violations = findPersistedKeyPolicyViolations(value);
  if (violations.length === 0) {
    return;
  }

  throw new Error(
    `Persisted key policy violation (expected snake_case keys): ${violations.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// COMPILE-TIME TWIN OF THE RUNTIME POLICY ABOVE
// ---------------------------------------------------------------------------

/**
 * 🛑 THE RUNTIME CHECK ABOVE FIRES TOO LATE TO PROTECT ANYONE — IT THROWS FROM
 * INSIDE THE WRITE, BEFORE `fs.writeFile`, AND THE THROW IS SWALLOWED.
 *
 * brick://48aca560. One camelCase key added anywhere reachable from
 * {@link SessionAcpxState} makes `assertPersistedKeyPolicy` throw on EVERY
 * subsequent session-record write. The record on disk then silently freezes at
 * its last successful state: in-memory values stay correct, no exception
 * surfaces, and everything written from that moment on is lost. Measured on
 * `fix/5026423b-persist-cost`, where `cost_units[].cacheRead` alone stopped
 * `context_window_size` — an unrelated, pre-existing, shipped field — from ever
 * reaching disk again.
 *
 * Two other guards were blind to it and stay blind by construction:
 * `scripts/lint-persisted-key-casing.ts` checks ONE HAND-WRITTEN fixture record
 * and cannot see a field invented after it was written, and no unit test drives
 * a cost-bearing record through the write path.
 *
 * This assertion is the one that fires BEFORE the change ships. It is derived
 * from the TYPE, so a newly added field is covered with nothing to register and
 * no list to maintain — `pnpm run typecheck` names the offending key and fails.
 *
 * ⚠️ SCOPE, stated rather than implied: this catches an UPPERCASE letter in a
 * key, which is the camelCase hazard that has actually bitten. The runtime
 * policy is stricter (`/^[a-z][a-z0-9_]*$/`, so it also rejects `cache-read` and
 * a leading digit) and remains the authority; this is a fast, maintenance-free
 * net under the failure mode that occurs, not a restatement of the regex.
 */
export type PersistedAcpxKeysAreSnakeCase = RequireNoOffendingKeys<
  OffendingKeys<import("./types.js").SessionAcpxState>
>;

/** Mirrors the runtime `ZED_TAG_KEYS` set — serde variant tags, PascalCase by schema. */
type ZedTagKey =
  | "User"
  | "Agent"
  | "Resume"
  | "Text"
  | "Mention"
  | "Image"
  | "Audio"
  | "Thinking"
  | "RedactedThinking"
  | "ToolUse";

/**
 * The same derived guard over the MESSAGE subtree. `serialize.ts` passes
 * `messages` through wholesale, so every key under it is persisted verbatim —
 * which is why `messages.Agent.claudeUuid` reached production (brick://94b6f8fb).
 */
export type PersistedMessageKeysAreSnakeCase = RequireNoOffendingKeys<
  OffendingKeys<import("./types.js").SessionMessage>
>;

/**
 * 🛑 THE TWO GUARDS ABOVE NAME THEIR ROOT BY HAND, AND THAT IS THE SAME DEFECT
 * ONE LEVEL UP — `messages` WAS UNGUARDED FOR EXACTLY AS LONG AS NOBODY HAD
 * THOUGHT TO NAME IT.
 *
 * brick://dce67687. `PersistedAcpxKeysAreSnakeCase` walks `record.acpx`;
 * `PersistedMessageKeysAreSnakeCase` walks `record.messages`. Both were added
 * AFTER a field in that subtree had already shipped and broken persistence. Five
 * further `SessionRecord` fields are passed through `serialize.ts` WHOLESALE, so
 * their interiors are persisted verbatim exactly as `messages` is, and none of
 * them was covered by either root: `eventLog`, `messagesLog`,
 * `cumulative_token_usage`, `request_token_usage`, `template`. A camelCase field
 * added to any of them escaped precisely as `claudeUuid` did — and a brand-new
 * wholesale subtree added tomorrow would have escaped too.
 *
 * This root is derived from `SessionRecord` itself, so **the default is
 * guarded**. Nothing has to be registered, and the only way to end up unguarded
 * is to add a name to {@link UnwalkedRecordField} below — a visible, reviewable
 * edit with a stated reason, rather than an omission nobody can see.
 *
 * The record's OWN top-level keys are deliberately not checked: they are
 * camelCase in memory by design and `serialize.ts` translates them one by one
 * (`acpx_record_id: canonical.acpxRecordId`). It is their VALUES that reach disk
 * verbatim, so it is their values this walks.
 *
 * The two narrower roots above are kept: they pin the two subtrees that have
 * actually bitten, so a red there names the historical path instead of just
 * "somewhere in the record".
 *
 * Fire-tested, not asserted — `scripts/lint-persisted-key-casing.ts` injects a
 * camelCase key into a FRESH subtree type, registered nowhere, and requires
 * `tsgo` to fail naming it. Measured against the tree this commit was cut from,
 * that probe passed the typecheck (the hole) and fails it now.
 */
export type PersistedRecordSubtreeKeysAreSnakeCase = RequireNoOffendingKeys<
  RecordSubtreeOffendingKeys<import("./types.js").SessionRecord>
>;

/**
 * The only `SessionRecord` fields whose interiors are NOT walked.
 *
 * ⚠️ ADDING A NAME HERE OPTS THAT SUBTREE OUT OF THE ONLY CHECK THAT FIRES
 * BEFORE THE CHANGE SHIPS. If you are here because a new field made the guard
 * red, the fix is almost always to spell the field snake_case — not to land it
 * here. All three current entries are exempt for a reason that makes the
 * interior genuinely unreachable from disk in camelCase:
 *
 * - `subagents` / `importedFrom` — `serialize.ts` maps their fields ONE BY ONE
 *   (`serializeSubagentRef`, the `imported_from` literal), so the in-memory
 *   camelCase never reaches disk. Make one of them a wholesale passthrough and
 *   it belongs back under the guard.
 * - `agentCapabilities` — mirrors the runtime `OPAQUE_VALUE_PATHS` entry
 *   `agent_capabilities`: an opaque passthrough of the adapter's own advertised
 *   shape, which the runtime policy does not descend into either.
 */
type UnwalkedRecordField = "subagents" | "importedFrom" | "agentCapabilities";

type WalkedRecordField<T> = Exclude<Extract<keyof T, string>, UnwalkedRecordField>;

/** Every offending key in the INTERIOR of every walked `SessionRecord` field. */
type RecordSubtreeOffendingKeys<T> = {
  [K in WalkedRecordField<T>]: OffendingKeys<NonNullable<T[K]>>;
}[WalkedRecordField<T>];

/** Fails the constraint — and NAMES the key — as soon as an offender exists. */
type RequireNoOffendingKeys<Offenders extends never> = Offenders;

/** Values that hold no persisted keys of their own; recursion stops here. */
type LeafValue = string | number | boolean | bigint | symbol | null | undefined;

/**
 * String keys of `T` that are known at compile time.
 *
 * An index signature (`Record<string, …>`) contributes the key `string`, whose
 * members are chosen at runtime and so can never be checked here — the runtime
 * policy skips those same map objects (`MAP_OBJECT_PATHS`) for the identical
 * reason. Their VALUES are still walked below; only the key names are exempt.
 */
type StaticKeyOf<T> =
  Extract<keyof T, string> extends infer Key
    ? Key extends string
      ? string extends Key
        ? never
        : Key
      : never
    : never;

/**
 * Compile-time-known keys of `T` that carry an uppercase letter and are not
 * explicitly permitted by the runtime policy.
 *
 * ⚠️ BOTH EXEMPTIONS BELOW ARE DELIBERATELY UNSCOPED BY PATH, where the runtime
 * ones are path-scoped. That asymmetry is safe in exactly one direction: this
 * guard can only ever MISS a violation the runtime still catches, never invent
 * one. A guard that reds on legitimate code gets disabled; a guard that is
 * merely incomplete still catches the case that has actually bitten twice.
 */
type NonSnakeKeyOf<T> = {
  [K in StaticKeyOf<T>]: K extends Lowercase<K> ? never : K extends PermittedKey ? never : K;
}[StaticKeyOf<T>];

/**
 * Mirrors `ACCOUNT_SWITCH_KEYS` — camelCase keys the runtime policy grants an
 * explicit exception to. Grandfathered, not a precedent: a NEW persisted key
 * belongs in snake_case, and adding to this union is how you opt out of the
 * only check that would have caught brick://48aca560.
 */
type PermittedKey =
  | ZedTagKey
  | "fromProfile"
  | "toProfile"
  | "fromAccount"
  | "toAccount"
  | "effectiveAccount"
  | "effectiveProfile"
  | "effectiveAuthMode"
  | "effectiveAnchor"
  | "effectiveResolutionMethod";

/**
 * Mirrors the `acpx.*` entries of `OPAQUE_VALUE_PATHS` — fields the runtime
 * policy does not descend into because their interior is an opaque passthrough
 * of someone else's shape (an adapter's advertised config options).
 */
type OpaqueFieldName = "config_options" | "desired_config_options";

/**
 * ⚠️ RETURNED WHEN THE WALK RUNS OUT OF DEPTH — ON PURPOSE, SO EXHAUSTION IS A
 * RED AND NOT A SILENT PASS.
 *
 * brick://dce67687. The bound below used to yield `never`, which is the same
 * value a clean subtree yields: a field nested past the limit was reported as
 * "no violations found" by a walk that had in fact stopped looking. That is the
 * failure shape this whole guard exists to prevent, reproduced inside the guard.
 *
 * So exhaustion now names itself and fails the constraint. Seeing this in a
 * typecheck error means the persisted record grew deeper than the walk reaches —
 * raise the `extends 12` bound below, do not silence it.
 *
 * ⚠️ IT ALREADY CAUGHT ONE: at the bound of 8 this commit inherited,
 * {@link PersistedMessageKeysAreSnakeCase} was walking the message subtree to its
 * exact last level with ZERO headroom (measured: red at 7, green at 8). One more
 * nesting level under `messages` and that guard would have gone quietly blind —
 * the same silence, inside the fix for it. Hence the bound moved to 12.
 */
type WalkDepthLimitExceeded = "__persisted_key_walk_ran_out_of_depth__";

/**
 * Every offending key reachable from `T`.
 *
 * `Depth` bounds the walk so a self-referential type cannot make the compiler
 * recurse forever. Bisected per root with the sentinel above, 2026-09-22 on
 * `origin/dev` 5756fd6 — the smallest bound at which each root is green:
 * `acpx` **5**, `messages` **8**, the whole record **9**. 12 therefore clears the
 * deepest subtree we have by three levels, and the cost is flat: the scoped
 * typecheck measured 0.5–0.9 s at every bound from 9 to 14.
 */
type OffendingKeys<T, Depth extends readonly unknown[] = []> = Depth["length"] extends 12
  ? WalkDepthLimitExceeded
  : T extends LeafValue
    ? never
    : T extends readonly (infer Element)[]
      ? OffendingKeys<Element, [...Depth, unknown]>
      : T extends object
        ?
            | NonSnakeKeyOf<T>
            | {
                [K in Exclude<Extract<keyof T, string>, OpaqueFieldName>]: OffendingKeys<
                  NonNullable<T[K]>,
                  [...Depth, unknown]
                >;
              }[Exclude<Extract<keyof T, string>, OpaqueFieldName>]
        : never;
