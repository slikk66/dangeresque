---
name: wrap-session
description: Used at the end of a session to ensure a smooth transition to the next session's cold start after a context clear.
---

Session is ending. Goal: the next cold session can pick up productively from `HANDOFF.md` alone.

`HANDOFF.md` is **transitory** — in-flight, blocked, or actively-next state. Not a log. Not permanent.

## Where permanent info goes

Route this session's outputs to their proper homes BEFORE wrapping. `HANDOFF.md` is the catch-all only when nothing else fits AND the next session needs it.

| Type | Home |
|---|---|
| Domain language / glossary | `CONTEXT.md` |
| Architectural decisions (with rationale + trade-off) | `docs/adr/NNNN-*.md` |
| Strategic posture / project reference | `.claude/rules/architecture.md` |
| Platform gotchas / workflow rules | `.claude/rules/*.md` |
| Trackable work, RFCs, design discussions | GitHub issues |

## Steps

1. Read current `HANDOFF.md`. Don't clobber — preserve still-relevant in-flight items from prior sessions.
2. Sweep stale references (deleted files, closed issues, completed work) — remove them.
3. Route this session's permanent info to its proper home (table above) — write `CONTEXT.md` / ADRs / rules updates now if not already.
4. Update in-flight items with this session's open work; tight, action-oriented entries.
5. Update the "Next session: start here" pointer to the single most concrete next action.
6. **Commit everything.** Run `git status`; commit `HANDOFF.md`, `CONTEXT.md`, ADRs, code — all outstanding changes per workflow.md's COMMIT EVERYTHING rule. Without this step, the work doesn't survive into the next session.

## Style

Tight, action-oriented. No narrative.

DO: `Pulumi destroy blocked on Lambda@Edge orphan; run \`pulumi state delete ...\` to resolve.`

DON'T: `In session 36 we tried X, then Y, then decided Y because of Z.` (log, not handoff)

## Done when

A cold session can pick up productively from `HANDOFF.md` alone. If `HANDOFF.md` exceeds ~150 lines, audit for stale items rather than letting it grow.
