import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_FACTS,
  HARNESS_IDS,
  type HarnessAdapterIdentity,
  type HarnessCapabilityFacts,
} from "../src/acp/harness-capabilities.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// 4791a88c — every capability claim cites the ADAPTER BUILD it was proven on.
//
// ⚠️ WHY THAT IS A DEFECT AND NOT UNTIDINESS. pi's `session/set_model` was REAL
// in pi-acp 0.0.26 and GONE in 0.0.33, while the descriptor's comment said
// "proven three ways" with no version. A claim with no build cannot be shown to
// have EXPIRED, so it cannot be checked at all — a belief wearing the clothes of
// a measurement.
//
// ## ⚠️ THIS FILE HAS ALREADY BEEN WRONG ONCE, IN THE SAME WAY THE BRICK IS ABOUT
//
// Its predecessor guarded the citation with
// `assert.match(adapter, /(\d+\.\d+\.\d+|commit\s+[0-9a-f]{7,})/)` under the
// heading *"a citation names a VERSION or a COMMIT, not just a package"*.
// Measured by EXECUTING it: that regex REJECTS `"pi-acp"` and **PASSES
// `"pi-acp@^0.0.33"`** — the exact value the brick exists to reject, because the
// nativai fork and upstream both publish 0.0.33. It caught one level and stopped
// one short of the next, which is also how J1 failed: a prose comment beside the
// field, and a prose comment is not the field a checker reads.
//
// ⇒ **The regex is DELETED, not tightened.** `HarnessAdapterIdentity` is a
// discriminated union whose ambiguous arm REQUIRES `cannotDistinguish`, so the
// bad shape is a COMPILE error and these rows guard the parts a type cannot:
// non-emptiness, agreement with the registry, and per-cell honesty.
//
// ⚠️ A citation still names a MEASUREMENT, never a belief. These rows check that
// a citation exists, is well-formed, and cannot silently drift from the pin it
// claims. They cannot check that a human wrote a TRUE one — the closest available
// proxy is the re-derivability row at the bottom, and that limit is stated rather
// than papered over.

/** Every problem the citation contract can detect in one block. */
function citationProblems(id: string, facts: HarnessCapabilityFacts): string[] {
  const problems: string[] = [];
  const cited = facts.measuredAgainst;
  if (!cited) {
    return [`${id}: no measuredAgainst at all`];
  }
  if (!cited.source?.trim()) {
    problems.push(`${id}: cites no re-derivation source`);
  }
  problems.push(...identityProblems(`${id}.adapter`, cited.adapter));
  for (const [path, override] of Object.entries(cited.cellOverrides ?? {})) {
    problems.push(...identityProblems(`${id}.cellOverrides["${path}"]`, override));
    // ⚠️ AN ORPHAN KEY IS THE FAILURE MODE A STRING-KEYED MAP INVITES: rename the
    // cell, and the override silently describes nothing while still reading as
    // coverage. Resolve every key against the block itself.
    if (resolvePath(facts, path) === undefined) {
      problems.push(
        `${id}: cellOverrides key "${path}" names no cell in this block — renamed or removed?`,
      );
    }
    // An override equal to its block is dead weight that goes stale silently.
    if (JSON.stringify(override) === JSON.stringify(cited.adapter)) {
      problems.push(
        `${id}: cellOverrides["${path}"] is identical to the block citation — delete it, do not keep it`,
      );
    }
  }
  return problems;
}

function identityProblems(where: string, identity: HarnessAdapterIdentity): string[] {
  if (identity.kind === "resolved-commit") {
    return [
      ...(identity.spec.trim() ? [] : [`${where}: resolved-commit with an empty spec`]),
      ...(identity.commit.trim() ? [] : [`${where}: resolved-commit with no commit`]),
    ];
  }
  if (identity.kind === "package-range") {
    return [
      ...(identity.spec.trim() ? [] : [`${where}: package-range with an empty spec`]),
      // THE FIELD THE OLD REGEX COULD NOT ASK FOR.
      ...(identity.cannotDistinguish.trim()
        ? []
        : [`${where}: package-range must say what its spec CANNOT distinguish`]),
    ];
  }
  return identity.reason.startsWith("not measured:")
    ? []
    : [`${where}: a not-measured reason must begin "not measured:" — the file's own vocabulary`];
}

/** Resolve a dotted path like `model.mechanism` against a block. */
function resolvePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

test("4791a88c: every described harness carries a well-formed citation", () => {
  // ⚠️ POPULATION FIRST — an empty HARNESS_IDS would satisfy this vacuously and
  // read exactly like a fully-cited table.
  assert.ok(HARNESS_IDS.length > 0, "no harnesses were examined at all");
  const problems = HARNESS_IDS.flatMap((id) => citationProblems(id, HARNESS_FACTS[id]));
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("4791a88c: the checker DISCOVERS its subjects — a planted sixth block is caught", () => {
  // ⚠️ THE COVERAGE PROOF, AND IT IS WHY THIS FILE ITERATES RATHER THAN LISTS.
  // A hand-maintained list of five ids passes its own violation: a sixth harness
  // added with no citation is invisible to it. So a FRESH SUBJECT is planted here
  // and must be flagged without being registered anywhere.
  //
  // It is built by spreading a REAL block so it is a genuine
  // `HarnessCapabilityFacts` rather than a shape that only resembles one.
  const planted: HarnessCapabilityFacts = {
    ...HARNESS_FACTS.pi,
    measuredAgainst: {
      // The exact defect the old regex green-lit: a range that never says what it
      // cannot separate.
      //
      // ⚠️ NOTE WHAT THE TYPE CAN AND CANNOT DO, because it is the reason this row
      // exists at all. The union makes OMITTING `cannotDistinguish` a compile
      // error — that half needs no test. It cannot make an EMPTY one an error, so
      // emptiness is exactly the residue a runtime check must cover, and this
      // planted block is what proves the check covers it.
      adapter: { kind: "package-range", spec: "pi-acp@^0.0.33", cannotDistinguish: "" },
      source: "",
    },
  };
  const problems = citationProblems("planted", planted);
  assert.ok(
    problems.some((p) => p.includes("CANNOT distinguish")),
    `the planted bare range was not flagged; problems were: ${JSON.stringify(problems)}`,
  );
  assert.ok(
    problems.some((p) => p.includes("re-derivation source")),
    `the planted empty source was not flagged; problems were: ${JSON.stringify(problems)}`,
  );
  // CONTROL: the same helper must return CLEAN on a real block, or "it flags
  // everything" would satisfy the row above vacuously.
  assert.deepEqual(citationProblems("pi", HARNESS_FACTS.pi), []);
});

test("4791a88c: a cited PIN cannot drift from AGENT_REGISTRY — on EITHER launch form", () => {
  // ⚠️ THE ANTI-DRIFT ROW, AND IT WAS ONE DEPLOYMENT FROM GOING SILENT.
  //
  // It used to match only `npx <spec>`. But `resolvePiAcpCommand` returns
  // `node /opt/pi-acp/dist/index.js` once the fork is installed — so the moment
  // B5's bootstrap lands, pi would have dropped out of the checked set entirely,
  // on exactly the harness whose identity is ambiguous and exactly when the fork
  // makes it matter. **It failed toward SILENCE, and the population guard could
  // not see it: `pinned.length > 0` stays true on opencode alone, so coverage
  // would halve with every row green.**
  //
  // ⇒ Both launch forms are classified, and installing the fork now TIGHTENS the
  // check (a resolved path demands a resolved-commit citation) instead of
  // removing it.
  const npxPinned: { id: string; spec: string }[] = [];
  const resolvedPath: { id: string; path: string }[] = [];
  for (const id of HARNESS_IDS) {
    const command = AGENT_REGISTRY[id] ?? "";
    const npx = /\bnpx\s+(?:-y\s+)?((?:@[^\s/]+\/)?[^\s@]+@[^\s]+)/.exec(command);
    if (npx) {
      npxPinned.push({ id, spec: npx[1] });
      continue;
    }
    const local = /\bnode\s+(\/\S+)/.exec(command);
    if (local) {
      resolvedPath.push({ id, path: local[1] });
    }
  }
  assert.ok(
    npxPinned.length + resolvedPath.length > 0,
    "no harness classified as either npx-pinned or resolved-path — the matcher is broken",
  );

  for (const { id, spec } of npxPinned) {
    const cited = HARNESS_FACTS[id as (typeof HARNESS_IDS)[number]].measuredAgainst.adapter;
    assert.equal(
      cited.kind,
      "package-range",
      `${id} is launched from an npx pin, so its citation must be a package-range naming that spec`,
    );
    assert.equal(
      cited.kind === "package-range" ? cited.spec : "",
      spec,
      `${id}: the registry launches "${spec}" but the claims cite a different spec`,
    );
  }

  for (const { id, path } of resolvedPath) {
    const cited = HARNESS_FACTS[id as (typeof HARNESS_IDS)[number]].measuredAgainst.adapter;
    assert.equal(
      cited.kind,
      "resolved-commit",
      `${id} is launched from a resolved path (${path}), so a package-range citation is STALE — ` +
        `the build is now identifiable and the citation must name its commit`,
    );
  }
});

test("4791a88c: the two harnesses whose adapter and CLI move apart cite both", () => {
  // pi-acp is not pi, and codex-acp is not the codex CLI. Two things that go
  // stale independently must both be named, or one moves while the citation
  // still looks current. (claude/claude-pty/opencode are single artifacts, so
  // `harness` is legitimately absent there — asserted, not assumed.)
  assert.ok(HARNESS_FACTS.pi.measuredAgainst.harness, "pi cites no underlying pi version");
  assert.ok(HARNESS_FACTS.codex.measuredAgainst.harness, "codex cites no underlying codex CLI");
  for (const id of ["claude", "claude-pty", "opencode"] as const) {
    assert.equal(
      HARNESS_FACTS[id].measuredAgainst.harness,
      undefined,
      `${id} gained an underlying-harness citation — is it really two artifacts?`,
    );
  }
});

test("4791a88c: pi's fork-dependent cells cite the FORK, not the block's upstream pin", () => {
  // ⚠️ J1, AS A FIELD RATHER THAN A COMMENT. pi's block cites what acpx RESOLVES
  // (upstream), while these five cells were proven on the nativai FORK and are
  // FALSE upstream — measured in one run, both arms, the resolved adapter command
  // printed first. A block-level citation over cells that differ from it is
  // "right by accident and wrong by intent".
  //
  // ⚠️ THIS ROW NAMES ITS OWN EXIT CONDITION so it reads as a contract rather than
  // an obstacle: when a box installs the fork, the BLOCK citation becomes a
  // resolved-commit naming it (the anti-drift row above forces that), and these
  // overrides then describe the SAME build as their block — at which point the
  // "identical to the block" check will demand they be DELETED. That is the
  // intended end state, not a regression.
  const overrides = HARNESS_FACTS.pi.measuredAgainst.cellOverrides ?? {};
  for (const cell of [
    "model.mechanism",
    "fork.supported",
    "fork.atIndex",
    "usageReporting",
    "liveModelChangeBlockedReason",
  ]) {
    assert.ok(
      overrides[cell],
      `pi.${cell} is TRUE on the fork and FALSE upstream, but carries no per-cell citation`,
    );
  }
});

test("4791a88c: the source field says HOW to re-derive, not just where it came from", () => {
  // ⚠️ THE CLOSEST AVAILABLE PROXY FOR "the citation is TRUE". No test can check
  // that a human recorded the right version. What it CAN require is that every
  // citation carries an executable-or-locatable way to re-derive the identity, so
  // the next reader can check it in seconds instead of trusting it forever.
  for (const id of HARNESS_IDS) {
    const { source } = HARNESS_FACTS[id].measuredAgainst;
    assert.match(
      source,
      /(node -p|git -C|ACP_ADAPTER_PACKAGE_RANGES|--version)/,
      `${id}'s source is not re-derivable: "${source}"`,
    );
  }
});
