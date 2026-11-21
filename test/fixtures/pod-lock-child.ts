import fs from "node:fs";
import path from "node:path";
import {
  acquireIdentityFileLock,
  releaseIdentityFileLock,
} from "../../src/session/persistence/identity-file-lock.js";
import { withRecordFileLock } from "../../src/session/persistence/record-file-lock.js";

/**
 * A lock-taking process for the two-pods tests (brick 8d85cb47). Run as a pod by
 * `test/pod-kit/two-pods.ts`; speaks one JSON line on stdout.
 *
 *   hold <lock> <holdMs>                     acquire, print {held,body}, hold, release
 *   acquire <lock> <budgetMs>                acquire once: {acquired} or {timeout,message}
 *   race <lock> <markerDir> <id> <budgetMs>  acquire; inside, prove no other racer is inside
 *   record-body <recordFile>                 the REAL record lock: print the body it wrote
 *   record-acquire <recordFile>              the REAL record lock: {acquired} or {code,message}
 */

const [mode, lockPath, ...rest] = process.argv.slice(2);

function policy(budgetMs: number) {
  return {
    label: "pod-kit test lock",
    budgetMs,
    staleMs: 1_000,
    legacyBody: () => ({ pid: process.pid }),
    makeTimeoutError: (file: string, holder: string) =>
      Object.assign(new Error(`timeout on ${file}: ${holder}`), { code: "kit-timeout" }),
  };
}

async function main(): Promise<void> {
  if (mode === "hold") {
    const content = await acquireIdentityFileLock(lockPath, policy(30_000));
    process.stdout.write(`${JSON.stringify({ held: true, body: JSON.parse(content) })}\n`);
    await new Promise((resolve) => setTimeout(resolve, Number(rest[0])));
    await releaseIdentityFileLock(lockPath, content);
    return;
  }
  if (mode === "acquire") {
    try {
      const content = await acquireIdentityFileLock(lockPath, policy(Number(rest[0])));
      process.stdout.write(`${JSON.stringify({ acquired: true, body: JSON.parse(content) })}\n`);
      await releaseIdentityFileLock(lockPath, content);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ timeout: (error as { code?: string }).code === "kit-timeout", message: (error as Error).message })}\n`,
      );
    }
    return;
  }
  if (mode === "race") {
    const [markerDir, id, budget] = rest;
    const content = await acquireIdentityFileLock(lockPath, policy(Number(budget)));
    const mine = path.join(markerDir, `inside.${id}`);
    const others = fs.readdirSync(markerDir).filter((name) => name.startsWith("inside."));
    fs.writeFileSync(mine, "");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const othersAfter = fs
      .readdirSync(markerDir)
      .filter((n) => n.startsWith("inside.") && n !== `inside.${id}`);
    fs.unlinkSync(mine);
    await releaseIdentityFileLock(lockPath, content);
    process.stdout.write(
      `${JSON.stringify({ id, overlap: others.length + othersAfter.length })}\n`,
    );
    return;
  }
  if (mode === "record-body") {
    const record = lockPath;
    await withRecordFileLock(record, async () => {
      process.stdout.write(
        `${JSON.stringify({ raw: fs.readFileSync(`${record}.lock`, "utf8") })}\n`,
      );
    });
    return;
  }
  if (mode === "record-acquire") {
    try {
      await withRecordFileLock(lockPath, async () => {});
      process.stdout.write(`${JSON.stringify({ acquired: true })}\n`);
    } catch (error) {
      const { code, message } = error as { code?: string; message: string };
      process.stdout.write(`${JSON.stringify({ code, message })}\n`);
    }
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

await main();
