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
single exception is explicit and separately named: `dangeresque resume`
(`resumeWorker`) re-enters ONE existing worktree to continue a worker that
died there, and it is a distinct entry point rather than a flag on
`createWorktree` precisely so `run` can never quietly land in an existing
tree (see [Crash recovery](#crash-recovery-two-independently-re-runnable-phases)). The
worktree is created from `origin/HEAD`, not local `HEAD`, so the worker
always starts from what the remote considers the current tip (this also
catches the "local main is ahead of origin" case with a warning; see
`src/runner.ts:checkRemoteBehind`).

### Layer 2 — Permission Allowlist

Workers are launched with `--permission-mode acceptEdits` (claude) or
`-s workspace-write -c approval_policy=never` (codex) plus engine-specific command-gating derived from the
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

### Layer 5 — Capture, Then Rebase Before Review

**Capture comes first.** The very first thing `runPostWorkerPhases` does is
commit whatever the worker left uncommitted (`captureWorkerChanges` in
`src/runner.ts`). Everything downstream of that line reads *commits* — the
scope check's three-dot diff, the rebase, and ultimately `git merge` — while
the reviewer and the file-count normalizer read the *working tree*. If those
two views disagree, a reviewer can ACCEPT a diff that ships nothing, which is
exactly what issue #93 was: three runs where a worker's own `git commit` was
refused, and the accepted diff sat in the worktree with the branch carrying
zero commits. Capture is idempotent — a worker that committed its own work
stages nothing — and runs for both engines, so `dangeresque review` gets it
too.

Between worker and reviewer, the worktree is then rebased onto `origin/main`
(`rebaseWorktreeOntoOrigin` in `src/worktree.ts`). This matters because
multiple workers can run in parallel on different issues, and another worker's
branch may have merged to main since this worktree was created. Without the
rebase, `git diff main` would show *this* worker's changes plus the diff from
whatever branches landed in the meantime, and the reviewer would misread
unrelated merges as scope violations or regressions.

Each way a rebase can fail to happen is recorded as itself, because they call
for different responses and used to be collapsed into one:

| Outcome | Lifecycle event | Failure category |
| --- | --- | --- |
| Rebased | `rebase_completed` | — |
| Tree still dirty after capture (git refuses to *start* a rebase) | `rebase_skipped` (`reason: dirty_worktree`) | `uncommitted_worker_changes` |
| `git fetch origin main` failed (no remote, offline) | `rebase_skipped` (`reason: fetch_failed`) | — |
| Real conflict, rebase aborted | `rebase_failed` (`conflict: true`) | `rebase_conflict` |
| git refused for another reason | `rebase_failed` (`conflict: false`) | — |

In every case the reviewer sees the pre-rebase diff and no work is silently
lost. A run that reaches the end with work outside its commits can never be
classified `success` — see `uncommitted_worker_changes` in `src/artifact.ts`.

### Hard stop on worker failure

If the worker exits non-zero, dangeresque prints a loud failure banner,
posts a FAIL comment on the issue, finalizes the artifact with
`result: "failure"`, and exits non-zero **without** running the scope check,
the rebase, the reviewer, or any success summary (see the "Hard-stop on
worker failure" section in `src/cli.ts`). The worktree is left in place
for inspection. A failed worker never produces a success artifact.

### Crash recovery: two independently re-runnable phases

A run has two expensive phases and either can die on its own. Both are
recoverable without re-dispatching the other, through one verb each. The
verbs are mutually exclusive by construction — `review` requires a worker that
FINISHED, `resume` requires one that did NOT — so each refuses the other's
case and names the verb that actually applies.

**The review died.** The worker succeeded and committed its work, then the
review pass died without a verdict: an outside SIGTERM reaping the process
group, a session teardown, a transient engine error. That run cannot merge
(the gate has no verdict to read), but the expensive part is already done, so
forcing a full re-dispatch would burn the whole cost to recover from a small
failure.

Two mechanisms make that recoverable:

1. **Artifact checkpoints.** The eval JSON is written after the worker phase
   and again immediately before the review dispatch, not only at process exit.
   A kill in that window now leaves a readable artifact describing exactly how
   far the run got, instead of nothing at all.
2. **`dangeresque review <branch>`** (`cmdReview` in `src/cli.ts`) replays the
   post-worker pipeline against the existing worktree: scope check, rebase,
   summary normalization, verification, review, artifact write.

Both `run` and `review` call the *same* `runPostWorkerPhases` — a rescued
review is byte-for-byte the same pipeline as an in-line one, so no gate can be
weaker on the recovery path. The eligibility policy lives in `src/rescue.ts`
(`assessReviewRescue`) and is deliberately narrow: it refuses a run whose
worker failed, whose block-policy verification failed, whose mode never
reviews, or which already carries a verdict. That last refusal is what keeps
this crash recovery rather than a "review until it passes" loop; `--force`
overrides it and records the overridden verdict in the artifact.

An abnormal review exit (killed by a signal, or an operator stop) is reported
as loudly as a worker failure — banner, an issue comment that says REVIEW
INCOMPLETE and names the recovery command, and a non-zero exit. Previously
this surfaced only as a footnote under a success-shaped summary, which read
like a finished run.

**The worker died (issue #110).** The mirror-image failure, and the more
expensive one: the worker hits the engine's usage limit or loses its session
hours into the task, before it could commit anything. The hard-stop path
above deliberately preserves that state — no capture, no rebase, worktree
left in place — so the entire diff survives, uncommitted, in the worktree.
Until `resume` existed there was no verb that could get back into it: the
pre-flight gate refused a same-issue dispatch, `createWorktree` refused the
same name even under `--force`, and `discard` deleted the diff. The only
remaining exit was reaching into the worktree by hand, which every consumer's
worker rules forbid.

**`dangeresque resume <branch>`** (`cmdResume` → `resumeWorker`) dispatches a
new worker attempt into that worktree:

- The tree is left exactly as the dead worker left it — no rebase, no stash,
  no reset. The dirty tree IS the thing being recovered. It is safe because
  the pre-flight gate has already refused a stale local main, and
  `runPostWorkerPhases` captures the accumulated tree into a commit and
  rebases *that* onto current `origin/main` before the reviewer reads it.
- One dynamic `Resume Context` block is appended to the worker prompt by
  `buildTaskPrompt`, naming the dead attempt's artifact and instructing the
  worker to continue rather than restart. Both engines compose their prompt
  through that function, so one block reaches claude and codex alike.
- `runWorker` and `resumeWorker` share one private executor
  (`executeWorkerPhase`), and `run` and `resume` share one completion path
  (`completeWorkerRun` → `runPostWorkerPhases`). The only difference between
  the two verbs is which of them produced the worktree.
- The resumed run gets a NEW `run_id` and records `resumed_from` (the prior
  artifact's basename) plus a `worker_resumed` lifecycle event. A review
  rescue keeps its `run_id` because it continues the same worker attempt; a
  resume is a second billable engine attempt and must count as its own run.

Eligibility lives in `src/rescue.ts` (`assessWorkerResume`) and is
unconditional — there is no `--force` lane, because every refusal describes a
tree where resuming would destroy live work or re-run a worker that already
finished. `--force` on this verb reaches the pre-flight and dispatch gates
only.

The subtle part is *attribution*, handled by `locateCurrentAttempt`. Dispatch
mirrors an issue's prior runs into every worktree, so the newest same-mode
artifact on disk is frequently a COPY of an earlier merged run. Selecting it
would resume the wrong work and defeat the "no artifact ⇒ refuse" rule
entirely. The ladder therefore runs strongest-first — the stale PID file's
recorded archive, then an eval JSON whose branch/issue/mode are this run's,
then a legacy markdown only when no JSON in the directory contradicts this
branch and the file is not also present in the project root (a file in both
roots was mirrored in at dispatch, by definition). No rung matching means
refuse.

Pre-flight is widened rather than bypassed. `runPreflightChecks` takes a
`PreflightIntent`: a `fresh` dispatch wants zero same-issue worktrees, a
`resume` wants exactly one and it must be the named branch. A second
same-issue worktree still refuses on both paths, and the stale-main gate is
unchanged. The gate was never "no worktree may exist" — it was always "the
worktree state must match the dispatch", and making the intent explicit is
what lets the recovery path keep a real gate instead of `--force`-ing through
one asking the wrong question.

### The human is the merge gate

Nothing touches the main branch until a human runs
`dangeresque merge <branch>`. `mergeWorktree` (see
`src/worktree.ts:mergeWorktree`) runs `git merge` against the target branch,
verifies that `HEAD` actually moved (a no-op merge is a failure, not a
silent success), and then removes the worktree and branch.
`dangeresque discard <branch>` throws the worktree and branch away entirely,
run artifact included — that's the whole point of discard.

**Merge refuses over uncommitted work (issue #93).** Before the `git merge`,
`mergeWorktree` asks `uncommittedPaths` whether the worktree still holds work
no commit carries, and refuses (`gateRefusal`, exit 2) if it does — listing
the paths and naming the rescue: commit them on the worker branch, merge
again. This is a data-loss gate, so it fails closed: if `git status` itself
cannot be read, the merge is refused rather than assumed safe. The refusal
runs *before* the merge precisely so the recovery is trivial; the old
behavior merged nothing, reported "No commits merged" as success, then failed
worktree cleanup and advised `git worktree remove --force`, which would have
deleted the accepted diff. That advice is now conditional: over a dirty
worktree the message says the opposite, in as many words.

## 4. Observability & Evaluation

For the concise user-facing definitions of evaluation terms, see
[`docs/SCHEMA.md` section "Evaluation"](SCHEMA.md#evaluation). This section
keeps the longer design rationale and implementation tradeoffs.

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

Dangeresque supports two execution engines: `claude` and `codex`. Worker and
reviewer are independent execution phases, selected under `worker` and `review`
in `.dangeresque/config.json` or with phase-specific CLI/environment overrides.
`engineDefaults` stores one standing model/effort pin per provider. An engine-only
override selects that provider's pin; it never carries a model or effort from the
previous provider. Phase-specific model/effort values remain the highest-precedence
config values, followed by the selected engine default.

**Orchestration is engine-agnostic.** The CLI command surface, the worktree
model, the adversarial reviewer, the artifact schema, and the merge flow
are all identical across engines. `src/config.ts:resolveRunPlan` resolves both
phases once. A narrow adapter seam in `src/runner.ts` selects between
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
  description. The result is piped via stdin
  (`exec -`) rather than argv (see
  `src/runner.ts:buildCodexWorkerArgs`). Codex runs with `-s workspace-write -c approval_policy=never` —
  its safe automation mode, *not* a dangerous bypass — and streams JSONL
  to a dangeresque-owned log file under `.dangeresque/` inside the
  worktree.

**Effort is native for both engines.** Claude receives `--effort`; Codex
receives `-c model_reasoning_effort="<effort>"`. Before dispatch, dangeresque
validates every scheduled Codex phase against the installed model catalog.
Unsupported pairs and `ultra` fail loudly.

**Worker commits are owned by dangeresque, not the worker (issues #38,
#93).** Neither engine can be relied on to commit its own output, for
different reasons:

- **codex** runs with `-s workspace-write -c approval_policy=never` inside a sandbox that explicitly marks
  the linked-worktree gitdir at `<main-checkout>/.git/worktrees/<name>/` as
  read-only, so `git add` / `git commit` from inside a codex worker always
  fail with `Operation not permitted` on `index.lock`. The restriction is
  hardcoded in codex-rs and has no public config escape that does not regress
  security. This is true of every codex run.
- **claude** workers usually self-commit, but a commit command the permission
  layer refuses leaves the entire diff in the working tree. Command
  substitution (`$(...)`) is rejected before allowlist matching and therefore
  cannot be granted by any `allowedTools` entry — and the canonical form for
  a multi-line commit message is `git commit -m "$(cat <<'EOF' … EOF)"`.
  Three bubble-craps runs ended with an accepted diff and a branch carrying
  zero commits.

Dangeresque's parent Node process has full host permissions, so
`captureWorkerChanges` (see `src/runner.ts`) stages every change in the
worktree — excluding `.dangeresque/runs/`, the injected `.codex/` session
state, and the PID file — and commits it with a message of the form
`dangeresque: capture <engine> <MODE> worker output for issue #<N>`. It runs
for both engines as the first step of `runPostWorkerPhases`, and it is a
no-op on a worker that already committed its own work.

The engine seam is narrow by design: adapters own preparation, invocation,
prompt delivery, and log/session receipts. Core orchestration owns worktrees,
verification, phase order, artifacts, and merge behavior. This permits all
four worker/reviewer engine pairings without pretending CLI details are equal.

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
| Reasoning effort                  | `--effort` flag (native)                     | `model_reasoning_effort` config override (native)                |
| Destructive-command blocking      | `--disallowed-tools Bash(...)`               | `.codex/rules/dangeresque.rules` prefix_rules (#39)              |
| MCP                               | `~/.claude.json` / `.mcp.json` (project)     | `~/.codex/config.toml` / `.codex/config.toml` (project)          |
| Task-prompt delivery              | stdin via pipe in headless (#43)             | stdin via `-` in headless (#35)                                  |
| Network egress from spawned shell | Unrestricted (claude model)                  | Gated by `sandbox_workspace_write.network_access` (this issue)   |

Enabling `sandbox_workspace_write.network_access=true` on the codex worker
widens its blast radius from "workspace-write filesystem only" to
"workspace-write filesystem + unrestricted network egress." The tradeoff
is accepted as parity with claude's existing `WebFetch` allowlist: the
codex worker is already trusted at the content level via `-s workspace-write -c approval_policy=never`
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

**Worktree-per-run, never implicit worktree-reuse.** `createWorktree`
hard-fails if the target path exists (see `src/runner.ts:createWorktree`). A
reusable worktree would save the cost of creating a fresh branch for each
run, but it would also make run artifacts, lockfiles, and stale
modifications bleed across runs. The failure message directs the user to
`merge`, `discard`, or — when the prior worker died mid-task — `resume` the
prior worktree, forcing an explicit decision. **The tradeoff:** more
branches to manage, at the cost of zero cross-run contamination.

Reuse is available in exactly one shape: `dangeresque resume`, a separate
verb with its own entry point (`resumeWorker`), its own eligibility policy,
and its own pre-flight intent. It was implemented that way rather than as
`run --resume` deliberately. `run` is issue-centric and guarantees a fresh
branch; `resume` is branch-centric and guarantees reuse of one existing
checkout. Collapsing them would have meant a conditional inside
`createWorktree`, which is exactly the silent-reuse door this decision
closes. **The tradeoff:** one more verb on the command surface, in exchange
for the two lifecycle transitions staying mutually exclusive and legible.

**INVESTIGATE→IMPLEMENT as the canonical flow.** The
`INVESTIGATE → read → discuss → stage → merge → IMPLEMENT` path is the
recommended sequence (see [`docs/WORKFLOW.md`](WORKFLOW.md)). **The
tradeoff** is one extra Claude run per non-trivial task, in exchange for
three benefits: the
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
