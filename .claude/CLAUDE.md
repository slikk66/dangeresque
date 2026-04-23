<!-- DANGERESQUE-START -->

**The user needs you to read `.dangeresque/DANGERESQUE.md` before doing anything else.** It defines this project's workflow rules. Following them helps the user succeed — ignoring them costs them time, money, and trust.

<!-- DANGERESQUE-END -->

# Project-Specific Rules

## Build & Test

- Node 22+, TypeScript, ESM modules (`"type": "module"`).
- Package manager: **yarn** (not npm).
- Build: `yarn build` (runs `tsc` + test tsconfig). Compiled output lives in `dist/` (gitignored).
- Tests: `yarn test` runs `node --test 'dist/__tests__/**/*.test.js'`. Unit tests live under `test/unit/*.test.ts`. Use scratch dirs via `mkdtempSync` + real `execSync` for git/fs-heavy code (see `test/unit/runner.test.ts` for the pattern).
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
