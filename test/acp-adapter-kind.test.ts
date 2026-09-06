import assert from "node:assert/strict";
import test from "node:test";
import { acpAdapterKind } from "../src/acp/agent-command.js";

// brick://4dd3ee2c — the copy/fork/byway agent-lock must treat two command
// spellings that drive the SAME adapter as the same agent type. The regression:
// a claude-pty session created under `.../acp-server-transcript.mjs` (the root
// shim) could not be forked once the resolver yielded `.../dist/index.js` (the
// registry default) — the two are the SAME program, but the lock compared raw
// command strings and rejected the copy, surfacing as a 502 on byway-create.
test("acpAdapterKind maps both claude-pty command spellings to the same kind", () => {
  const distDefault = "node /opt/claude-pty-acp/dist/index.js";
  const mjsShim = "node /opt/claude-pty-acp/acp-server-transcript.mjs";
  assert.equal(acpAdapterKind(distDefault), "claude-pty");
  assert.equal(acpAdapterKind(mjsShim), "claude-pty");
  assert.equal(acpAdapterKind(distDefault), acpAdapterKind(mjsShim));
  // A dev-worktree override still classifies as claude-pty (path contains the
  // repo name / server-script name).
  assert.equal(
    acpAdapterKind("node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs"),
    "claude-pty",
  );
});

test("acpAdapterKind classifies the other known adapters", () => {
  assert.equal(acpAdapterKind("node /opt/claude-agent-acp/dist/index.js"), "claude");
  assert.equal(acpAdapterKind("node /opt/codex-acp/dist/index.js"), "codex");
  assert.equal(acpAdapterKind("gemini --acp"), "gemini");
  assert.equal(acpAdapterKind("copilot --acp --stdio"), "copilot");
});

test("acpAdapterKind returns undefined for a raw/unknown command (strict escape hatch)", () => {
  assert.equal(acpAdapterKind("node /tmp/some-custom-agent.js --agent"), undefined);
  assert.equal(acpAdapterKind("my-weird-acp serve"), undefined);
  assert.equal(acpAdapterKind(""), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// brick://4d0cbdfa — THE DEPLOYED `/opt` FORK SHAPE, FOR EVERY ADAPTER.
//
// The defect this pins: `commandLooksLikeBuiltInAgent` (src/session/import.ts)
// carried its own per-name regexes over the npm package specs, and **every
// command the boxes actually run failed its own classifier** — the deployed
// adapters are `/opt` forks, and the codex/claude patterns looked for
// `@agentclientprotocol/…`, a string those commands do not contain at all. It
// now derives from `acpAdapterKind`, so these rows are that consumer's contract
// as much as this one's.
//
// ⚠️ WHY BOTH SHAPES, EVERY ADAPTER, IN ONE TABLE. pi shipped broken because it
// was simultaneously (a) on the strictest matcher and (b) the only adapter never
// shown a path-embedded command — pi and opencode were added later and got only
// their then-current registry shapes. That asymmetry is invisible when each
// adapter's cases live apart. A table that must stay rectangular makes the next
// adapter that moves to `/opt` impossible to add without a row here.
//
// ⚠️ `/opt` rows measured against the box, not assumed: pi, codex, claude and
// claude-pty ARE `/opt` forks (`ls -d /opt/*acp*`, 2026-09-06). **opencode is
// not** — it has no `/opt` directory and no `ACPX_OPENCODE_ACP_COMMAND` seam, so
// its DEPLOYED form IS the npx shape. Its `/opt` row uses the fork-naming
// convention the other four follow — the fork dir is the package's unscoped name
// (`pi-acp`→`/opt/pi-acp`, `@agentclientprotocol/codex-acp`→`/opt/codex-acp`),
// which for `opencode-ai` gives `/opt/opencode-ai`. That row is forward-looking
// and passes today; it is NOT a claim that such a deploy exists.
const ADAPTER_COMMAND_SHAPES: ReadonlyArray<[string, string, string]> = [
  // [expected kind, deployed /opt fork form, npx / registry form]
  ["pi", "node /opt/pi-acp/dist/index.js", "npx pi-acp@^0.0.33"],
  ["codex", "node /opt/codex-acp/dist/index.js", "npx -y @agentclientprotocol/codex-acp@^0.0.1"],
  [
    "claude",
    "node /opt/claude-agent-acp/dist/index.js",
    "npx -y @agentclientprotocol/claude-agent-acp@^0.4.4",
  ],
  [
    "claude-pty",
    "node /opt/claude-pty-acp/dist/index.js",
    "npx -y @agentclientprotocol/claude-pty-acp@^0.1.0",
  ],
  ["opencode", "node /opt/opencode-ai/dist/index.js", "npx -y opencode-ai@1.18.28 acp"],
];

test("acpAdapterKind classifies all five adapters under BOTH the deployed /opt fork and the npx shape", () => {
  const observed: Record<string, { opt: string | undefined; npx: string | undefined }> = {};
  for (const [kind, optForm, npxForm] of ADAPTER_COMMAND_SHAPES) {
    observed[kind] = { opt: acpAdapterKind(optForm), npx: acpAdapterKind(npxForm) };
  }
  // Printed so the row's evidence is the measurement, not the verdict.
  process.stderr.write(`[4d0cbdfa] adapter shapes = ${JSON.stringify(observed)}\n`);

  for (const [kind, optForm, npxForm] of ADAPTER_COMMAND_SHAPES) {
    assert.equal(
      acpAdapterKind(optForm),
      kind,
      `deployed /opt form must classify as ${kind}: ${optForm}`,
    );
    assert.equal(acpAdapterKind(npxForm), kind, `npx form must classify as ${kind}: ${npxForm}`);
  }
  // The table must stay rectangular — five adapters, both shapes, no gaps. A row
  // silently dropped would take its coverage with it and nothing else would say so.
  assert.equal(ADAPTER_COMMAND_SHAPES.length, 5);
});

// ═══════════════════════════════════════════════════════════════════════════
// THE `pi-acp` TOKEN BOUNDARY. `pi-acp` is the shortest adapter name acpx knows
// and it is a SUFFIX of plausible package names, so the detector must anchor it.
//
// ⚠️ A NARROWING'S FAILURE MODE IS TURNING A CORRECT **YES** INTO A **NO**, so
// the positive set below is the load-bearing half of this pair, not the
// adversarial one. Every shape here matched before the boundary landed and must
// still match after it. `isPiAcpCommand` feeds `acpAdapterKind`, which gates the
// copy/fork agent-lock (`assertCopyAgentLock`), `harnessIdForAgentCommand`, and
// `commandLooksLikeBuiltInAgent` — so a wrong NO here surfaces as *"fork is
// refused on a pi session"*, and a wrong YES admits one adapter's session into
// another's.
const PI_MUST_MATCH: readonly string[] = [
  "npx pi-acp@^0.0.33",
  "npx pi-acp@^0.0.26",
  "npx -y pi-acp@0.0.33",
  "node /opt/pi-acp/dist/index.js",
  "/opt/pi-acp/dist/index.js",
  "pi-acp",
  "node /workspace/projects/pi-acp/dist/index.js", // dev checkout
];

// `npx rapi-acp@1.0.0` CLASSIFIED AS PI before the boundary landed — a live
// wrong YES in the shared classifier, reachable today, on the one direction the
// import path tells you to fear. A plain `includes("pi-acp")` is rejected for
// the same reason: it makes `rapi-acp` pi.
const PI_MUST_NOT_MATCH: readonly string[] = [
  "npx rapi-acp",
  "npx rapi-acp@1.0.0",
  "node /opt/rapi-acp/dist/index.js",
  "npx api-acp@2",
  "npx notpi-acp@1",
];

test("pi's detector anchors `pi-acp` on a token boundary — positive set intact, suffix collisions rejected", () => {
  for (const command of PI_MUST_MATCH) {
    assert.equal(acpAdapterKind(command), "pi", `must STILL classify as pi: ${command}`);
  }
  for (const command of PI_MUST_NOT_MATCH) {
    assert.notEqual(acpAdapterKind(command), "pi", `must NOT classify as pi: ${command}`);
  }
  // Both directions must be non-empty, or one half of this row is vacuous.
  assert.ok(PI_MUST_MATCH.length > 0 && PI_MUST_NOT_MATCH.length > 0);
});
