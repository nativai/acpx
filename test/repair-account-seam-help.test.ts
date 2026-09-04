import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { registerDefaultCommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";

// Ride-along https://acpx.devbox.nativai.de/?brick=27cdb9fa — `sessions
// repair-account-seam --help` must name where the backups actually go and how to
// get a record back.
//
// ⚠️ WHY A TEST FOR HELP TEXT. On 2026-09-04 two independent readers each
// concluded a real, correct, fully-evidenced 58-record production sweep had never
// run: they looked in ~/.acpx/backups, found nothing, and the backups were
// elsewhere. The help said "(default: ~/.acpx/backups/…)" while the code resolves
// `process.env.ACPX_STATE_HOME || os.homedir()`, so under any isolated state home
// that sentence was false. Two readers reaching the identical wrong conclusion is
// a design signal, not two mistakes — and a false help line is what a reader
// trusts INSTEAD of reading the code.

function fakeConfig(): ResolvedAcpxConfig {
  return {
    defaultAgent: "codex",
    defaultPermissions: "approve-all",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    ttlMs: 900_000,
    queueMaxDepth: 16,
    format: "text",
    agents: {},
    auth: {},
    disableExec: false,
    mcpServers: [],
    subscriptions: { version: 3, subscriptions: [], profiles: [] },
    globalPath: "/tmp/acpx-test-config.json",
    projectPath: "/tmp/.acpxrc.json",
    hasGlobalConfig: false,
    hasProjectConfig: false,
  } as unknown as ResolvedAcpxConfig;
}

/**
 * The help a USER actually sees.
 *
 * ⚠️ NOT `helpInformation()` — and this is a trap worth naming, because it cost
 * a red on a correct change. `helpInformation()` renders only the usage block,
 * options and description; it silently OMITS everything added via
 * `addHelpText()`. So a test written against it asserts the absence of text the
 * real `--help` prints, i.e. it measures a surface one step to the side of the
 * one the reader reads. `outputHelp()` with a captured writer is the real thing.
 */
function repairHelpText(): string {
  const program = new Command();
  registerDefaultCommands(program, fakeConfig());
  const sessions = program.commands.find((command) => command.name() === "sessions");
  assert.ok(sessions, "sessions command must be registered — otherwise this test is vacuous");
  const repair = sessions.commands.find((command) => command.name() === "repair-account-seam");
  assert.ok(repair, "repair-account-seam must be registered — otherwise this test is vacuous");

  let captured = "";
  repair.configureOutput({
    writeOut: (text: string) => {
      captured += text;
    },
    writeErr: (text: string) => {
      captured += text;
    },
  });
  repair.outputHelp();
  return captured;
}

test("--help names the ACPX_STATE_HOME-dependent default, not just ~/.acpx", () => {
  const help = repairHelpText();
  // ⚠️ CONTROL FIRST: prove this string was reached at all. A help dump that
  // came back empty, or from the wrong command, would satisfy every `match`
  // below only if they were negative — so assert something that must be present.
  assert.match(help, /--backup-dir/, "control: the flag itself must appear in this help text");

  assert.match(
    help,
    /ACPX_STATE_HOME/,
    "the default is $ACPX_STATE_HOME-rooted when that variable is set; saying only ~/.acpx is " +
      "the exact falsehood that made two readers conclude the sweep never ran",
  );
  assert.match(
    help,
    /\$HOME/,
    "and $HOME otherwise — measured on this box, the backups of a real sweep sat under " +
      "/workspace/hp/home/.acpx/backups while /home/node/.acpx/backups did not exist at all",
  );
  assert.match(help, /account-seam-repair-<ts>/);

  // ⚠️ "~" IS THE TOKEN THAT CAUSED THE FAILURE — a reader resolves it against
  // their OWN home, which is exactly the wrong home under an isolated HOME. The
  // help must not reintroduce it as the stated default.
  assert.doesNotMatch(
    help,
    /default:[^\n]*~\/\.acpx\/backups/,
    "do not state the default as ~/.acpx/backups — that is the sentence two readers believed",
  );

  // The run's own printed `backups: <dir>` line is authoritative over any default.
  assert.match(help, /prints the directory/i);
});

test("--help names the restore procedure AND the caveat that a cp is not the sweep", () => {
  const help = repairHelpText();
  assert.match(help, /owner-status/, "the restore must tell you to check for a live owner first");
  assert.match(help, /\bcp\b/, "the restore must give the actual command");

  // ⚠️ THE CAVEAT IS THE LOAD-BEARING HALF. Naming a restore without it invites
  // a cp underneath a live queue owner, which is silently overwritten by that
  // owner's next checkpoint — the restore appears to work and is gone.
  assert.match(help, /ATOMIC/i);
  assert.match(help, /REFUSES/i);
  assert.match(help, /silently overwritten/i);

  // And it must NOT promise a restore mode that does not exist: `storeDir` /
  // `loadRecords` / `saveRecord` are TEST SEAMS on repairAccountSeamRecords, not
  // CLI flags, so "re-run the sweep against the backup dir" is unreachable from
  // the command line and must not be printed as a procedure.
  assert.doesNotMatch(
    help,
    /re-run the sweep against the backup/i,
    "that procedure is not reachable from the CLI — do not document it as one",
  );
});
