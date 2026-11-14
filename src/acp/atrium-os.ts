import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * PER-SESSION OPERATING SYSTEM (P3a, OS-extraction programme; spec
 * `/wisdom/Bricks/f87fa15b-…/conception/IMPLEMENTATION-SPEC.md` §1–§4).
 *
 * A session stores a CHOICE (`metadata.atrium_os`: absent = `default`, else an absolute path); every
 * agent start resolves it to a ROOT, exports it as `$ATRIUM_OS`, and puts `<root>/bin` first on PATH
 * after stripping every other OS bin. `default` means the BOX default root, which is never derived
 * from any session's choice.
 *
 * Neutral today: with `ATRIUM_OS` / `ATRIUM_OS_DEFAULT` unset and no `bin/.atrium-os-bin` marker
 * anywhere, the root is `/wisdom/Operating System`, its bin moves from last to first on PATH (no other
 * PATH entry carries its two script names), and the primer command is the same literal as before.
 */

export const ATRIUM_OS_ENV = "ATRIUM_OS";
export const ATRIUM_OS_DEFAULT_ENV = "ATRIUM_OS_DEFAULT";
/** Today's OS root, and — once P6 swaps it — the compatibility link (§4.5). */
export const LEGACY_OS_ROOT = "/wisdom/Operating System";
/** P2 creates `<root>/bin/.atrium-os-bin` in every OS release; the PATH strip keys on it. */
export const OS_BIN_MARKER = ".atrium-os-bin";
/**
 * RETIRED as a PATH input (§3.6). Read in ONE place — `boxDefaultOsRoot`'s transition alias — and
 * never written into an agent env. Retirement condition: delete the alias once
 * `grep -rn ACPX_AGENT_OS_BIN /wisdom/Projects/acpx-ui/skills/devn-slot/` is empty and every live
 * dev-slot stack has been restarted from the changed script.
 */
export const LEGACY_OS_BIN_ENV = "ACPX_AGENT_OS_BIN";

/** `record.metadata` keys (§1.2). The choice is written only by creation and `set-os`. */
export const ATRIUM_OS_KEY = "atrium_os";
/** The three OBSERVATION keys — written and cleared only by the lifecycle-snapshot leg (§1.6). */
export const ATRIUM_OS_REVISION_KEY = "atrium_os_revision";
export const ATRIUM_OS_FALLBACK_KEY = "atrium_os_fallback";
export const ATRIUM_OS_PRIMER_ERROR_KEY = "atrium_os_primer_error";

/** Where an explicit choice may point (v5 §3; both pods mount them). */
export const ALLOWED_OS_CHOICE_ROOTS: readonly string[] = ["/workspace/", "/opt/atrium-os/"];

const DEFAULT_CHOICE = "default";
const REVISION_TIMEOUT_MS = 2_000;
const HEX40 = /^[0-9a-f]{40}$/;
const RELEASE_PATH = /\/releases\/([0-9a-f]{40})$/;
// Control characters, built from code points so this source file stays free of raw control bytes.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** `path.resolve` already drops a trailing `/` except on `/` itself; this keeps that one rule explicit. */
function normaliseAbsolute(value: string, cwd = process.cwd()): string {
  return path.resolve(cwd, value);
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

let warnedLegacyBinAlias = false;

/** Test-only: re-arm the once-per-process alias note. */
export function resetAtriumOsWarningsForTests(): void {
  warnedLegacyBinAlias = false;
}

/**
 * What `default` means on this box. ⚠️ NEVER derived from a session's choice (v5 §3 invariant):
 * it reads `ATRIUM_OS_DEFAULT`, which acpx never writes, so a child of an override parent still gets
 * the box's default.
 */
export function boxDefaultOsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmpty(env[ATRIUM_OS_DEFAULT_ENV]);
  if (explicit) {
    return normaliseAbsolute(explicit);
  }
  // Transition alias (§3.6): a dev-slot stack still sets ACPX_AGENT_OS_BIN=<its copy>/bin.
  const legacyBin = nonEmpty(env[LEGACY_OS_BIN_ENV]);
  if (legacyBin) {
    const normalised = normaliseAbsolute(legacyBin);
    if (path.basename(normalised) === "bin") {
      return path.dirname(normalised);
    }
    if (!warnedLegacyBinAlias) {
      warnedLegacyBinAlias = true;
      process.stderr.write(
        `[acpx] note: ${LEGACY_OS_BIN_ENV}=${legacyBin} does not name a bin/ directory; ignored (set ${ATRIUM_OS_DEFAULT_ENV} instead)\n`,
      );
    }
  }
  return LEGACY_OS_ROOT;
}

/** The OS THIS process runs on — for commands it prints and for creation rule 4. */
export function processOsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const own = nonEmpty(env[ATRIUM_OS_ENV]);
  return own ? normaliseAbsolute(own) : boxDefaultOsRoot(env);
}

/**
 * A STORED choice as read from a record: absent, `default`, `""` and whitespace all READ as default
 * (`undefined`) — tolerance for hand edits and acpx-ui writes. Anything else is returned as stored
 * (trimmed); its usability is judged at spawn, never here.
 */
export function normaliseStoredChoice(raw: string | null | undefined): string | undefined {
  const trimmed = nonEmpty(raw);
  return trimmed === undefined || trimmed === DEFAULT_CHOICE ? undefined : trimmed;
}

/** A directory holding a regular `agents.md` — what makes a directory an OS root (§1.4 rule 7). */
export function isUsableOsRoot(root: string): boolean {
  return path.isAbsolute(root) && isDirectory(root) && isFile(path.join(root, "agents.md"));
}

export type OsChoiceValidation =
  | { ok: true; /** `undefined` = default (nothing stored). */ choice?: string }
  | { ok: false; reason: string };

/**
 * Normalise and validate an EXPLICIT choice (`--os`, creation rule 4, `set-os`) — §1.4. The stored
 * string is the normalised path, NEVER `realpath`'d: a stored `/opt/atrium-os/current` must keep
 * following the refresher and a pinned `releases/<c>` must stay pinned.
 */
export function validateOsChoice(
  raw: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): OsChoiceValidation {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === DEFAULT_CHOICE) {
    return { ok: true };
  }
  if (!isPathRepresentable(trimmed)) {
    return { ok: false, reason: "contains ':' or a control character, which PATH cannot carry" };
  }
  const normalised = normaliseAbsolute(trimmed, options.cwd);
  if (normalised === boxDefaultOsRoot(options.env ?? process.env)) {
    return { ok: true };
  }
  const reason = explicitRootRefusal(normalised);
  return reason === undefined ? { ok: true, choice: normalised } : { ok: false, reason };
}

function isPathRepresentable(value: string): boolean {
  return !value.includes(":") && !CONTROL_CHARS.test(value);
}

/** §1.4 rules 4, 5 and 7 for a normalised explicit path; `undefined` = acceptable. */
function explicitRootRefusal(normalised: string): string | undefined {
  if (!ALLOWED_OS_CHOICE_ROOTS.some((root) => normalised.startsWith(root))) {
    return `not under ${ALLOWED_OS_CHOICE_ROOTS.join(" or ")}`;
  }
  if (normalised.split("/").some((component) => component.startsWith("."))) {
    return "a path component starts with '.' (dot-folders are not allowed)";
  }
  if (!isUsableOsRoot(normalised)) {
    return "not a directory holding a regular agents.md";
  }
  return undefined;
}

/**
 * Which creation path is asking (§2.1). `successor` = `sessions new --from` (so also `handover`);
 * `copy` = a user fork / copy; `byway` = a by-the-way copy; `template` = a template copy; `plain` = a
 * fresh `sessions new` or seat join; `exec` / `flow` = record-less or caller-less creates.
 */
export type OsCreateKind = "plain" | "successor" | "copy" | "byway" | "template" | "exec" | "flow";

export type OsCreateInput = {
  /** `--os`, verbatim. */
  explicit?: string;
  kind: OsCreateKind;
  /** The SOURCE record's stored `atrium_os` (successor / copy / byway). `null` = stored default. */
  sourceChoice?: string | null;
  /** A LOCAL parent record's stored `atrium_os`; `undefined` = no local parent resolved. */
  parentChoice?: string | null;
  /** A template copy's template record — for the m1 "baked under another OS" warning. */
  template?: { id: string; choice?: string | null };
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type OsCreateResolution =
  | { ok: true; /** `undefined` = default: nothing stored. */ choice?: string; warnings: string[] }
  | { ok: false; reason: string };

const INHERITS_FROM_SOURCE: ReadonlySet<OsCreateKind> = new Set(["successor", "copy", "byway"]);

/**
 * THE creation precedence (§2.1, v5 §3 / review M7 + m1). First match wins:
 *  1. `--os` → validated; a refusal stops the create.
 *  2. successor / user fork / by-the-way → the SOURCE's stored choice, verbatim (a missing path is the
 *     spawn's business, §4.3).
 *  3. a local parent → the parent's stored choice. NOT gated on same-agent: the OS is harness-independent.
 *  4. no local parent → `$ATRIUM_OS`, when it differs from the box default and validates (else a note).
 *  5. default.
 */
export function resolveOsChoiceForCreate(input: OsCreateInput): OsCreateResolution {
  const env = input.env ?? process.env;
  const resolved = resolvePrecedence(input, env);
  if (!resolved.ok || input.template === undefined) {
    return resolved;
  }
  const templateChoice = normaliseStoredChoice(input.template.choice);
  if (templateChoice !== resolved.choice) {
    resolved.warnings.push(
      `[acpx] warning: template ${input.template.id} was baked under OS ${templateChoice ?? DEFAULT_CHOICE}; this copy runs on ${resolved.choice ?? DEFAULT_CHOICE}`,
    );
  }
  return resolved;
}

function resolvePrecedence(input: OsCreateInput, env: NodeJS.ProcessEnv): OsCreateResolution {
  if (input.explicit !== undefined) {
    const validated = validateOsChoice(input.explicit, { cwd: input.cwd, env });
    return validated.ok
      ? { ok: true, choice: validated.choice, warnings: [] }
      : { ok: false, reason: `--os ${input.explicit}: ${validated.reason}` };
  }
  if (INHERITS_FROM_SOURCE.has(input.kind) && input.sourceChoice !== undefined) {
    return { ok: true, choice: normaliseStoredChoice(input.sourceChoice), warnings: [] };
  }
  if (input.parentChoice !== undefined) {
    return { ok: true, choice: normaliseStoredChoice(input.parentChoice), warnings: [] };
  }
  return resolveFromCallerEnv(env, input.cwd);
}

/** Rule 4 / 5: a caller with no local parent — its own `$ATRIUM_OS`, else default. */
function resolveFromCallerEnv(env: NodeJS.ProcessEnv, cwd?: string): OsCreateResolution {
  const own = nonEmpty(env[ATRIUM_OS_ENV]);
  if (own === undefined || normaliseAbsolute(own, cwd) === boxDefaultOsRoot(env)) {
    return { ok: true, choice: undefined, warnings: [] };
  }
  const validated = validateOsChoice(own, { cwd, env });
  if (validated.ok) {
    return { ok: true, choice: validated.choice, warnings: [] };
  }
  return {
    ok: true,
    choice: undefined,
    warnings: [
      `[acpx] ${ATRIUM_OS_ENV}=${own} is not a usable OS root (${validated.reason}); this session uses the default`,
    ],
  };
}

export type AtriumOsOutcome = {
  /** The root this spawn runs on — what `$ATRIUM_OS` was set to. */
  root: string;
  /** The stored explicit choice, normalised; `undefined` = default. */
  choice?: string;
  /** The stored path was not a usable OS root, so this spawn runs on the box default (§4.3). */
  fallback?: { at: string; missing: string };
};

/** PATH strip-then-prepend (§3.3 step 6) — the one contract the profile snippet and workbench share. */
function rebuildPath(currentPath: string | undefined, bin: string): string | undefined {
  const binUsable = !bin.includes(":") && isDirectory(bin);
  if (!currentPath) {
    return binUsable ? bin : currentPath;
  }
  const kept = currentPath.split(":").filter((entry) => {
    // Empty and relative entries are not OS bins; removing them would change PATH semantics.
    if (entry === "" || !path.isAbsolute(entry)) {
      return true;
    }
    return path.resolve(entry) !== bin && !existsSync(path.join(entry, OS_BIN_MARKER));
  });
  return (binUsable ? [bin, ...kept] : kept).join(":");
}

/**
 * The OS half of an agent env — §3.3. ⚠️ MUST STAY THE LAST STEP of `buildAgentEnvironment` (after the
 * credential strip): it owns `ATRIUM_OS` and PATH's OS entries.
 *
 * - `ATRIUM_OS` is ALWAYS written, never inherited: the env starts from acpx's own `process.env`, and a
 *   queue owner can be started by an acpx running inside an agent on ANOTHER OS (review M1).
 * - `ATRIUM_OS_DEFAULT` is NEVER written — it passes through from acpx's env, or stays absent.
 * - `ACPX_AGENT_OS_BIN` is never written either (retired, §3.6).
 */
export function applyAtriumOsEnvironment(
  env: NodeJS.ProcessEnv,
  osChoice: string | null | undefined,
  now: () => Date = () => new Date(),
): AtriumOsOutcome {
  const defaultRoot = boxDefaultOsRoot(env);
  const choice = normaliseStoredChoice(osChoice);
  let root = defaultRoot;
  let fallback: AtriumOsOutcome["fallback"];
  if (choice !== undefined) {
    if (isUsableOsRoot(choice)) {
      root = choice;
    } else {
      fallback = { at: now().toISOString(), missing: choice };
    }
  }
  env[ATRIUM_OS_ENV] = root;
  const nextPath = rebuildPath(env.PATH, path.join(root, "bin"));
  if (nextPath !== undefined) {
    env.PATH = nextPath;
  }
  return { root, choice, fallback };
}

function gitHeadRevision(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "rev-parse", "--verify", "HEAD"],
      { timeout: REVISION_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => {
        const hex = stdout.trim();
        resolve(!error && HEX40.test(hex) ? hex : null);
      },
    );
  });
}

/**
 * The revision the agent start ran (§1.3) — an OBSERVATION, not identity. `releases/<40-hex>` after
 * realpath (refresher repo mode / a pinned release) → that hex; else a worktree's HEAD; else `null`
 * (a live folder such as today's `/wisdom/Operating System`). Never throws.
 */
export async function resolveOsRevision(root: string): Promise<string | null> {
  try {
    const match = RELEASE_PATH.exec(realpathSync(root));
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    return null;
  }
  if (!existsSync(path.join(root, ".git"))) {
    return null;
  }
  return await gitHeadRevision(root);
}

/**
 * C11 refuse keying (§4.5): from the wisdom swap (P6 step 6) on, `/wisdom/Operating System` is a
 * symlink, and a create whose primer fails is then refused. Evaluated per create. The path is a
 * parameter so tests point it at a temp symlink — never test it by touching the real path on a box.
 */
export function isOsCompatLinkInPlace(linkPath: string = LEGACY_OS_ROOT): boolean {
  try {
    return lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

export class OsPrimerRequiredError extends Error {
  constructor(reason: string) {
    super(
      `refusing to create the session: its Operating System primer did not render (${reason}), and on this box the OS is mandatory (${LEGACY_OS_ROOT} is the compatibility link).`,
    );
    this.name = "OsPrimerRequiredError";
  }
}

// ── The OS notice (§4.4) ───────────────────────────────────────────────────────────────────────────
//
// Process-local, keyed by acpx record id: the client ARMS it at spawn (fallback, failed or carried
// primer), the `atrium-os-notice` turn-context provider TAKES it — so it is delivered once per spawn,
// on the next turn that process serves.

export type AtriumOsNoticeKind = "fallback" | "primer";

const pendingNotices = new Map<string, Map<AtriumOsNoticeKind, string>>();

export function armAtriumOsNotice(
  recordId: string | undefined,
  kind: AtriumOsNoticeKind,
  text: string,
): void {
  if (!recordId) {
    return;
  }
  const notices = pendingNotices.get(recordId) ?? new Map<AtriumOsNoticeKind, string>();
  notices.set(kind, text);
  pendingNotices.set(recordId, notices);
}

/** Drop one kind (a successful render clears a carried primer notice), or every kind. */
export function clearAtriumOsNotice(recordId: string | undefined, kind?: AtriumOsNoticeKind): void {
  if (!recordId) {
    return;
  }
  if (kind === undefined) {
    pendingNotices.delete(recordId);
    return;
  }
  pendingNotices.get(recordId)?.delete(kind);
}

/** One synchronous map lookup, consuming — the turn-context provider contract (no I/O). */
export function takeAtriumOsNotice(recordId: string | undefined): string | undefined {
  if (!recordId) {
    return undefined;
  }
  const notices = pendingNotices.get(recordId);
  pendingNotices.delete(recordId);
  if (!notices || notices.size === 0) {
    return undefined;
  }
  return [notices.get("fallback"), notices.get("primer")]
    .filter((text): text is string => text !== undefined)
    .join("\n\n");
}

function oneLine(text: string, max = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function fallbackNoticeText(missing: string, root: string): string {
  return `⟦OS-NOTICE⟧ This session's Operating System ${missing} was not found when your agent started, so you are running on the box default (${root}) — its commands and primer, not ${missing}'s. If you were testing ${missing}, stop and tell whoever started you.`;
}

export function primerNoticeText(reason: string, root: string): string {
  return `⟦OS-NOTICE⟧ Your Operating System primer did not load (${oneLine(reason)}). You are working without it. Load it now by running "${root}/Harnesses/shared/session-context.sh" and reading its output before you continue.`;
}

/** `atrium_os_primer_error`'s value: `<ISO-8601 UTC> <reason>`, one line, reason ≤ 200 chars. */
export function formatPrimerErrorStamp(reason: string, now: Date = new Date()): string {
  return `${now.toISOString()} ${oneLine(reason)}`;
}

/** The reason half of a stored `atrium_os_primer_error` (drops the leading timestamp). */
export function primerErrorReason(stamp: string): string {
  const space = stamp.indexOf(" ");
  return space === -1 ? stamp : stamp.slice(space + 1);
}
