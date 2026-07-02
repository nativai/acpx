import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPrimerSessionMeta, resolvePrimerChannel } from "../src/acp/agent-command.js";
import { AcpClient } from "../src/acp/client.js";
import { resetSessionPrimerMemoForTests, resolveSessionPrimer } from "../src/acp/session-primer.js";

// Unified OS-primer injection at the acpx layer (CONCEPTION §4). acpx runs the
// session-context primer once per process and routes it to the right `_meta`
// channel per agent type: claude/claude-pty → `systemPrompt {append}`, codex →
// `codex.developerInstructions`, unknown agents → nothing. Re-supplied on cold
// resume for the system-prompt channels only (codex restores from thread).

const SDK_CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const CLAUDE_PTY_COMMAND = "node /opt/claude-pty-acp/dist/index.js";
const CODEX_COMMAND = "node /opt/codex-acp/dist/index.js";
const UNKNOWN_COMMAND = "node ./test/mock-agent.js";

const PRIMER_SEPARATOR = "\n\n---\n\n";

// ---------------------------------------------------------------------------
// §4.3 — channel routing by agent type (substring detectors)
// ---------------------------------------------------------------------------

test("resolvePrimerChannel: claude + claude-pty route to the system-prompt channel", () => {
  assert.equal(resolvePrimerChannel(SDK_CLAUDE_COMMAND), "system-prompt");
  assert.equal(resolvePrimerChannel(CLAUDE_PTY_COMMAND), "system-prompt");
  // dev override forms still match (substring, not exact registry string)
  assert.equal(
    resolvePrimerChannel("node /workspace/projects/claude-agent-acp/dev/dist/index.js"),
    "system-prompt",
  );
  assert.equal(
    resolvePrimerChannel("node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs"),
    "system-prompt",
  );
});

test("resolvePrimerChannel: codex routes to the developer-instructions channel", () => {
  assert.equal(resolvePrimerChannel(CODEX_COMMAND), "developer-instructions");
  assert.equal(
    resolvePrimerChannel("npx -y @agentclientprotocol/codex-acp"),
    "developer-instructions",
  );
});

test("resolvePrimerChannel: unknown agents inject nothing", () => {
  assert.equal(resolvePrimerChannel(UNKNOWN_COMMAND), "none");
  assert.equal(resolvePrimerChannel("gemini --acp"), "none");
  assert.equal(resolvePrimerChannel("copilot --acp"), "none");
});

// ---------------------------------------------------------------------------
// §4.4 — wire format / append composition
// ---------------------------------------------------------------------------

test("buildPrimerSessionMeta: system-prompt channel with primer only emits an append fragment", () => {
  assert.deepEqual(buildPrimerSessionMeta("system-prompt", "PRIMER", undefined), {
    systemPrompt: { append: "PRIMER" },
  });
});

test("buildPrimerSessionMeta: human --append-system-prompt composes primer FIRST, human LAST", () => {
  assert.deepEqual(buildPrimerSessionMeta("system-prompt", "PRIMER", { append: "HUMAN" }), {
    systemPrompt: { append: `PRIMER${PRIMER_SEPARATOR}HUMAN` },
  });
});

test("buildPrimerSessionMeta: brick context composes after primer and before human append", () => {
  assert.deepEqual(
    buildPrimerSessionMeta("system-prompt", "PRIMER", { append: "HUMAN" }, "BRICK"),
    {
      systemPrompt: { append: `PRIMER${PRIMER_SEPARATOR}BRICK${PRIMER_SEPARATOR}HUMAN` },
    },
  );
  assert.deepEqual(buildPrimerSessionMeta("system-prompt", undefined, undefined, "BRICK"), {
    systemPrompt: { append: "BRICK" },
  });
});

test("buildPrimerSessionMeta: human --system-prompt (replace string) skips the auto-primer (Q4)", () => {
  // Returning undefined leaves the human replace string untouched in optionsMeta.
  assert.equal(buildPrimerSessionMeta("system-prompt", "PRIMER", "REPLACE-ALL"), undefined);
  assert.equal(
    buildPrimerSessionMeta("system-prompt", "PRIMER", "REPLACE-ALL", "BRICK"),
    undefined,
  );
});

test("buildPrimerSessionMeta: codex channel emits developerInstructions and NOT systemPrompt", () => {
  const meta = buildPrimerSessionMeta("developer-instructions", "PRIMER", undefined);
  assert.deepEqual(meta, { codex: { developerInstructions: "PRIMER" } });
  assert.equal((meta as Record<string, unknown>).systemPrompt, undefined);
  assert.deepEqual(buildPrimerSessionMeta("developer-instructions", "PRIMER", undefined, "BRICK"), {
    codex: { developerInstructions: `PRIMER${PRIMER_SEPARATOR}BRICK` },
  });
});

test("buildPrimerSessionMeta: none channel / empty primer yields no fragment", () => {
  assert.equal(buildPrimerSessionMeta("none", "PRIMER", undefined), undefined);
  assert.equal(buildPrimerSessionMeta("system-prompt", undefined, undefined), undefined);
  assert.equal(buildPrimerSessionMeta("system-prompt", "", undefined), undefined);
  assert.equal(buildPrimerSessionMeta("none", "PRIMER", undefined, "BRICK"), undefined);
});

// ---------------------------------------------------------------------------
// §4.2 — primer resolution: exec, memoize success, fail open
// ---------------------------------------------------------------------------

async function withPrimerScript(
  body: string,
  run: (scriptPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-primer-"));
  const scriptPath = path.join(dir, "primer.sh");
  await fs.writeFile(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const previous = process.env.ACPX_SESSION_PRIMER_COMMAND;
  process.env.ACPX_SESSION_PRIMER_COMMAND = scriptPath;
  resetSessionPrimerMemoForTests();
  try {
    await run(scriptPath);
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_SESSION_PRIMER_COMMAND;
    } else {
      process.env.ACPX_SESSION_PRIMER_COMMAND = previous;
    }
    resetSessionPrimerMemoForTests();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withPrimerCommand(command: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.ACPX_SESSION_PRIMER_COMMAND;
  process.env.ACPX_SESSION_PRIMER_COMMAND = command;
  resetSessionPrimerMemoForTests();
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_SESSION_PRIMER_COMMAND;
    } else {
      process.env.ACPX_SESSION_PRIMER_COMMAND = previous;
    }
    resetSessionPrimerMemoForTests();
  }
}

test("resolveSessionPrimer: captures stdout of the configured command", async () => {
  await withPrimerScript("printf '# Current host\\nEND-OF-PRIMER\\n'", async () => {
    const primer = await resolveSessionPrimer();
    assert.ok(primer);
    assert.match(primer, /# Current host/);
    // The WHOLE output is carried (no truncation to a saved-to-path preview).
    assert.match(primer, /END-OF-PRIMER/);
  });
});

test("resolveSessionPrimer: memoizes SUCCESS for the process lifetime", async () => {
  await withPrimerScript("printf 'FIRST\\n'", async (scriptPath) => {
    const first = await resolveSessionPrimer();
    assert.match(first ?? "", /FIRST/);
    // Mutate the script: a memoized success must NOT re-exec.
    await fs.writeFile(scriptPath, "#!/bin/sh\nprintf 'SECOND\\n'\n", { mode: 0o755 });
    const second = await resolveSessionPrimer();
    assert.equal(second, first);
  });
});

test("resolveSessionPrimer: fail-open (missing script) returns undefined, never throws", async () => {
  await withPrimerCommand("/nonexistent/acpx-test-primer.sh", async () => {
    assert.equal(await resolveSessionPrimer(), undefined);
  });
});

test("resolveSessionPrimer: fail-open (non-zero exit) returns undefined", async () => {
  await withPrimerScript("echo boom >&2; exit 3", async () => {
    assert.equal(await resolveSessionPrimer(), undefined);
  });
});

test("resolveSessionPrimer: fail-open (empty output) returns undefined", async () => {
  await withPrimerScript("exit 0", async () => {
    assert.equal(await resolveSessionPrimer(), undefined);
  });
});

test("resolveSessionPrimer: a failure is NOT memoized — a later success still resolves", async () => {
  const previous = process.env.ACPX_SESSION_PRIMER_COMMAND;
  resetSessionPrimerMemoForTests();
  try {
    process.env.ACPX_SESSION_PRIMER_COMMAND = "/nonexistent/acpx-test-primer.sh";
    assert.equal(await resolveSessionPrimer(), undefined);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-primer-"));
    const scriptPath = path.join(dir, "primer.sh");
    await fs.writeFile(scriptPath, "#!/bin/sh\nprintf 'RECOVERED\\n'\n", { mode: 0o755 });
    process.env.ACPX_SESSION_PRIMER_COMMAND = scriptPath;
    const primer = await resolveSessionPrimer();
    assert.match(primer ?? "", /RECOVERED/);
    await fs.rm(dir, { recursive: true, force: true });
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_SESSION_PRIMER_COMMAND;
    } else {
      process.env.ACPX_SESSION_PRIMER_COMMAND = previous;
    }
    resetSessionPrimerMemoForTests();
  }
});

// ---------------------------------------------------------------------------
// §4.5 — end-to-end through AcpClient: new-session merge + resume re-supply
// ---------------------------------------------------------------------------

type CapturedConnection = {
  newSessionMeta?: Record<string, unknown>;
  resumeMeta?: Record<string, unknown> | "absent";
};

function makeClient(agentCommand: string, sessionOptions?: Record<string, unknown>): AcpClient {
  return new AcpClient({
    agentCommand,
    cwd: process.cwd(),
    permissionMode: "approve-reads",
    ...(sessionOptions ? { sessionOptions } : {}),
  } as ConstructorParameters<typeof AcpClient>[0]);
}

function stubConnection(client: AcpClient, captured: CapturedConnection): void {
  (client as unknown as { connection: unknown }).connection = {
    newSession: async (params: { _meta?: Record<string, unknown> }) => {
      captured.newSessionMeta = params._meta;
      return { sessionId: "session-stub" };
    },
    resumeSession: async (params: { _meta?: Record<string, unknown> }) => {
      captured.resumeMeta = "_meta" in params ? (params._meta ?? "absent") : "absent";
      return { sessionId: "session-stub" };
    },
  };
}

function systemPromptAppend(meta: Record<string, unknown> | undefined): string | undefined {
  const systemPrompt = meta?.systemPrompt as { append?: string } | undefined;
  return systemPrompt?.append;
}

test("createSession (claude): primer rides _meta.systemPrompt {append}", async () => {
  await withPrimerScript("printf 'PRIMER-CLAUDE\\n'", async () => {
    const captured: CapturedConnection = {};
    const client = makeClient(SDK_CLAUDE_COMMAND);
    stubConnection(client, captured);
    await client.createSession("/tmp/acpx-primer-claude");
    assert.match(systemPromptAppend(captured.newSessionMeta) ?? "", /PRIMER-CLAUDE/);
  });
});

test("createSession (claude-pty): primer rides _meta.systemPrompt {append}", async () => {
  await withPrimerScript("printf 'PRIMER-PTY\\n'", async () => {
    const captured: CapturedConnection = {};
    const client = makeClient(CLAUDE_PTY_COMMAND);
    stubConnection(client, captured);
    await client.createSession("/tmp/acpx-primer-pty");
    assert.match(systemPromptAppend(captured.newSessionMeta) ?? "", /PRIMER-PTY/);
  });
});

test("createSession (claude): human --append-system-prompt is composed primer-first, human-last", async () => {
  await withPrimerScript("printf 'PRIMER-X\\n'", async () => {
    const captured: CapturedConnection = {};
    const client = makeClient(SDK_CLAUDE_COMMAND, { systemPrompt: { append: "HUMAN-Y" } });
    stubConnection(client, captured);
    await client.createSession("/tmp/acpx-primer-compose");
    const append = systemPromptAppend(captured.newSessionMeta) ?? "";
    assert.ok(
      append.indexOf("PRIMER-X") < append.indexOf("HUMAN-Y"),
      "primer must precede human append",
    );
    // Primer (with its natural trailing newline) then the "---" rule, then the
    // human append last.
    assert.ok(
      append.includes("\n\n---\n\nHUMAN-Y"),
      `expected separator before human append, got: ${append}`,
    );
  });
});

test("createSession (codex): primer rides _meta.codex.developerInstructions, NOT systemPrompt", async () => {
  await withPrimerScript("printf 'PRIMER-CODEX\\n'", async () => {
    const captured: CapturedConnection = {};
    const client = makeClient(CODEX_COMMAND);
    stubConnection(client, captured);
    await client.createSession("/tmp/acpx-primer-codex");
    const codex = captured.newSessionMeta?.codex as { developerInstructions?: string } | undefined;
    assert.match(codex?.developerInstructions ?? "", /PRIMER-CODEX/);
    assert.equal(captured.newSessionMeta?.systemPrompt, undefined);
  });
});

test("createSession (unknown agent): no primer fragment", async () => {
  await withPrimerScript("printf 'PRIMER-NONE\\n'", async () => {
    const captured: CapturedConnection = {};
    const client = makeClient(UNKNOWN_COMMAND);
    stubConnection(client, captured);
    await client.createSession("/tmp/acpx-primer-none");
    assert.equal(systemPromptAppend(captured.newSessionMeta), undefined);
    assert.equal(captured.newSessionMeta?.codex, undefined);
  });
});

test("createSession: fail-open — session still builds when the primer is missing", async () => {
  await withPrimerCommand("/nonexistent/acpx-test-primer.sh", async () => {
    const captured: CapturedConnection = {};
    const client = makeClient(SDK_CLAUDE_COMMAND);
    stubConnection(client, captured);
    const result = await client.createSession("/tmp/acpx-primer-failopen");
    assert.equal(result.sessionId, "session-stub");
    assert.equal(systemPromptAppend(captured.newSessionMeta), undefined);
  });
});

test("resumeSession (claude): re-supplies the primer systemPrompt on cold resume", async () => {
  await withPrimerScript("printf 'PRIMER-RESUME\\n'", async () => {
    const captured: CapturedConnection = {};
    const client = makeClient(SDK_CLAUDE_COMMAND);
    stubConnection(client, captured);
    await client.resumeSession("session-stub", "/tmp/acpx-primer-resume");
    assert.notEqual(captured.resumeMeta, "absent");
    assert.match(
      systemPromptAppend(captured.resumeMeta as Record<string, unknown>) ?? "",
      /PRIMER-RESUME/,
    );
  });
});

test("resumeSession (codex): attaches NO _meta (developer item restored from thread)", async () => {
  await withPrimerScript("printf 'PRIMER-RESUME-CODEX\\n'", async () => {
    const captured: CapturedConnection = {};
    const client = makeClient(CODEX_COMMAND);
    stubConnection(client, captured);
    await client.resumeSession("session-stub", "/tmp/acpx-primer-resume-codex");
    assert.equal(captured.resumeMeta, "absent");
  });
});
