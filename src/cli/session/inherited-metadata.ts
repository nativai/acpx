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

export function applyBrickFlag(
  childMetadata: Record<string, string> | undefined,
  resolvedBrick: string | false | undefined,
): Record<string, string> | undefined {
  if (typeof resolvedBrick === "string") {
    return { ...childMetadata, brick: resolvedBrick };
  }
  return childMetadata;
}

function withoutBrickMetadata(
  childMetadata: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (childMetadata?.brick == null) {
    return childMetadata;
  }
  const { brick: _dropped, ...rest } = childMetadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Spawn-time `brick` inheritance — pure, no IO. Mirrors task_folder inheritance,
 * with an explicit `blocked` switch for --no-brick so callers can strip raw
 * metadata and suppress parent inheritance in one place.
 */
export function withInheritedBrick(
  childMetadata: Record<string, string> | undefined,
  parentBrick: string | null | undefined,
  blocked: boolean,
): Record<string, string> | undefined {
  if (blocked) {
    return withoutBrickMetadata(childMetadata);
  }
  const inherit = parentBrick?.trim();
  if (!inherit) {
    return childMetadata;
  }
  if (childMetadata?.brick != null) {
    return childMetadata; // explicit child brick wins, including an empty raw metadata value
  }
  return { ...childMetadata, brick: inherit };
}

/**
 * Spawn-time Claude `subscription` inheritance — pure, no IO. A child created
 * with no explicit `--subscription` inherits the parent's subscription only when
 * the caller passes a same-agent parent value. The caller gates this on
 * same-agent-as-parent so a Claude credential never reaches a Codex child (or
 * vice-versa). Explicit child selection always wins.
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
 * Spawn-time profile inheritance — pure, no IO. A child with no explicit
 * `--profile` inherits the parent's `session_options.profile` only when the
 * caller passes a same-agent parent value. The caller gates this on
 * same-agent-as-parent so provider/profile credentials stay agent-namespaced.
 * Explicit child selection always wins.
 */
export function withInheritedProfile(
  childProfile: string | undefined,
  parentProfile: string | undefined,
): string | undefined {
  if (childProfile?.trim()) {
    return childProfile; // explicit child --profile wins
  }
  return parentProfile?.trim() || childProfile;
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
 * credential inheritance: a child with no explicit `--model` inherits the
 * parent's model only when the caller passes a same-agent parent value; explicit
 * child selection wins. The caller gates this on same-agent-as-parent so a
 * claude model never reaches a codex child (or vice-versa). For codex this also
 * carries the `[depth]` suffix for free.
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
 * credential inheritance: a child with no explicit `--reasoning-effort` inherits
 * the parent's persisted `desired_config_options.effort` only when the caller
 * passes a same-agent parent value; explicit child selection wins. The caller
 * gates this on same-agent-as-parent (effort is claude-only and model-coupled).
 * The value is an opaque advertised effort id.
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
