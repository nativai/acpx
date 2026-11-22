/**
 * Is this command line one the CONTROL POD would get as far as RESOLVING the session for? (K5 TE F1c.)
 *
 * The control pod parses before it resolves: an unknown option, a wrong operand count, an invalid `--format`
 * value, `--json-strict` without `--format json` are refused there with their own exit code and wording, and a
 * "Session not found" for such a line would be a false answer. A pod cannot run commander for this, so it
 * accepts only the shapes MEASURED to reach the resolve — the verb's listed options and operand count, the two
 * program options `--format` / `--json-strict` — and anything else (including a program option whose value it
 * cannot validate, `--timeout abc`) is "not clean": the caller keeps the door's refusal.
 * `test/pod-not-found.test.ts` holds each verb's lists against the real commander registration.
 */

export type LineVerb = {
  /** Value-taking options of the verb (given as `--x v` or `--x=v`). */
  readonly values: readonly string[];
  readonly booleans: readonly string[];
  readonly operands: readonly [min: number, max: number];
  /** `set-parent` declares its own `--format` on the leaf. */
  readonly leafFormat?: true;
};

export type Line = { format: "text" | "json" | "quiet"; jsonStrict: boolean };

const FORMATS = new Set(["text", "json", "quiet"]);

/** The value of the option at `argv[i]` (`--x=v` or `--x v`) and where scanning resumes. */
function valueAt(argv: readonly string[], i: number): { value: string; next: number } | undefined {
  const token = argv[i] ?? "";
  const eq = token.indexOf("=");
  if (eq >= 0) {
    return { value: token.slice(eq + 1), next: i + 1 };
  }
  const value = argv[i + 1];
  return value === undefined ? undefined : { value, next: i + 2 };
}

const nameOf = (token: string): string => token.split("=")[0] ?? token;

/** A valid `--format` at `argv[i]`: its value and the next index. */
function formatAt(argv: readonly string[], i: number): { value: string; next: number } | undefined {
  const taken = valueAt(argv, i);
  return taken !== undefined && FORMATS.has(taken.value) ? taken : undefined;
}

type Step = { next: number; operand?: true; format?: string; jsonStrict?: true };

/** The program's own options before the command; only `--format` and `--json-strict` are known here. */
function globalStep(argv: readonly string[], i: number): Step | undefined {
  const name = nameOf(argv[i] ?? "");
  if (name === "--json-strict") {
    return (argv[i] ?? "").includes("=") ? undefined : { next: i + 1, jsonStrict: true };
  }
  const taken = name === "--format" ? formatAt(argv, i) : undefined;
  return taken ? { next: taken.next, format: taken.value } : undefined;
}

/** A `--format` carried by an option of the verb's own region (`set-parent` only). */
function leafFormatStep(argv: readonly string[], i: number): Step | undefined {
  const taken = formatAt(argv, i);
  return taken ? { next: taken.next, format: taken.value } : undefined;
}

/** One OPTION token of the verb's own region. */
function optionStep(verb: LineVerb, argv: readonly string[], i: number): Step | undefined {
  const token = argv[i] ?? "";
  const name = nameOf(token);
  if (verb.leafFormat === true && name === "--format") {
    return leafFormatStep(argv, i);
  }
  if (verb.booleans.includes(name)) {
    return token.includes("=") ? undefined : { next: i + 1 };
  }
  const taken = verb.values.includes(name) ? valueAt(argv, i) : undefined;
  return taken ? { next: taken.next } : undefined;
}

/** One token of the verb's own region: an operand, or an option. */
function leafStep(verb: LineVerb, argv: readonly string[], i: number): Step | undefined {
  return (argv[i] ?? "").startsWith("-")
    ? optionStep(verb, argv, i)
    : { next: i + 1, operand: true };
}

type Region = { format?: string; jsonStrict: boolean; operands: number; next: number };

/** Folds `step` over `argv` from `from`, while `more(i)` holds; undefined as soon as a token is not accepted. */
function scan(
  argv: readonly string[],
  from: number,
  more: (i: number) => boolean,
  step: (i: number) => Step | undefined,
): Region | undefined {
  const region: Region = { jsonStrict: false, operands: 0, next: from };
  while (region.next < argv.length && more(region.next)) {
    const taken = step(region.next);
    if (!taken) {
      return undefined;
    }
    region.operands += taken.operand ? 1 : 0;
    region.jsonStrict ||= taken.jsonStrict === true;
    region.format = taken.format ?? region.format;
    region.next = taken.next;
  }
  return region;
}

/** Do the regions form a line the control pod accepts? */
function accepted(verb: LineVerb, top: Region, leaf: Region, format: string): boolean {
  const [min, max] = verb.operands;
  return leaf.operands >= min && leaf.operands <= max && (!top.jsonStrict || format === "json");
}

/** The two regions of the line: the program's own options, then the command's two words and its own tokens. */
function regionsOf(
  verb: LineVerb,
  argv: readonly string[],
): { top: Region; leaf: Region } | undefined {
  const isOption = (i: number) => (argv[i] ?? "").startsWith("-");
  const top = scan(argv, 0, isOption, (i) => globalStep(argv, i));
  const leaf =
    top &&
    scan(
      argv,
      top.next + 2,
      () => true,
      (i) => leafStep(verb, argv, i),
    );
  return top && leaf ? { top, leaf } : undefined;
}

/**
 * The line's format, or undefined when the control pod would refuse it before resolving. The command is two
 * words (`<agent> status`, `sessions set-os`, `people set-owner`) right after the program's own options.
 */
export function cleanLine(verb: LineVerb, argv: readonly string[]): Line | undefined {
  const regions = regionsOf(verb, argv);
  if (!regions) {
    return undefined;
  }
  const format = regions.leaf.format ?? regions.top.format ?? "text";
  return accepted(verb, regions.top, regions.leaf, format)
    ? { format: format as Line["format"], jsonStrict: regions.top.jsonStrict }
    : undefined;
}
