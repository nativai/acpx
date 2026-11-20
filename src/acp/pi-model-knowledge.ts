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
 * Measured cost: **539 ms** for one ask (exit 0 — pi terminates on stdin EOF);
 * with the wait for pi's refresh (below) about 1-2 s, so this is affordable once
 * and then cached.
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
 * ## ⚠️ THE REFRESH: KEEP PI'S OWN REFRESHED BLOCK (brick d406ec77, defect D1)
 *
 * pi refreshes its remote catalogue in the background at startup, so the answer
 * depends on WHEN you ask. `get_available_models` first answers from pi's
 * **bundle** (the floor); about a second later pi writes its refreshed
 * `openrouter` block into `<agent dir>/models-store.json`. Measured 2026-11-20,
 * placeholder key, isolated agent dir, pi 0.84.4:
 *
 * ```
 *   devbox          (bundle 2026-09-15): floor 379, store write after 1.1-1.7 s
 *   devbox-staging  (bundle 2026-09-06): floor 333, store write after 0.75-0.84 s
 * ```
 *
 * A model newer than the box's pi bundle (`deepseek/deepseek-v4.1-flash` on the
 * 09-06 build) is outside the floor. It is not enough to KNOW that pi will learn
 * it after its refresh: a session's pi starts from its bundle plus the session's
 * `models-store.json`, and lists models for `session/new` BEFORE its own refresh
 * lands. Measured on devbox-staging: knowing it and provisioning nothing got the
 * create refused ("the ACP agent did not advertise that model").
 *
 * So the read waits for a POSITIVE signal (pi's own store write, capped at
 * {@link PI_REFRESH_WAIT_MS}) and KEEPS that block in an acpx-owned file beside the
 * knowledge cache ({@link piKeptOverlayPath}). When a box's own
 * `~/.pi/agent/models-store.json` is empty, the kept block becomes the box overlay
 * ({@link readPiKeptOpenRouterModels}), so the session's pi starts with pi's own
 * entries, maps included: the shape a box with a populated store already has.
 *
 * ⚠️ **THE IDS STAY THE FLOOR, ON PURPOSE.** The provisioning decision is
 * "the floor OR the overlay has it", which is exactly what the session's pi knows
 * when it starts. Do NOT replace the floor with a post-refresh answer: when the
 * overlay is the box's own (older) store, a model only the fresh refresh knows
 * would then get no entry and be refused, the failure above.
 *
 * When the refresh does not land in time (offline, pi.dev down), nothing is kept,
 * and the knowledge is marked `complete: false` and lives only
 * {@link PI_INCOMPLETE_KNOWLEDGE_TTL_MS}, so the next read soon tries again. The
 * driver ({@link RPC_DRIVER_SCRIPT}) kills pi at its own deadline, inside
 * {@link PI_RPC_TIMEOUT_MS}. The cost (~1-2 s) is paid once per pi binary per TTL.
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
 * write there. `PI_CODING_AGENT_SESSION_DIR` is dropped for the same reason: pi
 * 0.84.4 does NOT hang on a missing one during this RPC read (measured by the
 * test-engineer); it `mkdir`s it, i.e. it would create a directory at whatever
 * inherited path it was handed, outside the throwaway dir.
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

/** How long the read waits for pi's own refresh to land before it settles for the
 *  floor. Measured landing: 0.75-1.7 s. */
export const PI_REFRESH_WAIT_MS = 6_000;

/** The driver kills pi here, before `spawnSync`'s own SIGKILL can orphan it. */
const PI_DRIVER_DEADLINE_MS = PI_RPC_TIMEOUT_MS - 2_000;

/** A floor-only (incomplete) cache is re-asked after an hour, not a day. */
export const PI_INCOMPLETE_KNOWLEDGE_TTL_MS = 60 * 60 * 1000;

/** pi's catalogue reply is ~140 KB today; leave generous headroom. */
const PI_RPC_MAX_BUFFER = 64 * 1024 * 1024;

const RPC_REQUEST_ID = "acpx-knowledge";
/** The driver's own last line: did pi's refresh land before it closed stdin? */
const REFRESH_MARKER_TYPE = "acpx-refresh";

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
  /** `true` when pi's refresh landed and its block was kept beside this cache;
   *  `false` when only the floor was read (short TTL). Absent on caches written
   *  before this field existed, which therefore read as stale exactly once. */
  complete?: boolean;
};

/** pi's own `openrouter` block from its `models-store.json`. */
export type PiOpenRouterBlock = { models: unknown[] } & Record<string, unknown>;

/** One read: pi's FLOOR ids, and pi's refreshed block when its refresh landed. */
export type PiAdvertisedRead = {
  ids: string[];
  complete: boolean;
  openrouter?: PiOpenRouterBlock;
};

/** The kept block on disk: pi's refreshed block plus the read it came from. */
type KeptOverlay = { fetchedAt: string; binary?: string; openrouter: PiOpenRouterBlock };

export type PiKnowledgeDeps = {
  /** Overrides the cache file outright (tests). */
  cachePath?: string;
  /** The `pi` executable; the registry's resolved command in production. */
  piCommand?: string;
  now?: number;
  /** Injected in tests so no real process is spawned. */
  readAdvertised?: (piCommand: string, env: NodeJS.ProcessEnv) => PiAdvertisedRead | null;
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

/**
 * Where pi's own refreshed `openrouter` block is kept: BESIDE the knowledge cache,
 * acpx-owned, never under any `~/.pi/agent`. See the module header.
 */
export function piKeptOverlayPath(cachePath: string): string {
  const base = cachePath.endsWith(".json") ? cachePath.slice(0, -".json".length) : cachePath;
  return `${base}.openrouter-store.json`;
}

function readKeptOverlay(path: string): KeptOverlay | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<KeptOverlay>;
    const block = parsed.openrouter;
    if (typeof parsed.fetchedAt !== "string" || !block || !Array.isArray(block.models)) {
      return null;
    }
    return { fetchedAt: parsed.fetchedAt, binary: parsed.binary, openrouter: block };
  } catch {
    return null;
  }
}

/**
 * The models of pi's own refreshed `openrouter` block, kept by the last COMPLETE
 * knowledge read, when that block is still valid: under the full TTL and written
 * against the pi binary we would ask now (freshness alone when pi is not
 * resolvable, as for the knowledge cache). Anything else is `[]`, i.e. no overlay.
 * This never spawns pi; it only reads what a read already kept.
 */
export function readPiKeptOpenRouterModels(
  env: NodeJS.ProcessEnv = process.env,
  deps: PiKnowledgeDeps = {},
): unknown[] {
  const { cachePath, now, piCommand } = resolveDeps(env, deps);
  const kept = readKeptOverlay(piKeptOverlayPath(cachePath));
  if (kept === null) {
    return [];
  }
  const fetchedAt = Date.parse(kept.fetchedAt);
  const fresh = Number.isFinite(fetchedAt) && now - fetchedAt < PI_KNOWLEDGE_TTL_MS;
  const stamp = resolveStamp(env, deps, piCommand);
  return fresh && (stamp === null || kept.binary === stamp) ? kept.openrouter.models : [];
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
      complete: (parsed as PiModelKnowledge).complete,
    };
  } catch {
    // A truncated or hand-mangled cache is a cold cache, never a crash: a
    // session create must not fail because this file is unreadable.
    return null;
  }
}

/** Atomic tmp + rename — a reader never sees a half-written file. */
function writeJsonAtomic(path: string, value: PiModelKnowledge | KeptOverlay): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(tmpPath, path);
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
export function readReplyLine(line: string, requestId: string = RPC_REQUEST_ID): PiReplyLine {
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
  if (frame.type !== "response" || frame.id !== requestId) {
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

/**
 * The synchronous driver `readAdvertisedViaRpc` runs as `node -e`, because
 * `spawnSync` cannot hold pi's stdin open while pi refreshes. Argv:
 * `<pi command> <refresh wait ms> <deadline ms> <request>`; env: the isolated
 * read env. It asks once (the floor), polls `models-store.json` in the read's
 * agent dir until pi has written a non-empty `openrouter.models` (or the wait is
 * up), then closes stdin, and kills pi at its deadline. pi's stdout is buffered
 * and written at the end, followed by ONE marker line saying whether the refresh
 * landed, so the marker can never split a reply frame.
 */
export const RPC_DRIVER_SCRIPT = [
  `const {spawn}=require("child_process"),fs=require("fs"),path=require("path");`,
  `const [cmd,waitMs,deadlineMs,req]=process.argv.slice(1);`,
  `const t0=Date.now();`,
  `const store=path.join(process.env.PI_CODING_AGENT_DIR,"models-store.json");`,
  `const pi=spawn(cmd,["--mode","rpc","--no-themes"],{stdio:["pipe","pipe","ignore"]});`,
  `let out="",landed=false;`,
  `pi.stdout.setEncoding("utf8");pi.stdout.on("data",(d)=>{out+=d;});`,
  `pi.stdin.on("error",()=>{});`,
  `const has=()=>{try{const o=JSON.parse(fs.readFileSync(store,"utf8")).openrouter;`,
  `return !!(o&&Array.isArray(o.models)&&o.models.length>0);}catch{return false;}};`,
  `pi.stdin.write(req+"\\n");`,
  `const poll=setInterval(()=>{landed=has();`,
  `if(landed||Date.now()-t0>=Number(waitMs)){clearInterval(poll);pi.stdin.end();}},25);`,
  `const kill=setTimeout(()=>{pi.kill("SIGKILL");},Number(deadlineMs));`,
  `const done=()=>{clearInterval(poll);clearTimeout(kill);};`,
  `pi.on("error",()=>{done();process.exitCode=1;});`,
  `pi.on("close",()=>{done();`,
  `process.stdout.write(out+"\\n"+JSON.stringify({type:${JSON.stringify(REFRESH_MARKER_TYPE)},landed})+"\\n");});`,
].join("");

/** Bounds of one read; injected in tests so a stand-in pi runs in milliseconds. */
export type PiRpcTiming = { refreshWaitMs: number; deadlineMs: number };

const PI_RPC_TIMING: PiRpcTiming = {
  refreshWaitMs: PI_REFRESH_WAIT_MS,
  deadlineMs: PI_DRIVER_DEADLINE_MS,
};

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
  },
) => { error?: Error; stdout: string | null };

/**
 * One read of pi's model knowledge: the floor ids, plus pi's own refreshed
 * `openrouter` block once its refresh has landed (module header, brick d406ec77
 * D1). Returns `null`
 * — never throws — when pi is not installed, does not answer, or answers
 * something unparseable: the caller must be able to tell "pi advertises nothing"
 * (impossible) from "I could not ask" (routine on a box without pi).
 *
 * Runs in a fresh temp agent dir that is removed whatever happens, because pi
 * writes into the agent dir it is given; that write is also the refresh signal,
 * and the block it wrote is read back before the dir goes.
 */
export function readAdvertisedViaRpc(
  piCommand: string,
  env: NodeJS.ProcessEnv,
  spawn: PiRpcSpawn = spawnSync,
  timing: PiRpcTiming = PI_RPC_TIMING,
): PiAdvertisedRead | null {
  const agentDir = makeReadAgentDir();
  if (agentDir === null) {
    return null;
  }
  try {
    return readFromRpcResult(
      spawn(
        process.execPath,
        [
          "-e",
          RPC_DRIVER_SCRIPT,
          piCommand,
          String(timing.refreshWaitMs),
          String(timing.deadlineMs),
          JSON.stringify({ type: "get_available_models", id: RPC_REQUEST_ID }),
        ],
        {
          encoding: "utf8",
          // The driver's own deadline fires first; this SIGKILL is the backstop
          // for the driver itself, never the expected path.
          timeout: Math.min(PI_RPC_TIMEOUT_MS, timing.deadlineMs + 2_000),
          killSignal: "SIGKILL",
          maxBuffer: PI_RPC_MAX_BUFFER,
          env: piKnowledgeReadEnv(env, agentDir),
        },
      ),
      agentDir,
    );
  } catch {
    return null;
  } finally {
    removeReadAgentDir(agentDir);
  }
}

function makeReadAgentDir(): string | null {
  try {
    return mkdtempSync(join(tmpdir(), "acpx-pi-knowledge-"));
  } catch {
    return null;
  }
}

function removeReadAgentDir(agentDir: string): void {
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // A leftover temp dir must not fail a session create; this read never throws.
  }
}

/** The ids of the first frame answering our request; `null` when absent or malformed. */
function floorIds(lines: string[]): string[] | null {
  for (const line of lines) {
    const reply = readReplyLine(line);
    if (reply.kind !== "other") {
      return reply.kind === "ids" ? reply.ids : null;
    }
  }
  return null;
}

function refreshLanded(lines: string[]): boolean {
  return lines.some((line) => {
    try {
      const frame = JSON.parse(line) as { type?: unknown; landed?: unknown };
      return frame.type === REFRESH_MARKER_TYPE && frame.landed === true;
    } catch {
      return false;
    }
  });
}

/** pi's own `openrouter` block from a `models-store.json`, or `null` when there
 *  is none with at least one model. */
function readOpenRouterBlock(storePath: string): PiOpenRouterBlock | null {
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as { openrouter?: unknown };
    const block = parsed.openrouter as PiOpenRouterBlock | undefined;
    return block && Array.isArray(block.models) && block.models.length > 0 ? block : null;
  } catch {
    return null;
  }
}

/**
 * The floor ids, and pi's refreshed block when the driver saw it land. Only a
 * block that is readable when we look makes the read `complete`.
 */
function readFromRpcResult(
  result: ReturnType<PiRpcSpawn>,
  agentDir: string,
): PiAdvertisedRead | null {
  if (result.error || typeof result.stdout !== "string") {
    return null;
  }
  const lines = result.stdout.split("\n");
  const ids = floorIds(lines);
  if (ids === null) {
    return null;
  }
  const block = refreshLanded(lines)
    ? readOpenRouterBlock(join(agentDir, "models-store.json"))
    : null;
  return block ? { ids, complete: true, openrouter: block } : { ids, complete: false };
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

/**
 * How long an answer may be reused. A complete one (pi's refresh had landed)
 * keeps the full TTL; the floor gets the short one; a cache that does not say
 * (written before `complete` existed) is stale at once, because the build that
 * wrote it read only the floor (brick d406ec77, D1).
 */
function ttlFor(complete: boolean | undefined): number {
  if (complete === true) {
    return PI_KNOWLEDGE_TTL_MS;
  }
  return complete === false ? PI_INCOMPLETE_KNOWLEDGE_TTL_MS : 0;
}

function isFresh(cached: PiModelKnowledge, now: number): boolean {
  const fetchedAt = Date.parse(cached.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt < ttlFor(cached.complete);
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
  readAdvertised: (piCommand: string, env: NodeJS.ProcessEnv) => PiAdvertisedRead | null;
  piCommand: string;
  stamp: string | null;
  env: NodeJS.ProcessEnv;
};

/** What one establish produced, and whether it came from pi's refreshed view. */
type Knowledge = { value: Set<string>; complete: boolean };

function fromCache(cached: PiModelKnowledge | null): Knowledge | null {
  return cached ? { value: new Set(cached.ids), complete: cached.complete === true } : null;
}

function establishPiKnowledge(ctx: KnowledgeContext): Knowledge | null {
  const cached = readCache(ctx.cachePath);
  if (cached && isUsable(cached, ctx.stamp, ctx.now)) {
    return fromCache(cached);
  }
  if (ctx.stamp === null) {
    // pi is not resolvable on the env we would spawn with, so there is nothing to
    // ask and NO SPAWN IS ATTEMPTED. A stale cache still beats nothing.
    return fromCache(cached);
  }
  const read = ctx.readAdvertised(ctx.piCommand, ctx.env);
  if (read === null || read.ids.length === 0) {
    // Could not ask. A STALE cache is still far better than nothing — it is a
    // list of ids pi advertised recently, and pi's catalogue moves slowly.
    // ⚠️ An EMPTY answer is the same failure, not "pi knows nothing": pi always
    // bundles hundreds of models, so empty means pi filtered them all away
    // (brick d406ec77). Caching it would provision every model for 24 h.
    return fromCache(cached);
  }
  const fetchedAt = new Date(ctx.now).toISOString();
  writeJsonAtomic(ctx.cachePath, {
    fetchedAt,
    ids: read.ids,
    binary: ctx.stamp,
    complete: read.complete,
  });
  // ⚠️ ONLY a complete read replaces the kept block. A floor-only read (refresh
  // did not land) must never overwrite a valid block with nothing.
  if (read.complete && read.openrouter) {
    writeJsonAtomic(piKeptOverlayPath(ctx.cachePath), {
      fetchedAt,
      binary: ctx.stamp,
      openrouter: read.openrouter,
    });
  }
  return { value: new Set(read.ids), complete: read.complete };
}

type MemoEntry = { at: number; value: Set<string>; complete: boolean };

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
 * came back is the trade we want. A floor-only (incomplete) answer is memoised
 * for the short TTL only, exactly as it is cached.
 */
const knowledgeMemo = new Map<string, MemoEntry>();

/** Tests share one process; a memo that outlived a case would make the next one
 *  measure the previous one's answer. */
export function resetPiKnowledgeMemo(): void {
  knowledgeMemo.clear();
}

/**
 * The model ids pi knows WITHOUT any store, i.e. its bundle (the floor) — memo
 * first, cache second, one RPC read on a miss, and no spawn at all when pi is not
 * resolvable. A read whose refresh landed also keeps pi's refreshed block for
 * {@link readPiKeptOpenRouterModels}.
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
  if (memo && now - memo.at < ttlFor(memo.complete)) {
    // A COPY: the memo must not be mutable through its callers.
    return new Set(memo.value);
  }

  const known = establishPiKnowledge({ cachePath, now, readAdvertised, piCommand, stamp, env });
  if (known === null) {
    return null;
  }
  knowledgeMemo.set(memoKey, { at: now, value: known.value, complete: known.complete });
  return new Set(known.value);
}
