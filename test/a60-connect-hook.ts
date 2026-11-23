// Test seam for the A-60 close rows (brick f67e0ff1) — loaded with `node --import` into the CLI process
// of an `acpx sessions close` only. It touches the file named by A60_CONNECT_MARKER at the process's
// FIRST connect to a unix socket (the queue owner's). That connect comes after the close's first read of
// the record by construction, so a test that releases the owner's held turn when the marker appears
// puts the owner's turn end between the close's read and its write — the probe's deterministic trigger
// (it used strace; this needs no tracer). Product code is untouched.
import fs from "node:fs";
import net from "node:net";

const marker = process.env.A60_CONNECT_MARKER;
if (marker) {
  // eslint-disable-next-line typescript/unbound-method -- re-applied below with the caller's `this`
  const original = net.Socket.prototype.connect as (
    this: net.Socket,
    ...args: unknown[]
  ) => net.Socket;
  let touched = false;
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    // `net.connect(path)` calls `socket.connect(normalizedArgs)`: the first argument is then `[options, cb]`.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const unixPath =
      typeof first === "string" ? first : (first as { path?: unknown } | undefined)?.path;
    if (!touched && typeof unixPath === "string") {
      touched = true;
      fs.writeFileSync(marker, new Date().toISOString());
    }
    return original.apply(this, args);
  } as typeof net.Socket.prototype.connect;
}
