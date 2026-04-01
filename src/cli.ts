#!/usr/bin/env node

import {
  loadConfig,
  validateSetup,
  resolveProjectRoot,
} from "./config.js";
import { runWorker, runReview } from "./runner.js";
import { listWorktrees, mergeWorktree, discardWorktree } from "./worktree.js";

const USAGE = `
dangeresque — bounded AFK Claude Code runs with human review

Commands:
  run [--name <name>] [--no-review] [--no-tmux]   Execute worker + review pass
  status                                            List active dangeresque worktrees
  merge <branch>                                    Merge a reviewed worktree
  discard <branch>                                  Remove a worktree without merging
  init                                              Scaffold .dangeresque/ config

Options:
  --name <name>     Custom worktree name (default: dangeresque-<timestamp>)
  --no-review       Skip the review pass
  --no-tmux         Run without tmux (foreground)
  --model <model>   Override model (default: claude-opus-4-6)
  --effort <level>  Override effort level (default: high) [low, medium, high, max]
  --help            Show this help
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
    case "status":
      cmdStatus();
      break;
    case "merge":
      cmdMerge(args[1]);
      break;
    case "discard":
      cmdDiscard(args[1]);
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === "--no-review") {
      review = false;
    } else if (args[i] === "--no-tmux") {
      config.tmux = false;
    } else if (args[i] === "--model" && args[i + 1]) {
      config.model = args[++i];
    } else if (args[i] === "--effort" && args[i + 1]) {
      config.effort = args[++i];
    }
  }

  console.log("dangeresque — starting AFK run");
  console.log(`  Project: ${projectRoot}`);
  console.log(`  Model: ${config.model} (effort: ${config.effort})`);
  console.log(`  tmux: ${config.tmux ? config.tmuxStyle : "off"}`);
  console.log(`  Review pass: ${review ? "yes" : "no"}`);

  // Worker pass
  const workerResult = await runWorker({
    projectRoot,
    config,
    name,
  });

  console.log(
    `\nWorker exited with code ${workerResult.exitCode}`
  );

  // Review pass
  if (review && workerResult.exitCode === 0) {
    const reviewResult = await runReview(
      { projectRoot, config },
      workerResult.worktreeName
    );
    console.log(
      `Review exited with code ${reviewResult.exitCode}`
    );
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
    `  Merge:   npx dangeresque merge ${workerResult.branch}`
  );
  console.log(
    `  Discard: npx dangeresque discard ${workerResult.branch}`
  );
  console.log("=".repeat(60));
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
    console.log(`  Branch: ${wt.branch}`);
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
  const result = mergeWorktree(projectRoot, branch);

  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.message);
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
  const result = discardWorktree(projectRoot, branch);

  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function cmdInit() {
  console.log("TODO: scaffold .dangeresque/ config directory");
  console.log("For now, create .dangeresque/ manually with:");
  console.log("  worker-prompt.md");
  console.log("  review-prompt.md");
  console.log("  AFK_WORKER_RULES.md (optional)");
  console.log("  config.json (optional, defaults apply)");
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
