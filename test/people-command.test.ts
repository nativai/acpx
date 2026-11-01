import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { konsiqPair, peopleDocument, personRow, fixtureIdRow } from "./people-test-helpers.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";
import { withTempHome } from "./temp-home.js";

// TEST-PLAN P1-1 + PM-C4 (offline half): `acpx people list | resolve | principal` against the REAL compiled
// CLI, a temp HOME and no atrium. One committed negative per published exit code (CONCEPTION §4.1):
//   resolve: 0 · 3 unknown · 4 ambiguous · 5 another box     principal: 0 · 6 not recorded · 2 unknown session
//   a malformed people.json: 1, never an empty list           a usage error: 2

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_PEOPLE_FILE",
      "ACPX_PRINCIPAL_ID",
      "ACPX_PRINCIPAL_NAME",
    ]) {
      delete env[key];
    }
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: homeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function seedPeople(homeDir: string, text: string): Promise<string> {
  const file = path.join(homeDir, ".acpx", "people.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
  return file;
}

async function withKonsiq<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  return await withTempHome("acpx-people-cli-", async (homeDir) => {
    const { brammertz, laatz } = await konsiqPair();
    await seedPeople(homeDir, peopleDocument([brammertz, laatz]));
    return await run(homeDir);
  });
}

const LAATZ_ID = "p-fb566154c0bf245b7538";
const BRAMMERTZ_ID = "p-9df6e3afab610ff30d1a";

test("people list: one line per person (handle, name, id, last seen), exit 0; --format json is the rows", async () => {
  await withKonsiq(async (home) => {
    const text = await runCli(["people", "list"], home);
    assert.equal(text.code, 0, text.stderr);
    const lines = text.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.match(
      lines[0],
      /^brammertz\s+Daniel Brammertz\s+p-9df6e3afab610ff30d1a\s+last seen 2026-10-17T21:58:00Z$/u,
    );
    assert.match(lines[1], /^laatz\s+Daniel Laatz\s+p-fb566154c0bf245b7538\s+last seen /u);
    assert.doesNotMatch(
      text.stderr + text.stdout,
      /No acpx session found/u,
      "the verb is not shadowed by an agent name",
    );

    const json = await runCli(["--format", "json", "people", "list"], home);
    assert.equal(json.code, 0, json.stderr);
    const rows = JSON.parse(json.stdout) as Array<{ id: string; handle: string; issuer: string }>;
    assert.deepEqual(
      rows.map((row) => row.id),
      [BRAMMERTZ_ID, LAATZ_ID],
    );
    assert.equal(rows[1].handle, "laatz");
    assert.ok(rows[1].issuer.length > 0, "the rows are the file's rows, unreduced");
  });
});

test("a missing people file is an empty list: exit 0, nothing on stdout (P1-1)", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    const text = await runCli(["people", "list"], home);
    assert.equal(text.code, 0);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /no people are registered/u);
    const json = await runCli(["--format", "json", "people", "list"], home);
    assert.equal(json.code, 0);
    assert.deepEqual(JSON.parse(json.stdout), []);
    const resolve = await runCli(["people", "resolve", "laatz"], home);
    assert.equal(resolve.code, 3, "an empty list resolves nothing: unknown, not a crash");
  });
});

test("people resolve → exit 0 for an id, a handle (any case, with @) and a full name (any spacing)", async () => {
  await withKonsiq(async (home) => {
    for (const ref of ["laatz", "LAATZ", "@laatz", "Daniel  Laatz", LAATZ_ID]) {
      const result = await runCli(["people", "resolve", ref], home);
      assert.equal(result.code, 0, `${ref}: ${result.stderr}`);
      assert.equal(result.stdout.trimEnd(), `laatz (Daniel Laatz) ${LAATZ_ID}`, ref);
    }
    const json = await runCli(["--format", "json", "people", "resolve", "brammertz"], home);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), {
      id: BRAMMERTZ_ID,
      name: "Daniel Brammertz",
      handle: "brammertz",
    });
  });
});

test("people resolve → exit 3 for an unknown ref; suggestions are listed on stderr and in the JSON, never chosen", async () => {
  await withKonsiq(async (home) => {
    const near = await runCli(["people", "resolve", "laat"], home);
    assert.equal(near.code, 3);
    assert.equal(near.stdout, "", "a prefix is not a match: nothing was resolved");
    assert.match(near.stderr, /laatz \(Daniel Laatz\) p-fb566154c0bf245b7538/u);

    const first = await runCli(["people", "resolve", "daniel"], home);
    assert.equal(first.code, 3);
    assert.equal(first.stdout, "", "a first name picks nobody");
    assert.match(first.stderr, /brammertz \(Daniel Brammertz\)/u);
    assert.match(first.stderr, /laatz \(Daniel Laatz\)/u);

    const json = await runCli(["--format", "json", "people", "resolve", "daniel"], home);
    assert.equal(json.code, 3);
    const body = JSON.parse(json.stdout) as {
      error: string;
      suggestions: Array<{ handle: string }>;
    };
    assert.equal(body.error, "unknown");
    assert.deepEqual(body.suggestions.map((hit) => hit.handle).toSorted(), ["brammertz", "laatz"]);

    const absentId = await runCli(["people", "resolve", "p-00000000000000000000"], home);
    assert.equal(absentId.code, 3);
    assert.match(absentId.stderr, /people are per box/u);
  });
});

test("people resolve → exit 4 for two people with one display name, every candidate listed (C4.2)", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    const { laatz } = await konsiqPair();
    const v3 = await fixtureIdRow("V3");
    const twin = personRow(v3, "Daniel Laatz", "daniel-laatz");
    await seedPeople(home, peopleDocument([laatz, twin]));
    const result = await runCli(["people", "resolve", "Daniel Laatz"], home);
    assert.equal(result.code, 4);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /is ambiguous/u);
    assert.match(result.stderr, /laatz \(Daniel Laatz\) p-fb566154c0bf245b7538/u);
    assert.match(result.stderr, /daniel-laatz \(Daniel Laatz\) /u);

    const json = await runCli(["--format", "json", "people", "resolve", "Daniel Laatz"], home);
    assert.equal(json.code, 4);
    assert.equal((JSON.parse(json.stdout) as { candidates: unknown[] }).candidates.length, 2);

    // positive control: each handle still resolves exactly one of them
    assert.equal((await runCli(["people", "resolve", "laatz"], home)).code, 0);
    assert.equal((await runCli(["people", "resolve", "daniel-laatz"], home)).code, 0);
  });
});

test("people resolve → exit 5 for handle@box, even when that handle exists on this box (C4.4)", async () => {
  await withKonsiq(async (home) => {
    const result = await runCli(["people", "resolve", "laatz@konsiq"], home);
    assert.equal(result.code, 5);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /another box \(konsiq\)/u);
    const json = await runCli(
      ["--format", "json", "people", "resolve", "@laatz@konsiq.nativai.de"],
      home,
    );
    assert.equal(json.code, 5);
    assert.deepEqual(JSON.parse(json.stdout), { error: "other-box", box: "konsiq.nativai.de" });
  });
});

test("a former handle still resolves, with the note `now <handle>` (C3.4)", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    const { laatz } = await konsiqPair();
    await seedPeople(home, peopleDocument([{ ...laatz, handle: "dl", former_handles: ["laatz"] }]));
    const text = await runCli(["people", "resolve", "laatz"], home);
    assert.equal(text.code, 0, text.stderr);
    assert.equal(text.stdout.trimEnd(), `dl (Daniel Laatz) ${LAATZ_ID}`);
    assert.match(text.stderr, /now dl/u);
    const json = await runCli(["--format", "json", "people", "resolve", "laatz"], home);
    assert.deepEqual(JSON.parse(json.stdout), {
      id: LAATZ_ID,
      name: "Daniel Laatz",
      handle: "dl",
      note: "now dl",
    });
  });
});

test("a people.json truncated by one byte is exit 1 with the parse error — never an empty list (P1-1 negative)", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    const { laatz } = await konsiqPair();
    const good = peopleDocument([laatz]);
    const file = await seedPeople(home, good);
    assert.equal(
      (await runCli(["people", "list"], home)).code,
      0,
      "control: the intact file reads",
    );

    await fs.writeFile(file, good.slice(0, -1), "utf8");
    for (const args of [
      ["people", "list"],
      ["people", "resolve", "laatz"],
      ["--format", "json", "people", "list"],
    ]) {
      const result = await runCli(args, home);
      assert.equal(result.code, 1, args.join(" "));
      assert.equal(
        result.stdout,
        "",
        `${args.join(" ")}: nothing is printed as if the list were empty`,
      );
      assert.match(result.stderr, /not valid JSON/u);
      assert.ok(result.stderr.includes(file), "the message names the file");
    }
    assert.equal(
      await fs.readFile(file, "utf8"),
      good.slice(0, -1),
      "the verb never repairs the file",
    );
  });
});

// O4 (brick 509d3884): the people file as atrium leaves it after a same-uid hand edit — one foreign row
// keyed by a non-id between two valid people. Atrium keeps the row and serves the rest; so does acpx.
test("a people.json with ONE foreign row lists the valid rows, names the skipped one and exits 0; an unparseable file still exits 1 (O4)", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    const { brammertz, laatz } = await konsiqPair();
    const document = JSON.stringify({
      v: 1,
      people: {
        [brammertz.id]: brammertz,
        "p-zz-not-an-id": { note: "a foreign row, no id" },
        [laatz.id]: laatz,
      },
    });
    const file = await seedPeople(home, document);

    const text = await runCli(["people", "list"], home);
    assert.equal(text.code, 0, text.stderr);
    assert.deepEqual(
      text.stdout
        .trimEnd()
        .split("\n")
        .map((line) => line.split(/\s+/u)[0]),
      ["brammertz", "laatz"],
      "both valid rows are listed, in file order",
    );
    assert.ok(text.stderr.includes('"p-zz-not-an-id"'), `the skipped row is named: ${text.stderr}`);
    assert.ok(text.stderr.includes(file), "the warning names the file");
    assert.doesNotMatch(text.stdout, /p-zz-not-an-id/u, "the skipped row is not listed");

    const json = await runCli(["--format", "json", "people", "list"], home);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(
      (JSON.parse(json.stdout) as Array<{ id: string }>).map((row) => row.id),
      [brammertz.id, laatz.id],
      "stdout stays a clean JSON array of the valid rows",
    );
    assert.match(json.stderr, /p-zz-not-an-id/u);

    const resolved = await runCli(["people", "resolve", "laatz"], home);
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.match(resolved.stdout, new RegExp(laatz.id, "u"));
    assert.match(resolved.stderr, /p-zz-not-an-id/u);

    assert.equal(await fs.readFile(file, "utf8"), document, "the verb never repairs the file");

    // the negatives beside it: the same file made unparseable, and a clean file with nothing to name
    await fs.writeFile(file, document.slice(0, -1), "utf8");
    const broken = await runCli(["people", "list"], home);
    assert.equal(broken.code, 1);
    assert.equal(broken.stdout, "");
    assert.match(broken.stderr, /not valid JSON/u);
    await fs.writeFile(file, peopleDocument([brammertz, laatz]), "utf8");
    const clean = await runCli(["people", "list"], home);
    assert.equal(clean.code, 0);
    assert.equal(clean.stderr, "", "a clean file says nothing");
  });
});

test("ACPX_PEOPLE_FILE overrides the path (C6.1); the state-root file is then not consulted", async () => {
  await withKonsiq(async (home) => {
    const { laatz } = await konsiqPair();
    const elsewhere = path.join(home, "elsewhere.json");
    await fs.writeFile(
      elsewhere,
      peopleDocument([{ ...laatz, handle: "onlyhere", name: "Only Here" }]),
      "utf8",
    );
    const result = await runCli(["people", "resolve", "onlyhere"], home, {
      ACPX_PEOPLE_FILE: elsewhere,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^onlyhere \(Only Here\) /u);
    const stateRoot = await runCli(["people", "resolve", "brammertz"], home, {
      ACPX_PEOPLE_FILE: elsewhere,
    });
    assert.equal(stateRoot.code, 3, "Brammertz is only in the state-root file");
    const nofile = await runCli(["people", "list"], home, {
      ACPX_PEOPLE_FILE: path.join(home, "nope.json"),
    });
    assert.equal(nofile.code, 0);
    assert.equal(nofile.stdout, "");
  });
});

test("usage errors are exit 2: a missing ref, an unknown subverb, no session to read, a --session that names none", async () => {
  await withKonsiq(async (home) => {
    const cases: string[][] = [
      ["people", "resolve"],
      ["people", "bogus"],
      ["people", "principal"],
      ["people", "principal", "--session", "?session="],
      ["people", "list", "--no-such-flag"],
    ];
    for (const args of cases) {
      const result = await runCli(args, home);
      assert.equal(result.code, 2, `${args.join(" ")} → ${result.stderr}`);
      assert.equal(result.stdout, "", args.join(" "));
    }
    // the unknown subverb is an error naming the verb, not a prompt delivery to an agent called "people"
    const bogus = await runCli(["people", "bogus"], home);
    assert.doesNotMatch(bogus.stderr, /No acpx session found/u);
    assert.match(bogus.stderr, /unknown command 'bogus'/u);
  });
});

function sessionUrl(id: string): string {
  return `http://localhost:3456/?session=${id}`;
}

async function seedSession(home: string, id: string, metadata: Record<string, string> | undefined) {
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `acp-${id}`,
      agentCommand: "agent",
      cwd: home,
      metadata,
    }),
  );
}

test("people principal → exit 0 with {principal, via, from}; the principal may be null (CONCEPTION §4.1)", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    await seedSession(home, "s-started", {
      principal_via: "started",
      principal_id: LAATZ_ID,
      principal_name: "Daniel Laatz",
    });
    await seedSession(home, "s-inherited", {
      principal_via: "inherited",
      principal_id: LAATZ_ID,
      principal_name: "Daniel Laatz",
      principal_from: "s-started",
    });
    await seedSession(home, "s-nobody", { principal_via: "none" });

    const started = await runCli(
      ["--format", "json", "people", "principal", "--session", "s-started"],
      home,
    );
    assert.equal(started.code, 0, started.stderr);
    assert.deepEqual(JSON.parse(started.stdout), {
      principal: { id: LAATZ_ID, name: "Daniel Laatz" },
      via: "started",
      from: null,
    });
    const inherited = await runCli(
      ["--format", "json", "people", "principal", "--session", "s-inherited"],
      home,
    );
    assert.deepEqual(JSON.parse(inherited.stdout), {
      principal: { id: LAATZ_ID, name: "Daniel Laatz" },
      via: "inherited",
      from: "s-started",
    });
    const nobody = await runCli(
      ["--format", "json", "people", "principal", "--session", "s-nobody"],
      home,
    );
    assert.equal(nobody.code, 0, "no principal is a recorded answer, not an error");
    assert.deepEqual(JSON.parse(nobody.stdout), { principal: null, via: "none", from: null });

    const text = await runCli(["people", "principal", "--session", "s-inherited"], home);
    assert.equal(text.code, 0);
    assert.equal(text.stdout.trimEnd(), `Daniel Laatz ${LAATZ_ID} · via inherited from s-started`);
  });
});

test("people principal defaults to the caller's own session ($ACPX_SESSION_URL) and accepts a session URL; it needs no people.json", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    await seedSession(home, "s-own", {
      principal_via: "started",
      principal_id: BRAMMERTZ_ID,
      principal_name: "Daniel Brammertz",
    });
    const own = await runCli(["--format", "json", "people", "principal"], home, {
      ACPX_SESSION_URL: sessionUrl("s-own"),
    });
    assert.equal(own.code, 0, own.stderr);
    assert.equal(
      (JSON.parse(own.stdout) as { principal: { id: string } }).principal.id,
      BRAMMERTZ_ID,
    );
    const byUrl = await runCli(
      ["--format", "json", "people", "principal", "--session", sessionUrl("s-own")],
      home,
    );
    assert.equal(byUrl.code, 0, byUrl.stderr);
    assert.equal((JSON.parse(byUrl.stdout) as { via: string }).via, "started");
  });
});

test("people principal → exit 6 for a session that predates the keys; the hint names the atrium route", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    await seedSession(home, "s-legacy", { brick: "b" });
    await seedSession(home, "s-nometa", undefined);
    // a malformed principal_via-less shape: id without via is NOT a record of anything
    await seedSession(home, "s-halfway", { principal_id: LAATZ_ID });
    for (const id of ["s-legacy", "s-nometa", "s-halfway"]) {
      const result = await runCli(["people", "principal", "--session", id], home);
      assert.equal(result.code, 6, id);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(`GET /api/sessions/${id}/principal`), result.stderr);
    }
    const json = await runCli(
      ["--format", "json", "people", "principal", "--session", "s-legacy"],
      home,
    );
    assert.equal(json.code, 6);
    const body = JSON.parse(json.stdout) as { error: string; hint: string };
    assert.equal(body.error, "not-recorded");
    assert.match(body.hint, /GET \/api\/sessions\/s-legacy\/principal/u);
  });
});

test("people principal → exit 2 for a session that does not exist, never 6 (an unknown id is not 'an older session')", async () => {
  await withTempHome("acpx-people-cli-", async (home) => {
    await seedSession(home, "s-there", { principal_via: "none" });
    const control = await runCli(["people", "principal", "--session", "s-there"], home);
    assert.equal(control.code, 0, "control: the same invocation on a real session answers");
    const unknown = await runCli(
      ["people", "principal", "--session", "00000000-0000-4000-8000-000000000000"],
      home,
    );
    assert.equal(unknown.code, 2);
    assert.equal(unknown.stdout, "");
    const viaEnv = await runCli(["people", "principal"], home, {
      ACPX_SESSION_URL: sessionUrl("00000000-0000-4000-8000-000000000000"),
    });
    assert.equal(viaEnv.code, 2);
  });
});

test("the people verbs are read-only: the people file and the session store are byte-identical afterwards", async () => {
  await withKonsiq(async (home) => {
    await seedSession(home, "s-ro", {
      principal_via: "started",
      principal_id: LAATZ_ID,
      principal_name: "Daniel Laatz",
    });
    const digest = async (): Promise<string> => {
      const hash = createHash("sha256");
      for (const file of [
        path.join(home, ".acpx", "people.json"),
        path.join(home, ".acpx", "sessions", "s-ro.json"),
      ]) {
        hash.update(await fs.readFile(file));
      }
      const listing = (await fs.readdir(path.join(home, ".acpx", "sessions"))).toSorted();
      return `${hash.digest("hex")} ${listing.join(",")}`;
    };
    const before = await digest();
    for (const args of [
      ["people", "list"],
      ["people", "resolve", "laatz"],
      ["people", "resolve", "nobody-here"],
      ["people", "principal", "--session", "s-ro"],
    ]) {
      await runCli(args, home);
    }
    assert.equal(await digest(), before);
  });
});
