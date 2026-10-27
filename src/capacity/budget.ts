import fs from "node:fs";
import path from "node:path";
import { type CapacityConstants, MIB } from "./constants.js";

/**
 * The box's effective memory budget `B` (CONCEPTION f7587c86 §3.1–§3.3, AMENDMENT 2026-10-27).
 *
 * Sources: the Downward-API VOLUME `/etc/podinfo` (`memory_request`, `memory_limit` in bytes,
 * `annotations`) and the cgroup's `memory.max`. A file, never env: env does not follow an
 * in-place resize and never reaches ssh-launched processes (F10, F11).
 */

export const BASIS_ANNOTATION = "nativai.de/agent-capacity-basis";
export const BUDGET_OVERRIDE_ANNOTATION = "nativai.de/agent-capacity-budget-mib";

export type Basis = "request" | "limit" | "override" | "limit-fallback" | "none";

export type PodInfo =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly memoryRequest?: string;
      readonly memoryLimit?: string;
      readonly annotations?: string;
    };

/** Absent directory ⇒ `present: false` (workbench pod, Mac, a box before the manifest change). */
export function readPodInfo(dir: string): PodInfo {
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return { present: false };
    }
  } catch {
    return { present: false };
  }
  const read = (name: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    present: true,
    memoryRequest: read("memory_request"),
    memoryLimit: read("memory_limit"),
    annotations: read("annotations"),
  };
}

/**
 * The whole-annotations projection: one `key="escaped-value"` per line (kubernetes.io Downward
 * API). A missing key is simply an absent line.
 */
export function parseAnnotations(raw: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of (raw ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const quoted = line.slice(eq + 1).trim();
    if (!(quoted.startsWith('"') && quoted.endsWith('"') && quoted.length >= 2)) {
      result.set(key, quoted);
      continue;
    }
    try {
      result.set(key, String(JSON.parse(quoted)));
    } catch {
      // Go's %q can emit escapes JSON does not know (`\x..`); the raw inner text is good enough
      // for the two keys read here, which are a word and a number.
      result.set(key, quoted.slice(1, -1));
    }
  }
  return result;
}

/** A non-negative integer byte count, or undefined. `"0"` parses (and is then out of bounds). */
export function parseByteCount(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export type BudgetResolution = {
  /** False when there is no `/etc/podinfo`: the box is UNCONFIGURED and nothing is ever refused. */
  readonly configured: boolean;
  readonly basis: Basis;
  /** `B`; on an unconfigured box the limit (for display only), undefined when no limit is known. */
  readonly budgetBytes: number | undefined;
  readonly requestBytes: number | undefined;
  readonly limitBytes: number | undefined;
  readonly warnings: readonly string[];
};

export type BudgetInputs = {
  readonly podinfo: PodInfo;
  /** `memory.max` as the kernel enforces it; undefined when unreadable or `max` (no limit). */
  readonly cgroupLimitBytes: number | undefined;
  readonly constants: CapacityConstants;
};

export function marginFor(budget: number, constants: CapacityConstants): number {
  return Math.max(constants.marginFloorBytes, Math.floor(constants.marginFraction * budget));
}

/**
 * Can this budget admit even ONE agent session on an otherwise empty box
 * (`B − M − Q − b_floor ≥ r_new`)? If not, a configured request/override would refuse every
 * start forever — what a missing or mistyped overlay annotation causes (§3.3, review finding 8).
 */
export function budgetAdmitsOne(budget: number, constants: CapacityConstants): boolean {
  return (
    budget -
      marginFor(budget, constants) -
      constants.interactiveReserveBytes -
      constants.baseFloorBytes >=
    constants.reserveNewBytes.claude
  );
}

/**
 * `L`: the cgroup is what the kernel enforces; the podinfo file only cross-checks it. The file's
 * `limits.memory` falls back to NODE allocatable when no limit is set (§9), so it is used only when
 * the cgroup has no limit at all.
 */
function resolveLimit(
  fileLimitRaw: string | undefined,
  cgroupLimit: number | undefined,
  warnings: string[],
): number | undefined {
  const fileLimit = parseByteCount(fileLimitRaw);
  if (cgroupLimit === undefined) {
    if (fileLimit !== undefined && fileLimit > 0) {
      warnings.push(
        `cgroup memory.max is unlimited or unreadable; using /etc/podinfo/memory_limit (${fileLimit} bytes)`,
      );
      return fileLimit;
    }
    return undefined;
  }
  if (fileLimit !== undefined && fileLimit !== cgroupLimit) {
    warnings.push(
      `/etc/podinfo/memory_limit (${fileLimit}) disagrees with cgroup memory.max (${cgroupLimit}); the cgroup wins`,
    );
  }
  return cgroupLimit;
}

type Selection =
  | { readonly basis: "request" | "limit" | "override"; readonly budget: number | undefined }
  | { readonly fallback: string };

type SelectionInputs = {
  readonly podinfo: Extract<PodInfo, { present: true }>;
  readonly limitBytes: number | undefined;
  readonly constants: CapacityConstants;
};

function inBounds(value: number | undefined, inputs: SelectionInputs): value is number {
  return (
    value !== undefined &&
    value >= inputs.constants.budgetMinBytes &&
    (inputs.limitBytes === undefined || value <= inputs.limitBytes)
  );
}

function selectOverride(raw: string, inputs: SelectionInputs): Selection {
  const mib = parseByteCount(raw);
  const bytes = mib === undefined ? undefined : mib * MIB;
  return inBounds(bytes, inputs)
    ? { basis: "override", budget: bytes }
    : { fallback: `${BUDGET_OVERRIDE_ANNOTATION}="${raw}" is not a MiB count in bounds` };
}

function selectRequest(inputs: SelectionInputs): Selection {
  const raw = inputs.podinfo.memoryRequest;
  const request = parseByteCount(raw);
  if (inBounds(request, inputs)) {
    return { basis: "request", budget: request };
  }
  return {
    fallback:
      raw === undefined
        ? "/etc/podinfo/memory_request is missing"
        : `/etc/podinfo/memory_request ("${raw.trim()}") is unparseable, zero or outside [256 MiB, limit]`,
  };
}

/** The annotations pick the basis; an absent or empty basis means `request`, the code default. */
function selectBudget(inputs: SelectionInputs): Selection {
  const annotations = parseAnnotations(inputs.podinfo.annotations);
  const value = (key: string): string => (annotations.get(key) ?? "").trim();
  const overrideRaw = value(BUDGET_OVERRIDE_ANNOTATION);
  const basisRaw = value(BASIS_ANNOTATION);
  if (overrideRaw !== "") {
    return selectOverride(overrideRaw, inputs);
  }
  if (basisRaw === "" || basisRaw === "request") {
    return selectRequest(inputs);
  }
  if (basisRaw === "limit") {
    return { basis: "limit", budget: inputs.limitBytes };
  }
  return { fallback: `${BASIS_ANNOTATION}="${basisRaw}" is neither request nor limit` };
}

/**
 * `R`, only if it passes the same bounds check as a budget ([256 MiB, L]). A request that fails it
 * — a wrong `divisor` above all (`1m` turns 2 GiB into 2,147,483,648,000) — is treated EXACTLY as an
 * absent request, everywhere: not reported, not the alternative basis, and above all not the `R` of
 * G3's "borrowing while B > R" test. Kept as R, an out-of-bounds "request" made the box look as if it
 * were not borrowing and switched the node guard off: 12 slots / rc 0 where the same box with no
 * request file read 2 slots / rc 75 (TE finding D1). Row: "budget D1: …".
 */
function validRequest(raw: string | undefined, inputs: SelectionInputs): number | undefined {
  const value = parseByteCount(raw);
  return inBounds(value, inputs) ? value : undefined;
}

/** Under the limit or override basis an invalid request is not fatal — but it is not silent either. */
function ignoredRequestWarning(raw: string | undefined, valid: number | undefined): string[] {
  const text = raw?.trim() ?? "";
  return text !== "" && valid === undefined
    ? [
        `/etc/podinfo/memory_request ("${text}") fails validation [256 MiB, limit]; treated as absent`,
      ]
    : [];
}

export function resolveBudget(inputs: BudgetInputs): BudgetResolution {
  const { podinfo, constants } = inputs;
  const warnings: string[] = [];
  if (!podinfo.present) {
    return {
      configured: false,
      basis: "none",
      budgetBytes: inputs.cgroupLimitBytes,
      requestBytes: undefined,
      limitBytes: inputs.cgroupLimitBytes,
      warnings,
    };
  }

  const limitBytes = resolveLimit(podinfo.memoryLimit, inputs.cgroupLimitBytes, warnings);
  const base = {
    configured: true,
    requestBytes: validRequest(podinfo.memoryRequest, { podinfo, limitBytes, constants }),
    limitBytes,
    warnings,
  } as const;
  const fallback = (why: string): BudgetResolution => {
    warnings.push(`falling back to the limit basis: ${why}`);
    return { ...base, basis: "limit-fallback", budgetBytes: limitBytes };
  };

  const selection = selectBudget({ podinfo, limitBytes, constants });
  if ("fallback" in selection) {
    return fallback(selection.fallback);
  }
  warnings.push(...ignoredRequestWarning(podinfo.memoryRequest, base.requestBytes));
  if (selection.budget === undefined) {
    // Only the limit basis lands here, and only with no readable limit: the caller reports
    // `unmeasured` (§3.3: cgroup unreadable on a configured box fails open).
    return { ...base, basis: selection.basis, budgetBytes: undefined };
  }
  const budget = Math.min(selection.budget, limitBytes ?? selection.budget);
  if (selection.basis !== "limit" && !budgetAdmitsOne(budget, constants)) {
    return fallback(
      `the ${selection.basis} budget (${Math.round(budget / MIB)} MiB) cannot admit one agent session on an empty box (request too small)`,
    );
  }
  return { ...base, basis: selection.basis, budgetBytes: budget };
}
