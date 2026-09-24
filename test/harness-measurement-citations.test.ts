import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_FACTS,
  HARNESS_IDS,
  type HarnessAdapterIdentity,
  type HarnessCapabilityFacts,
  type HarnessMeasurementSource,
} from "../src/acp/harness-capabilities.js";
import { listAgentLaunchForms } from "../src/agent-registry.js";

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

type LaunchForm =
  | { kind: "npx-pin"; command: string; spec: string }
  | { kind: "resolved-path"; command: string; path: string }
  | { kind: "unclassified"; command: string };

function classifyLaunchForm(command: string): LaunchForm {
  const npx = /\bnpx\s+(?:-y\s+)?((?:@[^\s/]+\/)?[^\s@]+@[^\s]+)/.exec(command);
  if (npx) {
    return { kind: "npx-pin", command, spec: npx[1] };
  }
  const local = /\bnode\s+(\/\S+)/.exec(command);
  if (local) {
    return { kind: "resolved-path", command, path: local[1] };
  }
  return { kind: "unclassified", command };
}

/**
 * Every way a block's citations and the registry's launch forms can disagree.
 *
 * Extracted as a pure function of (citations, commands) for one reason: it is
 * the only shape in which this row can be shown to GO RED. The row below runs it
 * on the real table; the row after that runs it on planted stale citations and
 * requires each to be caught, on every box, with no mutation of the tree.
 */
function driftProblems(
  id: string,
  measured: HarnessMeasurementSource,
  commands: string[],
): string[] {
  const forms = commands.map(classifyLaunchForm);
  if (forms.length === 0) {
    return [`${id}: the registry enumerates NO launch form at all — the matcher is broken`];
  }
  const problems: string[] = [];
  // A per-cell citation is a citation: pi's `/opt` build is cited in
  // `cellOverrides` while its block names the npx fallback, and both forms are
  // real, so both count as covering evidence.
  const citations = [measured.adapter, ...Object.values(measured.cellOverrides ?? {})];
  const npxSpecs = new Set(forms.flatMap((form) => (form.kind === "npx-pin" ? [form.spec] : [])));

  for (const form of forms) {
    if (form.kind === "unclassified") {
      // ⚠️ REPORTED, NOT SKIPPED. The predecessor dropped an unrecognised command
      // silently, which is how a launch form leaves the checked set without
      // anything turning red.
      problems.push(
        `${id}: launch form "${form.command}" is neither an npx pin nor a resolved path — ` +
          `the classifier cannot check it, and an unchecked form must not pass as a checked one`,
      );
    } else if (form.kind === "npx-pin") {
      if (!citations.some((c) => c.kind === "package-range" && c.spec === form.spec)) {
        problems.push(
          `${id}: the registry can launch "${form.spec}" by npx, but no citation names that package-range`,
        );
      }
    } else if (!citations.some((c) => c.kind === "resolved-commit")) {
      problems.push(
        `${id}: the registry can launch it from a resolved path (${form.path}), so that build is ` +
          `IDENTIFIABLE — a package-range citation is stale for it and some citation must name its commit`,
      );
    }
  }

  // The BLOCK citation is documented as "what acpx RESOLVES", so it must still
  // describe one of the forms acpx can resolve — otherwise a harness could push
  // every real citation into `cellOverrides` and leave the block naming nothing.
  const blockDescribesAForm = forms.some((form) =>
    form.kind === "npx-pin"
      ? measured.adapter.kind === "package-range" && measured.adapter.spec === form.spec
      : form.kind === "resolved-path" && measured.adapter.kind === "resolved-commit",
  );
  if (!blockDescribesAForm) {
    problems.push(
      `${id}: the block citation (kind "${measured.adapter.kind}") describes none of the forms ` +
        `the registry launches: ${commands.join(" | ")}`,
    );
  }

  // ⚠️ THE INVERSE QUERY. Everything above asks "is each launch form cited?".
  // Alone that is half a sweep: a citation naming a spec nothing launches any
  // more is exactly the stale claim this file exists to reject, and it survives
  // the forward direction untouched.
  for (const citation of citations) {
    if (citation.kind === "package-range" && !npxSpecs.has(citation.spec)) {
      problems.push(
        `${id}: cites package-range "${citation.spec}", which the registry launches on NO box — STALE`,
      );
    }
  }
  return problems;
}

test("4791a88c: a cited PIN cannot drift from AGENT_REGISTRY — on EITHER launch form", () => {
  // ⚠️ THE ANTI-DRIFT ROW. IT WENT SILENT ON ONE HALF AND RED ON THE OTHER, AND
  // BOTH WERE THE SAME MISTAKE (brick 82a18653).
  //
  // Its first form matched only `npx <spec>`, so when `resolvePiAcpCommand`
  // began returning `node /opt/pi-acp/dist/index.js` pi would have dropped out
  // of the checked set entirely — failing toward SILENCE, invisibly to the
  // population guard, since `> 0` stays true on a single harness alone.
  //
  // Its second form classified both shapes but still read ONE box's resolution
  // (`AGENT_REGISTRY[id]`), and demanded static citations match it. `HARNESS_FACTS`
  // is source; the launch form is box state. On 2026-09-06 the bootstrap put
  // `/opt/pi-acp` on all five boxes and this row demanded a `resolved-commit`
  // block citation from a table that must equally serve a box without the fork —
  // **a requirement no single value can satisfy.** It passed everywhere on
  // 2026-09-05 and failed everywhere on 2026-09-06 with no source change at all.
  //
  // ⇒ The subject is now every form the registry CAN launch. Installing the fork
  // TIGHTENS the check — the resolved path demands a resolved-commit citation
  // *in addition to* the npx fallback's package-range — instead of swapping one
  // requirement for the other. And it is not a skip: **a row that passes by not
  // looking would re-hide the drift the row exists to catch.**
  assert.ok(HARNESS_IDS.length > 0, "no harnesses were examined at all");
  const problems = HARNESS_IDS.flatMap((id) =>
    driftProblems(id, HARNESS_FACTS[id].measuredAgainst, listAgentLaunchForms(id)),
  );
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("4791a88c: the anti-drift check GOES RED on a stale citation — each way it can be stale", () => {
  // ⚠️ THE POSITIVE CONTROL, ON THE PATH UNDER ASSERTION. The row above asserts
  // an ABSENCE (no problems). An absence is worth nothing from an instrument that
  // cannot produce a presence — and the previous form of this row was itself the
  // proof, having spent a deployment window unable to see pi at all while
  // reporting clean. Each case below is a drift the row is claimed to catch, run
  // through the same function on the same real data, so it fires on every box
  // rather than in one lane's one-off mutation.
  const pi = HARNESS_FACTS.pi.measuredAgainst;
  const codex = HARNESS_FACTS.codex.measuredAgainst;

  // 1. The pin moved and the citation did not.
  assert.ok(
    driftProblems("pi", pi, ["npx pi-acp@^0.0.99", `node /opt/pi-acp/dist/index.js`]).some((p) =>
      p.includes("no citation names that package-range"),
    ),
    "a bumped npx pin with an unchanged citation was not caught",
  );

  // 2. A citation naming a spec nothing launches — the inverse direction, which
  //    the forward check cannot see.
  assert.ok(
    driftProblems("pi", pi, [`node /opt/pi-acp/dist/index.js`]).some((p) => p.includes("STALE")),
    "a package-range citation for a launch form that no longer exists was not caught",
  );

  // 3. A resolved path cited only by a package-range — the identifiable build
  //    left unidentified. Built by stripping the `cellOverrides` that legitimately
  //    carry pi's fork commit, so the input differs from the real block in exactly
  //    the property under test.
  const withoutForkCitations: HarnessMeasurementSource = { ...pi, cellOverrides: undefined };
  assert.ok(
    driftProblems("pi", withoutForkCitations, [`node /opt/pi-acp/dist/index.js`]).some((p) =>
      p.includes("must name its commit"),
    ),
    "a resolved path with no resolved-commit citation anywhere was not caught",
  );

  // 4. A launch form the classifier does not understand is REPORTED, not dropped.
  assert.ok(
    driftProblems("codex", codex, ["some-custom-bridge --acp"]).some((p) =>
      p.includes("neither an npx pin nor a resolved path"),
    ),
    "an unclassifiable launch form passed silently — the original defect",
  );

  // 5. CONTROL: the same function on the same blocks with their real forms must
  //    return CLEAN, or "it flags everything" satisfies all four cases above
  //    vacuously.
  assert.deepEqual(driftProblems("pi", pi, listAgentLaunchForms("pi")), []);
  assert.deepEqual(driftProblems("codex", codex, listAgentLaunchForms("codex")), []);
});

test("4791a88c: the two harnesses whose adapter and CLI move apart cite both", () => {
  // pi-acp is not pi, and codex-acp is not the codex CLI. Two things that go
  // stale independently must both be named, or one moves while the citation
  // still looks current. (claude is a single artifact, so `harness` is
  // legitimately absent there — asserted, not assumed.)
  assert.ok(HARNESS_FACTS.pi.measuredAgainst.harness, "pi cites no underlying pi version");
  assert.ok(HARNESS_FACTS.codex.measuredAgainst.harness, "codex cites no underlying codex CLI");
  for (const id of ["claude"] as const) {
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
  // ⚠️ THIS ROW NAMES ITS OWN EXIT CONDITION so it reads as a contract rather
  // than an obstacle — and that condition was RE-STATED by brick 82a18653,
  // because the one written here was box-dependent and therefore unreachable.
  //
  // It used to read: "when a box installs the fork, the block citation becomes a
  // resolved-commit naming it". A box cannot decide what a source file says. What
  // installing the fork actually changes is that pi has TWO reachable launch
  // forms and needs a citation for each — the block's npx package-range and these
  // overrides' resolved-commit — which is the state the table is in today, on
  // boxes with the fork and without it alike.
  //
  // The real exit condition is the one event that removes a form: when the
  // upstream fallback in `resolvePiAcpCommand` is deleted (allowed only once
  // every box builds `/opt/pi-acp`), pi's only form is the resolved path, the
  // block's package-range becomes a citation nothing launches, and the anti-drift
  // row's inverse check demands it be replaced by the fork's commit. These
  // overrides then describe the SAME build as their block and the "identical to
  // the block" check demands they be DELETED. That is the intended end state, not
  // a regression.
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
