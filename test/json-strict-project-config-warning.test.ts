import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { suppressProjectConfigWarningForArgv } from "../src/cli/config.js";
import { runCli, tmpDir } from "./pod-a3-helpers.js";

// brick 9a49e76f (F-23, from the 20d6bce2 TE): on a control-role host whose cwd holds `.acpxrc.json`, config
// load wrote `acpx: ignoring project config … on the control pod` to stderr before any command ran — including
// under `--json-strict`, whose contract is an EMPTY stderr. Decision: SUPPRESS it under strict (the config is
// ignored either way, JSON documents have no shared envelope to carry a warning, text and plain json keep it).

const WARNING = /^acpx: ignoring project config .*\.acpxrc\.json.* on the control pod; /mu;

function controlHost(): { home: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = tmpDir("acpx-strictcfg-home-");
  const cwd = tmpDir("acpx-strictcfg-cwd-");
  fs.writeFileSync(path.join(cwd, ".acpxrc.json"), "{}\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NV_DEV_SERVER_ROLE: "control" };
  for (const name of ["ACPX_OWNER_PLACEMENT", "ACPX_POD_TEST_HOME", "ACPX_STATE_HOME"]) {
    delete env[name];
  }
  return { home, cwd, env };
}

test("F-23: under --json-strict a control-role host with .acpxrc.json in the cwd prints NOTHING on stderr — stdout is only the JSON document", async () => {
  const { cwd, env } = controlHost();
  const strict = await runCli(["--format", "json", "--json-strict", "agents", "list"], env, {
    cwd,
  });
  assert.equal(strict.status, 0, strict.stderr);
  assert.equal(strict.stderr, "", "json-strict's contract: empty stderr");
  assert.doesNotThrow(() => JSON.parse(strict.stdout), "stdout is only the document");
});

test("F-23 twin: the same host WITHOUT --json-strict still says it ignored the project config — once — in text and in plain json", async () => {
  const { cwd, env } = controlHost();
  for (const argv of [
    ["agents", "list"],
    ["--format", "json", "agents", "list"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stderr.split("\n").filter((line) => WARNING.test(line)).length,
      1,
      `${argv.join(" ")}: ${r.stderr}`,
    );
  }
});

test("F-23 negative: a host that is NOT control-role never ignores the project config, strict or not (nothing to say, nothing suppressed wrongly)", async () => {
  const { cwd, env } = controlHost();
  const plain = { ...env, NV_DEV_SERVER_ROLE: "workbench" };
  const r = await runCli(["--format", "json", "agents", "list"], plain, { cwd });
  assert.doesNotMatch(r.stderr, WARNING);
});

test("F-23: the suppression is decided from argv by the one setter every config-loading entry calls — `--json-strict`, `--json-strict=…`, and not after `--`", async () => {
  const warns = async (argv: string[]): Promise<boolean> => {
    const { cwd, env } = controlHost();
    const saved = process.env.NV_DEV_SERVER_ROLE;
    process.env.NV_DEV_SERVER_ROLE = env.NV_DEV_SERVER_ROLE;
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { loadResolvedConfig } = await import("../src/cli/config.js");
      suppressProjectConfigWarningForArgv(argv);
      await loadResolvedConfig(cwd);
    } finally {
      process.stderr.write = realWrite;
      if (saved === undefined) {
        delete process.env.NV_DEV_SERVER_ROLE;
      } else {
        process.env.NV_DEV_SERVER_ROLE = saved;
      }
      suppressProjectConfigWarningForArgv([]);
    }
    return written.some((line) => WARNING.test(line));
  };
  assert.equal(await warns(["--json-strict", "agents", "list"]), false);
  assert.equal(await warns(["--json-strict=true", "agents", "list"]), false);
  assert.equal(await warns(["agents", "list"]), true, "control: no strict, the warning is written");
  assert.equal(
    await warns(["agents", "--", "--json-strict"]),
    true,
    "a token after `--` is not a flag",
  );
});
