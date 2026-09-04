/**
 * The thinking-depth descriptor, derived ONCE here (C4 §7.2 rule 1).
 *
 * Three harnesses would otherwise each re-derive it from OpenRouter's raw
 * `reasoning` object and disagree — which is precisely what Daniel's
 * "ACPX is the basis" ruling forbids. Nothing outside this module reads a raw
 * `reasoning` shape.
 */

import { CANONICAL_DEPTH_LEVELS } from "./types.js";
import type { CanonicalDepthLevel, DepthDescriptor } from "./types.js";

/** Rank of every canonical token. Total over all eight — a harness ladder sorts through this too. */
const DEPTH_RANK: Record<string, number> = Object.fromEntries(
  CANONICAL_DEPTH_LEVELS.map((level, index) => [level, index]),
);

export function isCanonicalDepthLevel(value: string): value is CanonicalDepthLevel {
  return Object.hasOwn(DEPTH_RANK, value);
}

export function depthRank(level: CanonicalDepthLevel): number {
  return DEPTH_RANK[level] ?? -1;
}

/**
 * Sort into canonical order and drop duplicates. Unknown tokens are dropped:
 * a rung the vocabulary cannot order cannot be placed in a segmented control,
 * and silently appending it at one end would misrepresent the model.
 */
export function toCanonicalLadder(levels: readonly string[]): CanonicalDepthLevel[] {
  const seen = new Set<CanonicalDepthLevel>();
  for (const raw of levels) {
    const normalized = raw.trim().toLowerCase();
    if (isCanonicalDepthLevel(normalized)) {
      seen.add(normalized);
    }
  }
  return [...seen].toSorted((a, b) => depthRank(a) - depthRank(b));
}

/** The `reasoning` object exactly as OpenRouter reports it. Read only in this module. */
export type OpenRouterReasoning = {
  mandatory?: boolean;
  default_effort?: string;
  supported_efforts?: string[];
  default_enabled?: boolean;
  supports_max_tokens?: boolean;
};

/**
 * C4 §7.2 rule 1 / C5 §8.1 note 1, verbatim:
 *   `supported_efforts` non-empty     → ladder
 *   a `reasoning` object with no ladder → boolean
 *   no `reasoning`                     → none
 */
export function deriveDepthDescriptor(reasoning: OpenRouterReasoning | undefined): DepthDescriptor {
  if (!reasoning) {
    return { kind: "none" };
  }

  const levels = toCanonicalLadder(reasoning.supported_efforts ?? []);
  if (levels.length === 0) {
    return {
      kind: "boolean",
      defaultEnabled: reasoning.default_enabled === true,
      mandatory: reasoning.mandatory === true,
    };
  }

  const rawDefault = reasoning.default_effort?.trim().toLowerCase();
  const defaultLevel =
    rawDefault !== undefined && isCanonicalDepthLevel(rawDefault) && levels.includes(rawDefault)
      ? rawDefault
      : null;

  return {
    kind: "ladder",
    levels,
    default: defaultLevel,
    mandatory: reasoning.mandatory === true,
  };
}

/** One-line human summary of a descriptor — used by `acpx models` rows. */
export function describeDepth(depth: DepthDescriptor): string {
  if (depth.kind === "ladder") {
    return `${depth.levels.length} depths`;
  }
  if (depth.kind === "boolean") {
    return depth.defaultEnabled ? "on/off (on)" : "on/off (off)";
  }
  return "no reasoning";
}
