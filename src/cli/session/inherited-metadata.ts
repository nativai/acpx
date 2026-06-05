/**
 * Spawn-time `task_folder` inheritance — pure, no IO.
 *
 * When a child session is created with no explicit `task_folder` but a parent
 * that has one is resolvable, the parent's value is copied into the child's
 * metadata at create time. This is a snapshot at spawn: the child then owns the
 * value and may later re-point it itself (the self-apply / pull half). Explicit
 * child metadata always wins, and no path validation happens here — the
 * per-agent-folder derivation defends against a junk/non-absolute value.
 */
export function withInheritedTaskFolder(
  childMetadata: Record<string, string> | undefined,
  parentTaskFolder: string | null | undefined,
): Record<string, string> | undefined {
  const inherit = parentTaskFolder?.trim();
  if (!inherit) {
    return childMetadata;
  }
  if (childMetadata?.task_folder != null) {
    return childMetadata; // explicit child task_folder wins
  }
  return { ...childMetadata, task_folder: inherit };
}

/**
 * Spawn-time Claude `subscription` inheritance — pure, no IO. Mirrors
 * `withInheritedTaskFolder`: a child created with no explicit `--subscription`
 * inherits the parent's `session_options.subscription` (a snapshot at spawn —
 * the child owns it thereafter and fails over independently). Explicit child
 * selection always wins. Returns undefined when neither is set (no registry box
 * → byte-identical to today).
 */
export function withInheritedSubscription(
  childSubscription: string | undefined,
  parentSubscription: string | undefined,
): string | undefined {
  if (childSubscription?.trim()) {
    return childSubscription; // explicit child --subscription wins
  }
  return parentSubscription?.trim() || childSubscription;
}

/**
 * Spawn-time agent-type inheritance — pure, no IO. A bare/defaulted spawn (no
 * positional agent, no `--agent`) inside an acpx session resolves to the
 * parent's agent command instead of the machine default; an explicit child
 * agent always wins. With no resolvable parent (e.g. a top-level human shell)
 * the child keeps its own resolution → byte-identical to today. `effort`/`model`
 * inheritance is then gated on the resulting child===parent agent equality.
 */
export function withInheritedAgentCommand(
  childAgentCommand: string,
  agentWasExplicit: boolean,
  parentAgentCommand: string | undefined,
): string {
  if (agentWasExplicit) {
    return childAgentCommand; // explicit positional agent / --agent wins
  }
  return parentAgentCommand?.trim() || childAgentCommand;
}

/**
 * Spawn-time `model` inheritance — pure, no IO. Mirrors
 * `withInheritedSubscription`: a child with no explicit `--model` inherits the
 * parent's model; explicit child selection wins. The caller gates this on
 * same-agent-as-parent so a claude model never reaches a codex child (or
 * vice-versa). For codex this also carries the `[depth]` suffix for free.
 */
export function withInheritedModel(
  childModel: string | undefined,
  parentModel: string | undefined,
): string | undefined {
  if (childModel?.trim()) {
    return childModel; // explicit child --model wins
  }
  return parentModel?.trim() || childModel;
}

/**
 * Spawn-time Claude thinking-depth (`effort`) inheritance — pure, no IO. Mirrors
 * `withInheritedSubscription`: a child with no explicit `--reasoning-effort`
 * inherits the parent's persisted `desired_config_options.effort`; explicit
 * child selection wins. The caller gates this on same-agent-as-parent (effort is
 * claude-only and model-coupled). The value is an opaque advertised effort id.
 */
export function withInheritedReasoningEffort(
  childEffort: string | undefined,
  parentEffort: string | undefined,
): string | undefined {
  if (childEffort?.trim()) {
    return childEffort; // explicit child --reasoning-effort wins
  }
  return parentEffort?.trim() || childEffort;
}
