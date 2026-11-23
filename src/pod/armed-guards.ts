import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import workerThreads from "node:worker_threads";
import { sessionArchiveDirFor } from "../session/archive/paths.js";
import { parseSessionRecord } from "../session/persistence/parse.js";
import { sessionBaseDir } from "../session/persistence/session-base-dir.js";
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

function watchNetwork(undo: Restore[]): void {
  swap(net.Socket.prototype, "connect", refuseNetwork, undo);
  swap(net.Server.prototype, "listen", refuseNetwork, undo);
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
