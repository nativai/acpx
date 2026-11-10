import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// brick 5d7a23b6 — CONCEPTION §16 "Never fork. No `child_process` anywhere in the governor's code path"
// (TE finding F3). The governor's entry is a separate tsdown entry, `dist/capacity/governor/main.js`,
// and the bundler puts a module into a chunk by WHICH ENTRIES REACH IT — so the chunks this entry
// imports hold only modules the governor's own graph reaches. This test walks that graph as SHIPPED
// (the built entry and every relative chunk it imports, statically or by a literal dynamic import)
// and fails on any `node:child_process` / `child_process` specifier. `pnpm test` builds `dist/` first.
//
// ⚠️ A NEW IMPORT IN A GOVERNOR MODULE CAN TURN THIS RED THROUGH A LONG CHAIN (owners.ts →
// acp/agent-command.ts was one; session/persistence/repository.ts was another). The fix is to reach
// the pure piece through a child_process-free module (as src/capacity/leases.ts and
// src/session/persistence/session-base-dir.ts do), not to allowlist the chain.

const GOVERNOR_ENTRY = fileURLToPath(
  new URL("../../dist/capacity/governor/main.js", import.meta.url),
);
const SPECIFIER =
  /(?:^|[\s;}])(?:import|export)\s*(?:[\w*{}\s,$]*?\bfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
const FORBIDDEN = new Set(["node:child_process", "child_process"]);

/**
 * `unresolved`: relative specifiers that name no file. The bundle keeps JSDoc text such as
 * `{@link import("./session-tmp-dir.js")}`, which the pattern reads as a dynamic import; no runtime can
 * load a file that does not exist, so it is recorded, never followed. A FORBIDDEN specifier is flagged
 * even inside a comment — the conservative direction.
 */
type Walk = { files: string[]; offenders: string[][]; unresolved: string[] };

/** Every file reachable from `entry` by relative specifiers; each chain that ends in a forbidden one. */
export function walkImportGraph(entry: string): Walk {
  const parent = new Map<string, string>();
  const seen = new Set<string>();
  const offenders: string[][] = [];
  const unresolved: string[] = [];
  const stack = [entry];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2];
      if (FORBIDDEN.has(spec)) {
        const chain = [spec, file];
        for (let up = parent.get(file); up !== undefined; up = parent.get(up)) {
          chain.push(up);
        }
        offenders.push(chain);
      } else if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        if (!fs.existsSync(target)) {
          unresolved.push(`${spec} (in ${path.basename(file)})`);
          continue;
        }
        if (!parent.has(target) && target !== entry) {
          parent.set(target, file);
        }
        stack.push(target);
      }
    }
  }
  return { files: [...seen], offenders, unresolved };
}

test("F3: the BUILT governor entry's import graph reaches no node:child_process", () => {
  assert.ok(
    fs.existsSync(GOVERNOR_ENTRY),
    `${GOVERNOR_ENTRY} is missing — run \`pnpm run build\` (pnpm test does) before this file`,
  );
  const walk = walkImportGraph(GOVERNOR_ENTRY);
  assert.ok(walk.files.length >= 2, "positive control: the entry imports at least one chunk");
  const rel = (f: string) =>
    f.includes(path.sep) ? path.relative(path.dirname(GOVERNOR_ENTRY), f) : f;
  assert.deepEqual(
    walk.offenders.map((chain) => chain.map(rel).join(" <- ")),
    [],
    "a module on the governor's path imports child_process",
  );
});

test("F3 committed negative: the walker flags child_process behind a chain, static or literal dynamic, and ignores what is unreachable", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-gov-graph-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);
  write(
    "main.js",
    'import fs from "node:fs";\nimport { a } from "./a-1x2y.js";\nexport * from "./c.js";\n',
  );
  write("a-1x2y.js", 'import { b } from "./b.js";\nexport const a = 1;\n');
  write("b.js", 'import { spawn } from "node:child_process";\nexport const b = spawn;\n');
  write(
    "c.js",
    'export const c = () => import("child_process");\n/** {@link import("./gone.js")} */\n',
  );
  write("unreachable.js", 'import { exec } from "node:child_process";\n');
  const walk = walkImportGraph(path.join(dir, "main.js"));
  const chains = walk.offenders.map((chain) => chain.map((f) => path.basename(f)).join(" <- "));
  assert.deepEqual(chains.toSorted(), [
    "child_process <- c.js <- main.js",
    "node:child_process <- b.js <- a-1x2y.js <- main.js",
  ]);
  assert.ok(!walk.files.some((f) => f.endsWith("unreachable.js")));
  assert.deepEqual(
    walk.unresolved,
    ["./gone.js (in c.js)"],
    "a comment naming a missing file is not followed",
  );
});
