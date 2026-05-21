import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeCodeExecutable } from "../src/acp/agent-command.js";
import { resolveAgentSessionCwd } from "../src/acp/client-process.js";
import { buildAgentSpawnOptions, buildSpawnCommandOptions } from "../src/acp/client.js";
import { buildTerminalSpawnOptions } from "../src/acp/terminal-manager.js";
import { buildQueueOwnerSpawnOptions } from "../src/cli/session/queue-owner-process.js";
import {
  buildTerminalShellSpawnCommand,
  buildTerminalSpawnCommand,
} from "../src/spawn-command-options.js";

test("buildAgentSpawnOptions hides Windows console windows and preserves auth env", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", {
    ACPX_AUTH_TOKEN: "secret-token",
  });

  assert.equal(options.cwd, "/tmp/acpx-agent");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ACPX_AUTH_TOKEN, "secret-token");
});

test("buildAgentSpawnOptions injects ACPX_SESSION_ID when sessionContext.acpxRecordId is set", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "11111111-2222-3333-4444-555555555555",
  });
  assert.equal(options.env.ACPX_SESSION_ID, "11111111-2222-3333-4444-555555555555");
  assert.equal(options.env.ACPX_PARENT_SESSION_ID, undefined);
});

test("buildAgentSpawnOptions injects ACPX_PARENT_SESSION_ID when parentSessionId is non-empty", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    parentSessionId: "parent-id-abc",
  });
  assert.equal(options.env.ACPX_SESSION_ID, "child-id");
  assert.equal(options.env.ACPX_PARENT_SESSION_ID, "parent-id-abc");
});

test("buildAgentSpawnOptions omits ACPX_PARENT_SESSION_ID when parentSessionId is null", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    parentSessionId: null,
  });
  assert.equal(options.env.ACPX_SESSION_ID, "child-id");
  assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_ID"), false);
});

test("buildAgentSpawnOptions omits ACPX_PARENT_SESSION_ID when parentSessionId is empty string", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    parentSessionId: "   ",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_ID"), false);
});

test("buildAgentSpawnOptions trims whitespace around parentSessionId", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    parentSessionId: "  parent-id-xyz  ",
  });
  assert.equal(options.env.ACPX_PARENT_SESSION_ID, "parent-id-xyz");
});

function withAcpxUiBaseUrlEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.ACPX_UI_BASE_URL;
  if (value === undefined) {
    delete process.env.ACPX_UI_BASE_URL;
  } else {
    process.env.ACPX_UI_BASE_URL = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_UI_BASE_URL;
    } else {
      process.env.ACPX_UI_BASE_URL = previous;
    }
  }
}

test("buildAgentSpawnOptions injects ACPX_SESSION_URL with default base URL when acpxRecordId is set", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "11111111-2222-3333-4444-555555555555",
    });
    assert.equal(
      options.env.ACPX_SESSION_URL,
      "https://acpx.devbox.nativai.de/?session=11111111-2222-3333-4444-555555555555",
    );
  });
});

test("buildAgentSpawnOptions omits ACPX_SESSION_URL when acpxRecordId is empty/whitespace", () => {
  const previousId = process.env.ACPX_SESSION_ID;
  const previousUrl = process.env.ACPX_SESSION_URL;
  delete process.env.ACPX_SESSION_ID;
  delete process.env.ACPX_SESSION_URL;
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "   ",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_URL"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_ID"), false);
  } finally {
    if (previousId === undefined) {
      delete process.env.ACPX_SESSION_ID;
    } else {
      process.env.ACPX_SESSION_ID = previousId;
    }
    if (previousUrl === undefined) {
      delete process.env.ACPX_SESSION_URL;
    } else {
      process.env.ACPX_SESSION_URL = previousUrl;
    }
  }
});

test("buildAgentSpawnOptions injects ACPX_PARENT_SESSION_URL when parentSessionId is non-empty", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id-abc",
    });
    assert.equal(
      options.env.ACPX_PARENT_SESSION_URL,
      "https://acpx.devbox.nativai.de/?session=parent-id-abc",
    );
  });
});

test("buildAgentSpawnOptions omits ACPX_PARENT_SESSION_URL when parentSessionId is null/undefined/whitespace", () => {
  const nullCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    parentSessionId: null,
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(nullCase.env, "ACPX_PARENT_SESSION_URL"),
    false,
  );

  const undefinedCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(undefinedCase.env, "ACPX_PARENT_SESSION_URL"),
    false,
  );

  const whitespaceCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    parentSessionId: "   ",
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(whitespaceCase.env, "ACPX_PARENT_SESSION_URL"),
    false,
  );
});

test("buildAgentSpawnOptions honors ACPX_UI_BASE_URL override for both URL vars", () => {
  withAcpxUiBaseUrlEnv("http://localhost:3456", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id",
    });
    assert.equal(options.env.ACPX_SESSION_URL, "http://localhost:3456/?session=child-id");
    assert.equal(options.env.ACPX_PARENT_SESSION_URL, "http://localhost:3456/?session=parent-id");
  });
});

test("buildAgentSpawnOptions normalizes a trailing slash on ACPX_UI_BASE_URL", () => {
  withAcpxUiBaseUrlEnv("https://x.example.com/", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(options.env.ACPX_SESSION_URL, "https://x.example.com/?session=child-id");
  });
});

test("buildAgentSpawnOptions falls through to default when ACPX_UI_BASE_URL is empty/whitespace", () => {
  withAcpxUiBaseUrlEnv("   ", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(options.env.ACPX_SESSION_URL, "https://acpx.devbox.nativai.de/?session=child-id");
  });

  withAcpxUiBaseUrlEnv("", () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(options.env.ACPX_SESSION_URL, "https://acpx.devbox.nativai.de/?session=child-id");
  });
});

test("buildAgentSpawnOptions reflects trimmed UUIDs in URL vars", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "  child-id  ",
      parentSessionId: "  parent-id-xyz  ",
    });
    assert.equal(options.env.ACPX_SESSION_URL, "https://acpx.devbox.nativai.de/?session=child-id");
    assert.equal(
      options.env.ACPX_PARENT_SESSION_URL,
      "https://acpx.devbox.nativai.de/?session=parent-id-xyz",
    );
  });
});

test("buildAgentSpawnOptions keeps the additive contract: bare ID vars still injected alongside URL vars", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id",
    });
    assert.equal(options.env.ACPX_SESSION_ID, "child-id");
    assert.equal(options.env.ACPX_PARENT_SESSION_ID, "parent-id");
    assert.equal(options.env.ACPX_SESSION_URL, "https://acpx.devbox.nativai.de/?session=child-id");
    assert.equal(
      options.env.ACPX_PARENT_SESSION_URL,
      "https://acpx.devbox.nativai.de/?session=parent-id",
    );
  });
});

test("buildAgentSpawnOptions injects ACPX_TASK_FOLDER when sessionContext.taskFolder is non-empty", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    taskFolder: "/abs/path/to/task",
  });
  assert.equal(options.env.ACPX_TASK_FOLDER, "/abs/path/to/task");
});

test("buildAgentSpawnOptions trims whitespace around taskFolder before injecting ACPX_TASK_FOLDER", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    taskFolder: "   /abs/path  ",
  });
  assert.equal(options.env.ACPX_TASK_FOLDER, "/abs/path");
});

test("buildAgentSpawnOptions omits ACPX_TASK_FOLDER when taskFolder is null/undefined/empty/whitespace", () => {
  const previous = process.env.ACPX_TASK_FOLDER;
  delete process.env.ACPX_TASK_FOLDER;
  try {
    const undefinedCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(undefinedCase.env, "ACPX_TASK_FOLDER"),
      false,
    );

    const nullCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      taskFolder: null,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(nullCase.env, "ACPX_TASK_FOLDER"), false);

    const emptyCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      taskFolder: "",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(emptyCase.env, "ACPX_TASK_FOLDER"), false);

    const whitespaceCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      taskFolder: "   ",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(whitespaceCase.env, "ACPX_TASK_FOLDER"),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_TASK_FOLDER;
    } else {
      process.env.ACPX_TASK_FOLDER = previous;
    }
  }
});

test("buildAgentSpawnOptions keeps the additive contract: ACPX_TASK_FOLDER coexists with session + parent vars", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id",
      taskFolder: "/task/abs",
    });
    assert.equal(options.env.ACPX_SESSION_ID, "child-id");
    assert.equal(options.env.ACPX_PARENT_SESSION_ID, "parent-id");
    assert.equal(options.env.ACPX_SESSION_URL, "https://acpx.devbox.nativai.de/?session=child-id");
    assert.equal(
      options.env.ACPX_PARENT_SESSION_URL,
      "https://acpx.devbox.nativai.de/?session=parent-id",
    );
    assert.equal(options.env.ACPX_TASK_FOLDER, "/task/abs");
  });
});

test("buildAgentSpawnOptions promotes explicit ACPX auth env vars into agent auth env", () => {
  const previousPrefixed = process.env.ACPX_AUTH_OPENAI_API_KEY;
  const previousNormalized = process.env.OPENAI_API_KEY;

  process.env.ACPX_AUTH_OPENAI_API_KEY = "sk-explicit";
  delete process.env.OPENAI_API_KEY;

  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined);
    assert.equal(options.env.ACPX_AUTH_OPENAI_API_KEY, "sk-explicit");
    assert.equal(options.env.OPENAI_API_KEY, "sk-explicit");
  } finally {
    if (previousPrefixed == null) {
      delete process.env.ACPX_AUTH_OPENAI_API_KEY;
    } else {
      process.env.ACPX_AUTH_OPENAI_API_KEY = previousPrefixed;
    }

    if (previousNormalized == null) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousNormalized;
    }
  }
});

test("buildTerminalSpawnOptions hides Windows console windows and maps env entries", () => {
  const options = buildTerminalSpawnOptions("node", "/tmp/acpx-terminal", [
    { name: "TMUX", value: "/tmp/tmux-1000/default,123,0" },
    { name: "TERM", value: "screen-256color" },
  ]);

  assert.equal(options.cwd, "/tmp/acpx-terminal");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env?.TMUX, "/tmp/tmux-1000/default,123,0");
  assert.equal(options.env?.TERM, "screen-256color");
});

test("buildQueueOwnerSpawnOptions hides Windows console windows and passes payload", () => {
  const options = buildQueueOwnerSpawnOptions('{"sessionId":"queue-session"}');

  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ACPX_QUEUE_OWNER_PAYLOAD, '{"sessionId":"queue-session"}');
});

test("buildSpawnCommandOptions enables shell for .cmd/.bat on Windows", () => {
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  const cmdOptions = buildSpawnCommandOptions("C:\\Program Files\\nodejs\\npx.cmd", base, "win32");
  const batOptions = buildSpawnCommandOptions("C:\\tools\\agent.bat", base, "win32");

  assert.equal(cmdOptions.shell, true);
  assert.equal(batOptions.shell, true);
  assert.deepEqual(cmdOptions.stdio, base.stdio);
  assert.equal(cmdOptions.windowsHide, true);
});

test("buildSpawnCommandOptions enables shell for PATH-resolved .cmd wrappers on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));
  const env = {
    PATH: tempDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  try {
    await fs.writeFile(path.join(tempDir, "npx.cmd"), "@echo off\r\n");

    const options = buildSpawnCommandOptions("npx", base, "win32", env);
    assert.equal(options.shell, true);
    assert.deepEqual(options.stdio, base.stdio);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildSpawnCommandOptions keeps shell disabled for non-batch commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));
  const env = {
    PATH: tempDir,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };
  const base = {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };

  try {
    await fs.writeFile(path.join(tempDir, "node.exe"), "");

    const linuxOptions = buildSpawnCommandOptions("/usr/bin/npx", base, "linux");
    const windowsExeOptions = buildSpawnCommandOptions("node", base, "win32", env);

    assert.equal(linuxOptions.shell, undefined);
    assert.equal(windowsExeOptions.shell, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTerminalSpawnCommand preserves explicit argv", () => {
  assert.deepEqual(buildTerminalSpawnCommand("node", ["-e", "console.log('ok')"]), {
    command: "node",
    args: ["-e", "console.log('ok')"],
    killProcessGroup: false,
  });
  assert.deepEqual(buildTerminalSpawnCommand("/tmp/tool with space", []), {
    command: "/tmp/tool with space",
    args: [],
    killProcessGroup: false,
  });
  assert.deepEqual(buildTerminalSpawnCommand("/tmp/tool with space", undefined), {
    command: "/tmp/tool with space",
    args: [],
    killProcessGroup: false,
  });
});

test("buildTerminalShellSpawnCommand routes command lines through the shell", () => {
  assert.deepEqual(buildTerminalShellSpawnCommand("echo hello | tr a-z A-Z", "darwin"), {
    command: "/bin/sh",
    args: ["-c", "echo hello | tr a-z A-Z"],
    killProcessGroup: true,
  });
  assert.deepEqual(buildTerminalShellSpawnCommand("dir C:\\Users", "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "dir C:\\Users"],
    killProcessGroup: true,
  });
});

test("resolveAgentSessionCwd translates WSL cwd for Windows exe agents", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(
    inputCwd,
    '"/mnt/c/Users/User/AppData/Local/GitHub CLI/copilot/copilot.exe" --acp --stdio',
    {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async (value) => {
        capturedCwd = value;
        return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
      },
    },
  );

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd leaves non-WSL and non-Windows agents on resolved cwd", async () => {
  const nonWsl = await resolveAgentSessionCwd("relative/project", "/mnt/c/tools/copilot.exe", {
    platform: "linux",
    existsSync: () => false,
    runWslpath: async () => {
      throw new Error("wslpath should not run");
    },
  });
  const inputCwd = "/home/user/project";
  const wslNodeAgent = await resolveAgentSessionCwd(inputCwd, "node ./agent.js", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async () => {
      throw new Error("wslpath should not run");
    },
  });

  assert.equal(nonWsl, path.resolve("relative/project"));
  assert.equal(wslNodeAgent, path.resolve(inputCwd));
});

test("resolveAgentSessionCwd translates WSL cwd for Windows .cmd wrappers", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(
    inputCwd,
    '"/mnt/c/Program Files/nodejs/npx.cmd" some-acp-agent --stdio',
    {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async (value) => {
        capturedCwd = value;
        return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
      },
    },
  );

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd translates WSL cwd for Windows agents on non-C drives", async () => {
  let capturedCwd: string | undefined;
  const inputCwd = "/home/user/project";
  const resolvedCwd = path.resolve(inputCwd);

  const cwd = await resolveAgentSessionCwd(inputCwd, "/mnt/d/tools/agent.bat --acp", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async (value) => {
      capturedCwd = value;
      return "\\\\wsl.localhost\\Ubuntu\\home\\user\\project\n";
    },
  });

  assert.equal(capturedCwd, resolvedCwd);
  assert.equal(cwd, "\\\\wsl.localhost\\Ubuntu\\home\\user\\project");
});

test("resolveAgentSessionCwd does not translate WSL cwd for extension-less commands under /mnt/<drive>/", async () => {
  const inputCwd = "/home/user/project";
  const cwd = await resolveAgentSessionCwd(inputCwd, "/mnt/c/tools/linux-agent --acp", {
    platform: "linux",
    existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
    runWslpath: async () => {
      throw new Error("wslpath should not run for extension-less /mnt/<drive>/ commands");
    },
  });

  assert.equal(cwd, path.resolve(inputCwd));
});

test("resolveAgentSessionCwd rejects empty wslpath output", async () => {
  await assert.rejects(
    resolveAgentSessionCwd("/home/user/project", "/mnt/c/tools/copilot.exe --acp", {
      platform: "linux",
      existsSync: (filePath) => filePath === "/proc/sys/fs/binfmt_misc/WSLInterop",
      runWslpath: async () => "\n",
    }),
    /wslpath returned an empty Windows path/,
  );
});

test("buildTerminalSpawnOptions enables shell for PATH-resolved .cmd wrappers on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));

  try {
    await fs.writeFile(path.join(tempDir, "npx.cmd"), "@echo off\r\n");

    const options = buildTerminalSpawnOptions(
      "npx",
      "/tmp/acpx-terminal",
      [
        { name: "PATH", value: tempDir },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
      ],
      "win32",
    );

    assert.equal(options.shell, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildTerminalSpawnOptions keeps shell disabled for non-batch commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-windows-spawn-"));

  try {
    await fs.writeFile(path.join(tempDir, "node.exe"), "");

    const options = buildTerminalSpawnOptions(
      "node",
      "/tmp/acpx-terminal",
      [
        { name: "PATH", value: tempDir },
        { name: "PATHEXT", value: ".COM;.EXE;.BAT;.CMD" },
      ],
      "win32",
    );

    assert.equal(options.shell, undefined);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable finds claude.exe on PATH on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = { PATH: tempDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, path.join(tempDir, "claude.exe"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable returns undefined when CLAUDE_CODE_EXECUTABLE is already set", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      CLAUDE_CODE_EXECUTABLE: "/custom/claude",
    } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable respects case-insensitive env var on Windows", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-claude-exe-"));
  try {
    await fs.writeFile(path.join(tempDir, "claude.exe"), "");
    const env = {
      PATH: tempDir,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      claude_code_executable: "/custom/claude",
    } as NodeJS.ProcessEnv;
    const result = resolveClaudeCodeExecutable("win32", env);
    assert.equal(result, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutable returns undefined on non-Windows platforms", () => {
  const result = resolveClaudeCodeExecutable("linux", { PATH: "/usr/bin" } as NodeJS.ProcessEnv);
  assert.equal(result, undefined);
});

test("resolveClaudeCodeExecutable returns undefined when claude is not on PATH", () => {
  const env = { PATH: "/nonexistent", PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv;
  const result = resolveClaudeCodeExecutable("win32", env);
  assert.equal(result, undefined);
});
