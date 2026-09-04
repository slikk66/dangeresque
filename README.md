# Dangeresque

Run Claude Code or OpenAI Codex AFK in isolated git worktrees with structured multi-phase passes, automatic adversarial review, and human merge control.

![image info](./docs/image.png)

**Contents**

- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Engines](#engines)
- [Workflow at a glance](#workflow-at-a-glance)
- [Scope at a glance](#scope-at-a-glance)
- [Configuration overview](#configuration-overview)
- [Why Host-Native](#why-host-native)
- [License](#license)

Deeper references live under [`docs/`](docs/): [WORKFLOW](docs/WORKFLOW.md), [SCOPE](docs/SCOPE.md), [CONFIGURATION](docs/CONFIGURATION.md), [PERMISSIONS](docs/PERMISSIONS.md), [SCHEMA](docs/SCHEMA.md), [DESIGN](docs/DESIGN.md).

## The Problem

You're deep in an interactive agent session and discover a bug. You could investigate it yourself, but that derails your current work. You could open a new terminal and run an agent CLI headlessly, but then you need to manage worktrees, prompts, permissions, review quality, and result tracking yourself.

Docker-based agent orchestration tools solve some of this, but Anthropic's [usage policy](https://docs.anthropic.com/en/docs/claude-code/overview) now restricts running Claude Code in containers with subscription keys. Containers also break MCP and host-binary access regardless of engine — Unity Editor, Chrome automation, local databases, `gh`, language runtimes.

Dangeresque runs Claude Code or Codex directly on the host in a git worktree. You get full MCP server access, host binary inheritance, and granular tool permissions — with the safety model built around worktree isolation, a skeptical automated reviewer, and mandatory human merge.

## How It Works

```
  Your repo          Worker pass             Verify hook       Review pass
  (main)     --->    (worktree)       --->   (worktree) --->   (same worktree)
                         |                       |                   |
                  Reads GitHub Issue,       Compile/test/lint,  Reads git diff,
                  executes task,            block-on-failure    audits worker claims,
                  writes run result to      writes results      appends verdict to
                  gitignored                into SUMMARY +      the same run file
                  .dangeresque/runs/        ## Verification           |
                                                                      v
                                                            On merge: artifact
                                                            mirrored to main
                                                            checkout; SUMMARY +
                                                            path posted to issue
                                                                      |
                                                                      v
                                                            You review diff,
                                                            merge or discard
```

1. **Worker** runs the configured engine (Claude Code or Codex) headlessly in an isolated worktree with your system prompt + GitHub Issue context, writing a run result to `.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md`. The runs directory is **gitignored** — artifacts never enter git history.
2. **Verify hook** (optional, configured per project) runs compile/test/lint commands in the worktree post-rebase, pre-review. Block-style failures skip the review pass and fail the run; results land in the artifact's `<!-- SUMMARY -->` block (`Verify:` line) and a `## Verification` body section.
3. **Reviewer** runs a second session in the same worktree with an adversarial review prompt, checking the actual `git diff` against the worker's claims and appending its verdict to the run file.
4. **Comment on the issue** carries only the artifact's `<!-- SUMMARY -->` block plus the local path — never the full body. The artifact stays on disk so collaborators read it via `dangeresque results --issue <N>` or directly at `.dangeresque/runs/issue-<N>/`.
5. **On `dangeresque merge`**, the gitignored artifact is mirrored from the worktree back to the project root before the worktree is torn down. On the next dispatch for the same issue, prior artifacts are mirrored _into_ the new worktree so the worker can read them.
6. **You** inspect the diff, discuss with the agent in your interactive session, then `dangeresque merge` or `dangeresque discard`.

No code touches main until you explicitly merge. If the worker fails (non-zero exit), dangeresque prints a loud FAILURE banner, posts a FAIL comment on the issue, and exits non-zero — no stale success artifacts.

## Quick Start

### Requirements

- Node.js >= 22
- At least one engine CLI installed and authenticated:
  - **Claude Code**: `npm install -g @anthropic-ai/claude-code`
  - **OpenAI Codex CLI**: `npm install -g @openai/codex`
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- git, jq

### Install

```bash
git clone git@github.com:slikk66/dangeresque.git
cd dangeresque
yarn install
yarn build
npm link

# Now available everywhere
dangeresque --help
```

### Initialize

```bash
cd your-project
dangeresque init
```

Creates `.dangeresque/` with canonical prompts (`worker-prompt.md`, `review-prompt.md`, `AFK_WORKER_RULES.md`), matching `.local.md` override stubs, and `DANGERESQUE.md` (the workflow primer). Installs a Claude Code skill for creating issues (Claude-only — Codex users invoke the workflow primer in `DANGERESQUE.md` directly). Merges notification hooks into `.claude/settings.json`. If no `CLAUDE.md` exists in the project, a minimal one is created with a pointer to `DANGERESQUE.md`; if one already exists without the pointer, init prints a warning with the exact block to add:

```markdown
<!-- DANGERESQUE-START -->

**`dangeresque` is installed in this repo.** Use it — not raw `git worktree`, `kill <pid>`, or `cd <worktree>` — to dispatch AFK AI workers, manage isolated worktrees, and gate merges. Before dispatching or merging, run **`dangeresque brief`** (workflow loop + the hard rule). Run **`dangeresque --help`** for the full command surface (auto-generated, never stale).

<!-- DANGERESQUE-END -->
```

The pointer routes both interactive sessions (Claude Code via `CLAUDE.md`, Codex via `AGENTS.md`) and AFK workers to the canonical workflow primer in `DANGERESQUE.md`.

Confirm the install with `dangeresque doctor` — see [Health Checks in `docs/SCHEMA.md`](docs/SCHEMA.md#health-checks-dangeresque-doctor) for the full output shape.

### Customizing prompts

Canonical `.dangeresque/*.md` files (`worker-prompt.md`, `review-prompt.md`, `AFK_WORKER_RULES.md`) are refreshed on every `dangeresque init`; your project overrides live in the `.local.md` sibling and are never touched. `DANGERESQUE.md` is the workflow primer — overwritten on every init, not meant for direct edits; keep project rules in `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex) instead.

| File to edit                | Purpose                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `worker-prompt.local.md`    | Project conventions appended to the worker system prompt                                  |
| `review-prompt.local.md`    | Domain-specific review criteria appended to the reviewer prompt                           |
| `AFK_WORKER_RULES.local.md` | Custom modes or scope rules the worker reads at runtime                                   |
| `CLAUDE.md`                 | Project build/test/architecture rules for Claude Code (user-owned, never touched by init) |
| `AGENTS.md`                 | Project build/test/architecture rules for Codex (user-owned, never touched by init)       |

Example `worker-prompt.local.md`:

```markdown
## Project-Specific Rules

- Run `yarn test` to verify changes (not `npm test`)
- The API layer is in `src/api/` — route handlers call services, never repositories directly
- Always run `yarn lint` before committing
```

## Engines

Dangeresque supports two interchangeable execution engines:

- `claude` (default): uses `claude` CLI with native Claude session tracking.
- `codex`: uses `codex exec --json -s workspace-write -c approval_policy=never` in the same worktree model.

Select per-project in `.dangeresque/config.json`:

```json
{
  "engineDefaults": {
    "claude": { "model": "claude-opus-4-7", "effort": "max" },
    "codex": { "model": "gpt-5.5", "effort": "xhigh" }
  },
  "worker": { "engine": "codex" },
  "review": { "engine": "claude" }
}
```

Or override per-run: `dangeresque run --issue 63 --engine codex --review-engine claude`. Engine-only switches use the selected `engineDefaults` pin; phase `--model` / `--effort` flags override it. Each Codex phase receives native effort and is validated before dispatch.

For per-engine notes (Codex-specific flags, MCP setup differences) see [`docs/CONFIGURATION.md` §Engines](docs/CONFIGURATION.md#engines-claude-vs-codex).

## Workflow at a glance

```
INVESTIGATE → read → discuss → stage → merge → push → IMPLEMENT → read → discuss → merge → push
```

Every issue starts with INVESTIGATE — even one-liners — to verify the hypothesis and land a research artifact the IMPLEMENT can cite. After every merge, push `main` to origin before dispatching the next run; worktrees branch from `origin/main` and stale local-only commits pollute review.

Crash recovery comes in two complementary verbs, and neither substitutes for the other:

- **The review died, the worker finished.** `dangeresque review <branch>` re-runs only the review against the existing worktree; the worker's committed work is kept and does not need redoing.
- **The worker itself died.** `dangeresque resume <branch>` dispatches a new worker into that same worktree with the dead attempt's uncommitted diff intact, told to continue rather than restart. Without it the only exit from an engine usage limit is `discard`, which deletes hours of real work.

Full eight-step walkthrough with commands: [`docs/WORKFLOW.md`](docs/WORKFLOW.md).

## Scope at a glance

Two complementary mechanisms bound what files a worker is allowed to touch: a **declared scope block** in the issue (operator-side allow/deny globs) and a **scope declaration** the worker writes into its run result (per-file category + rationale). Drive-by fixes are bounded by an opportunistic budget (`maxFiles`, `maxLines`, project denyGlobs).

Full reference, syntax, and budget configuration: [`docs/SCOPE.md`](docs/SCOPE.md).

## Configuration overview

`.dangeresque/config.json` controls engine, model, permission mode, allowedTools/disallowedTools, scope budget, and the optional pre-review verification hook. Run `dangeresque <cmd> --help` for flag-level CLI detail (auto-generated and never stale).

- Full config reference (`.dangeresque/` directory layout, `config.json` keys, engine notes, comment filtering, verification hook): [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).
- Permissions deep-dive (`allowedTools`, `disallowedTools`, MCP grants): [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md).
- Health checks, schema migration, run-evaluation terms: [`docs/SCHEMA.md`](docs/SCHEMA.md).

## Why Host-Native

Some agent orchestration tools run each agent in a Docker container; dangeresque runs Claude Code or Codex directly on the host. Anthropic's usage policy restricts running Claude Code in containers with subscription keys, and containers break MCP server access and host-binary inheritance regardless of engine. Worktree isolation + adversarial reviewer + mandatory human merge replace container sandboxing.

Full design rationale: [`docs/DESIGN.md` §2 Execution Model](docs/DESIGN.md#2-execution-model-host-native-vs-containerized).

## License

MIT
