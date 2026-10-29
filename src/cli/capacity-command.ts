import { type Command, InvalidArgumentError } from "commander";
import { readPendingReservationsForProbe } from "../capacity/admission.js";
import { type Harness, HARNESSES, isHarness, MIB } from "../capacity/constants.js";
import {
  type CapacitySnapshot,
  capacitySourcesFromEnv,
  needMet,
  needMetReason,
  readCapacity,
} from "../capacity/reading.js";
import { EXIT_CODES, type OutputFormat } from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";

/**
 * `acpx capacity [--agent claude|codex|pi] [--need N]` — how many more agent sessions fit in THIS
 * box's control-pod memory (CONCEPTION f7587c86 §8.1). Read-only. It reads the admission ledger
 * the create gate writes, so creates in flight show as `pendingBytes` / `owners.starting`, and the
 * gate (`capacity/admission.ts`) admits exactly when `--need 1` here is met.
 *
 * Exit 0 on a successful reading (with `--need N`: at least N slots for `--agent`), 75 when
 * `--need N` is not met, 2 on usage, 1 on an internal error. An unconfigured or unmeasured box
 * exits 0 — fail open.
 */

type CapacityFlags = { agent?: Harness; need?: number };

function parseAgent(value: string): Harness {
  if (!isHarness(value)) {
    throw new InvalidArgumentError(`Expected one of: ${HARNESSES.join(", ")}`);
  }
  return value;
}

function parseNeed(value: string): number {
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    throw new InvalidArgumentError("Expected a positive integer");
  }
  return Number(value.trim());
}

const gib = (bytes: number): string => `${(bytes / (1024 * MIB)).toFixed(2)} GiB`;
const mib = (bytes: number): string => `${Math.round(bytes / MIB)} MiB`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function headLine(s: CapacitySnapshot): string {
  const head = [s.box];
  if (s.verdict === "unconfigured") {
    head.push("UNCONFIGURED (no /etc/podinfo) — nothing is refused");
  } else {
    head.push(
      s.budgetBytes === null ? `basis ${s.basis}` : `budget ${gib(s.budgetBytes)} (${s.basis})`,
    );
  }
  if (s.requestBytes !== null) {
    head.push(`request ${gib(s.requestBytes)}`);
  }
  if (s.limitBytes !== null) {
    head.push(`limit ${gib(s.limitBytes)}`);
  }
  return head.join(" · ");
}

function slotLine(s: CapacitySnapshot, free: number, interactive: number): string {
  const agent = s.agent;
  const label = s.verdict === "unconfigured" ? "would fit" : s.verdict;
  return (
    `${label}: ${plural(free, `new ${agent} session`)} (${mib(s.reserveNewBytes[agent])} reserved ` +
    `each; +${Math.max(0, interactive - free)} kept for humans; bound by ` +
    `${s.bindingGuard?.[agent] ?? "?"})`
  );
}

const yours = (s: CapacitySnapshot): string =>
  s.owners.trees.some((tree) => tree.self) ? " (one is yours)" : "";

function chargeLine(s: CapacitySnapshot, charged: number, base: number): string {
  const ownerCharge = s.owners.trees.reduce((sum, tree) => sum + tree.chargedBytes, 0);
  const workingSet = s.workingSetBytes === null ? "" : ` · working set ${gib(s.workingSetBytes)}`;
  const starting =
    s.owners.starting > 0 ? ` + ${s.owners.starting} starting ${gib(s.pendingBytes)}` : "";
  return (
    `charged ${gib(charged)} = base ${gib(base)} + ${plural(s.owners.live, "owner")}${yours(s)} ` +
    `${gib(ownerCharge)}${starting} · committed ${gib(s.committedBytes ?? 0)} (anon + kernel) · margin ` +
    `${gib(s.marginBytes ?? 0)}${workingSet}`
  );
}

function slotLines(s: CapacitySnapshot): string[] {
  if (!s.freeSlots || !s.freeSlotsInteractive || s.chargedBytes === null || s.baseBytes === null) {
    return [`${s.verdict}: no slot figure (see warnings) — nothing is refused`];
  }
  return [
    slotLine(s, s.freeSlots[s.agent], s.freeSlotsInteractive[s.agent]),
    chargeLine(s, s.chargedBytes, s.baseBytes),
  ];
}

function pressureLine(s: CapacitySnapshot): string {
  const p = s.pressure;
  const parts: Array<string | undefined> = [
    p.psiFullAvg10 === null ? "PSI unreadable" : `pressure PSI full ${p.psiFullAvg10.toFixed(2)}`,
    p.nodeAvailableBytes === null
      ? undefined
      : `node available ${gib(p.nodeAvailableBytes)} (shared)`,
    p.cpuPsiSomeAvg10 === null ? undefined : `cpu PSI some ${p.cpuPsiSomeAvg10.toFixed(2)}`,
    p.nodeLoad1 === null ? undefined : `node load1 ${p.nodeLoad1.toFixed(2)}`,
    p.oomKillsSinceContainerStart === null
      ? undefined
      : `oom kills since container start ${p.oomKillsSinceContainerStart}`,
  ];
  return parts.filter((part) => part !== undefined).join(" · ");
}

export function renderCapacityText(s: CapacitySnapshot): string {
  const lines = [
    headLine(s),
    ...slotLines(s),
    pressureLine(s),
    ...s.alternatives.map(
      (alt) =>
        `on the ${alt.basis} basis: budget ${gib(alt.budgetBytes)} → ` +
        plural(alt.freeSlots[s.agent], `new ${s.agent} session`),
    ),
    ...s.warnings.map((warning) => `⚠ ${warning}`),
  ];
  return `${lines.join("\n")}\n`;
}

function writeCapacity(
  format: OutputFormat,
  snapshot: CapacitySnapshot,
  need: number | undefined,
  met: boolean,
): void {
  if (
    emitJsonResult(
      format,
      need === undefined
        ? snapshot
        : { ...snapshot, need, needMet: met, needMetReason: needMetReason(snapshot, need) },
    )
  ) {
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${snapshot.slotsAfterMakeRoom?.[snapshot.agent] ?? snapshot.verdict}\n`);
    return;
  }
  process.stdout.write(renderCapacityText(snapshot));
  if (need !== undefined) {
    const verdict = met ? "met (exit 0)" : "NOT MET (exit 75)";
    process.stdout.write(
      `need ${plural(need, `${snapshot.agent} slot`)}: ${verdict} — ${needMetReason(snapshot, need)}\n`,
    );
  }
}

async function handleCapacity(
  flags: CapacityFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const snapshot = readCapacity({
    agent: flags.agent ?? "claude",
    sources: capacitySourcesFromEnv(),
    pending: await readPendingReservationsForProbe(),
  });
  const met = flags.need === undefined || needMet(snapshot, flags.need);
  writeCapacity(format, snapshot, flags.need, met);
  if (!met) {
    process.exitCode = EXIT_CODES.CAPACITY;
  }
}

/**
 * ⚠️ A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS: this one, and `"capacity"` in
 * `TOP_LEVEL_VERBS` (`src/cli-core.ts`). Without the second, `acpx capacity` is absorbed as an
 * AGENT NAME and, in a session-bearing cwd, the rest of the line becomes a prompt delivery.
 */
export function registerCapacityCommand(parent: Command, config: ResolvedAcpxConfig): void {
  parent
    .command("capacity")
    .description(
      "How many more agent sessions fit in this box's control-pod memory (read-only). " +
        "--need N exits 75 when fewer than N fit; an unconfigured box always exits 0.",
    )
    .option(
      "--agent <harness>",
      `Harness to size for: ${HARNESSES.join(", ")} (default claude)`,
      parseAgent,
    )
    .option("--need <n>", "Exit 75 unless at least n new sessions of --agent fit", parseNeed)
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    // Subcommands are registered BEFORE `program.exitOverride()` (cli-core `main`), so without
    // this commander exits a usage error with its own 1. Thrown, it reaches
    // `handleProgramParseError`, which maps it to USAGE ⇒ exit 2, as §8.1 and
    // docs/exit-codes.md promise. A script branching on 75 must be able to tell "no room"
    // from "I typed it wrong".
    .exitOverride((error) => {
      throw error;
    })
    .action(async function (this: Command, flags: CapacityFlags) {
      await handleCapacity(flags, this, config);
    });
}
