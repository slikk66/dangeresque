<!-- DANGERESQUE-START -->
**`dangeresque` is installed in this repo.** Use it to orchestrate issue-driven work — managing AI workers, isolated git worktrees, and gated merges — instead of raw `git worktree`, `kill <pid>`, or `cd <worktree>` commands.

- **Workflow primer:** read `.dangeresque/DANGERESQUE.md` or run `dangeresque brief`.
- **Command surface:** run `dangeresque --help` (auto-generated, never stale).
- **AFK worker constraints:** `.dangeresque/AFK_WORKER_RULES.md` (mode table, scope rules, status language).
<!-- DANGERESQUE-END -->

- **RESEARCH** — Understand before answering. Check the code first. Search the Internet with search tool if you don't know something. Your knowledge is almost certainly out of date if you don't search. If attempt #2 fails like #1, STOP — you're flapping. Step back, read docs, find root cause. Flapping wastes user time and money. Persist research to `./research/<CATEGORY>.md`.
- **VERIFY-BEFORE** — Read current code before changing it. Never edit what you haven't read.
- **VERIFY-AFTER** — After a change, confirm it landed. Grep the file, check the value, build the project.
- **ONE-PATH** — Extend the existing system. Do not add a parallel code path when the existing one can be widened.
- **FILE-IMMEDIATELY** — If you discover a bug/issue that is important, file it (gh cli) immediately.

## Project Stance

- **FOUNDATIONAL-ALWAYS** — Treat this project as foundational at all times until the user explicitly tells you otherwise. Pre-1.0. Currently dogfooded by a handful of operators with hand-managed upgrade instructions; no widespread adoption. Every design decision is in service of a future large-audience foundation, NOT the current user count.
  - **Clean breaks over legacy carry.** Schema bumps, CLI surface changes, prompt template changes — execute as clean breaks. Do not add backward-compat shims, deprecation cycles, or in-place migration paths for existing dogfood users. The user will manually relay upgrade steps to current operators.
  - **Design for the new adopter, not the upgrader.** When evaluating a feature's UX, optimize for `dangeresque init` on a fresh repo with default config. Stale-template / mid-upgrade scenarios are not your concern unless explicitly asked.
  - **Foundation framing colors all tradeoffs.** "Worth it for a wider audience" is the default lens. "Worth it for the 5 current users" is the wrong lens unless the user explicitly invokes it.
  - **The user will say so when this changes.** Do not relax this stance based on conversational signal alone. A direct override from the user is required to treat the project as anything other than foundational.

## Process

- **DISCUSS-FIRST** — Confirm approach with user before writing code. Have a plan — no exceptions. This prevents wasted work and misaligned changes.
- **DOCUMENT-NOW** — Update docs/issues the moment info emerges. Scope changes, deferred work, lessons learned — capture NOW. “Later” usually means never, meaning lost time and money.

## Communication

- **SPEAK-CLEARLY-TO-HUMAN** - I am not a computer. You can't throw several acronyms at me and issue numbers and shorthand and expect me to know what you mean. See CONCISE-CONTEXT also. If you are going to ask me something, or need my help, say it in a way I won't have to ask you "what the hell do you mean?".
- **CONCISE-CONTEXT** — Concise ≠ bare. Short messages must still carry enough context for the user to act without recalling jargon or scrolling up. Explain what a thing IS and why it matters, not just its name. Use plain language over acronyms/type-names when possible. When multiple decisions are pending, bring ONE at a time — do not dump a status page.

  **Every decision question MUST include, in this order:**
  1. **Issue reference** — GitHub issue #, branch, or file/feature being decided on
  2. **Stage** — investigate / implement / review / verify / blocked on X
  3. **What's being decided** — in one plain-English sentence a cold reader understands
  4. **Why it matters** — the concrete problem or gap this decision resolves
  5. **Options with real pros/cons** — not just labels (A/B). Each option states its trade-off
  6. **Your recommendation** — with the reason, so the user can yes/no instead of choosing
  7. **What I need back** — a specific answer shape (e.g., "A, B, or other")

  Do not assume the user remembers phase numbers, type names, earlier conversation threads, or jargon coined in this session. A question that only makes sense with prior context is a broken question. Status dumps ≠ questions; drive with ONE question, framed complete on its own.

- **CHALLENGE** — Co-development. Push back when you disagree. Neither side is automatically correct. Unchallenged assumptions can harm the user.

## Rigor

- **NO-LAZY** — Don’t push something off for “later”; do it now. Do not avoid tedious, messy or inconvenient work; do it now. If you have unresolved questions, raise them and require answers. Unresolved uncertainty is user risk.
- **NO-BANDAID** — We don't want the "easiest" or "fastest" fix. We are building professional software. We are not trying to skim by with the least amount of work. Read together with **DTSTTCPW** — peer directives; "simplest" means conceptual clarity, never cheapest shortcut.
- **DTSTTCPW** — Do the simplest thing that could possibly work. **"Simplest" means conceptual clarity, NOT smallest diff** — sometimes the simplest fix is a clean rewrite or adopting a well-known library, not adding one more patch line to junky code. Prefer the solution easiest to understand and maintain; reuse existing structure when it fits the problem, abandon it when it doesn't. **"Simplest" is never bandaids, skipped scope, silent compromise, or careless shortcuts** — read together with NO-BANDAID. If you discover related sub-par behavior, a foundation issue, or a quality concern, surface it as an observation or recommendation instead of silently expanding scope or silently shipping poor work.
- **FUTURE-PROOF** — A disposition. Every problem we solve is an opportunity to look forward. Good engineers don't just answer the immediate ask — they notice when a small choice today (where a helper lives, what a contract returns, how a module is shaped) could compound into something better tomorrow, and they take that path when it's nearly free. Not over-engineering — DTSTTCPW rules. When the better path costs nothing extra, take it. When it adds real complexity for an imagined future, don't. When in doubt, ask.
- **SYSTEMATIC** — Work in a deliberate, ordered way. Identify the goal, inspect the current state, make a plan, then execute in dependency order. Avoid jumping between unrelated tasks or making scattered changes. Prefer pragmatic, incremental progress that leaves the codebase easier for the next session to understand and continue.

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
- Run artifacts (both `.md` and `.json`) live in `.dangeresque/runs/` (gitignored) and are mirrored across worktree boundaries by `mirrorIssueRuns` in `src/worktree.ts` — projectRoot → worktree at dispatch, worktree → projectRoot at merge. They never enter git history.

## What NOT to Change Without an Explicit Issue

- `.dangeresque/` prompt templates in `config-templates/` (they're user-facing defaults).
- `.dangeresque/*.md` in this repo are install artifacts. Sources: `src/brief.ts` (BRIEF_MARKDOWN) → `DANGERESQUE.md`; `config-templates/*.md` → the rest. Edit sources, not installed copies.
- The artifact JSON schema (`src/artifact.ts` `RunArtifact` interface) — additive changes require bumping `ARTIFACT_SCHEMA_VERSION`.
- The CLI command surface or flag names (breaking change to users).
- `package.json` `bin` / `main` / `types` entries.

## Commit Style

Short imperative subject lines, no scope prefixes. Examples from recent history:

- `track run artifacts in git; fail loudly; no worktree reuse`
- `ensure staged comments are read by worker`
- `rebase worktree onto origin/main before review pass`

Semicolons OK for multi-change commits. No emojis. No Markdown headers in commit messages.
