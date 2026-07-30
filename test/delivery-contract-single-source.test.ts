import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// T11c — ONE CANONICAL DEFINITION PER CONTRACTED MESSAGE (brick://53437107).
//
// This programme exists because two repos disagreed about one string. During its
// own implementation, two LANES then disagreed about one string: the same detail
// code was emitted with two different wordings, every gate in both lanes green,
// because both texts satisfied acpx-ui's substring rule. One of them additionally
// opened byte-identical to acpx-ui's INVENTED fallback, which would have destroyed
// the forensic separability corollary C-3 requires.
//
// That was caught by a human grep. This test is that grep, made mechanical —
// because a property that needs a careful reader is a documented intention, not a
// guard, and the failure mode here is precisely an instruction that is EASY to
// follow and WRONG ("just put the literal here").
// ---------------------------------------------------------------------------

// The single module every emitter must read these from.
const CANONICAL = path.join("src", "cli", "queue", "delivery-terminals.ts");

// Scoped to src/ DELIBERATELY: that is where the emitters live. A copy in
// scripts/ or examples/ would escape this guard. Stated rather than implied —
// a boundary you have declared is a different object from one you never noticed.
const SCAN_ROOT = "src";

async function collectTsFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Remove comment lines so prose ABOUT a contracted message is not mistaken for a
 * DEFINITION of one.
 *
 * This matters more than it looks. Comments in this area quote these strings on
 * purpose — `runtime.ts` quotes acpx-ui's fallback text to explain why our wording
 * deliberately differs from it, and that comment is the mechanism that caught the
 * original collision. A guard that redded on such a comment would punish exactly
 * the documentation habit that found the defect.
 *
 * THE BACKTICK EXCEPTION IS NOT OPTIONAL — do not "simplify" it away. A line
 * inside a template literal can legitimately begin with `*` (a markdown bullet in
 * a multi-line message), and a prefix-based stripper cannot tell that from a
 * comment. Without this condition, a LIVE string on such a line is silently
 * exempted and the guard is evaded by accident rather than by malice. Found by
 * adversarial review of the sibling repo's identical guard — brick://9ed63117.
 *
 * So the layering, which is invisible from the code and is why each layer exists:
 *   1. a mechanical check is needed, because a comment only works if someone reads it;
 *   2. it must be comment-aware, because the comment's job is to QUOTE the very
 *      thing the check searches for;
 *   3. the comment-awareness must be backtick-aware, or step 2 becomes the hole.
 * Every layer here exists because the previous one was too naive.
 */
function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const looksLikeComment = /^\s*(\/\/|\*|\/\*)/.test(line);
      return !looksLikeComment || line.includes("`");
    })
    .join("\n");
}

type ContractFixture = {
  quiesceRejection: { message: string };
  ownerExitTerminals: Array<{ detailCode: string; message: string }>;
};

// DERIVED FROM THE FIXTURE, NEVER TRANSCRIBED. A hand-maintained list here would
// recreate the exact defect this test exists to catch, one level up: the list and
// the contract would drift, and the test would go on passing.
async function contractedMessages(): Promise<Array<{ label: string; message: string }>> {
  const fixture = JSON.parse(
    await fs.readFile(
      path.resolve(process.cwd(), "test/fixtures/delivery-contract.fixture.json"),
      "utf8",
    ),
  ) as ContractFixture;

  return [
    { label: "quiesceRejection", message: fixture.quiesceRejection.message },
    ...fixture.ownerExitTerminals.map((entry) => ({
      label: entry.detailCode,
      message: entry.message,
    })),
  ];
}

test("T11c every contracted message has exactly one definition in src/", async () => {
  const messages = await contractedMessages();
  assert.ok(messages.length > 0, "the fixture must yield the contracted messages");

  const files = await collectTsFiles(path.resolve(process.cwd(), SCAN_ROOT));
  const sources = await Promise.all(
    files.map(async (file) => ({
      // Repo-relative, so failure output is readable and platform-stable.
      file: path.relative(process.cwd(), file),
      code: stripCommentLines(await fs.readFile(file, "utf8")),
    })),
  );

  for (const { label, message } of messages) {
    // Searching the raw text AFTER stripping comments — not a quoted form.
    // Once prose is gone, any remaining occurrence is necessarily inside a string,
    // so this stays correct for '…', "…" and `…` alike. Matching a quoted form
    // would have missed a template-literal definition, which is a legitimate way
    // to write one.
    const definingFiles = sources
      .filter((entry) => entry.code.includes(message))
      .map((entry) => entry.file)
      .toSorted();

    assert.deepEqual(
      definingFiles,
      [CANONICAL],
      `${label}: a contracted message must be defined exactly once, in ${CANONICAL}. ` +
        `Found in: ${definingFiles.join(", ") || "(nowhere — has the canonical module moved?)"}. ` +
        `A second definition is a DEFECT, not untidiness: both copies can be green ` +
        `while they silently diverge in the field under one detail code.`,
    );
  }
});

// STATED LIMIT, so nobody reads this guard as broader than it is.
//
// It catches VERBATIM duplication — copy-paste, or a brief that suggests a
// literal, which is exactly how the real collision happened. It does NOT catch a
// message reassembled by concatenation, and no static check closes that without
// becoming a parser. Scoped to the failure mode actually observed rather than to
// an imagined adversary; a guard whose stated scope exceeds its real scope is
// worse than a narrow one honestly labelled.
test("T11c the guard's scope is stated, not implied", async () => {
  const messages = await contractedMessages();
  const canonical = await fs.readFile(path.resolve(process.cwd(), CANONICAL), "utf8");
  for (const { label, message } of messages) {
    assert.ok(
      canonical.includes(message),
      `${label}: the canonical module must actually define it — otherwise the ` +
        `uniqueness assertion above would pass vacuously with zero definitions.`,
    );
  }
});
