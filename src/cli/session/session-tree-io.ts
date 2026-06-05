// Real filesystem / clock / liveness adapter for the pure `session-tree` reader.
// Kept separate so `session-tree.ts` stays node-fs-free and unit-testable.

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sessionBaseDir } from "../../session/persistence.js";
import { readQueueOwnerLiveness } from "../queue/lease-store.js";
import type { FileStat, TreeIO } from "./session-tree.js";

/** The CLI-owned sidecar cache — lives in `~/.acpx`, NOT inside `sessions/`. */
export function treeCachePath(): string {
  return path.join(os.homedir(), ".acpx", ".tree-cache.json");
}

export function createDefaultTreeIO(options: { cache?: boolean } = {}): TreeIO {
  return {
    baseDir: sessionBaseDir(),
    cachePath: options.cache === false ? undefined : treeCachePath(),
    listSessionFiles: (dir) => fs.readdir(dir),
    statFile: async (filePath): Promise<FileStat | null> => {
      try {
        const stat = await fs.stat(filePath);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        return null;
      }
    },
    openChunks: (filePath) =>
      createReadStream(filePath, {
        encoding: "utf8",
        highWaterMark: 1 << 16,
      }) as AsyncIterable<string>,
    readCache: async (cachePath) => {
      try {
        return await fs.readFile(cachePath, "utf8");
      } catch {
        return null;
      }
    },
    writeCache: async (cachePath, content) => {
      // Atomic temp+rename so a concurrent reader on the shared box never sees a
      // torn file (a partial read just fails JSON.parse → degrades to a scan).
      const tempPath = `${cachePath}.${process.pid}.tmp`;
      try {
        await fs.writeFile(tempPath, content, "utf8");
        await fs.rename(tempPath, cachePath);
      } catch {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    },
    now: () => Date.now(),
    probeLive: async (id) => {
      try {
        const liveness = await readQueueOwnerLiveness(id);
        return Boolean(liveness && liveness.alive && !liveness.stale);
      } catch {
        return false;
      }
    },
  };
}
