# Dangeresque Workflow

Dangeresque runs AI coding agents (Claude Code or Codex) AFK in isolated git
worktrees with a human-gated merge. **This brief covers the workflow loop
only — the full command surface and flags live in `dangeresque --help`,
auto-generated from the CLI definition so it never goes stale.** Read both
to drive dangeresque end-to-end.

### Honest Scoping

- Stay inside the GitHub Issue. Do not widen scope.
- If blocked, stop and report. Do not invent requirements.
- Never say "fixed" or "done". Use allowed status language from `.dangeresque/AFK_WORKER_RULES.md`.

## The Standard Loop

```
INVESTIGATE → read → discuss → stage → merge → push →
IMPLEMENT   → read → discuss → merge → push → (VERIFY)
```

**Every issue starts with INVESTIGATE.** Even a "trivial one-liner"
gets an INVESTIGATE first — it independently verifies the hypothesis, surfaces
side-effects you missed, and lands a research artifact that the IMPLEMENT can
cite. Skipping INVESTIGATE is the most common way a run goes wrong. You may only skip INVESTIGATE
after getting sign-off by the user for an edge case.

**Merge keeps the run report. Discard deletes it.** That asymmetry is the
only difference between the two cleanup paths worth memorizing — see
[Merging or Discarding](#merging-or-discarding) for the artifact mirror flow.

## The One Hard Rule

**Push `main` to origin AFTER every merge, BEFORE dispatching the next run.**
Worktrees branch from `origin/main`. If local main is ahead of origin, the
next worker starts stale and the reviewer flags phantom regressions.

## Creating Issues

Workers read the GitHub Issue title, body, and selected comments as their
assignment. Good issues are bounded — one slice of work, not an entire feature.
Use this template (the `dangeresque-create-issue` skill produces the same shape):

```markdown
## Mode
<INVESTIGATE | IMPLEMENT | VERIFY | REFACTOR | TEST | custom>

## Goal
<what the worker should accomplish — one or two sentences>

## Hypothesis
<root cause guess, or "None — open investigation">

## Likely Files
- `path/to/file.ts` — reason
- `path/to/other.ts` — reason

## Verification Criteria
- [ ] criterion 1
- [ ] criterion 2

## Severity
<blocking | degraded | cosmetic>
```

Create with `gh issue create --label dangeresque --title "…" --body "…"`.

## Scope

Two complementary contracts bound what a worker is allowed to touch:

1. **Issue-side allow/deny block** — optional fenced `dangeresque-scope` YAML
   block in the issue body or a `[staged]` comment. Lists `allow:` and
   `deny:` globs (Node `path.matchesGlob`). Multiple blocks across body +
   staged comments are unioned; deny wins on conflict. See README §Scope for
   syntax + examples.
2. **Worker-side `## Scope Declaration`** — REQUIRED in IMPLEMENT/REFACTOR/TEST
   run results. Every changed file gets one of four categories:
   `declared` (matched the allow-list), `extension` (helper required to
   finish the Goal), `opportunistic` (drive-by, capped per project via
   `scope.opportunistic` in `.dangeresque/config.json`), or `incidental`
   (auto-touched). See `.dangeresque/AFK_WORKER_RULES.md` and
   `.dangeresque/worker-prompt.md` for the format.

The classifier turns both signals into `scope_report` ∈ {in_scope, extended,
outside} on the run artifact. The reviewer treats `outside` as
REJECT-unless-justified.

## Dispatching a Run

```bash
dangeresque run --issue <N>                    # default mode: INVESTIGATE
dangeresque run --issue <N> --mode IMPLEMENT
dangeresque run --issue <N> --no-verify        # skip pre-review compile/test/lint
```

Worker + (optional) verification + review run automatically. The verification
hook (configured per project under `verify` in `.dangeresque/config.json`)
runs compile/test/lint commands in the worktree post-rebase, pre-review;
block-style failures skip the review pass and mark the run `failure` with
category `verification_failed`. Review is also skipped for INVESTIGATE and
VERIFY (no code changes) and by `--no-review`. A macOS notification fires
when complete. Nothing touches main until you run `dangeresque merge`.

**Don't truncate or close the orchestrator's stdout.** `dangeresque run` is a
long-running orchestrator that streams output across multiple phases — worker
session → pre-review verification → review session → JSON eval write. Piping
its stdout through a truncating tool (`| head`, `| grep -m`, `| awk 'NR==N{exit}'`)
or otherwise closing the pipe early triggers SIGPIPE when the orchestrator
tries to write later phases. The worker's commit and run-result MD survive
(those happen first), but verify hooks, the review pass, and the JSON eval
write die — leaving you with a worktree that looks done but never got
reviewed. Always let stdout stream fully. If you need to background the run,
capture stdout to a file and read it when complete; don't apply any pipeline
that can exit before the orchestrator does.

After each run, dangeresque posts ONE comment on the GitHub Issue containing
only the artifact's `<!-- SUMMARY -->` block plus the local artifact path.
The full body never leaves the host — read it via
`dangeresque results --issue <N>` or directly at
`.dangeresque/runs/issue-<N>/`.

## Reading Results

```bash
dangeresque results <short-branch>     # e.g. investigate-63 — active worktree
dangeresque results --issue <N>        # latest archived run for an issue
dangeresque results --issue <N> --all  # full history
```

Run artifacts live at `.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md` —
one file per run. The runs directory is gitignored; dangeresque mirrors
prior runs into each new worktree at dispatch and back to the project root
on `dangeresque merge`. Read only the newest if you need prior context;
do not read all of them.

## Staging Guidance

Add structured context before the next run:

```bash
dangeresque stage <N> --comment "root cause confirmed; use approach A" --mode IMPLEMENT
```

The `[staged]` comment becomes part of the next worker's prompt. This is how
you steer an AFK worker without being present.

## Merging or Discarding

```bash
dangeresque merge <short-branch>            # merge worktree; KEEPS the run report under .dangeresque/runs/
dangeresque discard <short-branch>          # drop worktree + branch; DELETES the run report along with the worktree
dangeresque discard <short-branch> --force  # also stop a running worker first, then discard
```

Merge brings any code changes into main via `git merge`. The run result
file is gitignored — it does NOT flow through `git merge`. On merge,
dangeresque mirrors it from the worktree to the project root just before
tearing the worktree down, and mirrors prior artifacts into the next
worktree on dispatch. **Discard is destructive**: the worktree's run
report goes with it. For a no-diff INVESTIGATE you almost always want
`merge` (no-op git merge + artifact preserved), not `discard`. Then
push main to origin before your next dispatch — see The One Hard Rule.

## Monitoring a Run

```bash
dangeresque status                         # list active worktrees + worker liveness
dangeresque logs <short-branch>            # snapshot transcript + exit
dangeresque logs <short-branch> -f         # follow live output
dangeresque logs <short-branch> --review   # review pass transcript
dangeresque stop <short-branch>            # stop a running worker; leaves worktree intact
```

To kill a runaway worker, use `dangeresque stop` — never raw `kill <pid>`.
Stop tears down the engine + parent CLI cleanly so the worktree, PID file,
and artifact state stay consistent.

## Modes (one-liners; full semantics in `.dangeresque/AFK_WORKER_RULES.md`)

| Mode        | Purpose                               |
|-------------|---------------------------------------|
| INVESTIGATE | Find root cause, trace flow; no code changes |
| IMPLEMENT   | Bounded code change + tests           |
| VERIFY      | Prove an existing change works        |
| REFACTOR    | Restructure without behavior change   |
| TEST        | Write tests for existing behavior     |

## Health Checks

- `dangeresque doctor` — verify the linked binary's `dist/` matches HEAD,
  the artifact schema is current, `gh` is on PATH, and `.dangeresque/` is
  initialized. `--strict` exits non-zero on warnings (CI-friendly).
- `dangeresque migrate` — rewrite older `.dangeresque/runs/issue-*/*.json`
  artifacts to the current schema version. Idempotent.

Both are detailed in README §Health Checks and §Schema Migration.

## What NOT to Do

- **Do not `git push` from inside a worktree.** Pushing is hard-blocked at the
  tool layer; the human pushes `main` after `dangeresque merge`.
- **Do not close GitHub Issues from a worker run.** The orchestrator closes them after `dangeresque merge` + push.
- **Do not dispatch a second run on the same issue before merging + pushing**
  the previous one. You will start from a stale base.
- **Do not widen scope beyond the Goal stated in the issue.** Workers that
  widen scope cause review rejections.
- **Do not edit `.dangeresque/*.md` or `.gitignore` from inside a worker run.**
  Those are human-managed on main.
- **Do not edit canonical `.dangeresque/*.md` files directly on main.** The
  canonical `worker-prompt.md` / `review-prompt.md` / `AFK_WORKER_RULES.md`
  are overwritten on `dangeresque init`. Project-specific overrides belong
  in the `.local.md` companion (e.g. `worker-prompt.local.md`), which is
  never overwritten.
- **Do not edit `.dangeresque/DANGERESQUE.md`.** It's regenerated from
  dangeresque's built-in brief on every `init`. Project-specific rules
  belong in your `CLAUDE.md`.
- **Do not re-use a worktree name.** Worktree creation hard-fails if the path
  exists.
- **Do not read every prior run.** Read only the newest file under
  `.dangeresque/runs/issue-<N>/`.
- **Do not reach for raw `git worktree`, `kill <pid>`, or `cd <worktree>`.**
  Use `dangeresque merge` / `discard`, `dangeresque stop`, and
  `dangeresque results` / `logs` — they keep PID files, artifact mirrors,
  and worktree state consistent. `dangeresque --help` is the canonical
  command surface.

## Pointers (details live elsewhere in your project tree)

- `.dangeresque/AFK_WORKER_RULES.md` — full mode table, scope rules, status language
- Permissions reference — https://github.com/slikk66/dangeresque/blob/main/docs/PERMISSIONS.md (`acceptEdits`, `allowedTools`, `dangeresque allow`)
- `dangeresque --help` — full command surface
- `dangeresque stats --glossary` — result / verdict vocabulary
- `dangeresque doctor` — health/drift check (`--strict` for CI)
- `dangeresque migrate` — upgrade older run artifacts to the current schema

---

Generated by dangeresque v0.3.0.
