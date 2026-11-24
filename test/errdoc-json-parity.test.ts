import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { detectRequestedOutputFormat } from "../src/cli-core.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import { resolveRequestedFormat } from "../src/cli/flags.js";
import type { OutputFormat } from "../src/types.js";

// brick ec04ee32 — PARITY: the argv scan behind the error document must reach the answer the verbs' own resolver
// (`resolveRequestedFormat`, the one precedence) reaches for the same words. Each row parses `argv` through a real
// commander tree (program > group > leaf, each declaring `--format` and `--json`, program positional like acpx's),
// then compares the resolver on the parsed leaf with the scan on the raw argv. Separate from errdoc-json.test.ts
// because it imports the scan, which base does not export.

const config = (format: string): ResolvedAcpxConfig => ({ format }) as ResolvedAcpxConfig;

function parsedTree(argv: string[]): { program: Command; leaf: Command } {
  const build = (name: string, parent?: Command): Command => {
    const command = parent ? parent.command(name) : new Command(name);
    command.option("--format <fmt>").option("--json").exitOverride();
    return command;
  };
  const program = build("acpx");
  program.enablePositionalOptions().option("--cwd <dir>");
  const group = build("group", program);
  const leaf = build("leaf", group);
  leaf.argument("[rest...]").action(() => undefined);
  group.action(() => undefined);
  program.action(() => undefined);
  program.parse(argv, { from: "user" });
  return { program, leaf };
}

const ROWS: string[][] = [
  [],
  ["--json"],
  ["--format", "json"],
  ["--format", "quiet"],
  ["--format=text"],
  ["--format", "json", "group", "leaf"],
  ["--format", "json", "group", "leaf", "--format", "text"],
  ["--format", "text", "group", "leaf", "--format", "json"],
  ["--format", "quiet", "group", "leaf", "--json"],
  ["--format", "json", "group", "leaf", "--json", "--format", "text"],
  ["--format", "json", "group", "leaf", "--format", "text", "--json"],
  ["group", "leaf", "--json", "--format", "quiet"],
  ["group", "--format", "quiet", "leaf", "--json"],
  ["group", "--json", "leaf", "--format", "text"],
  ["--cwd", "/x", "group", "leaf", "--json"],
  ["--cwd", "/x", "--format", "json", "group", "leaf"],
  ["--json", "group", "leaf", "--format", "text"],
  ["group", "leaf", "operand", "--json"],
];

for (const configFormat of ["text", "json", "quiet"] as const) {
  test(`parity [config ${configFormat}]: the argv scan and the resolver pick the same format for the same words`, () => {
    for (const argv of ROWS) {
      let resolved: OutputFormat;
      let program: Command;
      try {
        const parsed = parsedTree(argv);
        program = parsed.program;
        resolved = resolveRequestedFormat(parsed.leaf, config(configFormat));
      } catch {
        // commander refused this row (an option its node does not declare): nothing to compare against
        continue;
      }
      assert.equal(
        detectRequestedOutputFormat(program, argv, configFormat),
        resolved,
        `[${argv.join(" ")}] with config ${configFormat}`,
      );
    }
  });
}

test("parity: the rows are not vacuous — most are parsed by commander and compared", () => {
  let compared = 0;
  for (const argv of ROWS) {
    try {
      parsedTree(argv);
      compared += 1;
    } catch {
      // refused
    }
  }
  assert.ok(compared >= ROWS.length - 3, `only ${compared} of ${ROWS.length} rows parsed`);
});

test("parity negative: the scan still ignores a value it cannot read, `--` ends it, and strict means json", () => {
  const { program } = parsedTree([]);
  const scan = (argv: string[], fallback: OutputFormat): OutputFormat =>
    detectRequestedOutputFormat(program, argv, fallback);
  assert.equal(scan(["group", "leaf", "--format", "bogus"], "text"), "text");
  assert.equal(scan(["group", "--", "--json"], "text"), "text");
  assert.equal(scan(["--json-strict", "group"], "text"), "json");
  assert.equal(scan(["group", "--json-strict=1"], "quiet"), "json");
  // a flag's value is not a command token: `--cwd group` swallows `group`, so `leaf`'s words stay the program's
  assert.equal(scan(["--cwd", "group", "--format", "json"], "text"), "json");
});
