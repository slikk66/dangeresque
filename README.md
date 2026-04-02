# Dangeresque

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
4. **RUN_RESULT.md archived** locally to `.dangeresque/runs/` for future run context
5. **macOS notification** fires when the run completes
6. **You** inspect the diff, then `merge` or `discard`

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
- Adds `.dangeresque/runs/` to `.gitignore`

### 2. Run against a GitHub Issue

```bash
dangeresque run --issue 63
```

Runs headlessly with `-p` flag. The worker reads the issue, executes the task, writes `RUN_RESULT.md`, and commits. A review session runs automatically after. A macOS notification fires on completion.

### 3. Check results

```bash
# From your main Claude session
! dangeresque results --latest

# Archived results for an issue (after merge/discard)
dangeresque results --issue 63
dangeresque results --issue 63 --all

# Or review the worktree directly
dangeresque status
cd .claude/worktrees/dangeresque-<name> && git diff main
```

### 4. Merge or discard

Branch names support shorthand — no need to type the full `worktree-dangeresque-` prefix:

```bash
dangeresque merge investigate-63
dangeresque discard investigate-63

# Full names also work
dangeresque merge worktree-dangeresque-investigate-63
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

After completion, posts the full RUN_RESULT.md as a comment on the GitHub Issue and archives it locally.

**Comment filtering:** The worker prompt includes the issue body + all `[staged]` comments + last 3 human comments. Old `[dangeresque]` run result comments are skipped — the worker gets prior run context from the local archive instead.

### `dangeresque results`

Show run results from active worktrees or the local archive.

```bash
# Active worktree results
dangeresque results --latest
dangeresque results investigate-63

# Archived results (after merge/discard)
dangeresque results --issue 63         # One-line summaries + full latest
dangeresque results --issue 63 --all   # Full content of all runs
```

Active worktree results also show one-line summaries of any prior archived runs for the same issue.

### `dangeresque stage <number> --comment "text" [--mode MODE]`

Post a structured context comment on an existing GitHub Issue. Useful for adding implementation guidance before an IMPLEMENT run.

```bash
dangeresque stage 63 --comment "root cause confirmed, cascade scan after line 140" --mode IMPLEMENT
dangeresque run --issue 63 --mode IMPLEMENT
```

### `dangeresque status`

List active dangeresque worktrees with branch names and HEAD commits.

### `dangeresque merge <branch>`

Merge the worktree branch into your current branch, then clean up the worktree and branch. Archives RUN_RESULT.md to `.dangeresque/runs/` before merging. Supports branch shorthand.

### `dangeresque discard <branch>`

Force-remove the worktree and delete the branch without merging. Archives RUN_RESULT.md to `.dangeresque/runs/` before discarding. Supports branch shorthand.

### `dangeresque clean --issue <N>`

Delete archived runs for an issue. Use after closing an issue to free up local storage.

```bash
dangeresque clean --issue 63
```

### `dangeresque init`

Set up a project for dangeresque:

- Creates `.dangeresque/` with default config templates
- Copies `/dangeresque-create-issue` skill to `.claude/skills/`
- Merges notification hooks into `.claude/settings.json` (preserves existing hooks)
- Adds `.dangeresque/runs/` to `.gitignore`

Re-run to refresh skills and config from the latest dangeresque version.

## Key Concepts

### One Run = One Slice

Each AFK run should complete a bounded slice of work, not an entire issue. The typical flow:

```
INVESTIGATE → stage guidance → IMPLEMENT → merge → VERIFY → close
```

Or for simple issues: `IMPLEMENT → merge → close`

### RUN_RESULT.md Summary Block

Every RUN_RESULT.md must start with a machine-parseable summary:

```markdown
<!-- SUMMARY -->

Mode: IMPLEMENT | Status: implemented, unverified
Files: 3 changed (BettingManager.cs, CrapsRules.cs, BettingManagerTests.cs)
Proof: 8/8 tests pass | Not verified: WebGL build
Risks: none | Next: VERIFY

<!-- /SUMMARY -->
```

The `results` command parses this for one-line summaries of prior runs. The reviewer must verify it exists but not modify it.

### Local Run Archive

RUN_RESULT.md files are archived to `.dangeresque/runs/issue-<N>/` before merge or discard. This provides:

- **Reliable context** — subsequent runs read from local files, not GitHub comment parsing
- **Survives failures** — if the GitHub comment post fails, the archive persists
- **Clean separation** — GitHub comments are for human review, local archive is for machine context

### Comment Filtering

When building the worker prompt, `runner.ts` filters issue comments:

- **Included:** issue body + all `[staged]` comments + last 3 untagged human comments
- **Skipped:** old `[dangeresque]` run result comments (replaced by local archive)

### Review System

The reviewer checks: scope compliance, verification honesty, status language, code quality, handoff quality. For each acceptance criterion, the reviewer must distinguish **VERIFIED** (tested/proven) from **ADDRESSED** (code written but unverified).

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
You:    dangeresque merge investigate-80
```

### Multi-step: investigate then implement

```bash
dangeresque run --issue 82 --mode INVESTIGATE
# ... notification ...
dangeresque results --latest
dangeresque merge investigate-82

dangeresque stage 82 --comment "go with approach A" --mode IMPLEMENT
dangeresque run --issue 82 --mode IMPLEMENT
# ... notification ...
dangeresque results --latest
dangeresque merge implement-82
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

### Reviewing archived history

```bash
dangeresque results --issue 63           # Summary + latest
dangeresque results --issue 63 --all     # Full history
dangeresque clean --issue 63             # Prune after closing
```

## Configuration

### .dangeresque/ directory

| File                  | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `worker-prompt.md`    | System prompt appended for the worker pass        |
| `review-prompt.md`    | System prompt for the review pass                 |
| `AFK_WORKER_RULES.md` | Operating modes, scope rules, status language     |
| `config.json`         | Optional overrides (model, tools, permissions)    |
| `runs/`               | Local archive of RUN_RESULT.md files (gitignored) |

### config.json

| Key               | Type     | Default              | Description                                    |
| ----------------- | -------- | -------------------- | ---------------------------------------------- |
| `model`           | string   | `"claude-opus-4-6"`  | Claude model ID                                |
| `permissionMode`  | string   | `"acceptEdits"`      | Claude Code permission mode                    |
| `effort`          | string   | `"high"`             | Effort level: low, medium, high, max           |
| `headless`        | boolean  | `true`               | Run with `-p` flag (set false for interactive) |
| `allowedTools`    | string[] | _(see below)_        | Tools auto-approved without prompting          |
| `disallowedTools` | string[] | _(see below)_        | Tools hard-blocked from use                    |
| `workerPrompt`    | string   | `"worker-prompt.md"` | Worker system prompt filename                  |
| `reviewPrompt`    | string   | `"review-prompt.md"` | Review system prompt filename                  |

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

## Why Worktrees Instead of Docker

Some agent orchestration tools run each agent in a Docker container with a bind-mounted worktree. dangeresque skips Docker entirely and runs Claude Code directly on the host in a git worktree. This is a deliberate tradeoff.

### What Docker gives you

- **Container isolation** — agent can't affect files outside its mount
- **Reproducible environments** — Dockerfile controls exact dependencies
- **CI/CD friendly** — runs in cloud pipelines without a local dev machine
- **Parallelization** — framework-level orchestration across containers

### What Docker costs you

- **No MCP servers** — host-bound tools (Unity Editor, Chrome automation, local databases) can't run inside a container without complex networking or socket forwarding. For projects that rely on MCP, this is a dealbreaker.
- **Docker overhead** — image builds, container startup, bind-mount permissions, daemon dependency
- **Heavier setup** — requires Docker Desktop, Dockerfile authoring, and orchestration scripts to define workflows
- **`--dangerously-skip-permissions`** — container-based configurations where this flag is more viable disable ALL permission checks. dangeresque uses `--permission-mode acceptEdits` with explicit `allowedTools`/`disallowedTools` lists — more granular control over what the agent can and cannot do.

### What dangeresque trades for

dangeresque runs on the host filesystem. The agent has real access to your tools, your MCP servers, and your files. The safety model is different:

| Layer | Docker-based | Dangeresque |
|-------|-------------|-------------|
| **Filesystem** | Container sandbox | Git worktree (isolated branch, shared repo) |
| **Permissions** | `--dangerously-skip-permissions` (all tools allowed) | `acceptEdits` + allowedTools/disallowedTools (granular) |
| **MCP servers** | Not practical (host-bound servers can't reach container) | Native access (Unity, Chrome, etc.) |
| **Review** | Template pattern (you write the orchestration) | Built-in second pass with skeptical reviewer |
| **Merge control** | Varies — some auto-merge temp branches on success | Always manual — nothing touches main without `dangeresque merge` |
| **Parallelism** | Framework-level orchestration | Manual (multiple terminals) |

### When to use which

**Use Docker-based orchestration** if you need container isolation, CI/CD pipelines, or cloud-based agent runs where no human is present.

**Use dangeresque** if you need MCP server access, want a lightweight single-command workflow, or prefer human-in-the-loop review before any code touches main.

The name is intentional — running agents on your host filesystem without Docker is slightly more dangerous. The mitigation is the human review loop: worker → reviewer → you inspect the diff → explicit merge. No code lands without your approval.

## Project Structure

```
dangeresque/
├── src/
│   ├── cli.ts        # CLI: run, results, stage, status, merge, discard, clean, init
│   ├── config.ts     # Load/validate .dangeresque/ config
│   ├── runner.ts     # Assemble Claude CLI flags, spawn worker + review, post comments, filter comments
│   ├── worktree.ts   # List/merge/discard worktrees, archive results, resolve branch shorthand
│   ├── init.ts       # Scaffold config, copy skills, merge hooks, update .gitignore
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
