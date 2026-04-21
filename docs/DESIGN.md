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

**Anthropic's usage policy** (see `README.md:9`) now restricts running
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
  `allowedTools`/`disallowedTools` patterns (see `src/config.ts:44-75`).
  Every destructive git command the worker might reach for — `git push`,
  `git reset --hard`, `git branch -D`, and `rm -rf` — is hard-blocked at
  the Claude Code tool layer, regardless of what the prompt says.

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
carry more weight. It does, in four layers.

### Layer 1 — Worktree Isolation

Every run creates a fresh worktree at `.claude/worktrees/dangeresque-<name>/`
on branch `worktree-dangeresque-<name>`. `createWorktree` (see
`src/runner.ts:387-417`) hard-fails if the target path already exists — there
is no silent reuse. If a prior run wasn't merged or discarded, the CLI errors
out and instructs the user to clean up first. The worktree is created from
`origin/HEAD`, not local `HEAD`, so the worker always starts from what the
remote considers the current tip (this also catches the "local main is ahead
of origin" case with a warning; see `src/runner.ts:367-381`).

### Layer 2 — Permission Allowlist

Claude Code is launched with `--permission-mode acceptEdits` and explicit
`--allowed-tools`/`--disallowed-tools` flags. The defaults (see
`src/config.ts:44-75`) allow read/write inside the repo,
`git status|diff|log|add|commit|branch`, MCP servers, and web access. They
explicitly disallow `git push`, `git reset --hard`, `git branch -D`, and
`rm -rf`. Projects extend the allowlist through `.dangeresque/config.json` —
for example, this repo adds `Bash(yarn build)` and
`Bash(yarn install --immutable)` so TypeScript workers can verify their code
compiles without being allowed to mutate `package.json`.

### Layer 3 — Adversarial Reviewer

After the worker finishes (and the worktree is rebased onto the latest
`origin/main`, see below), a second Claude or Codex session runs with
`config-templates/review-prompt.md` as its system prompt. The reviewer's job
is not to rubber-stamp the worker; the prompt explicitly instructs it to
"verify the worker's actual code changes, not rubber-stamp its narrative"
(see `config-templates/review-prompt.md:3`). It runs `git diff main` as
ground truth, reads the worker's run result as a *claims document*, and
appends a verdict (`ACCEPT`, `REJECT`, or `NEEDS_HUMAN_REVIEW`) that
dangeresque later extracts with a regex (see `src/artifact.ts:243`). The
reviewer's file-count integrity check (see
`config-templates/review-prompt.md:43`) is an **automatic FAIL** if the
worker's claimed file list doesn't match
`git diff main --name-only` (minus auto-committed artifacts). This is the
primary defense against a worker concealing changes.

Review is skipped for modes that by definition produce no code changes:
INVESTIGATE and VERIFY (see `src/cli.ts:408-409`). Spending Claude calls
reviewing an empty diff is waste, and a skipped review is recorded in the
run artifact with a reason so it's visible downstream.

### Layer 4 — Rebase Before Review

Between worker and reviewer, the worktree is rebased onto `origin/main` (see
`src/cli.ts:383-406`). This matters because multiple workers can run in
parallel on different issues, and another worker's branch may have merged
to main since this worktree was created. Without the rebase, `git diff main`
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
the rebase, the reviewer, or any success summary (see `src/cli.ts:309-347`).
The worktree is left in place for inspection. A failed worker never produces
a success artifact.

### The human is the merge gate

Nothing touches the main branch until a human runs
`dangeresque merge <branch>`. `mergeWorktree` (see
`src/worktree.ts:244-297`) runs `git merge` against the target branch,
verifies that `HEAD` actually moved (a no-op merge is a failure, not a
silent success), and then removes the worktree and branch.
`dangeresque discard <branch>` throws the worktree and branch away entirely,
run artifact included — that's the whole point of discard.

## 4. Observability & Evaluation

Each run writes two companion artifacts inside the worktree, both committed
on the worker's branch so they flow through normal merge:

- **The run result file**
  (`.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md`) — the worker's
  narrative output, required to start with a machine-parseable
  `<!-- SUMMARY -->` block and include the `[[PROJECT-RULES-LOADED]]`
  compliance marker (see `config-templates/worker-prompt.md:17`). The
  reviewer appends its verdict to the same file. Dangeresque commits it
  automatically; the worker should not stage or commit it.
- **The evaluation JSON**
  (`.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.json`) — a structured
  `RunArtifact` (see `src/artifact.ts:45-71`) capturing engine, model,
  worktree name, branch, worker and review phase timings,
  `ResultClassification` (`success`/`partial_success`/`failure`),
  `ReviewerVerdict`, `FailureCategory[]`, scope violations, a one-line
  summary, and a lifecycle event stream. The verdict is extracted from the
  run result markdown with `VERDICT_REGEX` (see `src/artifact.ts:243`) so
  the JSON reflects the same reviewer decision a human reads.

Two deliberate disciplines live in the artifact layer:

- **Schema versioning.** `ARTIFACT_SCHEMA_VERSION` (see
  `src/artifact.ts:7`) is stamped on every artifact. The project rule is
  that additive schema changes must bump this constant so downstream
  consumers can branch on it. Committing the evaluation JSON into the
  branch alongside the run result makes cross-run aggregation tractable for
  any future stats tool — it can read past JSON files directly from git
  history and reject or migrate older schema versions instead of silently
  coercing fields whose meanings changed.
- **Derivation, not duplication.** `result`, `reviewer_verdict`,
  `failure_categories`, and the summary line are all *derived* from worker
  exit code + review phase + archive existence + scope violations + parsed
  verdict (see `src/artifact.ts:255-327`). The same inputs always yield
  the same outputs, and the derivation functions are unit-testable in
  isolation.

## 5. Engine Abstraction

Dangeresque supports two execution engines: `claude` (default) and `codex`,
selected via `.dangeresque/config.json` `engine` field or
`DANGERESQUE_ENGINE` env var.

**Orchestration is engine-agnostic.** The CLI command surface, the worktree
model, the adversarial reviewer, the artifact schema, and the merge flow
are all identical across engines. The engine split lives in
`src/runner.ts`, where `runWorker` and `runReview` branch between
`buildClaudeWorkerArgs`/`buildClaudeReviewArgs` (see
`src/runner.ts:195-284`) and `buildCodexWorkerArgs`/`buildCodexReviewArgs`
(see `src/runner.ts:311-361`).

**The meaningful difference is prompt delivery.**

- **Claude Code** takes the worker system prompt through
  `--append-system-prompt-file` (see `src/runner.ts:214-215`) and the
  per-run task description as a positional argument. Session IDs are
  tracked so `dangeresque logs` can pretty-print the transcript.
- **Codex** has no system-prompt-file flag, so dangeresque reads the prompt
  file and concatenates it with the task description into a single
  positional prompt (see `src/runner.ts:311-328`). Codex runs with
  `--full-auto` — its safe automation mode, *not* a dangerous bypass — and
  streams JSONL to a dangeresque-owned log file under `.dangeresque/`
  inside the worktree.

**Effort is not a Codex flag.** `--effort` is Claude-only. Under Codex,
dangeresque passes the effort value as a prompt hint for planning depth
(see `src/runner.ts:319`) and the help output adapts per engine so Claude
users see `--effort` and Codex users don't.

The engine abstraction is narrow by design: dangeresque makes the worktree,
permissions, rebase, and review work regardless of which engine executes
the task, but it does not try to paper over every CLI-level difference.

## 6. Known Limitations

These are current gaps, not future plans. They appear here as honest
footnotes on an otherwise-working system.

- **Scope-check is telemetry, not authority (issue #27).** The post-worker
  scope check (see `src/cli.ts:363-394`) does a substring match of changed
  files against the issue body plus filtered comments. It cannot infer
  test paths from "add tests" language, cannot expand globs, and cannot
  cross-reference an INVESTIGATE artifact. When it fires, it still records
  `scope_violations[]` on the artifact and prints a stdout warning, but it
  does NOT downgrade the run's `result` classification when the
  adversarial reviewer accepted — the reviewer is the authority on scope
  (ONE-PATH). Only when the reviewer was skipped (e.g. `--no-review`) do
  scope violations still mark the run `partial_success`.
  `scope_violations[]` stays on the artifact as diagnostic signal for
  humans triaging borderline runs.
- **AFK allowlist friction for build commands.** The default `allowedTools`
  (see `src/config.ts:50-65`) doesn't include any build commands. For a
  TypeScript project where workers want to run `yarn build` to verify
  their changes compile, the allowlist must be extended in
  `.dangeresque/config.json`. This repo does so explicitly with
  `Bash(yarn build)` and `Bash(yarn install --immutable)`. Projects in
  other ecosystems (Go, Rust, Python) face the same ergonomic gap.
- **Small test surface.** The `test/` directory currently contains a
  single fixture (`test/fixtures/`). There is no test runner installed;
  `package.json` lists only `typescript` and `@types/node` as
  `devDependencies`. Schema versioning, verdict parsing, slug parsing,
  the staged-comment filter in `formatIssueComments`, and the derivation
  functions in `src/artifact.ts` are all unit-testable and should be
  tested. This is a gap, not a deliberate minimalism.
- **No runtime dependencies.** `package.json` has zero runtime
  dependencies — everything is stdlib plus `child_process` calls to `git`,
  `gh`, `claude`, and `codex`. This is a feature for audit clarity but a
  constraint for features that would otherwise want libraries (argument
  parsing, JSON schema validation, structured logging).

## 7. Key Design Decisions (the "Why")

Each decision below is a tradeoff, not a default. Listing them with
rationale is the clearest hiring-signal part of this document.

**Worktree-per-run, never worktree-reuse.** `createWorktree` hard-fails if
the target path exists (see `src/runner.ts:389-397`). A reusable worktree
would save the cost of creating a fresh branch for each run, but it would
also make run artifacts, lockfiles, and stale modifications bleed across
runs. The failure message directs the user to either `merge` or `discard`
the prior worktree, forcing an explicit decision. **The tradeoff:** more
branches to manage, at the cost of zero cross-run contamination.

**INVESTIGATE→IMPLEMENT as the canonical flow.** The README documents
`INVESTIGATE → read → discuss → stage → merge → IMPLEMENT` as the
recommended path (see `README.md:137`). **The tradeoff** is one extra
Claude run per non-trivial task, in exchange for three benefits: the
investigation fails cheaply when the hypothesis is wrong, the human sees
the analysis before authorizing changes, and the IMPLEMENT worker reads
the INVESTIGATE artifact from prior merges as context. For well-scoped
issues the user can still jump straight to IMPLEMENT — the flow is a
default, not a gate.

**Staged comments as first-class worker input.**
`dangeresque stage <N> --comment "..." --mode MODE` posts a `**[staged`
comment on the issue, which the prompt builder (`formatIssueComments`, see
`src/runner.ts:153-169`) always includes in the worker's context alongside
the issue body. Old `**[dangeresque` run-result comments are filtered out
(they duplicate the tracked artifact files). Untagged human comments are
trimmed to the last three. **The tradeoff** is ceding some comment-filter
visibility to the CLI, in exchange for a structured way to steer the next
run without editing the issue body.

**`[[PROJECT-RULES-LOADED]]` as a compliance marker.** The worker prompt
instructs the AFK worker to read `CLAUDE.md` or `AGENTS.md` at startup and
drop `[[PROJECT-RULES-LOADED]]` into the run result to confirm (see
`config-templates/worker-prompt.md:17`). **The tradeoff:** this is a
dead-simple probe for one of the most common silent failures — a worker
that skipped the project rules and proceeded on vibes. It's not foolproof
(a worker could in principle emit the marker without actually reading the
rules), but it's cheap and flags the obvious case where the marker is
missing.

**Personal infrastructure, not published to npm.** The `package.json`
`bin` field points at `./dist/cli.js` and there's no `"publishConfig"` —
the CLI is installed globally by cloning the repo and running `npm link`
(see `README.md:49-59`). **The tradeoff:** no `npx dangeresque`, no semver
negotiation with external users, no API stability burden. In exchange, the
maintainer can iterate on the CLI surface and artifact schema without
breaking anyone else's workflow, and all per-project config lives inside
each project's checked-in `.dangeresque/` directory.

---

## Reading this alongside the code

Everything above is derivable from the files in this repo. If a claim here
ever drifts from the code, trust the code. The file:line anchors exist so a
new contributor can follow any assertion back to its implementation in one
click. When the implementation changes, this document should change with
it — not ship separate versioned narratives about what the code *used to*
do.
