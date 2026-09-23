import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
// NOTE: `transcriptJsonlPath` / `legacyTranscriptJsonlPath` are deliberately NOT
// imported here. Every path this file asserts on is built from a LITERAL slug
// (see the DOTTED_* block below) — importing the path builders is what let three
// separate tests assert only self-consistency. Keeping them out of scope makes
// the tautology hard to reintroduce by accident.
import {
  ensureTranscriptAtConfigDir,
  resolveExistingTranscriptPath,
  transcriptCwdHash,
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
// behaviour.
//
// 🛑 AND AS OF 2026-09-23 THIS FILE NO LONGER OBSERVES THAT BEHAVIOUR. The tests
// that ran a real Claude Code process were DELETED on Daniel's explicit
// instruction, to take the `claude` binary off the merge path — see the block
// further down that stands where they were, and brick://37c0108a. What remains
// is exactly the hard-coded expectation table their own comment warned against
// accepting as a substitute: it pins the derivation to GROUND-TRUTH.md and stops
// OUR side drifting, and it cannot notice CLAUDE CODE'S side drifting. Read the
// deletion note before adding anything here that assumes otherwise.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HOMEs for the live probes. Deliberately NOT under `os.tmpdir()`: these must
 * live outside /tmp, and they must never touch the real ~/.claude or ~/.acpx.
 */
const LIVE_HOME_ROOT = "/workspace/.acpx-transcript-slug-tests";

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
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ DELETED 2026-09-23: SEVEN LIVE-PROBE TESTS THAT USED TO STAND HERE.
//
// This is a DELIBERATE TRADE, not a cleanup, and it runs against the standing
// rule ("a red is REPAIRED; deletion is only for a test that provably guards
// nothing"). These tests guarded something real. Daniel overruled the rule
// explicitly, to take the `claude` binary off the merge path. Recorded here so
// that the cost is legible later, because the failure it leaves uncovered is
// SILENT.
//
// WHAT THEY WERE. Five `GROUND TRUTH (live Claude Code)` rows (cwd shapes
// `.bare`, `v1.2.3`, `.hidden`, `under_score`, `plain`), one `GROUND TRUTH`
// legacy-contrast row, and one `FEATURE GOAL (live, end-to-end)` row. Each
// spawned a REAL Claude Code process in a dot-bearing cwd under a throwaway
// isolated HOME and read back the directory name it actually created under
// `projects/`. No credentials were involved: Claude Code writes that directory
// at STARTUP, before any API call.
//
// WHAT THEY GUARDED (brick://ae715773). acpx built the transcript directory with
// `cwd.replace(/\//g, "-")` — mapping the path separator and NOTHING ELSE —
// while Claude Code maps every character outside [A-Za-z0-9-]. So for any cwd
// containing a `.` — i.e. EVERY Nativai `.bare` worktree — acpx looked for a
// transcript at a path that CANNOT EXIST. The subscription switch found no
// source, the port never ran, and THE SESSION WENT UNPROMPTABLE.
//
// WHY THEY WERE LIVE PROBES RATHER THAN A TABLE. The file's own header said it,
// and it is still true: "THE SPEC IS CLAUDE CODE'S OWN BEHAVIOUR, NOT ANY
// DESCRIPTION OF IT — this program has been burned twice by trusting a written
// description over the behaviour." A table encodes what we believe today; the
// probes encoded what Claude Code actually does.
//
// 🛑 WHAT IS NOW UNCOVERED. **A change by Claude Code to its project-directory
// slug algorithm will not be detected by any test in this repo.** Nothing here
// observes the real binary any more. The symptom would be sessions becoming
// UNPROMPTABLE after a subscription switch, and no test failure will point at
// the cause — the derivation below will keep agreeing with itself while
// disagreeing with reality, which is exactly the shape of the original bug.
//
// If you are debugging that symptom: compare `transcriptCwdHash(cwd)` against
// the directory a real `claude` actually creates under `<configDir>/projects/`.
// That one comparison is what these seven tests did automatically.
//
// WHAT SURVIVES, and what it does NOT prove: the character-table tests below
// (printable-ASCII coverage, the UTF-16 code-unit rule, the 200-char truncation)
// still pin the derivation to the table recorded in GROUND-TRUTH.md. They keep
// the algorithm from drifting on OUR side. They CANNOT notice Claude Code
// drifting on THEIRS — that is precisely the half that was deleted.
//
// DECISION AND OWNER: deleted on Daniel's explicit instruction, 2026-09-23, to
// remove the `claude` binary from the merge path. The alternative — installing
// `claude` on the workbench image — was staged and fully measured (the same
// seven rows: 7 FAIL without the binary, 108 pass / 0 fail / 0 skipped with it)
// and CANCELLED in favour of this deletion. See brick://37c0108a.
// ─────────────────────────────────────────────────────────────────────────────
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
  const acpSessionId = "99999999-8888-7777-6666-555555555555";

  // A session stranded under the PRE-FIX name — what the fleet already has —
  // placed by LITERAL slug. Deriving this from legacyTranscriptJsonlPath() made
  // the test tautological: it filed the fixture wherever that function said and
  // then found it there, so gutting `legacyTranscriptCwdHash` to `return "nope"`
  // left it GREEN (it happily used `projects/nope/`). Rider 1's own test could
  // not detect a broken legacy derivation.
  const legacy = literalJsonlPath(srcConfigDir, DOTTED_LEGACY_SLUG, acpSessionId);
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
    recovery = await ensureTranscriptAtConfigDir(
      { acpSessionId, acpx: {}, cwd: DOTTED_CWD },
      dstConfigDir,
      {
        homeDir: root,
        registry: { subscriptions: [] },
        sourceConfigDirs: [srcConfigDir],
      },
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(recovery.status, "ported", "a stranded legacy transcript must still be recovered");
  assert.equal(recovery.sourcePath, legacy, "it must have been the LEGACY file that was recovered");

  // Migration, not a second permanent home: the destination is the PRIMARY form.
  assert.equal(
    recovery.activePath,
    literalJsonlPath(dstConfigDir, DOTTED_PRIMARY_SLUG, acpSessionId),
    "the port must land on the slug Claude Code actually reads",
  );
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
  const acpSessionId = "12121212-3434-5656-7878-909090909090";

  // LITERAL slug again — see the DOTTED_* block above for why.
  const primary = literalJsonlPath(srcConfigDir, DOTTED_PRIMARY_SLUG, acpSessionId);
  await fs.mkdir(path.dirname(primary), { recursive: true });
  await fs.writeFile(primary, `{"type":"assistant","timestamp":"2026-08-20T11:00:00.000Z"}\n`);

  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await ensureTranscriptAtConfigDir({ acpSessionId, acpx: {}, cwd: DOTTED_CWD }, dstConfigDir, {
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
  // OBSERVED pair, GROUND-TRUTH.md batch 4: a real Claude Code session in this
  // 227-char cwd created exactly this 207-char directory (200 + "-" + 6-char
  // base-36 hash of the ORIGINAL cwd).
  //
  // ⚠️ The expectation is a LITERAL, deliberately. It used to recompute the
  // expected prefix with its own copy of `.replace(/[^a-zA-Z0-9-]/g,"-")`, which
  // is the same self-consistency trap that made three other tests in this file
  // unable to fail — and it would also have accepted ANY hash suffix, since it
  // only checked that the tail matched /^[0-9a-z]+$/. The literal pins the hash
  // function too.
  const observedCwd = `/workspace/f1-probe/long/${"a".repeat(100)}.${"a".repeat(100)}x`;
  const observedSlug = `-workspace-f1-probe-long-${"a".repeat(100)}-${"a".repeat(74)}-pw3dhh`;

  assert.equal(observedCwd.length, 227, "fixture drifted from the observed cwd");
  assert.equal(observedSlug.length, 207, "fixture drifted from the observed slug");
  assert.equal(transcriptCwdHash(observedCwd), observedSlug);

  // Below the cap, the slug is the substitution and nothing else.
  assert.equal(transcriptCwdHash("/workspace/projects/acpx/main"), "-workspace-projects-acpx-main");

  // Distinct long paths sharing a 200-char prefix must NOT collide — the whole
  // point of appending a hash rather than plain truncation.
  assert.notEqual(
    transcriptCwdHash(observedCwd),
    transcriptCwdHash(`${observedCwd}/different`),
    "two cwds sharing a 200-char prefix must not collide",
  );
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
