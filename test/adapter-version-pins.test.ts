import assert from "node:assert/strict";
import test from "node:test";
import { HARNESS_IDS } from "../src/acp/harness-capabilities.js";
import {
  ACP_ADAPTER_PACKAGE_RANGES,
  AGENT_REGISTRY,
  agentCommandEnvSeam,
  listAgentLaunchForms,
} from "../src/agent-registry.js";

// 0ededc52 — every npx-launched adapter names a version.
//
// ⚠️ THE DEFECT. An unpinned `npx -y <pkg> acp` resolves `latest` FROM THE
// REGISTRY, AT SPAWN, ON EVERY BOX INDEPENDENTLY. Two boxes can then be running
// different adapter builds while every descriptor claim about that harness reads
// identically. That is the same class of fact as the pi-acp `session/set_model`
// cell that was true at 0.0.26 and false at 0.0.33: a claim with no version
// cannot be shown to have expired, so it cannot be checked.
//
// ⚠️ AND THE TRAP THAT CAUGHT ME WHILE FIXING IT. The table's own doc said "read
// `^` as `==`", which is TRUE for its `0.0.x` rows — npm treats `0.0.x` as fully
// pinned — and FALSE the moment a `1.x` row joins: `^1.18.28` accepts `1.19.0`.
// Copying the neighbours' shape would have produced a RANGE that reads as a pin,
// with the file's own comment vouching for it. So the rows below are checked for
// what they ACTUALLY constrain, not for looking alike.

// ⚠️ EVERY ROW BELOW READS `listAgentLaunchForms`, NOT `AGENT_REGISTRY` — and
// that substitution is the whole of brick 82a18653.
//
// `AGENT_REGISTRY` is a SNAPSHOT of what the box running the test resolves.
// `pi`'s entry flips from `npx pi-acp@^0.0.33` to `node /opt/pi-acp/dist/index.js`
// the moment a box builds the fork, so on 2026-09-06 the bootstrap rolled that
// path out to all five boxes and the pin-table row below went red on every one
// of them — with the pin table, the registry and the resolver all unchanged. It
// was measuring the box.
//
// Worse, and invisible: the OTHER two rows here did not go red, they went
// SILENT. `npxPins()` and the described-harness row both skipped any command
// without `npx` in it, so on a fork box pi simply dropped out of the checked
// population and its caret rule stopped being enforced — with every row green.
// **A coverage loss that reports as a pass is the failure this file exists to
// prevent**, so it is fixed here alongside the red rather than left for the
// version bump that would have discovered it.
//
// ⇒ The population is now every form the registry CAN launch, on any box. Not a
// skip on box state: a row that passes by not looking would re-hide exactly the
// drift these rows exist to catch.

/** Every `agent → launch form` pair the built-in registry can produce. */
function everyLaunchForm(): { agent: string; command: string }[] {
  return Object.keys(AGENT_REGISTRY).flatMap((agent) =>
    listAgentLaunchForms(agent).map((command) => ({ agent, command })),
  );
}

/** Launch forms that go through `npx <pkg>@<spec>`, and the spec each carries. */
function npxPins(): { agent: string; pkg: string; spec: string }[] {
  const found: { agent: string; pkg: string; spec: string }[] = [];
  for (const { agent, command } of everyLaunchForm()) {
    // `npx [-y] <pkg>@<spec> …` — the `@` form only; an unpinned `npx <pkg>`
    // is deliberately NOT matched here, because the row below is what catches it.
    const match = /\bnpx\s+(?:-y\s+)?((?:@[^\s/]+\/)?[^\s@]+)@([^\s]+)/.exec(command);
    if (match) {
      found.push({ agent, pkg: match[1], spec: match[2] });
    }
  }
  return found;
}

test("0ededc52: every DESCRIBED harness's npx adapter names a version", () => {
  // ⚠️ SCOPED TO THE DESCRIPTOR'S HARNESSES, AND THE SCOPE IS THE ARGUMENT, not
  // a convenience. The rule being enforced is "a capability claim must name the
  // build it was proven on"; claims exist only for the five harnesses in
  // `HARNESS_IDS`, so those are the rows that must be pinned.
  //
  // ⚠️ THIS ROW FOUND AN UNPINNED ADAPTER, AND IT IS DELIBERATELY NOT PINNED:
  // `kilocode: npx -y @kilocode/cli acp` resolves `latest` at spawn. It carries
  // no descriptor claims, nobody has measured
  // it, and pinning it would freeze a harness outside this programme at whatever
  // version happens to be latest today — a behaviour decision belonging to
  // whoever owns it. Reported rather than silently taken (brick 0ededc52).
  const unpinned: string[] = [];
  let npxForms = 0;
  for (const { agent, command } of everyLaunchForm()) {
    if (!/\bnpx\b/.test(command) || !(HARNESS_IDS as readonly string[]).includes(agent)) {
      continue;
    }
    npxForms += 1;
    if (!/\bnpx\s+(?:-y\s+)?(?:@[^\s/]+\/)?[^\s@]+@[^\s]+/.test(command)) {
      unpinned.push(`${agent}: ${command}`);
    }
  }
  // ⚠️ POPULATION FIRST. 0 npx forms would satisfy the assertion below
  // vacuously and read exactly like a clean registry — and on a box with the pi
  // fork installed that is no longer hypothetical: read from AGENT_REGISTRY this
  // count drops from 2 to 1 with nothing turning red.
  assert.ok(npxForms > 0, "no npx-launched forms were found at all — the matcher is broken");
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

test("0ededc52: the pin table holds ONLY adapters the registry can launch by npx — on ANY box", () => {
  // ⚠️ THE ROW A DEAD ENTRY WOULD HAVE FAILED. `codex: "^0.0.44"` sat here
  // referenced by nothing, naming a version the deployed build was already past
  // (`/opt/codex-acp` is 0.0.45) — a version claim that governed no behaviour and
  // could not be shown to have expired, in the pinning table itself. claude
  // and codex are `/opt` builds; a row for any of them reads as a pin
  // while pinning nothing, which is exactly how that entry arose.
  //
  // ⚠️ "CAN LAUNCH", NOT "IS LAUNCHING HERE" — and the difference is a live
  // defect, not a nicety (brick 82a18653). Read from this box's resolution, this
  // row calls `pi` an orphan on every box that has `/opt/pi-acp`: the fork is
  // preferred there, so no npx command is visible. But `ACP_ADAPTER_PACKAGE_RANGES.pi`
  // is exactly what `resolvePiAcpCommand` interpolates into its FALLBACK arm — it
  // governs what a box without the fork launches, which is the opposite of dead.
  // **The row was correct about the world and wrong about its own premise.**
  const npxLaunched = new Set<string>();
  for (const { agent, command } of everyLaunchForm()) {
    if (/\bnpx\b/.test(command)) {
      npxLaunched.add(agent);
    }
  }
  assert.ok(npxLaunched.size > 0, "population: no npx-launched agents — the matcher is broken");
  const orphans = Object.keys(ACP_ADAPTER_PACKAGE_RANGES).filter((key) => !npxLaunched.has(key));
  assert.deepEqual(
    orphans,
    [],
    `these pin-table rows govern no launch form on any box: ${orphans.join(", ")}`,
  );
});

test("0ededc52: the launch-form enumeration answers to THIS box, not only to itself", () => {
  // ⚠️ THE CONTROL FOR EVERY ROW ABOVE. They are all computed from
  // `listAgentLaunchForms`, which is deliberately box-independent — and a
  // box-independent enumeration that has drifted from what the box actually
  // resolves would keep all of them green while describing a registry nobody
  // runs. So: whatever `AGENT_REGISTRY` resolved AT IMPORT, on THIS box, must be
  // one of the forms enumerated for that agent — or the operator's documented
  // env-seam override, which is the one thing acpx does not ship and therefore
  // cannot enumerate.
  const missing: string[] = [];
  for (const [agent, command] of Object.entries(AGENT_REGISTRY)) {
    const seam = agentCommandEnvSeam(agent);
    const override = seam ? process.env[seam]?.trim() : undefined;
    if (override && override === command) {
      continue;
    }
    if (!listAgentLaunchForms(agent).includes(command)) {
      missing.push(
        `${agent}: resolved "${command}", enumerated ${JSON.stringify(listAgentLaunchForms(agent))}`,
      );
    }
  }
  assert.deepEqual(
    missing,
    [],
    `the enumeration does not cover what this box resolves:\n${missing.join("\n")}`,
  );
});
