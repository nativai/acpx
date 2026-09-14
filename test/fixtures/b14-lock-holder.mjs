import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2];
const marker = process.argv[3];
if (!file?.startsWith('/workspace/bricksdb-b14-selftest/') || !marker?.startsWith('/workspace/bricksdb-b14-selftest/')) process.exit(2);
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
fs.writeFileSync(marker, 'ACTED=1');
process.on('message', () => { db.exec('COMMIT'); db.close(); process.exit(0); });
