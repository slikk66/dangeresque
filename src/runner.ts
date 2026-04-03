import { spawn, execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  type DangeresqueConfig,
  CONFIG_DIR,
  TASK_FILE,
  RESULT_FILE,
  projectHash,
} from "./config.js";
import { getLatestArchivedRun, writePidFile, updatePidFile, removePidFile } from "./worktree.js";

export interface RunOptions {
  projectRoot: string;
  config: DangeresqueConfig;
  name?: string;
  /** Run review pass after worker (default: true) */
  review?: boolean;
  /** GitHub Issue number (replaces NEXT_TASK.md) */
  issueData?: IssueData;
  /** Task mode: INVESTIGATE, IMPLEMENT, VERIFY, REFACTOR, TEST, PLAYTEST */
  mode?: string;
}

export interface RunResult {
  worktreeName: string;
  branch: string;
  exitCode: number;
  workerSessionId?: string;
}

export interface IssueData {
  number: number;
  title: string;
  body: string;
  comments: Array<{ body: string; author: { login: string } }>;
}

export function fetchIssue(
  projectRoot: string,
  issueNumber: number
): IssueData {
  const raw = execSync(
    `gh issue view ${issueNumber} --json title,body,comments`,
    { cwd: projectRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
  );
  const data = JSON.parse(raw);
  return {
    number: issueNumber,
    title: data.title,
    body: data.body,
    comments: (data.comments ?? []).map(
      (c: { body: string; author: { login: string } }) => ({
        body: c.body,
        author: c.author,
      })
    ),
  };
}

function buildWorkerArgs(opts: RunOptions): { args: string[]; workerSessionId: string } {
  const { config, projectRoot, name } = opts;
  const worktreeName = name ?? `dangeresque-${Date.now()}`;
  const configDir = join(projectRoot, CONFIG_DIR);
  const headless = config.headless;

  const args: string[] = [];

  // Headless mode: -p (non-interactive, exits when done)
  if (headless) {
    args.push("-p");
  }

  // Worktree
  args.push("--worktree", worktreeName);

  // Model + effort
  args.push("--model", config.model);
  if (config.effort) {
    args.push("--effort", config.effort);
  }

  // Permissions
  args.push("--permission-mode", config.permissionMode);

  // Worker-specific prompt (CLAUDE.md auto-discovered, this appends on top)
  const workerPromptPath = join(configDir, config.workerPrompt);
  args.push("--append-system-prompt-file", workerPromptPath);

  // Tool permissions
  if (config.allowedTools.length > 0) {
    args.push("--allowed-tools", ...config.allowedTools);
  }
  if (config.disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...config.disallowedTools);
  }

  // Session name + ID for identification and log retrieval
  args.push("--name", `dangeresque-worker-${worktreeName}`);
  const workerSessionId = randomUUID();
  args.push("--session-id", workerSessionId);

  // Initial prompt: issue-driven or file-driven
  const mode = opts.mode ?? "INVESTIGATE";

  if (opts.issueData) {
    const { issueData } = opts;
    let prompt =
      `You are an AFK worker executing a bounded task.\n` +
      `Mode: ${mode}.\n\n` +
      `Your task is defined in the following GitHub Issue:\n\n` +
      `# #${issueData.number}: ${issueData.title}\n\n` +
      `${issueData.body}`;

    // Filter comments: staged + last N human comments (skip [dangeresque] run results)
    const stagedComments = issueData.comments.filter(
      (c) => c.body.startsWith("**[staged")
    );
    const humanComments = issueData.comments.filter(
      (c) => !c.body.startsWith("**[staged") && !c.body.startsWith("**[dangeresque")
    );
    const recentHuman = humanComments.slice(-3);

    const filteredComments = [...stagedComments, ...recentHuman];
    if (filteredComments.length > 0) {
      prompt += `\n\n## Context Comments\n`;
      for (const c of filteredComments) {
        prompt += `\n**${c.author.login}:**\n${c.body}\n`;
      }
    }

    // Include latest archived run result (if any prior run exists)
    const archivedResult = getLatestArchivedRun(opts.projectRoot, issueData.number);
    if (archivedResult) {
      prompt += `\n\n## Previous Run Result (from archive)\n\n${archivedResult}`;
    }

    prompt +=
      `\n\nFollow .dangeresque/AFK_WORKER_RULES.md (appended to your system prompt). ` +
      `Update RUN_RESULT.md before finishing.`;

    args.push(prompt);
  } else {
    // Legacy: read from NEXT_TASK.md
    const taskContent = readFileSync(join(projectRoot, TASK_FILE), "utf-8");
    const modeMatch = taskContent.match(/^-\s*Mode:\s*(\w+)/m);
    const fileMode = modeMatch?.[1] ?? mode;

    args.push(
      `You are an AFK worker executing a bounded task. ` +
        `Mode: ${fileMode}. ` +
        `Read NEXT_TASK.md for your full instructions. ` +
        `Follow .dangeresque/AFK_WORKER_RULES.md (appended to your system prompt). ` +
        `Update RUN_RESULT.md before finishing.`
    );
  }

  return { args, workerSessionId };
}

function buildReviewArgs(opts: RunOptions, worktreeName: string): { args: string[]; reviewSessionId: string } {
  const { config, projectRoot } = opts;
  const configDir = join(projectRoot, CONFIG_DIR);
  const headless = config.headless;

  const args: string[] = [];

  // Headless mode: -p (non-interactive, exits when done)
  if (headless) {
    args.push("-p");
  }

  args.push("--worktree", worktreeName);

  args.push("--model", config.model);
  if (config.effort) {
    args.push("--effort", config.effort);
  }
  args.push("--permission-mode", "acceptEdits"); // Reviewer needs to append to RUN_RESULT.md

  // Reviewer needs read/write + git commit for RUN_RESULT.md in headless mode
  if (headless) {
    args.push(
      "--allowed-tools",
      "Read", "Edit", "Write", "Grep", "Glob",
      "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)",
      "Bash(git add *)", "Bash(git commit *)"
    );
    args.push(
      "--disallowed-tools",
      ...config.disallowedTools
    );
  }

  const reviewPromptPath = join(configDir, config.reviewPrompt);
  args.push("--append-system-prompt-file", reviewPromptPath);

  args.push("--name", `dangeresque-review-${worktreeName}`);
  const reviewSessionId = randomUUID();
  args.push("--session-id", reviewSessionId);

  if (opts.issueData) {
    const { issueData } = opts;
    const mode = opts.mode ?? "INVESTIGATE";
    args.push(
      `You are a skeptical reviewer of an AFK worker run.\n` +
        `The task was GitHub Issue #${issueData.number}: ${issueData.title}\n` +
        `Mode: ${mode}\n\n` +
        `Read RUN_RESULT.md and review the changes against the issue requirements. ` +
        `Check: did the worker address the issue? Is verification honest? Any scope creep? ` +
        `Append your review findings to RUN_RESULT.md.`
    );
  } else {
    args.push(
      `You are a skeptical reviewer of an AFK worker run. ` +
        `Read RUN_RESULT.md and review the changes. ` +
        `Check: did verification match the task? Is status language honest? Any scope creep? ` +
        `Append your review findings to RUN_RESULT.md.`
    );
  }

  return { args, reviewSessionId };
}

function ensureDangeresquePrefix(name: string): string {
  return name.startsWith("dangeresque-") ? name : `dangeresque-${name}`;
}

function checkRemoteBehind(projectRoot: string): void {
  try {
    const ahead = execSync("git rev-list --count origin/HEAD..HEAD", {
      cwd: projectRoot, encoding: "utf-8", stdio: "pipe",
    }).trim();
    const count = parseInt(ahead, 10);
    if (count > 0) {
      console.warn(
        `\n⚠️  Local main is ${count} commit${count > 1 ? "s" : ""} ahead of origin. Worktree will branch from origin — run 'git push' first.\n`
      );
    }
  } catch {
    // Silently ignore — no remote, detached HEAD, etc.
  }
}

export function runWorker(opts: RunOptions): Promise<RunResult> {
  checkRemoteBehind(opts.projectRoot);

  const worktreeName = ensureDangeresquePrefix(opts.name ?? `${Date.now()}`);
  const { args, workerSessionId } = buildWorkerArgs({ ...opts, name: worktreeName });
  const branch = `worktree-${worktreeName}`;
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);
  const hash = projectHash(worktreePath);

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

    // Write PID file once spawned (worktree may not exist yet — write after short delay)
    if (child.pid) {
      // Worktree is created by claude CLI; wait briefly for it to exist
      setTimeout(() => {
        try { writePidFile(worktreePath, child.pid!, { workerSessionId, projectHash: hash }); } catch { /* worktree not ready yet — ok */ }
      }, 3000);
    }

    child.on("error", (err: Error) => {
      removePidFile(worktreePath);
      reject(new Error(`Failed to start claude: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      removePidFile(worktreePath);
      resolve({
        worktreeName,
        branch,
        exitCode: code ?? 0,
        workerSessionId,
      });
    });
  });
}

export function runReview(
  opts: RunOptions,
  worktreeName: string,
  workerSessionId?: string
): Promise<RunResult> {
  const { args, reviewSessionId } = buildReviewArgs(opts, worktreeName);
  const branch = `worktree-${worktreeName}`;
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);

  return new Promise((resolve, reject) => {
    console.log(`\n--- Review session starting ---\n`);

    const child = spawn("claude", args, {
      cwd: opts.projectRoot,
      stdio: "inherit",
      env: { ...process.env },
    });

    // Write PID file for review process (worker's PID file was removed on close)
    if (child.pid) {
      const hash = projectHash(worktreePath);
      writePidFile(worktreePath, child.pid, { reviewSessionId, workerSessionId, projectHash: hash });
    }

    child.on("error", (err: Error) => {
      removePidFile(worktreePath);
      reject(new Error(`Failed to start claude review: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      removePidFile(worktreePath);
      resolve({
        worktreeName,
        branch,
        exitCode: code ?? 0,
      });
    });
  });
}

function formatRunComment(resultContent: string, mode: string): string {
  let comment = `**[dangeresque ${mode}]**\n\n`;
  comment += resultContent;

  return comment;
}

export function postRunComment(
  projectRoot: string,
  issueNumber: number,
  mode: string,
  worktreeName: string
): void {
  const worktreePath = join(
    projectRoot,
    ".claude",
    "worktrees",
    worktreeName
  );
  const resultPath = join(worktreePath, RESULT_FILE);

  let comment: string;
  if (existsSync(resultPath)) {
    const content = readFileSync(resultPath, "utf-8");
    comment = formatRunComment(content, mode);
  } else {
    comment =
      `**[dangeresque ${mode}]** Run completed but no ${RESULT_FILE} found. ` +
      `Check worktree: \`.claude/worktrees/${worktreeName}/\``;
  }

  const result = spawnSync(
    "gh",
    ["issue", "comment", String(issueNumber), "-F", "-"],
    {
      cwd: projectRoot,
      input: comment,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  if (result.status === 0) {
    console.log(`Posted summary comment on issue #${issueNumber}`);
  } else {
    console.error(
      `Failed to post comment on #${issueNumber}: ${result.stderr}`
    );
  }
}
