// brick ad6ba1c2 — REAL `_claude/backgroundTasks` payloads, copied verbatim from
// /wisdom/Bricks/ad6ba1c2-1807-4a75-a048-81c4a49a0ec1/conception/fixtures/s1-claude-backgroundTasks.ndjson
// (session 31976ceb, claude-agent-acp 93b3bbcf / Claude Code 2.1.310, a Haiku model that called Bash
// `run_in_background` and Monitor). acpx PROJECT.md: synthetic adapter shapes pass in both
// directions, so the tracker and the gate are tested against these and nothing invented.
import type { LiveBackgroundTask } from "../src/cli/session/background-task-tracker.js";

export const FIXTURE_LINES: string[] = [
  `{"jsonrpc":"2.0","method":"_claude/backgroundTasks","params":{"sessionId":"99693e09-a64a-47fd-9518-124fd20b1ee3","at":"2026-10-29T13:18:45.649Z","tasks":[]}}`,
  `{"jsonrpc":"2.0","method":"_claude/backgroundTasks","params":{"sessionId":"99693e09-a64a-47fd-9518-124fd20b1ee3","at":"2026-10-29T13:18:48.417Z","tasks":[{"taskId":"b343f35rh","taskType":"local_bash","description":"rig-s1 bash bg","startedAt":"2026-10-29T13:18:48.417Z"}]}}`,
  `{"jsonrpc":"2.0","method":"_claude/backgroundTasks","params":{"sessionId":"99693e09-a64a-47fd-9518-124fd20b1ee3","at":"2026-10-29T13:18:48.418Z","tasks":[{"taskId":"b343f35rh","taskType":"local_bash","description":"rig-s1 bash bg","startedAt":"2026-10-29T13:18:48.417Z","toolName":"Bash"}]}}`,
  `{"jsonrpc":"2.0","method":"_claude/backgroundTasks","params":{"sessionId":"99693e09-a64a-47fd-9518-124fd20b1ee3","at":"2026-10-29T13:18:50.097Z","tasks":[{"taskId":"b343f35rh","taskType":"local_bash","description":"rig-s1 bash bg","startedAt":"2026-10-29T13:18:48.417Z","toolName":"Bash"},{"taskId":"b2g1k6brj","taskType":"local_bash","description":"rig-s1 monitor","startedAt":"2026-10-29T13:18:50.097Z"}]}}`,
  `{"jsonrpc":"2.0","method":"_claude/backgroundTasks","params":{"sessionId":"99693e09-a64a-47fd-9518-124fd20b1ee3","at":"2026-10-29T13:18:50.099Z","tasks":[{"taskId":"b343f35rh","taskType":"local_bash","description":"rig-s1 bash bg","startedAt":"2026-10-29T13:18:48.417Z","toolName":"Bash"},{"taskId":"b2g1k6brj","taskType":"local_bash","description":"rig-s1 monitor","startedAt":"2026-10-29T13:18:50.097Z","toolName":"Monitor"}]}}`,
];

// The two REAL entries of fixtures/s1-claude-backgroundTasks.ndjson (its last line).
export const FIXTURE_TASKS: LiveBackgroundTask[] = [
  {
    taskId: "b343f35rh",
    taskType: "local_bash",
    description: "rig-s1 bash bg",
    startedAt: "2026-10-29T13:18:48.417Z",
    toolName: "Bash",
  },
  {
    taskId: "b2g1k6brj",
    taskType: "local_bash",
    description: "rig-s1 monitor",
    startedAt: "2026-10-29T13:18:50.097Z",
    toolName: "Monitor",
  },
];
