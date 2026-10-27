import fs from "node:fs";
import path from "node:path";

/**
 * The control container's own memory, from its cgroup v2 files, and the NODE's headroom from
 * `/proc/meminfo` (CONCEPTION f7587c86 §3.1, §9).
 *
 * ⚠️ `memory.current` IS NOT THE BOX'S MEMORY: it includes page cache and reads ~100 % at idle.
 * Committed memory is `anon + kernel` from `memory.stat` — the figure DATA a6a2f2b3 §7's baselines
 * measure and the OOM flight recorder triggers on, so sizing, admission and forensics share one
 * number.
 */

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** `key value` lines → numbers. */
export function parseFlatKeyed(raw: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const [key, value] = line.trim().split(/\s+/u);
    if (key && value !== undefined && /^\d+$/.test(value)) {
      result.set(key, Number(value));
    }
  }
  return result;
}

export type CommittedReading = {
  readonly committedBytes: number;
  readonly anonBytes: number;
  readonly kernelBytes: number;
  readonly warnings: readonly string[];
};

/** Kernel components that `kernel` sums on kernels that report it (≥ 5.18 has the line). */
const KERNEL_COMPONENTS = [
  "kernel_stack",
  "pagetables",
  "sec_pagetables",
  "percpu",
  "vmalloc",
  "slab",
] as const;

/**
 * `C = anon + kernel`.
 *
 * ⚠️ DO NOT ADD `slab`. `kernel` ALREADY CONTAINS it (F7: on devbox `kernel` 478.4 MB ≈ slab +
 * kernel_stack + pagetables + percpu + vmalloc = 473.8 MB). The circulating `anon + slab + kernel`
 * double-counts slab — ~0.34 GiB on devbox, ~0.9 GiB on a slab-heavy reading. The case
 * "kernel ⊇ slab" in `test/capacity.test.ts` goes red if slab is added here.
 * Only on a kernel that has no `kernel` line are the components summed instead (slab once).
 */
export function committedFromMemoryStat(
  stat: ReadonlyMap<string, number>,
): CommittedReading | undefined {
  const anon = stat.get("anon");
  if (anon === undefined) {
    return undefined;
  }
  const warnings: string[] = [];
  let kernel = stat.get("kernel");
  if (kernel === undefined) {
    kernel = KERNEL_COMPONENTS.reduce((sum, key) => sum + (stat.get(key) ?? 0), 0);
    warnings.push("memory.stat has no `kernel` line; summed its components instead");
  }
  return { committedBytes: anon + kernel, anonBytes: anon, kernelBytes: kernel, warnings };
}

export type Psi = { readonly someAvg10?: number; readonly fullAvg10?: number };

export function parsePressure(raw: string | undefined): Psi {
  const out: { someAvg10?: number; fullAvg10?: number } = {};
  for (const line of (raw ?? "").split("\n")) {
    const match = /^(some|full)\s.*\bavg10=(\d+(?:\.\d+)?)/u.exec(line.trim());
    if (match) {
      out[match[1] === "some" ? "someAvg10" : "fullAvg10"] = Number(match[2]);
    }
  }
  return out;
}

export type CgroupReading = {
  /** undefined ⇒ `memory.stat` unreadable or without `anon`: the box is UNMEASURED. */
  readonly committed: CommittedReading | undefined;
  /** `memory.max`; undefined when unreadable or `max` (no limit). */
  readonly limitBytes: number | undefined;
  /** Working set `memory.current − inactive_file` — the kubelet's number; reported, never admits. */
  readonly workingSetBytes: number | undefined;
  readonly memoryPressure: Psi;
  readonly cpuPressure: Psi;
  /** `memory.events oom_kill` — resets on container restart, so display only (§9). */
  readonly oomKills: number | undefined;
};

/** A file holding one integer; undefined when unreadable or not a number (`max`). */
function readIntegerFile(file: string): number | undefined {
  const raw = readText(file)?.trim() ?? "";
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

function workingSet(current: number | undefined, stat: ReadonlyMap<string, number>) {
  return current === undefined
    ? undefined
    : Math.max(0, current - (stat.get("inactive_file") ?? 0));
}

export function readCgroup(root: string): CgroupReading {
  const stat = parseFlatKeyed(readText(path.join(root, "memory.stat")) ?? "");
  const events = parseFlatKeyed(readText(path.join(root, "memory.events")) ?? "");
  return {
    committed: committedFromMemoryStat(stat),
    limitBytes: readIntegerFile(path.join(root, "memory.max")),
    workingSetBytes: workingSet(readIntegerFile(path.join(root, "memory.current")), stat),
    memoryPressure: parsePressure(readText(path.join(root, "memory.pressure"))),
    cpuPressure: parsePressure(readText(path.join(root, "cpu.pressure"))),
    oomKills: events.get("oom_kill"),
  };
}

export type NodeReading = {
  /** `/proc/meminfo MemAvailable` — the NODE, shared with every other pod on it (F9). */
  readonly availableBytes: number | undefined;
  readonly load1: number | undefined;
};

export function readNode(procRoot: string): NodeReading {
  const meminfo = readText(path.join(procRoot, "meminfo")) ?? "";
  const kb = /^MemAvailable:\s+(\d+)\s+kB/mu.exec(meminfo)?.[1];
  const load = readText(path.join(procRoot, "loadavg"))?.trim().split(/\s+/u)[0];
  return {
    availableBytes: kb === undefined ? undefined : Number(kb) * 1024,
    load1: load !== undefined && /^\d+(?:\.\d+)?$/.test(load) ? Number(load) : undefined,
  };
}
