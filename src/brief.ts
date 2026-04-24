import { createRequire } from "node:module";

// NOTE: mirrors README.md §The Workflow and skills/dangeresque-create-issue/SKILL.md.
// Keep in sync if the workflow loop, command surface, or issue template changes.

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const BRIEF_MARKDOWN = `# Dangeresque Workflow

Dangeresque runs AI coding agents (Claude Code or Codex) AFK in isolated git
worktrees with a human-gated merge. This brief is the self-contained workflow
primer — an LLM or human reading only this document can drive dangeresque
correctly end-to-end.

## Prime Directives

### Quality Gates

- **VERIFY-BEFORE** — Read current code before changing it. Never edit what you haven't read.
- **VERIFY-AFTER** — After a change, confirm it landed. Grep the file, check the value, build the project.
- **NO-BANDAID** — Every fix must be researched and confirmed correct. No try/catch that swallows the problem.
- **ONE-PATH** — Extend the existing system. Do not add a parallel code path when the existing one can be widened.
- **FILE-IMMEDIATELY** — If you discover a bug/issue that is important, file it (gh cli) immediately.
- **INVESTIGATE-ALWAYS** — Every GitHub Issue gets an INVESTIGATE run before IMPLEMENT. No exceptions, no "trivial one-liner" shortcuts.

### Honest Scoping

- Stay inside the GitHub Issue. Do not widen scope.
- If blocked, stop and report. Do not invent requirements.
- Never say "fixed" or "done". Use allowed status language from \`.dangeresque/AFK_WORKER_RULES.md\`.

## The Loop

\`\`\`
INVESTIGATE → read → discuss → stage → merge → push →
IMPLEMENT   → read → discuss → merge → push → (VERIFY)
\`\`\`

**Every issue starts with INVESTIGATE. No exceptions.** Even a "trivial one-liner"
gets an INVESTIGATE first — it independently verifies the hypothesis, surfaces
side-effects you missed, and lands a research artifact that the IMPLEMENT can
cite. Skipping INVESTIGATE is the most common way a run goes wrong.

## The One Hard Rule

**Push \`main\` to origin AFTER every merge, BEFORE dispatching the next run.**
Worktrees branch from \`origin/main\`. If local main is ahead of origin, the
next worker starts stale and the reviewer flags phantom regressions.

## Creating Issues

Workers read the GitHub Issue title, body, and selected comments as their
assignment. Good issues are bounded — one slice of work, not an entire feature.
Use this template (the \`dangeresque-create-issue\` skill produces the same shape):

\`\`\`markdown
## Mode
<INVESTIGATE | IMPLEMENT | VERIFY | REFACTOR | TEST | custom>

## Goal
<what the worker should accomplish — one or two sentences>

## Hypothesis
<root cause guess, or "None — open investigation">

## Likely Files
- \`path/to/file.ts\` — reason
- \`path/to/other.ts\` — reason

## Verification Criteria
- [ ] criterion 1
- [ ] criterion 2

## Severity
<blocking | degraded | cosmetic>
\`\`\`

Create with \`gh issue create --label dangeresque --title "…" --body "…"\`.

## Dispatching a Run

\`\`\`bash
dangeresque run --issue <N>                    # default mode: INVESTIGATE
dangeresque run --issue <N> --mode IMPLEMENT
\`\`\`

Worker + review run automatically. Review is skipped for INVESTIGATE and
VERIFY (no code changes). A macOS notification fires when complete. Nothing
touches main until you run \`dangeresque merge\`.

## Reading Results

\`\`\`bash
dangeresque results <short-branch>     # e.g. investigate-63 — active worktree
dangeresque results --issue <N>        # latest archived run for an issue
dangeresque results --issue <N> --all  # full history
\`\`\`

Run artifacts live at \`.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md\` —
tracked in git, one file per run. Read only the newest if you need prior
context; do not read all of them.

## Staging Guidance

Add structured context before the next run:

\`\`\`bash
dangeresque stage <N> --comment "root cause confirmed; use approach A" --mode IMPLEMENT
\`\`\`

The \`[staged]\` comment becomes part of the next worker's prompt. This is how
you steer an AFK worker without being present.

## Merging or Discarding

\`\`\`bash
dangeresque merge <short-branch>       # merge worktree into main, clean up
dangeresque discard <short-branch>     # drop worktree + branch, no merge
\`\`\`

Merge brings the run result file (and any code changes) into main. Then push
main to origin before your next dispatch — see The One Hard Rule.

## Monitoring a Run

\`\`\`bash
dangeresque logs <short-branch>            # snapshot transcript + exit
dangeresque logs <short-branch> -f         # follow live output
dangeresque logs <short-branch> --review   # review pass transcript
dangeresque status                         # list active worktrees
\`\`\`

## Modes (one-liners; full semantics in \`.dangeresque/AFK_WORKER_RULES.md\`)

| Mode        | Purpose                               |
|-------------|---------------------------------------|
| INVESTIGATE | Find root cause, trace flow; no code changes |
| IMPLEMENT   | Bounded code change + tests           |
| VERIFY      | Prove an existing change works        |
| REFACTOR    | Restructure without behavior change   |
| TEST        | Write tests for existing behavior     |

## What NOT to Do

- **Do not \`git push\` from inside a worktree.** Pushing is hard-blocked at the
  tool layer; the human pushes \`main\` after \`dangeresque merge\`.
- **Do not close GitHub Issues from a worker run.** The orchestrator closes them after \`dangeresque merge\` + push.
- **Do not dispatch a second run on the same issue before merging + pushing**
  the previous one. You will start from a stale base.
- **Do not widen scope beyond the Goal stated in the issue.** Workers that
  widen scope cause review rejections.
- **Do not edit \`.dangeresque/*.md\` or \`.gitignore\` from inside a worker run.**
  Those are human-managed on main.
- **Do not edit canonical \`.dangeresque/*.md\` files directly on main.** The
  canonical \`worker-prompt.md\` / \`review-prompt.md\` / \`AFK_WORKER_RULES.md\`
  are overwritten on \`dangeresque init\`. Project-specific overrides belong
  in the \`.local.md\` companion (e.g. \`worker-prompt.local.md\`), which is
  never overwritten.
- **Do not edit \`.dangeresque/DANGERESQUE.md\`.** It's regenerated from
  dangeresque's built-in brief on every \`init\`. Project-specific rules
  belong in your \`CLAUDE.md\`.
- **Do not re-use a worktree name.** Worktree creation hard-fails if the path
  exists.
- **Do not read every prior run.** Read only the newest file under
  \`.dangeresque/runs/issue-<N>/\`.

## Pointers (details live elsewhere in your project tree)

- \`.dangeresque/AFK_WORKER_RULES.md\` — full mode table, scope rules, status language
- Permissions reference — https://github.com/slikk66/dangeresque/blob/main/docs/PERMISSIONS.md (\`acceptEdits\`, \`allowedTools\`, \`dangeresque allow\`)
- \`dangeresque --help\` — full command surface
- \`dangeresque stats --glossary\` — result / verdict vocabulary

---

Generated by dangeresque v${pkg.version}.
`;

export function printBrief(): void {
  process.stdout.write(BRIEF_MARKDOWN);
}
