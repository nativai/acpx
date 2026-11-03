import { readFileSync } from "node:fs";

// SSH login shells may lose Docker ENV. The image-owned marker is authoritative.
const controlImage = (() => {
  try {
    return readFileSync("/etc/nativai/image-role", "utf8").trim() === "control";
  } catch {
    return false;
  }
})();

export function isControlPod(env: NodeJS.ProcessEnv = process.env): boolean {
  return controlImage || env.NV_DEV_SERVER_ROLE === "control";
}
