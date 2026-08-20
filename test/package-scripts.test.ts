import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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

  assert.match(coverageScript, /\bc8\b/);
  assert.match(coverageScript, /--all\b/);
  assert.match(coverageScript, /--check-coverage\b/);
  assert.match(coverageScript, /--lines 85\b/);
  assert.match(coverageScript, /--branches 85\b/);
  assert.match(coverageScript, /--functions 85\b/);
  assert.match(coverageScript, /--statements 85\b/);
  assert.match(coverageScript, /dist-test\/src\/flows\/schema\.js/);
  assert.match(coverageScript, /dist-test\/src\/runtime\/public\/\*\*\/\*\.js/);
  assert.match(coverageScript, /dist-test\/src\/runtime\/engine\/manager\.js/);
  // brick://113073b8 — this pins TWO properties, and the second is new.
  // (1) the full suite still runs BEFORE the c8-instrumented subset, as always;
  // (2) it runs THROUGH scripts/run-tests.mjs, the wrapper that tags and reaps the
  //     `__queue-owner` daemons the suite spawns.
  // ⚠ DO NOT "simplify" this back to a bare `node --test dist-test/test/*.test.js`.
  // It looks equivalent and is not: a bare runner silently reintroduces the leak
  // under `pnpm run check` — the suite strands ~26 owners from cli.test.js alone,
  // each living 30 minutes, which is what evicted this box's pod three times on
  // 2026-08-20. The leak is invisible to every other test in this repo.
  assert.match(coverageScript, /scripts\/run-tests\.mjs dist-test\/test\/\*\.test\.js && c8\b/);
  assert.match(coverageScript, /dist-test\/test\/flows\.test\.js/);
  assert.match(coverageScript, /dist-test\/test\/runtime-manager\.test\.js/);
  assert.match(coverageScript, /--exclude ['"]?dist\/\*\*\/\*\.js['"]?/);
});

test("slophammer is CI-only and enforces latest DRY plus dependency boundaries", () => {
  const pkg = readPackageJson();
  const ciWorkflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "ci.yml"),
    "utf8",
  );

  assert.equal(pkg.dependencies?.["slophammer-ts"], undefined);
  assert.equal(pkg.devDependencies?.["slophammer-ts"], undefined);
  assert.doesNotMatch(JSON.stringify(pkg.scripts ?? {}), /slophammer-ts/);
  assert.match(ciWorkflow, /pnpm dlx slophammer-ts@latest rules --format text/);
  assert.match(ciWorkflow, /pnpm dlx slophammer-ts@latest dry \./);
  assert.match(ciWorkflow, /pnpm dlx slophammer-ts@latest check \. --only/);
  assert.match(ciWorkflow, /ts\.dependency-boundaries-required/);
  assert.doesNotMatch(ciWorkflow, /assert-slophammer-rules-clean\.mjs/);
});

test("test scripts build packaged output before running package-bin smoke tests", () => {
  const pkg = readPackageJson();

  assert.match(pkg.scripts?.test ?? "", /^pnpm run build && pnpm run build:test && /);
  assert.match(pkg.scripts?.["test:coverage"] ?? "", /^pnpm run build && pnpm run build:test && /);
});

test("the full suite runs through the owner-reaping wrapper (brick://113073b8)", () => {
  const pkg = readPackageJson();

  // Both entry points that run the WHOLE suite must go through the wrapper. It is
  // what stamps ACPX_TEST_OWNER_TAG on every spawn, caps the owner idle-release
  // deadline for the run, and sweeps the run's leftovers afterwards. Without it the
  // suite leaks queue owners at a rate no drain matches (93 -> 111 live owners in
  // five minutes, measured 2026-08-20), and nothing else in this repo would notice.
  for (const script of ["test", "test:coverage"]) {
    assert.match(
      pkg.scripts?.[script] ?? "",
      /node scripts\/run-tests\.mjs dist-test\/test\/\*\.test\.js/,
      `${script} must run the full suite through scripts/run-tests.mjs`,
    );
  }
});
