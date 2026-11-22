import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A bare HTTP server for the few rows that need a counterpart MISBEHAVING in a way the X1 kit's fakes do not
 * model (no response headers at all, a malformed or failing `GET /v1/agents`, a DELETE answering 503 or an odd
 * body). It is not a fake of the broker or of anything else: it answers what the row hands it, and the row says
 * why the kit does not. After brick 27b28c68 every shape a REAL service produces is in the kit (`truncate`,
 * `statusFails`, `PodSeed.containerStatuses`); what remains here are shapes no real service produces, kept to pin
 * acpx's own strictness.
 */
export type RawRequest = { method: string; url: string; body: string };

export async function rawHttp(
  handler: (request: RawRequest, response: http.ServerResponse) => void,
): Promise<{ url: string; requests: RawRequest[]; close(): void }> {
  const requests: RawRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const record = { method: req.method ?? "", url: req.url ?? "", body };
      requests.push(record);
      handler(record, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
