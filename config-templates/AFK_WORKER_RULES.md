# AFK Worker Rules

**This file applies to AFK dangeresque runs only, not interactive sessions.**

Read your project's agent-rules file first (e.g., `CLAUDE.md`, `AGENTS.md`, or whatever your project uses to brief AI assistants). This file overrides specific behaviors for bounded AFK execution; everything else from your project rules applies as written.

## AFK Operating Constraints

These constraints OVERRIDE any project-rule that conflicts with them. Match by behavior, not by name — your project may use different terminology for the same concepts.

- **No live discussion.** If your project rules say "discuss with user", "ask before X", "get sign-off", "confirm approach", or equivalent → instead, follow the GitHub Issue exactly. Do not widen scope. If blocked, stop and write findings under "Risks / Uncertainty" in your run result file.

- **No live documentation.** If your project rules say "update docs immediately", "capture as you go", "document now", or equivalent → instead, write a single handoff artifact at session end. Path provided in your initial prompt. This is your primary output.

- **No live pushback.** If your project rules say "push back / challenge / disagree with the user", or equivalent → instead, document your objection in your run result file with evidence under a `## CHALLENGE-IN-WRITING` heading. Do not silently comply with a bad plan — the documented objection IS how you push back.

All other project-rule directives apply as written unless they conflict with the constraints above.

## One Mode Per Run

Each AFK run operates in exactly ONE mode. The mode is provided via CLI flag.

| Mode | Purpose | You May | You May NOT |
|------|---------|---------|-------------|
| **INVESTIGATE** | Find root cause, trace flow | Read files, grep, analyze, write findings | Change code, close issues |
| **IMPLEMENT** | Bounded code change | Edit code, write tests, commit | Widen scope beyond the GitHub Issue |
| **VERIFY** | Prove a change works | Run tests, grep values, check state | Write new features, refactor |
| **REFACTOR** | Restructure without behavior change | Move/rename/reorganize code | Change behavior, add features |
| **TEST** | Write tests for existing behavior | Create test files, run them | Change production code |

Projects may define additional custom modes in their copy of this file.

## Scope Rules

- Stay within the GitHub Issue. Period.
- **One run = one slice.** Complete the scoped slice, not the entire issue, unless the issue IS a single slice.
- Do not try to solve the entire GitHub Issue unless it explicitly scopes you to do so.
- If you discover a related problem, note it in your run result file under "Risks / Uncertainty" — do not fix it.
- If the task is blocked (missing tool, unclear spec, needs human decision), stop and report. Do not guess.
- **Declare every file you touch.** For IMPLEMENT, REFACTOR, and TEST modes, the run result file MUST include a `## Scope Declaration` section listing every changed file with a category (`declared` / `extension` / `opportunistic` / `incidental`) and rationale. Phase 2 logs a warning when missing — Phase 3 will hard-fail. See worker-prompt.md for the format.

## File Scope Enforcement

- **DO NOT modify, delete, or create files outside the scope defined in the GitHub Issue.**
- If you see code that looks wrong but isn't part of your issue — leave it alone. Note the concern in your run result file under "Observations", do not fix it.
- If the issue says "only touch test files", that means ZERO changes to production code.
- **Deleting files you did not create in this run is NEVER acceptable** unless the issue explicitly requires deletion.
- Your worktree branched from `origin/HEAD` at creation time. Other workers may have merged changes to main since then. Code that looks unfamiliar may reflect work from another branch — DO NOT revert or "fix" it.
- The run result file lives inside your worktree at `.dangeresque/runs/issue-<N>/…` and is gitignored. Do NOT `git add` or `git commit` it — gitignore would block it anyway. Dangeresque mirrors the file out of your worktree to the project root at merge time.

## Worktree Write Fence

- All `Write`, `Edit`, and `NotebookEdit` calls MUST target paths inside your worktree. Compute every absolute path from your current working directory (the worktree root) — never hardcode an absolute path remembered from another repo or use `..` to climb out.
- Under the **claude** engine, a `PreToolUse` hook rejects parent-repo paths with exit code 2 and a message naming the offending path. Re-route to a worktree-relative absolute path and try again.
- Under the **codex** engine, the `-s workspace-write -c approval_policy=never` sandbox enforces the same boundary at the engine layer.
- The check is a simple absolute-path prefix comparison. It does NOT resolve symlinks or `..` traversal — those are out of scope (threat model is misrouted-but-well-meaning workers, not adversarial evasion).
- See `worker-prompt.md` § Path Discipline for the full failure-mode rationale (CI poisoning, invisible-to-diff stray files).

## Bash Shell Constraints

Multi-operation shell syntax is blocked by the engine **regardless of `allowedTools` config**. A `Bash(grep *)` permission does NOT grant `grep … | head` — the compound shape itself is denied. Blocked operators:

- Pipes: `|`
- Redirects: `>`, `>>`, `2>&1`, `2>/dev/null`, etc.
- Semicolons: `;`
- Chains: `&&`, `||`
- Process substitution: `<()`, `>()`

When a `Bash` call returns "requires approval", do NOT retry with different flags or fewer pipes — the denial is structural, retrying wastes round-trips. Switch to a builtin tool instead:

| Instead of | Use |
|---|---|
| `cat <file>` | **Read** |
| `grep -r <pattern> <path>` | **Grep** (use `path` + `glob` parameters) |
| `find <path> -name <glob>` | **Glob** |
| `cd <path> && <cmd>` | Pass the absolute path directly to `<cmd>`, or run from current cwd |
| `<cmd> 2>&1 \| head` | Run plain `<cmd>`; the engine will truncate large outputs automatically |
| `<cmd1> && <cmd2>` | Two separate `Bash` calls (only when both are individually allowed) |

If no builtin tool can express what you need, note the check as unverified in your run result file and move on. Do NOT loop on compound bash retries.

## Status Language

Use ONLY these statuses in your run result file:

| Status | Meaning |
|--------|---------|
| `investigating` | Still gathering information, no conclusion yet |
| `implementing` | Code changes in progress, not yet complete |
| `implemented, unverified` | Code changed but full verification not completed |
| `verified` | Change made AND original behavior rechecked successfully |
| `blocked` | Cannot proceed — missing tool, unclear spec, or dependency |
| `reverted` | Change attempted but rolled back due to problems |

**Forbidden language:** Do not use "fixed", "done", "should work now", or any equivalent. These overclaim. If you cannot recheck the original behavior, use `implemented, unverified`.

## Required Outputs

Before ending your session, you MUST:

1. Write your run result file (absolute path from the initial prompt) with all required sections, starting with the `<!-- SUMMARY -->` block (see worker-prompt.md)
2. `git add` your code changes + `git commit` them in the worktree. The run result file is gitignored and cannot be staged.
3. Your commit message should summarize what was done

## Stop Conditions

Stop immediately if:
- You have completed the task as specified in the GitHub Issue
- You are blocked and cannot proceed
- You realize the hypothesis in the GitHub Issue is wrong (write CHALLENGE-IN-WRITING)
- You have exceeded the scope of the GitHub Issue
