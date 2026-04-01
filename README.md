# dangeresque

Orchestrate bounded AFK [Claude Code](https://docs.anthropic.com/en/docs/claude-code) runs in isolated git worktrees with automatic review and human merge control.

dangeresque is a thin wrapper around Claude Code's built-in `--worktree`, `-p`, `--permission-mode`, and `--append-system-prompt-file` flags. It assembles the right CLI invocation, runs a worker pass, then a skeptical review pass, and hands control back to you.

## How It Works

```
  Your repo          Worker pass          Review pass
  (main)     ───>    (worktree)    ───>   (same worktree)
                         │                      │
                  Reads GitHub Issue,      Reads worker output,
                  makes changes,           checks quality,
                  writes RUN_RESULT.md     appends verdict
                                                │
                                                v
                                    You review diff,
                                    merge or discard
```

1. **Worker** runs Claude Code headlessly (`-p`) in an isolated worktree with your AFK rules + GitHub Issue context
2. **Reviewer** runs Claude Code in the same worktree with a skeptical review prompt
3. **Full RUN_RESULT.md** posted as a comment on the GitHub Issue
4. **macOS notification** fires when the run completes
5. **You** inspect the diff, then `merge` or `discard`

No code touches your main branch until you explicitly merge.

## Requirements

- Node.js >= 22
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- git
- jq (for notification hooks)

## Install

```bash
git clone git@github.com:slikk66/dangeresque.git
cd dangeresque
yarn install
yarn build
npm link

# Now available everywhere
dangeresque --help
```

## Quick Start

### 1. Initialize your project

```bash
cd your-project
dangeresque init
```

This creates:
- `.dangeresque/` — worker-prompt.md, review-prompt.md, AFK_WORKER_RULES.md
- `.claude/skills/dangeresque-create-issue/` — skill for creating issues from conversation context
- Merges notification hooks into `.claude/settings.json`

### 2. Run against a GitHub Issue

```bash
dangeresque run --issue 63
```

Runs headlessly with `-p` flag. The worker reads the issue, executes the task, writes `RUN_RESULT.md`, and commits. A review session runs automatically after. A macOS notification fires on completion.

### 3. Check results

```bash
# From your main Claude session
! dangeresque results --latest

# Or review the worktree directly
dangeresque status
cd .claude/worktrees/dangeresque-<name> && git diff main
```

### 4. Merge or discard

```bash
dangeresque merge worktree-dangeresque-<name>
# or
dangeresque discard worktree-dangeresque-<name>
```

## CLI Reference

### `dangeresque run`

Execute a worker + review pass.

```
Options:
  --issue <number>    Read task from GitHub Issue (recommended)
  --mode <mode>       Task mode (default: INVESTIGATE)
                      [INVESTIGATE, IMPLEMENT, VERIFY, REFACTOR, TEST, or custom]
  --name <name>       Custom worktree name (auto-prefixed with dangeresque-)
  --no-review         Skip the review pass
  --interactive       Run interactively instead of headless (for debugging)
  --model <model>     Override model (default: claude-opus-4-6)
  --effort <level>    Override effort (default: high) [low, medium, high, max]
```

After completion, posts the full RUN_RESULT.md as a comment on the GitHub Issue.

### `dangeresque results [--latest | <branch>]`

Dump `RUN_RESULT.md` + `git diff --stat` from a worktree to stdout. Use `! dangeresque results --latest` in your main Claude session to pull results into the conversation.

### `dangeresque stage <number> --comment "text" [--mode MODE]`

Post a structured context comment on an existing GitHub Issue. Useful for adding implementation guidance before an IMPLEMENT run.

```bash
dangeresque stage 63 --comment "root cause confirmed, cascade scan after line 140" --mode IMPLEMENT
dangeresque run --issue 63 --mode IMPLEMENT
```

### `dangeresque status`

List active dangeresque worktrees with branch names and HEAD commits.

### `dangeresque merge <branch>`

Merge the worktree branch into your current branch, then clean up the worktree and branch.

### `dangeresque discard <branch>`

Force-remove the worktree and delete the branch without merging.

### `dangeresque init`

Set up a project for dangeresque:
- Creates `.dangeresque/` with default config templates
- Copies `/dangeresque-create-issue` skill to `.claude/skills/`
- Merges notification hooks into `.claude/settings.json` (preserves existing hooks)

Re-run to refresh skills and config from the latest dangeresque version.

## Typical Workflows

### Bug discovered in main session

```
You:    "Come odds paid wrong when I hit the point"
Claude: *discusses, diagnoses*
You:    /dangeresque-create-issue               → creates issue #80
You:    dangeresque run --issue 80              → headless worker + review
        ... macOS notification: "dangeresque-80 complete" ...
You:    ! dangeresque results --latest          → pull results into session
Claude: *reads results, discusses*
You:    "merge it" or "send it back as IMPLEMENT"
```

### External user files a bug (issue already exists)

```bash
dangeresque run --issue 82 --mode INVESTIGATE
# ... notification: "dangeresque-82 complete" ...
dangeresque results --latest
```

### Adding guidance before an IMPLEMENT run

```bash
dangeresque stage 82 --comment "root cause is inverted payout table" --mode IMPLEMENT
dangeresque run --issue 82 --mode IMPLEMENT
```

### Interactive debugging

```bash
dangeresque run --issue 63 --mode INVESTIGATE --interactive
# Full interactive Claude session — you can answer questions, approve actions
```

## Configuration

### .dangeresque/ directory

| File | Purpose |
|------|---------|
| `worker-prompt.md` | System prompt appended for the worker pass |
| `review-prompt.md` | System prompt for the review pass |
| `AFK_WORKER_RULES.md` | Operating modes, scope rules, status language |
| `config.json` | Optional overrides (model, tools, permissions) |

### config.json

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `"claude-opus-4-6"` | Claude model ID |
| `permissionMode` | string | `"acceptEdits"` | Claude Code permission mode |
| `effort` | string | `"high"` | Effort level: low, medium, high, max |
| `headless` | boolean | `true` | Run with `-p` flag (set false for interactive) |
| `allowedTools` | string[] | *(see below)* | Tools auto-approved without prompting |
| `disallowedTools` | string[] | *(see below)* | Tools hard-blocked from use |
| `workerPrompt` | string | `"worker-prompt.md"` | Worker system prompt filename |
| `reviewPrompt` | string | `"review-prompt.md"` | Review system prompt filename |

### Default Tool Permissions

**Allowed (auto-approved):**
- `Read`, `Edit`, `Write`, `Grep`, `Glob`
- `WebSearch`, `WebFetch`
- `mcp__*` (all MCP servers — Unity, browser, etc.)
- `Bash(git status *)`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(git branch *)`

**Disallowed (hard-blocked):**
- `Bash(git push *)`, `Bash(git reset --hard *)`, `Bash(rm -rf *)`, `Bash(git branch -D *)`

### Notification Hooks

`dangeresque init` merges two hooks into `.claude/settings.json`:

- **Notification** — macOS alert when the worker needs attention
- **SessionEnd** — macOS alert when the run completes

Both read `cwd` from the hook's stdin JSON and check if the directory basename starts with `dangeresque-`. Only dangeresque worktree sessions trigger notifications — your main interactive session stays silent.

All dangeresque worktrees are automatically prefixed with `dangeresque-` to enable this detection.

## Project Structure

```
dangeresque/
├── src/
│   ├── cli.ts        # CLI: run, results, stage, status, merge, discard, init
│   ├── config.ts     # Load/validate .dangeresque/ config
│   ├── runner.ts     # Assemble Claude CLI flags, spawn worker + review, post comments
│   ├── worktree.ts   # List/merge/discard worktrees, dump results
│   ├── init.ts       # Scaffold config, copy skills, merge hooks
│   ├── stage.ts      # Post structured comments on issues
│   └── index.ts      # Public API exports
├── config-templates/ # Default config files for dangeresque init
├── skills/           # Claude Code skills distributed by init
│   └── dangeresque-create-issue/
│       └── SKILL.md
├── dist/             # Compiled JS (yarn build)
├── package.json
└── tsconfig.json
```

## License

MIT
