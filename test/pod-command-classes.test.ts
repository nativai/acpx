import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Command, Help } from "commander";
import { listBuiltInAgents } from "../src/agent-registry.js";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import { configurePublicCli } from "../src/cli-public.js";
import { registerAgentCommand, registerDefaultCommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import { addGlobalFlags } from "../src/cli/flags.js";
import {
  classifyArgv,
  COMMAND_CLASSES,
  COMMAND_TABLE,
  PRE_COMMANDER_PATHS,
  type Classification,
  type CommandClass,
} from "../src/pod/command-classes.js";
import { COMMAND_GRAMMAR, type GrammarNode } from "../src/pod/command-grammar.js";
import { POD_STARTING_BRANCH, ROUTE_TABLE, routeFor } from "../src/pod/placement-step.js";
import { agentPodName, placeOf } from "../src/pod/placement.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// brick b479441f — C1.2's conformance test (CONCEPTION r4 K2 "conformance test (gate)").
//
// ⚠️ EVERYTHING HERE IS DISCOVERED FROM THE REAL COMMANDER REGISTRATION, NOT FROM A HAND LIST — the
// same rule as `test/top-level-verbs.test.ts`. A test restating the paths would be exactly as
// incomplete as the table it checks. Each discovering check has a negative case: a FRESH command
// registered here, in no table, that the check must flag.

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

function valueFlags(command: Command): string[] {
  return command.options
    .filter((option) => option.required || option.optional)
    .flatMap((option) => [option.long, option.short].filter((flag): flag is string => !!flag))
    .toSorted();
}

/** The grammar commander actually registers, in `COMMAND_GRAMMAR`'s shape. */
/** Commander's own answer: does this command list an implicit `help` subcommand? (F1) */
function helpCommandOf(command: Command): { helpCommand?: true } {
  const listed = new Help()
    .visibleCommands(command)
    .some((c) => c.name() === "help" && !command.commands.includes(c));
  return listed ? { helpCommand: true } : {};
}

/** The program as `main` builds it — its `[prompt...]` action included, which decides its help. */
function realProgram(): Command {
  const program = new Command().enablePositionalOptions();
  addGlobalFlags(program);
  configurePublicCli({
    program,
    argv: [],
    config: fakeConfig(),
    requestedJsonStrict: false,
    topLevelVerbs: TOP_LEVEL_VERBS,
    listBuiltInAgents: () => [],
    detectAgentToken: () => ({ hasAgentOverride: false }),
    registerAgentCommand,
    registerDefaultCommands,
    handlePromptAction: async () => {},
  });
  return program;
}

function grammarFromCommander(extra?: (program: Command) => void): Record<string, GrammarNode> {
  const program = new Command();
  addGlobalFlags(program);
  registerDefaultCommands(program, fakeConfig());
  extra?.(program);
  const registered = new Set(program.commands.map((c) => c.name()));
  const claimed = [...TOP_LEVEL_VERBS].filter((v) => !registered.has(v)).toSorted();
  const grammar: Record<string, GrammarNode> = {
    "": {
      valueFlags: valueFlags(program),
      ...helpCommandOf(realProgram()),
      ...(claimed.length > 0 ? { claimed } : {}),
    },
  };
  const walk = (command: Command, prefix: string[]) => {
    for (const child of command.commands) {
      const p = [...prefix, child.name()];
      grammar[p.join(" ")] = {
        ...(child.aliases().length > 0 ? { aliases: child.aliases() } : {}),
        valueFlags: valueFlags(child),
        ...helpCommandOf(child),
      };
      walk(child, p);
    }
  };
  walk(program, []);
  const holder = new Command().enablePositionalOptions();
  registerAgentCommand(holder, "claude", fakeConfig());
  const agent = holder.commands[0];
  grammar["<agent>"] = {
    valueFlags: valueFlags(agent),
    children: agent.commands.map((command) => command.name()),
    ...helpCommandOf(agent),
  };
  return grammar;
}

/** Grammar paths with no class, and table entries no command answers — both directions. */
function tableDrift(grammar: Record<string, GrammarNode>): {
  unclassified: string[];
  dead: string[];
} {
  const paths = Object.keys(grammar);
  return {
    unclassified: paths.filter((p) => !(p in COMMAND_TABLE)).toSorted(),
    // `help` is commander's implicit help command: live only while some group has one (F1).
    dead: Object.keys(COMMAND_TABLE)
      .filter((p) =>
        p === "help" ? !Object.values(grammar).some((n) => n.helpCommand) : !(p in grammar),
      )
      .toSorted(),
  };
}

test("COMMAND_GRAMMAR equals what commander registers — every path, alias and value flag", () => {
  const expected = grammarFromCommander();
  assert.ok(Object.keys(expected).length > 90, "commander registered almost nothing — vacuous");
  assert.deepEqual(
    COMMAND_GRAMMAR,
    expected,
    `src/pod/command-grammar.ts has drifted from commander. Expected:\n${JSON.stringify(expected)}`,
  );
});

test("EVERY registered command path has a class, and every class entry is a registered path", () => {
  const drift = tableDrift(grammarFromCommander());
  assert.deepEqual(drift.unclassified, [], `paths with no class: ${drift.unclassified.join(", ")}`);
  assert.deepEqual(
    drift.dead,
    [],
    `classes for paths no command answers: ${drift.dead.join(", ")}`,
  );
});

test("the discovering check FLAGS a fresh unclassified command — negative case", () => {
  const drift = tableDrift(
    grammarFromCommander((program) => {
      program.command("zzz-fresh").command("deeper");
    }),
  );
  assert.deepEqual(drift.unclassified, ["zzz-fresh", "zzz-fresh deeper"]);
});

test("every class is in the closed set — and the check rejects one outside it", () => {
  const closed = new Set<string>(COMMAND_CLASSES);
  const outside = Object.entries(COMMAND_TABLE).filter(([, e]) => !closed.has(e.class));
  assert.deepEqual(outside, []);
  assert.equal(COMMAND_CLASSES.length, 8);
  assert.equal(closed.has("route"), false, "revision 3's 'default: route' is deleted (K2)");
});

test("the table's top-level verbs are exactly TOP_LEVEL_VERBS (the two registrations agree)", () => {
  const topLevel = Object.keys(COMMAND_TABLE).filter(
    (p) => p !== "" && p !== "<agent>" && !p.includes(" "),
  );
  assert.deepEqual(topLevel.toSorted(), [...TOP_LEVEL_VERBS].toSorted());
});

// ─── The light walker agrees with commander ──────────────────────────────────────────────────────

class Stop extends Error {}

/** The program exactly as `main` builds it, with every action replaced by a recorder. */
function commanderPathOf(argv: string[]): { path: string; opts: Record<string, unknown> } {
  const config = fakeConfig();
  const program = new Command()
    .name("acpx")
    .version("0")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  addGlobalFlags(program);
  const agents = listBuiltInAgents(config.agents);
  configurePublicCli({
    program,
    argv,
    config,
    requestedJsonStrict: false,
    topLevelVerbs: TOP_LEVEL_VERBS,
    listBuiltInAgents: () => agents,
    detectAgentToken: (tokens) => {
      const first = tokens.find((t) => !t.startsWith("-"));
      return { token: first, hasAgentOverride: tokens.includes("--agent") };
    },
    registerAgentCommand,
    registerDefaultCommands,
    handlePromptAction: async () => {},
  });
  let captured: { path: string; opts: Record<string, unknown> } | undefined;
  program.hook("preAction", (_root, action) => {
    const names: string[] = [];
    for (let c: Command | null = action; c && c !== program; c = c.parent) {
      names.unshift(c.name());
    }
    const isAgent = names.length > 0 && !TOP_LEVEL_VERBS.has(names[0]);
    const rest = isAgent ? names.slice(1) : names;
    captured = {
      path: isAgent && rest.length === 0 ? "<agent>" : rest.join(" "),
      opts: action.opts(),
    };
    throw new Stop();
  });
  for (const command of program.commands) {
    command.exitOverride();
  }
  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    // Commander's implicit help command / help option prints help and runs no action: path `help`.
    const code = (error as { code?: string }).code;
    if (code === "commander.help" || code === "commander.helpDisplayed") {
      return { path: "help", opts: {} };
    }
    if (!(error instanceof Stop)) {
      throw error;
    }
  }
  assert.ok(captured, `commander ran no action for ${JSON.stringify(argv)}`);
  return captured;
}

function requiredArgs(pathKey: string): string[] {
  const program = new Command();
  registerDefaultCommands(program, fakeConfig());
  let node: Command | undefined = program;
  for (const name of pathKey.split(" ")) {
    node = node?.commands.find((c) => c.name() === name);
  }
  const operands = (node?.registeredArguments ?? []).filter((a) => a.required).map(() => "arg-x");
  // Mandatory options (`.requiredOption`) too, or commander errors before any action.
  const mandatory = (node?.options ?? [])
    .filter((o) => o.mandatory && o.long)
    .flatMap((o) => [o.long as string, o.argChoices?.[0] ?? "opt-x"]);
  return [...operands, ...mandatory];
}

/**
 * Dummy operands and mandatory-option values that commander's parsers accept — found by asking
 * commander: an invalid operand is retried as a percent (a ceiling wants one); an invalid option
 * value takes the first choice commander's own error lists.
 */
function withValidOperands(p: string): string[] {
  let operand = "arg-x";
  const optionValues = new Map<string, string>();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const argv = p.split(" ");
    const required = requiredArgs(p);
    for (let i = 0; i < required.length; i += 1) {
      const token = required[i];
      if (token.startsWith("--")) {
        argv.push(token, optionValues.get(token) ?? required[i + 1]);
        i += 1;
      } else {
        argv.push(operand);
      }
    }
    try {
      commanderPathOf(argv);
      return argv;
    } catch (error) {
      const text = String(error);
      const choice =
        /option '(--[\w-]+) [^']*' argument '[^']*' is invalid\. Expected one of: ([\w-]+)/u.exec(
          text,
        );
      if (choice) {
        optionValues.set(choice[1], choice[2]);
      } else if (/is invalid for argument/u.test(text)) {
        operand = "90%";
      } else {
        throw error;
      }
    }
  }
  throw new Error(`no dummy operands satisfy ${p}`);
}

function classified(argv: string[]): Classification & { kind: "classified" } {
  const result = classifyArgv(argv, { builtInAgents: listBuiltInAgents({}) });
  assert.equal(result.kind, "classified", `${JSON.stringify(argv)} → ${JSON.stringify(result)}`);
  return result as Classification & { kind: "classified" };
}

/**
 * Paths commander runs an action for, found by asking commander. A path it runs none for must be a
 * group that only prints help — class `local` — or the exclusion would hide a real command.
 */
function runnablePaths(): string[] {
  const groups: string[] = [];
  const runnable = Object.keys(COMMAND_GRAMMAR)
    .filter((p) => p !== "" && p !== "<agent>")
    .filter((p) => {
      // A bare group (no action) makes commander print help: the oracle reports `help`.
      let runs = false;
      try {
        runs = commanderPathOf(withValidOperands(p)).path !== "help";
      } catch {
        runs = false;
      }
      if (!runs) {
        groups.push(p);
      }
      return runs;
    });
  for (const p of groups) {
    assert.equal(
      COMMAND_TABLE[p]?.class,
      "local",
      `${p} runs no action yet is not a help-only group`,
    );
  }
  return runnable;
}

test("classifyArgv finds the path commander dispatches to — for EVERY runnable path", () => {
  const paths = runnablePaths();
  assert.ok(paths.length > 80, "vacuous");
  for (const p of paths) {
    const argv = withValidOperands(p);
    assert.equal(classified(argv).path, commanderPathOf(argv).path, JSON.stringify(argv));
  }
});

test("…with a global value flag before the verb, under an agent, and through an alias", () => {
  for (const p of runnablePaths()) {
    const argv = ["--format", "json", "--cwd", "/tmp", ...withValidOperands(p)];
    assert.equal(classified(argv).path, commanderPathOf(argv).path, JSON.stringify(argv));
  }
  const agentChildren = COMMAND_GRAMMAR["<agent>"].children ?? [];
  for (const p of runnablePaths().filter((q) => agentChildren.includes(q.split(" ")[0]))) {
    const argv = ["claude", ...withValidOperands(p)];
    const ours = classified(argv);
    assert.equal(ours.path, commanderPathOf(argv).path, JSON.stringify(argv));
    assert.equal(ours.agent, "claude");
  }
  for (const [p, node] of Object.entries(COMMAND_GRAMMAR)) {
    for (const alias of node.aliases ?? []) {
      const argv = [...p.split(" ").slice(0, -1), alias, ...requiredArgs(p)];
      assert.equal(classified(argv).path, p, JSON.stringify(argv));
      assert.equal(commanderPathOf(argv).path, p);
    }
  }
});

test("prompt forms: bare text, an agent's text, `--agent` text — all the prompt actions", () => {
  const cases: Array<[string[], string]> = [
    [["fix", "the", "tests"], "<agent>"],
    [["claude", "fix", "the", "tests"], "<agent>"],
    [["claude", "--session-id", "s1", "sessions"], "sessions"],
    [["--agent", "./x", "fix", "sessions", "new"], ""],
    [["--agent", "./x", "claude", "hi"], "<agent>"],
    [["prompt", "--session-id", "s1", "hello"], "prompt"],
  ];
  for (const [argv, expected] of cases) {
    assert.equal(classified(argv).path, expected, JSON.stringify(argv));
    assert.equal(commanderPathOf(argv).path, expected, `commander: ${JSON.stringify(argv)}`);
  }
});

test("a value flag's VALUE is never read as a subcommand (the value-flag data is load-bearing)", () => {
  // `--filter-cwd new` at the `sessions` level: commander takes `new` as the value.
  const argv = ["sessions", "--filter-cwd", "new", "list"];
  assert.equal(commanderPathOf(argv).path, "sessions list");
  assert.equal(classified(argv).path, "sessions list");
});

test("the target the walker reads is the option commander parses", () => {
  const cases: Array<[string[], string, string]> = [
    [["prompt", "--session-id", "rec-1", "hi"], "sessionId", "rec-1"],
    [["claude", "prompt", "--seat", "seat-9", "hi"], "seat", "seat-9"],
    [
      ["cancel", "--session-url", "https://a/?session=rec-2"],
      "sessionUrl",
      "https://a/?session=rec-2",
    ],
    [["sessions", "set-metadata", "k", "v", "--session-id=rec-3"], "sessionId", "rec-3"],
  ];
  for (const [argv, optName, value] of cases) {
    assert.equal(commanderPathOf(argv).opts[optName], value, JSON.stringify(argv));
    assert.equal(classified(argv).target?.value, value, JSON.stringify(argv));
  }
  assert.deepEqual(classified(["sessions", "recover", "rec-4"]).target, {
    via: "operand",
    value: "rec-4",
  });
  // No selector, no target — never guessed.
  assert.equal(classified(["status"]).target, undefined);
});

test("an operand that names no subcommand at a level with subcommands is UNCLASSIFIED", () => {
  for (const argv of [
    ["seats", "zzz-new-verb"],
    ["sessions", "templates", "zzz"],
    ["claude", "sessions", "zzz"],
  ]) {
    const result = classifyArgv(argv, { builtInAgents: listBuiltInAgents({}) });
    assert.equal(result.kind, "unclassified", JSON.stringify(argv));
  }
});

test("help, version and the owner entry are `local`; a `-h` among prompt words is NOT help", () => {
  assert.equal(classified(["sessions", "new", "--help"]).help, true);
  assert.equal(classified(["seats", "help"]).class, "local", "a group's implicit help command");
  assert.equal(classified(["--version"]).class, "local");
  assert.equal(classified(["-V"]).class, "local");
  assert.equal(classified(["__queue-owner"]).class, "local");
  // ⚠️ the fail-open direction: an agent prompt's pass-through words are not options.
  const words = classified(["claude", "explain", "-h"]);
  assert.equal(words.path, "<agent>");
  assert.equal(words.help, false);
  assert.equal(classified(["prompt", "explain", "--version"]).class, "owner-ensure");
});

// ─── F1 (test-engineer, 045b3d71): `help` is a PROMPT word wherever commander has no help command ─

const HELP_PROMPTS: Array<[string[], string]> = [
  [["help"], ""],
  [["help", "sessions"], ""],
  [["--format", "json", "help"], ""],
  [["claude", "help"], "<agent>"],
  [["claude", "help", "me"], "<agent>"],
  [["claude", "--session-id", "X", "help", "me"], "<agent>"],
  [["--approve-all", "claude", "--session-id", "X", "help", "me"], "<agent>"],
  [
    ["--approve-all", "--cwd", "/w", "claude", "--session-id", "X", "--no-wait", "help", "me"],
    "<agent>",
  ],
];

test("F1: `help` among a prompt's words is a PROMPT (owner-ensure, not help) — as commander parses it", () => {
  for (const [argv, path] of HELP_PROMPTS) {
    assert.equal(commanderPathOf(argv).path, path, `commander: ${JSON.stringify(argv)}`);
    const c = classified(argv);
    assert.equal(c.path, path, JSON.stringify(argv));
    assert.equal(c.class, "owner-ensure", JSON.stringify(argv));
    assert.equal(c.help, false, JSON.stringify(argv));
  }
  // Where commander DOES have a help command (a group with no action), `help` is help.
  for (const argv of [
    ["seats", "help"],
    ["people", "help"],
    ["subscriptions", "ceiling", "help"],
  ]) {
    assert.equal(commanderPathOf(argv).path, "help", JSON.stringify(argv));
    assert.equal(classified(argv).path, "help", JSON.stringify(argv));
  }
  // A group WITH an action has no help command: `sessions help` is an operand naming nothing.
  assert.equal(classifyArgv(["sessions", "help"], { builtInAgents: [] }).kind, "unclassified");
});

test("F1: the grammar says which commands have a help command — the program and agents have none", () => {
  assert.equal(COMMAND_GRAMMAR[""].helpCommand, undefined, "the program has a [prompt...] action");
  assert.equal(COMMAND_GRAMMAR["<agent>"].helpCommand, undefined, "an agent has a prompt action");
  assert.equal(COMMAND_GRAMMAR.seats.helpCommand, true);
  assert.equal(COMMAND_GRAMMAR.sessions.helpCommand, undefined, "sessions lists by itself");
  assert.deepEqual(COMMAND_GRAMMAR[""].claimed, ["help"], "TOP_LEVEL_VERBS' unregistered token");
});

test("one-shot's from-records form: `sessions list --local` runs from records, without it not", () => {
  assert.equal(classified(["sessions", "list", "--local"]).fromRecords, true);
  assert.equal(classified(["sessions", "--local"]).fromRecords, true);
  assert.equal(classified(["sessions", "list"]).fromRecords, false);
  assert.equal(classified(["exec", "hi"]).fromRecords, false);
});

// ─── The C1.2 guarantees, over every path ────────────────────────────────────────────────────────

const BRIDGE_CAPABLE: ReadonlySet<CommandClass> = new Set([
  "owner-ensure",
  "owner-if-pod",
  "create",
  "one-shot",
]);

test("in pod mode on the control pod NO bridge-capable path runs locally — every path", () => {
  for (const [p, entry] of Object.entries(COMMAND_TABLE)) {
    const route = routeFor(entry.class, "control", false);
    if (BRIDGE_CAPABLE.has(entry.class)) {
      assert.equal(
        route.kind,
        "branch",
        `${p} (${entry.class}) would run locally on the control pod`,
      );
    }
  }
  // The from-records form is local only for one-shot, and only by an explicit per-path flag.
  for (const cls of COMMAND_CLASSES) {
    if (cls !== "one-shot" && BRIDGE_CAPABLE.has(cls)) {
      assert.equal(routeFor(cls, "control", true).kind, "branch", cls);
    }
  }
});

test("ONLY owner-ensure may reach the pod-starting branch, in any place", () => {
  for (const cls of COMMAND_CLASSES) {
    for (const place of ["control", "own-pod", "other-pod"] as const) {
      for (const fromRecords of [false, true]) {
        const route = routeFor(cls, place, fromRecords);
        const starts = route.kind === "branch" && route.branch === POD_STARTING_BRANCH;
        assert.equal(starts, cls === "owner-ensure" && place === "control", `${cls}@${place}`);
      }
    }
  }
});

test("the route table is total and is C1.2 cell for cell", () => {
  const show = (cls: CommandClass) =>
    (["control", "own-pod", "other-pod"] as const).map((place) => {
      const r = ROUTE_TABLE[cls][place];
      return r.kind === "local" ? "local" : r.branch;
    });
  assert.deepEqual(show("read"), ["local", "local", "local"]);
  assert.deepEqual(show("record"), ["local", "local", "pass-through"]);
  assert.deepEqual(show("create"), ["record-only-create", "pass-through", "pass-through"]);
  assert.deepEqual(show("control-store"), ["local", "pass-through", "pass-through"]);
  assert.deepEqual(show("owner-ensure"), ["routed-ensure", "local", "message-route"]);
  assert.deepEqual(show("owner-if-pod"), ["routed-if-pod", "local", "pass-through"]);
  assert.deepEqual(show("one-shot"), ["utility-pod", "local", "local"]);
  assert.deepEqual(show("local"), ["local", "local", "local"]);
});

// ─── Route before loading the world ──────────────────────────────────────────────────────────────

// `import … from "x"`, `export … from "x"`, and a bare `import "x"`. The `from` is mandatory in the
// first form: an optional one made this read string literals in the class table as specifiers.
const STATIC_IMPORT =
  /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?[\w*{}\s,$]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gmu;

/** Every source file statically reachable from `entry` (type-only imports included — conservative). */
function staticGraph(entry: string): { files: string[]; externals: string[] } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const stack = [entry];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    for (const match of fs.readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      const spec = match[1] ?? match[2];
      if (spec.startsWith(".")) {
        stack.push(path.resolve(path.dirname(file), spec).replace(/\.js$/u, ".ts"));
      } else {
        externals.add(spec);
      }
    }
  }
  return {
    files: [...files].map((f) => path.relative(SRC, f)).toSorted(),
    externals: [...externals],
  };
}

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

test("the light graph: the CLI entry and the class table reach no commander and no handler", () => {
  for (const entry of ["cli.ts", "pod/command-classes.ts", "pod/placement-step.ts"]) {
    const graph = staticGraph(path.join(SRC, entry));
    assert.ok(graph.files.length >= 2, `${entry}: walked nothing — vacuous`);
    const heavy = graph.files.filter(
      (f) =>
        !f.startsWith("pod/") &&
        ![
          "cli.ts",
          "agent-registry.ts",
          "config/control-pod.ts",
          "cli/queue/paths.ts",
          "session/persistence/session-base-dir.ts",
        ].includes(f),
    );
    assert.deepEqual(heavy, [], `${entry} statically reaches heavy modules`);
    assert.deepEqual(
      graph.externals.filter((e) => !e.startsWith("node:")),
      [],
      `${entry} statically imports packages`,
    );
    assert.ok(!graph.files.includes("pod/target-resolver.ts"), "the resolver is dynamic-only");
  }
});

test("the light-graph check FLAGS a heavy import — negative case", () => {
  const dir = fs.mkdtempSync(path.join(SRC, "..", ".pod-graph-probe-"));
  try {
    const entry = path.join(dir, "entry.ts");
    fs.writeFileSync(entry, 'import { Command, Help } from "commander";\nimport "./next.js";\n');
    fs.writeFileSync(path.join(dir, "next.ts"), "export const x = 1;\n");
    const graph = staticGraph(entry);
    assert.deepEqual(graph.externals, ["commander"]);
    assert.equal(graph.files.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── The export atrium loads (C6.2) ──────────────────────────────────────────────────────────────

test("classifyCall: class + target for the server; target resolved only where the class needs it", async () => {
  const { classifyCall } = await import("../src/pod/command-classes.js");
  const create = await classifyCall(["sessions", "new", "--name", "x"]);
  assert.equal(create.kind, "classified");
  assert.equal(create.kind === "classified" && create.class, "create");
  assert.ok(
    create.kind === "classified" && !("targetSessionId" in create),
    "create needs no target",
  );
  const record = await classifyCall([
    "sessions",
    "set-metadata",
    "k",
    "v",
    "--session-id",
    "no-such-session",
  ]);
  assert.ok(record.kind === "classified" && record.class === "record");
  assert.equal(
    record.kind === "classified" && record.targetSessionId,
    null,
    "an unresolvable target is null, never guessed",
  );
  const none = await classifyCall(["cancel"]);
  assert.equal(none.kind === "classified" && none.targetSessionId, null);
  assert.equal((await classifyCall(["seats", "zzz"])).kind, "unclassified");
});

test("classifyCall resolves a REAL record — by record id, by ACP id, and the own-pod check on it", async () => {
  const { classifyCall } = await import("../src/pod/command-classes.js");
  await withTempHome("acpx-pod-classify-", async (home) => {
    const recordId = "9b1e6a52-6a0f-4c3e-9f55-2f1d3f0c7a11";
    const acpId = "3c2d1e0f-1111-4222-8333-444455556666";
    await writeSessionRecordFile(
      home,
      makeSessionRecord({
        acpxRecordId: recordId,
        acpSessionId: acpId,
        agentCommand: "agent",
        cwd: home,
      }),
    );
    for (const selector of [recordId, acpId]) {
      const c = await classifyCall([
        "sessions",
        "set-metadata",
        "k",
        "v",
        "--session-id",
        selector,
      ]);
      assert.equal(c.kind === "classified" && c.targetSessionId, recordId, selector);
    }
    const viaUrl = await classifyCall([
      "cancel",
      "--session-url",
      `https://atrium.example/?session=${recordId}`,
    ]);
    assert.equal(viaUrl.kind === "classified" && viaUrl.targetSessionId, recordId);
    // F4: `people set-owner` names its session by the REQUIRED `--session <id|url>`; no default.
    const owner = await classifyCall([
      "people",
      "set-owner",
      "laatz",
      "--session",
      `https://atrium.example/?session=${recordId}`,
    ]);
    assert.equal(owner.kind === "classified" && owner.targetSessionId, recordId, "--session url");
    const noSelector = await classifyCall(["people", "set-owner", "laatz"]);
    assert.equal(
      noSelector.kind === "classified" && noSelector.targetSessionId,
      null,
      "no caller default: commander refuses this argv, so it names no session",
    );
    // The resolved id is what decides "own pod": the pod named for it, and no other.
    assert.equal(placeOf({ kind: "pod", name: agentPodName(recordId) }, recordId), "own-pod");
    assert.equal(placeOf({ kind: "pod", name: agentPodName(acpId) }, recordId), "other-pod");
  });
});

test("the SHIPPED bundle: dist/cli.js and dist/pod/command-classes.js statically reach node builtins only", () => {
  // `pnpm test` builds dist/ first (as test/governor-import-graph.test.ts relies on). The bundler
  // chunks by which entries reach a module, so this walks what actually ships, not the sources.
  const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
  for (const entry of ["cli.js", "pod/command-classes.js"]) {
    const file = path.join(dist, entry);
    assert.ok(fs.existsSync(file), `${entry} not built`);
    const seen = new Set<string>();
    const externals = new Set<string>();
    const stack = [file];
    for (let f = stack.pop(); f !== undefined; f = stack.pop()) {
      if (seen.has(f)) {
        continue;
      }
      seen.add(f);
      for (const match of fs.readFileSync(f, "utf8").matchAll(STATIC_IMPORT)) {
        const spec = match[1] ?? match[2];
        if (spec.startsWith(".")) {
          stack.push(path.resolve(path.dirname(f), spec));
        } else {
          externals.add(spec);
        }
      }
    }
    assert.ok(seen.size >= 2, `${entry}: walked nothing — vacuous`);
    assert.deepEqual(
      [...externals].filter((e) => !e.startsWith("node:")),
      [],
      entry,
    );
    assert.ok(
      seen.size <= 10,
      `${entry} statically reaches ${seen.size} chunks — the world crept in`,
    );
  }
});

// A-8 (block A8, brick 88112988): "every classified command, run in an agent pod, trips no
// foreign-write guard". The guard (`src/pod/foreign-write-guard.ts`) throws at the writers of the
// index, the seat store, the registries and the admission ledger. A command can reach one only by
// running LOCALLY in an agent pod with a class that may touch box-wide stores (C1.2's "What it may
// touch": `create` and `control-store`). Discovered from the real table and the real route table,
// not a hand list: every entry's class, in both agent-pod places.
// The classes that DO run locally in an agent pod write the session's own record only; that no index
// half and no box-wide write comes with it is `test/pod-foreign-write-guard.test.ts` (an own record
// write in an agent pod writes no index; a plain read persists nothing).
test("A-8: no classified command that touches box-wide stores runs locally in an agent pod", () => {
  const BOX_WIDE_CLASSES = new Set<CommandClass>(["create", "control-store"]);
  const reachesBoxWideLocally = (cls: CommandClass, route: { kind: string }): boolean =>
    BOX_WIDE_CLASSES.has(cls) && route.kind === "local";
  const entries = [...Object.entries(COMMAND_TABLE), ...Object.entries(PRE_COMMANDER_PATHS)];
  assert.ok(entries.length >= 90, `positive control: ${entries.length} entries`);
  const offenders: string[] = [];
  for (const [commandPath, entry] of entries) {
    for (const place of ["own-pod", "other-pod"] as const) {
      if (reachesBoxWideLocally(entry.class, routeFor(entry.class, place))) {
        offenders.push(`${commandPath} (${entry.class}, ${place})`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  // negative case: the predicate flags a box-wide class given a local route, and not a plain read.
  assert.equal(reachesBoxWideLocally("control-store", { kind: "local" }), true);
  assert.equal(reachesBoxWideLocally("create", { kind: "local" }), true);
  assert.equal(reachesBoxWideLocally("read", { kind: "local" }), false);
});

// block A7 / C1.2 rule 5 — NO SQLITE IN AN AGENT POD. Two halves, both discovered (no hand list of
// modules): (a) `node:sqlite` is required in ONE place, the guarded loader (`src/pod/sqlite-loader.ts`),
// so a command that runs locally in an agent pod and reaches a database meets the guard; (b) every
// CLI handler module that reaches a SQLite-opening module is named below with the verbs that open it,
// and each such verb PASSES THROUGH in an agent pod — it never runs there. A fresh handler that
// imports a database module is flagged until it is named here. The loader's own behaviour (refusal
// before load, per database, with its negative cases) is `test/pod-no-sqlite.test.ts`.
test("A7: the one loader is guarded, and every verb that opens a database passes through in an agent pod", () => {
  const SQLITE_MODULES = [
    "models/ui-prefs-store.js",
    "session/archive/liveness.js",
    "spawn-ledger.js",
    "pod/sqlite-loader.js",
  ];
  const HANDLER_VERBS: Record<string, readonly string[]> = {
    "cli/models-command.ts": [
      "models fav",
      "models fav add",
      "models fav rm",
      "models last-used",
      "models last-used set",
    ],
    "cli/archive-command.ts": ["sessions archive", "sessions restore", "sessions prune"],
  };
  const importers = (root: string): string[] =>
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .filter((name) =>
        SQLITE_MODULES.some((module) =>
          new RegExp(`from "\\.\\./${module.replace(/[.]/g, "\\.")}"`).test(
            fs.readFileSync(path.join(root, name), "utf8"),
          ),
        ),
      )
      .map((name) => `cli/${name}`)
      .toSorted();
  const cliRoot = path.resolve("src", "cli");
  assert.deepEqual(importers(cliRoot), Object.keys(HANDLER_VERBS).toSorted());
  // negative: a fresh handler importing a database module is flagged by the same discovery.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-a7-handlers-"));
  fs.writeFileSync(
    path.join(fresh, "fresh-command.ts"),
    'import { openUiPrefsStore } from "../models/ui-prefs-store.js";\n',
  );
  fs.writeFileSync(path.join(fresh, "unrelated.ts"), 'import fs from "node:fs";\n');
  assert.deepEqual(importers(fresh), ["cli/fresh-command.ts"]);
  for (const [handler, verbs] of Object.entries(HANDLER_VERBS)) {
    for (const verb of verbs) {
      const entry = COMMAND_TABLE[verb];
      assert.ok(entry, `${handler}: ${verb} has no class entry`);
      for (const place of ["own-pod", "other-pod"] as const) {
        assert.notEqual(
          routeFor(entry.class, place).kind,
          "local",
          `${verb} (${entry.class}) runs locally in an agent pod (${place}) and opens a database`,
        );
      }
    }
  }
});

test("C6.2's inherit list is exported, closed, and exactly the contract's start", async () => {
  const { PASS_THROUGH_INHERIT } = await import("../src/pod/command-classes.js");
  assert.deepEqual([...PASS_THROUGH_INHERIT], ["ACPX_SUBSCRIPTION", "ATRIUM_OS"]);
  assert.ok(!PASS_THROUGH_INHERIT.includes("ACPX_SESSION_URL"), "identity never inherits");
});

test("the class-table module exports C1.1's predicate itself — no twin to drift", async () => {
  const exported = await import("../src/pod/command-classes.js");
  const placement = await import("../src/pod/placement.js");
  assert.equal(exported.podModeVerdict, placement.podModeVerdict, "the same function, not a copy");
  assert.equal(exported.podModeVerdictNow, placement.podModeVerdictNow);
  assert.deepEqual(exported.podModeVerdictNow({}), { mode: "off", why: "switch-unset" });
  // Live facts: this test host is not the canonical home under a temp HOME → off, never pod.
  assert.notEqual(exported.podModeVerdictNow({ ACPX_OWNER_PLACEMENT: "pod" }).mode, "pod");
});

test("the argv shapes atrium really sends classify as expected (acpx-ui origin/master)", () => {
  // Copied from acpx-ui server code, not invented: the production shape, not the convenient one.
  const cases: Array<[string[], string, CommandClass]> = [
    // server/promptInvocation.ts:131
    [
      [
        "--approve-all",
        "--cwd",
        "/workspace",
        "claude",
        "prompt",
        "--no-wait",
        "--session-id",
        "S",
        "--batch-file",
        "-",
      ],
      "prompt",
      "owner-ensure",
    ],
    // server/promptInvocation.ts:138
    [
      ["--approve-all", "--cwd", "/workspace", "codex", "prompt", "--no-wait"],
      "prompt",
      "owner-ensure",
    ],
    // server/admitWake.ts:191
    [
      ["--format", "json", "capacity", "admit-wake", "--session-id", "S", "--class", "delivery"],
      "capacity admit-wake",
      "control-store",
    ],
    // server/capacityQueue.ts:582
    [
      ["--format", "json", "capacity", "--class", "automation", "--agent", "claude", "--need", "1"],
      "capacity",
      "control-store",
    ],
    // server/index.ts:15008
    [
      [
        "--approve-all",
        "--cwd",
        "/w",
        "--format",
        "json",
        "claude",
        "set",
        "model",
        "opus",
        "--session-id",
        "S",
      ],
      "set",
      "owner-if-pod",
    ],
    // server/sessionTemplateMark.ts:77
    [
      ["--format", "json", "sessions", "template", "S", "--enable"],
      "sessions template",
      "control-store",
    ],
    // server/sessionArchiveRetention.ts:493
    [
      ["sessions", "archive", "--compress", "--apply", "--max-bytes", "1", "--json"],
      "sessions archive",
      "control-store",
    ],
    // server/acpxSubscriptionsUsage.ts:258
    [["--format", "json", "claude", "subscriptions", "usage"], "subscriptions usage", "read"],
    // server/sessionCreate.ts:1817 (+ telegram's template fork)
    [["--cwd", "/workspace", "claude", "sessions", "new", "--name", "x"], "sessions new", "create"],
    [
      ["claude", "sessions", "new", "--from-template", "T", "--name", "n", "--no-prompt"],
      "sessions new",
      "create",
    ],
  ];
  for (const [argv, expectedPath, expectedClass] of cases) {
    const c = classified(argv);
    assert.equal(c.path, expectedPath, JSON.stringify(argv));
    assert.equal(c.class, expectedClass, JSON.stringify(argv));
  }
  assert.equal(
    classified(["sessions", "template", "--help"]).help,
    true,
    "sessionTemplateMark.ts:56's probe",
  );
  assert.equal(classified(cases[0][0]).target?.value, "S");
});

// A-71 (brick 70921280): `sessions unparsable-leases` removes lease files of every session on the box and dates them
// by the CONTROL pod's start (`readControlPodStart`: /proc/1/stat in an agent pod would date the AGENT pod's start,
// and a lease younger than that start could be selected while live). Its entry — `control-store`, controlPodOnly —
// is what keeps it out of pods (`test/pod-proc-readers.test.ts` REVIEWED names this test). Both forms, census and
// `--apply`, must classify so; a change of class or of controlPodOnly fails here.
test("A-71: `sessions unparsable-leases` is control-store and controlPodOnly, in its census and --apply forms", () => {
  for (const argv of [
    ["sessions", "unparsable-leases"],
    ["--format", "json", "sessions", "unparsable-leases"],
    ["sessions", "unparsable-leases", "--apply"],
  ]) {
    const c = classified(argv);
    assert.equal(c.path, "sessions unparsable-leases", JSON.stringify(argv));
    assert.equal(c.class, "control-store", JSON.stringify(argv));
    assert.equal(c.controlPodOnly, true, JSON.stringify(argv));
  }
  // The class and the flag come from the table's own entry, not from a neighbour's.
  assert.equal(COMMAND_TABLE["sessions unparsable-leases"]?.class, "control-store");
  assert.equal(COMMAND_TABLE["sessions unparsable-leases"]?.controlPodOnly, true);
});

// brick 7686016f — THE FLAG THE CLI ACCEPTS AND THE TABLE DOES NOT LIST. `sessions close --seat <seat>` registered
// `--seat` (command-registration.ts, `addSeatSelectorOption`) while its class entry's target spec did not name it,
// so the classifier found no target and an agent pod's close-by-seat was refused `target-unresolved`.
// DERIVED FROM THE REAL COMMANDER REGISTRATION: for every registered path whose class decides acceptance by TARGET
// (record / owner-if-pod / owner-ensure), a registered `--seat` must be a target flag of its entry. (A create's `--seat`
// — `sessions new --seat` — means "into this seat", and `context --seat` is control-store: neither names a target.)
test("CONFORMANCE: every verb whose class is decided by its target and that registers --seat lists --seat as a target flag", () => {
  const grammar = grammarFromCommander();
  const targetClasses = new Set<CommandClass>(["record", "owner-if-pod", "owner-ensure"]);
  const withSeat = Object.entries(grammar)
    .filter(([, node]) => node.valueFlags.includes("--seat"))
    .map(([p]) => p);
  assert.ok(
    withSeat.length >= 5,
    `commander registers --seat on almost nothing — vacuous: ${withSeat.join(",")}`,
  );
  const missing = withSeat.filter((p) => {
    const entry = COMMAND_TABLE[p];
    return (
      entry !== undefined &&
      targetClasses.has(entry.class) &&
      !entry.target?.flags.includes("--seat")
    );
  });
  assert.deepEqual(
    missing,
    [],
    "these verbs accept --seat but their class entry's target does not name it: a seat address finds no target",
  );
  // The scan is not vacuous: the verbs this fixed and the ones that always had it are all in the set it judged.
  for (const verb of ["prompt", "cancel", "status", "sessions close"]) {
    assert.ok(withSeat.includes(verb), `${verb} registers --seat`);
  }
});
