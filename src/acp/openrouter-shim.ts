import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENROUTER_SHIM_CODE } from "../config/openrouter-shim-code.js";

export type ShimHandle = {
  port: number;
  pid: number;
  stop: () => void;
};

// Ensure the shim file exists on disk (idempotent; no-op if already written).
// Written once per process run to a fixed path so concurrent sessions share
// a single copy rather than thrashing the FS with per-session writes.
let shimPath: string | undefined;

function ensureShimFile(): string {
  if (shimPath) {
    return shimPath;
  }
  const dir = join(tmpdir(), "acpx-or-shim");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "shim.mjs");
  writeFileSync(p, OPENROUTER_SHIM_CODE, { mode: 0o644 });
  shimPath = p;
  return p;
}

/**
 * Start the OpenRouter model-rewrite shim as a child process.
 * Returns a handle with the bound port and a `stop()` function.
 * Rejects if the shim doesn't write PORT= within `timeoutMs` milliseconds.
 */
export function spawnOpenRouterShim(
  apiKey: string,
  model: string,
  reasoningEffort?: string,
  timeoutMs = 5000,
): Promise<ShimHandle> {
  return new Promise((resolve, reject) => {
    const path = ensureShimFile();
    const shimEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENROUTER_API_KEY: apiKey,
      OR_MODEL: model,
      PORT: "0",
    };
    if (reasoningEffort) {
      shimEnv.OR_REASONING_EFFORT = reasoningEffort;
    }
    const child = spawn(process.execPath, [path], {
      env: shimEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stdout = "";

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`[or-shim] timed out waiting for PORT= (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const m = stdout.match(/PORT=(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        const port = Number.parseInt(m[1], 10);
        const pid = child.pid!;
        resolve({
          port,
          pid,
          stop: () => {
            try {
              child.kill();
            } catch {
              /* already dead */
            }
          },
        });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[or-shim] ${chunk.toString("utf8")}`);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`[or-shim] exited early with code ${String(code)}`));
      }
    });
  });
}
