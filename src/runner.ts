import { spawn, execSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  type DangeresqueConfig,
  CONFIG_DIR,
  TASK_FILE,
  RESULT_FILE,
} from "./config.js";

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

    if (issueData.comments.length > 0) {
      prompt += `\n\n## Previous Comments\n`;
      for (const c of issueData.comments) {
        prompt += `\n**${c.author.login}:**\n${c.body}\n`;
      }
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

function extractRunSummary(resultContent: string, mode: string): string {
  const statusMatch = resultContent.match(/^-\s*Status:\s*(.+)/m);
  const status = statusMatch?.[1]?.trim() ?? "unknown";

  const sectionRe = (heading: string) =>
    new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);

  const whatIDid = sectionRe("What I Did").exec(resultContent)?.[1]?.trim();
  const nextStep = sectionRe("Recommended Next Step").exec(resultContent)?.[1]?.trim();

  let comment = `**[dangeresque ${mode}]**\n\n`;
  comment += `**Status:** ${status}\n\n`;
  if (whatIDid) comment += `**Summary:** ${whatIDid}\n\n`;
  if (nextStep) comment += `**Next step:** ${nextStep}\n`;

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
    comment = extractRunSummary(content, mode);
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
