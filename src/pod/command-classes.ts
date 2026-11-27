import { listBuiltInAgents } from "../agent-registry.js";
import { COMMAND_GRAMMAR, type GrammarNode } from "./command-grammar.js";

/**
 * C6.2's closed `inherit` list: what a passed-through create may inherit from its creator's
 * environment, by name. atrium validates every `inherit` name against THIS constant (`400
 * inherit-not-allowed` otherwise) and keeps no copy; A3's pass-through client sends only these.
 */
export const PASS_THROUGH_INHERIT: readonly string[] = Object.freeze([
  "ACPX_SUBSCRIPTION",
  "ATRIUM_OS",
]);

// C1.1's predicate travels with the table: atrium loads both from this one module (EXPORT-class-table.md).
export {
  podModeVerdict,
  podModeVerdictNow,
  type HostFacts,
  type PodModeVerdict,
} from "./placement.js";

/**
 * C1.2 — every command path acpx registers has exactly one class (CONTRACTS-r4 C1.2, CONCEPTION r4
 * K2, brick b479441f). The assignment is DATA, exported: the atrium server validates a passed-through
 * call (C6.2) against this same table, by loading this module (see the brick's
 * reports/EXPORT-class-table.md).
 *
 * ⚠️ LIGHT MODULE. It is evaluated before the rest of acpx, and atrium loads it in-process: its static
 * imports stay `./command-grammar.js` and node builtins. Held by `test/pod-command-classes.test.ts`
 * ("the light graph").
 *
 * ⚠️ ADDING A COMMAND: add its path HERE (class + reason) and in `command-grammar.ts`, in the same
 * commit. `test/pod-command-classes.test.ts` enumerates the real commander registration and fails on
 * a path with no class, a class outside the closed set, or an entry no command answers. In pod mode a
 * path missing here REFUSES (`acpx: REFUSED reason=unclassified_command`, exit 2) — it never runs.
 */

// TEST ARTIFACT, NEVER MERGE (row 95.2): atrium's loader accepts only contract 1
// (server/acpxCall/commandClasses.ts validateCommandClassesModule), so this build is refused there.
export const COMMAND_CLASSES_CONTRACT = 2 as const;

export const COMMAND_CLASSES = [
  "read",
  "record",
  "create",
  "control-store",
  "owner-ensure",
  "owner-if-pod",
  "one-shot",
  "local",
] as const;

export type CommandClass = (typeof COMMAND_CLASSES)[number];

/** Where the session a command is about is named. Absent = the command is about no one session. */
export type TargetSpec = {
  /** Value flags that name the session (`--session-id`, `--session-url`, `--seat`, …). */
  readonly flags: readonly string[];
  /** Index of the operand that names the session, when one does. */
  readonly operand?: number;
};

export type CommandEntry = {
  readonly class: CommandClass;
  readonly reason: string;
  /** Set where the assignment is a judgment call a reviewer should look at. */
  readonly judgment?: string;
  readonly target?: TargetSpec;
  /**
   * `one-shot` only: the flag whose presence makes this invocation answerable FROM RECORDS — C1.2's
   * "from records where possible" on the control pod — so it runs locally instead of needing the
   * utility pod.
   */
  readonly fromRecordsWhen?: string;
  /** `owner-if-pod` only: a setting — on a session without a pod it is a record write (C1.2). */
  readonly setting?: true;
  /**
   * Control-pod maintenance — refuses in an agent pod (`control_pod_only`, A-7). `{ unless }`: only
   * the invocations WITHOUT that flag are maintenance (`sessions archive --ids` archives named
   * sessions and is passed through — stream HoD ruling Q, 2026-11-21).
   */
  readonly controlPodOnly?: true | { readonly unless: string };
  /**
   * The command only READS, or sets a value to what it already says, so running it AGAIN is harmless — the
   * advice after `CALL_HOME outcome=unknown` says so instead of "may apply twice" (brick 20d6bce2 F-13).
   * Only where that is true by construction; every other command keeps the "check first" advice.
   */
  readonly repeatSafe?: true;
};

const SELECT = ["--session-id", "--session-url", "-s", "--session"] as const;
const SELECT_SEAT = [...SELECT, "--seat"] as const;
const BY_FLAGS: TargetSpec = { flags: SELECT };
const BY_FLAGS_OR_SEAT: TargetSpec = { flags: SELECT_SEAT };
const BY_OPERAND: TargetSpec = { flags: SELECT, operand: 0 };
/** A verb that names its session by operand AND registers `--seat` (`sessions close`, brick 7686016f). */
const BY_OPERAND_OR_SEAT: TargetSpec = { flags: SELECT_SEAT, operand: 0 };

/**
 * `""` is the bare program (`acpx [prompt...]`) and `"<agent>"` the per-agent prompt
 * (`acpx claude …`); every other key is a command path. Paths beneath an agent
 * (`acpx claude sessions new`) have the class of the same path without the agent.
 */
export const COMMAND_TABLE: Readonly<Record<string, CommandEntry>> = {
  "": { class: "owner-ensure", reason: "bare `acpx <text>` is a prompt", target: BY_FLAGS },
  "<agent>": {
    class: "owner-ensure",
    reason: "`acpx <agent> <text>` is a prompt",
    target: BY_FLAGS,
  },
  prompt: {
    class: "owner-ensure",
    reason: "the one verb that may start a pod (C1.2)",
    target: BY_FLAGS_OR_SEAT,
  },
  exec: { class: "one-shot", reason: "a bridge without a session (C1.2 example)" },
  cancel: {
    class: "owner-if-pod",
    reason: "reaches the live owner; never starts one",
    target: BY_FLAGS_OR_SEAT,
  },
  "set-mode": {
    class: "owner-if-pod",
    reason: "a setting that must reach the bridge",
    target: BY_FLAGS,
    setting: true,
  },
  set: {
    class: "owner-if-pod",
    reason: "a setting that must reach the bridge",
    target: BY_FLAGS,
    setting: true,
  },
  "output-styles": {
    class: "one-shot",
    reason: "opens a transient session to read the adapter's list",
    fromRecordsWhen: "--session-id",
    judgment:
      "with --session-id it reads the session's own advertised list — taken as the C1.2 " +
      "'from records' form; whether that read is file-only today is for A3/probe work to confirm",
  },
  "model-catalogue": {
    class: "one-shot",
    reason: "opens a transient session to read the catalogue",
  },
  status: {
    class: "owner-if-pod",
    reason: "status of the live owner (C1.2 example)",
    target: BY_FLAGS_OR_SEAT,
  },
  sessions: {
    class: "one-shot",
    reason:
      "`sessions` = `sessions list`, which without --local asks the AGENT (spawns an adapter)",
    fromRecordsWhen: "--local",
    judgment:
      "a list reads as `read`, but without --local it spawns the adapter for ACP session/list; " +
      "classed one-shot with --local as its from-records form",
  },
  "sessions list": {
    class: "one-shot",
    reason: "without --local asks the agent (spawns an adapter); --local reads records",
    fromRecordsWhen: "--local",
    judgment: "as `sessions`",
  },
  "sessions templates": { class: "read", reason: "lists template records" },
  "sessions templates rollback": {
    class: "control-store",
    reason: "retracts or deletes template records and their index entries",
  },
  "sessions templates migrate-slugs": {
    class: "control-store",
    reason: "bulk rewrite of template records and the index",
  },
  "sessions reindex": { class: "control-store", reason: "rewrites index.json" },
  "sessions repair-account-seam": {
    class: "control-store",
    reason: "bulk maintenance rewrite of records",
    judgment: "maintenance, but it rewrites shared records, so control-store rather than local",
  },
  "sessions archive": {
    class: "control-store",
    reason: "the archive (C1.2 control-store list)",
    controlPodOnly: { unless: "--ids" },
    judgment:
      "ruling Q: archiving named sessions (`--ids`) is passed through from a pod; every other form " +
      "(retention sweep, --compress, --decompress --all, --status/--verify/--repair/--reindex, " +
      "--thaw, --cat) is maintenance — control_pod_only in an agent pod",
  },
  "sessions unparsable-leases": {
    class: "control-store",
    reason: "maintenance on the box's shared lease store (A-71's one-time removal)",
    controlPodOnly: true,
    judgment:
      "it removes lease files of every session on the box and reads the CONTROL pod's start: " +
      "control_pod_only in an agent pod; on a workbench or any other host it removes nothing",
  },
  "sessions restore": { class: "control-store", reason: "the archive" },
  "sessions template": {
    class: "control-store",
    reason:
      "marking assigns the slug's next VERSION from every entry of the box's index, under the index lock — a box-wide read-modify-write",
    judgment:
      "it names one session's record, but it was `record` and, on the pod's OWN id, ran locally and " +
      "tripped `pod_foreign_write file=index` (brick 3fda4443); passed through for any id",
  },
  "sessions new": { class: "create", reason: "a create (C1.3)" },
  "sessions close": {
    class: "owner-if-pod",
    reason: "close reaches the live owner if any (C1.2 example)",
    target: BY_OPERAND_OR_SEAT,
  },
  "sessions copy": { class: "create", reason: "copy / fork is a create (C1.3)" },
  "sessions reopen": {
    class: "record",
    reason: "clears the closed mark on one record; starts nothing",
    target: BY_OPERAND,
  },
  "sessions recover": {
    class: "owner-if-pod",
    reason: "recover (C1.2 example)",
    target: BY_OPERAND,
  },
  "sessions owner-status": {
    class: "owner-if-pod",
    reason: "the owner's state; a pid in another pod is not checkable locally (C3.3)",
    target: BY_OPERAND,
    judgment: "reads lease + pid today (read-like), but only the pod can answer liveness",
  },
  "sessions show": { class: "read", reason: "one record, read-only" },
  "sessions set-metadata": { class: "record", reason: "one record", target: BY_FLAGS },
  "sessions set-os": { class: "record", reason: "one record", target: BY_OPERAND },
  "sessions set-parent": {
    class: "record",
    reason: "the parent field of a record",
    // `--children-of <parent>` SELECTS its target (brick c2b7358d, T3): it rewrites every CHILD of the parent —
    // other sessions' records — so atrium must resolve it (else `400 target-unresolved`, and the call could not
    // run from a pod at all), and from a pod it is never "own": `own-target.ts` answers not-own for it, so it
    // always passes through to the control pod, even when the parent is the pod's own session.
    target: { flags: [...SELECT, "--children-of"] },
    judgment:
      "--children-of rewrites every child of a parent (several records): record-class, and the flag " +
      "names its target so the pass-through can resolve it; never local in a pod (it writes other sessions' records)",
  },
  "sessions activate": {
    class: "control-store",
    reason: "the succession write on the seat store",
  },
  "sessions handover": { class: "create", reason: "successor create (C1.3)" },
  "sessions history": { class: "read", reason: "reads a stream" },
  "sessions read": { class: "read", reason: "reads a stream" },
  "sessions export": { class: "read", reason: "reads a session into a file the caller names" },
  "sessions import": {
    class: "create",
    reason: "imports an archive as a new record",
    judgment: "a create form C1.3's table does not list",
  },
  "sessions prune": {
    class: "control-store",
    reason: "deletes records and index entries",
    controlPodOnly: true,
    judgment: "ruling Q: prune is an archive maintenance job — control_pod_only in an agent pod",
  },
  seats: { class: "local", reason: "group: help only" },
  "seats reconcile-archive": { class: "control-store", reason: "the seat store" },
  "seats set-brick": { class: "control-store", reason: "the seat store" },
  "seats rename": { class: "control-store", reason: "the seat store" },
  "seats favorite": { class: "control-store", reason: "the seat store" },
  "seats delete": { class: "control-store", reason: "the seat store" },
  "seats backfill": { class: "control-store", reason: "the seat store and records" },
  "seats close": { class: "control-store", reason: "the seat store" },
  "seats reopen": { class: "control-store", reason: "the seat store" },
  "seats show": { class: "read", reason: "reads the seat store" },
  "seats list": { class: "read", reason: "reads the seat store" },
  context: {
    class: "control-store",
    reason: "`--alarm` writes the seat row (C1.2 control-store example)",
    judgment:
      "one class per path: the plain read (no --alarm) is passed through from an agent pod too",
  },
  "agent-folders": { class: "local", reason: "group: help only" },
  "agent-folders migrate": {
    class: "control-store",
    reason: "moves agent folders box-wide",
  },
  transcripts: { class: "local", reason: "group: help only" },
  "transcripts dedup": {
    class: "control-store",
    reason: "rewrites transcript copies across subscriptions",
  },
  "transcripts restore": {
    class: "control-store",
    reason: "rewrites a transcript copy",
  },
  subscriptions: { class: "read", reason: "lists the registry" },
  "subscriptions list": { class: "read", reason: "reads the registry" },
  "subscriptions usage": {
    class: "read",
    reason: "reads usage (HTTP probe, no bridge)",
    judgment: "probes the vendor's usage endpoint and may refresh a cache — caches are any-writer",
  },
  "subscriptions ceiling": { class: "local", reason: "group: help only" },
  "subscriptions ceiling show": { class: "read", reason: "reads ceilings" },
  "subscriptions ceiling set": { class: "control-store", reason: "subscription registry" },
  "subscriptions ceiling set-default": {
    class: "control-store",
    reason: "subscription registry",
  },
  "subscriptions ceiling clear": { class: "control-store", reason: "subscription registry" },
  "subscriptions ceiling clear-default": {
    class: "control-store",
    reason: "subscription registry",
  },
  "subscriptions lock": { class: "control-store", reason: "subscription registry" },
  "subscriptions unlock": { class: "control-store", reason: "subscription registry" },
  "subscriptions remove": { class: "control-store", reason: "subscription registry" },
  profiles: { class: "read", reason: "lists profiles" },
  "profiles list": { class: "read", reason: "lists profiles" },
  "profiles show": { class: "read", reason: "shows a profile" },
  agents: { class: "read", reason: "harness capability descriptors" },
  "agents list": { class: "read", reason: "harness capability descriptors" },
  "agents show": { class: "read", reason: "harness capability descriptor" },
  models: { class: "read", reason: "the model catalogue" },
  "models list": { class: "read", reason: "the model catalogue" },
  "models show": { class: "read", reason: "the model catalogue" },
  "models endpoints": { class: "read", reason: "OpenRouter endpoints (HTTP, cache)" },
  "models fav": {
    class: "control-store",
    reason: "reads model preferences — a SQLite database, opened on the control pod only (A7)",
    repeatSafe: true,
  },
  "models fav add": {
    class: "control-store",
    reason: "model preferences (C1.2 list)",
    repeatSafe: true,
  },
  "models fav rm": { class: "control-store", reason: "model preferences", repeatSafe: true },
  "models last-used": {
    class: "control-store",
    reason: "reads model preferences — a SQLite database, opened on the control pod only (A7)",
    repeatSafe: true,
  },
  "models last-used set": {
    class: "control-store",
    reason: "model preferences",
    repeatSafe: true,
  },
  providers: { class: "local", reason: "group: help only" },
  "providers list": { class: "read", reason: "reads providers.json" },
  capacity: { class: "control-store", reason: "capacity (C1.2 control-store list)" },
  "capacity admit-wake": { class: "control-store", reason: "the admission ledger" },
  "capacity run-build": {
    class: "local",
    reason: "control-pod maintenance — release builds (K2 `local`)",
    controlPodOnly: true,
  },
  people: { class: "local", reason: "group: help only" },
  "people list": { class: "read", reason: "reads people.json" },
  "people resolve": { class: "read", reason: "reads people.json" },
  "people set-owner": {
    class: "record",
    reason: "the principal fields of one record",
    // `--session` is a REQUIRED option there (commander refuses without it): no caller default (F4).
    target: { flags: ["--session"] },
  },
  "people principal": { class: "read", reason: "reads a record" },
  governor: { class: "local", reason: "group: help only" },
  "governor status": {
    class: "local",
    reason: "control-pod maintenance (K2 `local`)",
    controlPodOnly: true,
  },
  "governor scan": {
    class: "local",
    reason: "control-pod maintenance (K2 `local`)",
    controlPodOnly: true,
  },
  box: { class: "local", reason: "group: help only" },
  "box refresh": {
    class: "control-store",
    reason: "A-17: starts the box release on the control pod; an agent pod passes it through",
  },
  config: { class: "read", reason: "`config` = show" },
  "config show": { class: "read", reason: "reads config files" },
  "config init": { class: "control-store", reason: "writes the box's config file" },
  flow: { class: "local", reason: "group: help only" },
  "flow run": { class: "one-shot", reason: "runs ACP nodes without a session (C1.2 example)" },
  // commander's IMPLICIT help command, which exists only on a command that has subcommands and no
  // action of its own (`acpx seats help`). ⚠️ NOT `acpx help …` nor `acpx <agent> help …`: the
  // program and every agent have an action, so there `help` is PROMPT TEXT (F1).
  help: { class: "local", reason: "commander's implicit help command of a group" },
};

/** Entry points handled before commander, by `src/cli.ts` / `src/cli-core.ts`. All `local`. */
export const PRE_COMMANDER_PATHS: Readonly<Record<string, CommandEntry>> = {
  "--version": { class: "local", reason: "version" },
  "__queue-owner": { class: "local", reason: "the owner entry (A4 guards it)" },
  "__spawn-ledger-module": { class: "local", reason: "module-path probe for atrium" },
  "__command-classes-module": { class: "local", reason: "module-path probe for atrium" },
  "--skill": { class: "local", reason: "skill text" },
};

export type TargetSelector =
  | { via: "flag"; flag: string; value: string }
  | { via: "operand"; value: string };

/** How the command will print: C7.2 "JSON mode carries the same in `error.data`". */
export type OutputMode = "text" | "json" | "json-strict";

export type Classification =
  | {
      kind: "classified";
      contract: typeof COMMAND_CLASSES_CONTRACT;
      path: string;
      agent?: string;
      class: CommandClass;
      entry: CommandEntry;
      /** `--help` / `-h` given: commander prints help and runs nothing. */
      help: boolean;
      target?: TargetSelector;
      /**
       * More than one selector names the session — two different selector flags, or a flag and the
       * operand (brick 7eb9686f, R2-a). The chosen `target` is then only the FIRST of them: the
       * placement step never calls that "this pod's own" (`own-target.ts`), and acpx's resolver refuses
       * such a line. Two values of the SAME flag are not a conflict (the last wins, in both readers).
       */
      targetConflict: boolean;
      /**
       * Where the command's own operands sit in the argv (indexes, in operand order) — the pass-through
       * rewrites a file-valued operand (`sessions import <archive>`) in place (brick 7eb9686f, F-4).
       */
      operandIndexes: number[];
      /** `one-shot`: this invocation is the from-records form. */
      fromRecords: boolean;
      /** This invocation is control-pod maintenance (A-7): it refuses in an agent pod. */
      controlPodOnly: boolean;
      output: OutputMode;
    }
  | {
      kind: "unclassified";
      contract: typeof COMMAND_CLASSES_CONTRACT;
      path: string;
      output: OutputMode;
    };

type Scan = {
  operands: string[];
  /** Index of each operand in the tokens this level scanned (parallel to `operands`). */
  operandAt: number[];
  /** How many tokens this level scanned: with `operandAt`, an operand's place in the whole argv. */
  tokenCount: number;
  values: Map<string, string>;
  /** Flags that took no value here (booleans, and flags this level does not declare). */
  booleans: Set<string>;
  help: boolean;
  rest: string[];
};

function emptyScan(): Scan {
  return {
    operands: [],
    operandAt: [],
    tokenCount: 0,
    values: new Map(),
    booleans: new Set(),
    help: false,
    rest: [],
  };
}

const HELP_FLAGS = new Set(["--help", "-h"]);

/** A combined short group `-abc`: booleans until the first value flag, which takes the rest or the next token. Returns how many tokens it consumed beyond itself. */
function readShortGroup(
  token: string,
  next: string | undefined,
  valueFlags: ReadonlySet<string>,
  scan: Scan,
): number {
  for (let c = 1; c < token.length; c += 1) {
    const short = `-${token[c]}`;
    scan.help ||= short === "-h";
    if (!valueFlags.has(short)) {
      scan.booleans.add(short);
      continue;
    }
    const last = c === token.length - 1;
    scan.values.set(short, last ? (next ?? "") : token.slice(c + 1));
    return last ? 1 : 0;
  }
  return 0;
}

/** One option token (it starts with `-` and is not `-` or `--`). Returns the extra tokens consumed. */
function readOption(
  token: string,
  next: string | undefined,
  valueFlags: ReadonlySet<string>,
  scan: Scan,
): number {
  if (HELP_FLAGS.has(token)) {
    scan.help = true;
    return 0;
  }
  if (valueFlags.has(token)) {
    scan.values.set(token, next ?? "");
    return 1;
  }
  const eq = token.indexOf("=");
  if (token.startsWith("--") && eq > 0) {
    scan.values.set(token.slice(0, eq), token.slice(eq + 1));
    return 0;
  }
  if (token.startsWith("--") || token.length === 2) {
    scan.booleans.add(token);
    return 0;
  }
  return readShortGroup(token, next, valueFlags, scan);
}

function isOperand(token: string): boolean {
  return !token.startsWith("-") || token === "-";
}

/**
 * How a level reads its tokens. `subcommands`: stop at the first operand (it names the subcommand);
 * `positional`: options only before the first operand, then everything is an operand (the program's
 * and an agent's prompt — `enablePositionalOptions` / `passThroughOptions`); `leaf`: options anywhere.
 */
type LevelMode = "subcommands" | "positional" | "leaf";

/**
 * Commander's option reading for one command level: a value flag takes the next token whatever it
 * is, `--flag=v` and an attached short value are one token, `--` ends options.
 *
 * ⚠️ `--help` / `-h` COUNTS ONLY BEFORE THE FIRST OPERAND, on purpose. Reading help where commander
 * would not (a `-h` among an agent prompt's pass-through words) would class a prompt `local` and run
 * it on the control pod in pod mode; missing a help commander would show only refuses it. The
 * conservative side is "not help".
 */
function scanLevel(tokens: readonly string[], node: GrammarNode, mode: LevelMode): Scan {
  const valueFlags = new Set(node.valueFlags);
  const scan = emptyScan();
  scan.tokenCount = tokens.length;
  for (let i = 0; i < tokens.length; i += 1) {
    const step = scanStep(tokens, i, mode, valueFlags, scan);
    if (step === "stop") {
      break;
    }
    i += step;
  }
  return scan;
}

/** One token of `scanLevel`: "stop", or how many further tokens it consumed. */
function scanStep(
  tokens: readonly string[],
  i: number,
  mode: LevelMode,
  valueFlags: ReadonlySet<string>,
  scan: Scan,
): number | "stop" {
  const token = tokens[i];
  const operandSeen = scan.operands.length > 0;
  if (token === "--" || (operandSeen && mode === "positional")) {
    const from = token === "--" ? i + 1 : i;
    scan.operands.push(...tokens.slice(from));
    scan.operandAt.push(...tokens.slice(from).map((_, k) => from + k));
    return "stop";
  }
  if (isOperand(token)) {
    if (mode === "subcommands") {
      scan.rest = tokens.slice(i);
      return "stop";
    }
    scan.operands.push(token);
    scan.operandAt.push(i);
    return 0;
  }
  const helpBefore = scan.help;
  const consumed = readOption(token, tokens[i + 1], valueFlags, scan);
  scan.help = operandSeen ? helpBefore : scan.help;
  return consumed;
}

/** The command paths directly beneath `parentPath` (`""` = the program). */
function childPaths(parentPath: string): string[] {
  const prefix = parentPath === "" ? "" : `${parentPath} `;
  return Object.keys(COMMAND_GRAMMAR).filter(
    (key) =>
      key !== "" &&
      key !== "<agent>" &&
      key !== parentPath &&
      key.startsWith(prefix) &&
      !key.slice(prefix.length).includes(" "),
  );
}

/** The child of `parentPath` that `token` names, by name or alias. */
function childOf(parentPath: string, token: string): string | undefined {
  const prefix = parentPath === "" ? "" : `${parentPath} `;
  return childPaths(parentPath).find(
    (path) => path.slice(prefix.length) === token || COMMAND_GRAMMAR[path].aliases?.includes(token),
  );
}

function targetFromFlags(spec: TargetSpec, scan: Scan): TargetSelector | undefined {
  for (const flag of spec.flags) {
    const value = scan.values.get(flag);
    if (value) {
      return { via: "flag", flag, value };
    }
  }
  return undefined;
}

/** How many DIFFERENT selectors (flags with a value, the operand) name the session. */
function selectorCount(entry: CommandEntry, scan: Scan): number {
  const spec = entry.target;
  if (!spec) {
    return 0;
  }
  const flags = spec.flags.filter((flag) => Boolean(scan.values.get(flag))).length;
  const operand = spec.operand !== undefined && scan.operands[spec.operand] ? 1 : 0;
  return flags + operand;
}

function targetOf(entry: CommandEntry, scan: Scan): TargetSelector | undefined {
  const spec = entry.target;
  if (!spec) {
    return undefined;
  }
  const operand = spec.operand === undefined ? undefined : scan.operands[spec.operand];
  return targetFromFlags(spec, scan) ?? (operand ? { via: "operand", value: operand } : undefined);
}

type Walk = { path: string; agent?: string; scan: Scan; help: boolean };

const unclassified = (path: string, output: OutputMode): Classification => ({
  kind: "unclassified",
  contract: COMMAND_CLASSES_CONTRACT,
  path,
  output,
});

/** Does commander give this command an implicit `help` subcommand? (Grammar data, F1.) */
function hasHelpCommand(path: string): boolean {
  return COMMAND_GRAMMAR[path]?.helpCommand === true;
}

/**
 * `acpx <agent> …`: an agent subcommand or the agent's own prompt action. ⚠️ NO `help` CASE: an
 * agent command has an action, so commander gives it no help command — `acpx claude help me` is a
 * prompt (F1). `hasHelpCommand("<agent>")` is false by the grammar, which the test pins.
 */
function walkAgent(agent: string, tokens: readonly string[], help: boolean): Walk | string {
  const agentNode = COMMAND_GRAMMAR["<agent>"];
  const level = scanLevel(tokens, agentNode, "subcommands");
  const sub = level.rest[0];
  if (sub === "help" && hasHelpCommand("<agent>")) {
    return { path: "help", agent, scan: level, help: true };
  }
  if (sub !== undefined && agentNode.children?.includes(sub)) {
    return walkCommand(sub, level.rest.slice(1), help || level.help, agent);
  }
  const scan = scanLevel(tokens, agentNode, "positional");
  return { path: "<agent>", agent, scan, help: help || scan.help };
}

/**
 * Descend from `start` while the next operand names a subcommand. Returns the walk, or the
 * unclassified path (a string) when an operand at a level with subcommands names none of them.
 */
function walkCommand(
  start: string,
  initial: readonly string[],
  initialHelp: boolean,
  agent?: string,
): Walk | string {
  let path = start;
  let tokens = initial;
  let help = initialHelp;
  for (;;) {
    const step = walkStep(path, tokens, help, agent);
    if (step.kind === "done") {
      return step.result;
    }
    ({ path, tokens, help } = step);
  }
}

function leafWalk(
  path: string,
  node: GrammarNode,
  tokens: readonly string[],
  help: boolean,
  agent: string | undefined,
): Walk {
  const scan = scanLevel(tokens, node, "leaf");
  return { path, agent, scan, help: help || scan.help };
}

type WalkStep =
  | { kind: "done"; result: Walk | string }
  | { kind: "descend"; path: string; tokens: readonly string[]; help: boolean };

function walkStep(
  path: string,
  tokens: readonly string[],
  help: boolean,
  agent: string | undefined,
): WalkStep {
  const node = COMMAND_GRAMMAR[path];
  if (childPaths(path).length === 0) {
    return { kind: "done", result: leafWalk(path, node, tokens, help, agent) };
  }
  const level = scanLevel(tokens, node, "subcommands");
  const next = level.rest[0];
  if (next === undefined) {
    return { kind: "done", result: { path, agent, scan: level, help: help || level.help } };
  }
  if (next === "help" && hasHelpCommand(path)) {
    return { kind: "done", result: { path: "help", agent, scan: level, help: true } };
  }
  const child = childOf(path, next);
  return child
    ? { kind: "descend", path: child, tokens: level.rest.slice(1), help: help || level.help }
    : { kind: "done", result: `${path} ${next}` };
}

function walkArgv(argv: readonly string[], builtInAgents: readonly string[]): Walk | string {
  const top = scanLevel(argv, COMMAND_GRAMMAR[""], "subcommands");
  const first = top.rest[0];
  if (first === undefined) {
    return { path: "", scan: top, help: top.help };
  }
  const verb = childOf("", first);
  if (verb) {
    return walkCommand(verb, top.rest.slice(1), top.help);
  }
  // `configurePublicCli`: a token that is not a registered verb is an agent command — unless
  // TOP_LEVEL_VERBS claims it (no agent of that name is registered: `help`), or `--agent` was given
  // and it is not a built-in agent. Then the words are the PROGRAM's prompt (F1: `acpx help`).
  const claimed = COMMAND_GRAMMAR[""].claimed?.includes(first) === true;
  if (!claimed && (!top.values.has("--agent") || builtInAgents.includes(first))) {
    return walkAgent(first, top.rest.slice(1), top.help);
  }
  return { path: "", scan: scanLevel(argv, COMMAND_GRAMMAR[""], "positional"), help: top.help };
}

/**
 * The command path, class and target of one acpx argv (the arguments after `node acpx`), read the
 * way commander reads it — without loading commander or any handler. `builtInAgents` is the agent
 * list acpx registers as commands (`listBuiltInAgents`).
 *
 * `unclassified`: a path this table has no entry for, or an operand at a level with subcommands
 * that names none of them — in commander a parse error or a command this table does not know; in
 * pod mode both refuse.
 */
export function classifyArgv(
  argv: readonly string[],
  options: { builtInAgents: readonly string[] },
): Classification {
  const pre = preCommanderPath(argv);
  const top = scanLevel(argv, COMMAND_GRAMMAR[""], "subcommands");
  if (pre !== undefined) {
    const entry = PRE_COMMANDER_PATHS[pre];
    const base = { contract: COMMAND_CLASSES_CONTRACT, path: pre, class: entry.class, entry };
    const flags = {
      help: false,
      targetConflict: false,
      operandIndexes: [],
      fromRecords: false,
      controlPodOnly: false,
    };
    return { kind: "classified", ...base, ...flags, output: outputMode(top) };
  }
  const walk = walkArgv(argv, options.builtInAgents);
  return typeof walk === "string"
    ? unclassified(walk, outputMode(top))
    : finish(walk, outputMode(top, walk.scan), argv.length);
}

/**
 * The output mode commander's handlers will use: `--json-strict`, or `--format json` among the
 * program's options or the leaf's own (`governor status --format json`), or a leaf's `--json`
 * (`sessions archive --json`). ⚠️ A config file's default format is NOT read here (loading the
 * config is the heavy graph); a refusal then prints text, as a pre-config error would.
 */
function outputMode(top: Scan, leaf?: Scan): OutputMode {
  const flagged = (scan: Scan | undefined, name: string) =>
    scan !== undefined && (scan.booleans.has(name) || scan.values.has(name));
  if (flagged(top, "--json-strict") || flagged(leaf, "--json-strict")) {
    return "json-strict";
  }
  const json =
    top.values.get("--format") === "json" ||
    leaf?.values.get("--format") === "json" ||
    flagged(leaf, "--json");
  return json ? "json" : "text";
}

/**
 * The argv shapes `src/cli.ts` and `cli-core`'s `main` handle before commander parses anything:
 * the owner entry (`argv[0]`), a module-path probe (alone), a version request among the program's
 * own options (`isTopLevelVersionRequest`), and a top-level `--skill` (skillflag prints and exits).
 */
function preCommanderPath(argv: readonly string[]): string | undefined {
  const probe = argv.length === 1 && argv[0].startsWith("__") && PRE_COMMANDER_PATHS[argv[0]];
  if (argv[0] === "__queue-owner" || probe) {
    return argv[0];
  }
  const top = scanLevel(argv, COMMAND_GRAMMAR[""], "subcommands");
  // Only among the program's own options: a `--skill` inside a prompt's words is prompt text.
  const has = (flag: string) => top.booleans.has(flag) || top.values.has(flag);
  if (has("--version") || has("-V")) {
    return "--version";
  }
  return has("--skill") ? "--skill" : undefined;
}

function scanHas(scan: Scan, flag: string): boolean {
  return scan.values.has(flag) || scan.booleans.has(flag);
}

function isControlPodOnly(entry: CommandEntry, scan: Scan): boolean {
  const rule = entry.controlPodOnly;
  return rule === true || (rule !== undefined && !scanHas(scan, rule.unless));
}

function finish(walk: Walk, output: OutputMode, argvLength: number): Classification {
  const entry = COMMAND_TABLE[walk.path];
  if (!entry) {
    return unclassified(walk.path, output);
  }
  const flag = entry.fromRecordsWhen;
  const fromRecords = flag !== undefined && scanHas(walk.scan, flag);
  const target = targetOf(entry, walk.scan);
  return {
    kind: "classified",
    contract: COMMAND_CLASSES_CONTRACT,
    path: walk.path,
    ...(walk.agent !== undefined ? { agent: walk.agent } : {}),
    class: entry.class,
    entry,
    help: walk.help,
    ...(target ? { target } : {}),
    targetConflict: selectorCount(entry, walk.scan) > 1,
    operandIndexes: walk.scan.operandAt.map((at) => argvLength - walk.scan.tokenCount + at),
    fromRecords,
    controlPodOnly: isControlPodOnly(entry, walk.scan),
    output,
  };
}

/** The classes whose pass-through acceptance depends on WHICH session the call is about (C6.2). */
const TARGET_CLASSES: ReadonlySet<CommandClass> = new Set([
  "record",
  "owner-if-pod",
  "owner-ensure",
]);

export type CallClassification =
  | {
      kind: "classified";
      contract: typeof COMMAND_CLASSES_CONTRACT;
      path: string;
      class: CommandClass;
      agent?: string;
      help: boolean;
      target?: TargetSelector;
      /**
       * The RECORD id of the session the call is about, resolved with acpx's own resolver (record
       * id, ACP id or unique suffix; a seat to its active holder) — what the command itself will
       * act on. `null`: it names no session acpx can resolve. Absent: not resolved, because the
       * class does not depend on it.
       */
      targetSessionId?: string | null;
      /**
       * WHY `targetSessionId` is `null` (A-52): present exactly when it is `null` on a class that depends on the
       * target, absent otherwise. `kind` is `not-found` (no match, no selector), `ambiguous` (acpx's resolver will
       * not choose; `message` is its own sentence) or `failed` (a store or I/O error, a selector refused as usage;
       * `message`). A reader that does not know the field reads `null` as "unresolved", as before A-52.
       */
      targetError?: { kind: "not-found" | "ambiguous" | "failed"; message?: string };
    }
  | { kind: "unclassified"; contract: typeof COMMAND_CLASSES_CONTRACT; path: string };

/**
 * The atrium server's entry (C6.2, brick b479441f reports/EXPORT-class-table.md): classify a
 * passed-through `argv` and, for `record` / `owner-if-pod` / `owner-ensure`, resolve its target.
 * The resolver is acpx's session store code, loaded on first need by dynamic import. (No command
 * defaults its target to the caller's own session — F4 — so the caller's identity is not needed.)
 */
export async function classifyCall(
  argv: readonly string[],
  options: { builtInAgents?: readonly string[] } = {},
): Promise<CallClassification> {
  const c = classifyArgv(argv, { builtInAgents: options.builtInAgents ?? listBuiltInAgents() });
  if (c.kind === "unclassified") {
    return { kind: c.kind, contract: c.contract, path: c.path };
  }
  const base = {
    kind: c.kind,
    contract: c.contract,
    path: c.path,
    class: c.class,
    ...(c.agent !== undefined ? { agent: c.agent } : {}),
    help: c.help,
    ...(c.target ? { target: c.target } : {}),
  };
  if (!TARGET_CLASSES.has(c.class)) {
    return base;
  }
  const { resolveTargetOutcome } = await import("./target-resolver.js");
  const outcome = await resolveTargetOutcome(c.target);
  return outcome.error === undefined
    ? { ...base, targetSessionId: outcome.recordId }
    : { ...base, targetSessionId: null, targetError: outcome.error };
}
