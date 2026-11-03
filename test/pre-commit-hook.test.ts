import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hooks = resolve(dirname(fileURLToPath(import.meta.url)), "../../git-hooks");

for (const placement of [".git/hooks", "myhooks"]) {
  test(`agent commit bypasses planted ${placement} pre-commit and keeps attribution`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "acpx-no-repo-hook-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      ACPX_SESSION_URL: "https://atrium.example/?session=test",
    });
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    git(["init", "-q"]);
    mkdirSync(join(dir, placement), { recursive: true });
    const hook = join(dir, placement, "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nprintf executed > WITNESS\nexit 42\n");
    chmodSync(hook, 0o755);
    if (placement === "myhooks") {
      git(["config", "core.hooksPath", placement]);
    }
    assert.throws(() => git(["commit", "--allow-empty", "-m", "unguarded"]));
    assert.ok(existsSync(join(dir, "WITNESS")));
    rmSync(join(dir, "WITNESS"));
    git(["-c", `core.hooksPath=${hooks}`, "commit", "--allow-empty", "-m", "guarded"]);
    assert.equal(existsSync(join(dir, "WITNESS")), false);
    assert.match(git(["log", "-1", "--format=%B"]), /Session: https:\/\/atrium.example/);
  });
}
