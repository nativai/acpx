import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// brick 45917618 §5.2 implementation rule (TEST-PLAN A13): nothing in acpx may decide a new
// session's cwd except the session-root helper. This test DISCOVERS every record-creating create
// site by scanning `src/` (`createSessionWithClient(` / `.createSession(`) and compares the census
// with the known list below — each entry says why that site is at the root (or, for N2, why it
// is deliberately not). A new create site fails here until someone decides which it is.
//
// The negative case is committed, not a mutation: `test/fixtures/session-root-bypass-site.txt` is a
// copy of a real site with one extra direct `client.createSession(options.cwd)`, and the same
// enumerator must report that extra call.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, "src");
const BYPASS_FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "session-root-bypass-site.txt");

const CREATE_SITE = /\bcreateSessionWithClient\(|\.createSession\(/;

type Site = { file: string; text: string };

/** Every create call in `source` (comments and the function's own definition excluded). */
function findCreateSites(file: string, source: string): Site[] {
  const sites: Site[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) {
      continue;
    }
    if (/\bfunction createSessionWithClient\(/.test(line)) {
      continue;
    }
    if (CREATE_SITE.test(line)) {
      sites.push({ file, text: line });
    }
  }
  return sites;
}

/** The known list: `file` + the exact call text, and why its cwd is the session root. */
const KNOWN_SITES: Array<Site & { why: string }> = [
  {
    file: "acp/transient-advertisement.ts",
    text: "const created = await withTimeout(client.createSession(cwd), options.timeoutMs);",
    why: "E6: `cwd = effectiveCreateCwd(options.cwd)` a few lines above",
  },
  {
    file: "runtime/engine/manager.ts",
    text: "const created = await client.createSession(cwd);",
    why: "E4: `ensureSession` forces `effectiveCreateCwd` for every fresh (non-resume) create",
  },
  {
    file: "runtime/engine/reconnect.ts",
    text: "const createdSession = await withTimeout(client.createSession(record.cwd), timeoutMs);",
    why: "N2: a load-failure fallback for an EXISTING record keeps the record's cwd (§5.5)",
  },
  {
    file: "flows/runtime.ts",
    text: "const created = await createSessionWithClient({",
    why: "E1/F1: createSessionWithClient forces the root itself",
  },
  {
    file: "cli/session/session-management.ts",
    text: "const createdSession = await withTimeout(client.createSession(cwd), options.timeoutMs);",
    why: "E1: inside createSessionRecordWithClient, cwd derives from the forced options.cwd",
  },
  {
    file: "cli/session/session-management.ts",
    text: "? await withTimeout(client.createSession(cwd), options.timeoutMs)",
    why: "E1: the index-0 copy branch of forkSessionRecordWithClient, same forced cwd",
  },
  {
    file: "cli/session/session-management.ts",
    text: "const { record, client } = await createSessionWithClient(options);",
    why: "E1: `createSession` is a thin wrapper over the seam",
  },
  {
    file: "cli/session/runtime.ts",
    text: "client.createSession(absolutePath(options.cwd)),",
    why: "E2: runOnce forces `cwd: effectiveCreateCwd(runOptions.cwd)` before building the client",
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(full);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

function unlisted(sites: Site[]): Site[] {
  const remaining = [...KNOWN_SITES];
  const extra: Site[] = [];
  for (const site of sites) {
    const index = remaining.findIndex(
      (known) => known.file === site.file && known.text === site.text,
    );
    if (index === -1) {
      extra.push(site);
    } else {
      remaining.splice(index, 1);
    }
  }
  return extra;
}

function sourceCensus(): Site[] {
  return walk(SRC_DIR).flatMap((full) =>
    findCreateSites(path.relative(SRC_DIR, full), readFileSync(full, "utf8")),
  );
}

test("A13(i): every create site in src/ is on the known list, and every known site still exists", () => {
  const census = sourceCensus();
  assert.deepEqual(
    unlisted(census),
    [],
    "a new create site must be routed through the root helper",
  );
  for (const known of KNOWN_SITES) {
    assert.ok(
      census.some((site) => site.file === known.file && site.text === known.text),
      `known site vanished (update the list): ${known.file}: ${known.text}`,
    );
  }
});

test("A13(i): every re-rooted direct create site sits in a file that calls the session-root helper", () => {
  for (const known of KNOWN_SITES) {
    if (known.why.startsWith("N2") || known.text.includes("createSessionWithClient(")) {
      continue; // N2 keeps the record's cwd; a createSessionWithClient call is forced inside the seam
    }
    const source = readFileSync(path.join(SRC_DIR, known.file), "utf8");
    assert.ok(
      source.includes("effectiveCreateCwd("),
      `${known.file} creates a session directly but never calls effectiveCreateCwd`,
    );
  }
});

test("A13(ii): a fixture copy of a real site with one extra direct createSession is reported", () => {
  const fixtureSites = findCreateSites(
    "acp/transient-advertisement.ts",
    readFileSync(BYPASS_FIXTURE, "utf8"),
  );
  // Planted positive: the copied real site IS recognised as the known one…
  assert.equal(fixtureSites.length, 2);
  // …and the bypass is the one thing reported.
  assert.deepEqual(unlisted(fixtureSites), [
    {
      file: "acp/transient-advertisement.ts",
      text: "const bypass = await client.createSession(options.cwd);",
    },
  ]);
});
