# AFK Worker Rules

**This file applies to AFK dangeresque runs only, not the interactive planner conversation.**

Read CLAUDE.md first. This file overrides specific directives for bounded AFK execution.

## Directive Overrides

These CLAUDE.md directives are modified for AFK mode:

| CLAUDE.md Directive | AFK Override | Reason |
|---------------------|-------------|--------|
| DISCUSS-FIRST | **STAY-IN-SCOPE** — Follow the GitHub Issue exactly. Do not widen scope. If the task is under-specified or blocked, stop and write findings instead of guessing. | No human to discuss with during AFK execution. |
| DOCUMENT-NOW | **WRITE-HANDOFF** — Update RUN_RESULT.md before ending. This is your primary output. | Handoff artifacts replace live documentation. |
| CHALLENGE | **CHALLENGE-IN-WRITING** — If you disagree with the hypothesis or approach in the GitHub Issue, document your objection in RUN_RESULT.md with evidence. Do not silently comply with a bad plan. | No human to push back against, but objections must be recorded. |

All other CLAUDE.md directives (VERIFY-BEFORE, VERIFY-AFTER, RESEARCH, NO-BANDAID, USE-UL, KNOW-PLATFORM, PROTECT-ENV, NO-LAZY) apply as written.

## One Mode Per Run

Each AFK run operates in exactly ONE mode. The mode is specified in the GitHub Issue.

| Mode | Purpose | You May | You May NOT |
|------|---------|---------|-------------|
| **INVESTIGATE** | Find root cause, trace flow | Read files, grep, analyze, write findings | Change code, close issues |
| **IMPLEMENT** | Bounded code change | Edit code, write tests, commit | Widen scope beyond the GitHub Issue |
| **VERIFY** | Prove a change works | Run tests, grep values, check state | Write new features, refactor |
| **REFACTOR** | Restructure without behavior change | Move/rename/reorganize code | Change behavior, add features |
| **TEST** | Write tests for existing behavior | Create test files, run them | Change production code |
| **PLAYTEST** | Generate manual test script | Read code, analyze paths | Change code, run the game |

## Scope Rules

- Stay within the GitHub Issue. Period.
- Do not try to solve the entire GitHub Issue unless the GitHub Issue explicitly scopes you to do so.
- If you discover a related problem, note it in RUN_RESULT.md under "Risks / Uncertainty" — do not fix it.
- If the task is blocked (missing tool, unclear spec, needs human decision), stop and report. Do not guess.

## Status Language

Use ONLY these statuses in RUN_RESULT.md:

| Status | Meaning |
|--------|---------|
| `investigating` | Still gathering information, no conclusion yet |
| `implementing` | Code changes in progress, not yet complete |
| `implemented, unverified` | Code changed but full verification not completed |
| `verified` | Change made AND original behavior rechecked successfully |
| `blocked` | Cannot proceed — missing tool, unclear spec, or dependency |
| `reverted` | Change attempted but rolled back due to problems |
| `needs playtest` | Code change looks correct but requires human visual verification |

**Forbidden language:** Do not use "fixed", "done", "should work now", or any equivalent. These overclaim. If you cannot recheck the original behavior, use `implemented, unverified`.

## Required Outputs

Before ending your session, you MUST:

1. Update `RUN_RESULT.md` with all required sections
2. `git add` your code changes + `git add -f RUN_RESULT.md` (force-add — gitignored on main), then `git commit`
3. Your commit message should summarize what was done

## Stop Conditions

Stop immediately if:
- You have completed the task as specified in the GitHub Issue
- You are blocked and cannot proceed
- You realize the hypothesis in the GitHub Issue is wrong (write CHALLENGE-IN-WRITING)
- You have exceeded the scope of the GitHub Issue
