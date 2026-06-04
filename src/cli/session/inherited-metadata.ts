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
