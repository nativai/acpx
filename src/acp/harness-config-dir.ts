import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type LiveProcessScan, scanIsMeasured } from "../process-population.js";
import {
  harnessIdForAgentCommand,
  HARNESS_FACTS,
  HARNESS_IDS,
  type HarnessId,
} from "./harness-capabilities.js";

/**
 * ONE per-session harness config dir, serving THREE purposes (CONCEPTION §5.3).
 *
 * ## Why one mechanism and not three
 *
 * Both new harnesses resolve a model against a **bundled catalogue** and reject
 * an unknown slug **locally, before any network call** (I1 R6, I2 R5). So "any
 * OpenRouter model" is not free: it requires generating a catalogue fragment
 * into the harness's own config — and that is the same directory the primer
 * already needs, and the same one the model pin goes in. Three requirements,
 * one directory. That is the strongest argument for the config dir being a
 * single mechanism rather than three bolted together.
 *
 *   1. the **primer** — `agents.md` + the brick block
 *   2. the **model pin**
 *   3. a generated **catalogue fragment** for an arbitrary slug
 *
 * ## The precedent this reuses
 *
 * acpx already creates a per-session config dir and points the child at it by
 * env: the OpenRouter shim does exactly this (`src/acp/auth-env.ts` —
 * `join(tmpdir(), \`or-${sessionId}\`)` + `CLAUDE_CONFIG_DIR`). This is that
 * pattern, for the two harnesses whose only working primer path it is.
 *
 * ## ⚠️ IT IS GATED PER HARNESS, OFF THE DESCRIPTOR — never applied unconditionally
 *
 * This writes environment variables into the ADAPTER spawn. Applied to every
 * agent, claude / claude-pty / codex would each silently gain env entries they
 * have no use for — a real behaviour change to three harnesses the program
 * requires to be untouched. The gate is `primerChannel === "config-file"`, which
 * only opencode and pi declare, so a harness that carries its primer on an ACP
 * `_meta` channel is never given a config dir it would ignore.
 *
 * ⚠️ **RS-01 CANNOT SEE THIS, IN EITHER DIRECTION**, so it is not the evidence
 * that the gate works. There are two spawn boundaries one level apart:
 *
 * ```
 * acpx-ui ──spawn('acpx')──▶ acpx CLI ──spawn(adapter)──▶ the harness adapter
 *              ▲                              ▲
 *              └── the rig shim captures HERE  └── THIS module writes HERE
 *                  (that is RS-01)
 * ```
 *
 * RS-01 would report an empty delta for a working gate and an equally empty
 * delta for one that never ran. The evidence is RS-13: the adapter-boundary
 * differential, population printed in both arms.
 */

/** The prefix every per-session harness config dir carries. One definition, used
 *  by the writer, the remover and the orphan sweep, so they cannot disagree. */
const CONFIG_DIR_PREFIX = "acpx-";

/** `acpx-<harness>-<id>` — the only place this name is composed. */
function configDirName(harness: HarnessId, sessionId: string): string {
  return `${CONFIG_DIR_PREFIX}${harness}-${sessionId}`;
}

/**
 * Where a config dir records WHO is currently using it (brick 4a6fdda0).
 *
 * ⚠️ INSIDE the config dir, not beside it — deliberately. A sibling directory
 * would need its own cleanup and would either collide with the sweep's `acpx-`
 * prefix or escape the sweep entirely, and a holders root no reaper can see is a
 * leak with no reaper. Inside, it disappears with the directory it describes.
 *
 * ## ⚠️ THE RISK THAT BUYS, AND THE FROZEN MEASUREMENT THAT BOUNDS IT
 *
 * Putting acpx's bookkeeping inside a directory a HARNESS reads is only safe if
 * the harness does not enumerate it. That was checked at source rather than
 * assumed:
 *
 *   **pi-acp 0.0.33** — its ONLY recursive enumeration is `loadCommandsFromDir`,
 *   over `~/.pi/agent/prompts` and `<cwd>/.pi/prompts`, reading `.md` files. It
 *   never enumerates `PI_CODING_AGENT_DIR` itself.
 *   **OpenCode** — pointed at `<dir>/opencode` and reads that, so a dot-prefixed
 *   sibling of that path is outside what it looks at.
 *
 * ⚠️ **THAT IS A VERSION-PINNED MEASUREMENT, NOT A PROPERTY.** It is the same
 * shape of fact as the `pi-acp` `session/set_model` capability cell, which was
 * TRUE and WENT STALE between 0.0.26 and 0.0.33 with nothing failing to announce
 * it — and as `piWireDepthValue`'s ladder, which carries the same warning. **A
 * future pi-acp that enumerates its own agent dir turns this safe placement into
 * a harness-visible artifact, silently.**
 *
 * **RE-MEASURE TRIGGER: when the pinned `pi-acp` version in `agent-registry.ts`
 * moves.** Re-run the check — grep the adapter's dist for `readdirSync` and
 * confirm no enumeration roots at `PI_CODING_AGENT_DIR` — and update the version
 * named above. The `pi does NOT get a generated models-store.json` row pins pi's
 * exact directory listing, acpx bookkeeping and harness-visible entries as two
 * separate lists, so it fails on any NEW entry; it cannot, however, notice the
 * harness starting to read an entry that was already there.
 */
const HOLDERS_DIR = ".acpx-holders";

/** What a release decided, so "nothing happened" is never silent. */
export interface HarnessConfigDirReleaseResult {
  /** True when this was the TERMINAL close and the directory was removed. */
  removed: boolean;
  /** Holders still registered after this one let go. */
  remainingHolders: number;
  /** True when the holder set could not be read, so no removal was attempted. */
  notMeasured: boolean;
}

/**
 * Claim a config dir for one client, returning the holder id it must release.
 *
 * The id carries the PID so a stale holder is diagnosable rather than anonymous,
 * plus a random suffix because ONE process can hold the same directory twice —
 * which is exactly the two-client case this brick is about.
 */
function registerConfigDirHolder(dir: string): string {
  const holderId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    mkdirSync(join(dir, HOLDERS_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, HOLDERS_DIR, holderId), `${new Date().toISOString()}\n`, {
      mode: 0o600,
    });
  } catch {
    // A directory we cannot mark is one we must never remove on close; the
    // release below reports `notMeasured` and leaves it to the orphan sweep.
  }
  return holderId;
}

/**
 * Release ONE client's claim, and remove the directory only if it was the LAST.
 *
 * ## ⚠️ THE DEFECT THIS FIXES: CLOSE WAS NOT THE OWNER'S TO PERFORM
 *
 * Two `AcpClient`s of one session compute the SAME directory —
 * `resolveConfigDirId()` returns the record id when it is present, by design, so
 * repeated spawns reuse one directory instead of accumulating one per resume.
 * But `close()` on EITHER client did an unconditional recursive `rmSync`. A
 * transient client closing therefore deleted the primer and model pin out from
 * under the client still serving a turn. **Removal belongs to the session's
 * TERMINAL close, not to whichever client happens to finish first.**
 *
 * ## Why a filesystem refcount and not an in-process one
 *
 * The two clients are not necessarily in one process — a queue owner and a CLI
 * invocation are separate processes reaching the same session. An in-memory
 * counter would be blind to exactly the case that matters.
 *
 * ⚠️ AND IT IS HONEST ABOUT ITS RACE. Between the last holder's removal and the
 * `rmSync`, a new client could claim the directory and lose it. The window is
 * two syscalls wide and the loser re-creates on its next spawn; the alternative
 * — a lock — buys less than it costs here. What is NOT left to chance is the
 * unreadable case: a holder set that cannot be read removes NOTHING and says so.
 */
export function releaseHarnessConfigDir(
  dir: string | undefined,
  holderId: string | undefined,
): HarnessConfigDirReleaseResult {
  if (!dir || !basename(dir).startsWith(CONFIG_DIR_PREFIX)) {
    return { removed: false, remainingHolders: 0, notMeasured: true };
  }
  const holders = join(dir, HOLDERS_DIR);
  if (holderId) {
    try {
      rmSync(join(holders, holderId), { force: true });
    } catch {
      // Already gone; the count below is what decides, not this.
    }
  }
  let remaining: string[];
  try {
    remaining = readdirSync(holders);
  } catch {
    // ⚠️ NOT "zero holders". An unreadable holder set is a NON-MEASUREMENT, and
    // treating it as empty would restore precisely the unconditional delete this
    // function exists to end. The orphan sweep collects it later.
    return { removed: false, remainingHolders: 0, notMeasured: true };
  }
  if (remaining.length > 0) {
    return { removed: false, remainingHolders: remaining.length, notMeasured: false };
  }
  removeHarnessConfigDir(dir);
  return { removed: true, remainingHolders: 0, notMeasured: false };
}

/**
 * Remove a config dir UNCONDITIONALLY, ignoring holders.
 *
 * ⚠️ NOT THE CLOSE PATH. `releaseHarnessConfigDir` is what a client calls; this
 * is for the orphan sweep, which has already established through record state and
 * a `/proc` census that nothing owns the directory.
 */
export function removeHarnessConfigDir(dir: string | undefined): void {
  if (!dir) {
    return;
  }
  // Only ever remove a directory this module could have created. A caller that
  // passed something else would otherwise get an arbitrary recursive delete.
  if (!basename(dir).startsWith(CONFIG_DIR_PREFIX)) {
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Swept later by pruneOrphanHarnessConfigDirs.
  }
}

/** What an orphan sweep did — every population printed, so 0 reads NOT RUN. */
export interface HarnessConfigDirPruneResult {
  /** Candidate directories examined. **0 means the sweep found nothing to look
   *  at — NOT RUN — not that everything was already clean.** */
  scanned: number;
  removed: string[];
  /** Kept for any reason. Reported so caution is visible rather than silent. */
  retained: number;
  /** Why each retention happened, so "retained 40" is diagnosable. */
  retainedBy: {
    /** A live process names this directory in its environment. */
    liveProcess: number;
    /** A record exists and is still OPEN. */
    openRecord: number;
    /** No record claims this id — never removed on a guess. */
    unrecognised: number;
    /** Unclaimed, but younger than `orphanMinAgeMs`. */
    tooYoung: number;
    /** The removal itself failed. */
    removeFailed: number;
  };
  /** The oldest unclaimed directory retained, in ms — printed so a stuck orphan
   *  is visible instead of accumulating silently. */
  oldestUnclaimedAgeMs?: number;
  /**
   * True when the sweep REFUSED to remove anything because it could not measure
   * live processes. ⚠️ A refusal and a clean sweep both remove nothing; this is
   * what tells them apart.
   */
  notMeasured: boolean;
}

/** What the invoking HOME's store knows about one session id. */
export interface KnownSessionRecord {
  closed: boolean;
}

/**
 * Sweep config dirs whose session is gone (brick 433f6bf8), on POSITIVE
 * OWNERSHIP ONLY (brick cc9a5f25).
 *
 * ⚠️ WHY THIS EXISTS ALONGSIDE remove-on-close: **close is not guaranteed to
 * run.** An owner death, a pod eviction or a `kill -9` skips it entirely — this
 * programme saw two owner deaths in one afternoon — so remove-on-close is the
 * fast path and this is the guarantee.
 *
 * ## ⚠️ THE COMMENT THAT USED TO STAND HERE DESCRIBED A SAFETY PROPERTY THE CODE
 * ## DID NOT HAVE, AND THAT IS THE DEFECT THIS FIXES
 *
 * It claimed a directory is removed only when its id appears in "neither
 * `liveSessionIds` **nor as a live spawn**", and that "an id it does not
 * recognise is **RETAINED**". Both were false. There was **no live-spawn check at
 * all**, and the single branch was `if (liveSessionIds.has(id)) retain; else
 * rm` — so an unrecognised id was **REMOVED**. A comment asserting a protection
 * its code lacks is worse than no comment: it is what a reviewer reads instead of
 * the branch. The comment was right about the design; the code never implemented
 * it. **This implements the comment.**
 *
 * ## Removal now requires EVERY clause
 *
 *   1. the id **resolves to a record in the invoking HOME's store**, AND
 *   2. **that record is CLOSED**, AND
 *   3. **no live process references the directory** — `/proc`, with a
 *      population control ({@link scanIsMeasured}); an unmeasurable scan removes
 *      NOTHING rather than guessing.
 *
 * Anything else is RETAINED:
 *
 *   - an id **no record claims** — including the `randomUUID()` fallback dir a
 *     session gets when `acpxRecordId` is absent, which is in no session list,
 *     ever — unless it is **older than `orphanMinAgeMs` AND unreferenced**. Its
 *     age and count are printed, so the caution is visible.
 *
 * ⚠️ THE ORDERING THIS DEPENDS ON. Clause 2 makes the sweep's correctness a
 * function of RECORD state, so a store full of abandoned-open records makes a
 * *correct* sweep retain forever. The record sweep that closes ownerless records
 * must therefore run BEFORE this one (`sweepAbandonedSessionRecords`). That is a
 * fix one layer up, deliberately NOT a relaxation of the rule here.
 */
export function pruneOrphanHarnessConfigDirs(params: {
  /** Records the invoking HOME's store knows about, id → state. Both the acpx
   *  record id and the ACP session id should be keyed, since either can name a
   *  directory. */
  records: ReadonlyMap<string, KnownSessionRecord>;
  /** The `/proc` census. Absent or unmeasured ⇒ nothing is removed. */
  liveScan?: LiveProcessScan;
  rootDir?: string;
  /** How old an UNCLAIMED directory must be before it may be removed. Stated,
   *  never inferred. */
  orphanMinAgeMs?: number;
  /** Injectable clock, so the age rule is testable without waiting. */
  now?: number;
}): HarnessConfigDirPruneResult {
  const { root, now, orphanMinAgeMs } = resolvePruneDefaults(params);
  const retainedBy = {
    liveProcess: 0,
    openRecord: 0,
    unrecognised: 0,
    tooYoung: 0,
    removeFailed: 0,
  };
  const gated = HARNESS_IDS.filter((id) => HARNESS_FACTS[id].primerChannel === "config-file");

  const candidates = findConfigDirCandidates(root, gated);
  if (candidates === undefined) {
    // The root itself could not be read, so nothing was examined and nothing can
    // be concluded — a non-measurement, reported as one.
    return { scanned: 0, removed: [], retained: 0, retainedBy, notMeasured: true };
  }

  // ⚠️ THE REFUSAL, BEFORE ANY WORK. Without a measured process census, clause 3
  // cannot be evaluated, and a sweep that skips it is exactly the blind `rm` this
  // function is not allowed to be. Note it still reports the CANDIDATE population:
  // a refusal that also printed `scanned=0` would be indistinguishable from a
  // sweep that found nothing to look at.
  if (!scanIsMeasured(params.liveScan)) {
    return {
      scanned: candidates.length,
      removed: [],
      retained: candidates.length,
      retainedBy: { ...retainedBy, liveProcess: candidates.length },
      notMeasured: true,
    };
  }
  const liveScan = params.liveScan;

  const removed: string[] = [];
  let scanned = 0;
  let retained = 0;
  let oldestUnclaimedAgeMs: number | undefined;
  for (const { dir, sessionId } of candidates) {
    scanned += 1;
    const verdict = classifyConfigDir(dir, sessionId, {
      records: params.records,
      liveScan,
      now,
      orphanMinAgeMs,
    });
    if (verdict.unclaimedAgeMs !== undefined) {
      oldestUnclaimedAgeMs = Math.max(oldestUnclaimedAgeMs ?? 0, verdict.unclaimedAgeMs);
    }
    if (verdict.retain) {
      retained += 1;
      retainedBy[verdict.reason] += 1;
      continue;
    }
    if (!removeDir(dir, removed)) {
      retained += 1;
      retainedBy.removeFailed += 1;
    }
  }
  return { scanned, removed, retained, retainedBy, oldestUnclaimedAgeMs, notMeasured: false };
}

/**
 * The directories this module could have created, with the session id each one
 * carries. Anything else — a queue socket dir, a stray `acpx-*` — is never even a
 * candidate, so it cannot be removed by any later branch.
 */
function findConfigDirCandidates(
  root: string,
  gated: readonly HarnessId[],
): { dir: string; sessionId: string }[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    // ⚠️ undefined, NOT an empty list. "I could not read the root" and "the root
    // holds no config dirs" are different facts, and only the second is a clean
    // sweep. Returning [] for both is the same silent-null this module keeps
    // finding elsewhere.
    return undefined;
  }
  const candidates: { dir: string; sessionId: string }[] = [];
  for (const entry of entries) {
    const harness = gated.find((id) => entry.startsWith(`${CONFIG_DIR_PREFIX}${id}-`));
    if (harness !== undefined) {
      candidates.push({
        dir: join(root, entry),
        sessionId: entry.slice(`${CONFIG_DIR_PREFIX}${harness}-`.length),
      });
    }
  }
  return candidates;
}

/** Defaults in one place, so the main function reads as the RULE rather than as
 *  a list of fallbacks. */
function resolvePruneDefaults(params: {
  rootDir?: string;
  now?: number;
  orphanMinAgeMs?: number;
}): { root: string; now: number; orphanMinAgeMs: number } {
  return {
    root: params.rootDir ?? tmpdir(),
    now: params.now ?? Date.now(),
    orphanMinAgeMs: params.orphanMinAgeMs ?? DEFAULT_ORPHAN_MIN_AGE_MS,
  };
}

type ConfigDirVerdict = {
  retain: boolean;
  reason: "liveProcess" | "openRecord" | "unrecognised" | "tooYoung";
  /** Set only for an unclaimed dir whose age could be read, so the caller can
   *  report the oldest one it is sitting on. */
  unclaimedAgeMs?: number;
};

/**
 * Whether one directory may be removed. **Every clause of the removal rule lives
 * here**, so the rule can be read in one place rather than reconstructed from a
 * loop — which is how the previous version's comment and code drifted apart.
 */
function classifyConfigDir(
  dir: string,
  sessionId: string,
  ctx: {
    records: ReadonlyMap<string, KnownSessionRecord>;
    liveScan: LiveProcessScan;
    now: number;
    orphanMinAgeMs: number;
  },
): ConfigDirVerdict {
  // Clause 3 first: it is the only one that can be true of a directory whose
  // record was already deleted, and it is the one whose failure mode is worst.
  if (ctx.liveScan.referencedDirs.has(dir)) {
    return { retain: true, reason: "liveProcess" };
  }
  const record = ctx.records.get(sessionId);
  if (record === undefined) {
    // Clause 1 fails. NOT ours to guess about — the fallback `randomUUID()` dir
    // lands here and is in no session list, ever.
    const age = directoryAgeMs(dir, ctx.now);
    if (age === undefined) {
      return { retain: true, reason: "unrecognised" };
    }
    if (age < ctx.orphanMinAgeMs) {
      return { retain: true, reason: "tooYoung", unclaimedAgeMs: age };
    }
    return { retain: false, reason: "unrecognised", unclaimedAgeMs: age };
  }
  if (!record.closed) {
    return { retain: true, reason: "openRecord" }; // Clause 2 fails.
  }
  return { retain: false, reason: "openRecord" };
}

/**
 * How long an UNCLAIMED directory must sit before the sweep may remove it.
 *
 * ⚠️ STATED, NOT INFERRED. Six hours is longer than any turn this programme has
 * observed and shorter than a working day, so a directory this old belongs to a
 * process that is not coming back. It is deliberately generous: the cost of
 * waiting is one directory; the cost of being wrong is a live session's primer.
 */
const DEFAULT_ORPHAN_MIN_AGE_MS = 6 * 60 * 60 * 1000;

function removeDir(dir: string, removed: string[]): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
    return true;
  } catch {
    return false;
  }
}

/** Age from mtime, or undefined when it cannot be read — which is NOT zero. */
function directoryAgeMs(dir: string, now: number): number | undefined {
  try {
    return Math.max(0, now - statSync(dir).mtimeMs);
  } catch {
    return undefined;
  }
}

/** One line carrying every population and every retention reason, so "retained
 *  40" is diagnosable rather than merely reassuring. */
export function describeHarnessConfigDirSweep(result: HarnessConfigDirPruneResult): string {
  const by = result.retainedBy;
  return (
    `[acpx] harness config dirs: scanned=${result.scanned} removed=${result.removed.length} ` +
    `retained=${result.retained} (liveProcess=${by.liveProcess} openRecord=${by.openRecord} ` +
    `unrecognised=${by.unrecognised} tooYoung=${by.tooYoung} removeFailed=${by.removeFailed}` +
    (result.oldestUnclaimedAgeMs === undefined
      ? ""
      : ` oldestUnclaimedAgeMs=${result.oldestUnclaimedAgeMs}`) +
    ")" +
    (result.notMeasured ? " — REFUSED: /proc not measurable, nothing was removed" : "") +
    " (scanned=0 means NOT RUN, not clean)\n"
  );
}

/** Verbose breadcrumb for a written config dir. Never prints a file's CONTENT —
 *  the primer can be long and the dir path is the useful handle for evidence. */
export function reportHarnessConfigDir(
  plan: HarnessConfigDirPlan | undefined,
  verbose: boolean | undefined,
): void {
  if (!plan || !verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] ${plan.harness} config dir ${plan.dir} (${plan.envNames.join(", ")}); ` +
      `wrote ${plan.files.length} file(s)\n`,
  );
}

/** What was written, so a caller can log or evidence it without re-deriving. */
export interface HarnessConfigDirPlan {
  harness: HarnessId;
  dir: string;
  /** Env var names set on the adapter spawn — the RS-13 subject. */
  envNames: string[];
  /** Absolute paths written, for evidence. Never contains a credential. */
  files: string[];
  /** This client's claim on the directory — hand it back to
   *  {@link releaseHarnessConfigDir} at close. */
  holderId?: string;
}

export interface HarnessConfigDirInput {
  /** The adapter spawn env, mutated in place — same contract as `applyBoxProviderEnv`. */
  env: NodeJS.ProcessEnv;
  agentCommand: string | undefined;
  /** Namespaces the directory. Any stable per-session string. */
  sessionId: string;
  /** The rendered OS primer (`agents.md` + the brick block). */
  primer?: string;
  /** The model to pin at creation. */
  model?: string;
  /**
   * An arbitrary OpenRouter slug to PROVISION into the harness's catalogue so it
   * becomes selectable. Without this the harness rejects it locally, before any
   * network call (I1 R6, I2 R5).
   */
  provisionModelId?: string;
  /** Overrides `tmpdir()`; tests use it to keep the directory inside a fixture. */
  rootDir?: string;
  /** The session's working directory — pi namespaces its session store by it
   *  (brick ac86eb34). Absent ⇒ pi's session dir is left alone. */
  cwd?: string;
}

/**
 * Create the per-session config dir for a `config-file`-primer harness and point
 * the adapter at it. Returns `undefined` — writing nothing and setting nothing —
 * for every other harness, and for an agent command the descriptor cannot
 * classify.
 *
 * Fail-open, like `resolveSessionPrimer`: a filesystem error warns on stderr and
 * returns `undefined` rather than blocking session creation. A session with no
 * primer is degraded; a session that cannot be created is broken.
 */
export function applyHarnessConfigDir(
  input: HarnessConfigDirInput,
): HarnessConfigDirPlan | undefined {
  const harness = harnessIdForAgentCommand(input.agentCommand);
  if (harness === undefined) {
    return undefined;
  }
  // THE GATE. Only a harness whose primer channel IS a config file gets one.
  if (HARNESS_FACTS[harness].primerChannel !== "config-file") {
    return undefined;
  }
  // ⚠️ REFUSE A BLANK ID — NEVER SUBSTITUTE A CONSTANT FOR IT (F-8, brick 161294ce).
  //
  // This shipped as `sessionId: record?.trim() || "session"` at the call site, and
  // on the real `sessions new` path the record id is EMPTY at adapter-spawn time
  // (`creationSessionContext` sets `acpxRecordId: ""` because the CLI record id IS
  // the adapter's own session/new id, so it cannot exist before the spawn that
  // produces it). The literal therefore fired on EVERY create: two distinct
  // sessions were handed the SAME `/tmp/acpx-<harness>-session`, and the directory
  // written at CREATE was not the one a RESUMED adapter read.
  //
  // A fallback that silently de-isolates is worse than an error, so there is no
  // fallback here at all. The caller mints a unique id; if a future one ever
  // passes blank again, this refuses loudly instead of quietly sharing a dir.
  if (!input.sessionId.trim()) {
    process.stderr.write(
      `[acpx] refusing to create a ${harness} config dir with a blank session id — ` +
        `a shared directory would de-isolate concurrent sessions. No primer/model pin applied.\n`,
    );
    return undefined;
  }
  try {
    const root = input.rootDir ?? tmpdir();
    const dir = join(root, configDirName(harness, input.sessionId.trim()));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // ⚠️ REGISTER THIS HOLDER BEFORE WRITING ANYTHING. Between mkdir and the
    // marker there is a window in which another client's close would see no
    // holders and remove the directory underneath this one. Narrowing it to two
    // syscalls is what makes the refcount worth having.
    const holderId = registerConfigDirHolder(dir);
    const plan =
      harness === "opencode" ? writeOpenCodeConfigDir(dir, input) : writePiConfigDir(dir, input);
    return { ...plan, holderId };
  } catch (error) {
    process.stderr.write(
      `[acpx] could not create the ${harness} config dir; continuing without primer/model pin: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

/**
 * Warn when the per-session config DISCARDS keys the box's own `opencode.json`
 * had set (F-13, brick 6d2ca570).
 *
 * ⚠️ THE SIGNATURE OF THIS DEFECT IS THAT EVERYTHING ELSE PASSES. acpx re-points
 * BOTH `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`, so the box's config is never
 * read — and the directory still exists, the env is still correct, the primer
 * still arrives, and the turn still works. Measured on the rig across two
 * sessions: with a box-level pin of `deepseek-v4-pro` and a session created with
 * NO `--model`, the per-session config carried only `instructions` and OpenCode's
 * own store served OpenCode's default (`big-pickle`). Nothing failed; the pin
 * simply evaporated.
 *
 * ⚠️ THIS MAKES THE DISCARD LOUD; IT DOES NOT MAKE IT STOP. Treating the box
 * config as a base and acpx's keys as an overlay is B4's job (brick 13f73472).
 * A per-session `--model` works today and is deliberately untouched here.
 *
 * It is read through the env acpx is ABOUT to overwrite, because that is the
 * config the child would otherwise have inherited — reading `$HOME/.config`
 * directly would answer a different question on any box that sets XDG.
 */
/**
 * Where the child WOULD have read its config, in OpenCode's own precedence
 * order. Resolved through the env acpx is ABOUT to overwrite, never from
 * `$HOME/.config` directly — on a box that sets XDG those are different
 * directories and only the former answers "what is being discarded".
 */
function resolveBoxOpenCodeConfigDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return join(xdg, "opencode");
  }
  return join(env.HOME?.trim() || homedir(), ".config", "opencode");
}

/**
 * The box's own `opencode.json`, or undefined when there is none, it is
 * unreadable, or it is not a JSON object. The last case matters: a JSON array
 * parses fine and `Object.keys` would then report array INDICES as discarded
 * settings, which is a warning that names nothing real.
 */
function readBoxOpenCodeConfig(dir: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function warnDiscardedBoxConfigKeys(env: NodeJS.ProcessEnv, sessionKeys: string[]): void {
  const boxConfigDir = resolveBoxOpenCodeConfigDir(env);
  const boxConfig = readBoxOpenCodeConfig(boxConfigDir);
  if (!boxConfig) {
    return; // no box config, or unreadable — nothing is being discarded
  }
  const kept = new Set(sessionKeys);
  const discarded = Object.keys(boxConfig).filter((key) => !kept.has(key));
  if (discarded.length === 0) {
    return;
  }
  // ⚠️ NAME THE KEYS. "some settings were ignored" sends the reader to look for
  // something they cannot identify; the whole value of this warning is that it
  // says WHICH setting silently stopped applying.
  process.stderr.write(
    `[acpx] opencode: this session uses its own config dir, so ${discarded.length} ` +
      `key(s) from ${join(boxConfigDir, "opencode.json")} are NOT applied: ` +
      `${discarded.join(", ")}. Pass them per session (e.g. --model) if you need them.\n`,
  );
}

/**
 * OpenCode (I1 R9, R15).
 *
 * ⚠️ **BOTH `XDG_CONFIG_HOME` AND `OPENCODE_CONFIG_DIR` ARE REQUIRED.** OpenCode
 * MERGES config from both, so setting only the latter does NOT isolate the
 * session — I1's first negative control failed for exactly this reason, and the
 * lane then twice re-created state in `/home/node` by invoking OpenCode without
 * them. Whatever spawns the adapter must set them unconditionally, together.
 */
function writeOpenCodeConfigDir(dir: string, input: HarnessConfigDirInput): HarnessConfigDirPlan {
  const configDir = join(dir, "opencode");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const files: string[] = [];

  // `"instructions"` takes ABSOLUTE paths to files outside the project root, and
  // is repo-independent — proven in turn 1 AND after `session/load` (I1 R9).
  // `_meta.systemPrompt.append` is accepted and SILENTLY IGNORED, so it is not
  // an option here however familiar it looks from the Claude path.
  const config: Record<string, unknown> = {};
  if (input.primer) {
    const primerPath = join(dir, "acpx-primer.md");
    writeFileSync(primerPath, input.primer, { mode: 0o600 });
    files.push(primerPath);
    config.instructions = [primerPath];
  }
  if (input.model) {
    config.model = input.model;
  }
  if (input.provisionModelId) {
    // I1 R6: declaring the slug here is what makes an id outside the bundled
    // models.dev snapshot resolvable at all. Measured: before the declaration
    // OpenCode fails LOCALLY (`ProviderModelNotFoundError … Did you mean:`);
    // after it, the identical request reaches OpenRouter and fails UPSTREAM
    // instead — which is what proves the request was forwarded.
    config.provider = {
      openrouter: { models: { [stripProviderPrefix(input.provisionModelId)]: {} } },
    };
  }

  const configPath = join(configDir, "opencode.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  files.push(configPath);

  // ⚠️ WARN BEFORE THE RE-POINT — this is the LAST moment the box's own config is
  // still reachable through the env we are about to overwrite (F-13).
  warnDiscardedBoxConfigKeys(input.env, Object.keys(config));

  input.env.XDG_CONFIG_HOME = dir;
  input.env.OPENCODE_CONFIG_DIR = configDir;
  return {
    harness: "opencode",
    dir,
    envNames: ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR"],
    files,
  };
}

/**
 * Pi (I2 R9).
 *
 * Through acpx/pi-acp only the `PI_CODING_AGENT_DIR` paths survive: pi-acp
 * passes no system-prompt flag and offers no ACP channel for one, so
 * `--append-system-prompt` is unreachable from here however well it works
 * natively.
 *
 * ⚠️ **KNOWN UN-ISOLATABLE LEAK, RECORDED RATHER THAN FOUGHT.** `pi-acp` writes
 * its session map to a **hardcoded** `~/.pi/pi-acp/session-map.json`, ignoring
 * `PI_CODING_AGENT_DIR` entirely. It follows `HOME`, so a per-session config dir
 * does not contain it. Nothing here can fix that — it is the adapter's path, not
 * ours — and pretending otherwise would be worse than saying so.
 */
function writePiConfigDir(dir: string, input: HarnessConfigDirInput): HarnessConfigDirPlan {
  const files: string[] = [];
  if (input.primer) {
    // I2 R9 measured this end-to-end: the marker was in turn 1's request body
    // AND survived a SIGKILL of both pi and pi-acp followed by a resume.
    const appendSystemPath = join(dir, "APPEND_SYSTEM.md");
    writeFileSync(appendSystemPath, input.primer, { mode: 0o600 });
    files.push(appendSystemPath);
  }
  // ⚠️ WRITING `models-store.json` HERE IS SAFE, AND THE COMMENT THAT STOOD HERE
  // SAYING OTHERWISE WAS WRONG. It read: *"What is NOT established is whether a
  // file in `PI_CODING_AGENT_DIR` merges with or REPLACES the bundled catalogue…
  // if the semantics are REPLACE, writing one entry here silently removes the
  // other ~370 models from every Pi session."* Measured 2026-09-04 against pi
  // 0.84.4 (brick ef5999ca, B5): **it MERGES, by id.**
  //
  //   `mergeModels(baseline, dynamic)` — `dist/core/remote-catalog-provider.js:7-16`
  //   — walks the stored entry and REPLACES a same-id model or APPENDS a new one.
  //   Planting a one-entry file took the offered catalogue from 333 models to
  //   **334**, with the planted slug offered, a pre-existing slug still offered,
  //   and 333 again after restore.
  //
  // ⚠️ THE REAL HAZARD IS THE OPPOSITE ONE, AND IT IS SILENT: an entry is IGNORED
  // unless the provider block carries a `lastModified` GREATER than the bundled
  // catalogue's generation stamp — `remoteModels()` returns `[]` when it is
  // absent (`remote-catalog-provider.js:31-38`). A well-formed entry without it
  // changes nothing at all, with no error anywhere; measured 333 → 333, slug not
  // offered. That is why the stamp below is `Date.now()` and not optional.
  //
  // ⚠️ THE SECOND TRAP, ALSO MEASURED: pi's own catalogue ships
  // `https://openrouter.ai/api` (NO `/v1`) for all 15 `anthropic-messages`
  // entries, so an Anthropic model's request goes out on the openai-completions
  // route, which appends `/chat/completions` → `POST /api/chat/completions` →
  // 404 (I2 R6, root-caused at the wire). Every entry generated here therefore
  // carries `https://openrouter.ai/api/v1`, and because the merge is BY ID this
  // also repairs a bundled entry rather than merely adding new ones.
  if (input.provisionModelId) {
    writePiModelsStore(dir, input.env, stripProviderPrefix(input.provisionModelId), files);
  }
  // ⚠️ KEEP pi's SESSION STORE WHERE IT WAS — read BEFORE the re-point below,
  // which is the last moment the box's own agent dir is still reachable through
  // the variable we are about to overwrite (brick ac86eb34; same ordering as the
  // F-13 discard warning).
  const sessionDir = resolvePiSessionDir(input.env, input.cwd);
  input.env.PI_CODING_AGENT_DIR = dir;
  const envNames = ["PI_CODING_AGENT_DIR"];
  if (sessionDir) {
    input.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    envNames.push("PI_CODING_AGENT_SESSION_DIR");
  }
  return { harness: "pi", dir, envNames, files };
}

/**
 * Generate pi's per-session `models-store.json` so an arbitrary OpenRouter slug
 * resolves — and repair pi's broken Anthropic entries on the way past.
 *
 * ## The two measurements this is built on (pi 0.84.4, brick ef5999ca)
 *
 * **It MERGES, by id.** `mergeModels(baseline, dynamic)`
 * (`dist/core/remote-catalog-provider.js:7-16`) replaces a same-id model and
 * appends a new one. Measured: a one-entry file took the offered catalogue from
 * 333 models to 334, the planted slug was offered, a pre-existing slug still
 * resolved, and 333 came back after restore. The standing comment that said this
 * might REPLACE the catalogue — and kept the capability switched off — was wrong.
 *
 * **But an entry is IGNORED without a fresh `lastModified`.** `remoteModels()`
 * (`:31-38`) returns `[]` when the provider block's `lastModified` is absent or
 * not newer than the bundled stamp. A well-formed entry without it changes
 * nothing, with no error anywhere: measured 333 → 333, slug not offered.
 *
 * ## ⚠️ WHY THE BOX'S OWN CATALOGUE IS COPIED FORWARD RATHER THAN REPLACED
 *
 * Writing ONLY the requested slug is what a naive "generate a fragment" does, and
 * it costs the session every model pi had cached: measured 374 offered → 334,
 * because the per-session file REPLACES the box's remote-overlay block (the
 * bundled 333 survive; the ~41 overlay-only models do not). Worse, if the slug is
 * one the catalogue ALREADY has, the generated entry replaces a real one with
 * guessed metadata — no `thinkingLevelMap` (so the depth ladder silently becomes
 * wrong), a made-up context window, zero costs.
 *
 * So the box's overlay is read first and the slug is UPSERTED into it. A slug the
 * catalogue already carries keeps its real metadata; only a genuinely new one gets
 * a generic entry.
 *
 * ## The Anthropic repair rides along
 *
 * All 15 `anthropic-messages` entries ship `https://openrouter.ai/api` — no `/v1`
 * — so the request goes out on the openai-completions route, which appends
 * `/chat/completions` → `POST /api/chat/completions` → 404 (I2 R6, at the wire).
 * Re-measured at the source: `GET https://pi.dev/api/models/providers/openrouter`
 * still serves 15 such entries. Because the merge is by id, patching them in the
 * copied overlay repairs them for the session rather than merely adding new ones.
 *
 * ⚠️ `checkedAt` is stamped NOW deliberately: pi refreshes the remote catalogue
 * when that is older than 4 h, and a refresh REPLACES the whole `openrouter`
 * block — provisioned slug and Anthropic repair included. A session running
 * longer than 4 h can therefore lose both. Recorded rather than worked around;
 * the fix belongs in pi's own merge, not in a second copy of it here.
 */
function writePiModelsStore(
  dir: string,
  env: NodeJS.ProcessEnv,
  modelId: string,
  files: string[],
): void {
  // The box's catalogue is parsed fresh from disk on every call, so mutating the
  // entries here cannot reach anything else.
  const models = readBoxPiOpenRouterModels(env);
  for (const model of models) {
    if (model.api === "anthropic-messages" && model.baseUrl === OPENROUTER_API_BASE_NO_V1) {
      model.baseUrl = OPENROUTER_API_BASE;
    }
  }

  // A slug the catalogue already carries needs nothing: it keeps every field pi
  // has for it, including the `thinkingLevelMap` the depth ladder is derived from.
  if (!models.some((model) => model.id === modelId)) {
    models.push({
      id: modelId,
      name: modelId,
      api: "openai-completions",
      baseUrl: OPENROUTER_API_BASE,
      provider: "openrouter",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
  }

  const now = Date.now();
  const storePath = join(dir, "models-store.json");
  writeFileSync(
    storePath,
    `${JSON.stringify({ openrouter: { lastModified: now, checkedAt: now, models } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  files.push(storePath);
}

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_API_BASE_NO_V1 = "https://openrouter.ai/api";

type PiCatalogueModel = {
  id?: string;
  api?: string;
  baseUrl?: string;
  [key: string]: unknown;
};

/**
 * pi's cached OpenRouter catalogue from the BOX agent dir — read before the
 * re-point, like the session store and the F-13 discard warning.
 *
 * An empty result is a legitimate state (pi has never run on this box), not an
 * error: the bundled catalogue still resolves, so the session simply gets the
 * provisioned slug on top of it.
 */
function readBoxPiOpenRouterModels(env: NodeJS.ProcessEnv): PiCatalogueModel[] {
  const boxAgentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? env.PI_CODING_AGENT_DIR.trim()
    : join(env.HOME?.trim() || homedir(), ".pi", "agent");
  try {
    const parsed = JSON.parse(readFileSync(join(boxAgentDir, "models-store.json"), "utf8")) as {
      openrouter?: { models?: unknown };
    };
    const models = parsed.openrouter?.models;
    return Array.isArray(models) ? (models as PiCatalogueModel[]) : [];
  } catch {
    return [];
  }
}

/**
 * Where pi's session JSONL should go once acpx has moved pi's agent dir
 * (brick ac86eb34).
 *
 * ## The defect
 *
 * `PI_CODING_AGENT_DIR` is pi's **data** dir as well as its config dir, so
 * re-pointing it for the primer took the session store with it. The JSONL was
 * still written — measured, so do NOT record this as "pi stopped writing" — but
 * into the throwaway per-session directory, which is removed at close. **pi's
 * per-message JSONL is IR-3's SECOND authority for pi**, so every pi served-model
 * claim was left resting on one leg.
 *
 * ## ⚠️ WHY THE OBVIOUS FIX IS WRONG, AND IT WOULD HAVE PASSED A PATH CHECK
 *
 * pi honours `PI_CODING_AGENT_SESSION_DIR` (`main.js:530`; precedence
 * `--session-dir` > env > `settings.json.sessionDir`) — but it treats it as the
 * **FINAL directory**, not as a root under which it appends `--<cwd>--`.
 * Measured with real turns: pointed at a store ROOT, pi writes the JSONL **FLAT**
 * into it. IR-3 reads at `<store>/sessions/--<cwd-with-slashes-as-dashes>--/`, so
 * the root form leaves the authority just as dead while making the directory look
 * correct.
 *
 * So the variable is pointed at the **cwd-mangled subdirectory** — the exact path
 * an un-overridden pi would have used.
 *
 * ⚠️ **THE MANGLING IS A VERSION-PINNED MEASUREMENT, NOT A PROPERTY.** It is read
 * from `@earendil-works/pi-agent-core` (bundled with pi-coding-agent **0.84.4**),
 * `dist/harness/session/jsonl/repo.js:13-15`. Same class of fact as the
 * `session/set_model` capability cell that was TRUE and WENT STALE, and as
 * `piWireDepthValue`'s ladder. **RE-MEASURE TRIGGER: when the pinned pi version
 * moves** — re-read `jsonlSessionDirectoryName` and confirm this still matches.
 *
 * ⚠️ **AND THE DIRECTORY MUST EXIST BEFORE pi STARTS.** Measured: with the
 * variable naming a missing directory, pi **HANGS** — rc=124 on a 150 s timeout,
 * **empty stdout AND empty stderr**, no error of any kind. A missing `mkdir` here
 * does not degrade, it wedges the session, and it looks exactly like a slow model.
 */
function resolvePiSessionDir(env: NodeJS.ProcessEnv, cwd: string | undefined): string | undefined {
  if (!cwd?.trim()) {
    // No cwd, no mangled name. Better to leave pi's default alone than to invent
    // a path: the session still runs, and the JSONL is merely where it is today.
    return undefined;
  }
  const boxAgentDir = env.PI_CODING_AGENT_DIR?.trim()
    ? env.PI_CODING_AGENT_DIR.trim()
    : join(env.HOME?.trim() || homedir(), ".pi", "agent");
  const target = join(boxAgentDir, "sessions", jsonlSessionDirectoryName(cwd.trim()));
  try {
    mkdirSync(target, { recursive: true });
  } catch {
    // Could not create it — so do NOT point pi at it. Pointing pi at a directory
    // that does not exist is the hang described above; leaving the variable unset
    // keeps today's behaviour, which is degraded but alive.
    return undefined;
  }
  return target;
}

/**
 * pi's own session-directory name for a cwd, transcribed from
 * `pi-agent-core` `dist/harness/session/jsonl/repo.js:13-15` (pi 0.84.4):
 *
 * ```js
 * `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 * ```
 *
 * Transcribed rather than approximated, because a near-miss produces a directory
 * that exists, is written to, and is not the one IR-3 reads.
 */
function jsonlSessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * `openrouter/z-ai/glm-5.3-flash` → `z-ai/glm-5.3-flash`.
 *
 * Both harnesses namespace the catalogue by provider, so the ENTRY key is the
 * bare vendor/model while the SELECTOR carries the provider prefix. Writing the
 * prefixed form as the key produces `provider.openrouter.models.openrouter/…`,
 * which the harness never looks up — and the failure is a local "model not
 * found" that reads exactly like the un-provisioned case it was meant to fix.
 */
function stripProviderPrefix(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.startsWith("openrouter/") ? trimmed.slice("openrouter/".length) : trimmed;
}
