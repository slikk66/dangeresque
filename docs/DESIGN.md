# Dangeresque — Design & Tradeoffs

This document is the "why" companion to the README's "what." It covers the
architectural and engineering tradeoffs dangeresque makes, grounded in the
current codebase. No invented version history — every claim below points at a
real file on the branch you're reading.

## 1. Problem Statement

You're deep in a Claude Code session and find a bug that isn't blocking your
current work but needs fixing. You have three bad options:

1. **Derail the session** — switch contexts, investigate, fix, return. Breaks
   flow and costs momentum.
2. **Open another terminal and run Claude Code headlessly** — now you're
   writing prompts, managing worktrees, tracking permissions, and reading
   transcripts by hand.
3. **Use a Docker-based agent orchestrator** — except Anthropic's current
   usage policy restricts Claude Code from running in containers with
   subscription OAuth, and containers break MCP servers and host binaries
   anyway.

Dangeresque exists to give option 2 a proper shape. It dispatches a bounded
Claude (or Codex) run into an isolated git worktree, constrains it with a
permission allowlist, runs an adversarial reviewer over the diff, and writes
a structured result artifact you can read before merging. Nothing touches
your main branch without an explicit `dangeresque merge`.

The name is intentional: running an autonomous agent on your host filesystem
is slightly more dangerous than running it in a container. The mitigation is
not isolation — it's the four-layer safety model (§3) and the mandatory
human merge step.

## 2. Execution Model: Host-Native vs Containerized

Agent orchestrators commonly run each agent in a Docker container.
Dangeresque runs Claude Code directly on the host, inside a git worktree.
This is deliberate.

**Anthropic's usage policy** (see the README's "The Problem" section) now restricts running
Claude Code in containers when authenticated with a subscription OAuth
token. For most individual developers, this makes containerized
orchestration a non-starter regardless of the technical merits.

Beyond policy, host execution is what actually works for day-to-day use:

- **MCP servers.** Unity Editor integrations, Chrome automation, local
  database connectors, and other MCP servers live on the host and bind to
  localhost ports. Reaching them from a container means socket forwarding,
  port mapping, and careful networking — and in practice, many MCP servers
  are not reachable at all. Host execution inherits them for free.
- **Host binaries.** `gh`, `node`, `yarn`, language runtimes, SDKs,
  compilers, the user's shell configuration — all of this is available
  without a Dockerfile. The worker runs with the developer's real
  toolchain, not a reconstructed approximation.
- **Permission granularity.** Container-based orchestrators typically pass
  `--dangerously-skip-permissions` to Claude Code because filesystem
  isolation is assumed to absorb the blast radius. Dangeresque uses the
  opposite posture: `acceptEdits` permission mode with explicit
  `allowedTools`/`disallowedTools` patterns (see
  `src/config.ts:DEFAULT_CONFIG`).
  Every destructive git command the worker might reach for — `git push`,
  `git reset --hard`, `git branch -D`, and `rm -rf` — is hard-blocked at
  the tool layer of both engines, regardless of what the prompt says:
  claude via `--disallowed-tools`, codex via a generated
  `<worktree>/.codex/rules/dangeresque.rules` file of
  `prefix_rule(..., decision="forbidden")` entries translated from the
  same `disallowedTools` list.

The isolation boundary is a **git worktree**, not a container. Worktrees
share the repository's object store but have their own checkout, index, and
branch. Writes inside the worktree can't cross into your main working tree,
and because every worktree lives under
`.claude/worktrees/dangeresque-<name>/` on its own branch
(`worktree-dangeresque-<name>`), the blast radius is one branch.

| Layer             | Docker-based                     | Dangeresque                                                      |
| ----------------- | -------------------------------- | ---------------------------------------------------------------- |
| Filesystem        | Container sandbox                | Git worktree (isolated branch, shared object store)              |
| Permissions       | `--dangerously-skip-permissions` | `acceptEdits` + `allowedTools`/`disallowedTools`                 |
| MCP servers       | Not practical                    | Native access                                                    |
| Review            | You write the orchestration      | Built-in adversarial reviewer pass                               |
| Merge control     | Varies                           | Always manual — nothing touches main without `dangeresque merge` |
| Subscription auth | Blocked by ToS                   | Allowed (running on the host as the logged-in user)              |

## 3. Safety Model

Host execution removes the container sandbox, so the safety model has to
carry more weight. It does, in six layers (plus pre-flight validation):
worktree isolation, permission allowlist, pre-review verification,
adversarial reviewer, rebase before review, and the human merge gate.

### Layer 0 — Pre-flight validation

Before any worktree is created, `validateEngineRuntime` (see
`src/config.ts:validateEngineRuntime`) fails fast if (a) the engine CLI is
missing from PATH, (b) codex is selected but its authentication is missing,
or (c) the `<!-- DANGERESQUE-START -->` pointer is missing from both
`CLAUDE.md` and `.claude/CLAUDE.md`. The missing-pointer error embeds the
full block to paste so the fix is one copy-paste away. This runs in
`src/cli.ts` immediately after config load, so nothing about the spawn flow
depends on scattered CLI checks further down.

### Layer 1 — Worktree Isolation

Every run creates a fresh worktree at `.claude/worktrees/dangeresque-<name>/`
on branch `worktree-dangeresque-<name>`. `createWorktree` (see
`src/runner.ts:createWorktree`) hard-fails if the target path already
exists — there is no silent reuse. If a prior run wasn't merged or
discarded, the CLI errors out and instructs the user to clean up first. The
worktree is created from `origin/HEAD`, not local `HEAD`, so the worker
always starts from what the remote considers the current tip (this also
catches the "local main is ahead of origin" case with a warning; see
`src/runner.ts:checkRemoteBehind`).

### Layer 2 — Permission Allowlist

Workers are launched with `--permission-mode acceptEdits` (claude) or
`--full-auto` (codex) plus engine-specific command-gating derived from the
same config. The defaults (see `src/config.ts:DEFAULT_CONFIG`) allow
read/write inside the repo, `git status|diff|log|add|commit|branch`, and
web access (`WebSearch`, `WebFetch`). They explicitly disallow `git push`,
`git reset --hard`, `git branch -D`, and `rm -rf`. MCP servers are NOT in
the defaults — bare `mcp__*` is not honored by claude-code, so each MCP
server must be allowed by id via `dangeresque allow mcp` (or
`dangeresque allow mcp <server>` for user/plugin-scope servers not in
`.mcp.json`). Under claude these pass through as
`--allowed-tools`/`--disallowed-tools` flags. Under codex, each
`Bash(<cmd> *)` entry in `disallowedTools` is translated into a Starlark
`prefix_rule(pattern=[...], decision="forbidden", ...)` line and written to
`<worktree>/.codex/rules/dangeresque.rules` before the codex process spawns
(see `writeCodexRulesFile` in `src/runner.ts`); codex's project-layer rules
scan picks up the file and refuses the matching commands at exec time.
Projects extend the allowlist through `.dangeresque/config.json` — for
example, this repo adds `Bash(yarn build)` and
`Bash(yarn install --immutable)` so TypeScript workers can verify their code
compiles without being allowed to mutate `package.json`.

### Layer 3 — Pre-review Verification (CLI hook)

Between the worker exit and the reviewer, dangeresque runs a configurable
list of verification commands inside the worktree (post-rebase, post
file-count normalization). The hook is the bridge between worker prose
claims ("yarn build passes", "all tests green") and code reality. The
reviewer is text-only; without verification it has no independent way to
confirm those claims, and a worker that breaks the build but writes a
plausible run result can otherwise sneak through to ACCEPT.

Configuration lives in `.dangeresque/config.json` under `verify` (see
`config-templates/config.example.json` for the canonical shape and
`src/verify.ts:VerifyConfig` for the type). Each command names itself,
specifies a shell string, an `on_failure` policy
(`"block"` short-circuits the run; `"warn"` records and continues), and a
timeout. Empty `commands` (the default) is a no-op — verification is
opt-in. The CLI runs the commands directly (see
`src/verify.ts:runVerification`); `allowedTools` does not gate them, since
the engine never sees them.

When a `block`-policy command fails, the run is finalized with
`result: "failure"` and `failure_categories` includes `verification_failed`
(see `src/artifact.ts:deriveFailureCategories` and
`src/artifact.ts:isVerificationBlocked`). The review pass is skipped — the
review's value is auditing diffs against an issue, and there is nothing
worth auditing if the code does not compile or tests do not pass.

The hook also writes back into the artifact so the reviewer (when it does
run, on warn-only failures) has ground-truth signal:

- A `Verify: …` line is inserted into the `<!-- SUMMARY -->` block
  alongside `Files:` (see `src/verify.ts:appendVerifySummaryLine`).
- A `## Verification (pre-review, captured automatically)` body section
  is appended at the end of the artifact .md, with one PASS/FAIL/TIMEOUT
  line per command and a trailing stderr excerpt for any non-zero exit
  (see `src/verify.ts:appendVerifyBodySection`).
- The structured `VerificationResult[]` lands in the artifact JSON under
  `verification` (see `src/artifact.ts:RunArtifact.verification`).

The reviewer prompt (`config-templates/review-prompt.md`) instructs the
reviewer to treat this section as ground truth: any command shown as
`FAIL` overrides any worker claim of "tests pass" or "build clean," and
the contradiction is grounds for REJECT. The reviewer is told NOT to
re-run verification commands — they already ran in the worktree.

Operator escape hatches: `--no-verify` on the run command skips the hook
for one run; `verify.enabled: false` in config disables it globally; or
drop the offending command from `commands`.

### Layer 4 — Adversarial Reviewer

After verification (and the worktree being rebased onto the latest
`origin/main`, see below), a second Claude or Codex session runs with
`config-templates/review-prompt.md` as its system prompt. The reviewer's job
is not to rubber-stamp the worker; the prompt explicitly instructs it to
"verify the worker's actual code changes, not rubber-stamp its narrative."
It runs `git diff origin/main` as ground truth, reads the worker's run
result as a *claims document*, and appends a verdict (`ACCEPT`, `REJECT`,
or `NEEDS_HUMAN_REVIEW`) that dangeresque later extracts with a regex (see
`src/artifact.ts:VERDICT_REGEX`). The reviewer's file-count integrity check
is an **automatic FAIL** if the worker's claimed file list doesn't match
`git diff origin/main --name-only` (minus the gitignored
`.dangeresque/runs/` directory, which never appears in the diff). This is
the primary defense against a worker concealing changes.

Review is skipped for modes that by definition produce no code changes:
INVESTIGATE and VERIFY (see `SKIP_REVIEW_MODES` in `src/cli.ts`). Review
is also skipped when verification blocks (Layer 3) — there is no point
running an adversarial review against un-compiling code. Spending Claude
calls reviewing an empty diff is waste, and a skipped review is recorded
in the run artifact with a reason so it's visible downstream.

### Layer 5 — Rebase Before Review

Between worker and reviewer, the worktree is rebased onto `origin/main` (see
the "Rebase worktree onto latest origin/main" section in `src/cli.ts`).
This matters because multiple workers can run in parallel on different
issues, and another worker's branch may have merged to main since this
worktree was created. Without the rebase, `git diff main`
would show *this* worker's changes plus the diff from whatever branches
landed in the meantime, and the reviewer would misread unrelated merges as
scope violations or regressions. If the rebase conflicts, dangeresque aborts
the rebase and logs a `rebase_failed` lifecycle event — the reviewer will
see the pre-rebase diff and can flag the conflict, but no work is silently
lost.

### Hard stop on worker failure

If the worker exits non-zero, dangeresque prints a loud failure banner,
posts a FAIL comment on the issue, finalizes the artifact with
`result: "failure"`, and exits non-zero **without** running the scope check,
the rebase, the reviewer, or any success summary (see the "Hard-stop on
worker failure" section in `src/cli.ts`). The worktree is left in place
for inspection. A failed worker never produces a success artifact.

### The human is the merge gate

Nothing touches the main branch until a human runs
`dangeresque merge <branch>`. `mergeWorktree` (see
`src/worktree.ts:mergeWorktree`) runs `git merge` against the target branch,
verifies that `HEAD` actually moved (a no-op merge is a failure, not a
silent success), and then removes the worktree and branch.
`dangeresque discard <branch>` throws the worktree and branch away entirely,
run artifact included — that's the whole point of discard.

## 4. Observability & Evaluation

For the concise user-facing definitions of evaluation terms, see
`README.md` section "Evaluation." This section keeps the longer design
rationale and implementation tradeoffs.

Each run writes two companion artifacts inside the worktree at
`.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.{md,json}`. The directory
is **gitignored** (`init.ts` adds `.dangeresque/runs/` to `.gitignore` on
first run); artifacts never enter git history. Instead, dangeresque
mirrors them across worktree boundaries by file copy:
`mirrorIssueRuns(srcRoot, destRoot, issueNumber)` (see
`src/worktree.ts:mirrorIssueRuns`) runs project-root → new worktree at
dispatch (so the worker can read prior runs for the same issue) and
worktree → project-root just before worktree teardown on
`dangeresque merge` (so the merged history persists locally). A no-op
`git merge` is therefore the expected success path for INVESTIGATE/VERIFY
runs that produce no code changes — `mergeWorktree` allows
`headBefore == headAfter` and falls through to the mirror step (see
`src/worktree.ts:mergeWorktree` and the `noopMerge` branch).

Why gitignored, not tracked? Run-internal reasoning (worker thought
process, retry logs, tool output excerpts) doesn't belong in
production-branch history; it's debugging signal that lives a different
lifecycle from code. The mirror flow keeps it locally durable across
worktree teardowns without coupling it to merge commits. Cross-machine
sync, if needed, is the user's responsibility (rsync, a separate notes
repo, etc.) — same as build caches or editor configs.

- **The run result file** (`<timestamp>-<MODE>.md`) — the worker's
  narrative output, required to start with a machine-parseable
  `<!-- SUMMARY -->` block and include the `[[PROJECT-RULES-LOADED]]`
  compliance marker (see `config-templates/worker-prompt.md`). The
  reviewer appends its verdict to the same file. Verification (Layer 3)
  appends a `Verify:` line inside the SUMMARY block and a
  `## Verification (pre-review, captured automatically)` body section.
  The worker must NOT `git add` or `git commit` it — `.gitignore` would
  block the stage anyway, and dangeresque does not need it staged because
  the mirror step is what carries it across boundaries.
- **The evaluation JSON** (`<timestamp>-<MODE>.json`) — a structured
  `RunArtifact` (see `src/artifact.ts:RunArtifact`) stamped with the
  current `ARTIFACT_SCHEMA_VERSION` (`"6"` at time of writing; see
  `src/artifact.ts:ARTIFACT_SCHEMA_VERSION`). It captures engine, model,
  worktree name, branch, worker and review phase timings,
  `ResultClassification` (`success`/`partial_success`/`failure`),
  `ReviewerVerdict`, `FailureCategory[]` (including `verification_failed`
  and `scope_outside`), the parsed scope block, the worker's scope
  declaration, the classifier's scope report, the verification result
  array, a one-line summary, and a lifecycle event stream including
  `verify_command_started` / `verify_command_completed` /
  `verification_completed` / `verification_skipped` /
  `scope_check_completed` events. The verdict is extracted from the run
  result markdown with `VERDICT_REGEX` (see
  `src/artifact.ts:VERDICT_REGEX`) so the JSON reflects the same reviewer
  decision a human reads.

The GitHub-issue comment posted after each run carries only the
artifact's `<!-- SUMMARY -->` block plus the local artifact path (see
`src/runner.ts:postRunComment`). The full body never leaves the host —
this is deliberate: the body can include excerpted stderr, tool output,
or other run-internal context that should not be replicated to a
public/team-visible issue thread by default.

Two deliberate disciplines live in the artifact layer:

- **Schema versioning.** `ARTIFACT_SCHEMA_VERSION` (see
  `src/artifact.ts:ARTIFACT_SCHEMA_VERSION`) is stamped on every artifact.
  Pre-1.0, the project rule is **break-and-migrate**: bumping the
  constant is the supported way to evolve the format, and the
  `dangeresque migrate` command (see `src/migrate.ts:migrateArtifact`)
  walks `.dangeresque/runs/issue-*/*.json` to rewrite older artifacts in
  place. Idempotent on already-current files. The shipping value is
  `"6"`; v4 artifacts (predating the scope subsystem) and v5 artifacts
  (predating the `scope_violations` cleanup) both migrate forward in one
  pass. Older or unknown source versions throw rather than silently
  coercing. The matching `dist/build-info.json` records the schema
  version the binary was built against, so a stale binary writing
  wrong-schema artifacts is caught by `dangeresque doctor`'s
  `schema-version` check.
- **Derivation, not duplication.** `result`, `reviewer_verdict`,
  `failure_categories`, and the summary line are all *derived* from worker
  exit code + review phase + archive existence + scope classification +
  verification outcomes + parsed verdict (see
  `src/artifact.ts:deriveResult`, `src/artifact.ts:deriveReviewerVerdict`,
  and `src/artifact.ts:deriveFailureCategories`). The same inputs always
  yield the same outputs, and the derivation functions are unit-testable
  in isolation.

## 5. Engine Abstraction

Dangeresque supports two execution engines: `claude` (default) and `codex`,
selected via `.dangeresque/config.json` `engine` field or
`DANGERESQUE_ENGINE` env var.

**Orchestration is engine-agnostic.** The CLI command surface, the worktree
model, the adversarial reviewer, the artifact schema, and the merge flow
are all identical across engines. The engine split lives in
`src/runner.ts`, where `runWorker` and `runReview` branch between
`src/runner.ts:buildClaudeWorkerArgs` /
`src/runner.ts:buildClaudeReviewArgs` and
`src/runner.ts:buildCodexWorkerArgs` /
`src/runner.ts:buildCodexReviewArgs`.

**The meaningful difference is prompt delivery.**

- **Claude Code** takes the merged canonical + `.local.md` system prompt
  through `--append-system-prompt` (see
  `src/runner.ts:buildClaudeWorkerArgs`). The per-run task description is
  piped via stdin in headless mode; positional argv is used only in the
  interactive fallback. Session IDs are tracked so `dangeresque logs` can
  pretty-print the transcript.
- **Codex** has no system-prompt-file flag, so dangeresque reads merged
  canonical + `.local.md` prompt content and concatenates it with the task
  description plus an effort-hint suffix. The result is piped via stdin
  (`exec -`) rather than argv (see
  `src/runner.ts:buildCodexWorkerArgs`). Codex runs with `--full-auto` —
  its safe automation mode, *not* a dangerous bypass — and streams JSONL
  to a dangeresque-owned log file under `.dangeresque/` inside the
  worktree.

**Effort is not a Codex flag.** `--effort` is Claude-only. Under Codex,
dangeresque passes the effort value as a prompt hint for planning depth
(see `src/runner.ts:buildCodexWorkerArgs`) and the help output adapts per
engine so Claude users see `--effort` and Codex users don't.

**Codex worker commits are owned by dangeresque, not the worker (issue
#38).** Codex runs with `--full-auto` inside a sandbox that explicitly
marks the linked-worktree gitdir at `<main-checkout>/.git/worktrees/<name>/`
as read-only, so `git add` / `git commit` from inside a codex worker always
fail with `Operation not permitted` on `index.lock`. The restriction is
hardcoded in codex-rs and has no public config escape that does not
regress security. Dangeresque's parent Node process has full host
permissions, so after a successful codex worker exit it runs
`commitWorkerChanges` (see `src/runner.ts`) to stage every change in the
worktree — excluding `.dangeresque/runs/` so the artifact stays in its own
follow-up commit — and commit with a message of the form
`codex <MODE> worker: issue #<N>`. Claude workers commit themselves with
their own message; `commitWorkerChanges` is called only in the codex
branch.

The engine abstraction is narrow by design: dangeresque makes the worktree,
permissions, rebase, and review work regardless of which engine executes
the task, but it does not try to paper over every CLI-level difference.

### Engine capability matrix

The engines have first-class parity on orchestration (worktree, rebase,
review, merge) but expose different tool names and configuration surfaces
for the common capabilities a worker reaches for. The table below is the
canonical mapping — prompt authors and scope reviewers should consult it
when a tool does not resolve under one engine.

| Capability                        | claude                                       | codex                                                            |
| --------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Web search                        | `WebSearch` tool (native)                    | `web_search` built-in (default mode: cached)                     |
| Web fetch                         | `WebFetch(url, prompt)` tool (native)        | Shell `curl` (network egress enabled) or MCP server              |
| Effort hint                       | `--effort` flag (native)                     | Prompt-suffix hint (existing)                                    |
| Destructive-command blocking      | `--disallowed-tools Bash(...)`               | `.codex/rules/dangeresque.rules` prefix_rules (#39)              |
| MCP                               | `~/.claude.json` / `.mcp.json` (project)     | `~/.codex/config.toml` / `.codex/config.toml` (project)          |
| Task-prompt delivery              | stdin via pipe in headless (#43)             | stdin via `-` in headless (#35)                                  |
| Network egress from spawned shell | Unrestricted (claude model)                  | Gated by `sandbox_workspace_write.network_access` (this issue)   |

Enabling `sandbox_workspace_write.network_access=true` on the codex worker
widens its blast radius from "workspace-write filesystem only" to
"workspace-write filesystem + unrestricted network egress." The tradeoff
is accepted as parity with claude's existing `WebFetch` allowlist: the
codex worker is already trusted at the content level via `--full-auto`
(and claude's equivalent via `acceptEdits`), so gating its outbound
connections while its file writes are already unrestricted would be a
half-measure. Destructive shell commands remain blocked under both
engines via the existing `disallowedTools` / `dangeresque.rules` paths.

## 6. Known Limitations

These are current gaps, not future plans. They appear here as honest
footnotes on an otherwise-working system.

- **AFK allowlist friction for in-worker build commands.** The default
  `allowedTools` (see `src/config.ts:DEFAULT_CONFIG.allowedTools`) doesn't
  include any build commands. If a project wants the worker itself (not
  just the post-worker verification hook) to run `yarn build`, the
  allowlist has to be extended in `.dangeresque/config.json`. This repo
  does so explicitly with `Bash(yarn build)` and
  `Bash(yarn install --immutable)`. Projects in other ecosystems (Go, Rust,
  Python) face the same ergonomic gap. The verification hook (Layer 3 in
  §3) sidesteps this for the common "did it compile / do tests pass" case
  — it runs CLI-side and is not gated by `allowedTools`.
- **No runtime dependencies.** `package.json` has zero runtime
  dependencies — everything is stdlib plus `child_process` calls to `git`,
  `gh`, `claude`, and `codex`. This is a feature for audit clarity but a
  constraint for features that would otherwise want libraries (argument
  parsing, JSON schema validation, structured logging).

## 7. Scope Contract

The scope subsystem is the project's answer to a recurring failure mode:
worker drifts outside the issue's intent, the diff lands changes the
operator never asked for, and the reviewer ends up arguing about taste
rather than correctness. The subsystem replaces the earlier substring
matcher (which was telemetry-only, see issue #27) with an explicit
contract that the issue, the worker, and the reviewer all consult.

The contract has three inputs and three outputs.

**Inputs:**

1. **Declared scope block** — a fenced ` ```dangeresque-scope``` ` YAML
   block in the issue body or a staged comment, parsed by
   `parseScopeBlocks` (see `src/scope.ts:parseScopeBlocks`). Multiple
   blocks across body + filtered staged comments are unioned; deny wins
   on conflict; quoted values are stripped; `#` comments and blank lines
   inside the block are tolerated. Empty `allow:` is allowed and means
   "no operator-side allow-list" — the worker's declaration is then the
   only positive signal.
2. **Worker scope declaration** — a top-level `## Scope Declaration`
   markdown section in the worker's run result, parsed by
   `parseScopeDeclaration` (see `src/scope.ts:parseScopeDeclaration`).
   Both bullet form (`- \`path\` (category) — rationale`) and table form
   (`| path | category | rationale |`) are accepted. The four legal
   categories are `declared`, `extension`, `opportunistic`, and
   `incidental`. The worker prompt template
   (`config-templates/worker-prompt.md`) is what compels the worker to
   write the section for `IMPLEMENT`/`REFACTOR`/`TEST` modes; the
   prompt-injection lives in `src/runner.ts` so the contract is
   per-mode rather than a single global rule.
3. **Changed-files list** — produced from `git diff --numstat` against
   the worktree base after worker exit (and after the file-count
   normalize step in `src/cli.ts`).

**Outputs (on the artifact JSON):**

- `scope_block` — the parsed declared scope (allow/deny/diagnostics).
- `scope_declaration` — the worker's per-file category + rationale array.
- `scope_report` — the classifier's verdict per file:
  `in_scope` / `extended` / `outside`. Computed by `classifyChanges`
  (see `src/scope.ts:classifyChanges`) and then narrowed by
  `applyOpportunisticBudget` (see `src/cli.ts:applyOpportunisticBudget`).

**Classifier rules** (in order):

1. If a file matches any deny-glob → `outside`. Deny always wins.
2. Else if it matches any allow-glob → `in_scope`.
3. Else if the worker declared it → use the declaration:
   `declared` and `incidental` → `in_scope`; `extension` and
   `opportunistic` → `extended` (with rationale and category preserved).
4. Else → `outside`.

**Budget engine** (three passes, in order, applied to `extended` plus
backfilled `outside`):

1. **Project denyGlobs** (`config.scope.opportunistic.denyGlobs`) demote
   any matching `extended` entry to `outside`. Applies regardless of
   `enabled`, because denyGlobs encode security policy
   (lockfiles, `.env*`, secrets dirs, infra IaC, generated migrations).
2. **`maxFiles` cap** demotes trailing-by-declaration-order
   `opportunistic` entries until the count is within budget.
3. **`maxLines` cap** sums (added + deleted) lines across remaining
   `opportunistic` entries from `git diff --numstat` and demotes
   largest-first until the total is within budget.

`enabled: false` skips passes 2 and 3 but keeps pass 1 — denyGlobs are
unconditional. Defaults are tight on purpose: `maxFiles: 1`,
`maxLines: 20`. The bet is that almost every drive-by worth keeping is a
single small file; everything bigger should split out as a follow-up
issue rather than ride along with an unrelated implementation.

**Authority model.** The reviewer is the scope authority **when it
ran**. The reviewer's prompt
(`config-templates/review-prompt.md`) reads `scope_report` and
`scope_declaration` from the artifact JSON and applies category-specific
scrutiny: `declared` reviewed on correctness only, `extension` on
necessity AND correctness, `opportunistic` REJECT unless strictly
trivial, `outside` REJECT unless justified. When the review pass is
skipped (INVESTIGATE/VERIFY by definition produce no diff worth
reviewing; `--no-review` is the manual override; verification-blocked
runs skip review because reviewing un-compiling code is waste), the
classifier still runs and `scope_outside` becomes a `failure_categories`
entry that downgrades the run to `partial_success` (see
`src/artifact.ts:deriveFailureCategories`). This avoids the failure mode
where a `--no-review` run silently lands an out-of-scope diff with no
operator-visible signal.

**Lifecycle event.** A `scope_check_completed` event with the
`{in_scope, extended, outside}` counts is appended to the artifact's
event stream so downstream consumers (`dangeresque stats`, future
dashboards) can aggregate scope behavior without re-parsing the report.

The result is a contract where the issue says what's in bounds, the
worker says what it actually touched and why, the budget engine
enforces project-level limits on drive-bys, and the reviewer
adjudicates the gray zone — with the failure category as the
fall-through when reviewer is absent.

## 8. Key Design Decisions (the "Why")

Each decision below is a tradeoff, not a default. Listing them with
rationale is the clearest hiring-signal part of this document.

**Worktree-per-run, never worktree-reuse.** `createWorktree` hard-fails if
the target path exists (see `src/runner.ts:createWorktree`). A reusable
worktree would save the cost of creating a fresh branch for each run, but
it would also make run artifacts, lockfiles, and stale modifications bleed
across runs. The failure message directs the user to either `merge` or
`discard` the prior worktree, forcing an explicit decision. **The
tradeoff:** more branches to manage, at the cost of zero cross-run
contamination.

**INVESTIGATE→IMPLEMENT as the canonical flow.** The README documents
`INVESTIGATE → read → discuss → stage → merge → IMPLEMENT` as the
recommended path (see `README.md`). **The tradeoff** is one extra Claude
run per non-trivial task, in exchange for three benefits: the
investigation fails cheaply when the hypothesis is wrong, the human sees
the analysis before authorizing changes, and the IMPLEMENT worker reads
the INVESTIGATE artifact from prior merges as context. For well-scoped
issues the user can still jump straight to IMPLEMENT — the flow is a
default, not a gate.

**Staged comments as first-class worker input.**
`dangeresque stage <N> --comment "..." --mode MODE` posts a `**[staged`
comment on the issue, which the prompt builder (see
`src/runner.ts:formatIssueComments`) always includes in the worker's
context alongside the issue body. Old `**[dangeresque` run-summary
comments are filtered out: those carry only the SUMMARY block, and the
worker reads the full prior-run body from the locally-mirrored
`.dangeresque/runs/issue-<N>/` directory instead. Untagged human comments
are trimmed to the last three. **The tradeoff** is ceding some
comment-filter visibility to the CLI, in exchange for a structured way to
steer the next run without editing the issue body.

**Canonical/`.local.md` overlay for prompts.** `.dangeresque/*.md` canonical
files (`worker-prompt.md`, `review-prompt.md`, `AFK_WORKER_RULES.md`) are
overwritten on every `dangeresque init`; project-specific overrides live
in the `.local.md` companion and are concatenated at spawn time by
`src/runner.ts:readPromptWithLocal`. **The tradeoff:** a clean upgrade
path — shipped prompt improvements reach existing projects on the next
`init` — while preserving user customization. `DANGERESQUE.md` applies
the same pattern at the workflow-primer level: the
`<!-- DANGERESQUE-START -->` pointer block in `CLAUDE.md` is the
bootstrap glue that routes both interactive and AFK sessions to the
canonical primer, which itself is overwritten on every `init`.

**`[[PROJECT-RULES-LOADED]]` as a compliance marker.** The worker prompt
instructs the AFK worker to read `CLAUDE.md` or `AGENTS.md` at startup and
drop `[[PROJECT-RULES-LOADED]]` into the run result to confirm (see
`config-templates/worker-prompt.md`). **The tradeoff:** this is a
dead-simple probe for one of the most common silent failures — a worker
that skipped the project rules and proceeded on vibes. It's not foolproof
(a worker could in principle emit the marker without actually reading the
rules), but it's cheap and flags the obvious case where the marker is
missing.

**Personal infrastructure, not published to npm.** The `package.json`
`bin` field points at `./dist/cli.js` and there's no `"publishConfig"` —
the CLI is installed globally by cloning the repo and running `npm link`
(see `README.md`'s Install section). **The tradeoff:** no
`npx dangeresque`, no semver negotiation with external users, no API
stability burden. In exchange, the maintainer can iterate on the CLI
surface and artifact schema without breaking anyone else's workflow, and
all per-project config lives inside each project's checked-in
`.dangeresque/` directory.

---

## Reading this alongside the code

Everything above is derivable from the files in this repo. If a claim here
ever drifts from the code, trust the code. The file:line anchors exist so a
new contributor can follow any assertion back to its implementation in one
click. When the implementation changes, this document should change with
it — not ship separate versioned narratives about what the code *used to*
do.
