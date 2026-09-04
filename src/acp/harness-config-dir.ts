import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
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
 * Remove one spawn's config dir. Best-effort: a failure here must never surface
 * as a session-close error, because the orphan sweep below is the guarantee.
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

/** What an orphan sweep did — `scanned` is printed so 0 reads NOT RUN, not clean. */
export interface HarnessConfigDirPruneResult {
  /** Candidate directories examined. **0 means the sweep found nothing to look
   *  at — NOT RUN — not that everything was already clean.** */
  scanned: number;
  removed: string[];
  /** Kept because a live session still owns them. */
  retained: number;
}

/**
 * Sweep config dirs whose session is gone (brick 433f6bf8).
 *
 * ⚠️ WHY THIS EXISTS ALONGSIDE remove-on-close: **close is not guaranteed to
 * run.** An owner death, a pod eviction or a `kill -9` skips it entirely — this
 * programme saw two owner deaths in one afternoon — so remove-on-close is the
 * fast path and this is the guarantee. Shipping only the former would leak one
 * directory plus a full primer copy per killed session, forever.
 *
 * ⚠️ IT IS NOT A BLIND `rm`. A directory is removed only when its id appears in
 * neither `liveSessionIds` nor as a live spawn — an id it does not recognise is
 * RETAINED, because a sweep that guesses wrong deletes a running session's
 * primer mid-turn. `retained` is reported so that caution is visible rather than
 * silent.
 */
export function pruneOrphanHarnessConfigDirs(params: {
  liveSessionIds: ReadonlySet<string>;
  rootDir?: string;
}): HarnessConfigDirPruneResult {
  const root = params.rootDir ?? tmpdir();
  const gated = HARNESS_IDS.filter((id) => HARNESS_FACTS[id].primerChannel === "config-file");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { scanned: 0, removed: [], retained: 0 };
  }

  const removed: string[] = [];
  let scanned = 0;
  let retained = 0;
  for (const entry of entries) {
    const harness = gated.find((id) => entry.startsWith(`${CONFIG_DIR_PREFIX}${id}-`));
    if (harness === undefined) {
      continue; // not ours — never touched
    }
    scanned += 1;
    const sessionId = entry.slice(`${CONFIG_DIR_PREFIX}${harness}-`.length);
    if (params.liveSessionIds.has(sessionId)) {
      retained += 1;
      continue;
    }
    const dir = join(root, entry);
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      retained += 1;
    }
  }
  return { scanned, removed, retained };
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
    return harness === "opencode"
      ? writeOpenCodeConfigDir(dir, input)
      : writePiConfigDir(dir, input);
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
  // ⚠️ NO `models-store.json` IS WRITTEN HERE, AND THAT IS DELIBERATE — DO NOT
  // "COMPLETE" THIS BY ADDING ONE WITHOUT MEASURING FIRST.
  //
  // Pi resolves models from a bundled `models-store.json` with ~371 entries and
  // will not take a free-text slug (I2 R5), so provisioning an arbitrary slug
  // does mean writing that file. What is NOT established is whether a file in
  // `PI_CODING_AGENT_DIR` **merges with** or **REPLACES** the bundled catalogue.
  // I2 proved only that EDITING existing entries is honoured (it rewrote three
  // entries' `baseUrl` in place) — which says nothing about a fresh one-entry
  // file. If the semantics are REPLACE, writing one entry here silently removes
  // the other ~370 models from every Pi session, breaking sessions that never
  // asked for provisioning to fix one that did.
  //
  // The asymmetry decides it: not writing costs an unprovisioned slug failing
  // honestly (the model apply path already refuses loudly); writing wrongly costs
  // every Pi session its catalogue. OpenCode is different and IS provisioned
  // above, because `provider.openrouter.models.<id>` is a documented ADDITIVE
  // config key and I1 R6 measured a declared slug reaching OpenRouter while the
  // rest of the catalogue kept resolving.
  //
  // ⚠️ When someone does measure this, the fix carries a second trap: Pi's own
  // catalogue ships `https://openrouter.ai/api` (no `/v1`) for all 15
  // `anthropic-messages` entries, so the request goes out on the
  // openai-completions route, which appends `/chat/completions` → `POST
  // /api/chat/completions` → 404. I2 root-caused that at the wire; any generated
  // entry must carry `https://openrouter.ai/api/v1`.
  //
  // Consequently `pi` stays out of ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX, so
  // `acceptsArbitraryModelIds` is false and the picker does not offer a band that
  // would fail at spawn. That is the descriptor working as designed.
  input.env.PI_CODING_AGENT_DIR = dir;
  return { harness: "pi", dir, envNames: ["PI_CODING_AGENT_DIR"], files };
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
