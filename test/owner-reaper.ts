// Test-harness owner reaper (brick://113073b8).
//
// WHY THIS EXISTS. The suite spawns detached `__queue-owner` daemons far faster
// than they drain. There is no TTL reap: `--ttl` is only the idle-CHECK cadence
// (queue-owner-runtime.ts:619), and the sole deadline that ends an idle owner is
// `ACPX_OWNER_IDLE_RELEASE_MS` / `DEFAULT_OWNER_IDLE_RELEASE_MS` (30 min). A test
// asking for `--ttl 0.01` therefore buys a 30-minute process, and `--ttl 0` buys
// an immortal one. Measured 2026-08-20 on devbox: 93 -> 111 live owners in five
// minutes, 10.3 GB resident. The suite must reap what the suite spawned.
//
// THE SAFETY INVARIANT — the whole point of this module:
//
//   A process is killed only on a positive, EXACT match of ACPX_TEST_OWNER_TAG to
//   this run's own tag. Every other outcome — unreadable environ, absent variable,
//   different value, a cwd inside our worktree, a matching command line, a
//   /tmp/acpx-*-test-home-* HOME, a missing ACPX_SESSION_* — is NOT a match and
//   NOT a kill.
//
// Each rejected signal has already cost this cluster something: a lane found a
// DIFFERENT live session's runtime owner whose cwd happened to be that lane's own
// worktree, and a measured test owner carried the LAUNCHING agent's
// ACPX_SESSION_NAME. A leaked owner is a load problem; a wrongly-killed owner is
// another agent's lost work. `skipped_unreadable` is REPORTED, never acted on.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import { after } from "node:test";

/** Env var carrying the per-test-file-process tag. Deliberately NOT on `runCli`'s
 *  denylist, so it survives into CLI subprocesses and the owners they spawn. */
export const OWNER_TAG_ENV = "ACPX_TEST_OWNER_TAG";

/** Env var carrying the run-level tag, minted once by `scripts/run-tests.mjs`
 *  before `node --test` forks its file processes. */
export const RUN_TAG_ENV = "ACPX_TEST_OWNER_RUN_TAG";

const TAG_NAMESPACE = "acpxtest";
const LOG_PREFIX = "[acpx-test-reaper]";

export type SweepResult = {
  identified: number;
  killed: number;
  /** Candidates that exited on their own between identification and the kill.
   *  Keeps `identified === killed + vanished + failed` reconcilable. */
  vanished: number;
  survived: number;
  skippedUnreadable: number;
  identifiedPids: number[];
  survivingPids: number[];
  failures: string[];
};

/** How a candidate's `ACPX_TEST_OWNER_TAG=` environ entry must match.
 *  `exact` is the only form L1 uses. `runPrefix` is allowed ONLY for the
 *  run-level L2 backstop, whose prefix is the run-unique tag — still positive
 *  identification, still nothing else's. */
export type OwnerMatcher = { kind: "exact"; entry: string } | { kind: "runPrefix"; prefix: string };

export function exactTagMatcher(tag: string): OwnerMatcher {
  return { kind: "exact", entry: `${OWNER_TAG_ENV}=${tag}` };
}

export function runTagMatcher(runTag: string): OwnerMatcher {
  // The trailing "." is load-bearing: without it run tag "r1" would also match
  // every owner of run "r10".
  return { kind: "runPrefix", prefix: `${OWNER_TAG_ENV}=${TAG_NAMESPACE}.${sanitize(runTag)}.` };
}

function sanitize(value: string): string {
  // "." is the tag's field separator, so it must never survive inside a field —
  // otherwise a crafted/odd run tag could shift the L2 prefix boundary.
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** `acpxtest.<runTag>.<fileSlug>.<pid>.<rand>` — see CONCEPTION §"The tag".
 *  `<rand>` defeats PID recycling; `<pid>` alone must never be the discriminator.
 *  No field may contain "." (see `sanitize`), so the shape is exactly 5 fields. */
export function mintOwnerTag(): string {
  const runTag = sanitize(
    process.env[RUN_TAG_ENV] ?? process.env.NV_GATE_TAG ?? `p${String(process.ppid)}`,
  );
  const fileSlug = sanitize(basename(process.argv[1] ?? "unknown").replace(/\.(m|c)?[jt]s$/, ""));
  return `${TAG_NAMESPACE}.${runTag}.${fileSlug}.${String(process.pid)}.${randomBytes(3).toString("hex")}`;
}

/** The `<pid>` field of a tag, or null if the value is not a tag we minted.
 *  This is what makes an INHERITED tag distinguishable from an OWN one: a tag is
 *  deliberately inherited by children (that is how a `runCli` subprocess's owner
 *  ends up carrying its test file's tag), so a process that finds one in its env
 *  must NOT assume it minted it. */
export function tagMintingPid(tag: string): number | null {
  const fields = tag.split(".");
  if (fields.length !== 5 || fields[0] !== TAG_NAMESPACE) {
    return null;
  }
  const pid = Number(fields[3]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// ---------------------------------------------------------------------------
// /proc reads. Each returns null on ANY failure, and null NEVER means "match" —
// it means "unreadable ⇒ not mine", which is counted and reported.
// ---------------------------------------------------------------------------

/** `/proc/<pid>/environ` is NUL-separated. Split on "\0" and compare whole
 *  `KEY=VALUE` entries — never grep it as text (the box's grep is ugrep, where a
 *  `$` anywhere in the pattern anchors and silently returns 0 matches). */
function readEnvironEntries(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${String(pid)}/environ`, "utf8").split("\0");
  } catch {
    // Not swallowed: the caller counts this as skipped_unreadable and reports it.
    return null;
  }
}

function readExe(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${String(pid)}/exe`);
  } catch {
    return null;
  }
}

/** ppid (field 4) and pgrp (field 5) from `/proc/<pid>/stat`. Parsed from after
 *  the LAST ")" because the comm field can itself contain spaces and parens. */
function readStatIds(pid: number): { ppid: number; pgid: number } | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const fields = raw.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) {
    return null;
  }
  return { ppid, pgid };
}

/** Self + every ancestor. THE trap this closes: a sweeper's own tag is in its own
 *  argv and environ, so it finds itself, kills nothing, and a new pid appears next
 *  pass looking exactly like a respawn. One lane hit that twice before diagnosing it. */
function selfAndAncestors(): Set<number> {
  const pids = new Set<number>([process.pid]);
  let current = process.pid;
  for (let hops = 0; hops < 64 && current > 1; hops += 1) {
    const ids = readStatIds(current);
    if (ids === null || ids.ppid <= 0 || pids.has(ids.ppid)) {
      break;
    }
    pids.add(ids.ppid);
    current = ids.ppid;
  }
  return pids;
}

function listProcPids(): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (Number.isInteger(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return pids;
}

function environMatches(entries: string[], matcher: OwnerMatcher): boolean {
  for (const entry of entries) {
    if (matcher.kind === "exact" ? entry === matcher.entry : entry.startsWith(matcher.prefix)) {
      return true;
    }
  }
  return false;
}

export type Candidate = { pid: number; pgid: number };

export type IdentifyResult = { candidates: Candidate[]; skippedUnreadable: number };

/** The only place a kill target is ever chosen. */
export function identifyOwners(matcher: OwnerMatcher): IdentifyResult {
  const excluded = selfAndAncestors();
  const selfExe = readExe(process.pid);
  const candidates: Candidate[] = [];
  let skippedUnreadable = 0;

  for (const pid of listProcPids()) {
    if (excluded.has(pid)) {
      continue;
    }
    const exe = readExe(pid);
    if (exe === null) {
      // Unreadable ⇒ NOT mine. Counted, never acted on.
      skippedUnreadable += 1;
      continue;
    }
    // Narrow the blast radius to node processes (owners always are). The tag is
    // the discriminator; this is defence in depth, not the identification.
    if (basename(exe) !== "node" && exe !== selfExe) {
      continue;
    }
    const entries = readEnvironEntries(pid);
    if (entries === null) {
      skippedUnreadable += 1;
      continue;
    }
    if (!environMatches(entries, matcher)) {
      continue;
    }
    const ids = readStatIds(pid);
    if (ids === null) {
      skippedUnreadable += 1;
      continue;
    }
    candidates.push({ pid, pgid: ids.pgid });
  }

  return { candidates, skippedUnreadable };
}

/** Re-confirm the exact tag immediately before signalling. Closes the
 *  identify→kill PID-recycling window, whose consequence is killing an unrelated
 *  process. */
function stillMatches(candidate: Candidate, matcher: OwnerMatcher): boolean {
  const entries = readEnvironEntries(candidate.pid);
  if (entries === null) {
    return false;
  }
  const ids = readStatIds(candidate.pid);
  if (ids === null || ids.pgid !== candidate.pgid) {
    return false;
  }
  return environMatches(entries, matcher);
}

function signalCandidate(
  candidate: Candidate,
  signal: NodeJS.Signals,
  failures: string[],
): "sent" | "gone" | "failed" {
  // Group kill when — and ONLY when — the target is its own group leader. Owners
  // are spawned detached (queue-owner-process.ts:232) so pgid === pid, and
  // kill(-pid) also reaps the ACP adapter, where most of the ~287 MB sits.
  // A matched NON-leader (e.g. a still-running `runCli` child, which shares OUR
  // process group) is signalled by pid alone — never by group, which would take
  // down the test run itself.
  const target = candidate.pgid === candidate.pid ? -candidate.pid : candidate.pid;
  try {
    process.kill(target, signal);
    return "sent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return "gone";
    }
    failures.push(`pid=${String(candidate.pid)} ${signal} -> ${code ?? String(error)}`);
    return "failed";
  }
}

function sleepSync(ms: number): void {
  // Sync wait so the same code path works inside `process.on("exit")`, where no
  // async continuation can ever run.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type SweepOptions = {
  /** ms between SIGTERM and the survivor re-check. Signal delivery is
   *  asynchronous — an immediate re-check reports false survivors. */
  graceMs?: number;
  /** ms between SIGKILL and the final absence check. */
  settleMs?: number;
  label?: string;
  log?: (line: string) => void;
};

/** Identify → group-kill → VERIFY BY PROCESS ABSENCE. Never throws.
 *
 *  Verification re-runs identification: a dead pid has no `/proc/<pid>` and so
 *  cannot be identified. It is never inferred from a lease record, a freed port,
 *  or "the cleanup command ran clean" — a cleanup that finds nothing looks
 *  exactly like a cleanup that finished, and that silent-success shape is what
 *  hid this bug in `recoverQueueOwnerForSession`. */
export function sweepOwners(matcher: OwnerMatcher, options: SweepOptions = {}): SweepResult {
  const graceMs = options.graceMs ?? 400;
  const settleMs = options.settleMs ?? 400;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const label = options.label ?? "sweep";
  const failures: string[] = [];

  const first = identifyOwners(matcher);
  const identifiedPids = first.candidates.map((candidate) => candidate.pid);
  let killed = 0;
  let vanished = 0;

  if (first.candidates.length > 0) {
    for (const candidate of first.candidates) {
      // Exited on its own, or stopped being ours, between identification and
      // here. Counted, not killed — this is the ONLY reason `identified` may
      // exceed `killed`, and naming it is what keeps the log line reconcilable:
      // identified === killed + vanished + failed, always.
      if (!stillMatches(candidate, matcher)) {
        vanished += 1;
        continue;
      }
      const outcome = signalCandidate(candidate, "SIGTERM", failures);
      if (outcome === "sent") {
        killed += 1;
      } else if (outcome === "gone") {
        vanished += 1;
      }
    }
    sleepSync(graceMs);

    const afterTerm = identifyOwners(matcher);
    for (const candidate of afterTerm.candidates) {
      if (!stillMatches(candidate, matcher)) {
        continue;
      }
      signalCandidate(candidate, "SIGKILL", failures);
    }
    sleepSync(settleMs);
  }

  const final = identifyOwners(matcher);
  const survivingPids = final.candidates.map((candidate) => candidate.pid);

  const result: SweepResult = {
    identified: identifiedPids.length,
    killed,
    vanished,
    survived: survivingPids.length,
    skippedUnreadable: first.skippedUnreadable,
    identifiedPids,
    survivingPids,
    failures,
  };

  // Log loudly, ALWAYS — including on a zero-identified sweep. A silent reaper is
  // the failure mode. Every count needed to reconcile the sweep is on this one
  // line, so a reader never has to assume where a difference went.
  log(
    `${LOG_PREFIX} ${label} identified=${String(result.identified)} killed=${String(result.killed)} ` +
      `vanished=${String(result.vanished)} survived=${String(result.survived)} ` +
      `skipped_unreadable=${String(result.skippedUnreadable)}` +
      (result.identifiedPids.length > 0 ? ` pids=[${result.identifiedPids.join(",")}]` : "") +
      (result.survivingPids.length > 0 ? ` surviving=[${result.survivingPids.join(",")}]` : "") +
      (result.failures.length > 0 ? ` failures=[${result.failures.join("; ")}]` : ""),
  );
  if (
    result.survived > 0 ||
    result.killed + result.vanished + result.failures.length !== result.identified
  ) {
    log(
      `${LOG_PREFIX} ${label} MISMATCH — identified=${String(result.identified)} killed=${String(result.killed)} ` +
        `vanished=${String(result.vanished)} failed=${String(result.failures.length)} survived=${String(result.survived)}. ` +
        `Expected killed+vanished+failed == identified and survived == 0. ` +
        `This is a stop-and-investigate, not a pass.`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// L1 — per-test-file-process reap.
// ---------------------------------------------------------------------------

let installed = false;

/** Stamps this file process's unique tag into `process.env` at MODULE LOAD —
 *  before any test body runs, which is what guarantees every later spawn (in
 *  process, or through a `runCli` subprocess) inherits it — and registers the
 *  teardown reap.
 *
 *  Two hooks, because they fail differently: `after()` covers the normal end of
 *  a test file (and can await a real grace period); `process.on("exit")` covers a
 *  file that never reaches `after()` (an early `process.exit`, a bail). Neither
 *  can cover a file process that is SIGKILLed — that is what L2 exists for. */
export function installOwnerReaper(): string {
  const inherited = process.env[OWNER_TAG_ENV];
  // Reuse the tag ONLY if this very process minted it. An inherited tag (this
  // process is a child of another tagged process) must be replaced, or two file
  // processes would share one tag and each one's teardown would reap the other's
  // in-flight owners.
  const own =
    inherited !== undefined && tagMintingPid(inherited) === process.pid ? inherited : undefined;
  if (installed && own !== undefined) {
    return own;
  }
  const tag = own ?? mintOwnerTag();
  process.env[OWNER_TAG_ENV] = tag;

  if (installed) {
    return tag;
  }
  installed = true;

  const matcher = exactTagMatcher(tag);
  let swept = false;
  const runSweep = (label: string): void => {
    if (swept) {
      return;
    }
    swept = true;
    try {
      sweepOwners(matcher, { label: `L1 ${label} tag=${tag}` });
    } catch (error) {
      // Must never throw out of a teardown hook — but must never be silent either.
      process.stderr.write(`${LOG_PREFIX} L1 ${label} FAILED tag=${tag}: ${String(error)}\n`);
    }
  };

  after(() => {
    runSweep("after");
  });
  process.on("exit", () => {
    runSweep("exit");
  });

  return tag;
}
