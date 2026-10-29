import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import {
  readAcpxUiInternalOriginSources,
  resolveAtriumLocalOrigin,
} from "../src/acp/acpx-ui-internal-origin.js";
import {
  ArchivedFileCorrupt,
  buildFooter,
  compressArchivedFile,
  compressibleFamilyOf,
  decodeArchiveZst,
  encodeArchiveZst,
  FOOTER_BYTES,
  logicalFileSet,
  parseFooter,
  readArchivedFileVerified,
  resolveArchivedFile,
  stageDecompressed,
  statArchivedFile,
  zstdFrameLength,
  type CorruptCheck,
} from "../src/session/archive/compressed.js";
import { claimArchiveFileSets } from "../src/session/archive/identity.js";

// Brick 1861b06d — `acpx-archive-zst/v1` (amendment §H). Every integrity check in
// `decodeArchiveZst` exists because node 22's decoder accepts a damaged frame SILENTLY
// (measurements.md §5); each quirk is pinned here twice — once showing the raw decoder
// does NOT notice, once showing the format does.

const FIXTURE_DIR = path.join(process.cwd(), "test", "fixtures", "archive-zst");

function logicalSample(lines = 4000): Buffer {
  const rows: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    rows.push(
      JSON.stringify({ seq: i, method: "session/update", text: `chunk ${i % 97} `.repeat(4) }),
    );
  }
  return Buffer.from(`${rows.join("\n")}\n`);
}

function sha(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function expectCorrupt(data: Buffer, check: CorruptCheck): void {
  assert.throws(
    () => decodeArchiveZst(data, "x.stream.ndjson.zst"),
    (error: unknown) => {
      assert.ok(
        error instanceof ArchivedFileCorrupt,
        `expected ArchivedFileCorrupt, got ${String(error)}`,
      );
      assert.equal(error.check, check);
      assert.equal(error.code, "ARCHIVED_FILE_CORRUPT");
      assert.match(error.message, /^ARCHIVED_FILE_CORRUPT x\.stream\.ndjson\.zst \(/);
      return true;
    },
  );
}

async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "acpx-zst-"));
}

// ─── golden vectors ───────────────────────────────────────────────────────────

test("golden: the committed v1 vector decodes to its committed logical bytes", async () => {
  // Frozen bytes, not a fresh encode: a libzstd upgrade may change what WE write, but
  // it must never stop us reading what an earlier build wrote.
  const vector = await fs.readFile(path.join(FIXTURE_DIR, "valid-v1.stream.ndjson.zst"));
  const expected = await fs.readFile(path.join(FIXTURE_DIR, "valid-v1.stream.ndjson"));
  assert.deepEqual(decodeArchiveZst(vector, "valid-v1"), expected);
  assert.equal(parseFooter(vector, "valid-v1").sha256, sha(expected));
});

test("encode: exactly one frame, then the 56-byte ACPXZST1 footer, byte for byte", () => {
  const logical = logicalSample();
  const encoded = encodeArchiveZst(logical);
  const footer = encoded.subarray(encoded.length - FOOTER_BYTES);
  assert.equal(footer.readUInt32LE(0), 0x184d2a5e);
  assert.equal(footer.readUInt32LE(4), 48);
  assert.equal(footer.toString("ascii", 8, 16), "ACPXZST1");
  assert.equal(footer.readBigUInt64LE(16), BigInt(logical.length));
  assert.equal(footer.subarray(24).toString("hex"), sha(logical));
  const frame = encoded.subarray(0, encoded.length - FOOTER_BYTES);
  assert.equal(zstdFrameLength(frame), frame.length, "the region before the footer is ONE frame");
  assert.deepEqual(decodeArchiveZst(encoded, "x"), logical);
  // Any RFC 8878 decoder skips the footer (a skippable frame) — the standard reader works.
  assert.deepEqual(zlib.zstdDecompressSync(encoded), logical);
});

// ─── AC-2: every corruption variant is refused, naming the check ─────────────

test("AC-2 truncated −1 / −5 / −100 bytes: refused (footer) — truncation always cuts the footer", () => {
  const encoded = encodeArchiveZst(logicalSample());
  for (const cut of [1, 5, 100]) {
    expectCorrupt(encoded.subarray(0, encoded.length - cut), "footer");
  }
});

test("AC-2 a byte flipped inside the frame: refused", () => {
  const encoded = Buffer.from(encodeArchiveZst(logicalSample()));
  encoded[Math.floor((encoded.length - FOOTER_BYTES) / 2)] ^= 0xff;
  assert.throws(() => decodeArchiveZst(encoded, "x"), ArchivedFileCorrupt);
});

test("AC-2 a byte flipped in the footer: magic/tag → footer, length → size, hash → hash", () => {
  const encoded = encodeArchiveZst(logicalSample());
  const at = (offset: number): Buffer => {
    const copy = Buffer.from(encoded);
    copy[encoded.length - FOOTER_BYTES + offset] ^= 0x01;
    return copy;
  };
  expectCorrupt(at(0), "footer");
  expectCorrupt(at(10), "footer");
  expectCorrupt(at(16), "size");
  expectCorrupt(at(40), "hash");
});

test("AC-2 footer removed: refused (footer)", () => {
  const encoded = encodeArchiveZst(logicalSample());
  expectCorrupt(encoded.subarray(0, encoded.length - FOOTER_BYTES), "footer");
});

test("AC-2 a 0-byte file: refused (footer) — node decodes empty input to 0 bytes WITHOUT an error", () => {
  assert.equal(
    zlib.zstdDecompressSync(Buffer.alloc(0)).length,
    0,
    "pin: the raw decoder does not notice",
  );
  expectCorrupt(Buffer.alloc(0), "footer");
});

test("AC-2 a skippable frame PREPENDED: refused (frame) — node returns 0 bytes for it, no error", () => {
  const logical = logicalSample();
  const encoded = encodeArchiveZst(logical);
  const frame = encoded.subarray(0, encoded.length - FOOTER_BYTES);
  const skippable = Buffer.alloc(16);
  skippable.writeUInt32LE(0x184d2a50, 0);
  skippable.writeUInt32LE(8, 4);
  assert.equal(
    zlib.zstdDecompressSync(Buffer.concat([skippable, frame])).length,
    0,
    "pin: the raw decoder silently yields nothing",
  );
  expectCorrupt(Buffer.concat([skippable, frame, buildFooter(logical)]), "frame");
});

test("AC-2 a SECOND frame appended before the footer: refused (frame) — node ignores it, no error", () => {
  const logical = logicalSample();
  const encoded = encodeArchiveZst(logical);
  const frame = encoded.subarray(0, encoded.length - FOOTER_BYTES);
  const second = zlib.zstdCompressSync(Buffer.from("tail that must not be ignored silently\n"));
  assert.deepEqual(
    zlib.zstdDecompressSync(Buffer.concat([frame, second])),
    logical,
    "pin: the raw decoder returns only the first frame",
  );
  // Same footer, content of frame 1 matches it — only the structural walk catches this.
  expectCorrupt(Buffer.concat([frame, second, buildFooter(logical)]), "frame");
});

test("AC-2 a second frame appended AFTER the footer: refused (footer)", () => {
  const encoded = encodeArchiveZst(logicalSample());
  expectCorrupt(Buffer.concat([encoded, zlib.zstdCompressSync(Buffer.from("x"))]), "footer");
});

test("pin: a frame cut mid-way decodes to a PREFIX without an error — so length+hash are mandatory", () => {
  const logical = logicalSample(20000);
  const frame = zlib.zstdCompressSync(logical);
  const prefix = zlib.zstdDecompressSync(frame.subarray(0, -100));
  assert.ok(prefix.length < logical.length, "the raw decoder returned a prefix");
  // A footer that matches the CUT frame's walk is impossible; a footer lying about the
  // size is caught by `size` even when the frame walk were fooled.
  expectCorrupt(Buffer.concat([frame.subarray(0, -100), buildFooter(logical)]), "frame");
});

test("zstdFrameLength: undefined for non-frames, cut frames, and reserved block types", () => {
  assert.equal(zstdFrameLength(Buffer.from("not a frame at all")), undefined);
  const frame = zlib.zstdCompressSync(logicalSample());
  assert.equal(zstdFrameLength(frame), frame.length);
  assert.equal(zstdFrameLength(frame.subarray(0, -1)), undefined);
  assert.equal(zstdFrameLength(Buffer.concat([frame, frame])), frame.length, "measures ONE frame");
});

// ─── families and names ───────────────────────────────────────────────────────

test("families: exactly the four transcript families; the record and everything else stay plain", () => {
  const id = "019f4e32-0966-7c53-ba59-0008a693fe6a";
  assert.equal(compressibleFamilyOf(id, `${id}.stream.ndjson`), "stream");
  assert.equal(compressibleFamilyOf(id, `${id}.stream.3.ndjson`), "stream-segment");
  assert.equal(compressibleFamilyOf(id, `${id}.messages.ndjson`), "messages");
  assert.equal(compressibleFamilyOf(id, `${id}.timestamps.ndjson`), "timestamps");
  for (const never of [
    `${id}.json`,
    `${id}.json.bak-mig-20260101`,
    `${id}.delivery.json`,
    `${id}.owner.log`,
    `${id}.stream.lock`,
    `${id}.messages.ndjson.stale`,
    `${id}.stream.0.ndjson`,
    `${id}.session-brief.md`,
    "MANIFEST.tsv",
    `other.stream.ndjson`,
  ]) {
    assert.equal(compressibleFamilyOf(id, never), undefined, never);
  }
});

test("claiming: `<id>.<family>.zst` is claimed to <id>, never a candidate of its own; COMPRESSION/ is not an id", () => {
  const id = "019f4e32-0966-7c53-ba59-0008a693fe6a";
  const sets = claimArchiveFileSets([
    `${id}.json`,
    `${id}.stream.ndjson.zst`,
    `${id}.messages.ndjson.zst`,
    `${id}.timestamps.ndjson`,
    "COMPRESSION",
    "MANIFEST.tsv",
  ]);
  assert.deepEqual([...sets.keys()], [id]);
  assert.deepEqual(logicalFileSet(id, sets.get(id) ?? []), [
    `${id}.json`,
    `${id}.messages.ndjson`,
    `${id}.stream.ndjson`,
    `${id}.timestamps.ndjson`,
  ]);
});

// ─── resolver and verified reads ──────────────────────────────────────────────

test("plain wins: both forms present ⇒ the plain is read; absent in both ⇒ undefined, never empty bytes", async () => {
  const dir = await tempDir();
  try {
    const name = "a.stream.ndjson";
    const zstBytes = logicalSample();
    await fs.writeFile(path.join(dir, `${name}.zst`), encodeArchiveZst(zstBytes));
    await fs.writeFile(path.join(dir, name), "the plain is authoritative\n");
    assert.equal((await resolveArchivedFile(dir, name)).form, "plain");
    assert.equal(
      (await readArchivedFileVerified(dir, name))?.bytes.toString(),
      "the plain is authoritative\n",
    );
    await fs.unlink(path.join(dir, name));
    const read = await readArchivedFileVerified(dir, name);
    assert.equal(read?.form, "zst");
    assert.deepEqual(read?.bytes, zstBytes);
    assert.equal(await readArchivedFileVerified(dir, "missing.stream.ndjson"), undefined);
    assert.equal((await statArchivedFile(dir, name))?.logicalBytes, zstBytes.length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt .zst is an ERROR, never absent: readArchivedFileVerified throws, statArchivedFile too on a bad footer", async () => {
  const dir = await tempDir();
  try {
    const name = "b.messages.ndjson";
    const encoded = encodeArchiveZst(logicalSample());
    await fs.writeFile(path.join(dir, `${name}.zst`), encoded.subarray(0, -3));
    await assert.rejects(readArchivedFileVerified(dir, name), ArchivedFileCorrupt);
    await assert.rejects(statArchivedFile(dir, name), ArchivedFileCorrupt);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── writer protocol (CONCEPTION §3.6) ────────────────────────────────────────

/** Exact-to-the-µs mtime (plain `ms / 1000` truncates to `….x999`; see `setMtime`). */
async function writePlain(dir: string, name: string, data: Buffer, mtimeMs: number): Promise<void> {
  await fs.writeFile(path.join(dir, name), data);
  const seconds = (Math.round(mtimeMs * 1000) + 0.5) / 1e6;
  await fs.utimes(path.join(dir, name), seconds, seconds);
}

test("compress: the plain is replaced by a verified .zst carrying its mtime; begin is journalled first", async () => {
  const dir = await tempDir();
  try {
    await fs.mkdir(path.join(dir, "staging"));
    const name = "c.stream.ndjson";
    const logical = logicalSample();
    const mtimeMs = Date.parse("2026-09-01T10:00:00.123Z");
    await writePlain(dir, name, logical, mtimeMs);
    const journal: string[] = [];
    const outcome = await compressArchivedFile({
      dir,
      logicalName: name,
      stagingDir: path.join(dir, "staging"),
      journal: {
        begin: async (file, bytes, digest) => {
          journal.push(`${file} ${bytes} ${digest}`);
          // `begin` lands BEFORE any staging temp exists.
          assert.deepEqual(await fs.readdir(path.join(dir, "staging")), []);
        },
      },
    });
    assert.equal(outcome.status, "compressed");
    assert.deepEqual(journal, [`${name} ${logical.length} ${sha(logical)}`]);
    assert.deepEqual((await fs.readdir(dir)).toSorted(), [`${name}.zst`, "staging"]);
    assert.deepEqual(await fs.readdir(path.join(dir, "staging")), [], "no temp left behind");
    const stat = await fs.stat(path.join(dir, `${name}.zst`));
    assert.equal(Math.floor(stat.mtimeMs), Math.floor(mtimeMs));
    assert.deepEqual((await readArchivedFileVerified(dir, name))?.bytes, logical);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("compress: < 4096 B stays plain (small); incompressible data stays plain (ratio); both forms is reported, untouched", async () => {
  const dir = await tempDir();
  try {
    await fs.mkdir(path.join(dir, "staging"));
    const journal = { begin: async () => undefined };
    await writePlain(dir, "s.timestamps.ndjson", Buffer.from("tiny\n"), Date.now());
    const small = await compressArchivedFile({
      dir,
      logicalName: "s.timestamps.ndjson",
      stagingDir: path.join(dir, "staging"),
      journal,
    });
    assert.equal(small.status, "skipped");
    assert.equal(small.status === "skipped" && small.reason, "small");

    const noise = Buffer.from(
      Array.from({ length: 64 * 1024 }, () => Math.floor(Math.random() * 256)),
    );
    await writePlain(dir, "r.stream.ndjson", noise, Date.now());
    const ratio = await compressArchivedFile({
      dir,
      logicalName: "r.stream.ndjson",
      stagingDir: path.join(dir, "staging"),
      journal,
    });
    assert.equal(ratio.status === "skipped" && ratio.reason, "ratio");

    await writePlain(dir, "b.stream.ndjson", logicalSample(), Date.now());
    await fs.writeFile(path.join(dir, "b.stream.ndjson.zst"), encodeArchiveZst(logicalSample()));
    const both = await compressArchivedFile({
      dir,
      logicalName: "b.stream.ndjson",
      stagingDir: path.join(dir, "staging"),
      journal,
    });
    assert.equal(both.status, "both-forms");
    assert.deepEqual((await fs.readdir(dir)).toSorted(), [
      "b.stream.ndjson",
      "b.stream.ndjson.zst",
      "r.stream.ndjson",
      "s.timestamps.ndjson",
      "staging",
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("AC-2 writer side: a staged temp corrupted before step 5 ⇒ fail, no .zst committed, the plain's sha256 and mtime unchanged", async () => {
  const dir = await tempDir();
  const previous = process.env.ACPX_ARCHIVE_COMPRESS_FLIP_STAGED;
  try {
    await fs.mkdir(path.join(dir, "staging"));
    const name = "w.messages.ndjson";
    const logical = logicalSample();
    await writePlain(dir, name, logical, Date.parse("2026-09-03T00:00:00.000Z"));
    const before = await fs.stat(path.join(dir, name));
    process.env.ACPX_ARCHIVE_COMPRESS_FLIP_STAGED = "1";
    const outcome = await compressArchivedFile({
      dir,
      logicalName: name,
      stagingDir: path.join(dir, "staging"),
      journal: { begin: async () => undefined },
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" && outcome.error, "verify-failed");
    assert.deepEqual((await fs.readdir(dir)).toSorted(), ["staging", name]);
    assert.deepEqual(await fs.readdir(path.join(dir, "staging")), []);
    assert.equal(sha(await fs.readFile(path.join(dir, name))), sha(logical));
    const after = await fs.stat(path.join(dir, name));
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ino, before.ino, "the plain itself was never rewritten");
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_ARCHIVE_COMPRESS_FLIP_STAGED;
    } else {
      process.env.ACPX_ARCHIVE_COMPRESS_FLIP_STAGED = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("stageDecompressed: a corrupt .zst throws and leaves NO temp; a good one stages the logical bytes with the .zst's mtime", async () => {
  const dir = await tempDir();
  try {
    const staging = path.join(dir, "staging");
    await fs.mkdir(staging);
    const logical = logicalSample();
    const good = path.join(dir, "g.stream.ndjson.zst");
    await fs.writeFile(good, encodeArchiveZst(logical));
    await fs.utimes(good, 1_780_000_000, 1_780_000_000);
    const staged = await stageDecompressed(good, "g.stream.ndjson", staging);
    assert.deepEqual(await fs.readFile(staged.temp), logical);
    assert.equal(Math.floor((await fs.stat(staged.temp)).mtimeMs), 1_780_000_000_000);

    const bad = path.join(dir, "h.stream.ndjson.zst");
    const encoded = encodeArchiveZst(logical);
    await fs.writeFile(bad, encoded.subarray(0, -1));
    await assert.rejects(stageDecompressed(bad, "h.stream.ndjson", staging), ArchivedFileCorrupt);
    assert.deepEqual(await fs.readdir(staging), [path.basename(staged.temp)]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── the box-local atrium (HoD 2026-10-29: never the public mTLS host) ────────

test("resolveAtriumLocalOrigin: an https (public, mTLS) base URL is NEVER used; http is kept; Service, then loopback", () => {
  const ns = { namespaceFile: "dev-devbox\n" };
  const service = "http://dev-server.dev-devbox.svc.cluster.local:3456";
  assert.equal(
    resolveAtriumLocalOrigin({ ACPX_UI_BASE_URL: "https://atrium.devbox.nativai.de" }, ns),
    service,
    "the public host fails the TLS handshake from the control pod",
  );
  assert.equal(
    resolveAtriumLocalOrigin({ ACPX_UI_BASE_URL: "http://127.0.0.1:3999/" }, ns),
    "http://127.0.0.1:3999",
    "a rig's explicit loopback listener probes itself",
  );
  assert.equal(
    resolveAtriumLocalOrigin(
      { ACPX_UI_BASE_URL: "https://x", ACPX_UI_INTERNAL_URL: "http://internal:1" },
      ns,
    ),
    "http://internal:1",
  );
  assert.equal(
    resolveAtriumLocalOrigin({ ACPX_UI_BASE_URL: "https://x" }, {}),
    "http://127.0.0.1:3456",
  );
  // The live sources reader never throws (it is called on every probe).
  assert.equal(typeof readAcpxUiInternalOriginSources(), "object");
});
