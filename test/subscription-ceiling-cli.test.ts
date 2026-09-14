import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InvalidArgumentError } from "commander";
import { parseAutoWeeklyCeiling } from "../src/cli/subscriptions-command.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

async function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return await new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_STATE_HOME: homeDir,
    };
    delete env.ACPX_SUBSCRIPTION_WEEKLY_THRESHOLD;
    delete env.ACPX_SESSION_URL;
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withRegistry(
  run: (context: { homeDir: string; registryPath: string }) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-ceiling-cli-"));
  try {
    const registryPath = path.join(homeDir, ".acpx", "subscriptions", "registry.json");
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify(
        {
          version: 3,
          futureTopLevel: { keep: true },
          profiles: [
            {
              id: "alias-a",
              label: "Alias A",
              authMode: "subscription",
              adapter: "claude",
              account: "shared-account",
              credentialSource: "/cfg/a",
            },
            {
              id: "alias-b",
              label: "Alias B",
              authMode: "subscription",
              adapter: "claude",
              account: "shared-account",
              credentialSource: "/cfg/b",
            },
            {
              id: "secret-profile",
              label: "Secret",
              authMode: "openrouter",
              model: "anthropic/test",
              openRouterApiKey: "secret-never-print-or-drop",
            },
            {
              id: "collision",
              label: "Collision profile",
              authMode: "subscription",
              adapter: "claude",
              account: "profile-account",
              credentialSource: "/cfg/collision-profile",
            },
            {
              id: "account-member",
              label: "Collision account member",
              authMode: "subscription",
              adapter: "claude",
              account: "collision",
              credentialSource: "/cfg/collision-account",
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await run({ homeDir, registryPath });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("ceiling parser requires explicit percent or fraction notation", () => {
  assert.equal(parseAutoWeeklyCeiling("90%"), 0.9);
  assert.equal(parseAutoWeeklyCeiling("100.0%"), 1);
  assert.equal(parseAutoWeeklyCeiling("0.90"), 0.9);
  assert.equal(parseAutoWeeklyCeiling("1.00"), 1);
  for (const invalid of ["90", "1", "0", "0%", "101%", "1.01", "-0.5", "wat"]) {
    assert.throws(() => parseAutoWeeklyCeiling(invalid), InvalidArgumentError, invalid);
  }
});

test("CLI sets, shows, and clears account/default ceilings without exposing or losing secrets", async () => {
  await withRegistry(async ({ homeDir, registryPath }) => {
    const setAccount = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "set", "alias-b", "90%"],
      homeDir,
    );
    assert.equal(setAccount.code, 0, setAccount.stderr);
    assert.doesNotMatch(`${setAccount.stdout}${setAccount.stderr}`, /secret-never-print-or-drop/u);
    const setPayload = JSON.parse(setAccount.stdout) as Record<string, unknown>;
    assert.equal(setPayload.account, "shared-account");
    assert.equal(setPayload.effectiveWeeklyCeiling, 0.9);
    assert.equal(setPayload.effectiveWeeklyCeilingPercent, 90);
    assert.equal(setPayload.source, "account");
    assert.equal(setPayload.hard, true);

    const show = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "show", "shared-account"],
      homeDir,
    );
    assert.equal(show.code, 0, show.stderr);
    assert.doesNotMatch(`${show.stdout}${show.stderr}`, /secret-never-print-or-drop/u);
    const shown = JSON.parse(show.stdout) as {
      subscriptions?: string[];
      effectiveWeeklyCeiling?: number;
      effectiveWeeklyCeilingPercent?: number;
      reservedWeeklyPercent?: number;
      source?: string;
      hard?: boolean;
    };
    assert.deepEqual(shown.subscriptions, ["alias-a", "alias-b"]);
    assert.equal(shown.effectiveWeeklyCeiling, 0.9);
    assert.equal(shown.effectiveWeeklyCeilingPercent, 90);
    assert.equal(shown.reservedWeeklyPercent, 10);
    assert.equal(shown.source, "account");
    assert.equal(shown.hard, true);

    const beforeInvalid = await fs.readFile(registryPath, "utf8");
    const invalid = await runCli(["subscriptions", "ceiling", "set", "alias-a", "90"], homeDir);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /Use an explicit percent/u);
    assert.equal(await fs.readFile(registryPath, "utf8"), beforeInvalid);

    const setDefault = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "set-default", "1.00"],
      homeDir,
    );
    assert.equal(setDefault.code, 0, setDefault.stderr);

    const clearAccount = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "clear", "alias-a"],
      homeDir,
    );
    assert.equal(clearAccount.code, 0, clearAccount.stderr);
    const clearAccountPayload = JSON.parse(clearAccount.stdout) as Record<string, unknown>;
    assert.equal(clearAccountPayload.source, "registry-default");
    assert.equal(clearAccountPayload.hard, true);

    const clearDefault = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "clear-default"],
      homeDir,
    );
    assert.equal(clearDefault.code, 0, clearDefault.stderr);
    const clearDefaultPayload = JSON.parse(clearDefault.stdout) as Record<string, unknown>;
    assert.equal(clearDefaultPayload.source, "built-in");
    assert.equal(clearDefaultPayload.hard, false);

    const finalRaw = await fs.readFile(registryPath, "utf8");
    assert.match(finalRaw, /secret-never-print-or-drop/u);
    assert.match(finalRaw, /futureTopLevel/u);
    assert.doesNotMatch(finalRaw, /subscriptionPolicy/u);
  });
});

test("CLI refuses profile/account namespace collisions unless explicitly prefixed", async () => {
  await withRegistry(async ({ homeDir, registryPath }) => {
    const before = await fs.readFile(registryPath, "utf8");
    const ambiguous = await runCli(
      ["subscriptions", "ceiling", "set", "collision", "0.80"],
      homeDir,
    );
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.stderr, /Ambiguous ceiling subject "collision"/u);
    assert.match(ambiguous.stderr, /profile:collision/u);
    assert.match(ambiguous.stderr, /account:collision/u);
    assert.equal(await fs.readFile(registryPath, "utf8"), before);

    const profile = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "set", "profile:collision", "80%"],
      homeDir,
    );
    assert.equal(profile.code, 0, profile.stderr);
    assert.equal((JSON.parse(profile.stdout) as { account?: string }).account, "profile-account");

    const account = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "set", "account:collision", "0.85"],
      homeDir,
    );
    assert.equal(account.code, 0, account.stderr);
    assert.equal((JSON.parse(account.stdout) as { account?: string }).account, "collision");

    const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      subscriptionPolicy?: { accounts?: Record<string, { autoWeeklyCeiling?: number }> };
    };
    assert.equal(raw.subscriptionPolicy?.accounts?.["profile-account"]?.autoWeeklyCeiling, 0.8);
    assert.equal(raw.subscriptionPolicy?.accounts?.collision?.autoWeeklyCeiling, 0.85);
  });
});

test("CLI can show and clear an account policy after its last profile was removed", async () => {
  await withRegistry(async ({ homeDir, registryPath }) => {
    const raw = JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, unknown>;
    raw.subscriptionPolicy = {
      accounts: {
        orphan: { autoWeeklyCeiling: 0.8, futurePolicy: "keep" },
      },
    };
    await fs.writeFile(registryPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    const show = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "show", "account:orphan"],
      homeDir,
    );
    assert.equal(show.code, 0, show.stderr);
    const shown = JSON.parse(show.stdout) as { subscriptions?: string[]; source?: string };
    assert.deepEqual(shown.subscriptions, []);
    assert.equal(shown.source, "account");

    const clear = await runCli(
      ["--format", "json", "subscriptions", "ceiling", "clear", "account:orphan"],
      homeDir,
    );
    assert.equal(clear.code, 0, clear.stderr);
    const cleared = JSON.parse(clear.stdout) as {
      affected?: string[];
      source?: string;
      hard?: boolean;
    };
    assert.deepEqual(cleared.affected, []);
    assert.equal(cleared.source, "built-in");
    assert.equal(cleared.hard, false);

    const after = JSON.parse(await fs.readFile(registryPath, "utf8")) as {
      subscriptionPolicy?: { accounts?: Record<string, Record<string, unknown>> };
    };
    assert.deepEqual(after.subscriptionPolicy?.accounts?.orphan, { futurePolicy: "keep" });
  });
});
