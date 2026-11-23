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

// <scanner>
const STATIC_IMPORT =
  /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?[\w*{}\s,$]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gmu;

/** A native-handle or addon reference: `process.binding`, `internalBinding`, a `*_wrap` binding name, a `.node` file, `process.dlopen`. Run over whitespace-joined, comment-free text, so a reference split across lines or interleaved with a comment is still one match. */
const BINDING_REFERENCE =
  /\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b|\binternalBinding\b|["'`][a-z0-9_]+_wrap["'`]|\.node["'`]/gu;

/** The one chunk allowed to NAME a binding: the guard, which refuses them. */
const GUARD_CHUNK = /^armed-guards-.*\.js$/u;

/** Packages the child reaches only on paths it cannot run: `tsx` loads flow files (and esbuild, a spawned binary the permission model denies). */
const NOT_ON_THE_CHILD_PATH = new Set(["tsx"]);

/** After one of these a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "void",
  "delete",
  "throw",
  "new",
  "instanceof",
  "yield",
  "await",
]);

type Offender = { file: string; hit: string };

/**
 * Removes line and block comments the way a tokenizer does: a comment opener inside a string, a template literal or a regular
 * expression literal is not a comment, and a template's `${ }` is code again. Newlines survive (a comment becomes a space plus
 * the newlines it held), so line structure stays for the import scan. `clean` is false when the file ends inside a string-like
 * token or a block comment: the scanner then cannot tell code from comment, and says so rather than guessing.
 */
function stripComments(source: string): { text: string; clean: boolean } {
  let out = "";
  let prevChar = "";
  let prevWord = "";
  let inWord = false;
  let clean = true;
  const templateDepths: number[] = [];
  let braces = 0;
  const emit = (chunk: string, valueLike: boolean): void => {
    out += chunk;
    prevChar = valueLike ? '"' : (chunk[chunk.length - 1] ?? "");
    prevWord = "";
    inWord = false;
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      out += " ";
    } else if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      clean = clean && close !== -1;
      out += ` ${source.slice(i, end).replace(/[^\n]/gu, "")}`;
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      clean = clean && source[j] === c;
      emit(source.slice(i, j + 1), true);
      i = j + 1;
    } else if (c === "`" || (c === "}" && templateDepths[templateDepths.length - 1] === braces)) {
      if (c === "}") {
        templateDepths.pop();
      }
      let j = i + 1;
      while (
        j < source.length &&
        source[j] !== "`" &&
        !(source[j] === "$" && source[j + 1] === "{")
      ) {
        j += source[j] === "\\" ? 2 : 1;
      }
      if (source[j] === "$") {
        templateDepths.push(braces);
        j += 2;
      } else {
        clean = clean && source[j] === "`";
        j += 1;
      }
      emit(source.slice(i, j), source[j - 1] === "`");
      i = j;
    } else if (
      c === "/" &&
      !(/[\w$)\]]/u.test(prevChar) && !REGEX_AFTER_WORD.has(prevWord)) &&
      prevChar !== '"'
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") {
          j += 1;
        } else if (source[j] === "[") {
          inClass = true;
        } else if (source[j] === "]") {
          inClass = false;
        }
        j += 1;
      }
      if (source[j] === "/") {
        emit(source.slice(i, j + 1), true);
        i = j + 1;
      } else {
        emit(c, false);
        i += 1;
      }
    } else {
      if (c === "{") {
        braces += 1;
      } else if (c === "}") {
        braces -= 1;
      }
      if (/[\w$]/u.test(c)) {
        prevWord = inWord ? prevWord + c : c;
        inWord = true;
      } else if (/\s/u.test(c)) {
        inWord = false;
      } else {
        prevWord = "";
        inWord = false;
      }
      if (!/\s/u.test(c)) {
        prevChar = c;
      }
      out += c;
      i += 1;
    }
  }
  return { text: out, clean: clean && templateDepths.length === 0 };
}

/** The comment-free text of a file; a file the tokenizer cannot close is itself reported. */
function code(file: string): { text: string; unparsed: boolean } {
  const { text, clean } = stripComments(fs.readFileSync(file, "utf8"));
  return { text, unparsed: !clean };
}

/** Every binding reference in `text`, whitespace-joined first: a split reference is one hit, shown with its surroundings. */
function bindingHits(text: string): string[] {
  const joined = text.replace(/\s+/gu, " ");
  return [...joined.matchAll(BINDING_REFERENCE)].map((m) =>
    joined.slice(Math.max(0, m.index - 20), m.index + 100).trim(),
  );
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

/** Where Node finds `name` from code in `fromDir`: `node_modules/<name>` in `fromDir` and each ancestor, skipping ancestors that are themselves `node_modules`. In pnpm's layout a package's own dependencies are its siblings, found this way. */
function resolvePackageDir(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name);
      if (fs.existsSync(candidate)) {
        return fs.realpathSync(candidate);
      }
    }
    if (path.dirname(dir) === dir) {
      return undefined;
    }
  }
}

function dependenciesOf(packageDir: string): { required: string[]; optional: string[] } {
  const manifestFile = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestFile)) {
    return { required: [], optional: [] };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return {
    required: Object.keys(manifest.dependencies ?? {}),
    optional: Object.keys(manifest.optionalDependencies ?? {}),
  };
}

/** Walks the shipped child (`<dist>/cli.js`), its direct packages and, recursively, the `dependencies` of every package it reaches; returns what it reached and every binding reference outside the guard. */
function scanChild(
  dist: string,
  nodeModules: string,
): {
  chunks: string[];
  direct: string[];
  packages: string[];
  offenders: Offender[];
  guardNames: number;
} {
  const chunks = new Set<string>();
  const direct = new Set<string>();
  const offenders: Offender[] = [];
  let guardNames = 0;
  const stack = [path.join(dist, "cli.js")];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (chunks.has(file)) {
      continue;
    }
    chunks.add(file);
    const { text, unparsed } = code(file);
    const base = path.basename(file);
    const hits = bindingHits(text);
    if (GUARD_CHUNK.test(base)) {
      guardNames += hits.length > 0 ? 1 : 0;
    } else {
      offenders.push(...hits.map((hit) => ({ file: base, hit })));
    }
    if (unparsed) {
      offenders.push({ file: base, hit: "ends inside a string, template or block comment" });
    }
    for (const match of text.matchAll(STATIC_IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? "";
      if (spec.startsWith(".")) {
        stack.push(path.resolve(path.dirname(file), spec));
      } else if (!spec.startsWith("node:")) {
        direct.add(packageOf(spec));
      }
    }
  }
  const reached = new Map<string, string>(); // real directory -> package name
  const queue: { name: string; dir: string }[] = [];
  for (const name of direct) {
    if (!NOT_ON_THE_CHILD_PATH.has(name)) {
      queue.push({ name, dir: fs.realpathSync(path.join(nodeModules, name)) });
    }
  }
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const { name, dir } = item;
    if (reached.has(dir)) {
      continue;
    }
    reached.set(dir, name);
    for (const file of filesUnder(dir)) {
      const base = path.basename(file);
      if (base === "binding.gyp" || base.endsWith(".node")) {
        offenders.push({ file: `${name}/${base}`, hit: "a native addon" });
      } else if (/\.(?:c|m)?js$/u.test(base)) {
        const { text, unparsed } = code(file);
        offenders.push(...bindingHits(text).map((hit) => ({ file: `${name}/${base}`, hit })));
        if (unparsed) {
          offenders.push({
            file: `${name}/${base}`,
            hit: "ends inside a string, template or block comment",
          });
        }
      }
    }
    const { required, optional } = dependenciesOf(dir);
    for (const dependency of [...required, ...optional]) {
      if (NOT_ON_THE_CHILD_PATH.has(dependency)) {
        continue;
      }
      const resolved = resolvePackageDir(dependency, dir);
      if (resolved !== undefined) {
        queue.push({ name: dependency, dir: resolved });
      } else if (required.includes(dependency)) {
        offenders.push({ file: `${name}/package.json`, hit: `dependency ${dependency} not found` });
      }
    }
  }
  return {
    chunks: [...chunks].map((f) => path.basename(f)),
    direct: [...direct],
    packages: [...new Set(reached.values())],
    offenders,
    guardNames,
  };
}
// </scanner>

const REAL = { scan: undefined as ReturnType<typeof scanChild> | undefined };
function realScan(): ReturnType<typeof scanChild> {
  REAL.scan ??= scanChild(DIST, NODE_MODULES);
  return REAL.scan;
}

test("the code the armed child loads names no process.binding, internalBinding, *_wrap binding or .node addon outside the guard", () => {
  assert.ok(fs.existsSync(path.join(DIST, "cli.js")), "dist/cli.js not built (pnpm run build)");
  const scan = realScan();
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

/**
 * A test-local copy of the walked tree, with `extra` appended to cli.js and `setup` free to add fake packages; `run` sees the
 * scan of the copy and the copy is removed again (`rm` does not follow the symlinks into the real node_modules).
 */
function onCopy(
  extra: string,
  setup: ((nodeModules: string) => void) | undefined,
  run: (scan: ReturnType<typeof scanChild>) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-no-bindings-"));
  try {
    const dist = path.join(root, "dist");
    fs.cpSync(DIST, dist, { recursive: true });
    const nodeModules = path.join(root, "node_modules");
    fs.mkdirSync(nodeModules);
    for (const name of realScan().direct) {
      if (!NOT_ON_THE_CHILD_PATH.has(name)) {
        fs.mkdirSync(path.dirname(path.join(nodeModules, name)), { recursive: true });
        fs.symlinkSync(
          fs.realpathSync(path.join(NODE_MODULES, name)),
          path.join(nodeModules, name),
        );
      }
    }
    setup?.(nodeModules);
    fs.appendFileSync(path.join(dist, "cli.js"), extra);
    run(scanChild(dist, nodeModules));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function addFakeAddon(nodeModules: string): void {
  fs.mkdirSync(path.join(nodeModules, "fake-addon"));
  fs.writeFileSync(path.join(nodeModules, "fake-addon", "build.node"), "");
  fs.writeFileSync(path.join(nodeModules, "fake-addon", "index.js"), "module.exports = 1;\n");
}

/**
 * Gap 1's fixture: pnpm's sibling layout. `fake-top` is what cli.js imports; the package it depends on, `fake-dep`, is NOT
 * under the top-level node_modules, only beside `fake-top` inside `.pnpm/<id>/node_modules/`. `depCode` is fake-dep's source.
 */
function addPnpmSiblings(depCode: string, topDependsOnDep = true): (nodeModules: string) => void {
  return (nodeModules) => {
    const store = path.join(nodeModules, ".pnpm", "fake-top@1.0.0", "node_modules");
    fs.mkdirSync(path.join(store, "fake-top"), { recursive: true });
    fs.mkdirSync(path.join(store, "fake-dep"), { recursive: true });
    fs.writeFileSync(
      path.join(store, "fake-top", "package.json"),
      JSON.stringify({
        name: "fake-top",
        dependencies: topDependsOnDep ? { "fake-dep": "1.0.0" } : {},
      }),
    );
    fs.writeFileSync(path.join(store, "fake-top", "index.js"), "module.exports = 1;\n");
    fs.writeFileSync(
      path.join(store, "fake-dep", "package.json"),
      JSON.stringify({ name: "fake-dep", dependencies: { "fake-top": "1.0.0" } }),
    );
    fs.writeFileSync(path.join(store, "fake-dep", "index.js"), depCode);
    fs.symlinkSync(path.join(store, "fake-top"), path.join(nodeModules, "fake-top"));
  };
}

for (const [label, extra, setup] of [
  ["process.binding", '\nprocess.binding("udp_wrap");\n', undefined],
  ["internalBinding", '\nglobalThis.x = internalBinding("tcp_wrap");\n', undefined],
  ["a *_wrap name", '\nglobalThis.y = "cares_wrap";\n', undefined],
  ["process.dlopen", '\nprocess.dlopen(module, "x");\n', undefined],
  ["a .node addon file", '\nimport "fake-addon";\n', addFakeAddon],
  // The new copies pass `"fs"`, not a `*_wrap` name: a quoted `*_wrap` string is flagged on its own, which would let a copy pass for the wrong reason.
  // gap 1 (R2-F1 a): a transitive dependency of a walked package, in pnpm's sibling layout
  [
    "GAP-1 a transitive dependency of a walked package (pnpm sibling layout)",
    '\nimport "fake-top";\n',
    addPnpmSiblings('process.binding("fs");\n'),
  ],
  // gap 2 (R2-F1 b): a reference split across lines
  ["GAP-2a process.binding split before the dot", '\nprocess\n  .binding("fs");\n', undefined],
  ["GAP-2b process.dlopen split after the dot", '\nprocess.\n  dlopen(module, "x");\n', undefined],
  [
    "GAP-2c process.binding with a comment between its parts",
    '\nprocess./* hidden */binding("fs");\n',
    undefined,
  ],
  // gap 3 (R2-F1 c): code on a line that starts with a block comment, or with the tail of one
  [
    "GAP-3a code after a block comment at the start of a line",
    '\n/* note */ process.binding("fs");\n',
    undefined,
  ],
  [
    "GAP-3b code after the closing of a block comment at the start of a line",
    '\n/* a note\n */ process.binding("fs");\n',
    undefined,
  ],
  // the tokenizer reads strings and regular expressions as such: a comment opener inside one hides nothing
  [
    "a binding after a // inside a string",
    '\nglobalThis.u = "http://x"; globalThis.y = "cares_wrap";\n',
    undefined,
  ],
  [
    "a binding after a regular expression holding quotes",
    '\nglobalThis.r = /["\'`]/; process.binding("fs");\n',
    undefined,
  ],
  [
    "a binding after a // inside a template literal",
    '\nglobalThis.t = `a // ${1 /* c */ + 1} b`; process.binding("fs");\n',
    undefined,
  ],
] as const) {
  test(`the scan is RED on a test-local copy that adds ${label}`, () => {
    onCopy(extra, setup, (scan) => {
      assert.ok(scan.offenders.length >= 1, `${label}: not flagged`);
      assert.ok(
        scan.offenders.some(
          (o) =>
            o.file === "cli.js" ||
            o.file.startsWith("fake-addon/") ||
            o.file === "fake-dep/index.js",
        ),
        JSON.stringify(scan.offenders),
      );
    });
  });
}

test("the scan walks a clean transitive dependency (and its cycle back) and stays green", () => {
  onCopy('\nimport "fake-top";\n', addPnpmSiblings("module.exports = 2;\n"), (scan) => {
    assert.ok(
      scan.packages.includes("fake-top") && scan.packages.includes("fake-dep"),
      String(scan.packages),
    );
    assert.ok(!scan.direct.includes("fake-dep"), "fake-dep is reached only through fake-top");
    assert.deepEqual(scan.offenders, []);
  });
});

test("a dependency the package lists but nothing resolves is reported, not skipped", () => {
  onCopy(
    '\nimport "fake-top";\n',
    (nodeModules) => {
      addPnpmSiblings("module.exports = 2;\n")(nodeModules);
      fs.rmSync(path.join(nodeModules, ".pnpm", "fake-top@1.0.0", "node_modules", "fake-dep"), {
        recursive: true,
      });
    },
    (scan) => {
      assert.deepEqual(scan.offenders, [
        { file: "fake-top/package.json", hit: "dependency fake-dep not found" },
      ]);
    },
  );
});

test("the scan stays GREEN where a comment, not code, names a binding", () => {
  const extra = [
    "",
    '// process.binding("fs") is refused by the guard',
    "/* internalBinding('tcp_wrap'),",
    '   process.dlopen(module, "x") */',
    '/** "cares_wrap" in a doc comment */',
    "globalThis.q = 4 / 2; // a division, then a comment: process.binding",
    'globalThis.s = "a /* not a comment */ b"; /* a real one */',
    "globalThis.t = `x ${globalThis.q /* c */ / 2} // not a comment`;",
    "",
  ].join("\n");
  onCopy(extra, undefined, (scan) => {
    assert.deepEqual(scan.offenders, []);
  });
});

test("a file that ends inside a block comment is reported, not silently read as clean", () => {
  onCopy('\n/* never closed process.binding("fs")\n', undefined, (scan) => {
    assert.ok(
      scan.offenders.some((o) => o.file === "cli.js" && o.hit.includes("ends inside")),
      JSON.stringify(scan.offenders),
    );
  });
});
