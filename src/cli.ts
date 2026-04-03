#!/usr/bin/env node

import {
  loadConfig,
  validateSetup,
  resolveProjectRoot,
} from "./config.js";
import { runWorker, runReview, fetchIssue, postRunComment } from "./runner.js";
import { listWorktrees, mergeWorktree, discardWorktree, getWorktreeResults, getArchivedResults, resolveBranch, cleanArchivedRuns, readPidFile } from "./worktree.js";
import { initProject } from "./init.js";
import { stageComment } from "./stage.js";
import { resolveSessionPath, tailLog } from "./logs.js";

const USAGE = `
dangeresque — bounded AFK Claude Code runs with human review

Commands:
  run [options]                        Execute worker + review pass
  logs [branch] [options]              Pretty-print session transcript
  results [--latest | <branch>]        Show run results from a worktree
  results --issue <N> [--all]          Show archived results for an issue
  stage <number> --comment "text"      Add context comment to an issue
  status                               List active dangeresque worktrees
  merge <branch>                       Merge a reviewed worktree
  discard <branch>                     Remove a worktree without merging
  clean --issue <N>                    Delete archived runs for an issue
  init                                 Scaffold .dangeresque/ config + skills

Run options:
  --issue <number>  Read task from GitHub Issue (recommended)
  --mode <mode>     Task mode (default: INVESTIGATE)
                    [INVESTIGATE, IMPLEMENT, VERIFY, REFACTOR, TEST, or custom]
  --name <name>     Custom worktree name (default: dangeresque-<timestamp>)
  --no-review       Skip the review pass
  --interactive     Run interactively (default: headless with -p)
  --model <model>   Override model (default: claude-opus-4-6)
  --effort <level>  Override effort level (default: max) [low, medium, high, max]
  --help            Show this help

Examples:
  dangeresque run --issue 63
  dangeresque run --issue 63 --mode IMPLEMENT
  dangeresque results --latest
  dangeresque stage 63 --comment "root cause confirmed" --mode IMPLEMENT
  dangeresque init
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "run":
      await cmdRun(args.slice(1));
      break;
    case "logs":
      await cmdLogs(args.slice(1));
      break;
    case "results":
      cmdResults(args.slice(1));
      break;
    case "stage":
      cmdStage(args.slice(1));
      break;
    case "status":
      cmdStatus();
      break;
    case "merge":
      cmdMerge(args[1]);
      break;
    case "discard":
      cmdDiscard(args[1]);
      break;
    case "clean":
      cmdClean(args.slice(1));
      break;
    case "init":
      cmdInit();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

async function cmdRun(args: string[]) {
  const projectRoot = resolveProjectRoot();
  const validation = validateSetup(projectRoot);

  if (!validation.valid) {
    console.error("Setup validation failed:");
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const config = loadConfig(projectRoot);

  // Parse CLI overrides
  let name: string | undefined;
  let review = true;
  let issueNumber: number | undefined;
  let mode: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === "--no-review") {
      review = false;
    } else if (args[i] === "--interactive" || args[i] === "--no-tmux") {
      config.headless = false;
    } else if (args[i] === "--model" && args[i + 1]) {
      config.model = args[++i];
    } else if (args[i] === "--effort" && args[i + 1]) {
      config.effort = args[++i];
    } else if (args[i] === "--issue" && args[i + 1]) {
      issueNumber = parseInt(args[++i], 10);
      if (isNaN(issueNumber)) {
        console.error("--issue requires a numeric issue number");
        process.exit(1);
      }
    } else if (args[i] === "--mode" && args[i + 1]) {
      mode = args[++i].toUpperCase();
    }
  }

  // Fetch issue if provided
  let issueData;
  if (issueNumber) {
    try {
      issueData = fetchIssue(projectRoot, issueNumber);
      console.log(`Fetched issue #${issueNumber}: ${issueData.title}`);
    } catch (err) {
      console.error(
        `Failed to fetch issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
      console.error("Is `gh` installed and authenticated? Does the issue exist?");
      process.exit(1);
    }
  }

  const effectiveMode = mode ?? "INVESTIGATE";

  // Auto-generate name from mode + issue when not explicitly provided
  if (!name && issueNumber) {
    name = `${effectiveMode.toLowerCase()}-${issueNumber}`;
  }

  console.log("\ndangeresque — starting AFK run");
  console.log(`  Project: ${projectRoot}`);
  if (issueData) {
    console.log(`  Issue: #${issueData.number} — ${issueData.title}`);
    console.log(`  Mode: ${effectiveMode}`);
  }
  console.log(`  Model: ${config.model} (effort: ${config.effort})`);
  console.log(`  Mode: ${config.headless ? "headless (-p)" : "interactive"}`);
  console.log(`  Review pass: ${review ? "yes" : "no"}`);

  // Worker pass
  const workerResult = await runWorker({
    projectRoot,
    config,
    name,
    issueData,
    mode: effectiveMode,
  });

  console.log(
    `\nWorker exited with code ${workerResult.exitCode}`
  );

  // Review pass
  if (review && workerResult.exitCode === 0) {
    const reviewResult = await runReview(
      { projectRoot, config, issueData, mode: effectiveMode },
      workerResult.worktreeName,
      workerResult.workerSessionId
    );
    console.log(
      `Review exited with code ${reviewResult.exitCode}`
    );
  }

  // Post summary comment on issue
  if (issueNumber) {
    try {
      postRunComment(
        projectRoot,
        issueNumber,
        effectiveMode,
        workerResult.worktreeName
      );
    } catch (err) {
      console.error(
        `Warning: failed to post comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`dangeresque run complete`);
  console.log(`  Worktree: .claude/worktrees/${workerResult.worktreeName}/`);
  console.log(`  Branch: ${workerResult.branch}`);
  console.log(`\nNext steps:`);
  console.log(
    `  Review:  cd .claude/worktrees/${workerResult.worktreeName} && git diff main`
  );
  console.log(
    `  Merge:   dangeresque merge ${workerResult.branch}`
  );
  console.log(
    `  Discard: dangeresque discard ${workerResult.branch}`
  );
  console.log("=".repeat(60));
}

async function cmdLogs(args: string[]) {
  const projectRoot = resolveProjectRoot();
  const worktrees = listWorktrees(projectRoot);

  if (worktrees.length === 0) {
    console.error("No active dangeresque worktrees");
    process.exit(1);
  }

  const raw = args.includes("--raw");
  const review = args.includes("--review");
  const followFlag = args.includes("-f") || args.includes("--follow");
  const positional = args.find((a) => !a.startsWith("-"));

  // Resolve target worktree
  let target;
  if (positional) {
    const branch = resolveBranch(projectRoot, positional);
    target = worktrees.find((wt) => wt.branch === branch);
    if (!target) {
      console.error(`Worktree not found for branch: ${branch}`);
      process.exit(1);
    }
  } else {
    // Latest by commit timestamp
    target = worktrees.reduce((a, b) => a.commitEpoch >= b.commitEpoch ? a : b);
  }

  // Read PID file for session IDs
  const pidInfo = readPidFile(target.path);
  if (!pidInfo) {
    console.error(`No PID file found in ${target.path} — run predates session tracking`);
    process.exit(1);
  }

  const phase = review ? "review" : "worker";
  const sessionPath = resolveSessionPath(pidInfo, phase, target.path);
  if (!sessionPath) {
    console.error(`No ${phase} session ID tracked for this run`);
    process.exit(1);
  }

  console.error(`Branch: ${target.branch}  Phase: ${phase}  ${target.running ? "RUNNING" : "IDLE"}`);

  const follow = followFlag || target.running;
  await tailLog({
    sessionPath,
    follow,
    raw,
    pid: target.running ? pidInfo.pid : undefined,
  });
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function cmdStatus() {
  const projectRoot = resolveProjectRoot();
  const worktrees = listWorktrees(projectRoot);

  if (worktrees.length === 0) {
    console.log("No active dangeresque worktrees");
    return;
  }

  console.log(`Active dangeresque worktrees (${worktrees.length}):\n`);
  for (const wt of worktrees) {
    let state = "IDLE";
    if (wt.running && wt.pidInfo) {
      const elapsed = formatElapsed(Date.now() - wt.pidInfo.startedAt);
      state = `RUNNING (pid ${wt.pidInfo.pid}, ${elapsed} elapsed)`;
    } else if (wt.pidInfo && !wt.running) {
      state = "IDLE (worker exited)";
    }

    console.log(`  Branch: ${wt.branch}  ${state}`);
    console.log(`  Path:   ${wt.path}`);
    console.log(`  HEAD:   ${wt.head.slice(0, 8)}`);
    console.log();
  }
}

function cmdMerge(branch: string | undefined) {
  if (!branch) {
    console.error("Usage: dangeresque merge <branch>");
    console.error("Run 'dangeresque status' to see active worktrees");
    process.exit(1);
  }

  const projectRoot = resolveProjectRoot();
  try {
    const resolved = resolveBranch(projectRoot, branch);
    const result = mergeWorktree(projectRoot, resolved);

    if (result.success) {
      console.log(result.message);
    } else {
      console.error(result.message);
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function cmdDiscard(branch: string | undefined) {
  if (!branch) {
    console.error("Usage: dangeresque discard <branch>");
    console.error("Run 'dangeresque status' to see active worktrees");
    process.exit(1);
  }

  const projectRoot = resolveProjectRoot();
  try {
    const resolved = resolveBranch(projectRoot, branch);
    const result = discardWorktree(projectRoot, resolved);

    if (result.success) {
      console.log(result.message);
    } else {
      console.error(result.message);
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function cmdResults(args: string[]) {
  const projectRoot = resolveProjectRoot();

  // Check for --issue flag (show archived results)
  const issueIdx = args.indexOf("--issue");
  if (issueIdx !== -1 && args[issueIdx + 1]) {
    const issueNumber = parseInt(args[issueIdx + 1], 10);
    if (isNaN(issueNumber)) {
      console.error("--issue requires a numeric issue number");
      process.exit(1);
    }
    const showAll = args.includes("--all");
    const output = getArchivedResults(projectRoot, issueNumber, showAll);
    console.log(output);
    return;
  }

  const target = args.find((a) => !a.startsWith("-")) ?? "latest";
  const isLatest = target === "latest" || args.includes("--latest");

  let branchOrLatest: string | "latest";
  if (isLatest) {
    branchOrLatest = "latest";
  } else {
    try {
      branchOrLatest = resolveBranch(projectRoot, target);
    } catch {
      branchOrLatest = target; // Fall through to getWorktreeResults which has its own error message
    }
  }

  const output = getWorktreeResults(projectRoot, branchOrLatest);
  console.log(output);
}

function cmdClean(args: string[]) {
  const issueIdx = args.indexOf("--issue");
  if (issueIdx === -1 || !args[issueIdx + 1]) {
    console.error("Usage: dangeresque clean --issue <N>");
    process.exit(1);
  }

  const issueNumber = parseInt(args[issueIdx + 1], 10);
  if (isNaN(issueNumber)) {
    console.error("--issue requires a numeric issue number");
    process.exit(1);
  }

  const projectRoot = resolveProjectRoot();
  const result = cleanArchivedRuns(projectRoot, issueNumber);

  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function cmdStage(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: dangeresque stage <issue-number> --comment \"text\" [--mode MODE]");
    process.exit(1);
  }

  const issueNumber = parseInt(args[0], 10);
  if (isNaN(issueNumber)) {
    console.error("First argument must be an issue number");
    process.exit(1);
  }

  let comment: string | undefined;
  let mode: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--comment" && args[i + 1]) {
      comment = args[++i];
    } else if (args[i] === "--mode" && args[i + 1]) {
      mode = args[++i].toUpperCase();
    }
  }

  if (!comment) {
    console.error("--comment is required");
    console.error("Usage: dangeresque stage <issue-number> --comment \"text\" [--mode MODE]");
    process.exit(1);
  }

  const projectRoot = resolveProjectRoot();
  const result = stageComment(projectRoot, issueNumber, comment, mode);

  if (result.success) {
    console.log(result.message);
    if (mode) {
      console.log(`Run: dangeresque run --issue ${issueNumber} --mode ${mode}`);
    }
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function cmdInit() {
  const projectRoot = resolveProjectRoot();
  initProject(projectRoot);
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
