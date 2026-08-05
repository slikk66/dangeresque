import type { Engine } from "./config.js";

export function usageForEngine(engine: Engine): string {
  const engineLine =
    engine === "codex"
      ? "Engine: codex • codex exec --full-auto --json\nModels: installed Codex catalog (examples: gpt-5.4, gpt-5.5; override with --model)\nEffort: native model_reasoning_effort; gpt-5.5 supports low|medium|high|xhigh and does not support max"
      : "Engine: claude (default) • headless -p mode";
  const engineRunNotes =
    engine === "codex"
      ? "  --effort <level>  Override native Codex reasoning effort; validated against selected model\n"
      : "  --effort <level>  Override worker effort [low, medium, high|xhigh, max]\n";

  return `
dangeresque — bounded AFK Claude Code or Codex runs with human review
${engineLine}

Commands:
  run [options]                        Execute worker + review pass
  review <branch> [options]            Re-run ONLY the review pass on a finished worker whose review died (killed process, engine error) — keeps the committed work; refuses a run that already has a verdict unless --force
  logs <branch> [options]              Pretty-print session transcript
  results <branch>                     Show run results from a worktree
  results --issue <N> [--all]          Show archived results for an issue
  stage <number> --comment "text"      Add context comment to an issue
  status                               List active dangeresque worktrees
  merge <branch> [--rescue]            Merge a reviewed worktree (--rescue: merge over a reject/needs_human_review verdict on a USER-approved micro-fix commit; verify gates still run)
  discard <branch> [--force]           Remove a worktree (--force kills running worker first)
  stop <branch>                        Stop a running worker; leave worktree intact
  clean --issue <N>                    Delete archived runs for an issue
  stats [options]                      Aggregate run evaluation artifacts; review auto-skipped for INVESTIGATE/VERIFY modes; --glossary explains terms
  allow mcp [<server>] [--dry-run]     Add mcp__<server> entries to allowedTools (reads ./.mcp.json if no server given)
  allow bash "<pattern>" [--dry-run]   Append Bash(<pattern>) to allowedTools (e.g. allow bash "npm install *")
  init                                 Scaffold .dangeresque/ config + skills
  migrate                              Migrate run artifacts to current schema version
  doctor [--strict]                    Health-check the install (binary freshness, deps, config; --strict: exit non-zero on warnings)
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
  --engine <name>   Worker engine: claude or codex (uses engineDefaults pin)
  --model <model>   Override worker model
${engineRunNotes}  --review-engine <name> Override review engine; uses engineDefaults pin
  --review-model <model>  Override review model
  --review-effort <level> Override review effort
  Env: DANGERESQUE_ENGINE, DANGERESQUE_REVIEW_ENGINE
  --help            Show this help

Review options (crash recovery — the worker's committed output is kept):
  --dry-run         Report whether the run is rescuable; dispatch nothing
  --force           Re-review a run that already has a verdict
  --no-verify       Skip pre-review verification commands
  --review-engine <name> / --review-model <model> / --review-effort <level>

Examples:
  dangeresque run --issue 63
  dangeresque run --issue 63 --mode IMPLEMENT
  dangeresque run --issue 63 --mode IMPLEMENT --engine codex --review-engine claude
  dangeresque review worktree-dangeresque-implement-63
  dangeresque results investigate-63
  dangeresque stage 63 --comment "root cause confirmed" --mode IMPLEMENT
  dangeresque init
  dangeresque brief >> CLAUDE.md
`;
}
