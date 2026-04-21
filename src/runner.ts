import { spawn, execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { readFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import {
  type DangeresqueConfig,
  CONFIG_DIR,
  RUNS_DIR,
  ADHOC_DIR,
  TASK_FILE,
  projectHash,
} from "./config.js";
import { writePidFile, updatePidFile, removePidFile, readPidFile } from "./worktree.js";

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
  /** Absolute path to the run's archive file inside the worktree */
  archivePath: string;
}

/**
 * Compute the archive path for a run. Lives inside the worktree at
 * <worktree>/.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md so it flows
 * through normal git merge into main. Discard drops the artifact along with
 * the worktree — which is what "discard" means.
 */
export function computeRunArchivePath(
  worktreePath: string,
  issueNumber: number | undefined,
  mode: string
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const subdir = issueNumber ? `issue-${issueNumber}` : ADHOC_DIR;
  return join(worktreePath, CONFIG_DIR, RUNS_DIR, subdir, `${timestamp}-${mode}.md`);
}

function commitArchiveFile(worktreePath: string, archivePath: string): void {
  if (!existsSync(archivePath)) return;
  try {
    const rel = relative(worktreePath, archivePath);
    execSync(`git add "${rel}"`, { cwd: worktreePath, encoding: "utf-8", stdio: "pipe" });
    execSync(`git commit -m "dangeresque run artifact"`, { cwd: worktreePath, encoding: "utf-8", stdio: "pipe" });
  } catch {
    // nothing to commit, or index already clean — fine
  }
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

export function loadIssueFixture(path: string): IssueData {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read fixture file: ${path} (${err instanceof Error ? err.message : String(err)})`
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Fixture file is not valid JSON: ${path} (${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (!data || typeof data !== "object") {
    throw new Error(`Fixture file must be a JSON object: ${path}`);
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.number !== "number") {
    throw new Error(`Fixture missing required field "number" (number): ${path}`);
  }
  if (typeof obj.title !== "string") {
    throw new Error(`Fixture missing required field "title" (string): ${path}`);
  }
  if (typeof obj.body !== "string") {
    throw new Error(`Fixture missing required field "body" (string): ${path}`);
  }
  if (!Array.isArray(obj.comments)) {
    throw new Error(`Fixture missing required field "comments" (array): ${path}`);
  }

  const comments = obj.comments.map((c: unknown, i: number) => {
    if (!c || typeof c !== "object") {
      throw new Error(`Fixture comment[${i}] must be an object: ${path}`);
    }
    const cObj = c as Record<string, unknown>;
    const author = cObj.author as Record<string, unknown> | undefined;
    if (typeof cObj.body !== "string") {
      throw new Error(`Fixture comment[${i}].body must be a string: ${path}`);
    }
    if (!author || typeof author.login !== "string") {
      throw new Error(`Fixture comment[${i}].author.login must be a string: ${path}`);
    }
    return {
      body: cObj.body,
      author: { login: author.login },
      isMinimized: Boolean(cObj.isMinimized),
    };
  });

  return {
    number: obj.number,
    title: obj.title,
    body: obj.body,
    comments,
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

function buildTaskPrompt(opts: RunOptions, archivePath: string): string {
  const mode = opts.mode ?? "INVESTIGATE";
  const runsDir = dirname(archivePath);

  if (opts.issueData) {
    const { issueData } = opts;
    let prompt =
      `You are an AFK worker executing a bounded task.\n` +
      `Mode: ${mode}.\n\n` +
      `Your task is defined in the following GitHub Issue:\n\n` +
      `# #${issueData.number}: ${issueData.title}\n\n` +
      `${issueData.body}`;

    prompt += formatIssueComments(issueData);

    prompt +=
      `\n\n## Run Artifacts\n\n` +
      `- Write your run result to exactly this absolute path: ${archivePath}\n` +
      `- Prior runs for this issue live at ${runsDir}/ (one timestamped file per run, newest last). ` +
      `Read the latest there ONLY if you need prior context — do not read them all.\n\n` +
      `Follow .dangeresque/AFK_WORKER_RULES.md (appended to your system prompt).`;

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
    `Write your run result to exactly this absolute path: ${archivePath}`
  );
}

function buildClaudeWorkerArgs(opts: RunOptions, worktreeName: string, archivePath: string): { args: string[]; workerSessionId: string } {
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

  args.push(buildTaskPrompt(opts, archivePath));

  return { args, workerSessionId };
}

function buildClaudeReviewArgs(opts: RunOptions, worktreeName: string, archivePath: string): { args: string[]; reviewSessionId: string } {
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

  args.push(buildReviewPrompt(opts, archivePath, diffStat));

  return { args, reviewSessionId };
}

function buildReviewPrompt(opts: RunOptions, archivePath: string, diffStat: string): string {
  const header = opts.issueData
    ? `You are an adversarial reviewer of an AFK worker run.\n` +
      `The task was GitHub Issue #${opts.issueData.number}: ${opts.issueData.title}\n` +
      `Mode: ${opts.mode ?? "INVESTIGATE"}\n\n` +
      `## Issue Body\n\n${opts.issueData.body}\n` +
      formatIssueComments(opts.issueData)
    : `You are an adversarial reviewer of an AFK worker run.`;

  return (
    `${header}\n\n` +
    `## Actual Diff (ground truth — captured automatically)\n\`\`\`\n${diffStat}\n\`\`\`\n\n` +
    `## Run Artifact\n\n` +
    `The worker's run result is committed in the worktree at: ${archivePath}\n` +
    `Treat this as a claims document — verify against the diff. ` +
    `Append your review findings to the SAME file.\n\n` +
    `Start by running git diff main to see full code changes. ` +
    `Then read the run artifact and compare the worker's claims against the diff. ` +
    `When counting files, EXCLUDE any path under .dangeresque/runs/ — those are auto-committed artifacts, not worker claims. ` +
    `Any remaining file-count discrepancy is an automatic FAIL.\n\n` +
    `Follow review-prompt.md.`
  );
}

function buildCodexWorkerArgs(opts: RunOptions, worktreeName: string, archivePath: string): string[] {
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);
  const workerPromptPath = join(opts.projectRoot, CONFIG_DIR, opts.config.workerPrompt);
  const workerPromptContent = readFileSync(workerPromptPath, "utf-8");
  const prompt =
    workerPromptContent +
    `\n\n` +
    buildTaskPrompt(opts, archivePath) +
    `\n\nEffort preference: ${opts.config.effort} (map this to response depth and planning thoroughness).`;

  return [
    "exec",
    "--json",
    "--full-auto",
    "--model", opts.config.model,
    "--cd", worktreePath,
    prompt,
  ];
}

function buildCodexReviewArgs(opts: RunOptions, worktreeName: string, archivePath: string): string[] {
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

  const reviewPromptPath = join(opts.projectRoot, CONFIG_DIR, opts.config.reviewPrompt);
  const reviewPromptContent = readFileSync(reviewPromptPath, "utf-8");
  const prompt = reviewPromptContent + `\n\n` + buildReviewPrompt(opts, archivePath, diffStat);

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

/**
 * Create a fresh worktree. Hard-fails if the target path already exists —
 * no silent reuse. Caller must merge or discard the prior worktree first.
 */
function createWorktree(projectRoot: string, worktreeName: string, branch: string): string {
  const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);
  if (existsSync(worktreePath)) {
    throw new Error(
      `Worktree already exists: .claude/worktrees/${worktreeName}\n` +
      `A prior run on this mode+issue was not cleaned up. Choose one:\n` +
      `  dangeresque merge   ${branch}   (keep the work)\n` +
      `  dangeresque discard ${branch}   (throw it away)\n` +
      `Then re-run.`
    );
  }

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

  // Always create a fresh worktree — throws if one already exists.
  createWorktree(opts.projectRoot, worktreeName, branch);

  const archivePath = computeRunArchivePath(
    worktreePath,
    opts.issueData?.number,
    opts.mode ?? "INVESTIGATE"
  );
  mkdirSync(dirname(archivePath), { recursive: true });

  if (opts.config.engine === "codex") {
    const args = buildCodexWorkerArgs(opts, worktreeName, archivePath);
    const logPath = createCodexLogPath(worktreePath, "worker");

    return new Promise((resolve, reject) => {
      console.log(`\n🏗️  Starting worker in worktree: ${worktreeName}`);
      console.log(`📋 Branch: ${branch}`);
      console.log(`⚙️  Engine: codex`);
      console.log(`🔧 Model: ${opts.config.model}`);
      console.log(`📂 Config: ${join(opts.projectRoot, CONFIG_DIR)}/`);
      console.log(`📝 Run artifact: ${relative(opts.projectRoot, archivePath)}`);
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
          archivePath,
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
        if ((code ?? 0) === 0) commitArchiveFile(worktreePath, archivePath);
        resolve({ worktreeName, branch, exitCode: code ?? 0, archivePath });
      });
    });
  }

  const { args, workerSessionId } = buildClaudeWorkerArgs(opts, worktreeName, archivePath);

  return new Promise((resolve, reject) => {
    console.log(`\n🏗️  Starting worker in worktree: ${worktreeName}`);
    console.log(`📋 Branch: ${branch}`);
    console.log(`🔧 Model: ${opts.config.model}`);
    console.log(`📂 Config: ${join(opts.projectRoot, CONFIG_DIR)}/`);
    console.log(`📝 Run artifact: ${relative(opts.projectRoot, archivePath)}`);
    console.log(`\n--- Worker session starting ---\n`);

    const child = spawn("claude", args, {
      cwd: opts.projectRoot,
      stdio: "inherit",
      env: { ...process.env },
    });

    if (child.pid) {
      setTimeout(() => {
        try { writePidFile(worktreePath, child.pid!, { workerSessionId, projectHash: hash, engine: "claude", archivePath }); } catch { /* worktree not ready yet — ok */ }
      }, 3000);
    }

    child.on("error", (err: Error) => {
      removePidFile(worktreePath);
      reject(new Error(`Failed to start claude: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      removePidFile(worktreePath);
      if ((code ?? 0) === 0) commitArchiveFile(worktreePath, archivePath);
      resolve({
        worktreeName,
        branch,
        exitCode: code ?? 0,
        workerSessionId,
        archivePath,
      });
    });
  });
}

export function runReview(
  opts: RunOptions,
  worktreeName: string,
  archivePath: string,
  workerSessionId?: string
): Promise<RunResult> {
  const branch = `worktree-${worktreeName}`;
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);
  const hash = projectHash(worktreePath);

  if (opts.config.engine === "codex") {
    const args = buildCodexReviewArgs(opts, worktreeName, archivePath);
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
          archivePath,
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
        if ((code ?? 0) === 0) commitArchiveFile(worktreePath, archivePath);
        resolve({ worktreeName, branch, exitCode: code ?? 0, archivePath });
      });
    });
  }

  const { args, reviewSessionId } = buildClaudeReviewArgs(opts, worktreeName, archivePath);

  return new Promise((resolve, reject) => {
    console.log(`\n--- Review session starting ---\n`);

    const child = spawn("claude", args, {
      cwd: opts.projectRoot,
      stdio: "inherit",
      env: { ...process.env },
    });

    if (child.pid) {
      writePidFile(worktreePath, child.pid, { reviewSessionId, workerSessionId, projectHash: hash, engine: "claude", archivePath });
      updatePidFile(worktreePath, { reviewSessionId, workerSessionId, projectHash: hash, engine: "claude", archivePath });
    }

    child.on("error", (err: Error) => {
      removePidFile(worktreePath);
      reject(new Error(`Failed to start claude review: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      removePidFile(worktreePath);
      if ((code ?? 0) === 0) commitArchiveFile(worktreePath, archivePath);
      resolve({ worktreeName, branch, exitCode: code ?? 0, archivePath });
    });
  });
}

export interface CommentOptions {
  projectRoot: string;
  issueNumber: number;
  mode: string;
  worktreeName: string;
  archivePath: string;
  workerExitCode: number;
  reviewExitCode?: number;
  engine?: string;
  model?: string;
  effort?: string;
}

function buildRunTag(mode: string, opts: CommentOptions): string {
  const parts = [`dangeresque ${mode}`];
  if (opts.engine) parts.push(`engine=${opts.engine}`);
  if (opts.model) parts.push(`model=${opts.model}`);
  if (opts.effort) parts.push(`effort=${opts.effort}`);
  return `**[${parts.join(" · ")}]**`;
}

export function postRunComment(opts: CommentOptions): void {
  const { projectRoot, issueNumber, mode, worktreeName, archivePath, workerExitCode, reviewExitCode } = opts;
  const tag = buildRunTag(mode, opts);

  let comment: string;
  if (workerExitCode !== 0) {
    comment =
      `${tag} ❌ FAILED\n\n` +
      `Worker exited with code ${workerExitCode}. No review was run.\n\n` +
      `- Worktree: \`.claude/worktrees/${worktreeName}/\`\n` +
      `- Expected run artifact: \`${relative(projectRoot, archivePath)}\` ` +
      `(${existsSync(archivePath) ? "partial output present" : "not written"})\n\n` +
      `Inspect the worker session log with \`dangeresque logs\`, then \`dangeresque discard worktree-${worktreeName}\` to clean up.`;
  } else if (!existsSync(archivePath)) {
    comment =
      `${tag} ⚠️  Worker exited cleanly but wrote no run artifact.\n\n` +
      `Expected file: \`${relative(projectRoot, archivePath)}\`\n` +
      `Worktree: \`.claude/worktrees/${worktreeName}/\``;
  } else {
    const content = readFileSync(archivePath, "utf-8");
    const reviewNote = reviewExitCode !== undefined && reviewExitCode !== 0
      ? `\n\n⚠️  Review process exited with code ${reviewExitCode} — findings above may be incomplete.`
      : "";
    comment = `${tag}\n\n${content}${reviewNote}`;
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
    console.log(`Posted ${workerExitCode !== 0 ? "FAILURE" : "summary"} comment on issue #${issueNumber}`);
  } else {
    console.error(
      `Failed to post comment on #${issueNumber}: ${result.stderr}`
    );
  }
}
