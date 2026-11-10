/**
 * Bash's `FUNCNEST` cap on shell-function nesting, exported into every agent's environment.
 *
 * Brick://6e5b34a8 (RCA brick://21d4a83d §1d): an agent ran a shell function named `tr` whose body
 * piped into `tr` — it called itself, forked 450+ shells and OOM-killed the whole devbox control
 * pod. bash reads `FUNCNEST` from the environment and aborts a function chain at that depth with
 * "maximum function nesting level exceeded", so one variable in the env every agent shell inherits
 * (the Claude Code Bash tool, Codex, Pi, `workbench-exec`, which forwards the env) stops the shape.
 *
 * ⚠️ NARROW ON PURPOSE: this stops FUNCTION recursion only. `&` fork bombs and plain loops are not
 * covered (a separate runaway-tree governor owns those).
 *
 * ⚠️ A DEFAULT, NEVER AN OVERWRITE: an operator who set `FUNCNEST` (any value, `0` = no limit
 * included) keeps it. `test/shell-recursion-limit.test.ts` pins both directions.
 */
export const AGENT_FUNCNEST_ENV = "FUNCNEST";

export const AGENT_FUNCNEST_LIMIT = "64";

export function applyFuncnestLimit(env: NodeJS.ProcessEnv): void {
  env[AGENT_FUNCNEST_ENV] ??= AGENT_FUNCNEST_LIMIT;
}
