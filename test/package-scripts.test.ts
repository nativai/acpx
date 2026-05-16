import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

type PackageJson = {
  scripts?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

test("lint script covers conformance runner sources", () => {
  const pkg = readPackageJson();
  const lintScript = pkg.scripts?.lint ?? "";

  assert.match(pkg.scripts?.["conformance:run"] ?? "", /\bconformance\/runner\/run\.ts\b/);
  assert.match(lintScript, /\bconformance\b/);
});

test("coverage script excludes generated package output", () => {
  const pkg = readPackageJson();
  const coverageScript = pkg.scripts?.["test:coverage"] ?? "";

  assert.match(coverageScript, /--test-coverage-exclude=dist\/\*\*\/\*\.js\b/);
});

test("test scripts build packaged output before running package-bin smoke tests", () => {
  const pkg = readPackageJson();

  assert.match(pkg.scripts?.test ?? "", /^pnpm run build && pnpm run build:test && /);
  assert.match(pkg.scripts?.["test:coverage"] ?? "", /^pnpm run build && pnpm run build:test && /);
});
