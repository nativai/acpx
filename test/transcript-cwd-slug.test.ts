import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import {
  ensureTranscriptAtConfigDir,
  legacyTranscriptCwdHash,
  legacyTranscriptJsonlPath,
  resolveExistingTranscriptPath,
  transcriptCwdHash,
  transcriptJsonlPath,
} from "../src/config/subscription-transcript.js";

// ─────────────────────────────────────────────────────────────────────────────
// brick://ae715773 — acpx computed `projects/<slug>` with `cwd.replace(/\//g,"-")`,
// which maps the path separator and NOTHING ELSE. Claude Code maps every
// character outside [A-Za-z0-9-]. So for any cwd containing a `.` (every Nativai
// `.bare` worktree), acpx looked for a transcript at a path that CANNOT EXIST —
// the switch found no source, the port never ran, and the session went
// unpromptable.
//
// ⚠️ THE SPEC IS CLAUDE CODE'S OWN BEHAVIOUR, NOT ANY DESCRIPTION OF IT — this
// program has been burned twice by trusting a written description over the
// behaviour. The tests below therefore RUN A REAL CLAUDE CODE PROCESS in
// dot-bearing cwds under isolated HOMEs and read back the directory name it
// actually creates. Do not replace them with a hard-coded expectation table.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HOMEs for the live probes. Deliberately NOT under `os.tmpdir()`: these must
 * live outside /tmp, and they must never touch the real ~/.claude or ~/.acpx.
 */
const LIVE_HOME_ROOT = "/workspace/.acpx-transcript-slug-tests";

/** How long to wait for Claude Code to write its project dir before giving up. */
const LIVE_PROBE_TIMEOUT_MS = 30_000;

/**
 * One scratch dir for this whole run, reaped in `after`.
 *
 * Per-run rather than a shared fixed dir so a concurrent run (a test-engineer
 * verifying while the suite runs elsewhere) cannot delete our tree out from
 * under us — and reaped at all because these probes create a full Claude config
 * dir each, and unreaped scratch on the shared box is how /workspace fills.
 */
let runRoot: string | undefined;

async function liveRoot(): Promise<string> {
  if (!runRoot) {
    await fs.mkdir(LIVE_HOME_ROOT, { recursive: true });
    runRoot = await fs.mkdtemp(path.join(LIVE_HOME_ROOT, "run-"));
  }
  return runRoot;
}

after(async () => {
  // `runRoot` is captured from mkdtemp at creation time and never re-derived
  // from the environment — the deletion target can only ever be that literal
  // subtree.
  if (runRoot) {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

type LiveProbe = {
  /** The directory name Claude Code actually created under `projects/`. */
  observedDirName: string;
  /** The transcript JSONL Claude Code created inside it, if any. */
  observedJsonlName: string | undefined;
  configDir: string;
};

/** Deliberate, written-down opt-out for boxes with no Claude Code installed. */
const ALLOW_NO_CLAUDE_ENV = "ACPX_TEST_ALLOW_NO_CLAUDE";

let claudeBinaryChecked = false;
let claudeBinaryPresent = false;

async function hasClaudeBinary(): Promise<boolean> {
  if (claudeBinaryChecked) {
    return claudeBinaryPresent;
  }
  claudeBinaryChecked = true;
  claudeBinaryPresent = await new Promise<boolean>((resolve) => {
    const probe = spawn("claude", ["--version"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("exit", (code) => resolve(code === 0));
  });
  return claudeBinaryPresent;
}

/**
 * Gate for the live probes — a MISSING `claude` binary FAILS by default.
 *
 * ⚠️ DO NOT turn this back into an unconditional `t.skip()`. A skipped test is
 * green in the summary line, so `# fail 0` would then be able to mean "the only
 * tests pinning this derivation to reality never ran" — the vacuous-pass shape
 * this whole lane exists to prevent (brick://ae715773). The pre-merge gate runs
 * on a box where `claude` is present, so failing by default costs that gate
 * nothing and makes its green mean something.
 *
 * Running somewhere without Claude Code is still allowed — but as a conscious
 * act, not an accident: set `ACPX_TEST_ALLOW_NO_CLAUDE=1`. The skip then names
 * exactly which property went unobserved.
 */
async function requireClaudeBinary(t: TestContext, unverified: string): Promise<boolean> {
  if (await hasClaudeBinary()) {
    return true;
  }

  if (process.env[ALLOW_NO_CLAUDE_ENV] === "1") {
    process.stderr.write(
      `[acpx-test] UNVERIFIED: ${unverified} — the \`claude\` binary is absent and ` +
        `${ALLOW_NO_CLAUDE_ENV}=1 was set, so this property was NOT observed in this run.\n`,
    );
    t.skip(
      `SKIPPED BY EXPLICIT OPT-OUT (${ALLOW_NO_CLAUDE_ENV}=1) WITHOUT VERIFYING ANYTHING: ` +
        `${unverified} was not observed, because the \`claude\` binary is not on PATH.`,
    );
    return false;
  }

  // Thrown rather than `assert.fail`-ed so this function has an explicit exit on
  // every path (oxlint `consistent-return`); the observable behaviour — a failed
  // test carrying this message — is identical.
  throw new assert.AssertionError({
    message:
      `the \`claude\` binary is not on PATH, so ${unverified} could not be observed against ` +
      `Claude Code's real behaviour — which is the ONLY thing that makes this derivation ` +
      `trustworthy. This is a hard failure on purpose. If you genuinely intend to run this ` +
      `suite on a box without Claude Code, say so deliberately: ${ALLOW_NO_CLAUDE_ENV}=1.`,
  });
}

/**
 * Start a REAL Claude Code session in `cwd` under a throwaway isolated HOME and
 * return the directory name it creates under `<configDir>/projects/`.
 *
 * Claude Code writes that directory at STARTUP, before any API call, so a bogus
 * API key is enough — we never make a request, never need credentials, and never
 * read the caller's. We poll for the directory and kill the process the moment
 * it appears, which keeps each probe to a few seconds.
 */
async function observeClaudeProjectDir(cwd: string, label: string): Promise<LiveProbe> {
  const home = await fs.mkdtemp(path.join(await liveRoot(), `${label}-`));
  const configDir = path.join(home, ".claude");
  await fs.mkdir(cwd, { recursive: true });

  const child = spawn("claude", ["-p", "x"], {
    cwd,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "sk-ant-invalid-probe-key",
      CLAUDE_CONFIG_DIR: configDir,
      HOME: home,
    },
    stdio: "ignore",
  });

  const projectsDir = path.join(configDir, "projects");
  const deadline = Date.now() + LIVE_PROBE_TIMEOUT_MS;
  let observedDirName: string | undefined;
  let observedJsonlName: string | undefined;
  try {
    // Wait for the project dir AND the transcript inside it. The JSONL lands a
    // beat AFTER the directory, so stopping at the directory turns every
    // downstream transcript assertion into a race — which already produced one
    // false red ("no transcript written") that had nothing to do with the bug
    // under test.
    while (Date.now() < deadline) {
      const entries = await fs.readdir(projectsDir).catch(() => [] as string[]);
      if (entries.length > 0) {
        observedDirName = entries[0];
        const inner = await fs
          .readdir(path.join(projectsDir, observedDirName))
          .catch(() => [] as string[]);
        observedJsonlName = inner.find((name) => name.endsWith(".jsonl"));
        if (observedJsonlName) {
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    child.kill("SIGKILL");
  }

  assert.ok(
    observedDirName,
    `Claude Code created no directory under ${projectsDir} within ${LIVE_PROBE_TIMEOUT_MS}ms ` +
      `for cwd ${cwd} — the probe could not observe the spec, so nothing below is verified.`,
  );

  return { configDir, observedDirName, observedJsonlName };
}

/**
 * The cwd shapes that matter. `.bare` is the live fleet exposure; `v1.2.3` and
 * `.hidden` are the multi-dot / dot-leading cases the charter names; the
 * underscore case exists because the mapping turned out to be much broader than
 * "dots" and a dot-only fix would still be wrong; `plain` is the control that
 * must be unaffected.
 */
const LIVE_CASES: Array<{ dir: string; label: string; why: string }> = [
  { dir: ".bare", label: "dot-leading", why: "the live fleet exposure — every Nativai .bare repo" },
  { dir: "v1.2.3", label: "multi-dot", why: "several dots inside one segment" },
  { dir: ".hidden", label: "dot-hidden", why: "a second dot-leading shape" },
  { dir: "under_score", label: "underscore", why: "proves the rule is not dot-only" },
  { dir: "plain", label: "control", why: "no special characters — must be unchanged" },
];

for (const testCase of LIVE_CASES) {
  test(`GROUND TRUTH (live Claude Code): transcriptCwdHash matches the dir actually written for '${testCase.dir}' — ${testCase.why}`, async (t) => {
    if (
      !(await requireClaudeBinary(
        t,
        `that transcriptCwdHash matches the projects/ directory Claude Code really writes for a '${testCase.dir}' cwd`,
      ))
    ) {
      return;
    }

    const cwd = await fs
      .mkdtemp(path.join(await liveRoot(), "cwd-"))
      .then((base) => path.join(base, testCase.dir));

    const probe = await observeClaudeProjectDir(cwd, testCase.label);

    // THE assertion: our derivation must equal what Claude Code actually wrote.
    assert.equal(
      transcriptCwdHash(cwd),
      probe.observedDirName,
      `our slug for ${cwd} does not match the directory Claude Code created`,
    );
  });
}

test("GROUND TRUTH (live Claude Code): the LEGACY slug is what was broken — it does NOT match reality for a dotted cwd", async (t) => {
  if (
    !(await requireClaudeBinary(
      t,
      "that the PRE-FIX slug genuinely disagrees with reality for a dotted cwd (i.e. that this lane fixed a real bug)",
    ))
  ) {
    return;
  }

  const cwd = await fs
    .mkdtemp(path.join(await liveRoot(), "cwd-"))
    .then((base) => path.join(base, ".bare"));

  const probe = await observeClaudeProjectDir(cwd, "legacy-contrast");

  // This is the bug, stated as an executable fact rather than a comment: the
  // pre-fix derivation disagrees with observed reality, the new one agrees.
  assert.notEqual(
    legacyTranscriptCwdHash(cwd),
    probe.observedDirName,
    "the legacy slug matched reality — then this cwd shape never reproduced the bug and this test is not testing what it claims",
  );
  assert.equal(transcriptCwdHash(cwd), probe.observedDirName);
});

test("FEATURE GOAL (live, end-to-end): a real dotted-cwd session's transcript is FOUND and PORTED across a subscription switch", async (t) => {
  if (
    !(await requireClaudeBinary(
      t,
      "THE FEATURE'S GOAL — that a real dotted-cwd session's transcript survives a subscription switch instead of leaving the session unpromptable",
    ))
  ) {
    return;
  }

  const cwd = await fs
    .mkdtemp(path.join(await liveRoot(), "cwd-"))
    .then((base) => path.join(base, ".bare"));

  // 1. A REAL Claude Code session in a dotted cwd writes a REAL transcript,
  //    wherever Claude Code decides to put it. We never tell it where.
  const probe = await observeClaudeProjectDir(cwd, "e2e");
  assert.ok(
    probe.observedJsonlName,
    "Claude Code wrote no transcript JSONL — cannot exercise the port end-to-end",
  );
  const acpSessionId = probe.observedJsonlName.replace(/\.jsonl$/, "");
  const sourceJsonl = path.join(
    probe.configDir,
    "projects",
    probe.observedDirName,
    probe.observedJsonlName,
  );
  await fs.appendFile(
    sourceJsonl,
    `{"type":"assistant","timestamp":"2026-08-20T12:00:00.000Z","text":"real-session-marker"}\n`,
  );

  // 2. Switch this session onto a different subscription's config dir.
  const dstConfigDir = path.join(path.dirname(probe.configDir), "dst-subscription");
  const recovery = await ensureTranscriptAtConfigDir(
    { acpSessionId, acpx: {}, cwd },
    dstConfigDir,
    {
      homeDir: path.dirname(probe.configDir),
      registry: { subscriptions: [] },
      sourceConfigDirs: [probe.configDir],
    },
  );

  // 3. The outcome a real agent must get: the conversation came with it.
  assert.equal(
    recovery.status,
    "ported",
    `the switch did not port the transcript — this is the unpromptable-session bug. searched: ${recovery.searchedPaths.join(", ")}`,
  );

  // 4. And it landed where CLAUDE CODE will look for it on the target account —
  //    i.e. under the directory name Claude Code itself produces, read off the
  //    filesystem rather than recomputed here.
  const expected = path.join(
    dstConfigDir,
    "projects",
    probe.observedDirName,
    `${acpSessionId}.jsonl`,
  );
  assert.equal(recovery.activePath, expected);
  const ported = await fs.readFile(expected, "utf8");
  assert.match(ported, /real-session-marker/);
});

// ─── Rider 2: the fallback must not be able to mask a broken primary ─────────

// ─────────────────────────────────────────────────────────────────────────────
// The fleet's own exposure, with both slug forms written out as LITERALS.
//
// ⚠️ DO NOT replace these with calls to transcriptJsonlPath() /
// legacyTranscriptJsonlPath(). That is precisely what made the two tests below
// tautological: they wrote the fixture at transcriptJsonlPath() and then
// asserted the resolver found it there, so both sides derived from the SAME
// function and agreed by construction whatever it returned — they stayed GREEN
// under a deliberately corrupted primary derivation, proving only that the pipe
// was open. Building the fixture from a literal is what gives them teeth.
//
// Both values are observations: `.bare` → double hyphen is the RCA's measured
// fleet evidence and GROUND-TRUTH.md batch 1 case 2.
// ─────────────────────────────────────────────────────────────────────────────
const DOTTED_CWD = "/workspace/projects/acpx-ui/.bare";
const DOTTED_PRIMARY_SLUG = "-workspace-projects-acpx-ui--bare";
const DOTTED_LEGACY_SLUG = "-workspace-projects-acpx-ui-.bare";

function literalJsonlPath(configDir: string, slug: string, acpSessionId: string): string {
  return path.join(configDir, "projects", slug, `${acpSessionId}.jsonl`);
}

test("PRIMARY carries new sessions: a primary-only transcript resolves, and the legacy path is NOT consulted for it", async () => {
  const root = await fs.mkdtemp(path.join(await liveRoot(), "primary-only-"));
  const configDir = path.join(root, "cfg");
  const acpSessionId = "11111111-2222-3333-4444-555555555555";

  // Written ONLY at the primary path — exactly what a NEW session produces —
  // and placed there by LITERAL slug, not by the function under test.
  const primary = literalJsonlPath(configDir, DOTTED_PRIMARY_SLUG, acpSessionId);
  await fs.mkdir(path.dirname(primary), { recursive: true });
  await fs.writeFile(primary, `{"type":"user","timestamp":"2026-08-20T10:00:00.000Z"}\n`);

  // The legacy location is deliberately EMPTY, so the fallback cannot rescue a
  // wrong primary derivation. If transcriptCwdHash computed anything other than
  // DOTTED_PRIMARY_SLUG, the resolver would look somewhere no file exists and
  // this test would go red — which is the whole point of it.
  const legacy = literalJsonlPath(configDir, DOTTED_LEGACY_SLUG, acpSessionId);
  assert.notEqual(legacy, primary, "this cwd must exercise a differing legacy form");
  await assert.rejects(() => fs.access(legacy));

  const resolved = await resolveExistingTranscriptPath(configDir, DOTTED_CWD, acpSessionId);
  assert.equal(resolved?.form, "primary", "the primary derivation did not find the real file");
  assert.equal(resolved?.path, primary);
});

test("the fallback CANNOT rescue a wrong primary: with only a primary-form file present, a legacy-form lookup finds nothing", async () => {
  const root = await fs.mkdtemp(path.join(await liveRoot(), "no-rescue-"));
  const configDir = path.join(root, "cfg");
  const acpSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  // Again by LITERAL slug: the ONLY file on disk sits where Claude Code really
  // puts it, so a resolution can only succeed if our primary derivation agrees
  // with Claude Code — the fallback has nothing to serve.
  const primary = literalJsonlPath(configDir, DOTTED_PRIMARY_SLUG, acpSessionId);
  await fs.mkdir(path.dirname(primary), { recursive: true });
  await fs.writeFile(primary, `{"type":"user","timestamp":"2026-08-20T10:00:00.000Z"}\n`);

  const resolved = await resolveExistingTranscriptPath(configDir, DOTTED_CWD, acpSessionId);
  assert.equal(resolved?.form, "primary", "the primary derivation did not find the real file");
  assert.equal(resolved?.path, primary);

  // A DIFFERENT dotted cwd must not resolve to this file under either form.
  const missing = await resolveExistingTranscriptPath(
    configDir,
    "/workspace/projects/acpx-ui/.other",
    acpSessionId,
  );
  assert.equal(missing, undefined, "a different dotted cwd must not resolve to this file");
});

// ─── Rider 1: the fallback is observable ────────────────────────────────────

test("a legacy-slug hit is LOGGED, and the transcript is migrated onto the primary path", async () => {
  const root = await fs.mkdtemp(path.join(await liveRoot(), "legacy-hit-"));
  const srcConfigDir = path.join(root, "src");
  const dstConfigDir = path.join(root, "dst");
  const cwd = "/workspace/projects/acpx-ui/.bare";
  const acpSessionId = "99999999-8888-7777-6666-555555555555";

  // A session stranded under the PRE-FIX name — what the fleet already has.
  const legacy = legacyTranscriptJsonlPath(srcConfigDir, cwd, acpSessionId);
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  await fs.writeFile(
    legacy,
    `{"type":"assistant","timestamp":"2026-08-20T11:00:00.000Z","text":"stranded"}\n`,
  );

  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let recovery: Awaited<ReturnType<typeof ensureTranscriptAtConfigDir>>;
  try {
    recovery = await ensureTranscriptAtConfigDir({ acpSessionId, acpx: {}, cwd }, dstConfigDir, {
      homeDir: root,
      registry: { subscriptions: [] },
      sourceConfigDirs: [srcConfigDir],
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(recovery.status, "ported", "a stranded legacy transcript must still be recovered");

  // Migration, not a second permanent home: the destination is the PRIMARY form.
  assert.equal(recovery.activePath, transcriptJsonlPath(dstConfigDir, cwd, acpSessionId));
  const ported = await fs.readFile(recovery.activePath, "utf8");
  assert.match(ported, /stranded/);

  // Rider 1 — a silent fallback becomes permanent. It must announce itself.
  const output = written.join("");
  assert.match(
    output,
    /transcript-slug-legacy-hit/,
    "a legacy-only resolution must be logged, or migration progress is unmeasurable and this fallback can never be removed",
  );
  assert.match(output, new RegExp(acpSessionId));
  assert.match(
    output,
    /srcSlugForm=legacy/,
    "the port decision line must record which form served it",
  );
});

test("no legacy breadcrumb is emitted when the primary form served the lookup", async () => {
  const root = await fs.mkdtemp(path.join(await liveRoot(), "no-breadcrumb-"));
  const srcConfigDir = path.join(root, "src");
  const dstConfigDir = path.join(root, "dst");
  const cwd = "/workspace/projects/acpx-ui/.bare";
  const acpSessionId = "12121212-3434-5656-7878-909090909090";

  const primary = transcriptJsonlPath(srcConfigDir, cwd, acpSessionId);
  await fs.mkdir(path.dirname(primary), { recursive: true });
  await fs.writeFile(primary, `{"type":"assistant","timestamp":"2026-08-20T11:00:00.000Z"}\n`);

  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await ensureTranscriptAtConfigDir({ acpSessionId, acpx: {}, cwd }, dstConfigDir, {
      homeDir: root,
      registry: { subscriptions: [] },
      sourceConfigDirs: [srcConfigDir],
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  const output = written.join("");
  assert.doesNotMatch(
    output,
    /transcript-slug-legacy-hit/,
    "a primary-served lookup must stay quiet, or the breadcrumb cannot measure migration",
  );
  assert.match(output, /srcSlugForm=primary/);
});

// ─── The 200-char truncation branch ─────────────────────────────────────────

// ─── The OBSERVED printable-ASCII population ────────────────────────────────
//
// These two strings ARE the spec's character classes, copied from
// verification/GROUND-TRUTH.md BATCH 5 — which probed every printable-ASCII
// character with its own dedicated cwd (`a<char>b`) and read back the directory
// Claude Code actually created.
//
// ⚠️ Do NOT hand-edit these to match a change you made to the regex. They are
// observations, not preferences. If you believe one is wrong, re-run
// verification/probe-ascii.sh and change GROUND-TRUTH.md first.
//
// Why a POPULATION and not a handful of examples: sampling closes instances,
// not the class. An independent test-engineer added ONE character to the
// preserved set (`[^a-zA-Z0-9-]` -> `[^a-zA-Z0-9-~]`) and the entire 270-test
// suite stayed green, because 29 characters observed to be replaced were
// asserted nowhere. Every character below is now pinned in both directions.

/** 30 chars Claude Code REPLACES with a single `-` (GROUND-TRUTH.md batch 5). */
const OBSERVED_REPLACED = " !\"#$%&'()*+,.:;<=>?@[]^_`{|}~";

/** 63 chars Claude Code PRESERVES verbatim (GROUND-TRUTH.md batch 5). */
const OBSERVED_PRESERVED = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * `/` is observed structurally (it is the separator — every case in every batch
 * shows it becoming `-`), and `\` is UNOBSERVABLE: Claude Code refuses to start
 * in a backslash-bearing cwd, exiting with `Can't access working directory`.
 * We therefore assert nothing about `\` — predicting it would be exactly the
 * "assert against a description instead of behaviour" trap this lane exists to
 * avoid.
 */
const NOT_IN_POPULATION = "/\\";

test("the observed population COVERS every printable-ASCII character — the table cannot be quietly shrunk", () => {
  // This is the structural guard on the two tables above. Deleting a character
  // from either one to make a broken regex pass would fail HERE, because the
  // union must still account for all 95 printable-ASCII code points.
  // `.split("")` rather than spread: it splits by UTF-16 CODE UNIT, which is the
  // unit this derivation works in (and it satisfies oxlint's `no-misused-spread`,
  // which objects to code-point iteration of strings — the very distinction the
  // no-/u test below pins).
  const accounted = new Set(
    OBSERVED_REPLACED.split("")
      .concat(OBSERVED_PRESERVED.split(""))
      .concat(NOT_IN_POPULATION.split("")),
  );
  const missing: string[] = [];
  for (let code = 0x20; code <= 0x7e; code++) {
    const ch = String.fromCharCode(code);
    if (!accounted.has(ch)) {
      missing.push(JSON.stringify(ch));
    }
  }
  assert.deepEqual(missing, [], "printable-ASCII characters accounted for by no table");
  assert.equal(accounted.size, 95, "a character is listed in more than one table");
  assert.equal(OBSERVED_REPLACED.length, 30);
  assert.equal(OBSERVED_PRESERVED.length, 63);
});

for (const ch of OBSERVED_REPLACED.split("")) {
  test(`observed population: ${JSON.stringify(ch)} (U+${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}) is REPLACED by a single dash`, () => {
    assert.equal(
      transcriptCwdHash(`/w/a${ch}b`),
      "-w-a-b",
      `Claude Code replaces ${JSON.stringify(ch)} (GROUND-TRUTH.md batch 5); our derivation must too`,
    );
  });
}

for (const ch of OBSERVED_PRESERVED.split("")) {
  test(`observed population: ${JSON.stringify(ch)} (U+${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}) is PRESERVED verbatim`, () => {
    assert.equal(
      transcriptCwdHash(`/w/a${ch}b`),
      `-w-a${ch}b`,
      `Claude Code preserves ${JSON.stringify(ch)} (GROUND-TRUTH.md batch 5); our derivation must too`,
    );
  });
}

test("the substitution runs per UTF-16 CODE UNIT, not per code point — the derivation must NOT carry the /u flag", () => {
  // ⚠️ DO NOT "modernise" transcriptCwdHash's regex by adding the /u flag, and
  // DO NOT swap the ASCII class for \p{L} or a unicode-aware \w. Both look like
  // improvements and both are the bug: /u iterates CODE POINTS, so a
  // supplementary-plane character would yield ONE hyphen instead of two, and a
  // \p{L} class would PRESERVE non-ASCII letters instead of replacing them.
  // Either change silently breaks every affected cwd — and, without the
  // assertions below, passes the entire rest of this suite green.
  //
  // These are OBSERVED facts, not invented ones: verification/GROUND-TRUTH.md
  // cases 28-32, from real Claude Code sessions in these cwd shapes.

  // Case 32: U+1F680 is ONE code point but TWO UTF-16 code units, and Claude
  // Code emitted TWO hyphens. This single assertion is what pins "no /u".
  assert.equal(transcriptCwdHash("/w/emoji\u{1F680}x"), "-w-emoji--x");

  // Cases 28-29: non-ASCII LETTERS are replaced, one hyphen each — never kept.
  assert.equal(transcriptCwdHash("/w/café"), "-w-caf-");
  assert.equal(transcriptCwdHash("/w/müller"), "-w-m-ller");

  // Case 30: three CJK characters produce three hyphens.
  assert.equal(transcriptCwdHash("/w/日本語"), "-w----");
});

test("the slug is truncated at 200 chars with a hash suffix, exactly as Claude Code does", () => {
  const short = "/workspace/projects/acpx/main";
  assert.equal(transcriptCwdHash(short).length, short.length);

  const long = `/workspace/${"a".repeat(150)}/${"b".repeat(150)}`;
  const slug = transcriptCwdHash(long);
  assert.ok(long.length > 200, "fixture must actually exceed the cap");
  assert.equal(slug.slice(0, 200), long.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 200));
  assert.equal(slug[200], "-");
  assert.match(slug.slice(201), /^[0-9a-z]+$/, "suffix must be base-36");

  // Distinct long paths sharing a 200-char prefix must NOT collide.
  const sibling = `${long}/different`;
  assert.notEqual(transcriptCwdHash(long), transcriptCwdHash(sibling));
});

test("searchedPaths names BOTH slug forms, so a miss is diagnosable", async () => {
  const root = await fs.mkdtemp(path.join(await liveRoot(), "searched-"));
  const cwd = "/workspace/projects/acpx-ui/.bare";
  const acpSessionId = "abababab-cdcd-efef-0101-232323232323";

  const recovery = await ensureTranscriptAtConfigDir(
    { acpSessionId, acpx: {}, cwd },
    path.join(root, "dst"),
    {
      homeDir: root,
      registry: { subscriptions: [] },
      sourceConfigDirs: [path.join(root, "src")],
    },
  );

  assert.equal(recovery.status, "missing");
  const searched = recovery.searchedPaths.join(", ");
  assert.match(searched, /--bare/, "the primary (Claude-Code-correct) form must be searched");
  assert.match(searched, /-\.bare/, "the legacy form must be searched too");
});
