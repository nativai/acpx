// PREPARED TEST ADAPTER. A real CLI child blocks here before its first record write.
import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const marker = process.argv[2];
const release = process.argv[3];
if (!marker?.startsWith('/workspace/bricksdb-b14-selftest/') || !release?.startsWith('/workspace/bricksdb-b14-selftest/')) {
  console.error('EXAMINED NOTHING'); process.exit(2);
}
let creationRequests = 0;
process.on('exit', () => { if (creationRequests === 0) { console.error('EXAMINED NOTHING'); process.exitCode = 2; } });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async line => {
  const request = JSON.parse(line);
  if (!('id' in request)) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } }, agentInfo: { name: 'b14-fixture', version: '1' }, authMethods: [] };
  if (request.method === 'session/new' || request.method === 'session/fork') {
    creationRequests++;
    fs.writeFileSync(marker, request.method);
    while (!fs.existsSync(release)) await new Promise(resolve => setTimeout(resolve, 10));
    result = { sessionId: randomUUID() };
  }
  if (request.method === 'session/prompt') result = { stopReason: 'end_turn' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
