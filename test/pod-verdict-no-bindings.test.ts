import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Brick e8c77d5b, HoD #12's scope ruling, item (3): the armed verdict child is the shipped CLI (`process.argv[1]`,
// `dist/cli.js`). The network barrier (`src/pod/armed-guards.ts`) stops ACCIDENTAL network use by that trusted code at
// the public API. It cannot stop a DELIBERATE bypass (`process.binding('udp_wrap')`, `internalBinding`, a native
// `.node` addon, `process.dlopen`): that is the named residual for OS-level isolation. So this row proves the code the
// child actually loads contains none of them — by CONSTRUCTION: the guard module is the only chunk that may name a
// binding (it names them to refuse them), and every other occurrence is an offender. The walk is DISCOVERING: it
// follows every relative static and dynamic import from `cli.js`, and the bare-package imports into their own files.

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const DIST = path.join(REPO, "dist");
const NODE_MODULES = path.join(REPO, "node_modules");

const STATIC_IMPORT =
  /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?[\w*{}\s,$]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gmu;

/** A native-handle or addon reference: `process.binding`, `internalBinding`, a `*_wrap` binding name, a `.node` file, `process.dlopen`. */
const BINDING_REFERENCE =
  /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b|\binternalBinding\b|["'`][a-z0-9_]+_wrap["'`]|\.node["'`]/u;

/** The one chunk allowed to NAME a binding: the guard, which refuses them. */
const GUARD_CHUNK = /^armed-guards-.*\.js$/u;

/** Packages the child reaches only on paths it cannot run: `tsx` loads flow files (and esbuild, a spawned binary the permission model denies). */
const NOT_ON_THE_CHILD_PATH = new Set(["tsx"]);

type Offender = { file: string; hit: string };

function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(?:\*|\/\*|\/\/)/u.test(line))
    .join("\n");
}

function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...filesUnder(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Walks the shipped child (`<dist>/cli.js`) and its direct packages; returns what it reached and every binding reference outside the guard. */
function scanChild(
  dist: string,
  nodeModules: string,
): { chunks: string[]; packages: string[]; offenders: Offender[]; guardNames: number } {
  const chunks = new Set<string>();
  const packages = new Set<string>();
  const offenders: Offender[] = [];
  let guardNames = 0;
  const stack = [path.join(dist, "cli.js")];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (chunks.has(file)) {
      continue;
    }
    chunks.add(file);
    const text = code(file);
    const base = path.basename(file);
    if (GUARD_CHUNK.test(base)) {
      guardNames += BINDING_REFERENCE.test(text) ? 1 : 0;
    } else {
      for (const line of text.split("\n")) {
        if (BINDING_REFERENCE.test(line)) {
          offenders.push({ file: base, hit: line.trim().slice(0, 120) });
        }
      }
    }
    for (const match of text.matchAll(STATIC_IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? "";
      if (spec.startsWith(".")) {
        stack.push(path.resolve(path.dirname(file), spec));
      } else if (!spec.startsWith("node:")) {
        packages.add(packageOf(spec));
      }
    }
  }
  for (const name of packages) {
    if (NOT_ON_THE_CHILD_PATH.has(name)) {
      continue;
    }
    const dir = path.join(nodeModules, name);
    for (const file of filesUnder(fs.realpathSync(dir))) {
      const base = path.basename(file);
      if (base === "binding.gyp" || base.endsWith(".node")) {
        offenders.push({ file: `${name}/${base}`, hit: "a native addon" });
      } else if (/\.(?:c|m)?js$/u.test(base)) {
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          if (BINDING_REFERENCE.test(line)) {
            offenders.push({ file: `${name}/${base}`, hit: line.trim().slice(0, 120) });
          }
        }
      }
    }
  }
  return {
    chunks: [...chunks].map((f) => path.basename(f)),
    packages: [...packages],
    offenders,
    guardNames,
  };
}

test("the code the armed child loads names no process.binding, internalBinding, *_wrap binding or .node addon outside the guard", () => {
  assert.ok(fs.existsSync(path.join(DIST, "cli.js")), "dist/cli.js not built (pnpm run build)");
  const scan = scanChild(DIST, NODE_MODULES);
  // positive controls: the walk is not vacuous, it reached the guard (which DOES name bindings), and it reached the packages
  assert.ok(scan.chunks.length >= 10, `walked ${scan.chunks.length} chunks`);
  assert.ok(
    scan.chunks.some((c) => GUARD_CHUNK.test(c)),
    "the walk never reached the guard chunk (the dynamic import in armedVerdictRun)",
  );
  assert.equal(scan.guardNames, 1, "the scanner sees the bindings the guard names");
  assert.ok(
    scan.packages.includes("commander") && scan.packages.includes("zod"),
    String(scan.packages),
  );
  assert.deepEqual(scan.offenders, []);
});

/** A test-local copy of the walked tree, with `extra` appended to cli.js; a fake package when `addon` is set. */
function copyWith(extra: string, addon: boolean): { dist: string; nodeModules: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-no-bindings-"));
  const dist = path.join(root, "dist");
  fs.cpSync(DIST, dist, { recursive: true });
  const nodeModules = path.join(root, "node_modules");
  fs.mkdirSync(nodeModules);
  for (const name of scanChild(DIST, NODE_MODULES).packages) {
    if (!NOT_ON_THE_CHILD_PATH.has(name)) {
      fs.mkdirSync(path.dirname(path.join(nodeModules, name)), { recursive: true });
      fs.symlinkSync(fs.realpathSync(path.join(NODE_MODULES, name)), path.join(nodeModules, name));
    }
  }
  if (addon) {
    fs.mkdirSync(path.join(nodeModules, "fake-addon"));
    fs.writeFileSync(path.join(nodeModules, "fake-addon", "build.node"), "");
    fs.writeFileSync(path.join(nodeModules, "fake-addon", "index.js"), "module.exports = 1;\n");
  }
  fs.appendFileSync(path.join(dist, "cli.js"), extra);
  return { dist, nodeModules };
}

for (const [label, extra, addon] of [
  ["process.binding", '\nprocess.binding("udp_wrap");\n', false],
  ["internalBinding", '\nglobalThis.x = internalBinding("tcp_wrap");\n', false],
  ["a *_wrap name", '\nglobalThis.y = "cares_wrap";\n', false],
  ["process.dlopen", '\nprocess.dlopen(module, "x");\n', false],
  ["a .node addon file", '\nimport "fake-addon";\n', true],
] as const) {
  test(`the scan is RED on a test-local copy that adds ${label}`, () => {
    const copy = copyWith(extra, addon);
    const scan = scanChild(copy.dist, copy.nodeModules);
    assert.ok(scan.offenders.length >= 1, `${label}: not flagged`);
    assert.ok(
      scan.offenders.some((o) => o.file === "cli.js" || o.file.startsWith("fake-addon/")),
      JSON.stringify(scan.offenders),
    );
  });
}
