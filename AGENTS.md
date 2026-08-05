<!-- DANGERESQUE-START -->
**`dangeresque` is installed in this repo.** Use it to orchestrate issue-driven work — managing AI workers, isolated git worktrees, and gated merges — instead of raw `git worktree`, `kill <pid>`, or `cd <worktree>` commands.

- **Workflow primer:** read `.dangeresque/DANGERESQUE.md` or run `dangeresque brief`.
- **Command surface:** run `dangeresque --help` (auto-generated, never stale).
- **AFK worker constraints:** `.dangeresque/AFK_WORKER_RULES.md` (mode table, scope rules, status language).
<!-- DANGERESQUE-END -->

# AGENTS.md

This project's rules for AI coding agents live in `.claude/CLAUDE.md`.
Read that file first and apply every rule in it.

After reading, include `[[PROJECT-RULES-LOADED]]` somewhere in your run result file so we can verify compliance.
