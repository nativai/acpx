import { realpathSync } from "node:fs";
import path from "node:path";
import { isControlPod } from "../config/control-pod.js";
import { basenameToken, type CommandParts } from "./client-process.js";

function sharedCwd(cwd: string): boolean {
  const candidates = [path.resolve(cwd)];
  try {
    candidates.push(realpathSync(cwd));
  } catch {
    // A missing cwd is still classified lexically; spawn reports it if allowed.
  }
  return candidates.some((p) =>
    ["/workspace", "/wisdom"].some((root) => p === root || p.startsWith(`${root}/`)),
  );
}

function packageExecutor({ command, args }: CommandParts): boolean {
  const name = basenameToken(command);
  if (name === "npx") {
    return true;
  }
  if (name === "npm") {
    return args.includes("exec") || args.includes("x");
  }
  if (name === "node" || name === "nodejs") {
    return nodePackageExecutor(args);
  }
  return false;
}

function nodePackageExecutor(args: readonly string[]): boolean {
  const script = args[0] ? path.basename(args[0]).toLowerCase() : "";
  return (
    script === "npx-cli.js" ||
    (script === "npm-cli.js" && (args.includes("exec") || args.includes("x")))
  );
}

/** Before package resolution: even an installed/cache hit must not silently
 * select project node_modules. Explicit control-runtime adapter paths survive.
 */
export function assertControlNpxLaunchAllowed(
  cwd: string,
  command: CommandParts,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isControlPod(env) && sharedCwd(cwd) && packageExecutor(command)) {
    throw new Error(
      "Control pod refused an npx/npm-exec adapter launch from /workspace or /wisdom. " +
        "Install the adapter into the control runtime (/opt), or run it in a workbench.",
    );
  }
}
