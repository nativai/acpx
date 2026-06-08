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
  markSubscriptionDead,
  resetKnownDeadSubs,
} from "../src/config/known-dead-subscriptions.js";
import type { SubscriptionLookupOptions } from "../src/config/subscriptions.js";
import {
  buildTerminalShellSpawnCommand,
  buildTerminalSpawnCommand,
} from "../src/spawn-command-options.js";
import { withCapturedStderrWrites } from "./tty-test-helpers.js";

test("buildAgentSpawnOptions hides Windows console windows and preserves auth env", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", {
    ACPX_AUTH_TOKEN: "secret-token",
  });

  assert.equal(options.cwd, "/tmp/acpx-agent");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.ACPX_AUTH_TOKEN, "secret-token");
});

test("buildAgentSpawnOptions never injects ACPX_SESSION_ID (URL-only identity contract)", () => {
  const previous = process.env.ACPX_SESSION_ID;
  delete process.env.ACPX_SESSION_ID;
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "11111111-2222-3333-4444-555555555555",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_ID"), false);
    assert.equal(
      options.env.ACPX_SESSION_URL,
      "https://acpx.devbox.nativai.de/?session=11111111-2222-3333-4444-555555555555",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_SESSION_ID;
    } else {
      process.env.ACPX_SESSION_ID = previous;
    }
  }
});

test("buildAgentSpawnOptions never injects ACPX_PARENT_SESSION_ID (URL-only identity contract)", () => {
  const previous = process.env.ACPX_PARENT_SESSION_ID;
  delete process.env.ACPX_PARENT_SESSION_ID;
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id-abc",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_ID"),
      false,
    );
    assert.equal(
      options.env.ACPX_PARENT_SESSION_URL,
      "https://acpx.devbox.nativai.de/?session=parent-id-abc",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_PARENT_SESSION_ID;
    } else {
      process.env.ACPX_PARENT_SESSION_ID = previous;
    }
  }
});

test("buildAgentSpawnOptions trims whitespace around parentSessionId into ACPX_PARENT_SESSION_URL", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    parentSessionId: "  parent-id-xyz  ",
  });
  assert.equal(
    options.env.ACPX_PARENT_SESSION_URL,
    "https://acpx.devbox.nativai.de/?session=parent-id-xyz",
  );
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
  const previousUrl = process.env.ACPX_SESSION_URL;
  delete process.env.ACPX_SESSION_URL;
  try {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "   ",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_URL"), false);
  } finally {
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
  const previousParentUrl = process.env.ACPX_PARENT_SESSION_URL;
  delete process.env.ACPX_PARENT_SESSION_URL;
  try {
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
  } finally {
    if (previousParentUrl === undefined) {
      delete process.env.ACPX_PARENT_SESSION_URL;
    } else {
      process.env.ACPX_PARENT_SESSION_URL = previousParentUrl;
    }
  }
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

test("buildAgentSpawnOptions: URL is the only identity surface — no _ID vars emitted", () => {
  const previousSessionId = process.env.ACPX_SESSION_ID;
  const previousParentId = process.env.ACPX_PARENT_SESSION_ID;
  delete process.env.ACPX_SESSION_ID;
  delete process.env.ACPX_PARENT_SESSION_ID;
  try {
    withAcpxUiBaseUrlEnv(undefined, () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
        parentSessionId: "parent-id",
      });
      assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_ID"), false);
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_ID"),
        false,
      );
      assert.equal(
        options.env.ACPX_SESSION_URL,
        "https://acpx.devbox.nativai.de/?session=child-id",
      );
      assert.equal(
        options.env.ACPX_PARENT_SESSION_URL,
        "https://acpx.devbox.nativai.de/?session=parent-id",
      );
    });
  } finally {
    if (previousSessionId === undefined) {
      delete process.env.ACPX_SESSION_ID;
    } else {
      process.env.ACPX_SESSION_ID = previousSessionId;
    }
    if (previousParentId === undefined) {
      delete process.env.ACPX_PARENT_SESSION_ID;
    } else {
      process.env.ACPX_PARENT_SESSION_ID = previousParentId;
    }
  }
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

test("buildAgentSpawnOptions: ACPX_TASK_FOLDER coexists with URL session + parent vars (no _ID vars)", () => {
  const previousSessionId = process.env.ACPX_SESSION_ID;
  const previousParentId = process.env.ACPX_PARENT_SESSION_ID;
  delete process.env.ACPX_SESSION_ID;
  delete process.env.ACPX_PARENT_SESSION_ID;
  try {
    withAcpxUiBaseUrlEnv(undefined, () => {
      const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
        acpxRecordId: "child-id",
        parentSessionId: "parent-id",
        taskFolder: "/task/abs",
      });
      assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SESSION_ID"), false);
      assert.equal(
        Object.prototype.hasOwnProperty.call(options.env, "ACPX_PARENT_SESSION_ID"),
        false,
      );
      assert.equal(
        options.env.ACPX_SESSION_URL,
        "https://acpx.devbox.nativai.de/?session=child-id",
      );
      assert.equal(
        options.env.ACPX_PARENT_SESSION_URL,
        "https://acpx.devbox.nativai.de/?session=parent-id",
      );
      assert.equal(options.env.ACPX_TASK_FOLDER, "/task/abs");
    });
  } finally {
    if (previousSessionId === undefined) {
      delete process.env.ACPX_SESSION_ID;
    } else {
      process.env.ACPX_SESSION_ID = previousSessionId;
    }
    if (previousParentId === undefined) {
      delete process.env.ACPX_PARENT_SESSION_ID;
    } else {
      process.env.ACPX_PARENT_SESSION_ID = previousParentId;
    }
  }
});

test("buildAgentSpawnOptions injects ACPX_AGENT_FOLDER when sessionContext.agentFolder is non-empty", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    agentFolder: "/abs/task/agents/child-12345678",
  });
  assert.equal(options.env.ACPX_AGENT_FOLDER, "/abs/task/agents/child-12345678");
});

test("buildAgentSpawnOptions trims whitespace around agentFolder before injecting ACPX_AGENT_FOLDER", () => {
  const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
    acpxRecordId: "child-id",
    agentFolder: "   /abs/task/agents/child  ",
  });
  assert.equal(options.env.ACPX_AGENT_FOLDER, "/abs/task/agents/child");
});

test("buildAgentSpawnOptions omits ACPX_AGENT_FOLDER when agentFolder is null/undefined/empty/whitespace", () => {
  const previous = process.env.ACPX_AGENT_FOLDER;
  delete process.env.ACPX_AGENT_FOLDER;
  try {
    const undefinedCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(undefinedCase.env, "ACPX_AGENT_FOLDER"),
      false,
    );

    const nullCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      agentFolder: null,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(nullCase.env, "ACPX_AGENT_FOLDER"), false);

    const emptyCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      agentFolder: "",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(emptyCase.env, "ACPX_AGENT_FOLDER"), false);

    const whitespaceCase = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      agentFolder: "   ",
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(whitespaceCase.env, "ACPX_AGENT_FOLDER"),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_AGENT_FOLDER;
    } else {
      process.env.ACPX_AGENT_FOLDER = previous;
    }
  }
});

test("buildAgentSpawnOptions: ACPX_AGENT_FOLDER coexists with task folder + URL session vars", () => {
  withAcpxUiBaseUrlEnv(undefined, () => {
    const options = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "child-id",
      parentSessionId: "parent-id",
      taskFolder: "/task/abs",
      agentFolder: "/task/abs/agents/child-id",
    });
    assert.equal(options.env.ACPX_TASK_FOLDER, "/task/abs");
    assert.equal(options.env.ACPX_AGENT_FOLDER, "/task/abs/agents/child-id");
    assert.equal(options.env.ACPX_SESSION_URL, "https://acpx.devbox.nativai.de/?session=child-id");
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

// --- CLAUDE_CONFIG_DIR resolution (registry `default` governs unselected sessions) ---
// Hermetic: every case injects a temp registry + real temp configDirs via the
// 4th `lookupOptions` arg, so NONE of these read this box's real ~/.acpx (which
// has default=sub2). Ambient Claude subscription env is scrubbed so ABSENT
// assertions are meaningful regardless of how the test runner was launched.

type SubsHomeContext = {
  lookupOptions: SubscriptionLookupOptions;
  configDir: (id: string) => string;
};

async function withSubscriptionsHome(
  setup: { registry?: unknown; existingDirs?: string[] },
  run: (ctx: SubsHomeContext) => Promise<void>,
): Promise<void> {
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousAcpxSubscription = process.env.ACPX_SUBSCRIPTION;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ACPX_SUBSCRIPTION;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-spawn-subs-"));
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(subsDir, { recursive: true });
    const registryPath = path.join(subsDir, "registry.json");
    if (setup.registry !== undefined) {
      await fs.writeFile(registryPath, JSON.stringify(setup.registry));
    }
    for (const id of setup.existingDirs ?? []) {
      await fs.mkdir(path.join(subsDir, id), { recursive: true });
    }
    await run({
      lookupOptions: { homeDir, registryPath },
      configDir: (id) => path.join(subsDir, id),
    });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    if (previousAcpxSubscription === undefined) {
      delete process.env.ACPX_SUBSCRIPTION;
    } else {
      process.env.ACPX_SUBSCRIPTION = previousAcpxSubscription;
    }
  }
}

function hasClaudeConfigDir(env: NodeJS.ProcessEnv): boolean {
  return Object.prototype.hasOwnProperty.call(env, "CLAUDE_CONFIG_DIR");
}

const TWO_SUB_REGISTRY = {
  default: "sub2",
  subscriptions: [
    { id: "sub1", label: "One" },
    { id: "sub2", label: "Two" },
  ],
};

test("buildAgentSpawnOptions (N1) explicit valid subscription → CLAUDE_CONFIG_DIR is that configDir", async () => {
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "sub1" },
        ctx.lookupOptions,
      );
      assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub1"));
    },
  );
});

test("buildAgentSpawnOptions (N2) unselected + usable default → CLAUDE_CONFIG_DIR is the default's configDir", async () => {
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec" }, // no subscriptionId
          ctx.lookupOptions,
        );
        assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub2"));
        assert.equal(
          writes.join(""),
          `[acpx] no subscription selected; using registry default "sub2" (CLAUDE_CONFIG_DIR=${ctx.configDir(
            "sub2",
          )})\n`,
        );
      });
    },
  );
});

test("buildAgentSpawnOptions (N3) unselected + default whose dir is MISSING → CLAUDE_CONFIG_DIR ABSENT and silent", async () => {
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1"] }, // sub2 (the default) dir not created
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec" },
          ctx.lookupOptions,
        );
        assert.equal(hasClaudeConfigDir(options.env), false);
        assert.deepEqual(writes, []); // defaultUnusable is intentionally silent
      });
    },
  );
});

test("buildAgentSpawnOptions (N4) explicit unknown + usable default → default dir; legacy not-found line + default note", async () => {
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec", subscriptionId: "ghost" },
          ctx.lookupOptions,
        );
        assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub2"));
        assert.ok(
          writes.includes(
            `[acpx] subscription "ghost" not found in registry; using default Claude config (no CLAUDE_CONFIG_DIR override)\n`,
          ),
          "legacy not-found line must be emitted verbatim",
        );
        assert.ok(
          writes.includes(
            `[acpx] using registry default "sub2" instead (CLAUDE_CONFIG_DIR=${ctx.configDir("sub2")})\n`,
          ),
          "default-applied (via rejection) note must be emitted",
        );
      });
    },
  );
});

test("buildAgentSpawnOptions (G1) no registry + unselected → CLAUDE_CONFIG_DIR ABSENT and ZERO subscription stderr", async () => {
  await withSubscriptionsHome({ registry: undefined }, async (ctx) => {
    await withCapturedStderrWrites(async (writes) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec" },
        ctx.lookupOptions,
      );
      assert.equal(hasClaudeConfigDir(options.env), false);
      assert.deepEqual(writes, []);
    });
  });
});

test("buildAgentSpawnOptions (G2) no registry + explicit unknown → exact legacy line + ABSENT", async () => {
  await withSubscriptionsHome({ registry: undefined }, async (ctx) => {
    await withCapturedStderrWrites(async (writes) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "ghost" },
        ctx.lookupOptions,
      );
      assert.equal(hasClaudeConfigDir(options.env), false);
      assert.deepEqual(writes, [
        `[acpx] subscription "ghost" not found in registry; using default Claude config (no CLAUDE_CONFIG_DIR override)\n`,
      ]);
    });
  });
});

test("buildAgentSpawnOptions (G3) registry present but default ABSENT + unselected → ABSENT and silent", async () => {
  await withSubscriptionsHome(
    { registry: { subscriptions: [{ id: "sub1", label: "One" }] }, existingDirs: ["sub1"] },
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec" },
          ctx.lookupOptions,
        );
        assert.equal(hasClaudeConfigDir(options.env), false);
        assert.deepEqual(writes, []);
      });
    },
  );
});

test("buildAgentSpawnOptions (G4) explicit id with MISSING dir, no default → exact legacy missing-dir line + ABSENT", async () => {
  await withSubscriptionsHome(
    { registry: { subscriptions: [{ id: "sub1", label: "One" }] }, existingDirs: [] }, // sub1 dir not created, no default
    async (ctx) => {
      await withCapturedStderrWrites(async (writes) => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec", subscriptionId: "sub1" },
          ctx.lookupOptions,
        );
        assert.equal(hasClaudeConfigDir(options.env), false);
        assert.deepEqual(writes, [
          `[acpx] subscription "sub1" configDir not found at ${ctx.configDir("sub1")}; using default Claude config (no CLAUDE_CONFIG_DIR override)\n`,
        ]);
      });
    },
  );
});

// --- ACPX_SUBSCRIPTION env export (E.2) ---

test("buildAgentSpawnOptions (S1) explicit sub → ACPX_SUBSCRIPTION = that id", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "sub1" },
        ctx.lookupOptions,
      );
      assert.equal(options.env.ACPX_SUBSCRIPTION, "sub1");
    },
  );
});

test("buildAgentSpawnOptions (S2) unselected + default → ACPX_SUBSCRIPTION = the resolved default id", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      await withCapturedStderrWrites(async () => {
        const options = buildAgentSpawnOptions(
          "/tmp/acpx-agent",
          undefined,
          { acpxRecordId: "rec" },
          ctx.lookupOptions,
        );
        assert.equal(options.env.ACPX_SUBSCRIPTION, "sub2");
      });
    },
  );
});

test("buildAgentSpawnOptions (S3) no registry → ACPX_SUBSCRIPTION ABSENT (backward safety)", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome({ registry: undefined }, async (ctx) => {
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-agent",
      undefined,
      { acpxRecordId: "rec" },
      ctx.lookupOptions,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(options.env, "ACPX_SUBSCRIPTION"), false);
  });
});

// --- Pre-spawn known-dead avoidance (§4.1.4) ---

test("buildAgentSpawnOptions (K1) resolved sub known-dead → substitutes a healthy sub", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      markSubscriptionDead("sub1");
      try {
        await withCapturedStderrWrites(async () => {
          const options = buildAgentSpawnOptions(
            "/tmp/acpx-agent",
            undefined,
            { acpxRecordId: "rec", subscriptionId: "sub1" }, // explicitly pinned to the dead sub
            ctx.lookupOptions,
          );
          // Substituted to the healthy sub2.
          assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub2"));
          assert.equal(options.env.ACPX_SUBSCRIPTION, "sub2");
        });
      } finally {
        resetKnownDeadSubs();
      }
    },
  );
});

test("buildAgentSpawnOptions (K2) known-dead set empty → no substitution (identical to today)", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: TWO_SUB_REGISTRY, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "sub1" },
        ctx.lookupOptions,
      );
      assert.equal(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub1"));
    },
  );
});
