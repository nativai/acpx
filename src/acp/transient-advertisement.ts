/**
 * Read what an adapter ADVERTISES for a new session — its `config_options` —
 * by opening a transient ACP session and closing it again.
 *
 * ONE implementation, three callers: `listAgentOutputStyles` (acpx-ui's create
 * dialog, brick://874fee67 §4.2 #40), the Claude model-advertisement probe
 * (`src/models/claude-advertisement.ts`, brick ebfe4c3c) and `acpx <agent>
 * model-catalogue` (the adapter's `models` advertisement, brick 574b137e — it
 * replaced acpx-ui creating, statusing and pruning a throwaway Codex session).
 * Factored out so every caller reuses the measured path.
 *
 * What the path costs, MEASURED 2026-10-02 on the deployed claude-agent-acp
 * (CONTRACT §4.1): only `initialize` + `session/new` cross the wire — **no prompt
 * is ever sent, so no tokens** — and **no acpx session record is written**. The
 * adapter's Claude Code child writes only the files every spawn writes into its
 * config dir (`.claude.json`, a backup, a `sessions/<pid>.key`). ~1.4–1.6 s
 * direct, ~2.7 s through acpx end to end.
 *
 * ⚠️ THE CLAUDE CODE CHILD OUTLIVES `client.close()` by ~140 ms (it rewrote
 * `.claude.json` after the caller had already removed the HOME). Harmless in
 * production; a test that deletes a temp HOME right after a REAL probe must retry
 * the delete — or, better, use the `ACPX_TEST_CLAUDE_ADVERT_JSON` seam.
 */

import path from "node:path";
import { withTimeout } from "../async-control.js";
import type { AcpClientOptions } from "../types.js";
import { AcpClient, type SessionCreateResult } from "./client.js";

export type TransientAdvertisementOptions = Pick<
  AcpClientOptions,
  | "agentCommand"
  | "cwd"
  | "mcpServers"
  | "authCredentials"
  | "authPolicy"
  | "verbose"
  | "sessionContext"
> & { timeoutMs?: number };

/** Open, read the advertisement off `session/new`, close. Never prompts; writes no record. */
export async function readTransientAdvertisement(
  options: TransientAdvertisementOptions,
): Promise<Pick<SessionCreateResult, "configOptions" | "models">> {
  const cwd = path.resolve(options.cwd);
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd,
    mcpServers: options.mcpServers,
    // Read-only probe: no prompt is ever sent, so the most restrictive policy is
    // correct — nothing can ask for a permission on this session.
    permissionMode: "deny-all",
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    verbose: options.verbose,
    sessionContext: options.sessionContext,
  });
  try {
    await withTimeout(client.start(), options.timeoutMs);
    const created = await withTimeout(client.createSession(cwd), options.timeoutMs);
    return { configOptions: created.configOptions, models: created.models };
  } finally {
    await client.close().catch(() => {
      // Enumeration is read-only; a close failure must not mask the answer.
    });
  }
}
