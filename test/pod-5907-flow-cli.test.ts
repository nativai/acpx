import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeWorld, withEnv, worldEnv } from "./pod-owner-helpers.js";

// Brick 59070d68, round 2 (TE F-1): the PRODUCTION path of rule (ii) is `acpx flow run` in the utility pod
// (A10 routes it there), driven here through the SHIPPED `dist/cli.js` (needs `pnpm build`). A second actor takes the
// session's lease between two nodes; the second node's direct send is refused. The refusal must exit 2 — CONTRACTS
// C7.2 `owner_outside_pod` (exit 2) — in text AND json mode, with the token line on stderr: atrium classifies a
// routed outcome by token + exit code (A-53, row 53.2).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CLI = path.join(REPO, "dist", "cli.js");
const MOCK = `node ${JSON.stringify(path.join(HERE, "mock-agent.js"))} --supports-load-session`;

function writeFlow(root: string, idFile: string): string {
  const flowFile = path.join(root, "f1cli.flow.mjs");
  const helpers = pathToFileURL(HERE).href;
  fs.writeFileSync(
    flowFile,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { acp, compute, defineFlow } from "acpx/flows";',
      "export default defineFlow({",
      '  name: "f1cli",',
      '  startAt: "first",',
      "  nodes: {",
      '    first: acp({ prompt: () => "echo first" }),',
      "    intrude: compute({",
      "      run: async ({ state }) => {",
      "        const id = Object.values(state.sessionBindings)[0].acpxRecordId;",
      `        const { makeWorld } = await import(${JSON.stringify(`${helpers}/pod-owner-helpers.js`)});`,
      `        const { writePodLease } = await import(${JSON.stringify(`${helpers}/pod-proof-helpers.js`)});`,
      "        const home = process.env.ACPX_STATE_HOME;",
      '        await writePodLease({ ...makeWorld("f1clio"), home }, id);',
      '        fs.writeFileSync(path.join(home, ".nv-agent"), process.env.NV_POD_NAME + "\\n");',
      `        fs.writeFileSync(${JSON.stringify(idFile)}, id);`,
      "        return { id };",
      "      },",
      "    }),",
      '    second: acp({ prompt: () => "echo second" }),',
      "  },",
      '  edges: [{ from: "first", to: "intrude" }, { from: "intrude", to: "second" }],',
      "});",
      "",
    ].join("\n"),
  );
  return flowFile;
}

for (const format of ["text", "json"] as const) {
  test(`C1.2-F.1 (ii) on the production path (${format}): the shipped \`acpx flow run\` in the utility pod, a second actor takes the lease between nodes — the refusal exits 2 with the owner_outside_pod token line on stderr`, () => {
    const world = makeWorld(`f1cli${format[0]}`);
    try {
      const idFile = path.join(world.root, "record-id.txt");
      const flowFile = writeFlow(world.root, idFile);
      return withEnv(
        worldEnv(world, { place: "agent-pod", podMode: true, extra: { HOME: world.home } }),
        () => {
          const run = spawnSync(
            process.execPath,
            [
              CLI,
              "--agent",
              MOCK,
              "--approve-all",
              "--cwd",
              world.home,
              "--format",
              format,
              "--ttl",
              "1",
              "flow",
              "run",
              flowFile,
            ],
            { env: process.env, encoding: "utf8", timeout: 120_000 },
          );
          const id = fs.existsSync(idFile)
            ? fs.readFileSync(idFile, "utf8")
            : "<intruder never ran>";
          const token = `acpx: REFUSED reason=owner_outside_pod session=${id}`;
          assert.ok(
            fs.existsSync(idFile),
            `the second actor took the lease: ${run.stderr.slice(-600)}`,
          );
          assert.equal(
            run.status,
            2,
            `exit code 2 (got ${run.status}); stderr: ${run.stderr.slice(-600)}`,
          );
          assert.ok(
            run.stderr.split("\n").some((line) => line === token),
            `the token line is a line of its own on stderr: ${run.stderr.slice(-600)}`,
          );
          if (format === "json") {
            const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
              error?: { code?: number; message?: string; data?: { acpxCode?: string } };
            };
            assert.equal(
              out.error?.data?.acpxCode,
              "USAGE",
              "the existing exit-2 refusals' JSON class",
            );
            assert.ok(
              out.error?.message?.startsWith(token),
              "the refusal is the JSON error's message",
            );
          }
          return undefined;
        },
      );
    } finally {
      fs.rmSync(world.root, { recursive: true, force: true });
    }
  });
}
