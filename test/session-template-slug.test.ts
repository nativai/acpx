import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SessionNotFoundError, SessionResolutionError } from "../src/errors.js";
import {
  isTemplateRecord,
  listSessionsForAgent,
  migrateTemplateSlugs,
  persistTemplateMark,
  resolveSessionRecord,
  resolveTemplateSelector,
  rollbackTemplateSlug,
} from "../src/session/persistence.js";
import {
  effectiveTemplateSlug,
  isLaterTemplate,
  slugify,
} from "../src/session/persistence/template-slug.js";
import type { SessionRecord } from "../src/types.js";
import {
  fileExists,
  makeSessionRecord,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const AGENT = "agent-a";

function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  return withTempHomeFixture("acpx-w13-tmpl-", run);
}

// ---------------------------------------------------------------------------
// Appendix A — slugify (cross-repo contract; MUST match acpx-ui byte-for-byte)
// ---------------------------------------------------------------------------

test("slugify (Appendix A) is lowercase kebab, collapses runs, trims, caps 64, drops empty", () => {
  assert.equal(slugify("Context Engineer"), "context-engineer");
  assert.equal(slugify("  Head of Development  "), "head-of-development");
  assert.equal(slugify("a__b..c--d  e"), "a-b-c-d-e"); // any run of non-[a-z0-9] → single "-"
  assert.equal(slugify("-–Café Crème!!!–-"), "caf-cr-me"); // accents/punct are non-[a-z0-9]
  assert.equal(slugify("already-canonical-slug"), "already-canonical-slug"); // idempotent
  assert.equal(slugify("🙂"), undefined); // emoji-only ⇒ undefined (caller falls back to id)
  assert.equal(slugify("   "), undefined);
  const capped = slugify("x".repeat(100));
  assert.equal(capped?.length, 64);
  // a slice that lands mid-separator must not leave a trailing dash
  assert.equal(slugify(`${"a".repeat(63)} bbbb`), "a".repeat(63));
});

test("effectiveTemplateSlug prefers stored slug, else slugify(name)", () => {
  assert.equal(effectiveTemplateSlug("ctx-eng", "Context Engineer"), "ctx-eng");
  assert.equal(effectiveTemplateSlug(undefined, "Context Engineer"), "context-engineer");
  assert.equal(effectiveTemplateSlug(undefined, undefined), undefined);
  assert.equal(effectiveTemplateSlug(undefined, "🙂"), undefined); // ⇒ caller uses record id
});

// ---------------------------------------------------------------------------
// Appendix B — "latest" comparator (cross-repo contract; total order)
// ---------------------------------------------------------------------------

test("isLaterTemplate (Appendix B): version, then created_at, then acpxRecordId", () => {
  const key = (
    version: number | undefined,
    created_at: string | undefined,
    acpxRecordId: string,
  ) => ({
    version,
    created_at,
    acpxRecordId,
  });
  // 1. higher version wins (un-versioned ⇒ 0, so a versioned refresh always sorts latest)
  assert.equal(isLaterTemplate(key(2, "2020", "a"), key(1, "2099", "z")), true);
  assert.equal(isLaterTemplate(key(undefined, "2099", "z"), key(1, "2020", "a")), false);
  // 2. equal version ⇒ later created_at wins
  assert.equal(isLaterTemplate(key(1, "2026-06-02", "a"), key(1, "2026-06-01", "z")), true);
  // 3. equal version + created_at ⇒ higher acpxRecordId wins (final tiebreak, total order)
  assert.equal(isLaterTemplate(key(1, "2026-06-01", "b"), key(1, "2026-06-01", "a")), true);
  assert.equal(isLaterTemplate(key(1, "2026-06-01", "a"), key(1, "2026-06-01", "b")), false);
});

// ---------------------------------------------------------------------------
// Real-store helpers
// ---------------------------------------------------------------------------

type SeedTemplateOptions = {
  id: string;
  name?: string;
  slug?: string;
  version?: number;
  enabled?: boolean;
  createdAt?: string;
  agentCommand?: string;
};

// Write a template record straight to the store, the way acpx-ui leaves one
// after "Save as template" (closed + a top-level template block). The index is
// (re)built from these record files on the first index read.
async function seedTemplate(homeDir: string, opts: SeedTemplateOptions): Promise<SessionRecord> {
  const record = makeSessionRecord({
    acpxRecordId: opts.id,
    acpSessionId: `${opts.id}-acp`,
    agentCommand: opts.agentCommand ?? AGENT,
    cwd: path.join(homeDir, "workspace"),
    name: opts.name ?? opts.id,
    closed: true,
  });
  record.template = {
    enabled: opts.enabled ?? true,
    created_at: opts.createdAt ?? "2026-06-01T00:00:00.000Z",
    source_session_id: `${opts.id}-acp`,
    ...(opts.slug !== undefined ? { slug: opts.slug } : {}),
    ...(opts.version !== undefined ? { version: opts.version } : {}),
  };
  await writeSessionRecordFile(homeDir, record);
  return record;
}

// A fresh, un-marked candidate session ready to be marked under a slug.
function makeCandidate(homeDir: string, id: string, name: string): SessionRecord {
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: AGENT,
    cwd: path.join(homeDir, "workspace"),
    name,
    closed: true,
  });
  // The block markSessionAsTemplate builds (sans slug/version, which persistTemplateMark assigns).
  record.template = {
    enabled: true,
    created_at: "2026-06-10T00:00:00.000Z",
    source_session_id: `${id}-acp`,
  };
  return record;
}

async function readIndexEntry(
  homeDir: string,
  acpxRecordId: string,
): Promise<Record<string, unknown> | undefined> {
  const indexPath = path.join(homeDir, ".acpx", "sessions", "index.json");
  const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
    entries: Array<Record<string, unknown>>;
  };
  return parsed.entries.find((entry) => entry.acpxRecordId === acpxRecordId);
}

// ---------------------------------------------------------------------------
// Mark: slug + version assignment (version = max+1 over the effectiveSlug group)
// ---------------------------------------------------------------------------

test("mark assigns default slug = slugify(name) + version 1 on a fresh slug", async () => {
  await withTempHome(async (homeDir) => {
    const cand = makeCandidate(homeDir, "cand-1", "Context Engineer");
    await persistTemplateMark(cand, {}); // no --slug ⇒ default slugify(name)

    assert.equal(cand.template?.slug, "context-engineer");
    assert.equal(cand.template?.version, 1);

    // Survives to disk AND the index projects slug/version.
    const onDisk = await resolveSessionRecord("cand-1");
    assert.equal(onDisk.template?.slug, "context-engineer");
    assert.equal(onDisk.template?.version, 1);
    const entry = await readIndexEntry(homeDir, "cand-1");
    assert.equal(entry?.templateSlug, "context-engineer");
    assert.equal(entry?.templateVersion, 1);
  });
});

test("mark honors an explicit --slug (canonicalized) different from slugify(name)", async () => {
  await withTempHome(async (homeDir) => {
    const cand = makeCandidate(homeDir, "cand-x", "Refreshed Context Eng v2");
    await persistTemplateMark(cand, { slug: "Context Engineer" }); // explicit, non-canonical input

    assert.equal(cand.template?.slug, "context-engineer"); // canonicalized via slugify
    assert.equal(cand.template?.version, 1);
  });
});

test("version = max+1 over the slug group, counting BOTH enabled and disabled (soft-retracted) siblings", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, {
      id: "ce-v1",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 1,
      enabled: false, // soft-retracted — must still count toward max
    });
    await seedTemplate(homeDir, {
      id: "ce-v2",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 2,
      enabled: true,
    });

    const cand = makeCandidate(homeDir, "ce-v3", "Context Engineer");
    await persistTemplateMark(cand, { slug: "context-engineer" });
    assert.equal(cand.template?.version, 3); // max(1 disabled, 2 enabled) + 1
  });
});

test("version = max+1 ranges over effectiveSlug, so slug-less / version-less siblings count", async () => {
  await withTempHome(async (homeDir) => {
    // A pre-migration template: enabled, no slug, no version. Its effectiveSlug
    // derives from slugify(name) = "helper" and its version counts as 0.
    await seedTemplate(homeDir, { id: "legacy", name: "Helper" });

    const cand = makeCandidate(homeDir, "helper-new", "Helper");
    await persistTemplateMark(cand, { slug: "helper" });
    // legacy is in the "helper" group via slugify(name); version ?? 0 = 0 ⇒ new = 1
    assert.equal(cand.template?.version, 1);
    // The refreshed candidate must sort LATEST over the version-less sibling.
    const resolved = await resolveTemplateSelector("helper");
    assert.equal(resolved.record.acpxRecordId, "helper-new");
    assert.equal(resolved.selectorKind, "slug");
  });
});

test("idempotent re-mark under the same slug preserves version (does not bump to latest)", async () => {
  await withTempHome(async (homeDir) => {
    const cand = makeCandidate(homeDir, "idem", "Helper");
    await persistTemplateMark(cand, { slug: "helper" });
    assert.equal(cand.template?.version, 1);

    // Re-resolve from disk (as the real mark flow does) and re-mark.
    const reread = await resolveSessionRecord("idem");
    await persistTemplateMark(reread, { slug: "helper" });
    assert.equal(reread.template?.version, 1, "re-enable must not bump the version");
  });
});

// ---------------------------------------------------------------------------
// resolveTemplateSelector: id-first → slug (precedence + not-found)
// ---------------------------------------------------------------------------

test("selector resolves a literal id to that exact record (snapshot), never redirecting to a slug", async () => {
  await withTempHome(async (homeDir) => {
    // Two enabled versions of one slug; a third record whose literal id we pass.
    await seedTemplate(homeDir, {
      id: "ce-a",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 1,
    });
    await seedTemplate(homeDir, {
      id: "ce-b",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 2,
    });

    const byId = await resolveTemplateSelector("ce-a");
    assert.equal(byId.selectorKind, "id");
    assert.equal(byId.record.acpxRecordId, "ce-a"); // the literal id, NOT the latest (ce-b)
  });
});

test("selector falls through to the slug's latest only on an id MISS", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, {
      id: "ce-a",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 1,
    });
    await seedTemplate(homeDir, {
      id: "ce-b",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 2,
    });

    const bySlug = await resolveTemplateSelector("context-engineer");
    assert.equal(bySlug.selectorKind, "slug");
    assert.equal(bySlug.record.acpxRecordId, "ce-b"); // latest version
  });
});

test("selector rethrows an AMBIGUOUS id (suffix matches >1) — it never silently becomes a slug lookup", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, { id: "dup-aaaa", name: "One", slug: "one", version: 1 });
    await seedTemplate(homeDir, { id: "dup-bbbb", name: "Two", slug: "two", version: 1 });
    // "dup-" is a suffix of neither acpxRecordId nor acpSessionId, so craft an
    // ambiguous SUFFIX: both acpSessionIds end with "-acp".
    await assert.rejects(
      () => resolveTemplateSelector("-acp"),
      (err: unknown) => {
        assert.ok(
          err instanceof SessionResolutionError,
          "ambiguous id must surface, not fall through",
        );
        return true;
      },
    );
  });
});

test("selector throws a clear not-found naming both attempts when neither id nor slug matches", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, {
      id: "ce",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 1,
    });
    await assert.rejects(
      () => resolveTemplateSelector("does-not-exist"),
      (err: unknown) => {
        assert.ok(err instanceof SessionNotFoundError);
        assert.match((err as Error).message, /tried session id, then slug/);
        return true;
      },
    );
  });
});

test("selector's slug branch ignores SOFT-RETRACTED (disabled) versions", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, {
      id: "only-v1",
      name: "Solo",
      slug: "solo",
      version: 1,
      enabled: false, // retracted ⇒ slug has no enabled version
    });
    await assert.rejects(() => resolveTemplateSelector("solo"), SessionNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// template_source provenance: the value the --from-template handler stamps
// ---------------------------------------------------------------------------

test("the id stamped as template_source is the RESOLVED latest record id (not the raw slug arg)", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, {
      id: "ce-1",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 1,
    });
    await seedTemplate(homeDir, {
      id: "ce-2",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 2,
    });
    // handleSessionsNewFromTemplate stamps metadata.template_source = resolved.record.acpxRecordId.
    const resolved = await resolveTemplateSelector("context-engineer");
    assert.equal(resolved.record.acpxRecordId, "ce-2");
    assert.notEqual(resolved.record.acpxRecordId, "context-engineer");
  });
});

// ---------------------------------------------------------------------------
// rollback: soft-retract default + re-enable + --delete
// ---------------------------------------------------------------------------

test("rollback soft-retracts the latest, dropping it from BOTH slug resolution and the templates list; prior becomes latest", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, {
      id: "v1",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 1,
    });
    await seedTemplate(homeDir, {
      id: "v2",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 2,
    });

    const result = await rollbackTemplateSlug("context-engineer");
    assert.equal(result.outcome, "soft-retract");
    assert.equal(result.retracted?.acpxRecordId, "v2");
    assert.equal(result.newLatest?.acpxRecordId, "v1");

    // v2 is no longer a template (enabled:false) — gone from the list...
    const v2 = await resolveSessionRecord("v2");
    assert.equal(isTemplateRecord(v2), false);
    assert.equal(v2.template?.slug, "context-engineer", "slug kept for reversibility");
    assert.equal(v2.template?.version, 2, "version kept for reversibility");
    const templates = (await listSessionsForAgent(AGENT)).filter(isTemplateRecord);
    assert.deepEqual(templates.map((t) => t.acpxRecordId).toSorted(), ["v1"]);

    // ...and slug resolution now returns the prior version.
    const resolved = await resolveTemplateSelector("context-engineer");
    assert.equal(resolved.record.acpxRecordId, "v1");
  });
});

test("re-enabling a soft-retracted version restores it as latest", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, {
      id: "v1",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 1,
    });
    await seedTemplate(homeDir, {
      id: "v2",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 2,
    });
    await rollbackTemplateSlug("context-engineer"); // retract v2

    // Re-enable v2 the way `sessions template <id> --enable` does: markSessionAsTemplate
    // flips enabled:true and carries slug/version forward, then persistTemplateMark
    // preserves the version (idempotent under the same slug).
    const v2 = await resolveSessionRecord("v2");
    v2.template = { ...v2.template, enabled: true };
    await persistTemplateMark(v2, { slug: "context-engineer" });
    assert.equal(v2.template?.version, 2, "re-enable preserved the retracted version");
    assert.equal(v2.template?.enabled, true);

    const resolved = await resolveTemplateSelector("context-engineer");
    assert.equal(resolved.record.acpxRecordId, "v2", "v2 is latest again");
  });
});

test("rollback --delete hard-removes the record + sidecars + index entry", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, {
      id: "v1",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 1,
    });
    await seedTemplate(homeDir, {
      id: "v2",
      name: "Context Engineer",
      slug: "context-engineer",
      version: 2,
    });

    const result = await rollbackTemplateSlug("context-engineer", { delete: true });
    assert.equal(result.outcome, "delete");
    assert.equal(result.retracted?.acpxRecordId, "v2");
    assert.equal(result.newLatest?.acpxRecordId, "v1");

    assert.equal(await fileExists(sessionFilePath(homeDir, "v2")), false, "record file gone");
    assert.equal(await readIndexEntry(homeDir, "v2"), undefined, "index entry gone");
    await assert.rejects(() => resolveSessionRecord("v2"), SessionNotFoundError);
  });
});

test("rolling back the only version empties the slug; rolling back an empty slug is a no-op", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, { id: "solo", name: "Solo", slug: "solo", version: 1 });

    const first = await rollbackTemplateSlug("solo");
    assert.equal(first.outcome, "soft-retract");
    assert.equal(first.newLatest, undefined, "slug now empty");

    const second = await rollbackTemplateSlug("solo");
    assert.equal(second.outcome, "noop", "no enabled version left to roll back");
  });
});

// ---------------------------------------------------------------------------
// migrate-slugs: idempotent backfill + collision disambiguation (D3)
// ---------------------------------------------------------------------------

test("migrate-slugs backfills slug+version on un-migrated templates; --dry-run writes nothing", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, { id: "t1", name: "Context Engineer" }); // no slug/version

    const dry = await migrateTemplateSlugs({ dryRun: true });
    assert.equal(dry.assigned, 1);
    assert.equal(dry.dryRun, true);
    const stillBare = await resolveSessionRecord("t1");
    assert.equal(stillBare.template?.slug, undefined, "dry-run wrote nothing");

    const wet = await migrateTemplateSlugs();
    assert.equal(wet.assigned, 1);
    const migrated = await resolveSessionRecord("t1");
    assert.equal(migrated.template?.slug, "context-engineer");
    assert.equal(migrated.template?.version, 1);
  });
});

test("migrate-slugs is idempotent: a second run skips already-migrated templates (no renumber)", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, { id: "t1", name: "Helper" });
    await migrateTemplateSlugs();
    const afterFirst = await resolveSessionRecord("t1");
    assert.equal(afterFirst.template?.version, 1);

    const second = await migrateTemplateSlugs();
    assert.equal(second.assigned, 0);
    assert.equal(second.skipped, 1);
    const afterSecond = await resolveSessionRecord("t1");
    assert.equal(afterSecond.template?.version, 1, "version not renumbered");
  });
});

test("migrate-slugs disambiguates collisions (D3): distinct templates with the same name get distinct slugs", async () => {
  await withTempHome(async (homeDir) => {
    // Two distinct templates both named "Helper" (slugify ⇒ "helper").
    await seedTemplate(homeDir, {
      id: "older",
      name: "Helper",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    await seedTemplate(homeDir, {
      id: "newer",
      name: "Helper",
      createdAt: "2026-06-02T00:00:00.000Z",
    });

    const result = await migrateTemplateSlugs();
    assert.equal(result.assigned, 2);

    const older = await resolveSessionRecord("older");
    const newer = await resolveSessionRecord("newer");
    // earliest created_at gets the bare slug; the later one is disambiguated.
    assert.equal(older.template?.slug, "helper");
    assert.equal(newer.template?.slug, "helper-2");
    assert.notEqual(older.template?.slug, newer.template?.slug);
    // distinct slugs ⇒ each is version 1 of its own slug (NOT merged into versions)
    assert.equal(older.template?.version, 1);
    assert.equal(newer.template?.version, 1);
  });
});

test("migrate-slugs leaves an emoji-only-named template slug-less (groups by id)", async () => {
  await withTempHome(async (homeDir) => {
    await seedTemplate(homeDir, { id: "emoji", name: "🙂" });
    const result = await migrateTemplateSlugs();
    assert.equal(result.degenerate, 1);
    assert.equal(result.assigned, 0);
    const rec = await resolveSessionRecord("emoji");
    assert.equal(rec.template?.slug, undefined);
  });
});
