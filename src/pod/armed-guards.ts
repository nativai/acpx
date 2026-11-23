import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import fs from "node:fs";
import inspector from "node:inspector";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import workerThreads from "node:worker_threads";
import { sessionArchiveDirFor } from "../session/archive/paths.js";
import { parseSessionRecord } from "../session/persistence/parse.js";
import { acpxStateRoot, sessionBaseDir } from "../session/persistence/session-base-dir.js";
import {
  isSessionRecordFileName,
  SESSION_INDEX_FILE,
} from "../session/persistence/session-dir-files.js";
import { tellParent } from "./target-verdict.js";

/**
 * What the armed verdict child watches itself for (K5 round 4, TE F2, F5, F4; brick 46b827ba). The Node permission
 * model stops a write, a spawn and a worker; it cannot say WHAT was attempted, and it says nothing of a read that
 * returned half a record. These guards are installed ONCE, in the child, before the command's own code runs, and each
 * tells the parent (`target-verdict.ts`) so that the door's refusal stands.
 *
 *   read evidence   every read of a store file — a session record (hot or archived), `index.json`, `seats.json` —
 *                   whose bytes do not parse, or fail to read for any reason but absence, tells `differs`. The evidence
 *                   is taken AT THE READ THAT DECIDES, whatever site makes it (the direct read, an index-entry load, a
 *                   seat's holder, a set-parent parent, the archive): a check made later cannot prove what an earlier
 *                   read saw — the record can be whole by then (the F2 race).
 *   denial watch    ANY `ERR_ACCESS_DENIED` from an fs mutation (sync, callback, promises, streams), a child process or
 *                   a worker, swallowed or printed by its message, tells `denied`.
 *   network         a connection OR a listen is refused and told (`network`). UDP and DNS are not covered: the accepted
 *                   residual (PLAN.md).
 *
 * Every install returns the function that undoes it, for the in-process rows; production never undoes.
 */

type Restore = () => void;
type Fn = (...args: unknown[]) => unknown;
const record = (target: object): Record<string, unknown> => target as Record<string, unknown>;

function swap(target: object, name: string, replacement: unknown, undo: Restore[]): void {
  const original = record(target)[name];
  record(target)[name] = replacement;
  undo.push(() => {
    record(target)[name] = original;
  });
}

const isDenied = (error: unknown): boolean => {
  const e = error as { code?: unknown; message?: unknown } | null;
  return (
    e?.code === "ERR_ACCESS_DENIED" ||
    (typeof e?.message === "string" && e.message.includes("Access to this API has been restricted"))
  );
};

function noteDenied(error: unknown): void {
  if (isDenied(error)) {
    tellParent("denied");
  }
}

/** The result of a call, watched: a throw, a rejection, a callback's error, or a stream's `error` event. */
function watched(original: Fn, onResult: (result: unknown) => void): Fn {
  return function (this: unknown, ...args: unknown[]): unknown {
    const last = args.at(-1);
    if (typeof last === "function") {
      args[args.length - 1] = (error: unknown, ...rest: unknown[]) => {
        noteDenied(error);
        if (error === null || error === undefined) {
          onResult(rest[0]);
        }
        return (last as Fn)(error, ...rest);
      };
    }
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (error) {
      noteDenied(error);
      throw error;
    }
    const thenable = result as { then?: unknown } | null;
    if (thenable && typeof thenable.then === "function") {
      return (result as Promise<unknown>).then(
        (value) => {
          onResult(value);
          return value;
        },
        (error: unknown) => {
          noteDenied(error);
          throw error;
        },
      );
    }
    const emitter = result as { emit?: Fn; on?: unknown } | null;
    if (emitter && typeof emitter.emit === "function" && typeof emitter.on === "function") {
      const emit = emitter.emit;
      emitter.emit = function (this: unknown, event: unknown, ...rest: unknown[]) {
        if (event === "error") {
          noteDenied(rest[0]);
        }
        return emit.call(this, event, ...rest);
      };
      return result;
    }
    onResult(result);
    return result;
  };
}

// ── the denial watch ───────────────────────────────────────────────────────────────────────────

/** Every fs name that mutates (or opens, where a write is asked for) — DISCOVERED by name, so a new API is covered. */
const FS_MUTATION =
  /^(write|append|mkdir|mkdtemp|rename|unlink|rm|rmdir|copy|cp|truncate|ftruncate|chmod|chown|lchmod|lchown|fchmod|fchown|utimes|futimes|lutimes|link|symlink|open|createWriteStream|fsync|fdatasync|mkfifo)/u;
const CHILD_PROCESS = /^(spawn|exec|execFile|fork)/u;

function watchDenials(undo: Restore[]): void {
  for (const target of [fs, fs.promises]) {
    for (const name of Object.keys(target)) {
      const original = record(target)[name];
      if (typeof original === "function" && FS_MUTATION.test(name)) {
        swap(
          target,
          name,
          watched(original as Fn, () => undefined),
          undo,
        );
      }
    }
  }
  for (const name of Object.keys(childProcess)) {
    const original = record(childProcess)[name];
    if (typeof original === "function" && CHILD_PROCESS.test(name)) {
      swap(
        childProcess,
        name,
        watched(original as Fn, () => undefined),
        undo,
      );
    }
  }
  const Original = workerThreads.Worker;
  class WatchedWorker extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      try {
        super(...args);
      } catch (error) {
        noteDenied(error);
        throw error;
      }
    }
  }
  swap(workerThreads, "Worker", WatchedWorker, undo);
}

// ── the read evidence ──────────────────────────────────────────────────────────────────────────

type StoreKind = "record" | "index" | "seats";

function pathOf(file: unknown): string | undefined {
  if (file instanceof URL) {
    return path.resolve(file.pathname);
  }
  return typeof file === "string" || Buffer.isBuffer(file)
    ? path.resolve(file.toString())
    : undefined;
}

/** Is this path a store file whose content decides a lookup? Evaluated per call: the store is where the env says. */
function storeKindOf(file: unknown): StoreKind | undefined {
  const resolved = pathOf(file);
  if (resolved === undefined) {
    return undefined;
  }
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const hot = sessionBaseDir();
  if (dir === hot) {
    return hotKindOf(base);
  }
  return dir === sessionArchiveDirFor(hot) && isSessionRecordFileName(base) ? "record" : undefined;
}

function hotKindOf(base: string): StoreKind | undefined {
  if (base === SESSION_INDEX_FILE) {
    return "index";
  }
  if (base === "seats.json") {
    return "seats";
  }
  return isSessionRecordFileName(base) ? "record" : undefined;
}

function parses(kind: StoreKind, bytes: unknown): boolean {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes),
    );
    if (kind === "record") {
      return parseSessionRecord(parsed) !== null;
    }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function watchReads(undo: Restore[]): void {
  const check = (file: unknown, bytes: unknown): void => {
    const kind = storeKindOf(file);
    if (kind !== undefined && !parses(kind, bytes)) {
      tellParent("differs");
    }
  };
  const failed = (file: unknown, error: unknown): void => {
    // absence is an answer; anything else (EIO, EISDIR, a denied read) is a read that did not happen
    if (
      storeKindOf(file) !== undefined &&
      (error as { code?: unknown } | null)?.code !== "ENOENT"
    ) {
      tellParent("differs");
    }
  };
  const wrap = (original: Fn): Fn =>
    function (this: unknown, ...args: unknown[]): unknown {
      const file = args[0];
      const last = args.at(-1);
      if (typeof last === "function") {
        args[args.length - 1] = (error: unknown, data: unknown) => {
          if (error) {
            failed(file, error);
          } else {
            check(file, data);
          }
          return (last as Fn)(error, data);
        };
        return original.apply(this, args);
      }
      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (error) {
        failed(file, error);
        throw error;
      }
      if (result && typeof (result as { then?: unknown }).then === "function") {
        return (result as Promise<unknown>).then(
          (data) => {
            check(file, data);
            return data;
          },
          (error: unknown) => {
            failed(file, error);
            throw error;
          },
        );
      }
      check(file, result);
      return result;
    };
  for (const [target, name] of [
    [fs, "readFile"],
    [fs, "readFileSync"],
    [fs.promises, "readFile"],
  ] as const) {
    swap(target, name, wrap(record(target)[name] as Fn), undo);
  }
}

// ── the network ────────────────────────────────────────────────────────────────────────────────

function refuseNetwork(): never {
  tellParent("network");
  throw Object.assign(
    new Error("ERR_ACCESS_DENIED: a pod's verdict child may not use the network"),
    {
      code: "ERR_ACCESS_DENIED",
    },
  );
}

/** The same refusal for a Promise API: a rejection, so `.catch` and `await` see it as they would a failed call. */
function refuseNetworkAsync(): Promise<never> {
  try {
    refuseNetwork();
  } catch (error) {
    return Promise.reject(error);
  }
  return Promise.reject(new Error("unreachable"));
}

/** Names that send a UDP packet or a name query, DISCOVERED by name on each dns surface (a new `resolveX` is covered). */
const DNS_QUERY = /^(lookup|resolve|reverse)/u;

function barDnsSurface(target: object, refusal: () => unknown, undo: Restore[]): void {
  for (const name of Object.keys(target)) {
    if (typeof record(target)[name] === "function" && DNS_QUERY.test(name)) {
      swap(target, name, refusal, undo);
    }
  }
}

/** The names a Resolver class gets on its prototype (`resolve4`, `reverse`, …). */
function barResolver(resolver: unknown, refusal: () => unknown, undo: Restore[]): void {
  const prototype = (resolver as { prototype?: object } | undefined)?.prototype;
  if (prototype !== undefined) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (typeof record(prototype)[name] === "function" && DNS_QUERY.test(name)) {
        swap(prototype, name, refusal, undo);
      }
    }
  }
}

/** The native handles behind sockets and name resolution, by their (deprecated) `process.binding` names. */
const NETWORK_BINDINGS = new Set([
  "udp_wrap",
  "tcp_wrap",
  "cares_wrap",
  "pipe_wrap",
  "tls_wrap",
  "stream_wrap",
]);

/**
 * The network, in the armed child. TCP: `connect` (every client, `fetch`, `http`, `tls`, and a connect to a HOSTNAME, which is
 * refused before it resolves) and `listen`. UDP: every dgram socket (`createSocket`, the `Socket` class, `bind`, `send`,
 * `connect`). DNS: `lookup`, `lookupService`, `resolve*`, `reverse` on `dns`, `dns.promises`, and both `Resolver` classes.
 * Also `inspector.open` (an inbound listener) and the native handles behind `process.binding`. Node 22's permission model
 * restricts none of these (v25's does); each attempt tells `network` and fails with `ERR_ACCESS_DENIED`. COULD NOT BE BARRED:
 * nothing in userland reaches a raw socket without one of these; a module loaded BEFORE the guards (none: they install first)
 * would have kept its own references.
 */
function watchNetwork(undo: Restore[]): void {
  swap(net.Socket.prototype, "connect", refuseNetwork, undo);
  swap(net.Server.prototype, "listen", refuseNetwork, undo);
  swap(dgram, "createSocket", refuseNetwork, undo);
  swap(dgram, "Socket", refuseNetwork, undo);
  for (const name of ["bind", "send", "connect"]) {
    swap(dgram.Socket.prototype, name, refuseNetwork, undo);
  }
  barDnsSurface(dns, refuseNetwork, undo);
  barDnsSurface(dns.promises, refuseNetworkAsync, undo);
  barResolver(dns.Resolver, refuseNetwork, undo);
  barResolver(dns.promises.Resolver, refuseNetworkAsync, undo);
  swap(inspector, "open", refuseNetwork, undo);
  const binding = record(process).binding as ((name: string) => unknown) | undefined;
  if (typeof binding === "function") {
    swap(
      process,
      "binding",
      function (this: unknown, name: string) {
        if (NETWORK_BINDINGS.has(name)) {
          refuseNetwork();
        }
        return binding.call(this, name);
      },
      undo,
    );
  }
}

/** Installs every guard; returns the function that removes them (the in-process rows). */
export function installArmedGuards(): Restore {
  const undo: Restore[] = [];
  watchDenials(undo);
  watchReads(undo);
  watchNetwork(undo);
  syncBuiltinESMExports();
  return () => {
    for (const restore of undo.toReversed()) {
      restore();
    }
    syncBuiltinESMExports();
  };
}

/** The read evidence alone, for the row that proves a lookup WITHOUT it can be wrong. */
export function installReadEvidenceOnly(): Restore {
  const undo: Restore[] = [];
  watchReads(undo);
  syncBuiltinESMExports();
  return () => {
    for (const restore of undo.toReversed()) {
      restore();
    }
    syncBuiltinESMExports();
  };
}

// ── the read-only check ────────────────────────────────────────────────────────────────────

type Permission = { has(scope: string, reference?: string): boolean };

/** `permission.has`, with a runtime that does not know the scope counted as "no". */
function granted(permission: Permission, scope: string, reference?: string): boolean {
  try {
    return permission.has(scope, reference);
  } catch {
    return false;
  }
}

/** The places a write grant is looked for by PATH: the root, the store, the home, the working directory, tmp. */
function writeProbePaths(): string[] {
  const cwd = process.cwd();
  return [path.parse(cwd).root, sessionBaseDir(), acpxStateRoot(), os.homedir(), cwd, os.tmpdir()];
}

/**
 * Has the RUNTIME made this process read-only? (Lives here, not in `target-verdict.ts`, which the CLI entry reaches statically: it must stay free of the store modules.) The permission model is on and grants — at ANY scope this can test —
 * no file write (not on the root, the store, the state home, the home, the working directory or tmp: a path-scoped
 * grant answers `has("fs.write")` false and `has("fs.write", <path>)` true, so the path-less question is not
 * enough: K5 round 4 TE F1), no child process, no worker, no addon, no wasi; the command line carries no `--allow-*`
 * but the read grant; and `NODE_OPTIONS` carries none. Anything else is "not read-only" and the verdict is not honoured.
 */
export function isReadOnlyProcess(): boolean {
  const permission = (process as unknown as { permission?: Permission }).permission;
  if (permission === undefined) {
    return false;
  }
  const scopes = ["fs.write", "child", "worker", "addon", "wasi"];
  return (
    !scopes.some((scope) => granted(permission, scope)) &&
    !writeProbePaths().some((probe) => granted(permission, "fs.write", probe)) &&
    !process.execArgv.some(
      (arg) => arg.startsWith("--allow-") && !arg.startsWith("--allow-fs-read"),
    ) &&
    !(process.env.NODE_OPTIONS ?? "").includes("--allow-")
  );
}
