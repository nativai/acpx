import fs from "node:fs";

/**
 * Where a dev box's bootstrap writes its runtime record (`info.json`: the deployed
 * sha of every bootstrapped tool), newest location first.
 *
 * Since brick 04063316 the runtime lives on the control pod's home disk at
 * `/data/runtime`, off the NFS `/workspace`. Boxes not yet migrated keep it at
 * `/workspace/.runtime`; that entry stays until every box has moved, so a build
 * promoted to `main` reads the right record on both layouts.
 */
export const BOX_RUNTIME_INFO_PATHS = [
  "/data/runtime/info.json",
  "/workspace/.runtime/info.json",
] as const;

/**
 * The first candidate that exists; the newest location when none does (off-box, or
 * a pod without the runtime), so a reader reports "absent" against the current path.
 */
export function defaultBoxRuntimeInfoPath(
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  return BOX_RUNTIME_INFO_PATHS.find((candidate) => exists(candidate)) ?? BOX_RUNTIME_INFO_PATHS[0];
}
