import assert from "node:assert/strict";
import test from "node:test";
import { HARNESS_IDS } from "../src/acp/harness-capabilities.js";
import { ACP_ADAPTER_PACKAGE_RANGES, AGENT_REGISTRY } from "../src/agent-registry.js";

// 0ededc52 — every npx-launched adapter names a version.
//
// ⚠️ THE DEFECT. `opencode` was `npx -y opencode-ai acp` — no version — so it
// resolved `latest` FROM THE REGISTRY, AT SPAWN, ON EVERY BOX INDEPENDENTLY. Two
// boxes could be running different OpenCode builds while every descriptor claim
// about OpenCode read identically. That is the same class of fact as the pi-acp
// `session/set_model` cell that was true at 0.0.26 and false at 0.0.33: a claim
// with no version cannot be shown to have expired, so it cannot be checked.
//
// ⚠️ AND THE TRAP THAT CAUGHT ME WHILE FIXING IT. The table's own doc said "read
// `^` as `==`", which is TRUE for its `0.0.x` rows — npm treats `0.0.x` as fully
// pinned — and FALSE the moment a `1.x` row joins: `^1.18.28` accepts `1.19.0`.
// Copying the neighbours' shape would have produced a RANGE that reads as a pin,
// with the file's own comment vouching for it. So the rows below are checked for
// what they ACTUALLY constrain, not for looking alike.

/** Adapters launched through `npx <pkg>@<spec>`, and the spec each carries. */
function npxPins(): { agent: string; pkg: string; spec: string }[] {
  const found: { agent: string; pkg: string; spec: string }[] = [];
  for (const [agent, command] of Object.entries(AGENT_REGISTRY)) {
    // `npx [-y] <pkg>@<spec> …` — the `@` form only; an unpinned `npx <pkg>`
    // is deliberately NOT matched here, because the row below is what catches it.
    const match = /\bnpx\s+(?:-y\s+)?((?:@[^\s/]+\/)?[^\s@]+)@([^\s]+)/.exec(command);
    if (match) {
      found.push({ agent, pkg: match[1], spec: match[2] });
    }
  }
  return found;
}

test("0ededc52: opencode's adapter is pinned, and the pin is BARE (not a caret)", () => {
  const command = AGENT_REGISTRY.opencode;
  assert.match(
    command,
    /opencode-ai@\d+\.\d+\.\d+\s/,
    `opencode is not version-pinned: ${command}`,
  );
  // ⚠️ THE POINT OF THE ROW. A caret on a 1.x package is a RANGE. If someone
  // "tidies" this to match pi's `^0.0.33`, the pin silently stops being one.
  assert.doesNotMatch(
    command,
    /opencode-ai@\^/,
    "opencode-ai is a 1.x package — a caret here is a RANGE, not a pin",
  );
});

test("0ededc52: every DESCRIBED harness's npx adapter names a version", () => {
  // ⚠️ SCOPED TO THE DESCRIPTOR'S HARNESSES, AND THE SCOPE IS THE ARGUMENT, not
  // a convenience. The rule being enforced is "a capability claim must name the
  // build it was proven on"; claims exist only for the five harnesses in
  // `HARNESS_IDS`, so those are the rows that must be pinned.
  //
  // ⚠️ THIS ROW FOUND A SECOND UNPINNED ADAPTER, AND IT IS DELIBERATELY NOT
  // PINNED: `kilocode: npx -y @kilocode/cli acp` resolves `latest` at spawn
  // exactly as opencode did. It carries no descriptor claims, nobody has measured
  // it, and pinning it would freeze a harness outside this programme at whatever
  // version happens to be latest today — a behaviour decision belonging to
  // whoever owns it. Reported rather than silently taken (brick 0ededc52).
  const unpinned: string[] = [];
  let npxAgents = 0;
  for (const [agent, command] of Object.entries(AGENT_REGISTRY)) {
    if (!/\bnpx\b/.test(command) || !(HARNESS_IDS as readonly string[]).includes(agent)) {
      continue;
    }
    npxAgents += 1;
    if (!/\bnpx\s+(?:-y\s+)?(?:@[^\s/]+\/)?[^\s@]+@[^\s]+/.test(command)) {
      unpinned.push(`${agent}: ${command}`);
    }
  }
  // ⚠️ POPULATION FIRST. 0 npx agents would satisfy the assertion below
  // vacuously and read exactly like a clean registry.
  assert.ok(npxAgents > 0, "no npx-launched agents were found at all — the matcher is broken");
  assert.deepEqual(
    unpinned,
    [],
    `these adapters resolve \`latest\` at spawn:\n${unpinned.join("\n")}`,
  );
});

test("0ededc52: a caret pin appears ONLY on 0.0.x, where npm makes it exact", () => {
  // The rule this file exists to keep true, applied to every row rather than to
  // the one being added today:
  //   ^0.0.x  → npm allows only that patch. Exact.
  //   ^1.y.z  → npm allows any later 1.x. A range wearing a pin's clothes.
  const pins = npxPins();
  assert.ok(pins.length > 0, "population: no `pkg@spec` adapters matched — the matcher is broken");
  for (const { agent, pkg, spec } of pins) {
    if (!spec.startsWith("^")) {
      continue;
    }
    assert.match(
      spec,
      /^\^0\.0\.\d+$/,
      `${agent} (${pkg}) pins "${spec}" — a caret is only exact on 0.0.x; use a bare version`,
    );
  }
});

test("0ededc52: the pin table holds ONLY adapters the registry actually launches by npx", () => {
  // ⚠️ THE ROW A DEAD ENTRY WOULD HAVE FAILED. `codex: "^0.0.44"` sat here
  // referenced by nothing, naming a version the deployed build was already past
  // (`/opt/codex-acp` is 0.0.45) — a version claim that governed no behaviour and
  // could not be shown to have expired, in the pinning table itself. claude,
  // claude-pty and codex are `/opt` builds; a row for any of them reads as a pin
  // while pinning nothing, which is exactly how that entry arose.
  const npxLaunched = new Set<string>();
  for (const [agent, command] of Object.entries(AGENT_REGISTRY)) {
    if (/\bnpx\b/.test(command)) {
      npxLaunched.add(agent);
    }
  }
  assert.ok(npxLaunched.size > 0, "population: no npx-launched agents — the matcher is broken");
  const orphans = Object.keys(ACP_ADAPTER_PACKAGE_RANGES).filter((key) => !npxLaunched.has(key));
  assert.deepEqual(orphans, [], `these pin-table rows govern nothing: ${orphans.join(", ")}`);
});

test("0ededc52: the pinned opencode version is the one the descriptor claims were measured on", () => {
  // The pin and the citation must not drift apart: part 2 of this block cites
  // OpenCode capability claims against this exact version, and a bump that moved
  // one without the other would leave the citations quietly wrong.
  assert.match(AGENT_REGISTRY.opencode, /opencode-ai@1\.18\.28\s/);
});
