/**
 * brick://5a7cf1f0 — ADAPTER DETECTION MATCHES A PATH SEGMENT, NEVER A SUBSTRING.
 *
 * WHAT WENT WRONG. `isCodexAcpCommand` and `isClaudeAcpCommand` both ended in
 * `args.some((arg) => arg.includes("<token>"))`. A substring test does not care
 * WHERE the token appears, so any argument that merely mentions it classified the
 * whole session as that adapter — and the consequences are not cosmetic. The codex
 * answer gates admission (`runtime/engine/codex-subscription-cap.ts` HOLDS a turn
 * when acpx-ui's quota endpoint is unreachable) and selects the OS primer channel
 * (`resolvePrimerChannel`), so a misclassified session is both capped as Codex and
 * cannot take a turn at all while acpx-ui is down.
 *
 * MEASURED, not hypothetical (brick c028c10e, 2026-09-30): four `test/cli.test.ts`
 * BRICK tests whose agent is `node <mock-agent.js>` were classified as Codex
 * sessions purely because they passed `--operation-log …/codex-acp-ops.jsonl`. The
 * substring `codex-acp` occurred only inside the name of a log file. On a box whose
 * acpx-ui was unreachable those four rows failed — as a bare `waitFor` timeout that
 * named neither Codex nor the quota.
 *
 * ⚠️ WHY A SEGMENT AND NOT A BASENAME. Basename-only is too strict: the real
 * invocation on every dev box is `node /opt/codex-acp/dist/index.js`, where the
 * token is a DIRECTORY, and the basename is `index.js`. Every genuine spelling in
 * the repo puts the token in its own path segment or npm package-name position:
 *
 *   codex-acp                                   (bare command)
 *   node /opt/codex-acp/dist/index.js           (token is a directory segment)
 *   npx -y @agentclientprotocol/codex-acp       (scoped package name)
 *   npx -y @agentclientprotocol/codex-acp@^0.0.44
 *   npx @zed-industries/codex-acp@^0.12.0       (name + version suffix)
 *   <bin>/codex-acp.cmd                         (Windows shim)
 *
 * while the false positive — `codex-acp-ops.jsonl` — has NO segment equal to the
 * token: its segment is `codex-acp-ops.jsonl`. That is the whole discriminator.
 *
 * ⚠️ KNOWN RESIDUAL, DELIBERATELY NOT FIXED HERE. A flag VALUE that is a directory
 * path containing the token as a real segment still matches — e.g.
 * `--cwd /workspace/projects/codex-acp/main`. Separating a flag's value from a
 * positional argument needs per-flag knowledge of every adapter CLI, which this
 * layer does not have and should not acquire. It is named here rather than left to
 * be rediscovered.
 */

/**
 * True when `value` carries `token` as a complete path segment or npm package name
 * — not merely as a substring. `token` must already be lowercase.
 */
export function hasAdapterToken(value: string, token: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => normalizeSegment(segment) === token);
}

/** True when the command or any argument carries `token` as a segment. */
export function commandCarriesAdapterToken(
  command: string,
  args: readonly string[],
  token: string,
): boolean {
  return hasAdapterToken(command, token) || args.some((arg) => hasAdapterToken(arg, token));
}

function normalizeSegment(segment: string): string {
  return (
    segment
      .toLowerCase()
      // ⚠️ A DASH-PREFIXED SEGMENT EQUAL TO THE TOKEN IS A DELIBERATE DECLARATION,
      // AND STRIPPING THE DASHES IS REQUIRED, NOT A CONVENIENCE. The suite's
      // mock agent is adapter-agnostic, so a test that needs an adapter-classified
      // session declares one by passing a flag named after it —
      // `test/cli.test.ts:329`, `GUARD_CLAUDE_COMMAND = node <mock-agent.js>
      // --claude-agent-acp`, which `test/mock-agent.ts:579` consumes to behave like
      // the SDK adapter. That seam predates this change and worked only because the
      // match was a substring: measured here, dropping it reds 14 rows across the
      // claude model-pinning guard (`brick://5bac5564`) and `sessions copy
      // --at-index`. So the flag form stays supported ON PURPOSE.
      //
      // It does NOT reopen the bug: `--operation-log` normalizes to
      // `operation-log`, and the false positive `codex-acp-ops.jsonl` carries no
      // dash prefix and is still a single segment that differs from the token.
      .replace(/^-+/u, "")
      // An npm version suffix is not part of the package name: `codex-acp@^0.0.44`,
      // `codex-acp@latest`. Anchored to the LAST `@` so a scoped segment
      // (`@agentclientprotocol`) collapses to "" rather than being mistaken for a name.
      .replace(/@[^@]*$/u, "")
      // Windows shims: `codex-acp.cmd`.
      .replace(/\.(cmd|exe|bat)$/u, "")
  );
}
