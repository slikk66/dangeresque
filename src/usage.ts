import type { Engine } from "./config.js";

export function usageForEngine(engine: Engine): string {
  const engineLine =
    engine === "codex"
      ? "Engine: codex • codex exec --full-auto --json\nModel: gpt-5.4 (override with --model)"
      : "Engine: claude (default) • headless -p mode";
  const engineRunNotes =
    engine === "codex"
      ? ""
      : "  --effort <level>  Override effort level (default: max) [low, medium, high|xhigh, max]\n";

  return `
dangeresque — bounded AFK Claude Code or Codex runs with human review
${engineLine}

Commands:
  run [options]                        Execute worker + review pass
  logs <branch> [options]              Pretty-print session transcript
  results <branch>                     Show run results from a worktree
  results --issue <N> [--all]          Show archived results for an issue
  stage <number> --comment "text"      Add context comment to an issue
  status                               List active dangeresque worktrees
  merge <branch>                       Merge a reviewed worktree
  discard <branch> [--force]           Remove a worktree (--force kills running worker first)
  stop <branch>                        Stop a running worker; leave worktree intact
  clean --issue <N>                    Delete archived runs for an issue
  stats [options]                      Aggregate run evaluation artifacts; review auto-skipped for INVESTIGATE/VERIFY modes; --glossary explains terms
  allow mcp [<server>] [--dry-run]     Add mcp__<server> entries to allowedTools (reads ./.mcp.json if no server given)
  allow bash "<pattern>" [--dry-run]   Append Bash(<pattern>) to allowedTools (e.g. allow bash "npm install *")
  init                                 Scaffold .dangeresque/ config + skills
  brief                                Print a self-contained workflow primer (pipe to CLAUDE.md or less)

Exit codes: 0 success • 1 error • 2 gate refusal (workflow state — fix and retry)

Run options:
  --issue <number>  Read task from GitHub Issue (recommended)
  --issue-fixture <path>  Read issue content from a local JSON file (no gh needed)
  --mode <mode>     Task mode (default: INVESTIGATE)
                    [INVESTIGATE, IMPLEMENT, VERIFY, REFACTOR, TEST, or custom]
  --name <name>     Custom worktree name (default: dangeresque-<timestamp>)
  --no-review       Skip the review pass
  --no-verify       Skip pre-review verification commands (compile/test/lint)
  --interactive     Run interactively (default: headless with -p)
  --force           Bypass pre-flight gates (same-issue worktree, stale main)
  --model <model>   Override model (default: ${engine === "codex" ? "gpt-5.4" : "claude-opus-4-7"})
${engineRunNotes}  --review-model <model>  Override model for review pass (default: matches --model)
  --review-effort <level> Override effort for review pass (default: matches --effort)
  Advanced: --engine <name> (hidden), DANGERESQUE_ENGINE env var
  --help            Show this help

Examples:
  dangeresque run --issue 63
  dangeresque run --issue 63 --mode IMPLEMENT
  dangeresque results investigate-63
  dangeresque stage 63 --comment "root cause confirmed" --mode IMPLEMENT
  dangeresque init
  dangeresque brief >> CLAUDE.md
`;
}
