# Dangeresque

Run Claude Code or OpenAI Codex AFK in isolated git worktrees with automatic review and human merge control.

## The Problem

You're deep in a Claude Code session and discover a bug. You could investigate it yourself, but that derails your current work. You could open a new terminal and run Claude Code headlessly, but then you need to manage worktrees, prompts, permissions, review quality, and result tracking yourself.

Docker-based agent orchestration tools solve some of this, but Anthropic's [usage policy](https://docs.anthropic.com/en/docs/claude-code/overview) now restricts running Claude Code in containers with subscription keys. Even when Docker was viable, container isolation blocks access to MCP servers (Unity Editor, Chrome automation, local databases) and host-installed tools (`gh`, language runtimes, build SDKs).

Dangeresque runs Claude Code directly on the host in a git worktree. You get full MCP server access, host binary inheritance, and granular tool permissions — with the safety model built around worktree isolation, a skeptical automated reviewer, and mandatory human merge.

## How It Works

```
  Your repo          Worker pass             Review pass
  (main)     --->    (worktree)       --->   (same worktree)
                         |                         |
                  Reads GitHub Issue,         Reads git diff,
                  executes task,              audits worker claims,
                  writes run result to        appends verdict to the
                  .dangeresque/runs/          same run file
                                                   |
                                                   v
                                          You review diff,
                                          merge or discard
```

1. **Worker** runs Claude Code headlessly (`-p`) in an isolated worktree with your custom system prompt + GitHub Issue context. It writes a run result file at `.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md` inside the worktree.
2. **Reviewer** runs Claude Code in the same worktree with an adversarial review prompt — checks the actual `git diff` against the worker's claims and appends its verdict to the same run file.
3. Dangeresque **commits the run file** to the worktree branch so it flows through normal merge into main — runs are tracked history, not a parallel archive.
4. The **full run file** is posted as a comment on the GitHub Issue.
5. **macOS notification** fires when complete.
6. **You** inspect the diff, discuss with Claude, then `merge` or `discard`.

No code touches your main branch until you explicitly merge. If the worker **fails** (non-zero exit), dangeresque prints a loud FAILURE banner, posts a FAIL comment on the issue, and exits non-zero — no stale success artifacts.

## Requirements

- Node.js >= 22
- At least one engine CLI installed and authenticated. Follow each vendor's standard subscription login flow:
  - **Claude Code**: `npm install -g @anthropic-ai/claude-code`
  - **OpenAI Codex CLI**: `npm install -g @openai/codex`
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

| File                  | What to customize                                              |
| --------------------- | -------------------------------------------------------------- |
| `worker-prompt.md`    | Add project-specific conventions, build commands, test runners |
| `review-prompt.md`    | Add domain-specific review criteria                            |
| `AFK_WORKER_RULES.md` | Add custom modes, adjust scope rules                           |

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
INVESTIGATE → read → discuss → stage → merge → push → IMPLEMENT → read → discuss → merge → push
```

**Every issue starts with INVESTIGATE. No exceptions** — even "trivial one-liners" get a read-only INVESTIGATE first to verify the hypothesis, surface missed side-effects, and land a research artifact the IMPLEMENT can cite.

**Push `main` to origin after every merge, before dispatching the next run.** Worktrees branch from `origin/main`, so any local-only commits make the next worker start from a stale base and produce phantom-regression noise in review.

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

This dispatches an **INVESTIGATE** run (the default mode). The worker reads the GitHub Issue, traces through relevant code, and documents findings in a run result file under `.dangeresque/runs/issue-63/` — but makes no code changes. A review pass runs automatically after. A macOS notification fires when complete.

### 3. Read the results

```bash
# From your main Claude session — the ! prefix runs the command inline
! dangeresque results investigate-63

# Or from a separate terminal
dangeresque results investigate-63
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

Merges the worktree into main, cleaning up the branch. The run result file at `.dangeresque/runs/issue-63/` is part of the merge — future runs see it automatically because it's tracked history. Since INVESTIGATE runs don't change code, the merge just brings in the run file.

### 6. Dispatch the implementation

```bash
dangeresque run --issue 63 --mode IMPLEMENT
```

The worker reads the issue + your staged comment + prior run files for the same issue, makes code changes, writes tests, and commits. Review pass audits the diff.

### 7. Review and merge

```bash
# Read results (shows the latest run file + diff summary vs main)
! dangeresque results implement-63

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
# Snapshot current transcript and exit
dangeresque logs investigate-63

# Tail live output (explicit opt-in, like tail -f / journalctl -f)
dangeresque logs investigate-63 -f

# Review pass transcript
dangeresque logs investigate-63 --review

# Raw JSONL for custom processing
dangeresque logs investigate-63 --raw | jq '.message.content[]?.text'
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
  --model <model>     Override model (default: claude-opus-4-7)
  --effort <level>    Override effort (default: max) [low, medium, high|xhigh, max]
```

### Switching Engines

Dangeresque now supports two interchangeable execution engines:

- `claude` (default): Uses `claude` CLI with `--worktree` and native Claude session tracking.
- `codex`: Uses `codex exec --json --full-auto` and runs inside the same isolated worktree model.

Set the engine in `.dangeresque/config.json` (recommended):

```bash
{
  "engine": "codex",
  "model": "gpt-5.4"
}
```

Or use an environment override for a single run:

```bash
DANGERESQUE_ENGINE=codex dangeresque run --issue 63
```

Help output adapts to the active engine (`config.engine` or `DANGERESQUE_ENGINE`): Claude help shows `--effort`, while Codex help omits it because `--effort` is Claude-only and ignored in Codex mode.

### Codex option mapping

- `model` maps directly to `codex exec --model <model>`.
- `effort` has no direct Codex CLI flag; dangeresque passes it as an explicit prompt hint for planning depth.
- Codex runs use `--full-auto` (safe automation mode) and **do not** use dangerous bypass flags.

### Dynamic help output

- Help text adapts to the active engine (`config.engine` or `DANGERESQUE_ENGINE`).
- Claude help emphasizes `--effort`.
- Codex help de-emphasizes effort and shows Codex-native execution notes.

### `dangeresque logs`

Pretty-print engine transcripts (Claude or Codex JSONL).

```
Arguments:
  <branch>       Target worktree (required)

Options:
  -f, --follow   Follow mode — tail new output (explicit opt-in; default is snapshot + exit)
  --review       Show review session instead of worker
  --raw          Output raw JSONL without formatting
```

### `dangeresque results`

Show run results from active worktrees or the local archive.

```bash
dangeresque results investigate-63          # Specific active worktree
dangeresque results --issue 63              # Summary + latest for issue
dangeresque results --issue 63 --all        # Full history
```

### `dangeresque stage <number> --comment "text" [--mode MODE]`

Post a structured context comment on a GitHub Issue before a run.

```bash
dangeresque stage 63 --comment "use the existing config pattern" --mode IMPLEMENT
```

### `dangeresque status`

List active dangeresque worktrees with branch names and HEAD commits.

### `dangeresque merge <branch>`

Merge the worktree branch into the current branch (carrying the run result file with it), then remove the worktree and branch. Supports branch shorthand (`investigate-63` instead of `worktree-dangeresque-investigate-63`).

### `dangeresque discard <branch>`

Force-remove worktree and branch without merging. The run result file is discarded along with the worktree — that's the point of discard. Supports branch shorthand.

### `dangeresque clean --issue <N>`

Delete tracked run result files for an issue (e.g. after closing). This modifies the working tree; commit the deletion separately.

### `dangeresque stats [options]`

Aggregate structured run evaluation artifacts from `.dangeresque/runs/`.

```bash
dangeresque stats
dangeresque stats --issue 63
dangeresque stats --engine codex --mode IMPLEMENT
dangeresque stats --glossary
```

### `dangeresque init`

Scaffold `.dangeresque/` config, copy skills, merge notification hooks. Re-run to refresh skills. Existing config files are not overwritten. If a legacy `.dangeresque/runs/` pattern is found in `.gitignore`, it is removed (run results are tracked in git, not ignored).

### `dangeresque brief`

Print a self-contained workflow primer to stdout (markdown, version-stamped). Use `dangeresque brief >> CLAUDE.md` to embed the primer into your project's CLAUDE.md, or `dangeresque brief | less` for a quick read. The document covers the workflow loop, issue body shape, command surface, modes, and what-not-to-do — enough to drive dangeresque end-to-end without reading this README.

## Evaluation Vocabulary

These terms are derived from worker exit code, review phase, run artifact presence, recorded scope violations, and parsed reviewer verdicts in `src/artifact.ts`. For design rationale, see [docs/DESIGN.md](docs/DESIGN.md#4-observability--evaluation).

- `success`: The worker exited successfully and produced its run artifact. Either the reviewer accepted the run, or review did not run and no scope violations were recorded.
- `partial_success`: The worker exited successfully and produced its run artifact, but the run still needs attention. This is used when review errored, review returned `needs_human_review` or `unknown`, or review was skipped while scope violations were recorded.
- `failure`: The worker failed, the run artifact was missing, or the reviewer explicitly rejected the run.
- `scope_violation`: Changed files were outside the issue body or selected issue comments, excluding `.dangeresque/runs/`. This failure category is emitted only when those scope violations caused a downgrade because review did not run; when review ran, the reviewer verdict controls the result.
- `reviewer_verdict=accept`: The reviewer accepted the worker's changes.
- `reviewer_verdict=reject`: The reviewer rejected the worker's changes; this makes the run a `failure`.
- `reviewer_verdict=needs_human_review`: The reviewer could not accept or reject outright and asked for human judgment; this makes the run a `partial_success`.
- `reviewer_verdict=skipped`: No reviewer decision exists because review was intentionally skipped.
- `reviewer_verdict=unknown`: Dangeresque could not derive a reviewer verdict, usually because the worker failed, the artifact was missing or unreadable, or the markdown verdict was absent or unparseable.

Review normally runs after a successful worker run for code-changing modes. It is automatically skipped for `INVESTIGATE` and `VERIFY`, and manually skipped by `--no-review`.

## Task Modes

Each run operates in exactly one mode. The mode constrains what the worker can do.

| Mode            | Purpose                             | May                                 | May NOT                      |
| --------------- | ----------------------------------- | ----------------------------------- | ---------------------------- |
| **INVESTIGATE** | Find root cause, trace flow         | Read, grep, analyze, write findings | Change code                  |
| **IMPLEMENT**   | Bounded code change                 | Edit code, write tests, commit      | Widen scope beyond the issue |
| **VERIFY**      | Prove a change works                | Run tests, grep values, check state | Write new features           |
| **REFACTOR**    | Restructure without behavior change | Move/rename/reorganize              | Change behavior              |
| **TEST**        | Write tests for existing behavior   | Create test files, run them         | Change production code       |

Add custom modes in `.dangeresque/AFK_WORKER_RULES.md`.

## Comment Filtering

When building the worker prompt, dangeresque filters issue comments:

- **Included:** issue body + all `[staged]` comments + last 3 untagged human comments
- **Skipped:** old `[dangeresque]` run result comments (duplicated by the tracked run files in `.dangeresque/runs/`)

This keeps the prompt focused. Use `dangeresque stage` to add guidance the worker will always see.

## Configuration

### .dangeresque/ directory

| File                  | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `worker-prompt.md`    | System prompt appended for the worker pass        |
| `review-prompt.md`    | System prompt for the review pass                 |
| `AFK_WORKER_RULES.md` | Operating modes, scope rules, status language     |
| `PERMISSIONS.md`      | How to grant tool permissions; matcher rule shapes |
| `CLAUDE.md.sample`    | Recommended CLAUDE.md starting point              |
| `config.json`         | Optional overrides (model, tools, permissions)    |
| `runs/`               | Tracked run result files, one per run (merged with your branch) |

### config.json

| Key               | Type     | Default              | Description                                     |
| ----------------- | -------- | -------------------- | ----------------------------------------------- |
| `engine`          | string   | `"claude"`           | Execution engine (`claude` or `codex`)          |
| `model`           | string   | `"claude-opus-4-7"`  | Model ID passed to the selected engine          |
| `permissionMode`  | string   | `"acceptEdits"`      | Sandbox/permission mode for the selected engine |
| `effort`          | string   | `"max"`              | Effort level: low, medium, high, xhigh, max     |
| `headless`        | boolean  | `true`               | Run with `-p` flag (set false for interactive)  |
| `allowedTools`    | string[] | _(see below)_        | Tools auto-approved without prompting           |
| `disallowedTools` | string[] | _(see below)_        | Tools hard-blocked from use                     |
| `workerPrompt`    | string   | `"worker-prompt.md"` | Worker system prompt filename                   |
| `reviewPrompt`    | string   | `"review-prompt.md"` | Review system prompt filename                   |
| `notifications`   | boolean  | `true`               | Enable macOS notification hooks                 |

### Default Tool Permissions

**Allowed (auto-approved):**

- `Read`, `Edit`, `Write`, `Grep`, `Glob`
- `WebSearch`, `WebFetch`
- `Bash(git status *)`, `Bash(git diff *)`, `Bash(git log *)`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(git branch *)`

**Disallowed (hard-blocked):**

- `Bash(git push *)`, `Bash(git reset --hard *)`, `Bash(rm -rf *)`, `Bash(git branch -D *)`

Both engines enforce these at the tool layer: claude via `--disallowed-tools`, codex via a generated `<worktree>/.codex/rules/dangeresque.rules` file (Starlark `prefix_rule(..., decision="forbidden")` entries translated from the same config) that codex picks up through its project-layer rules scan.

**Granting more permissions.** MCP and arbitrary `Bash(...)` patterns are NOT auto-approved by `acceptEdits`. To enable an MCP server, run `dangeresque allow mcp` (reads `./.mcp.json` `mcpServers` keys) or `dangeresque allow mcp <server>` for user-scope / plugin-scope servers not in `.mcp.json`. To allow a bash command pattern, `dangeresque allow bash "<pattern>"` — e.g. `dangeresque allow bash "npm install *"`. The matcher form `mcp__<server>` / `mcp__<server>__*` is per [Anthropic's permissions docs](https://code.claude.com/docs/en/permissions); bare `mcp__*` is not honored. See `.dangeresque/PERMISSIONS.md` (created by `dangeresque init`) for the full reference.

## Why Host-Native Instead of Containerized

Some agent orchestration tools run each agent in a Docker container. Dangeresque runs Claude Code directly on the host. This is deliberate.

**Anthropic's usage policy now restricts running Claude Code in containers with subscription keys.** This makes host-native execution not just a preference but a practical necessity for most users.

Beyond policy, host-native gives you:

- **MCP server access** — Unity Editor, Chrome automation, local databases work natively. Containers can't reach host-bound MCP servers without complex networking.
- **Host binaries** — `gh`, language runtimes, build tools, SDKs are inherited directly. No Dockerfile authoring or container startup overhead.
- **Granular permissions** — `acceptEdits` mode with explicit `allowedTools`/`disallowedTools` instead of `--dangerously-skip-permissions`

The safety model is different:

## MCP setup (Claude vs Codex)

- **Claude Code** MCP uses your existing Claude setup.
- **Codex** MCP is configured in `~/.codex/config.toml` under `[mcp_servers]`.
- Keep entries aligned across both tools if you want equivalent MCP behavior for both engines.

| Layer             | Docker-based                     | Dangeresque                                                      |
| ----------------- | -------------------------------- | ---------------------------------------------------------------- |
| **Filesystem**    | Container sandbox                | Git worktree (isolated branch, shared repo)                      |
| **Permissions**   | `--dangerously-skip-permissions` | `acceptEdits` + allowedTools/disallowedTools                     |
| **MCP servers**   | Not practical                    | Native access                                                    |
| **Review**        | You write the orchestration      | Built-in adversarial reviewer                                    |
| **Merge control** | Varies                           | Always manual — nothing touches main without `dangeresque merge` |

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
