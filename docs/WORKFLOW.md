# The Workflow

The full cycle looks like this:

```
INVESTIGATE → read → discuss → stage → merge → push → IMPLEMENT → read → discuss → merge → push
```

**Every issue starts with INVESTIGATE. No exceptions** — even "trivial one-liners" get a read-only INVESTIGATE first to verify the hypothesis, surface missed side-effects, and land a research artifact the IMPLEMENT can cite.

**Push `main` to origin after every merge, before dispatching the next run.** Worktrees branch from `origin/main`, so any local-only commits make the next worker start from a stale base and produce phantom-regression noise in review.

Here's each step in detail.

## 1. Create a GitHub Issue

Write a focused issue describing the task. Workers read the issue title, body, and selected comments as their assignment. Good issues are bounded — one slice of work, not an entire feature.

Optionally include a fenced ` ```dangeresque-scope ``` ` YAML block in the body (or any `[staged]` comment) to declare an allow/deny list of file globs the worker is expected to touch. The reviewer applies category-specific scrutiny based on what fell inside, outside, or extended the declared scope. See [`docs/SCOPE.md`](SCOPE.md) for syntax.

You can create issues manually, or use the bundled Claude Code skill (Claude-only) from your interactive session:

```
You:    "The login timeout is set to 5 minutes but should be 30"
Agent:  *discusses, confirms the fix*
You:    /dangeresque-create-issue
```

## 2. Dispatch an investigation

```bash
dangeresque run --issue 63
```

This dispatches an **INVESTIGATE** run (the default mode). The worker reads the GitHub Issue, traces through relevant code, and documents findings in a run result file under `.dangeresque/runs/issue-63/` — but makes no code changes. A review pass runs automatically after. A macOS notification fires when complete.

## 3. Read the results

```bash
# From your main Claude Code session — the ! prefix runs the command inline
# (Claude-only; Codex users run the command in a separate terminal)
! dangeresque results investigate-63

# Or from a separate terminal
dangeresque results investigate-63
```

Pull the results into your interactive session (Claude Code or Codex) so you can discuss what the worker found. Ask questions, challenge conclusions, or plan next steps.

## 4. Stage your decisions

After reading the investigation, stage a comment with your guidance before dispatching the implementation:

```bash
dangeresque stage 63 --comment "root cause confirmed in TokenService.ts:140. Use approach A — extend existing timeout config, don't add a new one" --mode IMPLEMENT
```

The `[staged]` comment becomes part of the next worker's prompt context. This is how you steer the implementation without being present.

## 5. Merge the investigation

```bash
dangeresque merge investigate-63
```

Merges the worktree into main and cleans up the branch. The run result file at `.dangeresque/runs/issue-63/` is **gitignored** — it does not flow through `git merge`. Instead, dangeresque mirrors it from the worktree to the project root just before tearing the worktree down, and mirrors prior artifacts back into the next worktree on dispatch. Since INVESTIGATE runs don't change code, `git merge` is a no-op (HEAD unchanged) and only the artifact mirror runs.

## 6. Dispatch the implementation

```bash
dangeresque run --issue 63 --mode IMPLEMENT
```

The worker reads the issue + your staged comment + prior run files for the same issue, makes code changes, writes tests, and commits. Review pass audits the diff.

## 7. Review and merge

```bash
# Read results (shows the latest run file + diff summary vs main)
! dangeresque results implement-63

# Discuss with the agent in your interactive session — ask about edge cases, risks, test coverage
# Then merge when satisfied
dangeresque merge implement-63
```

## 8. Continue or close

- **Push** your main branch with the merged changes
- **Dispatch a VERIFY run** to prove the change works end-to-end
- **Stage more comments** and dispatch another IMPLEMENT pass for the next slice
- **Close the issue** when done
