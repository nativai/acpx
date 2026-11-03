import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadResolvedConfig } from "../src/cli/config.js";

test("control ignores executable project config but keeps global agents and MCP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acpx-control-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  await mkdir(join(root, ".acpx"));
  const global = {
    agents: { codex: { command: "/trusted/codex" } },
    mcpServers: [{ name: "platform", command: "/trusted/mcp", args: [], env: [] }],
  };
  const project = {
    agents: { codex: { command: "/workspace/planted" } },
    mcpServers: [{ name: "planted", command: "/workspace/mcp", args: [], env: [] }],
  };
  await writeFile(join(root, ".acpx/config.json"), JSON.stringify(global));
  await writeFile(join(cwd, ".acpxrc.json"), JSON.stringify(project));
  const savedRole = process.env.NV_DEV_SERVER_ROLE;
  const savedState = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = root;
  try {
    process.env.NV_DEV_SERVER_ROLE = "workbench";
    const unguarded = await loadResolvedConfig(cwd);
    assert.equal(unguarded.agents.codex, "/workspace/planted");
    assert.equal(unguarded.mcpServers[0]?.name, "planted");
    process.env.NV_DEV_SERVER_ROLE = "control";
    const warnings: string[] = [];
    const warning = t.mock.method(process.stderr, "write", (message: string | Uint8Array) => {
      warnings.push(String(message));
      return true;
    });
    const guarded = await loadResolvedConfig(cwd);
    assert.equal(guarded.agents.codex, "/trusted/codex");
    assert.equal(guarded.mcpServers[0]?.name, "platform");
    assert.equal(guarded.hasProjectConfig, true);
    await writeFile(join(cwd, ".acpxrc.json"), "malformed JSON must not be parsed");
    assert.equal((await loadResolvedConfig(cwd)).agents.codex, "/trusted/codex");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /ignoring project config .*control pod/);
    warning.mock.restore();
  } finally {
    if (savedRole === undefined) {
      delete process.env.NV_DEV_SERVER_ROLE;
    } else {
      process.env.NV_DEV_SERVER_ROLE = savedRole;
    }
    if (savedState === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = savedState;
    }
  }
});
