import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isHomeOnlyHarness,
  PI_PLACEMENT_ENV,
  PI_PLACEMENT_FILE,
  readBoxFacts,
  resetPiPlacementWarningForTests,
} from "../src/pod/home-only.js";
import { utilityKeyFor } from "../src/pod/utility-branch.js";

// A-44 / A-45: the ONE function that says which harnesses are home-only on this box — read by the utility
// pod's key and by a session's placement. The condition is a PER-BOX fact (P1 on the box), never an acpx release.

const NO_P1 = { p1OnBox: false };
const P1 = { p1OnBox: true };

test("home-only: codex always; pi until P1 is on the box; claude, the terminal harness, utility and unknown never", () => {
  assert.equal(isHomeOnlyHarness("codex", NO_P1), true);
  assert.equal(isHomeOnlyHarness("codex", P1), true, "codex stays home with P1");
  assert.equal(isHomeOnlyHarness("pi", NO_P1), true);
  assert.equal(isHomeOnlyHarness("pi", P1), false, "with P1's fact, Pi leaves the home set");
  for (const harness of ["claude", "claude-pty", "utility", "gemini", undefined]) {
    assert.equal(isHomeOnlyHarness(harness, NO_P1), false, String(harness));
    assert.equal(isHomeOnlyHarness(harness, P1), false, String(harness));
  }
});

// P1: with no env signal the reader falls back to the release-pins FILE, which is box state. Rows below that
// carry no env value point the file seam at a missing path, or set the env to `home` where the row's subject
// is something else, so no row reads the box's own file.
const NO_FILE = {
  NODE_TEST_CONTEXT: "child",
  ACPX_TEST_PI_PLACEMENT_FILE: "/nonexistent/pi-placement",
};

test("the per-box fact: no signal means NOT on the box; the test seam is ignored outside node --test and unless exactly `1`", () => {
  assert.deepEqual(readBoxFacts(NO_FILE), NO_P1, "nothing set: pre-P1 — Pi stays home");
  assert.deepEqual(readBoxFacts({ NODE_TEST_CONTEXT: "child", ACPX_PI_PLACEMENT: "home" }), NO_P1);
  assert.deepEqual(
    readBoxFacts({ ACPX_TEST_P1_ON_BOX: "1", ACPX_PI_PLACEMENT: "home" }),
    NO_P1,
    "the seam alone, outside a test, is ignored",
  );
  assert.deepEqual(readBoxFacts({ ...NO_FILE, ACPX_TEST_P1_ON_BOX: "true" }), NO_P1);
  assert.deepEqual(readBoxFacts({ NODE_TEST_CONTEXT: "child", ACPX_TEST_P1_ON_BOX: "1" }), P1);
  // An EMPTY NODE_TEST_CONTEXT honours no seam (the rule of every other seam here).
  assert.deepEqual(
    readBoxFacts({ NODE_TEST_CONTEXT: "", ACPX_TEST_P1_ON_BOX: "1", ACPX_PI_PLACEMENT: "home" }),
    NO_P1,
  );
});

test("the utility key follows the same function: Pi and codex home, claude pool — and Pi pool only with the fact", () => {
  assert.equal(utilityKeyFor("pi", NO_P1), "util-home");
  assert.equal(utilityKeyFor("pi", P1), "util-pool");
  assert.equal(utilityKeyFor("codex", NO_P1), "util-home");
  assert.equal(utilityKeyFor("codex", P1), "util-home");
  assert.equal(utilityKeyFor("claude", NO_P1), "util-pool");
  assert.equal(utilityKeyFor(undefined, NO_P1), "util-pool");
});

// P1 (brick e9f71106, contract §2): the REAL per-box signal. These rows go red if the reader honours anything
// but the exact `pool`, if it ever answers `pool` without the variable (the release alone moving Pi), or if an
// unknown value stops warning by name.
test("P1 signal: ACPX_PI_PLACEMENT=pool puts P1 on the box; absent, empty and home do not, silently", () => {
  assert.equal(PI_PLACEMENT_ENV, "ACPX_PI_PLACEMENT");
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);
  resetPiPlacementWarningForTests();
  assert.deepEqual(readBoxFacts({ ACPX_PI_PLACEMENT: "pool" }, warn), P1);
  // No test seam needed and none consulted: the production signal works outside node --test too.
  assert.deepEqual(readBoxFacts({ NODE_TEST_CONTEXT: "", ACPX_PI_PLACEMENT: "pool" }, warn), P1);
  assert.deepEqual(readBoxFacts(NO_FILE, warn), NO_P1, "absent: the release alone never moves Pi");
  assert.deepEqual(readBoxFacts({ ACPX_PI_PLACEMENT: "" }, warn), NO_P1, "empty");
  assert.deepEqual(readBoxFacts({ ACPX_PI_PLACEMENT: "home" }, warn), NO_P1, "home (the undo)");
  assert.deepEqual(lines, [], "absent, empty, home and pool warn about nothing");
});

test("P1 signal: any other value is NOT pool and warns once per process, naming the variable and the value", () => {
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);
  resetPiPlacementWarningForTests();
  for (const garbage of ["Pool", "pool ", "POOL", "on", "true", "1", "auto", "pod"]) {
    assert.deepEqual(readBoxFacts({ ACPX_PI_PLACEMENT: garbage }, warn), NO_P1, garbage);
  }
  assert.equal(lines.length, 1, "one warning per process, not one per call");
  assert.match(
    lines[0] ?? "",
    /ACPX_PI_PLACEMENT="Pool" is not "pool" or "home"; treating it as "home"/,
  );
  // The garbage value with the test seam on still takes the seam's answer, not pool.
  assert.deepEqual(
    readBoxFacts({ ACPX_PI_PLACEMENT: "yes", NODE_TEST_CONTEXT: "child" }, warn),
    NO_P1,
  );
});

test("P1 signal: sessions and one-shots get the same answer from the same env — codex never moves", () => {
  for (const [value, piKey, piHome] of [
    [undefined, "util-home", true],
    ["", "util-home", true],
    ["home", "util-home", true],
    ["pool", "util-pool", false],
    ["garbage", "util-home", true],
  ] as const) {
    const env: NodeJS.ProcessEnv = value === undefined ? NO_FILE : { ACPX_PI_PLACEMENT: value };
    const box = readBoxFacts(env, () => {});
    assert.equal(utilityKeyFor("pi", box), piKey, `one-shot, ${String(value)}`);
    assert.equal(isHomeOnlyHarness("pi", box), piHome, `session, ${String(value)}`);
    assert.equal(utilityKeyFor("codex", box), "util-home", `codex one-shot, ${String(value)}`);
    assert.equal(isHomeOnlyHarness("codex", box), true, `codex session, ${String(value)}`);
  }
});

// ─── P1 contract §2 amended (2026-11-28, the authority's 2eb92fea): the control reads the release-pins FILE ───

function placementFile(): {
  dir: string;
  file: string;
  env: NodeJS.ProcessEnv;
  write: (v: string) => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "acpx-p1-pins-"));
  const file = path.join(dir, "pi-placement");
  return {
    dir,
    file,
    env: { NODE_TEST_CONTEXT: "child", ACPX_TEST_PI_PLACEMENT_FILE: file },
    write: (value) => writeFileSync(file, value),
  };
}

test("P1 file: the production path is the release-pins key", () => {
  assert.equal(PI_PLACEMENT_FILE, "/etc/nativai/release-pins/pi-placement");
});

test("P1 file: `pool` (whitespace trimmed) means pool; empty, `home`, missing and unreadable mean home", () => {
  const f = placementFile();
  const silent = () => {};
  try {
    f.write("pool");
    assert.deepEqual(readBoxFacts(f.env, silent), P1, "file pool");
    f.write("  pool\n");
    assert.deepEqual(
      readBoxFacts(f.env, silent),
      P1,
      "a ConfigMap value's trailing newline is trimmed",
    );
    f.write("");
    assert.deepEqual(readBoxFacts(f.env, silent), NO_P1, "empty file");
    f.write("home\n");
    assert.deepEqual(readBoxFacts(f.env, silent), NO_P1, "file home");
    rmSync(f.file);
    assert.deepEqual(readBoxFacts(f.env, silent), NO_P1, "missing file");
    f.write("pool");
    chmodSync(f.file, 0o000);
    assert.deepEqual(readBoxFacts(f.env, silent), NO_P1, "unreadable file (uid 1000)");
    chmodSync(f.file, 0o644);
    rmSync(f.file);
    mkdirSync(f.file);
    assert.deepEqual(readBoxFacts(f.env, silent), NO_P1, "a directory where the key should be");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("P1 file: the answer follows the file home → pool → home inside ONE process (no cache)", () => {
  const f = placementFile();
  try {
    const answers: boolean[] = [];
    for (const value of ["home", "pool", "home", "pool"]) {
      f.write(value);
      answers.push(readBoxFacts(f.env, () => {}).p1OnBox);
    }
    assert.deepEqual(answers, [false, true, false, true]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("P1 file: env and file disagree — the env wins, even empty, and the file is then not read", () => {
  const f = placementFile();
  try {
    f.write("pool");
    assert.deepEqual(
      readBoxFacts({ ...f.env, ACPX_PI_PLACEMENT: "home" }, () => {}),
      NO_P1,
    );
    assert.deepEqual(
      readBoxFacts({ ...f.env, ACPX_PI_PLACEMENT: "" }, () => {}),
      NO_P1,
      "empty env",
    );
    f.write("home");
    assert.deepEqual(
      readBoxFacts({ ...f.env, ACPX_PI_PLACEMENT: "pool" }, () => {}),
      P1,
    );
    // "Not read": a garbage FILE would warn if it were read; with the env present nothing is said.
    f.write("garbage");
    resetPiPlacementWarningForTests();
    const lines: string[] = [];
    readBoxFacts({ ...f.env, ACPX_PI_PLACEMENT: "home" }, (line) => lines.push(line));
    assert.deepEqual(lines, [], "the file was read although the env was set");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("P1 file: a garbage file value is home and warns once, naming the FILE", () => {
  const f = placementFile();
  try {
    f.write("Pool");
    resetPiPlacementWarningForTests();
    const lines: string[] = [];
    assert.deepEqual(
      readBoxFacts(f.env, (line) => lines.push(line)),
      NO_P1,
    );
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.includes(`${f.file}="Pool" is not "pool" or "home"`), lines[0]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("P1 file: the path seam is honoured ONLY under node --test — no production variable moves it", () => {
  const f = placementFile();
  try {
    f.write("pool");
    // Without NODE_TEST_CONTEXT the seam is ignored and the PRODUCTION path is read. Where that path does
    // not exist (every workbench, every box before W2) the answer is home although the seam file says pool.
    const production = readBoxFacts({ ACPX_TEST_PI_PLACEMENT_FILE: f.file }, () => {});
    const expected = readBoxFacts(
      { NODE_TEST_CONTEXT: "child", ACPX_TEST_PI_PLACEMENT_FILE: PI_PLACEMENT_FILE },
      () => {},
    );
    assert.deepEqual(production, expected, "the seam moved the path outside a test");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("P1 file: sessions, one-shots read the SAME file answer from the same env", () => {
  const f = placementFile();
  try {
    for (const [value, key, homeOnly] of [
      ["home", "util-home", true],
      ["pool", "util-pool", false],
      ["home", "util-home", true],
    ] as const) {
      f.write(value);
      assert.equal(
        utilityKeyFor(
          "pi",
          readBoxFacts(f.env, () => {}),
        ),
        key,
        value,
      );
      assert.equal(
        isHomeOnlyHarness(
          "pi",
          readBoxFacts(f.env, () => {}),
        ),
        homeOnly,
        value,
      );
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
