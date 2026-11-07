import assert from "node:assert/strict";
import test from "node:test";
import { registerAgentsCommand } from "../src/cli/agents-command.js";
import {
  CONTROL_POD_SESSION_ROOT,
  effectiveCreateCwd,
  resolveSessionRoot,
  sessionRootOverrideNotice,
} from "../src/config/session-root.js";
import { AcpxOperationalError } from "../src/errors.js";

// brick 45917618 §5.1 / §5.9 — the one resolver of the fixed session root, and the key atrium
// reads it from. TEST-PLAN rows B8 (relative value refused) and B9 (all four sources reported).

test("resolveSessionRoot: control pod → /workspace; not a control pod → off (upstream behaviour)", () => {
  assert.deepEqual(resolveSessionRoot({}, true), {
    enforced: true,
    root: CONTROL_POD_SESSION_ROOT,
    source: "control-pod",
  });
  assert.equal(CONTROL_POD_SESSION_ROOT, "/workspace");
  assert.deepEqual(resolveSessionRoot({}, false), {
    enforced: false,
    root: null,
    source: "not-control-pod",
  });
});

test("resolveSessionRoot: ACPX_SESSION_ROOT wins on and off a control pod; empty switches it off", () => {
  for (const controlPod of [true, false]) {
    assert.deepEqual(resolveSessionRoot({ ACPX_SESSION_ROOT: "/srv/root/" }, controlPod), {
      enforced: true,
      root: "/srv/root",
      source: "env",
    });
    // Present-but-empty is a SETTING (legacy fixtures on a rig), not an absence.
    for (const empty of ["", "   "]) {
      assert.deepEqual(resolveSessionRoot({ ACPX_SESSION_ROOT: empty }, controlPod), {
        enforced: false,
        root: null,
        source: "env-off",
      });
    }
  }
});

test("B8: a relative ACPX_SESSION_ROOT is a usage error naming the variable, never a guessed base", () => {
  for (const value of ["relative/dir", "./x", "workspace"]) {
    assert.throws(
      () => resolveSessionRoot({ ACPX_SESSION_ROOT: value }, true),
      (error: unknown) =>
        error instanceof AcpxOperationalError &&
        error.outputCode === "USAGE" &&
        error.message.includes("ACPX_SESSION_ROOT"),
    );
    assert.throws(() => effectiveCreateCwd("/tmp/x", { ACPX_SESSION_ROOT: value }));
  }
});

test("effectiveCreateCwd: the root when enforced, the resolved request otherwise", () => {
  assert.equal(effectiveCreateCwd("/tmp/x", { ACPX_SESSION_ROOT: "/workspace" }), "/workspace");
  assert.equal(effectiveCreateCwd("/tmp/x/../y", { ACPX_SESSION_ROOT: "" }), "/tmp/y");
  assert.equal(effectiveCreateCwd("/tmp/x", { NV_DEV_SERVER_ROLE: "control" }), "/workspace");
});

test("the override notice prints only on a control pod, and only for the env sources", () => {
  assert.equal(
    sessionRootOverrideNotice({ ACPX_SESSION_ROOT: "" }, true),
    "[acpx] ACPX_SESSION_ROOT=(empty) overrides the fixed session root on this control pod (test and rig use only)\n",
  );
  assert.equal(
    sessionRootOverrideNotice({ ACPX_SESSION_ROOT: "/srv/r" }, true),
    "[acpx] ACPX_SESSION_ROOT=/srv/r overrides the fixed session root on this control pod (test and rig use only)\n",
  );
  // Negative cases: a rig on a workbench (not a control pod) and the plain control pod are silent.
  assert.equal(sessionRootOverrideNotice({ ACPX_SESSION_ROOT: "/workspace" }, false), undefined);
  assert.equal(sessionRootOverrideNotice({}, true), undefined);
});

async function agentsJson(
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const { Command } = await import("commander");
    const program = new Command();
    program.exitOverride();
    registerAgentsCommand(program, { defaultAgent: "claude", format: "text" } as never);
    await program.parseAsync(["node", "acpx", "agents", "--json"]);
  } finally {
    (process.stdout as unknown as { write: unknown }).write = original;
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

test("B9: acpx agents --json reports sessionRoot; the agents array is unchanged", async () => {
  // The not-control-pod arm is pinned at the resolver (injected seam, above): the image marker is
  // read once per process and cannot be varied here. These three arms hold on either pod role.
  assert.deepEqual(
    (await agentsJson({ ACPX_SESSION_ROOT: undefined, NV_DEV_SERVER_ROLE: "control" })).sessionRoot,
    { enforced: true, root: "/workspace", source: "control-pod" },
  );
  assert.deepEqual(
    (await agentsJson({ ACPX_SESSION_ROOT: "/srv/rig", NV_DEV_SERVER_ROLE: "x" })).sessionRoot,
    { enforced: true, root: "/srv/rig", source: "env" },
  );
  const off = await agentsJson({ ACPX_SESSION_ROOT: "", NV_DEV_SERVER_ROLE: "control" });
  assert.deepEqual(off.sessionRoot, { enforced: false, root: null, source: "env-off" });
  // The envelope only GREW: `agents` is still the array of three descriptors.
  assert.deepEqual(
    (off.agents as Array<{ id: string }>).map((agent) => agent.id),
    ["claude", "codex", "pi"],
  );
  assert.deepEqual(Object.keys(off).toSorted(), ["agents", "sessionRoot"]);
});
