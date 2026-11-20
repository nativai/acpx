/**
 * PI'S OWN MODEL KNOWLEDGE — read through a SUPPORTED interface, cached under a
 * path ACPX owns.
 *
 * ## Why this module exists (brick 6253611b)
 *
 * `writePiModelsStore()` used to decide "does pi already know this slug?" by
 * looking at **the box's remote-overlay cache alone**
 * (`readBoxPiOpenRouterModels`). That asks the wrong question. pi's knowledge is
 * its **BUNDLED** catalogue PLUS that overlay, and **measured 2026-09-07: 333 of
 * the 374 models pi advertises are BUNDLED.** So the guard was unreachable for
 * 89% of the catalogue even with a populated overlay — and on a box where the
 * overlay file does not exist at all (the actual state of every dev box, because
 * acpx re-points `PI_CODING_AGENT_DIR` at a per-session dir it later deletes) it
 * was unreachable for **all** of it. Every session therefore fabricated an entry
 * that **replaced** pi's real one, costing the session its true price, its true
 * context window and its `thinkingLevelMap`.
 *
 * ## Why an RPC read and NOT parsing pi's bundle
 *
 * pi's catalogue is embedded in its **minified** `dist/bundle/chunks/*.js`.
 * Parsing that would couple acpx to pi's internal bundle layout, so **a pi
 * upgrade would break us SILENTLY** — landing straight back at fabrication with
 * no signal at all. `ModelRegistry` *is* a public export of pi's package entry,
 * but it is **not constructible standalone** (measured: `new ModelRegistry()`
 * succeeds, then `getAll()` throws `TypeError: Cannot read properties of
 * undefined (reading 'getModels')`), so the in-process route is closed.
 *
 * What is left is pi's own **documented RPC surface**, which is the interface
 * pi-acp itself drives: `pi --mode rpc` + `{"type":"get_available_models"}`.
 * Measured cost: **539 ms** via `spawnSync` (exit 0 — pi terminates on stdin
 * EOF), so this is affordable once and then cached.
 *
 * ## ⚠️ THIS RUNS ON THE SESSION-CREATE PATH — WHAT BOUNDS IT (brick ff298f02)
 *
 * A 539 ms synchronous spawn on every session create is a cost we do not pay for
 * a value that changes only when the pi binary does. Three bounds, in the order
 * they fire:
 *
 * 1. **A process-level memo**, so repeated creates in one acpx process do not
 *    even re-read the cache file.
 * 2. **A file cache keyed by the pi BINARY'S IDENTITY** (resolved path, mtime,
 *    size), so the spawn is paid at most once per binary per box — and, in the
 *    other direction, a pi upgrade invalidates the cache *immediately* instead of
 *    up to {@link PI_KNOWLEDGE_TTL_MS} later. Identity is strictly better than the
 *    TTL at the job the TTL was doing.
 * 3. **No pi on `PATH` ⇒ NO SPAWN AT ALL.** On every box without pi the old code
 *    paid a failed `spawnSync` per create to learn what one `stat` answers.
 *
 * And the spawn itself carries a **hard** bound: {@link PI_RPC_TIMEOUT_MS} with
 * `killSignal: "SIGKILL"`, so a wedged pi cannot hang session creation — SIGTERM
 * is catchable and a hung child is exactly the process that would catch it.
 * 15 s is affordable *because* of bounds 1–3: it is a worst case paid once per
 * binary, not per create.
 *
 * ## ⚠️ THE REFRESH RACE, MEASURED — and why this reader is a FLOOR, not a total
 *
 * pi refreshes its remote catalogue in the background at startup, so the answer
 * depends on WHEN you ask. Measured, varying only the wait:
 *
 * ```
 *   ask after    0 ms -> 333 models      ask after 1200 ms -> 374 models
 *   ask after  300 ms -> 333 models      ask after 3000 ms -> 374 models
 * ```
 *
 * A synchronous read therefore returns the **bundled floor (333)**, not the full
 * 374. **This is deliberate and it degrades in the SAFE direction:** a model in
 * the ~41 remote-only rows is classified "pi does not know it", so we write an
 * entry for it — but now with **real** rates, context window and max-tokens from
 * acpx's own catalogue, which is strictly better than the zeros this brick
 * removes. The residual (such a model still loses its `thinkingLevelMap`) is
 * filed under 6253611b rather than papered over: closing it means waiting on
 * pi's refresh, which would put >1.2 s on every session create.
 *
 * **Never widen this to "the total pi will eventually advertise" without
 * re-measuring the race — a reader that is sometimes complete is worse than one
 * that is reliably a floor, because only the second one is safe to reason about.**
 *
 * ## ⚠️ THE READ CARRIES A PLACEHOLDER KEY IN A THROWAWAY AGENT DIR (brick d406ec77)
 *
 * pi filters `get_available_models` by AUTH: it lists only models whose provider
 * has a credential. The September numbers above were taken while
 * `OPENROUTER_API_KEY` was still in the session env. Once the OpenRouter
 * credential moved into pi's per-session `auth.json` (written AFTER this read),
 * the read's env carried none, and pi answered an empty list that was cached as
 * "pi knows nothing" for 24 h. Every OpenRouter model then got a fabricated,
 * map-less entry that shadowed pi's own on boxes with an empty
 * `~/.pi/agent/models-store.json`. Measured 2026-11-20 on devbox, pi 0.84.4, in a
 * throwaway `PI_CODING_AGENT_DIR`:
 *
 * ```
 *   no OpenRouter key          -> 0 models
 *   placeholder key (not real) -> 379 openrouter models
 * ```
 *
 * pi filters on the credential's PRESENCE, so {@link PI_KNOWLEDGE_PLACEHOLDER_KEY}
 * is enough: the read lists models and runs no turn. Never copy the real key in;
 * that only puts a live credential into one more process.
 *
 * The read runs in a fresh temp agent dir that is always removed, because pi
 * WRITES `auth.json`, `models-store.json` and `sessions/` into the agent dir it
 * runs with, even for this read. Pointed at the box's `~/.pi/agent` it would
 * write there. `PI_CODING_AGENT_SESSION_DIR` is dropped: an inherited value that
 * names a missing directory hangs pi with no output.
 *
 * And because pi always bundles hundreds of models, an EMPTY answer is a failed
 * read, never "pi knows nothing": it is not cached, not memoised, and a cached
 * empty list is ignored. That is what retires the poisoned caches already on
 * disk without anyone deleting them.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Long enough that the spawn is amortised to nothing; short enough that a pi
 *  upgrade is picked up the same day EVEN IF its binary identity somehow does not
 *  move. Identity is the primary invalidator; this is the backstop. */
export const PI_KNOWLEDGE_TTL_MS = 24 * 60 * 60 * 1000;

/** pi answers in ~539 ms; this is a HARD stall bound, not an expected duration.
 *  Paired with `killSignal: "SIGKILL"` below — a SIGTERM is catchable, and a pi
 *  that has wedged is precisely the process that would catch it. */
const PI_RPC_TIMEOUT_MS = 15_000;

/** pi's catalogue reply is ~140 KB today; leave generous headroom. */
const PI_RPC_MAX_BUFFER = 64 * 1024 * 1024;

const RPC_REQUEST_ID = "acpx-knowledge";

/** A fixed, deliberately non-secret stand-in for an OpenRouter credential. pi
 *  lists a provider's models only when that provider has auth, and it checks
 *  PRESENCE, not validity, so this is all the catalogue read needs. Never derive
 *  it from, or replace it with, a real key. */
export const PI_KNOWLEDGE_PLACEHOLDER_KEY = "acpx-pi-catalogue-probe-not-a-key";

export type PiModelKnowledge = {
  /** ISO-8601 of the read these ids came from. */
  fetchedAt: string;
  /** Every model id pi advertised, WITHOUT a provider prefix — the same
   *  namespace `writePiModelsStore` keys its entries on. */
  ids: string[];
  /** The pi binary these ids came from — `<resolved path>:<mtimeMs>:<size>`.
   *  A cache whose stamp does not match the binary we are about to ask is stale
   *  HOWEVER RECENT it is. Absent on caches written before this field existed,
   *  which therefore read as stale exactly once. */
  binary?: string;
};

export type PiKnowledgeDeps = {
  /** Overrides the cache file outright (tests). */
  cachePath?: string;
  /** The `pi` executable; the registry's resolved command in production. */
  piCommand?: string;
  now?: number;
  /** Injected in tests so no real process is spawned. */
  readAdvertised?: (piCommand: string, env: NodeJS.ProcessEnv) => string[] | null;
  /** Overrides the binary identity stamp (tests). `null` states "pi is not
   *  resolvable", which is the no-spawn path. `undefined` means "compute it". */
  binaryStamp?: string | null;
};

/**
 * `ACPX_STATE_HOME` moves the whole `.acpx` tree, which is the override every
 * other acpx path resolver already honours. **Deliberately NOT under pi's own
 * agent dir:** acpx re-points that at a per-session directory it deletes at
 * close, so a cache written there could never survive (the very mechanism that
 * keeps pi's overlay permanently empty).
 */
export function piKnowledgeCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACPX_PI_KNOWLEDGE_CACHE?.trim();
  if (explicit) {
    return explicit;
  }
  // ⚠️ `env.HOME` BEFORE `homedir()`, and the order is load-bearing. `homedir()`
  // reads the CURRENT PROCESS's home, so a caller that scoped its `env` — every
  // unit test here, and any isolated rig — would still have read and written the
  // REAL `~/.acpx`. Isolation is a property of each invocation and fails
  // silently the one time it is missed; this resolver must honour the env it was
  // handed, exactly as `readBoxPiOpenRouterModels` does.
  return join(
    env.ACPX_STATE_HOME?.trim() || env.HOME?.trim() || homedir(),
    ".acpx",
    "pi-model-knowledge.json",
  );
}

function readCache(cachePath: string): PiModelKnowledge | null {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const listed = (parsed as PiModelKnowledge).ids;
    if (!Array.isArray(listed)) {
      return null;
    }
    const ids = listed.filter((id): id is string => typeof id === "string");
    if (ids.length === 0) {
      // A cached EMPTY list is the poisoned answer of a read pi filtered to
      // nothing (brick d406ec77), never real knowledge: pi always bundles
      // hundreds of models. Treat it as no cache at all.
      return null;
    }
    return {
      fetchedAt: (parsed as PiModelKnowledge).fetchedAt ?? new Date(0).toISOString(),
      ids,
      binary: (parsed as PiModelKnowledge).binary,
    };
  } catch {
    // A truncated or hand-mangled cache is a cold cache, never a crash: a
    // session create must not fail because this file is unreadable.
    return null;
  }
}

/** Atomic tmp + rename — a reader never sees a half-written cache. */
function writeCache(cachePath: string, knowledge: PiModelKnowledge): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(knowledge)}\n`, "utf8");
    renameSync(tmpPath, cachePath);
  } catch {
    // Caching is an optimisation. A read-only or full disk must not fail a
    // session create; the next spawn simply pays the ~539 ms again.
  }
}

/**
 * One line of pi's RPC reply, classified into the THREE outcomes that matter.
 *
 * ⚠️ `malformed` and `other` are NOT the same thing, and collapsing either into
 * an empty id list is the defect this shape exists to prevent: a reply frame that
 * is ours but carries no `models` array means **we could not establish pi's
 * knowledge**, not "pi advertises nothing". Those two drive opposite decisions
 * one level up — provision everything vs. provision nothing — which is the whole
 * reason this module distinguishes `null` from an empty set.
 */
export type PiReplyLine =
  | { kind: "other" }
  | { kind: "malformed" }
  | { kind: "ids"; ids: string[] };

const NOT_OUR_LINE: PiReplyLine = { kind: "other" };

/** Exported for tests: the three-way distinction is the whole point, and it is
 *  not reachable through `spawnSync` without a real pi. */
export function readReplyLine(line: string): PiReplyLine {
  if (!line.trim()) {
    return NOT_OUR_LINE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return NOT_OUR_LINE;
  }
  const frame = parsed as { type?: unknown; id?: unknown; data?: { models?: unknown } };
  if (frame.type !== "response" || frame.id !== RPC_REQUEST_ID) {
    return NOT_OUR_LINE;
  }
  const models = frame.data?.models;
  if (!Array.isArray(models)) {
    return { kind: "malformed" };
  }
  const ids = models
    .map((model) => (model as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  return { kind: "ids", ids };
}

/**
 * The env the catalogue read hands pi: the caller's env, plus a placeholder
 * OpenRouter credential and an isolated agent dir, minus any inherited session
 * dir. See the module header (brick d406ec77) for why each one is needed.
 */
export function piKnowledgeReadEnv(env: NodeJS.ProcessEnv, agentDir: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PI_CODING_AGENT_DIR: agentDir,
    OPENROUTER_API_KEY: PI_KNOWLEDGE_PLACEHOLDER_KEY,
  };
  delete childEnv.PI_CODING_AGENT_SESSION_DIR;
  return childEnv;
}

/** `spawnSync`'s shape, narrowed to what the read uses, so tests can inject it. */
export type PiRpcSpawn = (
  command: string,
  args: string[],
  options: {
    encoding: "utf8";
    timeout: number;
    killSignal: "SIGKILL";
    maxBuffer: number;
    env: NodeJS.ProcessEnv;
    input: string;
  },
) => { error?: Error; stdout: string | null };

/**
 * One `pi --mode rpc` round-trip. Returns `null` — never throws — when pi is not
 * installed, does not answer, or answers something unparseable: the caller must
 * be able to tell "pi advertises nothing" (impossible) from "I could not ask"
 * (routine on a box without pi).
 *
 * Runs in a fresh temp agent dir that is removed whatever happens, because pi
 * writes into the agent dir it is given (module header, brick d406ec77).
 */
export function readAdvertisedViaRpc(
  piCommand: string,
  env: NodeJS.ProcessEnv,
  spawn: PiRpcSpawn = spawnSync,
): string[] | null {
  let agentDir: string;
  try {
    agentDir = mkdtempSync(join(tmpdir(), "acpx-pi-knowledge-"));
  } catch {
    return null;
  }
  try {
    const result = spawn(piCommand, ["--mode", "rpc", "--no-themes"], {
      encoding: "utf8",
      timeout: PI_RPC_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: PI_RPC_MAX_BUFFER,
      env: piKnowledgeReadEnv(env, agentDir),
      input: `${JSON.stringify({ type: "get_available_models", id: RPC_REQUEST_ID })}\n`,
    });
    if (result.error || typeof result.stdout !== "string") {
      return null;
    }
    for (const line of result.stdout.split("\n")) {
      const reply = readReplyLine(line);
      if (reply.kind === "other") {
        continue;
      }
      return reply.kind === "ids" ? reply.ids : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch {
      // A leftover temp dir must not fail a session create; this read never throws.
    }
  }
}

/**
 * The pi binary's identity: `<resolved path>:<mtimeMs>:<size>`, or `null` when pi
 * is not resolvable at all.
 *
 * ⚠️ Resolved against **the `env` we are about to hand `spawnSync`**, never
 * against the calling shell's `PATH`. `spawnSync` looks a bare command up in the
 * CHILD's `PATH`, so any other `PATH` would answer a question about a different
 * process. (A path-dependent lookup that measures the wrong shell is how a
 * working fleet deployment once read as ABSENT on four of five boxes.)
 *
 * `statSync` follows symlinks deliberately: `~/.local/bin/pi` is a link, and the
 * identity that matters is the target's, not the link's.
 */
function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes("/")) {
    return command;
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) {
      continue;
    }
    try {
      const candidate = join(dir, command);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not here; try the next PATH entry.
    }
  }
  return null;
}

function piBinaryStamp(command: string, env: NodeJS.ProcessEnv): string | null {
  const resolved = resolveExecutable(command, env);
  if (resolved === null) {
    return null;
  }
  try {
    const stat = statSync(resolved);
    return `${resolved}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Identity of "whatever the caller injected" — see {@link resolveStamp}. */
const INJECTED_READER_STAMP = "injected-reader";

/**
 * Which pi are we about to ask?
 *
 * ⚠️ **AN INJECTED READER IS NOT A BINARY.** A caller that hands us
 * `readAdvertised` is asking us to call it, so resolving a binary identity there
 * would be both meaningless and destructive: on a fixture with no `pi` on its
 * `PATH` the no-spawn short-circuit would skip the injected reader entirely, and
 * every row built on that seam would keep passing **for a reason it never
 * asserted**. A caller that wants the no-binary path says so explicitly with
 * `binaryStamp: null`.
 */
function resolveStamp(
  env: NodeJS.ProcessEnv,
  deps: PiKnowledgeDeps,
  piCommand: string,
): string | null {
  if (deps.binaryStamp !== undefined) {
    return deps.binaryStamp;
  }
  if (deps.readAdvertised) {
    return INJECTED_READER_STAMP;
  }
  return piBinaryStamp(piCommand, env);
}

function isFresh(cached: PiModelKnowledge, now: number): boolean {
  const fetchedAt = Date.parse(cached.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt < PI_KNOWLEDGE_TTL_MS;
}

/**
 * A cache is usable when it is fresh AND was written against the binary we would
 * otherwise ask. With no resolvable binary there is no identity to compare, so
 * freshness alone decides — there is nothing to spawn either way.
 */
function isUsable(cached: PiModelKnowledge, stamp: string | null, now: number): boolean {
  if (!isFresh(cached, now)) {
    return false;
  }
  return stamp === null || cached.binary === stamp;
}

/** Defaults in one place, so the read below stays a single readable decision. */
function resolveDeps(env: NodeJS.ProcessEnv, deps: PiKnowledgeDeps) {
  return {
    cachePath: deps.cachePath ?? piKnowledgeCachePath(env),
    now: deps.now ?? Date.now(),
    readAdvertised: deps.readAdvertised ?? readAdvertisedViaRpc,
    piCommand: deps.piCommand ?? "pi",
  };
}

type KnowledgeContext = {
  cachePath: string;
  now: number;
  readAdvertised: (piCommand: string, env: NodeJS.ProcessEnv) => string[] | null;
  piCommand: string;
  stamp: string | null;
  env: NodeJS.ProcessEnv;
};

function establishPiKnowledge(ctx: KnowledgeContext): Set<string> | null {
  const cached = readCache(ctx.cachePath);
  if (cached && isUsable(cached, ctx.stamp, ctx.now)) {
    return new Set(cached.ids);
  }
  if (ctx.stamp === null) {
    // pi is not resolvable on the env we would spawn with, so there is nothing to
    // ask and NO SPAWN IS ATTEMPTED. A stale cache still beats nothing.
    return cached ? new Set(cached.ids) : null;
  }
  const ids = ctx.readAdvertised(ctx.piCommand, ctx.env);
  if (ids === null || ids.length === 0) {
    // Could not ask. A STALE cache is still far better than nothing — it is a
    // list of ids pi advertised recently, and pi's catalogue moves slowly.
    // ⚠️ An EMPTY answer is the same failure, not "pi knows nothing": pi always
    // bundles hundreds of models, so empty means pi filtered them all away
    // (brick d406ec77). Caching it would provision every model for 24 h.
    return cached ? new Set(cached.ids) : null;
  }
  writeCache(ctx.cachePath, {
    fetchedAt: new Date(ctx.now).toISOString(),
    ids,
    binary: ctx.stamp,
  });
  return new Set(ids);
}

type MemoEntry = { at: number; value: Set<string> };

/**
 * Keyed by cache path AND binary identity, so a pi upgrade or a differently
 * scoped env can never be answered from another key's memo.
 *
 * ⚠️ **ONLY SUCCESSFUL READS ARE MEMOISED.** Memoising a `null` would pin "I
 * could not establish pi's knowledge" for the whole TTL inside one long-lived
 * process — so a pi that was briefly unavailable at the wrong moment would make
 * every session for the next 24 h provision a fabricated entry. The failure path
 * is also the cheap one to repeat: when pi is not resolvable there is no spawn to
 * save (a `stat` decides), and when pi IS resolvable, paying a retry to notice it
 * came back is the trade we want.
 */
const knowledgeMemo = new Map<string, MemoEntry>();

/** Tests share one process; a memo that outlived a case would make the next one
 *  measure the previous one's answer. */
export function resetPiKnowledgeMemo(): void {
  knowledgeMemo.clear();
}

/**
 * The model ids pi already knows — memo first, cache second, one RPC read on a
 * miss, and no spawn at all when pi is not resolvable.
 *
 * `null` means **"could not be established"** (pi absent, it did not answer, or
 * it answered an empty list), and this function never returns an empty set: the
 * caller must not read a failure to ask as "pi knows nothing", because those two
 * lead to opposite decisions.
 */
export function readPiAdvertisedModelIds(
  env: NodeJS.ProcessEnv = process.env,
  deps: PiKnowledgeDeps = {},
): Set<string> | null {
  const { cachePath, now, readAdvertised, piCommand } = resolveDeps(env, deps);
  const stamp = resolveStamp(env, deps, piCommand);
  const memoKey = `${cachePath} ${stamp ?? ""}`;

  const memo = knowledgeMemo.get(memoKey);
  if (memo && now - memo.at < PI_KNOWLEDGE_TTL_MS) {
    // A COPY: the memo must not be mutable through its callers.
    return new Set(memo.value);
  }

  const value = establishPiKnowledge({ cachePath, now, readAdvertised, piCommand, stamp, env });
  if (value === null) {
    return null;
  }
  knowledgeMemo.set(memoKey, { at: now, value });
  return new Set(value);
}
