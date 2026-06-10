# B2 Tester Plan — acpx Profile Data Model

## What changed

- New `src/config/profiles.ts`: `ProfileEntry`, `ProfileRegistry`, `loadProfileRegistry` (dual-read v1/v2), `findProfile`, `ensureOpenRouterConfigDir`
- `src/types.ts`: added `session_options.profile` to `SessionAcpxState`; added `profileId` to `AcpClientOptions.sessionContext`
- `src/acp/auth-env.ts`: added `profileId` to `AgentSessionContext`; `applyProfileAuth(env, profileId, sessionId)` async fn; skips `applySubscriptionConfigDir` when `profileId` is set
- `src/acp/client.ts`: `AcpClient.shimHandle` — starts shim in `resolveAgentLaunchPlan`, stops in `close()`
- `src/runtime/engine/session-options.ts`: `profile` field added alongside `subscription`
- `src/runtime/engine/connected-session.ts`: passes `profileId` from record to `sessionContext`
- `src/session/persistence/parse.ts`: parses `session_options.profile`
- `src/cli/flags.ts`: `--profile <id>` flag registered; `profile` in `GlobalFlags`
- `src/cli/command-handlers.ts`: `profile` flows through `sessionOptionsFromGlobalFlags` and inheritance
- `src/cli/session/inherited-metadata.ts`: `withInheritedProfile`
- `src/cli-core.ts`: `--profile` in scan lists

## Unit tests: `loadProfileRegistry`

### v2 format (profiles key)

```typescript
// Setup: write registry.json with profiles array
const tmp = fs.mkdtempSync("/tmp/test-registry-");
fs.writeFileSync(
  path.join(tmp, ".acpx/subscriptions/registry.json"),
  JSON.stringify({
    default: "or1",
    profiles: [
      {
        id: "or1",
        label: "OR GPT-4o",
        harness: "claude",
        authMode: "openrouter",
        credentialSource: null,
        model: "openai/gpt-4o-mini",
        openRouterApiKey: "sk-or-v1-test",
      },
    ],
  }),
);
const registry = loadProfileRegistry({ homeDir: tmp });
// Expect: registry.profiles.length === 1, registry.default === 'or1'
// profile.authMode === 'openrouter', profile.model === 'openai/gpt-4o-mini'
// profile.openRouterApiKey === 'sk-or-v1-test'
```

### v1 format (subscriptions key — auto-migration)

```typescript
// Setup: write old registry.json with subscriptions array
fs.writeFileSync(
  path.join(tmp, ".acpx/subscriptions/registry.json"),
  JSON.stringify({
    default: "sub1",
    subscriptions: [
      { id: "sub1", label: "Claude Max", configDir: "/home/node/.acpx/subscriptions/sub1" },
    ],
  }),
);
const registry = loadProfileRegistry({ homeDir: tmp });
// Expect: registry.profiles.length === 1
// profile.harness === 'claude', profile.authMode === 'subscription'
// profile.credentialSource === '/home/node/.acpx/subscriptions/sub1'
```

### Empty / missing file

```typescript
const registry = loadProfileRegistry({ homeDir: "/does/not/exist" });
// Expect: registry.profiles.length === 0, no throw
```

### Malformed JSON

```typescript
fs.writeFileSync(path.join(tmp, ".acpx/subscriptions/registry.json"), "not json");
const registry = loadProfileRegistry({ homeDir: tmp });
// Expect: empty registry, no throw
```

## Integration smoke: openrouter session spawn

**Setup:** Create a registry.json with one openrouter profile:

```json
{
  "default": "or-test",
  "profiles": [
    {
      "id": "or-test",
      "label": "Test OR profile",
      "harness": "claude",
      "authMode": "openrouter",
      "credentialSource": null,
      "model": "openai/gpt-4o-mini",
      "openRouterApiKey": "sk-or-v1-test-key-here"
    }
  ]
}
```

**Test steps:**

1. `acpx sessions new --profile or-test` (in a test cwd)
2. Verify: session record has `acpx.session_options.profile = "or-test"`
3. When queue owner activates:
   - Shim process starts (process exists, bound to a port)
   - `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` is set in adapter env
   - `CLAUDE_CONFIG_DIR=/tmp/or-<sessionId>` is created and set
   - `ANTHROPIC_AUTH_TOKEN=" "` is set
4. Verify: adapter process inherits the correct env (check via `acpx status --verbose` or by inspecting process env)

## Regression: subscription session spawns still work

**Test:** Existing subscription session with `--subscription sub1` (or registry default).

**Expected:**

- `acpx sessions new` with no `--profile` flag → falls through to subscription path
- `CLAUDE_CONFIG_DIR` set from registry as before
- No shim started (`shimHandle` remains undefined)
- `acpx subscriptions list` still works (unchanged)

**CLI smoke:**

```bash
acpx sessions new              # no flags → registry default subscription
acpx sessions new --subscription sub1   # explicit sub
acpx subscriptions list        # old command still works
```

## Security: openRouterApiKey not in logs/stderr

**Test:** Enable `--verbose` on a session with `authMode=openrouter`, capture all stderr.

**Expected:**

- The literal string `sk-or-` MUST NOT appear in any stderr or stdout output
- The shim process's env has `OPENROUTER_API_KEY` set correctly (can verify via `/proc/<pid>/environ` in tests)
- The gateway adapter's env does NOT contain `OPENROUTER_API_KEY` (it only gets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR`)

**Code audit:**

- `applyProfileAuth` passes `apiKey` to `spawnOpenRouterShim` only via env var `OPENROUTER_API_KEY` on the shim child process
- `spawnOpenRouterShim` does NOT log the key
- The shim code (`OPENROUTER_SHIM_CODE`) never writes the key to stdout/stderr
- No `process.stderr.write` in `applyProfileAuth` includes the key value

## Known fragile spots

1. **Shim port assignment**: The shim binds to port 0 (OS-assigned). If the shim fails to start (e.g. node not found at `process.execPath`), `applyProfileAuth` will reject. The adapter spawn is then blocked — test this error path explicitly.

2. **Reconnect after adapter restart**: When the queue owner reconnects (adapter exited and is restarting), `AcpClient.start()` is called again. The code checks `!this.shimHandle` to avoid double-spawning — verify the shim is NOT re-started on reconnect.

3. **Shim stop on session close**: `AcpClient.close()` calls `this.shimHandle?.stop()` which kills the shim process. Verify no zombie shim processes after `acpx sessions close <id>`.

4. **CLAUDE_CONFIG_DIR isolation**: Two concurrent openrouter sessions must get separate dirs (`/tmp/or-<sessionId1>` vs `/tmp/or-<sessionId2>`). The `acpxRecordId` is used as the session discriminator — verify they are distinct.
