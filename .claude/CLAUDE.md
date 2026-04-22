# PRIME DIRECTIVES

## Quality Gates

- **VERIFY-BEFORE** — Read current code before changing it. Never edit what you haven't read.
- **VERIFY-AFTER** — After a change, confirm it landed. Grep the file, check the value, build the project.
- **NO-BANDAID** — Every fix must be researched and confirmed correct. No try/catch that swallows the problem.
- **ONE-PATH** — Extend the existing system. Do not add a parallel code path when the existing one can be widened.
- **FILE-IMMEDIATELY** — If you discover a bug/issue that is important, raise it or file it (gh cli) immediately. We can decide if it is uneeded later.

## Honest Scoping

- Stay inside the GitHub Issue. Do not widen scope.
- If blocked, stop and report. Do not invent requirements.
- Never say "fixed" or "done". Use allowed status language from AFK_WORKER_RULES.md.

# Project-Specific Rules

## Build & Test

- Node 22+, TypeScript, ESM modules (`"type": "module"`).
- Package manager: **yarn** (not npm).
- Build: `yarn build` (runs `tsc`). The compiled output lives in `dist/` (gitignored).
- No test framework is installed yet. Do not add one without an issue authorizing it.
- CLI binary: `./dist/cli.js`. Installed globally via `npm link` — the `dangeresque` command points at it.

## Code Conventions

- ES module imports with `.js` extensions: `import { x } from "./foo.js"` (even though the source is `foo.ts`).
- Prefer `node:` prefix for built-in modules: `import { readFileSync } from "node:fs"`.
- No external runtime dependencies in `package.json` unless absolutely necessary. Stdlib first.
- Default to no comments. Add one only when the WHY is non-obvious.

## Architecture

- `src/cli.ts` — argument parsing, command dispatch, orchestration of runWorker + runReview.
- `src/runner.ts` — worker + review process spawning, prompt assembly, worktree creation.
- `src/worktree.ts` — git worktree listing/merge/discard, PID tracking, archived results.
- `src/config.ts` — config loading and validation.
- `src/artifact.ts` — structured run evaluation JSON (schema, builder, writer, verdict parsing).
- `src/logs.ts` — JSONL transcript parsing and tailing for both Claude and Codex sessions.
- `src/init.ts` — scaffolds `.dangeresque/` into a target project.
- `src/stage.ts` — posts `[staged]` comments onto GitHub Issues.
- `src/index.ts` — public API surface (re-exports).

## Engines

- Two interchangeable engines: `claude` (default, uses `claude` CLI) and `codex` (uses `codex exec --json --full-auto`).
- Selected via `.dangeresque/config.json` `"engine"` field or `DANGERESQUE_ENGINE` env var.
- Engine-specific branching lives in `runner.ts` — keep new features engine-agnostic where possible.

## Worktree Model

- Every run happens in an isolated worktree under `.claude/worktrees/dangeresque-<name>/`.
- Branch naming: `worktree-dangeresque-<name>` (e.g. `worktree-dangeresque-implement-63`).
- Worktrees are never reused — creation hard-fails if the path exists.
- Run artifacts (both `.md` and `.json`) are committed inside the worktree and flow through normal `git merge`.

## Permissions & Safety

- Workers run with `acceptEdits` permission mode (Claude) or `--full-auto` (Codex).
- `allowedTools` / `disallowedTools` in config gate bash commands. `git push`, `git reset --hard`, `rm -rf`, `git branch -D` are hard-blocked under both engines: claude via `--disallowed-tools`, codex via a generated `<worktree>/.codex/rules/dangeresque.rules` (Starlark `prefix_rule(..., decision="forbidden")`) written by `writeCodexRulesFile` before spawn.
- Nothing touches main until the human runs `dangeresque merge`.

## What NOT to Change Without an Explicit Issue

- `.dangeresque/` prompt templates in `config-templates/` (they're user-facing defaults).
- The artifact JSON schema (`src/artifact.ts` `RunArtifact` interface) — additive changes require bumping `ARTIFACT_SCHEMA_VERSION`.
- The CLI command surface or flag names (breaking change to users).
- `package.json` `bin` / `main` / `types` entries.

## Commit Style

Short imperative subject lines, no scope prefixes. Examples from recent history:

- `track run artifacts in git; fail loudly; no worktree reuse`
- `ensure staged comments are read by worker`
- `rebase worktree onto origin/main before review pass`

Semicolons OK for multi-change commits. No emojis. No Markdown headers in commit messages.
