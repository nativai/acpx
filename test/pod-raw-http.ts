import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A bare HTTP server for the few rows that need a counterpart the X1 kit's fakes do not model. It is not a fake of
 * the broker or of anything else: it answers what the row hands it, and the row says why the kit does not.
 *
 * Two kinds of row use it, and they are NOT the same:
 *   - shapes that are REAL but that the kit has no knob for — a `GET /v1/agents` that never answers (the real
 *     broker makes up to three sequential kube calls of 10 s each, against acpx's 20 s wake bound, so a slow kube
 *     API produces it), and a broker that sends no response headers (a wedged or frozen broker does; by process
 *     failure, not by protocol). A kit knob (`statusDelayMs`, a "freeze") would move them.
 *   - shapes no real service produces — a malformed `GET /v1/agents` 200, a DELETE answering 503 or a non-C4 body,
 *     a pod list that is not a list — kept to pin acpx's own strictness.
 * (Every other real shape is in the kit: `truncate`, `statusFails`, `PodSeed.containerStatuses`; brick 27b28c68.)
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
