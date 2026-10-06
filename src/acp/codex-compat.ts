import { commandCarriesAdapterToken } from "./adapter-token.js";

const CODEX_ACP_TOKEN = "codex-acp";

/**
 * brick://5a7cf1f0 — SEGMENT match, not substring. This answer gates Codex
 * admission and selects the primer channel, so a false positive both caps a
 * non-Codex session and blocks it outright whenever acpx-ui is unreachable. The
 * full rationale, the genuine spellings it must keep matching, and the one known
 * residual are in `adapter-token.ts`.
 */
export function isCodexAcpCommand(command: string, args: readonly string[]): boolean {
  return commandCarriesAdapterToken(command, args, CODEX_ACP_TOKEN);
}

export function isLegacyZedCodexAcpInvocation(agentCommand: string): boolean {
  return /@zed-industries\/codex-acp\b/u.test(agentCommand);
}
