import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import { registerDefaultCommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";

// brick https://acpx.devbox.nativai.de/?brick=eb9c1d1e — `output-styles` was
// registered as a top-level command but missing from TOP_LEVEL_VERBS, so the
// token ALSO registered as an agent name and a bogus subverb was absorbed by the
// agent catch-all instead of erroring.
//
// ⚠️ THIS FILE IS DELIBERATELY *DISCOVERING*, NOT A SECOND HAND-WRITTEN LIST.
// A test that restates the expected verbs would be exactly as incomplete as the
// set it checks, and would have passed against the very defect it is written for:
// whoever forgets the entry forgets the list too. Instead it ENUMERATES what
// `registerDefaultCommands` actually registers on a real `Command`, so a NEW
// top-level command is flagged without being registered anywhere.

function fakeConfig(): ResolvedAcpxConfig {
  return {
    defaultAgent: "codex",
    defaultPermissions: "approve-all",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    ttlMs: 900_000,
    queueMaxDepth: 16,
    format: "text",
    agents: {},
    auth: {},
    disableExec: false,
    mcpServers: [],
    subscriptions: { version: 3, subscriptions: [], profiles: [] },
    globalPath: "/tmp/acpx-test-config.json",
    projectPath: "/tmp/.acpxrc.json",
    hasGlobalConfig: false,
    hasProjectConfig: false,
  } as unknown as ResolvedAcpxConfig;
}

function registeredTopLevelNames(): string[] {
  const program = new Command();
  registerDefaultCommands(program, fakeConfig());
  return program.commands.map((command) => command.name()).toSorted();
}

test("EVERY top-level command commander registers is present in TOP_LEVEL_VERBS", () => {
  // The discovering assertion. A command registered without its entry is
  // shadowed by an agent registration of the same name and fails SILENTLY —
  // there is no error to notice, which is why this has to be found rather than
  // remembered.
  const registered = registeredTopLevelNames();
  assert.ok(registered.length > 0, "registerDefaultCommands registered nothing — test is vacuous");

  const missing = registered.filter((name) => !TOP_LEVEL_VERBS.has(name));
  assert.deepEqual(
    missing,
    [],
    `these top-level commands are registered but absent from TOP_LEVEL_VERBS, so each is ` +
      `shadowed by an agent registration of its own name: ${missing.join(", ")}`,
  );
});

// ⚠️ THIS CHECK IS DELIBERATELY ONE-DIRECTIONAL, and the missing direction is a
// KNOWN, PRE-EXISTING defect rather than an oversight.
//
// It asserts REGISTERED ⊆ TOP_LEVEL_VERBS (the eb9c1d1e shape: a command that is
// registered but unlisted gets shadowed by an agent registration of its name).
// It does NOT assert the inverse, TOP_LEVEL_VERBS ⊆ REGISTERED — because `usage`
// is in the set on `origin/dev` today and is NOT a top-level command: the real
// verb is `subscriptions usage` (src/cli/subscriptions-command.ts). Measured on
// this build from a session-free cwd, `acpx usage <anything>` is absorbed by the
// `[prompt...]` catch-all and prints `No acpx session found` — byte-identically
// to a nonsense token.
//
// So `usage` is a DEAD TOKEN: claimed by the set (so it can never register as an
// agent name) while no command answers it. The blast radius is small — it blocks
// an agent literally named "usage" and gives a confusing message for `acpx usage`
// — which is why B0.2 REPORTS it rather than fixing it: deleting the entry would
// let an agent named `usage` register, a behaviour change nobody asked for, and
// it is outside this brick. Filed with WS-core 2026-09-04.
//
// If that is fixed, add the inverse assertion here; it is a two-line change and
// this comment is the reason it is not already present.

test("the discovering check can actually FAIL — mutation probe", () => {
  // ⚠️ Without this, "missing is empty" is indistinguishable from "the
  // enumeration found nothing to check". Prove the check has teeth by presenting
  // it a name that is registered and NOT in the set — the exact shape of the
  // eb9c1d1e defect — and requiring it to be caught.
  const registered = [...registeredTopLevelNames(), "zzz-unregistered-verb"];
  const missing = registered.filter((name) => !TOP_LEVEL_VERBS.has(name));
  assert.deepEqual(missing, ["zzz-unregistered-verb"]);
});

test("output-styles specifically — the verb eb9c1d1e was about", () => {
  // Named as well as discovered: the discovering test says WHETHER something is
  // wrong, this one says WHICH, faster than re-reading a diff.
  assert.ok(
    registeredTopLevelNames().includes("output-styles"),
    "output-styles must still be registered top-level (registerSharedAgentSubcommands)",
  );
  assert.ok(TOP_LEVEL_VERBS.has("output-styles"));
});

test("a bogus subverb is an ERROR, not an agent-catch-all prompt", async () => {
  // ⚠️ ASSERTS ON STDOUT/STDERR CONTENT, NEVER ON AN EXIT CODE (program TEST-PLAN
  // IR-2). The rc reports which fallthrough path was hit, not whether the command
  // exists, and it is cwd-dependent — in a session-bearing cwd the same tokens
  // become a real prompt delivery. `No acpx session found` is the ABSENT control:
  // its presence would mean the token had been absorbed by the agent path.
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDefaultCommands(program, fakeConfig());

  let message = "";
  try {
    await program.parseAsync(["output-styles", "zzz-bogus-subverb"], { from: "user" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.ok(message.length > 0, "a bogus subverb must be rejected by the parser, not absorbed");
  assert.match(message, /too many arguments/i);
  assert.doesNotMatch(
    message,
    /No acpx session found/,
    "the agent-catch-all string must be ABSENT — its presence means the verb is not registered",
  );
});
