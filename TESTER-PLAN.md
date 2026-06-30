# W16-03 Part B Tester Plan

Candidate branch: `fix/w16-03-codex-default-model`
Implementation SHA: `cd632444bcd7f6f4cf6e7b59205d40389fc2781d`

## Goal Check

A real root/unrooted Codex spawn with no `--model` works on the dev-server ChatGPT account and does not hit the bad `gpt-5.3-codex` 400.

Use the candidate build from this worktree/checkout, not the installed production `acpx` binary. Keep ACPX and Codex state isolated from production config:

```bash
pnpm install --frozen-lockfile
pnpm run build
SMOKE_ROOT=$(mktemp -d /tmp/acpx-w16-03-te.XXXXXX)
mkdir -p "$SMOKE_ROOT/.codex" "$SMOKE_ROOT/.acpx"
cp -a /home/node/.codex/. "$SMOKE_ROOT/.codex/"
HOME="$SMOKE_ROOT" ACPX_STATE_HOME="$SMOKE_ROOT" CODEX_HOME="$SMOKE_ROOT/.codex" \
  node dist/cli.js --approve-all codex exec "Reply with exactly: PARTB-OK"
```

Expected: command exits 0, output includes `PARTB-OK`, and there is no ChatGPT-account 400 for `gpt-5.3-codex`. In normal text output, `session/set_model` should appear before the answer.

## Regression Checks

Explicit model still wins:

```bash
HOME="$SMOKE_ROOT" ACPX_STATE_HOME="$SMOKE_ROOT" CODEX_HOME="$SMOKE_ROOT/.codex" \
  node dist/cli.js --approve-all --format json \
  --model 'gpt-5.3-codex-spark[medium]' \
  codex exec "Reply with exactly: PARTB-EXPLICIT"
```

Expected: JSON output includes an outbound `session/set_model` request with `modelId: "gpt-5.3-codex-spark[medium]"`; reply includes `PARTB-EXPLICIT`.

Run the targeted automated acceptance tests:

```bash
pnpm run build:test
node --test --test-name-pattern 'codex exec without --model|codex exec preserves|codex child session inherits|prompting an existing codex session|non-codex exec without --model|AcpRuntimeManager applies the built-in codex default' \
  dist-test/test/cli.test.js dist-test/test/runtime-manager.test.js
```

Expected: all 6 targeted tests pass. They cover no-model Codex defaulting, explicit override precedence, Codex→Codex inheritance, existing-session prompt no-reset, non-Codex unchanged, and the runtime-engine create path.
