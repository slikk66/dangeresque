import { spawn, execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { readFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import {
  type DangeresqueConfig,
  CONFIG_DIR,
  TASK_FILE,
  RESULT_FILE,
  projectHash,
} from "./config.js";
import { getLatestArchivedRun, writePidFile, updatePidFile, removePidFile, readPidFile } from "./worktree.js";

export interface RunOptions {
  projectRoot: string;
  config: DangeresqueConfig;
  name?: string;
  /** Run review pass after worker (default: true) */
  review?: boolean;
  /** GitHub Issue number (replaces NEXT_TASK.md) */
  issueData?: IssueData;
  /** Task mode: INVESTIGATE, IMPLEMENT, VERIFY, REFACTOR, TEST */
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
  comments: Array<{ body: string; author: { login: string }; isMinimized: boolean }>;
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
      (c: { body: string; author: { login: string }; isMinimized: boolean }) => ({
        body: c.body,
        author: c.author,
        isMinimized: c.isMinimized,
      })
    ),
  };
}

function formatIssueComments(issueData: IssueData): string {
  const visibleComments = issueData.comments.filter(c => !c.isMinimized);
  const stagedComments = visibleComments.filter((c) => c.body.startsWith("**[staged"));
  const humanComments = visibleComments.filter(
    (c) => !c.body.startsWith("**[staged") && !c.body.startsWith("**[dangeresque")
  );
  const recentHuman = humanComments.slice(-3);

  const filteredComments = [...stagedComments, ...recentHuman];
  if (filteredComments.length === 0) return "";

  let result = `\n\n## Context Comments\n`;
  for (const c of filteredComments) {
    result += `\n**${c.author.login}:**\n${c.body}\n`;
  }
  return result;
}

function buildTaskPrompt(opts: RunOptions): string {
  const mode = opts.mode ?? "INVESTIGATE";

  if (opts.issueData) {
    const { issueData } = opts;
    let prompt =
      `You are an AFK worker executing a bounded task.\n` +
      `Mode: ${mode}.\n\n` +
      `Your task is defined in the following GitHub Issue:\n\n` +
      `# #${issueData.number}: ${issueData.title}\n\n` +
      `${issueData.body}`;

    prompt += formatIssueComments(issueData);

    const archivedResult = getLatestArchivedRun(opts.projectRoot, issueData.number);
    if (archivedResult) {
      prompt += `\n\n## Previous Run Result (from archive)\n\n${archivedResult}`;
    }

    prompt +=
      `\n\nFollow .dangeresque/AFK_WORKER_RULES.md (appended to your system prompt). ` +
      `Update RUN_RESULT.md before finishing.`;

    return prompt;
  }

  const taskContent = readFileSync(join(opts.projectRoot, TASK_FILE), "utf-8");
  const modeMatch = taskContent.match(/^-\s*Mode:\s*(\w+)/m);
  const fileMode = modeMatch?.[1] ?? mode;

  return (
    `You are an AFK worker executing a bounded task. ` +
    `Mode: ${fileMode}. ` +
    `Read NEXT_TASK.md for your full instructions. ` +
    `Follow .dangeresque/AFK_WORKER_RULES.md (appended to your system prompt). ` +
    `Update RUN_RESULT.md before finishing.`
  );
}

function buildClaudeWorkerArgs(opts: RunOptions, worktreeName: string): { args: string[]; workerSessionId: string } {
  const { config, projectRoot } = opts;
  const configDir = join(projectRoot, CONFIG_DIR);
  const headless = config.headless;

  const args: string[] = [];

  if (headless) {
    args.push("-p");
  }

  args.push("--worktree", worktreeName);
  args.push("--model", config.model);
  if (config.effort) {
    args.push("--effort", config.effort);
  }

  args.push("--permission-mode", config.permissionMode);

  const workerPromptPath = join(configDir, config.workerPrompt);
  args.push("--append-system-prompt-file", workerPromptPath);

  if (config.allowedTools.length > 0) {
    args.push("--allowed-tools", ...config.allowedTools);
  }
  if (config.disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...config.disallowedTools);
  }

  args.push("--name", `dangeresque-worker-${worktreeName}`);
  const workerSessionId = randomUUID();
  args.push("--session-id", workerSessionId);

  args.push(buildTaskPrompt(opts));

  return { args, workerSessionId };
}

function buildClaudeReviewArgs(opts: RunOptions, worktreeName: string): { args: string[]; reviewSessionId: string } {
  const { config, projectRoot } = opts;
  const configDir = join(projectRoot, CONFIG_DIR);
  const headless = config.headless;

  const args: string[] = [];

  if (headless) {
    args.push("-p");
  }

  args.push("--worktree", worktreeName);

  args.push("--model", config.model);
  if (config.effort) {
    args.push("--effort", config.effort);
  }
  args.push("--permission-mode", "acceptEdits");

  if (headless) {
    args.push(
      "--allowed-tools",
      "Read", "Edit", "Write", "Grep", "Glob",
      "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)",
      "Bash(git add *)", "Bash(git commit *)"
    );
    args.push("--disallowed-tools", ...config.disallowedTools);
  }

  const reviewPromptPath = join(configDir, config.reviewPrompt);
  args.push("--append-system-prompt-file", reviewPromptPath);

  args.push("--name", `dangeresque-review-${worktreeName}`);
  const reviewSessionId = randomUUID();
  args.push("--session-id", reviewSessionId);

  let diffStat = "";
  try {
    diffStat = execSync("git diff main --stat", {
      cwd: join(opts.projectRoot, ".claude", "worktrees", worktreeName),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    diffStat = "(could not capture diff stat)";
  }

  if (opts.issueData) {
    const { issueData } = opts;
    const mode = opts.mode ?? "INVESTIGATE";
    args.push(
      `You are an adversarial reviewer of an AFK worker run.\n` +
      `The task was GitHub Issue #${issueData.number}: ${issueData.title}\n` +
      `Mode: ${mode}\n\n` +
      `## Issue Body\n\n${issueData.body}\n` +
      formatIssueComments(issueData) + `\n` +
      `## Actual Diff (ground truth — captured automatically)\n\`\`\`\n${diffStat}\n\`\`\`\n\n` +
      `Compare this against the worker's claimed file count in RUN_RESULT.md. ` +
      `Any discrepancy is an automatic FAIL.\n\n` +
      `Start by running git diff main to see full code changes. ` +
      `Then read RUN_RESULT.md as a claims document to verify against the diff. ` +
      `Follow review-prompt.md. Append findings to RUN_RESULT.md.`
    );
  } else {
    args.push(
      `You are an adversarial reviewer of an AFK worker run.\n\n` +
      `## Actual Diff (ground truth — captured automatically)\n\`\`\`\n${diffStat}\n\`\`\`\n\n` +
      `Start by running git diff main to see full code changes. ` +
      `Then read RUN_RESULT.md as a claims document to verify against the diff. ` +
      `Follow review-prompt.md. Append findings to RUN_RESULT.md.`
    );
  }

  return { args, reviewSessionId };
}

function buildCodexWorkerArgs(opts: RunOptions, worktreeName: string): string[] {
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);
  const prompt = buildTaskPrompt(opts) + `\n\nEffort preference: ${opts.config.effort} (map this to response depth and planning thoroughness).`;

  return [
    "exec",
    "--json",
    "--full-auto",
    "--model", opts.config.model,
    "--cd", worktreePath,
    prompt,
  ];
}

function buildCodexReviewArgs(opts: RunOptions, worktreeName: string): string[] {
  let diffStat = "";
  try {
    diffStat = execSync("git diff main --stat", {
      cwd: join(opts.projectRoot, ".claude", "worktrees", worktreeName),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    diffStat = "(could not capture diff stat)";
  }

  const prompt = opts.issueData
    ? (
      `You are an adversarial reviewer of an AFK worker run.\n` +
      `The task was GitHub Issue #${opts.issueData.number}: ${opts.issueData.title}\n` +
      `Mode: ${opts.mode ?? "INVESTIGATE"}\n\n` +
      `## Issue Body\n\n${opts.issueData.body}\n` +
      formatIssueComments(opts.issueData) + `\n` +
      `## Actual Diff (ground truth — captured automatically)\n\`\`\`\n${diffStat}\n\`\`\`\n\n` +
      `Compare this against the worker's claimed file count in RUN_RESULT.md. ` +
      `Any discrepancy is an automatic FAIL.\n\n` +
      `Start by running git diff main to see full code changes. ` +
      `Then read RUN_RESULT.md as a claims document to verify against the diff. ` +
      `Follow review-prompt.md. Append findings to RUN_RESULT.md.`
    )
    : (
      `You are an adversarial reviewer of an AFK worker run.\n\n` +
      `## Actual Diff (ground truth — captured automatically)\n\`\`\`\n${diffStat}\n\`\`\`\n\n` +
      `Start by running git diff main to see full code changes. ` +
      `Then read RUN_RESULT.md as a claims document to verify against the diff. ` +
      `Follow review-prompt.md. Append findings to RUN_RESULT.md.`
    );

  return [
    "exec",
    "--json",
    "--full-auto",
    "--model", opts.config.model,
    "--cd", join(opts.projectRoot, ".claude", "worktrees", worktreeName),
    prompt,
  ];
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

function ensureWorktreeExists(projectRoot: string, worktreeName: string, branch: string): string {
  const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);
  if (existsSync(worktreePath)) return worktreePath;

  mkdirSync(dirname(worktreePath), { recursive: true });

  let baseRef = "HEAD";
  try {
    baseRef = execSync("git symbolic-ref --quiet --short refs/remotes/origin/HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    baseRef = "HEAD";
  }

  execSync(`git worktree add -b ${branch} "${worktreePath}" ${baseRef}`, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  return worktreePath;
}

function createCodexLogPath(worktreePath: string, phase: "worker" | "review"): string {
  const logDir = join(worktreePath, ".dangeresque");
  mkdirSync(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(logDir, `${phase}-codex-${timestamp}.jsonl`);
}

export function runWorker(opts: RunOptions): Promise<RunResult> {
  checkRemoteBehind(opts.projectRoot);

  const worktreeName = ensureDangeresquePrefix(opts.name ?? `${Date.now()}`);
  const branch = `worktree-${worktreeName}`;
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);
  const hash = projectHash(worktreePath);

  if (opts.config.engine === "codex") {
    ensureWorktreeExists(opts.projectRoot, worktreeName, branch);
    const args = buildCodexWorkerArgs(opts, worktreeName);
    const logPath = createCodexLogPath(worktreePath, "worker");

    return new Promise((resolve, reject) => {
      console.log(`\n🏗️  Starting worker in worktree: ${worktreeName}`);
      console.log(`📋 Branch: ${branch}`);
      console.log(`⚙️  Engine: codex`);
      console.log(`🔧 Model: ${opts.config.model}`);
      console.log(`📂 Config: ${join(opts.projectRoot, CONFIG_DIR)}/`);
      console.log(`\n--- Worker session starting ---\n`);

      const child = spawn("codex", args, {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      const logStream = createWriteStream(logPath, { flags: "a" });
      child.stdout?.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        logStream.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        logStream.write(chunk);
      });

      if (child.pid) {
        writePidFile(worktreePath, child.pid, {
          engine: "codex",
          projectHash: hash,
          workerLogPath: logPath,
        });
      }

      child.on("error", (err: Error) => {
        logStream.end();
        removePidFile(worktreePath);
        reject(new Error(`Failed to start codex: ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        logStream.end();
        removePidFile(worktreePath);
        resolve({ worktreeName, branch, exitCode: code ?? 0 });
      });
    });
  }

  const { args, workerSessionId } = buildClaudeWorkerArgs(opts, worktreeName);

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

    if (child.pid) {
      setTimeout(() => {
        try { writePidFile(worktreePath, child.pid!, { workerSessionId, projectHash: hash, engine: "claude" }); } catch { /* worktree not ready yet — ok */ }
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
  const branch = `worktree-${worktreeName}`;
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);
  const hash = projectHash(worktreePath);

  if (opts.config.engine === "codex") {
    const args = buildCodexReviewArgs(opts, worktreeName);
    const logPath = createCodexLogPath(worktreePath, "review");

    return new Promise((resolve, reject) => {
      console.log(`\n--- Review session starting ---\n`);

      const child = spawn("codex", args, {
        cwd: worktreePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      const logStream = createWriteStream(logPath, { flags: "a" });
      child.stdout?.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        logStream.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        logStream.write(chunk);
      });

      if (child.pid) {
        const existing = readPidFile(worktreePath);
        writePidFile(worktreePath, child.pid, {
          engine: "codex",
          projectHash: hash,
          workerLogPath: existing?.workerLogPath,
          reviewLogPath: logPath,
        });
      }

      child.on("error", (err: Error) => {
        logStream.end();
        removePidFile(worktreePath);
        reject(new Error(`Failed to start codex review: ${err.message}`));
      });

      child.on("close", (code: number | null) => {
        logStream.end();
        removePidFile(worktreePath);
        resolve({ worktreeName, branch, exitCode: code ?? 0 });
      });
    });
  }

  const { args, reviewSessionId } = buildClaudeReviewArgs(opts, worktreeName);

  return new Promise((resolve, reject) => {
    console.log(`\n--- Review session starting ---\n`);

    const child = spawn("claude", args, {
      cwd: opts.projectRoot,
      stdio: "inherit",
      env: { ...process.env },
    });

    if (child.pid) {
      writePidFile(worktreePath, child.pid, { reviewSessionId, workerSessionId, projectHash: hash, engine: "claude" });
      updatePidFile(worktreePath, { reviewSessionId, workerSessionId, projectHash: hash, engine: "claude" });
    }

    child.on("error", (err: Error) => {
      removePidFile(worktreePath);
      reject(new Error(`Failed to start claude review: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      removePidFile(worktreePath);
      resolve({ worktreeName, branch, exitCode: code ?? 0 });
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
