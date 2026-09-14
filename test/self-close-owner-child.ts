// The innermost descendant of the self-close rig (test/self-close.test.ts).
//
// Compiled to `dist-test/test/self-close-owner-child.js` by `build:test` (the
// test tsconfig compiles every `test/**/*.ts`) and spawned as the GRANDCHILD of
// the planted owner process: owner → this → the close. It is the stand-in for
// the production shape `queue owner → ACP adapter → agent → acpx sessions
// close`, i.e. the CLI process whose ancestry contains the very owner the
// close must terminate.
//
// Not a test file (no `.test.` in the name) — `node --test` never picks it up;
// it only exists to be spawned.
//
// Waits for the go-file before closing so the parent test can plant the owner
// lease FIRST: spawning the chain before the lease would race, and a close
// that runs before the lease exists takes the non-self arm — a red caused by
// the harness, not by the code under test.
import { closeSession } from "../src/cli/session/session-control.js";

const sessionId = process.argv[2];
const goFile = process.argv[3];
if (!sessionId || !goFile) {
  process.stderr.write("usage: self-close-owner-child <sessionId> <goFile>\n");
  process.exit(2);
}

const goDeadline = Date.now() + 30_000;
for (;;) {
  try {
    await import("node:fs/promises").then((fs) => fs.stat(goFile));
    break;
  } catch {
    if (Date.now() > goDeadline) {
      process.stderr.write("self-close rig: go-file never arrived\n");
      process.exit(3);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

try {
  const result = await closeSession(sessionId);
  // Only reached when this process survives its own close — the fixed order
  // makes that possible (the write lands before the owner kill), but the
  // faithful cascade in the intermediate may still kill us first. Either way
  // the RECORD on disk is the assertion; this output is best-effort evidence.
  process.stdout.write(
    `${JSON.stringify({ closed: result.record.closed, drain: result.drain })}\n`,
  );
} catch (error) {
  process.stderr.write(`self-close-owner-child: ${String(error)}\n`);
  process.exitCode = 1;
}
