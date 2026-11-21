import http from "node:http";
import type { AddressInfo } from "node:net";

// A minimal scripted broker (C4) for A6's tests. Replaced by X1's `test/pod-kit` fake broker once it
// lands on agent-pods.

export type Script = {
  status?: number;
  /** Lines sent with `delayMs` between them; `stall` keeps the connection open after them. */
  lines?: string[];
  delayMs?: number;
  stall?: boolean;
  noHeaders?: boolean;
  json?: unknown;
  /** The answer to `GET /v1/agents` when the same broker is also asked for it. */
  agents?: unknown;
  /** The answer to `DELETE /v1/agents/<key>?uid=…`. */
  del?: { status?: number; body?: string };
};

export type Seen = { method?: string; url?: string; body: string; closedEarly: boolean }[];

export async function startBroker(
  script: Script,
): Promise<{ origin: string; seen: Seen; close(): void }> {
  const seen: Seen = [];
  const server = http.createServer((req, res) => {
    const record = { method: req.method, url: req.url, body: "", closedEarly: false };
    seen.push(record);
    req.on("data", (chunk: Buffer) => {
      record.body += chunk.toString("utf8");
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        record.closedEarly = true;
      }
    });
    req.on("end", () => {
      if (req.method === "DELETE" && script.del !== undefined) {
        res.writeHead(script.del.status ?? 200, { "content-type": "text/plain" });
        res.end(script.del.body ?? "");
        return;
      }
      if (req.method === "GET" && script.agents !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(script.agents));
        return;
      }
      if (script.noHeaders) {
        return;
      }
      if (script.json !== undefined) {
        res.writeHead(script.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(script.json));
        return;
      }
      res.writeHead(script.status ?? 200, { "content-type": "text/plain" });
      res.flushHeaders();
      const lines = [...(script.lines ?? [])];
      const send = () => {
        const line = lines.shift();
        if (line === undefined) {
          if (!script.stall) {
            res.end();
          }
          return;
        }
        res.write(`${line}\n`);
        setTimeout(send, script.delayMs ?? 0);
      };
      send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
