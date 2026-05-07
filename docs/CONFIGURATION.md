# Configuration

## .dangeresque/ directory

| File                        | Purpose                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `worker-prompt.md`          | Canonical worker system prompt (overwritten by `init`)                                                            |
| `worker-prompt.local.md`    | Project overrides appended to the worker prompt (user-owned)                                                      |
| `review-prompt.md`          | Canonical review system prompt (overwritten by `init`)                                                            |
| `review-prompt.local.md`    | Project overrides appended to the review prompt (user-owned)                                                      |
| `AFK_WORKER_RULES.md`       | Canonical mode table, scope rules, status language (overwritten)                                                  |
| `AFK_WORKER_RULES.local.md` | Project-specific additions read at runtime (user-owned)                                                           |
| `DANGERESQUE.md`            | Workflow primer pointed to from `CLAUDE.md` / `AGENTS.md` (overwritten)                                           |
| `config.json`               | Optional overrides (model, tools, permissions)                                                                    |
| `runs/`                     | Run result files (one per run). **Gitignored** — mirrored across worktrees by the CLI, not carried by `git merge` |

## config.json

| Key               | Type     | Default              | Description                                                                                        |
| ----------------- | -------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `engine`          | string   | `"claude"`           | Execution engine (`claude` or `codex`)                                                             |
| `model`           | string   | `"claude-opus-4-7"`  | Model ID passed to the selected engine                                                             |
| `permissionMode`  | string   | `"acceptEdits"`      | Sandbox/permission mode for the selected engine                                                    |
| `effort`          | string   | `"max"`              | Effort level: low, medium, high, xhigh, max                                                        |
| `headless`        | boolean  | `true`               | Run with `-p` flag (set false for interactive)                                                     |
| `allowedTools`    | string[] | _(see below)_        | Tools auto-approved without prompting                                                              |
| `disallowedTools` | string[] | _(see below)_        | Tools hard-blocked from use                                                                        |
| `workerPrompt`    | string   | `"worker-prompt.md"` | Worker system prompt filename                                                                      |
| `reviewPrompt`    | string   | `"review-prompt.md"` | Review system prompt filename                                                                      |
| `notifications`   | boolean  | `true`               | Enable macOS notification hooks                                                                    |
| `verify`          | object   | _(empty commands)_   | Pre-review verification hook — see the [Verification](#verification-pre-review-hook) section below |
| `scope`           | object   | _(see Opportunistic)_ | Scope subsystem policy. `scope.opportunistic` controls the per-project drive-by budget — see [Opportunistic Drive-by Fixes in `docs/SCOPE.md`](SCOPE.md#opportunistic-drive-by-fixes) |

## Engines (claude vs codex)

Dangeresque supports two interchangeable execution engines:

- `claude` (default): uses `claude` CLI with native Claude session tracking.
- `codex`: uses `codex exec --json --full-auto` in the same worktree model.

Select per-project in `.dangeresque/config.json`:

```json
{
  "engine": "codex",
  "model": "gpt-5.4"
}
```

Or override per-run: `DANGERESQUE_ENGINE=codex dangeresque run --issue 63`. Help output adapts to the active engine.

Codex-specific notes: `model` maps directly to `codex exec --model <model>`; `effort` has no native Codex CLI flag (dangeresque passes it as a prompt hint for planning depth); Codex runs use `--full-auto` (safe automation mode), not dangerous bypass flags. MCP on **Claude Code** uses your existing Claude setup; MCP on **Codex** is configured in `~/.codex/config.toml` under `[mcp_servers]` — keep entries aligned across both tools for equivalent behavior.

## Permissions

Default `allowedTools` (auto-approved): `Read`, `Edit`, `Write`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, and `Bash(git status|diff|log|add|commit|branch *)`. Default `disallowedTools` (hard-blocked): `Bash(git push *)`, `Bash(git reset --hard *)`, `Bash(rm -rf *)`, `Bash(git branch -D *)`. MCP and arbitrary `Bash(...)` patterns are NOT auto-approved. To grant them, run `dangeresque allow mcp` (reads `.mcp.json`), `dangeresque allow mcp <server>` (user- or plugin-scope), or `dangeresque allow bash "<pattern>"`. See [`docs/PERMISSIONS.md`](PERMISSIONS.md) for the full reference.

## Comment filtering

When building the worker prompt, dangeresque filters issue comments:

- **Included:** issue body + all `[staged]` comments + last 3 untagged human comments
- **Skipped:** prior `[dangeresque]` run-summary comments (the worker reads the local artifacts from `.dangeresque/runs/issue-<N>/` instead — they hold the full body, the comment carries only the SUMMARY block)

Use `dangeresque stage` to add guidance the worker will always see.

## GitHub issue comments

After each run, dangeresque posts a single comment on the issue containing only the artifact's `<!-- SUMMARY -->` block, the local artifact path, and a pointer to `dangeresque results --issue <N>`. The full run-result body never leaves the local machine — it lives at `.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md` (gitignored) on the host that ran the worker. Pull it onto another machine via `git`-based mirroring of your choice, or run dangeresque on the same host where the artifacts already live.

## Verification (pre-review hook)

Dangeresque can run compile/test/lint commands in the worktree between the worker exit (post-rebase, post-file-count-normalize) and the review pass. This catches drift between worker prose claims ("yarn build passes") and code reality. The reviewer (text-only) treats verification exit codes as ground truth and overrides any contradicting worker claim.

Configure under `verify` in `.dangeresque/config.json`. See [`config-templates/config.example.json`](../config-templates/config.example.json) for the full shape and ecosystem-specific examples (Cargo, Go, TypeScript-only). Minimal example:

```json
{
  "verify": {
    "enabled": true,
    "modes": ["IMPLEMENT", "REFACTOR", "TEST", "VERIFY"],
    "commands": [
      {
        "name": "compile",
        "cmd": "yarn build",
        "on_failure": "block",
        "timeout_ms": 300000
      },
      {
        "name": "test",
        "cmd": "yarn test",
        "on_failure": "block",
        "timeout_ms": 600000
      },
      {
        "name": "lint",
        "cmd": "yarn lint",
        "on_failure": "warn",
        "timeout_ms": 120000
      }
    ]
  }
}
```

Per-command policy:

- `on_failure: "block"` — first failure short-circuits the run, skips the review pass, marks `result: "failure"` with `failure_categories: ["verification_failed"]`.
- `on_failure: "warn"` — failure is recorded but the review still runs.

The CLI runs verification commands directly — `allowedTools` does not constrain them, since the engine never sees them.

Where output lands:

- **Artifact JSON** (`<timestamp>-<MODE>.json`) — `verification: VerificationResult[]` with name, cmd, exit code, duration, stdout/stderr excerpts, `timed_out`, and `truncated` flags.
- **Artifact Markdown** — a `Verify: …` line in the `<!-- SUMMARY -->` block, plus a `## Verification (pre-review, captured automatically)` body section with a one-line PASS/FAIL/TIMEOUT per command and the trailing stderr excerpt for any non-zero exit.
- **Console** — per-command pass/warn/block lines while the hook runs.

Operator escape hatches:

- `dangeresque run --issue <N> --no-verify` — skip for one run.
- `verify.enabled: false` in config — disable globally.
- Drop the offending command from `commands`.

Empty `commands` array (the default) means no-op; opt in by listing commands.
