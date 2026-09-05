import assert from "node:assert/strict";
import test from "node:test";
import { HARNESS_FACTS, HARNESS_IDS } from "../src/acp/harness-capabilities.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// 4791a88c — every capability claim cites the adapter build it was proven on.
//
// ⚠️ THE DEFECT, MEASURED. Before this, `harness-capabilities.ts` contained ZERO
// occurrences of any adapter version — no `codex-acp@`, no `0.144`, no
// `pi-acp@^`, no `opencode-ai@` — against 48 `mechanism` hits, so the file is
// deep and the absence was total. Not one claim, for any harness, named the build
// it was measured against.
//
// ⚠️ WHY THAT IS A DEFECT AND NOT UNTIDINESS. pi's `session/set_model` was REAL
// in pi-acp 0.0.26 and GONE in 0.0.33, while the descriptor's comment said
// "proven three ways" with no version. A claim with no version cannot be shown to
// have EXPIRED, so it cannot be checked at all — it is a belief wearing the
// clothes of a measurement.
//
// ⚠️ AND A CITATION NAMES A MEASUREMENT, NEVER A BELIEF. These rows check that a
// citation EXISTS and cannot silently drift from the pin it claims; they cannot
// check that a human wrote a true one. That limit is stated rather than papered
// over — see the last row, which is the closest available proxy.

test("4791a88c: every described harness cites the build its claims were measured on", () => {
  const missing: string[] = [];
  for (const id of HARNESS_IDS) {
    const cited = HARNESS_FACTS[id].measuredAgainst;
    if (!cited?.adapter?.trim() || !cited.source?.trim()) {
      missing.push(id);
    }
  }
  // ⚠️ POPULATION FIRST — an empty HARNESS_IDS would satisfy this vacuously and
  // read exactly like a fully-cited table.
  assert.ok(HARNESS_IDS.length > 0, "no harnesses were examined at all");
  assert.deepEqual(missing, [], `these harnesses cite no adapter build: ${missing.join(", ")}`);
});

test("4791a88c: a citation names a VERSION or a COMMIT, not just a package", () => {
  // `pi-acp` alone would satisfy "cites something" while naming nothing that can
  // expire — which is the exact failure mode, one level less obvious.
  for (const id of HARNESS_IDS) {
    const { adapter } = HARNESS_FACTS[id].measuredAgainst;
    assert.match(
      adapter,
      /(\d+\.\d+\.\d+|commit\s+[0-9a-f]{7,})/,
      `${id} cites "${adapter}", which names no version and no commit`,
    );
  }
});

test("4791a88c: a cited PIN cannot drift from AGENT_REGISTRY", () => {
  // ⚠️ THE ANTI-DRIFT ROW, and the reason the citation is a FIELD rather than
  // prose. Where acpx pins the adapter itself, the citation must name the same
  // spec the registry launches — otherwise a bump moves what runs while the
  // citation still reads as current, which is precisely the state this brick
  // exists to end.
  const pinned: { id: (typeof HARNESS_IDS)[number]; spec: string }[] = [];
  for (const id of HARNESS_IDS) {
    const command = AGENT_REGISTRY[id];
    const match = /\bnpx\s+(?:-y\s+)?((?:@[^\s/]+\/)?[^\s@]+@[^\s]+)/.exec(command ?? "");
    if (match) {
      pinned.push({ id, spec: match[1] });
    }
  }
  // Population: if no harness is npx-pinned the row proves nothing, and today two
  // are (pi and opencode). 0 would mean the matcher broke, not that all is well.
  assert.ok(pinned.length > 0, "no npx-pinned harness found — the matcher is broken");
  for (const { id, spec } of pinned) {
    assert.equal(
      HARNESS_FACTS[id].measuredAgainst.adapter,
      spec,
      `${id}: the registry launches "${spec}" but the claims cite "${HARNESS_FACTS[id].measuredAgainst.adapter}"`,
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
