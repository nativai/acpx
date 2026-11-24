// Test-only seam for writer-rules-a64-cli.test.ts (brick 849cb075; the abee5465 TE's hook). Loaded with
// `node --import` into ONE `acpx sessions close` process: at its Nth unix-socket connect it writes
// A64_HOLD_MARKER and BLOCKS (synchronously) until A64_HOLD_GO exists. Product code is untouched.
import fs from "node:fs";
import net from "node:net";

const marker = process.env.A64_HOLD_MARKER;
const go = process.env.A64_HOLD_GO;
if (marker && go) {
  // eslint-disable-next-line typescript/unbound-method
  const original = net.Socket.prototype.connect as (
    this: net.Socket,
    ...args: unknown[]
  ) => net.Socket;
  let done = false;
  let seen = 0;
  const at = Number(process.env.A64_HOLD_AT ?? "1");
  const cell = new Int32Array(new SharedArrayBuffer(4));
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const unixPath =
      typeof first === "string" ? first : (first as { path?: unknown } | undefined)?.path;
    if (!done && typeof unixPath === "string" && ++seen >= at) {
      done = true;
      fs.writeFileSync(marker, new Date().toISOString());
      const deadline = Date.now() + 180_000;
      while (!fs.existsSync(go) && Date.now() < deadline) {
        Atomics.wait(cell, 0, 0, 50);
      }
    }
    return original.apply(this, args);
  } as typeof net.Socket.prototype.connect;
}
