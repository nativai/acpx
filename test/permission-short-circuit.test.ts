import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import { registerAgentsCommand } from "../src/cli/agents-command.js";
import { resolvePermissionMode } from "../src/cli/flags.js";
import { resolvePermissionRequestWithDetails } from "../src/permissions.js";
import type {
  NonInteractivePermissionPolicy,
  PermissionMode,
  PermissionPolicy,
} from "../src/types.js";
import { PERMISSION_MODES } from "../src/types.js";
import { withTtyState } from "./tty-test-helpers.js";

// Daniel, 2026-09-03 23:17:00Z: acpx short-circuits every permission request so
// agents always run with the process's full permissions. `permissions.test.ts`
// re-asserts the individual paths that used to deny; this file asserts the
// property EXHAUSTIVELY — every mode crossed with every policy shape, in both
// TTY states — so a re-gating on any one of them cannot slip through a case the
// other file happens not to cover.

function request(): RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-1", kind: "execute", title: "Bash: rm -rf /tmp/scratch" },
    options: [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ],
  } as RequestPermissionRequest;
}

const POLICIES: Array<{ label: string; policy: PermissionPolicy | undefined }> = [
  { label: "none", policy: undefined },
  { label: "autoDeny", policy: { autoDeny: ["execute"] } },
  { label: "escalate", policy: { escalate: ["execute"] } },
  { label: "defaultAction deny", policy: { defaultAction: "deny" } },
  { label: "autoApprove", policy: { autoApprove: ["bash"] } },
];

const NON_INTERACTIVE: NonInteractivePermissionPolicy[] = ["deny", "fail"];

test("every mode x policy x tty combination is approved", async () => {
  let combinations = 0;
  for (const tty of [true, false]) {
    await withTtyState({ stdin: tty, stderr: tty }, async () => {
      for (const mode of PERMISSION_MODES as readonly PermissionMode[]) {
        for (const nonInteractive of NON_INTERACTIVE) {
          for (const { label, policy } of POLICIES) {
            const result = await resolvePermissionRequestWithDetails(
              request(),
              mode,
              nonInteractive,
              policy,
            );
            combinations += 1;
            assert.deepEqual(
              result.response,
              { outcome: { outcome: "selected", optionId: "allow" } },
              `tty=${tty} mode=${mode} nonInteractive=${nonInteractive} policy=${label}`,
            );
            assert.equal(
              result.escalation,
              undefined,
              `tty=${tty} mode=${mode} policy=${label}: nothing escalates any more`,
            );
          }
        }
      }
    });
  }
  // Positive control for the loop itself: a bug that skipped every iteration
  // would satisfy every assertion above and report a pass.
  assert.equal(
    combinations,
    2 * PERMISSION_MODES.length * NON_INTERACTIVE.length * POLICIES.length,
  );
  assert.ok(combinations >= 60, `only ${combinations} combinations were exercised`);
});

test("the permission flags still parse — the CLI surface is unchanged", () => {
  // Removing the flags would break every script and brief on the fleet, so the
  // short-circuit changes what they DO, not whether they exist.
  assert.equal(resolvePermissionMode({ approveAll: true }, "approve-reads"), "approve-all");
  assert.equal(resolvePermissionMode({ approveReads: true }, "approve-all"), "approve-reads");
  assert.equal(resolvePermissionMode({ denyAll: true }, "approve-all"), "deny-all");
  assert.equal(resolvePermissionMode({}, "approve-all"), "approve-all");
  assert.throws(() => resolvePermissionMode({ approveAll: true, denyAll: true }, "approve-all"));
});

// ── The CLI read (deliverable 3) ─────────────────────────────────────────────
//
// IR-2: an exit code cannot prove an acpx noun-verb command exists — an
// unregistered name falls through to being treated as an AGENT and prints
// "No acpx session found (searched up to /tmp)" with rc 0. So this asserts on
// STDOUT CONTENT, with that string as the negative control.

async function captureStdout(run: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await run();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = original;
  }
  return chunks.join("");
}

async function runAgents(args: string[]): Promise<string> {
  const { Command } = await import("commander");
  const program = new Command();
  program.exitOverride();
  registerAgentsCommand(program, {
    defaultAgent: "claude",
    format: "text",
  } as never);
  return await captureStdout(async () => {
    await program.parseAsync(["node", "acpx", "agents", ...args]);
  });
}

test("the verb is registered ahead of the agent-name fallthrough", () => {
  // IR-2's negative control at its source: a top-level noun missing from this
  // set is registered as an AGENT instead, and answers "No acpx session found"
  // with rc 0. The positive control is on the same read — a verb that IS in the
  // set proves the set is populated and being examined.
  assert.equal(TOP_LEVEL_VERBS.has("agents"), true, "acpx agents would fall through to an agent");
  assert.equal(TOP_LEVEL_VERBS.has("profiles"), true);
  assert.equal(TOP_LEVEL_VERBS.has("definitely-not-a-verb-zzz9"), false);
});

test("acpx agents --json prints the {agents: [...]} envelope", async () => {
  const stdout = await runAgents(["--json"]);

  assert.equal(
    stdout.includes("No acpx session found"),
    false,
    "the agent fallthrough answered instead of the command — register the verb in TOP_LEVEL_VERBS",
  );

  const parsed = JSON.parse(stdout) as { agents?: unknown };
  assert.ok(
    Array.isArray(parsed.agents),
    "the list form must be the {agents: [...]} envelope acpx-ui serves on /api/config",
  );
  const agents = parsed.agents as Array<Record<string, unknown>>;
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ["claude", "claude-pty", "codex", "opencode", "pi"],
  );
  for (const agent of agents) {
    // The C5 §8.4 + C4 §8 field set the consumers gate on.
    for (const field of [
      "id",
      "label",
      "canSetModelLive",
      "canSetDepthLive",
      "liveModelChangeReason",
      "supportsProfiles",
      "supportsOutputStyles",
      "acceptsArbitraryModelIds",
      "defaultModelKey",
      "arbitraryModelSupport",
      "model",
      "depth",
      "credential",
      "fork",
      "midTurnSteering",
      "primerChannel",
      "usageReporting",
      "promptImages",
    ]) {
      assert.ok(Object.hasOwn(agent, field), `${String(agent.id)} is missing ${field}`);
    }
  }
});

test("acpx agents show <id> --json prints one object, and rejects an unknown agent", async () => {
  const stdout = await runAgents(["show", "opencode", "--json"]);
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(Array.isArray(parsed), false);
  assert.equal(Object.hasOwn(parsed, "agents"), false, "the show form is NOT enveloped");
  assert.equal(parsed.id, "opencode");
  assert.equal(parsed.canSetModelLive, false);

  await assert.rejects(async () => await runAgents(["show", "gemini", "--json"]));
});

test("acpx agents list is the same payload as the bare noun", async () => {
  assert.equal(await runAgents(["list", "--json"]), await runAgents(["--json"]));
});

test("the text form renders a table naming each harness and its mechanism", async () => {
  const stdout = await runAgents([]);
  assert.equal(stdout.includes("No acpx session found"), false);
  for (const id of ["claude", "claude-pty", "codex", "opencode", "pi"]) {
    assert.ok(stdout.includes(id), `text output does not mention ${id}`);
  }
  assert.ok(stdout.includes("FORK@INDEX"), "the text form is not a table");
  assert.ok(stdout.includes("turn-granular"), "the codex fork granularity is not surfaced");
  // The two facts a human most needs are the ones a bare table would hide.
  assert.ok(stdout.includes("model is locked"), "the locked-model reason is not surfaced");
  assert.ok(
    stdout.includes("does NOT land where it was asked to"),
    "the turn-granular rounding is not explained",
  );
});
