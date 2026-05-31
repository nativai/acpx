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
