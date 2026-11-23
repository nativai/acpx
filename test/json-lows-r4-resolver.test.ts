import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import { resolveRequestedFormat } from "../src/cli/flags.js";

// brick 3bc340d5 — the ONE format resolver, over a hand-built command tree (the real-CLI rows per family are in
// json-lows-r4.test.ts; this file is separate because it imports `resolveRequestedFormat`, which base does not have).

// ---- O1 unit: the one resolver, over a hand-built command tree -----------------------------------------------------

function tree(words: { program?: string[]; group?: string[]; leaf?: string[] }): Command {
  const build = (name: string, parent?: Command): Command => {
    const command = parent ? parent.command(name) : new Command(name);
    command.option("--format <fmt>").option("--json");
    command.exitOverride();
    command.action(() => undefined);
    return command;
  };
  const program = build("acpx");
  program.enablePositionalOptions();
  const group = build("group", program);
  const leaf = build("leaf", group);
  // parse each level's own words by setting them directly: what commander binds to a command is its own opts
  const set = (command: Command, argv: string[] | undefined): void => {
    for (let index = 0; index < (argv?.length ?? 0); index += 1) {
      if (argv?.[index] === "--json") {
        command.setOptionValue("json", true);
      } else if (argv?.[index] === "--format") {
        command.setOptionValue("format", argv[index + 1]);
        index += 1;
      }
    }
  };
  set(program, words.program);
  set(group, words.group);
  set(leaf, words.leaf);
  return leaf;
}
const config = (format: string): ResolvedAcpxConfig => ({ format }) as ResolvedAcpxConfig;

test("O1 unit: the NEAREST command's word wins (leaf, then group, then program), then the config, then text", () => {
  assert.equal(
    resolveRequestedFormat(
      tree({ program: ["--format", "json"], leaf: ["--format", "text"] }),
      config("quiet"),
    ),
    "text",
  );
  assert.equal(
    resolveRequestedFormat(
      tree({ program: ["--format", "text"], leaf: ["--format", "json"] }),
      config("quiet"),
    ),
    "json",
  );
  assert.equal(
    resolveRequestedFormat(
      tree({ program: ["--format", "json"], group: ["--format", "quiet"] }),
      config("text"),
    ),
    "quiet",
  );
  assert.equal(
    resolveRequestedFormat(
      tree({
        program: ["--format", "quiet"],
        group: ["--format", "json"],
        leaf: ["--format", "text"],
      }),
      config("json"),
    ),
    "text",
  );
  assert.equal(
    resolveRequestedFormat(tree({ program: ["--format", "quiet"] }), config("json")),
    "quiet",
  );
  assert.equal(resolveRequestedFormat(tree({}), config("json")), "json");
  assert.equal(resolveRequestedFormat(tree({}), config("text")), "text");
});

test("O1 unit: `--json` is `--format json` at its own level — nearest wins, and within one command it beats a `--format` beside it", () => {
  assert.equal(
    resolveRequestedFormat(
      tree({ program: ["--format", "text"], leaf: ["--json"] }),
      config("text"),
    ),
    "json",
  );
  assert.equal(
    resolveRequestedFormat(tree({ group: ["--json"], leaf: ["--format", "text"] }), config("json")),
    "text",
  );
  assert.equal(
    resolveRequestedFormat(tree({ leaf: ["--format", "text", "--json"] }), config("text")),
    "json",
  );
  assert.equal(resolveRequestedFormat(tree({ program: ["--json"] }), config("text")), "json");
});
