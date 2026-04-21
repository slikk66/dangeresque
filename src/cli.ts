#!/usr/bin/env node

import {
  loadConfig,
  validateSetup,
  resolveProjectRoot,
  type Engine,
} from "./config.js";
import { runWorker, runReview, fetchIssue, postRunComment, loadIssueFixture, formatIssueComments, type IssueData } from "./runner.js";
import {
  ArtifactBuilder,
  writeArtifact,
  commitArtifactJson,
  jsonPathForArchive,
} from "./artifact.js";
import {
  listWorktrees,
  mergeWorktree,
  discardWorktree,
  getWorktreeResults,
  getArchivedResults,
  resolveBranch,
  cleanArchivedRuns,
  readPidFile,
  type WorktreeInfo,
} from "./worktree.js";
import { initProject } from "./init.js";
import { stageComment } from "./stage.js";
import { resolveSessionPath, tailLog } from "./logs.js";

function usageForEngine(engine: Engine): string {
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
  discard <branch>                     Remove a worktree without merging
  clean --issue <N>                    Delete archived runs for an issue
  init                                 Scaffold .dangeresque/ config + skills

Run options:
  --issue <number>  Read task from GitHub Issue (recommended)
  --issue-fixture <path>  Read issue content from a local JSON file (no gh needed)
  --mode <mode>     Task mode (default: INVESTIGATE)
                    [INVESTIGATE, IMPLEMENT, VERIFY, REFACTOR, TEST, or custom]
  --name <name>     Custom worktree name (default: dangeresque-<timestamp>)
  --no-review       Skip the review pass
  --interactive     Run interactively (default: headless with -p)
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
`;
}

function currentHelpEngine(): Engine {
  const envEngine = process.env.DANGERESQUE_ENGINE?.toLowerCase();
  if (envEngine === "claude" || envEngine === "codex") return envEngine;

  try {
    const config = loadConfig(resolveProjectRoot());
    return config.engine;
  } catch {
    return "claude";
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(usageForEngine(currentHelpEngine()));
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
      console.log(usageForEngine(currentHelpEngine()));
      process.exit(1);
  }
}

async function cmdRun(args: string[]) {
  const runStartedAtMs = Date.now();
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
  const envEngine = process.env.DANGERESQUE_ENGINE?.toLowerCase();
  if (envEngine === "claude" || envEngine === "codex") {
    config.engine = envEngine;
  }

  // Parse CLI overrides
  let name: string | undefined;
  let review = true;
  let issueNumber: number | undefined;
  let issueFixturePath: string | undefined;
  let mode: string | undefined;
  let effortFlagUsed = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === "--no-review") {
      review = false;
    } else if (args[i] === "--interactive" || args[i] === "--no-tmux") {
      config.headless = false;
    } else if (args[i] === "--model" && args[i + 1]) {
      config.model = args[++i];
      // Hidden advanced override flag (kept for power users)
    } else if (args[i] === "--engine" && args[i + 1]) {
      const engine = args[++i].toLowerCase();
      if (engine !== "claude" && engine !== "codex") {
        console.error("--engine must be one of: claude, codex");
        process.exit(1);
      }
      config.engine = engine;
    } else if (args[i] === "--effort" && args[i + 1]) {
      effortFlagUsed = true;
      config.effort = args[++i];
    } else if (args[i] === "--review-model" && args[i + 1]) {
      config.reviewModel = args[++i];
    } else if (args[i] === "--review-effort" && args[i + 1]) {
      config.reviewEffort = args[++i];
    } else if (args[i] === "--issue" && args[i + 1]) {
      issueNumber = parseInt(args[++i], 10);
      if (isNaN(issueNumber)) {
        console.error("--issue requires a numeric issue number");
        process.exit(1);
      }
    } else if (args[i] === "--issue-fixture" && args[i + 1]) {
      issueFixturePath = args[++i];
    } else if (args[i] === "--mode" && args[i + 1]) {
      mode = args[++i].toUpperCase();
    }
  }

  if (issueNumber !== undefined && issueFixturePath !== undefined) {
    console.error(
      "--issue and --issue-fixture are mutually exclusive. Pass one, not both.",
    );
    process.exit(1);
  }

  if (issueNumber === undefined && issueFixturePath === undefined) {
    console.error(
      "Usage: dangeresque run --issue <N> [options]\n" +
        "   or: dangeresque run --issue-fixture <path> [options]\n\n" +
        "A task source is required. Pass one of:\n" +
        "  --issue <N>              Read task from GitHub Issue #N\n" +
        "  --issue-fixture <path>   Read task from a local JSON fixture",
    );
    process.exit(1);
  }

  // Load issue content from fixture or gh
  let issueData: IssueData;
  const fixtureUsed = issueFixturePath !== undefined;
  if (issueFixturePath !== undefined) {
    try {
      issueData = loadIssueFixture(issueFixturePath);
      issueNumber = issueData.number;
      console.log(
        `Loaded fixture #${issueData.number}: ${issueData.title} (from ${issueFixturePath})`,
      );
    } catch (err) {
      console.error(
        `Failed to load issue fixture: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  } else {
    try {
      issueData = fetchIssue(projectRoot, issueNumber!);
      console.log(`Fetched issue #${issueNumber}: ${issueData.title}`);
    } catch (err) {
      console.error(
        `Failed to fetch issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        "Is `gh` installed and authenticated? Does the issue exist?",
      );
      process.exit(1);
    }
  }

  const effectiveMode = mode ?? "INVESTIGATE";

  if (config.engine === "codex" && effortFlagUsed) {
    console.warn("⚠️  --effort is ignored in codex mode");
  }

  // Auto-generate name from mode + issue when not explicitly provided
  if (!name && issueNumber) {
    name = `${effectiveMode.toLowerCase()}-${issueNumber}`;
  }

  const effectiveReviewModel = config.reviewModel ?? config.model;
  const effectiveReviewEffort = config.reviewEffort ?? config.effort;
  const reviewDiffers =
    effectiveReviewModel !== config.model || effectiveReviewEffort !== config.effort;

  console.log("\ndangeresque — starting AFK run");
  console.log(`  Project: ${projectRoot}`);
  console.log(`  Issue: #${issueData.number} — ${issueData.title}`);
  console.log(`  Mode: ${effectiveMode}`);
  console.log(`  Engine: ${config.engine}`);
  console.log(`  Model: ${config.model} (effort: ${config.effort})`);
  if (reviewDiffers) {
    console.log(`  Review: ${effectiveReviewModel} (effort: ${effectiveReviewEffort})`);
  }
  console.log(`  Mode: ${config.headless ? "headless (-p)" : "interactive"}`);
  console.log(`  Review pass: ${review ? "yes" : "no"}`);

  // Worker pass
  const workerStartedAtMs = Date.now();
  const workerResult = await runWorker({
    projectRoot,
    config,
    name,
    issueData,
    mode: effectiveMode,
  });
  const workerEndedAtMs = Date.now();

  const builder = new ArtifactBuilder({
    projectRoot,
    issueNumber,
    ...(fixtureUsed ? { issueUrl: null } : {}),
    mode: effectiveMode,
    engine: config.engine,
    model: config.model,
    effort: config.effort,
    worktreeName: workerResult.worktreeName,
    branch: workerResult.branch,
    archivePath: workerResult.archivePath,
    startedAtMs: runStartedAtMs,
  });
  builder.setWorkerTiming(workerStartedAtMs, workerEndedAtMs, workerResult.exitCode);
  builder.recordEvent("worker_completed", { exit_code: workerResult.exitCode });

  console.log(`\nWorker exited with code ${workerResult.exitCode}`);

  // Hard-stop on worker failure: loud banner, FAIL comment, non-zero exit.
  // No scope check, no rebase, no review, no success summary.
  if (workerResult.exitCode !== 0) {
    const banner = "!".repeat(60);
    console.error(`\n${banner}`);
    console.error(`!!  DANGERESQUE RUN FAILED`);
    console.error(`!!  Worker exit code: ${workerResult.exitCode}`);
    console.error(`!!  Worktree: .claude/worktrees/${workerResult.worktreeName}/`);
    console.error(`!!  Branch:   ${workerResult.branch}`);
    console.error(`!!  Artifact: ${workerResult.archivePath}`);
    console.error(`!!`);
    console.error(`!!  Inspect: dangeresque logs`);
    console.error(`!!  Cleanup: dangeresque discard ${workerResult.branch}`);
    console.error(`${banner}\n`);

    if (issueNumber && !fixtureUsed) {
      try {
        postRunComment({
          projectRoot,
          issueNumber,
          mode: effectiveMode,
          worktreeName: workerResult.worktreeName,
          archivePath: workerResult.archivePath,
          workerExitCode: workerResult.exitCode,
          engine: config.engine,
          model: config.model,
          effort: config.engine === "claude" ? config.effort : undefined,
          reviewModel: config.reviewModel,
          reviewEffort: config.reviewEffort,
        });
      } catch (err) {
        console.error(
          `Warning: failed to post failure comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    finalizeArtifact(builder, projectRoot, workerResult.worktreeName);

    process.exit(workerResult.exitCode);
  }

  // Post-worker scope check: flag files changed that aren't mentioned in the issue body
  try {
    const { execSync } = await import("node:child_process");
    const worktreePath = `${projectRoot}/.claude/worktrees/${workerResult.worktreeName}`;
    const changedFiles = execSync("git diff main...HEAD --name-only", {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter((f) => f && !f.startsWith(".dangeresque/runs/"));

    const haystack = issueData.body + formatIssueComments(issueData);
    const unexpected = changedFiles.filter((f) => !haystack.includes(f));
    if (unexpected.length > 0) {
      console.warn(
        `\n⚠️  Worker modified files not mentioned in issue body:`,
      );
      for (const f of unexpected) {
        console.warn(`   ${f}`);
      }
      console.warn(`   Review carefully for scope violations.\n`);
      builder.setScopeViolations(unexpected);
    }
    builder.recordEvent("scope_check_completed", {
      changed_files: changedFiles.length,
      scope_violations: unexpected.length,
    });
  } catch {
    // Silently ignore — worktree state query failures aren't fatal here
  }

  // Rebase worktree onto latest origin/main before review
  // Prevents false REJECT from reviewer seeing stale-branch diffs
  if (review) {
    try {
      const { execSync } = await import("node:child_process");
      const worktreePath = `${projectRoot}/.claude/worktrees/${workerResult.worktreeName}`;
      execSync("git fetch origin main", { cwd: worktreePath, stdio: "pipe" });
      execSync("git rebase origin/main", { cwd: worktreePath, stdio: "pipe" });
      console.log(`\nRebased worktree onto latest origin/main`);
      builder.recordEvent("rebase_completed");
    } catch (e: any) {
      try {
        const { execSync } = await import("node:child_process");
        const worktreePath = `${projectRoot}/.claude/worktrees/${workerResult.worktreeName}`;
        execSync("git rebase --abort", { cwd: worktreePath, stdio: "pipe" });
      } catch {
        /* ignore */
      }
      console.warn(
        `\n⚠️  Rebase failed (conflict) — reviewer will see original diff`,
      );
      builder.recordEvent("rebase_failed");
    }
  }

  // Review pass — skip for modes that don't produce code changes
  const SKIP_REVIEW_MODES = new Set(["INVESTIGATE", "VERIFY"]);
  let reviewExitCode: number | undefined;
  if (review && SKIP_REVIEW_MODES.has(effectiveMode)) {
    console.log(`\nSkipping review (no code changes in ${effectiveMode} mode)`);
    builder.markReviewSkipped(`mode=${effectiveMode}`);
  } else if (review) {
    const reviewStartedAtMs = Date.now();
    const reviewResult = await runReview(
      { projectRoot, config, issueData, mode: effectiveMode },
      workerResult.worktreeName,
      workerResult.archivePath,
      workerResult.workerSessionId,
    );
    const reviewEndedAtMs = Date.now();
    reviewExitCode = reviewResult.exitCode;
    builder.setReviewTiming(reviewStartedAtMs, reviewEndedAtMs, reviewResult.exitCode);
    builder.recordEvent("review_completed", { exit_code: reviewResult.exitCode });
    console.log(`Review exited with code ${reviewResult.exitCode}`);
  } else {
    builder.markReviewSkipped("--no-review");
  }

  // Post summary comment on issue (success path)
  if (issueNumber && !fixtureUsed) {
    try {
      postRunComment({
        projectRoot,
        issueNumber,
        mode: effectiveMode,
        worktreeName: workerResult.worktreeName,
        archivePath: workerResult.archivePath,
        workerExitCode: workerResult.exitCode,
        reviewExitCode,
        engine: config.engine,
        model: config.model,
        effort: config.engine === "claude" ? config.effort : undefined,
        reviewModel: config.reviewModel,
        reviewEffort: config.reviewEffort,
      });
    } catch (err) {
      console.error(
        `Warning: failed to post comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const artifact = finalizeArtifact(builder, projectRoot, workerResult.worktreeName);

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`dangeresque run complete`);
  console.log(`  Worktree: .claude/worktrees/${workerResult.worktreeName}/`);
  console.log(`  Branch:   ${workerResult.branch}`);
  console.log(`  Artifact: ${workerResult.archivePath}`);
  if (artifact) {
    console.log(`  Eval:     ${artifact.artifact_paths.json}`);
    console.log(`  Result:   ${artifact.result} (verdict=${artifact.reviewer_verdict})`);
  }
  console.log(`\nNext steps:`);
  console.log(`  Review:  dangeresque results ${workerResult.branch}`);
  console.log(`  Merge:   dangeresque merge ${workerResult.branch}`);
  console.log(`  Discard: dangeresque discard ${workerResult.branch}`);
  console.log("=".repeat(60));
}

function finalizeArtifact(
  builder: ArtifactBuilder,
  projectRoot: string,
  worktreeName: string,
) {
  try {
    const artifact = builder.build();
    const absJsonPath = writeArtifact(artifact, projectRoot);
    const worktreePath = `${projectRoot}/.claude/worktrees/${worktreeName}`;
    commitArtifactJson(worktreePath, absJsonPath);
    return artifact;
  } catch (err) {
    console.error(
      `Warning: failed to write run evaluation artifact: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function cmdLogs(args: string[]) {
  const projectRoot = resolveProjectRoot();
  const worktrees = listWorktrees(projectRoot);

  const KNOWN_FLAGS = new Set(["--raw", "--review", "-f", "--follow"]);
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  const raw = args.includes("--raw");
  const review = args.includes("--review");
  const followFlag = args.includes("-f") || args.includes("--follow");
  const positional = args.find((a) => !a.startsWith("-"));

  if (!positional) {
    console.error(formatMissingTargetError("logs", "<branch>", worktrees));
    process.exit(1);
  }

  const branch = resolveBranch(projectRoot, positional);
  const target = worktrees.find((wt) => wt.branch === branch);
  if (!target) {
    console.error(`Worktree not found for branch: ${branch}`);
    process.exit(1);
  }

  // Read PID file for session IDs
  const pidInfo = readPidFile(target.path);
  if (!pidInfo) {
    console.error(
      `No PID file found in ${target.path} — run predates session tracking`,
    );
    process.exit(1);
  }

  // Auto-select review phase if review is running (PID file has review PID)
  const autoReview = !review && pidInfo.reviewSessionId && target.running;
  const phase = review || autoReview ? "review" : "worker";
  const sessionPath = resolveSessionPath(pidInfo, phase, target.path);
  if (!sessionPath) {
    console.error(`No ${phase} session ID tracked for this run`);
    process.exit(1);
  }

  console.error(
    `Branch: ${target.branch}  Phase: ${phase}  ${target.running ? "RUNNING" : "IDLE"}`,
  );

  const follow = followFlag;
  await tailLog({
    sessionPath,
    follow,
    raw,
    pid: target.running ? pidInfo.pid : undefined,
  });

  if (target.running && !followFlag) {
    console.error(
      "\nworker is RUNNING — pass -f/--follow to tail live output",
    );
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortBranch(branch: string): string {
  return branch.replace(/^worktree-dangeresque-/, "");
}

function formatMissingTargetError(
  cmd: string,
  argName: string,
  worktrees: WorktreeInfo[],
): string {
  let msg = `Usage: dangeresque ${cmd} ${argName} [options]\n\n`;
  if (worktrees.length === 0) {
    msg += "No active dangeresque worktrees.";
    return msg;
  }
  msg += "Active worktrees:\n";
  for (const wt of worktrees) {
    const name = shortBranch(wt.branch);
    let state = "IDLE";
    if (wt.running && wt.pidInfo) {
      const elapsed = formatElapsed(Date.now() - wt.pidInfo.startedAt);
      state = `RUNNING (pid ${wt.pidInfo.pid}, ${elapsed} elapsed)`;
    } else if (wt.pidInfo && !wt.running) {
      state = "IDLE (worker exited)";
    }
    msg += `  ${name.padEnd(20)} ${state}\n`;
  }
  msg += `\nPass one explicitly, e.g.: dangeresque ${cmd} ${shortBranch(worktrees[0].branch)}`;
  return msg;
}

function cmdStatus() {
  const projectRoot = resolveProjectRoot();
  const worktrees = listWorktrees(projectRoot);

  if (worktrees.length === 0) {
    console.log(`No active dangeresque worktrees (cwd=${process.cwd()})`);
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

  const KNOWN_FLAGS = new Set<string>();
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  const target = args.find((a) => !a.startsWith("-"));
  if (!target) {
    const worktrees = listWorktrees(projectRoot);
    console.error(formatMissingTargetError("results", "<branch>", worktrees));
    process.exit(1);
  }

  let branch: string;
  try {
    branch = resolveBranch(projectRoot, target);
  } catch {
    branch = target; // Fall through to getWorktreeResults which has its own error message
  }

  const output = getWorktreeResults(projectRoot, branch);
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
    console.error(
      'Usage: dangeresque stage <issue-number> --comment "text" [--mode MODE]',
    );
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
    console.error(
      'Usage: dangeresque stage <issue-number> --comment "text" [--mode MODE]',
    );
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
