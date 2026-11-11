/**
 * The person model's pure primitives (PERSON-CONTRACT v3.1: C1 person id, C3 handle, C4 resolver,
 * C7.3 reserved words; brick b9ae0de1, build block P0 of brick fcef527e).
 *
 * ⚠️ FROZEN CROSS-REPO CONTRACT, BYTE-FOR-BYTE. This exact file lives at two paths:
 *   - acpx-ui  `shared/person.ts`
 *   - acpx     `src/session/persistence/person.ts`
 * Both repos' tests pin its sha256 (`PERSON_TS_SHA256` in `shared/person.test.ts` / `test/person.test.ts`)
 * and run ONE shared fixture (`person.fixture.json`, also pinned) through it. Change the file here and
 * the digest reds in the repo you did not touch. To change it: edit both copies to the same bytes,
 * update the digest in both tests, and amend the fixture only through the programme lead (a person id
 * or a handle rule change is a contract change, not a refactor).
 *
 * Why it is shaped this way:
 *   - No imports at all. acpx-ui's `shared/actor.ts` does not exist in acpx, so the actor is read
 *     structurally (`unknown` in, narrowed here), and the SHA-256 below is local. A single import line
 *     that differed between the repos would make "byte-identical" a claim about everything but the one
 *     line that can drift.
 *   - SHA-256 is implemented here, not taken from `node:crypto`: this file is imported by acpx-ui's
 *     browser bundle too (Vite cannot bundle `node:crypto`; `crypto.subtle` is async and absent on a
 *     plain-http devN origin). The browser still never has to hash (C1.5: the server hands it ids), but
 *     the module must not break the bundle that imports it. Both repos' tests check it against
 *     `node:crypto` on every vector and on every padding boundary.
 *   - Formatting is oxfmt's (acpx's formatter, which gates acpx's merge); acpx-ui has no formatter, so
 *     the one text is formatted once, for the stricter repo.
 *   - No I/O, no clock, no randomness: every function is a plain unit test.
 */

/** C7.3. Exact-match words that never become handles. Only `everyone` and `box` mean anything today. */
export const RESERVED_HANDLES: readonly string[] = Object.freeze([
  "everyone",
  "all",
  "box",
  "machine",
  "system",
  "agent",
  "agents",
  "human",
  "humans",
  "anonymous",
  "unknown",
  "nobody",
  "none",
  "me",
  "you",
  "self",
  "admin",
  "root",
  "person",
  "people",
  "owner",
]);

/** One row of a box's people list, as far as the resolver reads it (C6.2 holds more; extra keys are ignored). */
export interface PersonListEntry {
  id: string;
  name: string;
  handle: string;
  former_handles?: readonly string[];
}

/** What a successful match, a candidate or a suggestion carries: the PersonRef plus the current handle. */
export interface PersonHit {
  id: string;
  name: string;
  handle: string;
}

/** C4.2. `note` is set for a former handle (`now <handle>`) and for an id this box does not know. */
export type MatchResult =
  | { ok: true; person: PersonHit; note?: string }
  | { ok: false; error: "unknown"; suggestions: PersonHit[]; note?: string }
  | { ok: false; error: "ambiguous"; candidates: PersonHit[] }
  | { ok: false; error: "other-box"; box: string };

// ---------------------------------------------------------------------------
// SHA-256 (private). FIPS 180-4; input is the UTF-8 encoding of a string.
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function padSha256Message(message: Uint8Array): DataView {
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((message.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (message.length * 8) >>> 0);
  return view;
}

function sha256Schedule(view: DataView, offset: number): Uint32Array {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i += 1) {
    w[i] = view.getUint32(offset + i * 4);
  }
  for (let i = 16; i < 64; i += 1) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  return w;
}

function sha256Compress(h: Uint32Array, w: Uint32Array): void {
  let [a, b, c, d, e, f, g, hh] = h;
  for (let i = 0; i < 64; i += 1) {
    const t1 =
      (hh +
        (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
        ((e & f) ^ (~e & g)) +
        SHA256_K[i] +
        w[i]) >>>
      0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  const next = [a, b, c, d, e, f, g, hh];
  for (let i = 0; i < 8; i += 1) {
    h[i] = (h[i] + next[i]) >>> 0;
  }
}

function sha256Hex(text: string): string {
  const view = padSha256Message(new TextEncoder().encode(text));
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    sha256Compress(h, sha256Schedule(view, offset));
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}

// ---------------------------------------------------------------------------
// C1 · person id
// ---------------------------------------------------------------------------

const PERSON_ID_RE = /^p-[0-9a-f]{20}$/;

/** C1.1 format: `p-` + 20 lowercase hex. Exact: no padding, no case-folding, no prefix match, no trailing LF. */
export function isPersonId(s: unknown): s is string {
  return typeof s === "string" && PERSON_ID_RE.test(s);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function humanDns(actor: unknown): { issuer: string; subject: string } | null {
  if (typeof actor !== "object" || actor === null) {
    return null;
  }
  const { kind, verified, issuer, subject } = actor as Record<string, unknown>;
  if (kind !== "human" || verified !== true) {
    return null;
  }
  return isNonEmptyString(issuer) && isNonEmptyString(subject) ? { issuer, subject } : null;
}

/**
 * The Telegram leg (Telegram CONCEPTION 5.5, K7). A forwarded Telegram message carries the actor
 * `{kind:'human', channel:'telegram', verified:false, name, telegram_user_id, person_id, box}`; its person
 * is the `person_id` the bridge wrote, and only when that is a well-formed id (C1.1: exact, no padding, no
 * case-folding). It is a stored id, never a hash of anything, and nothing else about the actor is read:
 * another channel carrying a `person_id` is not a person by it.
 */
function telegramPersonId(actor: unknown): string | null {
  if (typeof actor !== "object" || actor === null) {
    return null;
  }
  const { kind, channel, person_id } = actor as Record<string, unknown>;
  return kind === "human" && channel === "telegram" && isPersonId(person_id) ? person_id : null;
}

/**
 * C1.1 + C2.1. `p-` + the first 20 hex of sha256(UTF-8(issuer + "\n" + subject)), the DNs exactly as stored
 * (no trim, no case-folding, no re-ordering). `null` for every non-person: an agent, a system component,
 * an unverified or anonymous human, a human without both DNs. Does not throw for any JSON-shaped input.
 * A human actor without a verified certificate is a person only through the Telegram leg above.
 */
export function personIdOf(actor: unknown): string | null {
  const dns = humanDns(actor);
  return dns === null
    ? telegramPersonId(actor)
    : `p-${sha256Hex(`${dns.issuer}\n${dns.subject}`).slice(0, 20)}`;
}

// ---------------------------------------------------------------------------
// C3 · handle
// ---------------------------------------------------------------------------

const MAX_HANDLE_LENGTH = 20;
const HANDLE_RE = /^[a-z](?:[a-z0-9-]{0,18}[a-z0-9])$/;

/**
 * C3.1 format only: 2-20 lowercase ASCII letters, digits or `-`, starting with a letter and ending with a
 * letter or digit. Strict lowercase: a caller that accepts input case-insensitively lowercases it first.
 * It says nothing about reserved words (C7.3: check `RESERVED_HANDLES`) or whether the handle is free.
 */
export function isValidHandle(s: unknown): s is string {
  return typeof s === "string" && HANDLE_RE.test(s);
}

function isUsableHandle(s: string): boolean {
  return isValidHandle(s) && !RESERVED_HANDLES.includes(s);
}

const FOLDED_LETTERS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  ø: "o",
  ł: "l",
  đ: "d",
  þ: "th",
  œ: "oe",
};

function trimDashes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "-") {
    start += 1;
  }
  while (end > start && s[end - 1] === "-") {
    end -= 1;
  }
  return s.slice(start, end);
}

/** C3.3 steps 1-4. NFKD, drop combining marks, lowercase, the seven letters NFKD leaves alone, cut at `@`, split. */
function nameTokens(name: string): string[] {
  const folded = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ßæøłđþœ]/g, (letter) => FOLDED_LETTERS[letter] ?? letter);
  return folded
    .split("@")[0]
    .split(/[^a-z0-9-]+/)
    .map(trimDashes)
    .filter((token) => token !== "");
}

/** Cut to `max` characters, then drop a trailing `-` the cut may have exposed. */
function cutHandle(base: string, max: number): string {
  return trimDashes(base.slice(0, max));
}

function startsWithLetter(s: string): boolean {
  return /^[a-z]/.test(s);
}

/** The named candidates in C3.3 order, plus the series base the `-2`, `-3`... suffixes hang on. */
function candidatePlan(tokens: string[], fallback: string): { bases: string[]; series: string } {
  if (tokens.length === 0) {
    return { bases: [fallback], series: fallback };
  }
  const last = tokens[tokens.length - 1];
  const firstLast = `${tokens[0]}-${last}`;
  const bases = tokens.length === 1 ? [last] : [last, firstLast];
  const preferred = tokens.length === 1 ? [last] : [firstLast, last];
  const series = preferred.find(startsWithLetter) ?? fallback;
  return { bases: series === fallback ? [...bases, fallback] : bases, series };
}

function* candidateStream(tokens: string[], fallback: string): Generator<string, void, undefined> {
  const { bases, series } = candidatePlan(tokens, fallback);
  const seen = new Set<string>();
  const fresh = (candidate: string): boolean => isUsableHandle(candidate) && !seen.has(candidate);
  for (const base of bases) {
    const candidate = cutHandle(base, MAX_HANDLE_LENGTH);
    if (fresh(candidate)) {
      seen.add(candidate);
      yield candidate;
    }
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${cutHandle(series, MAX_HANDLE_LENGTH - suffix.length)}${suffix}`;
    if (fresh(candidate)) {
      seen.add(candidate);
      yield candidate;
    }
  }
}

/**
 * C3.3. The handles to try for a person, in order, lazily and without end: the family name (last token),
 * `first-last`, then `first-last-2`, `-3`... A bare given name is a candidate only when it is the only
 * token. Every candidate is at most 20 characters, valid (C3.1) and not reserved (C7.3); a suffix is never
 * cut off by the 20-character limit (the base is shortened instead). A name that yields no token gets
 * `person-<first 6 hex of the id>` (then `-2`...). The caller takes the first candidate that is free
 * against every current and former handle on its box; this function does not know the box.
 *
 * Throws `TypeError` when `id` is not a person id, because the fallback is derived from it.
 */
export function handleCandidates(name: string, id: string): Generator<string, void, undefined> {
  if (!isPersonId(id)) {
    throw new TypeError("handleCandidates: id is not a person id");
  }
  return candidateStream(nameTokens(name), `person-${id.slice(2, 8)}`);
}

// ---------------------------------------------------------------------------
// C4 · resolver
// ---------------------------------------------------------------------------

const MAX_SUGGESTIONS = 5;

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/** C4.1 leg 3: case-folded, whitespace collapsed. */
function foldName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function hit(entry: PersonListEntry): PersonHit {
  return { id: entry.id, name: entry.name, handle: entry.handle };
}

function settle(entries: PersonListEntry[], note?: string): MatchResult | null {
  if (entries.length === 0) {
    return null;
  }
  if (entries.length > 1) {
    return { ok: false, error: "ambiguous", candidates: entries.map(hit) };
  }
  const person = hit(entries[0]);
  return note === undefined ? { ok: true, person } : { ok: true, person, note };
}

function suggestionsFor(list: readonly PersonListEntry[], input: string): PersonHit[] {
  const needle = foldName(input);
  if (needle === "") {
    return [];
  }
  return list
    .filter(
      (entry) =>
        entry.handle.includes(needle) ||
        foldName(entry.name)
          .split(" ")
          .some((token) => token.includes(needle)),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map(hit);
}

function matchById(list: readonly PersonListEntry[], input: string): MatchResult | null {
  if (!isPersonId(input)) {
    return null;
  }
  return (
    settle(list.filter((entry) => entry.id === input)) ?? {
      ok: false,
      error: "unknown",
      suggestions: [],
      note: "people are per box",
    }
  );
}

function matchByHandle(list: readonly PersonListEntry[], input: string): MatchResult | null {
  const key = asciiLower(input);
  const current = settle(list.filter((entry) => entry.handle === key));
  if (current !== null) {
    return current;
  }
  const former = list.filter((entry) => entry.former_handles?.includes(key) === true);
  return settle(former, former.length === 1 ? `now ${former[0].handle}` : undefined);
}

function matchByName(list: readonly PersonListEntry[], input: string): MatchResult | null {
  const key = foldName(input);
  return settle(list.filter((entry) => foldName(entry.name) === key));
}

/** `ref@box` with something on both sides of the first `@`. A box-qualified ref is never resolved here (C4.4). */
function boxOf(input: string): string | null {
  const at = input.indexOf("@");
  if (at <= 0 || at === input.length - 1) {
    return null;
  }
  return input.slice(at + 1);
}

/**
 * C4. Resolve one reference against a box's people list: a leading `@` is ignored; `ref@box` answers
 * `other-box` without looking at the list; then, in order, a person id (exact), a handle (current, then
 * former; ASCII case-insensitive) and a full display name (case-folded, whitespace collapsed). Nothing
 * else matches: no prefix, no substring, no first name, no fuzzy match. Zero matches is `unknown` with up
 * to five suggestions (people whose handle or a name token contains the input; shown, never chosen); two or
 * more is `ambiguous` with every candidate. An empty reference is `unknown` with no suggestions.
 * Does not throw for a list of well-typed rows.
 */
export function matchRef(list: readonly PersonListEntry[], ref: string): MatchResult {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  const input = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const box = boxOf(input);
  if (box !== null) {
    return { ok: false, error: "other-box", box };
  }
  if (input === "") {
    return { ok: false, error: "unknown", suggestions: [] };
  }
  const matchers = [matchById, matchByHandle, matchByName];
  for (const matcher of matchers) {
    const result = matcher(list, input);
    if (result !== null) {
      return result;
    }
  }
  return { ok: false, error: "unknown", suggestions: suggestionsFor(list, input) };
}
