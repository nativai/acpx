import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import {
  addArchiveRunIntentOptions,
  resolveRunIntent,
  type RunIntent,
  type SessionsArchiveFlags,
} from "../src/cli/archive-command.js";

/**
 * The acpx ↔ acpx-ui seam: `acpx sessions archive` requires an EXPLICIT intent.
 *
 * 🛑 THE P0 THIS CLOSES. acpx-ui's retention scheduler emitted `--dry-run` when
 * dry-running and NOTHING when it meant to apply — so it never archived anything,
 * in any configuration. Measured with a positive control one flag apart: same
 * vector, 0 files moved; with `--no-dry-run`, 31 files moved; `selected: 5` in
 * both.
 *
 * ⚠️ THE SCHEDULER'S ASSUMPTION WAS NOT UNREASONABLE, and that is why the fix is
 * a refusal rather than a corrected default. `sessions archive` was the ONLY one
 * of the five dry-run-bearing verbs on this surface with an inverted polarity —
 * `prune`, `templates migrate-slugs`, `repair-account-seam` and
 * `sweep-config-dirs` all declare only an affirmative `--dry-run`, so bare means
 * APPLY for every one of them. Generalising that to archive is the natural
 * reading. Refusing silence removes this verb from the inconsistency instead of
 * adding a sixth variant.
 *
 * ⚠️ THESE ARE VECTOR-LEVEL TESTS AGAINST THE REAL PARSER, DELIBERATELY. The
 * acpx-ui test that missed this asserted on an argv array handed to a FAKE, and
 * encoded the defect itself as its success condition ("absence of --dry-run means
 * APPLY") — which is how 9,279 green cases missed it. A test that accepts a
 * pre-built flags object would miss it here for the same reason: the whole
 * question is what a real argv PARSES TO, and `--no-dry-run`'s declaration order
 * is what makes that non-obvious.
 */

/**
 * Parse a real argv through a command declared exactly as `registerSessionsCommand`
 * declares it — including the load-bearing `--no-dry-run`-before-`--dry-run` order.
 */
function intentOf(argv: readonly string[]): RunIntent {
  const command = new Command();
  command.exitOverride();
  // ⚠️ THE PRODUCT'S OWN DECLARATION, NOT A HAND-BUILT COPY. If this rebuilt the
  // three options locally it would be a replica, and a replica cannot notice the
  // product drifting away from it — the exact failure of the acpx-ui test that
  // missed this P0. The unrelated options below are only so realistic scheduler
  // vectors parse at all; none of them says what to DO.
  addArchiveRunIntentOptions(command)
    .option("--orphans", "")
    .option("--json", "")
    .option("--wave <token>", "");
  command.parse([...argv], { from: "user" });
  return resolveRunIntent(command.opts<SessionsArchiveFlags>(), command);
}

test("🛑 a bare vector is UNSTATED — silence means neither intent", () => {
  // The exact vector acpx-ui emitted when it meant to apply. It must now be a loud
  // refusal rather than a silent dry run.
  assert.equal(intentOf([]), "unstated");
  // …and still unstated when other flags are present, because none of them says
  // what to DO. This is the scheduler's real vector shape.
  assert.equal(intentOf(["--orphans", "--json", "--wave", "retention-20260917T0100Z"]), "unstated");
});

test("explicit intents resolve to themselves", () => {
  assert.equal(intentOf(["--dry-run"]), "dry-run");
  assert.equal(intentOf(["--apply"]), "apply");
  // Kept as an exact synonym: the spelling the TE already measured moving 31 files.
  assert.equal(intentOf(["--no-dry-run"]), "apply");
});

test("a contradiction is as ambiguous as silence, and is refused too", () => {
  assert.equal(intentOf(["--apply", "--dry-run"]), "contradictory");
  assert.equal(intentOf(["--dry-run", "--apply"]), "contradictory");
  // Two ways of saying the SAME thing is not a contradiction.
  assert.equal(intentOf(["--apply", "--no-dry-run"]), "apply");
});

test("🛑 bare and explicit --dry-run BOTH parse to dryRun:true — the trap this guard must not fall into", () => {
  // ⚠️ THE REASON A NAIVE VERSION OF THIS VERY FIX WOULD BE A SILENT NO-OP. Reading
  // `flags.dryRun` alone cannot separate these two, so a guard written that way
  // would classify every invocation identically — the same class of defect it
  // exists to prevent. What separates them is the option's SOURCE.
  const bare = new Command();
  bare.exitOverride();
  bare.option("--no-dry-run", "").option("--dry-run", "").option("--apply", "");
  bare.parse([], { from: "user" });

  const explicit = new Command();
  explicit.exitOverride();
  explicit.option("--no-dry-run", "").option("--dry-run", "").option("--apply", "");
  explicit.parse(["--dry-run"], { from: "user" });

  assert.equal(bare.opts().dryRun, true);
  assert.equal(explicit.opts().dryRun, true, "identical values — the flags object cannot decide");
  assert.equal(bare.getOptionValueSource("dryRun"), "default");
  assert.equal(explicit.getOptionValueSource("dryRun"), "cli", "only the SOURCE separates them");

  // ⚠️ AND THE KEY MUST BE camelCase. The kebab spelling returns undefined for
  // BOTH, which would make every run look unstated — a guard reduced to a constant.
  assert.equal(bare.getOptionValueSource("dry-run"), undefined);
  assert.equal(explicit.getOptionValueSource("dry-run"), undefined);
});

test("the resolver never returns a fifth value, so no caller can fall off the switch", () => {
  const vectors: readonly (readonly string[])[] = [
    [],
    ["--dry-run"],
    ["--apply"],
    ["--no-dry-run"],
    ["--apply", "--dry-run"],
    ["--json"],
  ];
  const allowed = new Set<RunIntent>(["dry-run", "apply", "unstated", "contradictory"]);
  for (const argv of vectors) {
    const command = new Command();
    command.exitOverride();
    command
      .option("--no-dry-run", "")
      .option("--dry-run", "")
      .option("--apply", "")
      .option("--json", "");
    command.parse([...argv], { from: "user" });
    assert.ok(allowed.has(resolveRunIntent(command.opts<SessionsArchiveFlags>(), command)));
  }
});

test("a command without the option declared does not crash the resolver", () => {
  // Defensive: `getOptionValueSource` is optional-chained, so a caller constructing
  // flags programmatically (a test, an embedder) gets `unstated` rather than a
  // throw — and `unstated` refuses, which is the safe direction.
  const bare = new Command();
  assert.equal(resolveRunIntent({}, bare), "unstated");
  assert.equal(resolveRunIntent({ apply: true }, bare), "apply");
});
