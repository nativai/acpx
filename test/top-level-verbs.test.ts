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

/**
 * Is this verb ANSWERED by the CLI — measured, not looked up.
 *
 * ⚠️ WHY BEHAVIOURAL AND NOT `program.commands.includes(verb)`. `help` is absent
 * from `program.commands` yet `acpx help` works, because commander supplies it.
 * Counting it dead would be a false RED, and the usual fix for a false red is a
 * second hand-written exception list — the exact failure this file exists to
 * prevent. So the question is put to the parser instead: a token commander does
 * not know throws `commander.unknownCommand`; anything else means something
 * answered it. No private commander API, and it cannot drift when commander's
 * internals move.
 *
 * ⚠️ Safe to parse: registered verbs short-circuit on the name check BEFORE any
 * parse, so no command's action can fire. Only tokens that are NOT registered
 * commands reach the parser, where commander rejects or handles them without
 * running anything of ours.
 */
function isAnswered(verb: string): boolean {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDefaultCommands(program, fakeConfig());
  if (program.commands.some((command) => command.name() === verb)) {
    return true;
  }
  try {
    program.parse([verb], { from: "user" });
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "commander.unknownCommand";
  }
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

// ⚠️ THE CHECK ABOVE IS ONE DIRECTION OF TWO, AND ON ITS OWN IT IS HALF A SWEEP.
// REGISTERED ⊆ TOP_LEVEL_VERBS catches the eb9c1d1e shape (registered-but-unlisted
// ⇒ shadowed by an agent registration of its own name). The inverse,
// TOP_LEVEL_VERBS ⊆ REGISTERED, catches the OPPOSITE defect — a DEAD TOKEN:
// claimed by the set, so it can never register as an agent name, while no command
// answers it. Finding nothing in one direction says nothing about the other.
//
// It was one-directional until brick https://acpx.devbox.nativai.de/?brick=f99a1b30
// because `usage` was exactly such a dead token on `origin/dev` (the real verb is
// `subscriptions usage`, src/cli/subscriptions-command.ts). B0.2 reported it
// rather than fixing it, since deleting the entry lets an agent named `usage`
// register — a behaviour change that was not B0.2's to make. That entry is now
// deleted, which is what lets the inverse assertion exist.
//
// ⚠️ THE PIN IS THE POINT; THE DELETION WAS ONLY WHAT UNBLOCKED IT. Without the
// pin the next dead token is added exactly as silently as `usage` was.
test("EVERY entry in TOP_LEVEL_VERBS is a command that is actually answered", () => {
  assert.ok(registeredTopLevelNames().length > 0, "nothing was registered — test is vacuous");

  const dead = [...TOP_LEVEL_VERBS].filter((verb) => !isAnswered(verb)).toSorted();
  assert.deepEqual(
    dead,
    [],
    `these entries are claimed by TOP_LEVEL_VERBS but no command answers them, so each blocks ` +
      `an agent of that name while doing nothing: ${dead.join(", ")}`,
  );
});

test("the DEAD-TOKEN check can actually FAIL — mutation probe", () => {
  // ⚠️ Same reason as the probe below: an empty `dead` list is otherwise
  // indistinguishable from an enumeration that examined nothing. Present the
  // check a set entry no command answers — the exact `usage` shape — and require
  // it to be caught.
  const verbs = [...TOP_LEVEL_VERBS, "zzz-dead-token"];
  const dead = verbs.filter((verb) => !isAnswered(verb));
  assert.deepEqual(dead, ["zzz-dead-token"]);
});

test("`isAnswered` discriminates — its own two-sided control", () => {
  // ⚠️ The whole dead-token pin rests on this one predicate, so it is measured in
  // BOTH directions rather than assumed: an instrument that returns `true` for
  // everything would make the pin permanently green, and one that returns `false`
  // for everything would make it permanently red. Neither is distinguishable
  // from a working instrument by looking at the pin alone.
  assert.equal(isAnswered("help"), true, "commander supplies `help` — it is answered");
  assert.equal(isAnswered("sessions"), true, "a genuinely registered verb");
  assert.equal(isAnswered("zzz-not-a-command"), false, "an unknown token must read as UNANSWERED");
  assert.equal(
    isAnswered("usage"),
    false,
    "`usage` is the dead token f99a1b30 removed — it must read as unanswered, which is what " +
      "makes deleting it from TOP_LEVEL_VERBS correct rather than cosmetic",
  );
});

test("`usage` specifically — the dead token f99a1b30 removed", () => {
  // Named as well as discovered: the pin says WHETHER something is wrong, this
  // says WHICH, faster than re-reading a diff.
  assert.ok(!TOP_LEVEL_VERBS.has("usage"), "`usage` is a dead token — do not re-add it");
  assert.ok(
    !registeredTopLevelNames().includes("usage"),
    "no top-level `usage` command exists; the real verb is `subscriptions usage`",
  );
});

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
