import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  type DangeresqueConfig,
  CONFIG_DIR,
  TASK_FILE,
} from "./config.js";

export interface RunOptions {
  projectRoot: string;
  config: DangeresqueConfig;
  name?: string;
  /** Run review pass after worker (default: true) */
  review?: boolean;
}

export interface RunResult {
  worktreeName: string;
  branch: string;
  exitCode: number;
}

function buildWorkerArgs(opts: RunOptions): string[] {
  const { config, projectRoot, name } = opts;
  const worktreeName = name ?? `dangeresque-${Date.now()}`;
  const configDir = join(projectRoot, CONFIG_DIR);

  const args: string[] = [];

  // Worktree
  args.push("--worktree", worktreeName);

  // tmux
  if (config.tmux) {
    args.push(config.tmuxStyle === "classic" ? "--tmux=classic" : "--tmux");
  }

  // Model + effort
  args.push("--model", config.model);
  if (config.effort) {
    args.push("--effort", config.effort);
  }

  // Permissions
  args.push("--permission-mode", config.permissionMode);

  // Prompt injection — append to default system prompt (preserves CLAUDE.md)
  const workerPromptPath = join(configDir, config.workerPrompt);
  args.push("--append-system-prompt-file", workerPromptPath);

  // Tool permissions
  if (config.allowedTools.length > 0) {
    args.push("--allowed-tools", ...config.allowedTools);
  }
  if (config.disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...config.disallowedTools);
  }

  // Session name for easy identification
  args.push("--name", `dangeresque-worker-${worktreeName}`);

  // Initial prompt: read the task and execute
  const taskContent = readFileSync(join(projectRoot, TASK_FILE), "utf-8");
  const modeMatch = taskContent.match(/^-\s*Mode:\s*(\w+)/m);
  const mode = modeMatch?.[1] ?? "UNKNOWN";

  args.push(
    `You are an AFK worker executing a bounded task. ` +
      `Mode: ${mode}. ` +
      `Read NEXT_TASK.md for your full instructions. ` +
      `Follow .dangeresque/AFK_WORKER_RULES.md (appended to your system prompt). ` +
      `Update RUN_RESULT.md before finishing.`
  );

  return args;
}

function buildReviewArgs(opts: RunOptions, worktreeName: string): string[] {
  const { config, projectRoot } = opts;
  const configDir = join(projectRoot, CONFIG_DIR);

  const args: string[] = [];

  // Resume in the same worktree — use continue flag
  // Actually, review runs as a new session in the same worktree
  args.push("--worktree", worktreeName);

  if (config.tmux) {
    args.push(config.tmuxStyle === "classic" ? "--tmux=classic" : "--tmux");
  }

  args.push("--model", config.model);
  if (config.effort) {
    args.push("--effort", config.effort);
  }
  args.push("--permission-mode", "acceptEdits"); // Reviewer needs to append to RUN_RESULT.md

  const reviewPromptPath = join(configDir, config.reviewPrompt);
  args.push("--append-system-prompt-file", reviewPromptPath);

  args.push("--name", `dangeresque-review-${worktreeName}`);

  args.push(
    `You are a skeptical reviewer of an AFK worker run. ` +
      `Read RUN_RESULT.md and review the changes. ` +
      `Check: did verification match the task? Is status language honest? Any scope creep? ` +
      `Append your review findings to RUN_RESULT.md.`
  );

  return args;
}

export function runWorker(opts: RunOptions): Promise<RunResult> {
  const worktreeName = opts.name ?? `dangeresque-${Date.now()}`;
  const args = buildWorkerArgs({ ...opts, name: worktreeName });
  const branch = `worktree-${worktreeName}`;

  return new Promise((resolve, reject) => {
    console.log(`\n🏗️  Starting worker in worktree: ${worktreeName}`);
    console.log(`📋 Branch: ${branch}`);
    console.log(`🔧 Model: ${opts.config.model}`);
    console.log(`📂 Config: ${join(opts.projectRoot, CONFIG_DIR)}/`);
    console.log(`\n--- Worker session starting ---\n`);

    const child = spawn("claude", args, {
      cwd: opts.projectRoot,
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("error", (err: Error) => {
      reject(new Error(`Failed to start claude: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      resolve({
        worktreeName,
        branch,
        exitCode: code ?? 0,
      });
    });
  });
}

export function runReview(
  opts: RunOptions,
  worktreeName: string
): Promise<RunResult> {
  const args = buildReviewArgs(opts, worktreeName);
  const branch = `worktree-${worktreeName}`;

  return new Promise((resolve, reject) => {
    console.log(`\n--- Review session starting ---\n`);

    const child = spawn("claude", args, {
      cwd: opts.projectRoot,
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("error", (err: Error) => {
      reject(new Error(`Failed to start claude review: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      resolve({
        worktreeName,
        branch,
        exitCode: code ?? 0,
      });
    });
  });
}
