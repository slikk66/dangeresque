# Dangeresque

Run Claude Code AFK in isolated git worktrees with automatic review and human merge control.

## The Problem

You're deep in a Claude Code session and discover a bug. You could investigate it yourself, but that derails your current work. You could open a new terminal and run Claude Code headlessly, but then you need to manage worktrees, prompts, permissions, review quality, and result tracking yourself.

Docker-based agent orchestration tools solve some of this, but Anthropic's [usage policy](https://docs.anthropic.com/en/docs/claude-code/overview) now restricts running Claude Code in containers with subscription keys. Even when Docker was viable, container isolation blocks access to MCP servers (Unity Editor, Chrome automation, local databases) and host-installed tools (`gh`, language runtimes, build SDKs).

Dangeresque runs Claude Code directly on the host in a git worktree. You get full MCP server access, host binary inheritance, and granular tool permissions — with the safety model built around worktree isolation, a skeptical automated reviewer, and mandatory human merge.

## How It Works

```
  Your repo          Worker pass          Review pass
  (main)     --->    (worktree)    --->   (same worktree)
                         |                      |
                  Reads GitHub Issue,      Reads git diff,
                  executes task,           audits worker claims,
                  writes RUN_RESULT.md     appends verdict
                                                |
                                                v
                                    You review diff,
                                    merge or discard
```

1. **Worker** runs Claude Code headlessly (`-p`) in an isolated worktree with your custom system prompt + GitHub Issue context
2. **Reviewer** runs Claude Code in the same worktree with an adversarial review prompt — checks the actual `git diff` against the worker's claims
3. **RUN_RESULT.md** posted as a comment on the GitHub Issue
4. **macOS notification** fires when complete
5. **You** inspect the diff, discuss with Claude, then `merge` or `discard`
6. **RUN_RESULT.md archived** locally to `.dangeresque/runs/` for future run context

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

## Setup (One-Time)

### 1. Initialize your project

```bash
cd your-project
dangeresque init
```

Creates `.dangeresque/` with system prompts, rules, and a `CLAUDE.md.sample`. Installs a Claude Code skill for creating issues. Merges notification hooks into `.claude/settings.json`.

### 2. Set up your CLAUDE.md

Workers read your project's `CLAUDE.md` (at project root or `.claude/CLAUDE.md`) before every run. If you don't have one, check `.dangeresque/CLAUDE.md.sample` — it has a recommended structure with prime directives that both interactive sessions and AFK workers follow:

```markdown
# PRIME DIRECTIVES

## Quality Gates
- **VERIFY-BEFORE** — Check current state before touching anything.
- **VERIFY-AFTER** — Confirm every change landed. Grep the file, check the value.
- **NO-BANDAID** — Every fix must be researched and confirmed correct.
- **ONE-PATH** — Never add a parallel code path when the existing system can be extended.

## Project-Specific
- Run `yarn test` to verify changes
- The API layer is in `src/api/` — route handlers call services, never repositories directly
- Always run `yarn lint` before committing
```

The project-specific section is where you put build commands, architecture rules, naming conventions — anything a new developer (or an AFK worker) would need to know.

### 3. Customize the worker prompts

The default prompts work out of the box, but you can tailor them. The files in `.dangeresque/` are yours to edit:

| File | What to customize |
|------|-------------------|
| `worker-prompt.md` | Add project-specific conventions, build commands, test runners |
| `review-prompt.md` | Add domain-specific review criteria |
| `AFK_WORKER_RULES.md` | Add custom modes, adjust scope rules |

**Examples:**

In `worker-prompt.md`, add project context:
```markdown
## Project-Specific Rules
- Run `yarn test` to verify changes (not `npm test`)
- The API layer is in `src/api/` — route handlers call services, never repositories directly
- Always run `yarn lint` before committing
```

In `AFK_WORKER_RULES.md`, add a custom mode:
```markdown
| **MIGRATE** | Database migration | Create migration files, update schema | Change application code |
```

In `review-prompt.md`, add domain checks:
```markdown
## Additional Review Criteria
- Verify no direct database queries outside the repository layer
- Check that new API endpoints have corresponding test coverage
```

## The Workflow

The full cycle looks like this:

```
INVESTIGATE → read → discuss → stage → merge → IMPLEMENT → read → discuss → merge → push
```

For simple, well-scoped issues you can skip straight to IMPLEMENT:

```
IMPLEMENT → read → merge → push
```

Here's each step in detail.

### 1. Create a GitHub Issue

Write a focused issue describing the task. Workers read the issue title, body, and selected comments as their assignment. Good issues are bounded — one slice of work, not an entire feature.

You can create issues manually, or use the bundled Claude Code skill from your interactive session:

```
You:    "The login timeout is set to 5 minutes but should be 30"
Claude: *discusses, confirms the fix*
You:    /dangeresque-create-issue
```

### 2. Dispatch an investigation

```bash
dangeresque run --issue 63
```

This dispatches an **INVESTIGATE** run (the default mode). The worker reads the GitHub Issue, traces through relevant code, and documents findings in `RUN_RESULT.md` — but makes no code changes. A review pass runs automatically after. A macOS notification fires when complete.

### 3. Read the results

```bash
# From your main Claude session — the ! prefix runs the command inline
! dangeresque results --latest

# Or from a separate terminal
dangeresque results --latest
```

Pull the results into your Claude session so you can discuss what the worker found. Ask questions, challenge conclusions, or plan next steps.

### 4. Stage your decisions

After reading the investigation, stage a comment with your guidance before dispatching the implementation:

```bash
dangeresque stage 63 --comment "root cause confirmed in TokenService.ts:140. Use approach A — extend existing timeout config, don't add a new one" --mode IMPLEMENT
```

The `[staged]` comment becomes part of the next worker's prompt context. This is how you steer the implementation without being present.

### 5. Merge the investigation

```bash
dangeresque merge investigate-63
```

Archives `RUN_RESULT.md` locally (so future runs have context), merges worktree into main, cleans up. Since INVESTIGATE runs don't change code, this just brings in the archived results.

### 6. Dispatch the implementation

```bash
dangeresque run --issue 63 --mode IMPLEMENT
```

The worker reads the issue + your staged comment + archived investigation results, makes code changes, writes tests, and commits. Review pass audits the diff.

### 7. Review and merge

```bash
# Read results
! dangeresque results --latest

# Inspect the actual diff
cd .claude/worktrees/dangeresque-implement-63 && git diff main

# Discuss with Claude — ask about edge cases, risks, test coverage
# Then merge when satisfied
dangeresque merge implement-63
```

### 8. Continue or close

- **Push** your main branch with the merged changes
- **Dispatch a VERIFY run** to prove the change works end-to-end
- **Stage more comments** and dispatch another IMPLEMENT pass for the next slice
- **Close the issue** when done

## Monitoring a Running Session

```bash
# Pretty-print live transcript (auto-follows while running)
dangeresque logs

# Specific worktree
dangeresque logs investigate-63

# Review pass transcript
dangeresque logs --review

# Raw JSONL for custom processing
dangeresque logs --raw | jq '.message.content[]?.text'
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
  --effort <level>    Override effort (default: max) [low, medium, high, max]
```

### `dangeresque logs`

Pretty-print Claude Code session transcripts.

```
Options:
  [branch]       Target worktree (default: latest by commit timestamp)
  -f, --follow   Follow mode — tail new output (default when worker is RUNNING)
  --review       Show review session instead of worker
  --raw          Output raw JSONL without formatting
```

### `dangeresque results`

Show run results from active worktrees or the local archive.

```bash
dangeresque results --latest               # Latest active worktree
dangeresque results investigate-63          # Specific worktree
dangeresque results --issue 63             # Summary + latest for issue
dangeresque results --issue 63 --all       # Full history
```

### `dangeresque stage <number> --comment "text" [--mode MODE]`

Post a structured context comment on a GitHub Issue before a run.

```bash
dangeresque stage 63 --comment "use the existing config pattern" --mode IMPLEMENT
```

### `dangeresque status`

List active dangeresque worktrees with branch names and HEAD commits.

### `dangeresque merge <branch>`

Archive `RUN_RESULT.md`, merge worktree into current branch, clean up. Supports branch shorthand (`investigate-63` instead of `worktree-dangeresque-investigate-63`).

### `dangeresque discard <branch>`

Archive `RUN_RESULT.md`, force-remove worktree and branch without merging. Supports branch shorthand.

### `dangeresque clean --issue <N>`

Delete archived runs for an issue after closing it.

### `dangeresque init`

Scaffold `.dangeresque/` config, copy skills, merge notification hooks, update `.gitignore`. Re-run to refresh skills from the latest dangeresque version. Existing config files are not overwritten.

## Task Modes

Each run operates in exactly one mode. The mode constrains what the worker can do.

| Mode | Purpose | May | May NOT |
|------|---------|-----|---------|
| **INVESTIGATE** | Find root cause, trace flow | Read, grep, analyze, write findings | Change code |
| **IMPLEMENT** | Bounded code change | Edit code, write tests, commit | Widen scope beyond the issue |
| **VERIFY** | Prove a change works | Run tests, grep values, check state | Write new features |
| **REFACTOR** | Restructure without behavior change | Move/rename/reorganize | Change behavior |
| **TEST** | Write tests for existing behavior | Create test files, run them | Change production code |

Add custom modes in `.dangeresque/AFK_WORKER_RULES.md`.

## Comment Filtering

When building the worker prompt, dangeresque filters issue comments:

- **Included:** issue body + all `[staged]` comments + last 3 untagged human comments
- **Skipped:** old `[dangeresque]` run result comments (replaced by local archive)

This keeps the prompt focused. Use `dangeresque stage` to add guidance the worker will always see.

## Configuration

### .dangeresque/ directory

| File | Purpose |
|------|---------|
| `worker-prompt.md` | System prompt appended for the worker pass |
| `review-prompt.md` | System prompt for the review pass |
| `AFK_WORKER_RULES.md` | Operating modes, scope rules, status language |
| `CLAUDE.md.sample` | Recommended CLAUDE.md starting point |
| `config.json` | Optional overrides (model, tools, permissions) |
| `runs/` | Local archive of RUN_RESULT.md files (gitignored) |

### config.json

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `"claude-opus-4-6"` | Claude model ID |
| `permissionMode` | string | `"acceptEdits"` | Claude Code permission mode |
| `effort` | string | `"max"` | Effort level: low, medium, high, max |
| `headless` | boolean | `true` | Run with `-p` flag (set false for interactive) |
| `allowedTools` | string[] | _(see below)_ | Tools auto-approved without prompting |
| `disallowedTools` | string[] | _(see below)_ | Tools hard-blocked from use |
| `workerPrompt` | string | `"worker-prompt.md"` | Worker system prompt filename |
| `reviewPrompt` | string | `"review-prompt.md"` | Review system prompt filename |
| `notifications` | boolean | `true` | Enable macOS notification hooks |

### Default Tool Permissions

**Allowed (auto-approved):**
- `Read`, `Edit`, `Write`, `Grep`, `Glob`
- `WebSearch`, `WebFetch`
- `mcp__*` (all MCP servers)
- `Bash(git status *)`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(git branch *)`

**Disallowed (hard-blocked):**
- `Bash(git push *)`, `Bash(git reset --hard *)`, `Bash(rm -rf *)`, `Bash(git branch -D *)`

## Why Host-Native Instead of Containerized

Some agent orchestration tools run each agent in a Docker container. Dangeresque runs Claude Code directly on the host. This is deliberate.

**Anthropic's usage policy now restricts running Claude Code in containers with subscription keys.** This makes host-native execution not just a preference but a practical necessity for most users.

Beyond policy, host-native gives you:

- **MCP server access** — Unity Editor, Chrome automation, local databases work natively. Containers can't reach host-bound MCP servers without complex networking.
- **Host binaries** — `gh`, language runtimes, build tools, SDKs are inherited directly. No Dockerfile authoring or container startup overhead.
- **Granular permissions** — `acceptEdits` mode with explicit `allowedTools`/`disallowedTools` instead of `--dangerously-skip-permissions`

The safety model is different:

| Layer | Docker-based | Dangeresque |
|-------|-------------|-------------|
| **Filesystem** | Container sandbox | Git worktree (isolated branch, shared repo) |
| **Permissions** | `--dangerously-skip-permissions` | `acceptEdits` + allowedTools/disallowedTools |
| **MCP servers** | Not practical | Native access |
| **Review** | You write the orchestration | Built-in adversarial reviewer |
| **Merge control** | Varies | Always manual — nothing touches main without `dangeresque merge` |

The name is intentional — running agents on your host filesystem is slightly more dangerous. The mitigation is the human review loop: worker → reviewer → you inspect diff → explicit merge. No code lands without your approval.

## Project Structure

```
dangeresque/
├── src/
│   ├── cli.ts        # CLI: run, logs, results, stage, status, merge, discard, clean, init
│   ├── config.ts     # Load/validate .dangeresque/ config
│   ├── logs.ts       # JSONL session parser, pretty-printer, tail/follow
│   ├── runner.ts     # Assemble Claude CLI flags, spawn worker + review, post comments
│   ├── worktree.ts   # List/merge/discard worktrees, archive results, resolve shorthand
│   ├── init.ts       # Scaffold config, copy skills, merge hooks, update .gitignore
│   ├── stage.ts      # Post structured comments on issues
│   └── index.ts      # Public API exports
├── config-templates/ # Default config files for dangeresque init
├── skills/           # Claude Code skills distributed by init
├── dist/             # Compiled JS (yarn build)
├── package.json
└── tsconfig.json
```

## License

MIT
