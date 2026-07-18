import { spawn, execSync, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";
import { join, dirname, relative } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, rmSync } from "node:fs";
import {
  type DangeresqueConfig,
  CONFIG_DIR,
  RUNS_DIR,
  projectHash,
} from "./config.js";
import { writePidFile, removePidFile, readPidFile, resolveDiffBase, mirrorIssueRuns, parseSummaryBlock } from "./worktree.js";
import type { VerificationOutcome } from "./verify.js";

// --- engine-process tracking ---
//
// `dangeresque stop` and the parent CLI's SIGTERM handler need to signal the
// running engine child. The PID file gives `stop` (a separate process) what
// it needs, but the in-process signal handler cannot read its own PID file
// reliably during shutdown — it needs a direct ChildProcess reference. This
// module-level set is the bridge.
const activeEngines = new Set<ChildProcess>();

function trackEngine(child: ChildProcess): void {
  activeEngines.add(child);
  const drop = () => activeEngines.delete(child);
  child.once("close", drop);
  child.once("error", drop);
}

/**
 * Send `signal` to every currently-running engine spawned in this process.
 * Used by the parent CLI's SIGTERM handler so an external `dangeresque stop`
 * cleanly aborts both phases of a run instead of only killing the engine and
 * letting the parent spawn the review pass on top.
 */
export function killActiveEngines(signal: NodeJS.Signals): number {
  let count = 0;
  for (const child of activeEngines) {
    if (!child.pid) continue;
    try {
      process.kill(child.pid, signal);
      count++;
    } catch {
      /* already dead */
    }
  }
  return count;
}

/**
 * Translate a `child.on("close", (code, signal))` event into a real exit
 * code. Without this, a signal-killed engine (`code === null`) collapses to
 * 0 via `code ?? 0`, which makes the parent CLI think the worker succeeded
 * and proceed to spawn the review pass on top of a killed run. Maps signal
 * names to the POSIX `128 + signal-number` convention.
 */
export function exitCodeFromCloseEvent(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  if (signal === null) return 0;
  const signalNum = osConstants.signals[signal] ?? 0;
  return 128 + signalNum;
}

export interface RunOptions {
  projectRoot: string;
  config: DangeresqueConfig;
  name?: string;
  /** Run review pass after worker (default: true) */
  review?: boolean;
  /** GitHub Issue data — required */
  issueData: IssueData;
  /** Task mode: INVESTIGATE, IMPLEMENT, VERIFY, REFACTOR, TEST */
  mode?: string;
}

export interface RunResult {
  worktreeName: string;
  branch: string;
  exitCode: number;
  workerSessionId?: string;
  /** Codex worker's log path, threaded into the review pass (codex has no session id). */
  workerLogPath?: string;
  /** Absolute path to the run's archive file inside the worktree */
  archivePath: string;
}

/**
 * Compute the archive path for a run. Lives inside the worktree at
 * <worktree>/.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md. The directory
 * is gitignored — dangeresque mirrors files to the project root on merge.
 * Discard drops the artifact along with the worktree.
 */
export function computeRunArchivePath(
  worktreePath: string,
  issueNumber: number,
  mode: string
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(worktreePath, CONFIG_DIR, RUNS_DIR, `issue-${issueNumber}`, `${timestamp}-${mode}.md`);
}

/**
 * Capture a worker's code changes into a single commit on its branch.
 *
 * Codex under `--full-auto` runs inside a sandbox that denies writes to the
 * linked-worktree gitdir at `<main-checkout>/.git/worktrees/<name>/`, so
 * `git add` / `git commit` from inside the worker always fail. This helper
 * runs from the dangeresque parent process (which has full host permissions)
 * to salvage the worker's file changes. Claude workers commit themselves and
 * do not need this path.
 *
 * Scope rules:
 * - `git add -A` captures every tracked/untracked change in the worktree.
 *   Safe because the worktree is a throwaway branch from origin/HEAD and
 *   `.gitignore` still excludes build output, node_modules, PID files, etc.
 * - The run artifact directory (`.dangeresque/runs/`) is gitignored, so the
 *   exclude pathspec is defensive — keeps any pre-existing tracked entries
 *   out of the worker's commit during the migration window for older repos.
 */
export function commitWorkerChanges(
  worktreePath: string,
  issueNumber: number,
  mode: string
): void {
  try {
    // Bare `git add -A` (no pathspec): with an explicit pathspec — even an
    // exclude-only one — git treats matched IGNORED dirs as named targets and
    // hard-fails ("paths are ignored by one of your .gitignore files", exit 1;
    // advice.addIgnoredFile=false silences the hint but keeps the failure —
    // verified empirically 2026-07-04, first live codex run, bc#603). Bare -A
    // never touches ignored+untracked paths, so `.dangeresque/runs` stays out
    // on current repos. The reset below covers what the excludes used to:
    // the injected codex session state (.codex/) and any pre-existing TRACKED
    // entries under .dangeresque/runs (migration-window repos).
    execSync(`git add -A`, {
      cwd: worktreePath, encoding: "utf-8", stdio: "pipe",
    });
    execSync(`git reset -q -- .codex .dangeresque/runs`, {
      cwd: worktreePath, encoding: "utf-8", stdio: "pipe",
    });
    // Delete the codex session-state dir outright: left untracked, it blocks
    // the merge path's non-force `git worktree remove` (first live IMPLEMENT
    // run, bc#603 — merge landed but cleanup failed). The run artifact lives
    // in .dangeresque/runs (mirrored by merge), so nothing of value is lost.
    rmSync(join(worktreePath, ".codex"), { recursive: true, force: true });
    const staged = execSync("git diff --cached --name-only", {
      cwd: worktreePath, encoding: "utf-8", stdio: "pipe",
    }).trim();
    if (!staged) return;
    const message = `codex ${mode} worker: issue #${issueNumber}`;
    execSync(`git commit -m "${message}"`, {
      cwd: worktreePath, encoding: "utf-8", stdio: "pipe",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `dangeresque: failed to commit codex worker changes in ${worktreePath} ` +
      `(issue #${issueNumber}, mode ${mode}). ` +
      `Worker output remains in the worktree for manual salvage. ` +
      `Underlying error: ${detail}`
    );
  }
}

/** Relative path (from worktree root) of the generated codex rules file. */
export const CODEX_RULES_RELPATH = ".codex/rules/dangeresque.rules";

/**
 * Translate a single `Bash(<cmd> *)` disallowedTools pattern into a Starlark
 * `prefix_rule(...)` line for codex's exec_policy engine. Returns null for
 * non-Bash() patterns (claude-only tool names like `WebSearch`, `Edit`) which
 * have no representation in codex's shell-command rules. The trailing ` *`
 * glob claude uses for prefix-match is stripped — codex's prefix_rule already
 * matches by token-prefix.
 */
export function bashPatternToPrefixRule(pattern: string): string | null {
  const match = pattern.match(/^Bash\((.*)\)$/);
  if (!match) return null;
  const inner = match[1].replace(/\s*\*\s*$/, "").trim();
  if (!inner) return null;
  const tokens = inner.split(/\s+/);
  const patternArray = tokens.map((t) => JSON.stringify(t)).join(", ");
  const justification = `dangeresque: ${inner} blocked (engine-parity with claude --disallowed-tools)`;
  return `prefix_rule(pattern=[${patternArray}], decision="forbidden", justification=${JSON.stringify(justification)})`;
}

/**
 * Render the full content of `<worktree>/.codex/rules/dangeresque.rules`
 * from `config.disallowedTools`. Non-Bash() entries are silently dropped.
 * Returns null when nothing translates — caller should skip writing the file.
 */
export function buildCodexRulesContent(disallowedTools: string[]): string | null {
  const rules = disallowedTools
    .map((t) => bashPatternToPrefixRule(t))
    .filter((r): r is string => r !== null);
  if (rules.length === 0) return null;
  const header =
    `# Auto-generated by dangeresque. DO NOT EDIT.\n` +
    `# Source: .dangeresque/config.json "disallowedTools". Regenerated per-run.\n` +
    `# Translates each Bash(<cmd> *) pattern into a codex prefix_rule denial so\n` +
    `# destructive-command blocking applies under the codex engine the same way\n` +
    `# --disallowed-tools applies under the claude engine.\n\n`;
  return header + rules.join("\n") + "\n";
}

/**
 * Write the translated codex rules file into the worktree so codex picks it
 * up via its project-layer rules scan. Call once per worktree, before
 * spawning codex. Returns the absolute path written, or null if there were
 * no Bash() patterns to translate.
 */
export function writeCodexRulesFile(
  worktreePath: string,
  disallowedTools: string[]
): string | null {
  const content = buildCodexRulesContent(disallowedTools);
  if (!content) return null;
  const rulesPath = join(worktreePath, CODEX_RULES_RELPATH);
  mkdirSync(dirname(rulesPath), { recursive: true });
  writeFileSync(rulesPath, content, "utf-8");
  return rulesPath;
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

export function formatIssueComments(issueData: IssueData): string {
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

// Modes whose worker output produces a code diff and therefore must declare
// every touched file in a `## Scope Declaration` section. Kept in sync with
// the matching set in `src/artifact.ts` (warning emission). Two literal sets
// rather than a shared export so each consumer can drift independently if
// future modes change semantics.
const CODE_CHANGING_MODES = new Set(["IMPLEMENT", "REFACTOR", "TEST"]);

function buildTaskPrompt(opts: RunOptions, archivePath: string): string {
  const mode = opts.mode ?? "INVESTIGATE";
  const runsDir = dirname(archivePath);
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

  if (CODE_CHANGING_MODES.has(mode)) {
    prompt +=
      `\n\n## Scope Declaration\n\n` +
      `Your run artifact MUST include a top-level \`## Scope Declaration\` section listing every file you touched in this run. ` +
      `One entry per changed file. See worker-prompt.md for the four categories (\`declared\` / \`extension\` / \`opportunistic\` / \`incidental\`) and the bullet/table formats. ` +
      `Phase 2 logs a warning when this section is missing — Phase 3 will hard-fail.`;
  }

  return prompt;
}

/**
 * Read <configDir>/<baseName> and, if a sibling <baseName-minus-md>.local.md
 * exists with non-blank content, return canonical + "\n\n" + local.
 * Missing or blank local file returns canonical alone (silent, optional-by-design).
 * Missing canonical propagates the underlying readFileSync error.
 */
export function readPromptWithLocal(configDir: string, baseName: string): string {
  const canonical = readFileSync(join(configDir, baseName), "utf-8");
  const localName = baseName.replace(/\.md$/, ".local.md");
  const localPath = join(configDir, localName);
  if (existsSync(localPath)) {
    const local = readFileSync(localPath, "utf-8").trim();
    if (local.length > 0) return canonical + "\n\n" + local;
  }
  return canonical;
}

/**
 * Resolve the model/effort that actually drive a phase, so the same values feed
 * both the engine args and the PID file's status fields (single source of truth).
 * Codex ignores `--effort`, so effort is omitted for it.
 */
export function workerModelEffort(
  config: DangeresqueConfig,
): { model: string; effort?: string } {
  if (config.engine === "codex") {
    return { model: config.codexModel ?? config.model };
  }
  return { model: config.model, effort: config.effort };
}

export function reviewModelEffort(
  config: DangeresqueConfig,
): { model: string; effort?: string } {
  if (config.engine === "codex") {
    return {
      model:
        config.codexReviewModel ??
        config.codexModel ??
        config.reviewModel ??
        config.model,
    };
  }
  return {
    model: config.reviewModel ?? config.model,
    effort: config.reviewEffort ?? config.effort,
  };
}

export function buildClaudeWorkerArgs(
  opts: RunOptions,
  worktreeName: string,
  archivePath: string
): { args: string[]; workerSessionId: string; prompt: string } {
  const { config, projectRoot } = opts;
  const configDir = join(projectRoot, CONFIG_DIR);
  const headless = config.headless;

  const args: string[] = [];

  if (headless) {
    args.push("-p");
  }

  const { model, effort } = workerModelEffort(config);
  args.push("--worktree", worktreeName);
  args.push("--model", model);
  if (effort) {
    args.push("--effort", effort);
  }

  args.push("--permission-mode", config.permissionMode);

  args.push("--append-system-prompt", readPromptWithLocal(configDir, config.workerPrompt));

  if (config.allowedTools.length > 0) {
    args.push("--allowed-tools", ...config.allowedTools);
  }
  if (config.disallowedTools.length > 0) {
    args.push("--disallowed-tools", ...config.disallowedTools);
  }

  args.push("--name", `dangeresque-worker-${worktreeName}`);
  const workerSessionId = randomUUID();
  args.push("--session-id", workerSessionId);

  const prompt = buildTaskPrompt(opts, archivePath);

  // Non-headless (interactive) claude has no way to pre-pipe the user prompt —
  // stdin is the operator's TTY. Fall back to positional argv (argv leak is
  // documented; default config is headless so AFK runs use the stdin path).
  if (!headless) args.push(prompt);

  return { args, workerSessionId, prompt };
}

export function buildClaudeReviewArgs(
  opts: RunOptions,
  worktreeName: string,
  archivePath: string,
  verification?: VerificationOutcome | null,
): { args: string[]; reviewSessionId: string; prompt: string } {
  const { config, projectRoot } = opts;
  const configDir = join(projectRoot, CONFIG_DIR);
  const headless = config.headless;
  const { model: reviewModel, effort: reviewEffort } = reviewModelEffort(config);

  const args: string[] = [];

  if (headless) {
    args.push("-p");
  }

  args.push("--worktree", worktreeName);

  args.push("--model", reviewModel);
  if (reviewEffort) {
    args.push("--effort", reviewEffort);
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

  args.push("--append-system-prompt", readPromptWithLocal(configDir, config.reviewPrompt));

  args.push("--name", `dangeresque-review-${worktreeName}`);
  const reviewSessionId = randomUUID();
  args.push("--session-id", reviewSessionId);

  const diffBase = resolveDiffBase(opts.projectRoot);
  let diffStat = "";
  try {
    diffStat = execSync(`git diff ${diffBase} --stat`, {
      cwd: join(opts.projectRoot, ".claude", "worktrees", worktreeName),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    diffStat = "(could not capture diff stat)";
  }

  const prompt = buildReviewPrompt(opts, archivePath, diffStat, diffBase, verification);

  // Non-headless (interactive) claude has no way to pre-pipe the user prompt —
  // stdin is the operator's TTY. Fall back to positional argv (argv leak is
  // documented; default config is headless so AFK runs use the stdin path).
  if (!headless) args.push(prompt);

  return { args, reviewSessionId, prompt };
}

function buildReviewPrompt(
  opts: RunOptions,
  archivePath: string,
  diffStat: string,
  diffBase: string,
  verification?: VerificationOutcome | null,
): string {
  const { issueData } = opts;
  const header =
    `You are an adversarial reviewer of an AFK worker run.\n` +
    `The task was GitHub Issue #${issueData.number}: ${issueData.title}\n` +
    `Mode: ${opts.mode ?? "INVESTIGATE"}\n\n` +
    `## Issue Body\n\n${issueData.body}\n` +
    formatIssueComments(issueData);

  return (
    `${header}\n\n` +
    `## Actual Diff (ground truth — captured automatically)\n\`\`\`\n${diffStat}\n\`\`\`\n\n` +
    formatVerificationSection(verification) +
    `## Run Artifact\n\n` +
    `The worker's run result lives in the worktree at: ${archivePath}\n` +
    `(Run artifacts are stored locally and gitignored — they are NOT in the diff.) ` +
    `Treat this as a claims document — verify against the diff. ` +
    `Append your review findings to the SAME file.\n\n` +
    `Start by running git diff ${diffBase} to see full code changes. ` +
    `Then read the run artifact and compare the worker's claims against the diff. ` +
    `Any file-count discrepancy is an automatic FAIL.\n\n` +
    `Follow review-prompt.md.`
  );
}

function formatVerificationSection(verification: VerificationOutcome | null | undefined): string {
  if (verification === undefined) {
    return "## Verification (pre-review, captured automatically)\n\nVerification not run this session.\n\n";
  }
  if (verification === null || verification.results.length === 0) {
    return "## Verification (pre-review, captured automatically)\n\nVerification not run this session.\n\n";
  }

  const lines: string[] = ["## Verification (pre-review, captured automatically)", "", "The CLI ran the project's configured verification commands in the worktree before dispatching review:", "", "```"];
  for (const r of verification.results) {
    const status = r.exit_code === 0 ? "PASS" : r.timed_out ? "TIMEOUT" : "FAIL";
    const dur = r.duration_ms < 1000 ? `${r.duration_ms}ms` : `${(r.duration_ms / 1000).toFixed(1)}s`;
    const policy = r.on_failure === "block" ? "[block]" : "[warn]";
    lines.push(`  ${r.name.padEnd(12)} ${policy} ${r.cmd.padEnd(40)} ${status} (exit=${r.exit_code}, ${dur})`);
  }
  lines.push("```", "");
  lines.push(
    "You do NOT need to re-run these commands. Treat these results as ground truth: " +
      "if the worker's claims contradict them (e.g. claims \"tests pass\" but verification " +
      "shows test=FAIL), that is grounds for REJECT. The artifact's own `## Verification` " +
      "section has full stderr excerpts for any failure.",
  );
  if (verification.blocked) {
    lines.push("");
    lines.push(
      "**Note:** A `block`-policy command failed; the run is already classified as failure. " +
        "Your review is still useful for diagnosing scope/regression issues, but ACCEPT is not appropriate.",
    );
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

export function buildCodexWorkerArgs(
  opts: RunOptions,
  worktreeName: string,
  archivePath: string
): { args: string[]; prompt: string } {
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);
  const configDir = join(opts.projectRoot, CONFIG_DIR);
  const workerPromptContent = readPromptWithLocal(configDir, opts.config.workerPrompt);
  const prompt =
    workerPromptContent +
    `\n\n` +
    buildTaskPrompt(opts, archivePath) +
    `\n\nEffort preference: ${opts.config.effort} (map this to response depth and planning thoroughness).`;

  const args = [
    "exec",
    "--json",
    "--full-auto",
    "--model", workerModelEffort(opts.config).model,
    "-c", "sandbox_workspace_write.network_access=true",
    "--cd", worktreePath,
    "-",
  ];
  return { args, prompt };
}

export function buildCodexReviewArgs(
  opts: RunOptions,
  worktreeName: string,
  archivePath: string,
  verification?: VerificationOutcome | null,
): { args: string[]; prompt: string } {
  const diffBase = resolveDiffBase(opts.projectRoot);
  let diffStat = "";
  try {
    diffStat = execSync(`git diff ${diffBase} --stat`, {
      cwd: join(opts.projectRoot, ".claude", "worktrees", worktreeName),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    diffStat = "(could not capture diff stat)";
  }

  const reviewModel = reviewModelEffort(opts.config).model;
  const reviewEffort = opts.config.reviewEffort ?? opts.config.effort;
  const configDir = join(opts.projectRoot, CONFIG_DIR);
  const reviewPromptContent = readPromptWithLocal(configDir, opts.config.reviewPrompt);
  const prompt =
    reviewPromptContent +
    `\n\n` +
    buildReviewPrompt(opts, archivePath, diffStat, diffBase, verification) +
    `\n\nEffort preference: ${reviewEffort} (map this to response depth and planning thoroughness).`;

  const args = [
    "exec",
    "--json",
    "--full-auto",
    "--model", reviewModel,
    "-c", "sandbox_workspace_write.network_access=true",
    "--cd", join(opts.projectRoot, ".claude", "worktrees", worktreeName),
    "-",
  ];
  return { args, prompt };
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
      `  dangeresque merge   ${branch}   (keeps the run report in .dangeresque/runs/)\n` +
      `  dangeresque discard ${branch}   (deletes the run report along with the worktree)\n` +
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

function createCodexLogPath(projectRoot: string, worktreeName: string, phase: "worker" | "review"): string {
  const logDir = join(projectRoot, ".dangeresque", "sessions", worktreeName);
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

  // Carry prior runs for this issue into the new worktree. The runs dir is
  // gitignored, so it doesn't ride the worktree's branch — dangeresque
  // mirrors it across at dispatch time so workers see prior-run history.
  mirrorIssueRuns(opts.projectRoot, worktreePath, opts.issueData.number);

  const archivePath = computeRunArchivePath(
    worktreePath,
    opts.issueData.number,
    opts.mode ?? "INVESTIGATE"
  );
  mkdirSync(dirname(archivePath), { recursive: true });

  if (opts.config.engine === "codex") {
    writeCodexRulesFile(worktreePath, opts.config.disallowedTools);
    const { args, prompt } = buildCodexWorkerArgs(opts, worktreeName, archivePath);
    const logPath = createCodexLogPath(opts.projectRoot, worktreeName, "worker");

    return new Promise((resolve, reject) => {
      console.log(`\n🏗️  Starting worker in worktree: ${worktreeName}`);
      console.log(`📋 Branch: ${branch}`);
      console.log(`⚙️  Engine: codex`);
      console.log(`🔧 Model: ${opts.config.model}`);
      console.log(`📂 Config: ${join(opts.projectRoot, CONFIG_DIR)}/`);
      console.log(`📝 Run artifact: ${relative(opts.projectRoot, archivePath)}`);
      console.log(`\n--- Worker session starting ---\n`);

      // detached:true makes the engine a process-group leader, letting
      // `dangeresque stop` cascade SIGKILL to grandchildren (e.g. a stuck
      // Bash tool) via `process.kill(-pid, …)`. Codex always pipes stdio,
      // so detaching is safe — it does not steal the controlling terminal.
      const child = spawn("codex", args, {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        detached: true,
      });
      trackEngine(child);

      child.stdin?.on("error", () => { /* tolerate EPIPE if codex exits before reading */ });
      child.stdin?.end(prompt);

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
          cliPid: process.pid,
          engine: "codex",
          projectHash: hash,
          workerLogPath: logPath,
          archivePath,
          ...workerModelEffort(opts.config),
          phase: opts.mode ?? "INVESTIGATE",
        });
      }

      child.on("error", (err: Error) => {
        logStream.end();
        removePidFile(worktreePath);
        reject(new Error(`Failed to start codex: ${err.message}`));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        logStream.end();
        removePidFile(worktreePath);
        const exitCode = exitCodeFromCloseEvent(code, signal);
        if (exitCode === 0) {
          commitWorkerChanges(
            worktreePath,
            opts.issueData.number,
            opts.mode ?? "INVESTIGATE"
          );
        }
        resolve({ worktreeName, branch, exitCode, archivePath, workerLogPath: logPath });
      });
    });
  }

  const { args, workerSessionId, prompt } = buildClaudeWorkerArgs(opts, worktreeName, archivePath);
  const useStdin = opts.config.headless;

  return new Promise((resolve, reject) => {
    console.log(`\n🏗️  Starting worker in worktree: ${worktreeName}`);
    console.log(`📋 Branch: ${branch}`);
    console.log(`🔧 Model: ${opts.config.model}`);
    console.log(`📂 Config: ${join(opts.projectRoot, CONFIG_DIR)}/`);
    console.log(`📝 Run artifact: ${relative(opts.projectRoot, archivePath)}`);
    console.log(`\n--- Worker session starting ---\n`);

    // Detach only on the headless path. Interactive claude inherits the
    // operator's controlling TTY ("inherit"), and detaching there steals
    // terminal control. The headless path pipes stdin and inherits
    // stdout/stderr, which is safe to detach.
    const child = spawn("claude", args, {
      cwd: opts.projectRoot,
      stdio: useStdin ? ["pipe", "inherit", "inherit"] : "inherit",
      env: { ...process.env },
      detached: useStdin,
    });
    trackEngine(child);

    if (useStdin) {
      child.stdin?.on("error", () => { /* tolerate EPIPE if claude exits before reading */ });
      child.stdin?.end(prompt);
    }

    if (child.pid) {
      try {
        writePidFile(worktreePath, child.pid, {
          cliPid: process.pid,
          workerSessionId,
          projectHash: hash,
          engine: "claude",
          archivePath,
          ...workerModelEffort(opts.config),
          phase: opts.mode ?? "INVESTIGATE",
        });
      } catch {
        /* worktree not ready yet — ok */
      }
    }

    child.on("error", (err: Error) => {
      removePidFile(worktreePath);
      reject(new Error(`Failed to start claude: ${err.message}`));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      removePidFile(worktreePath);
      const exitCode = exitCodeFromCloseEvent(code, signal);
      resolve({
        worktreeName,
        branch,
        exitCode,
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
  workerSessionId?: string,
  workerLogPath?: string,
  verification?: VerificationOutcome | null,
): Promise<RunResult> {
  const branch = `worktree-${worktreeName}`;
  const worktreePath = join(opts.projectRoot, ".claude", "worktrees", worktreeName);
  const hash = projectHash(worktreePath);

  if (opts.config.engine === "codex") {
    const { args, prompt } = buildCodexReviewArgs(opts, worktreeName, archivePath, verification);
    const logPath = createCodexLogPath(opts.projectRoot, worktreeName, "review");

    return new Promise((resolve, reject) => {
      console.log(`\n--- Review session starting ---\n`);

      const child = spawn("codex", args, {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        detached: true,
      });
      trackEngine(child);

      child.stdin?.on("error", () => { /* tolerate EPIPE if codex exits before reading */ });
      child.stdin?.end(prompt);

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
          cliPid: process.pid,
          engine: "codex",
          projectHash: hash,
          workerLogPath: workerLogPath ?? existing?.workerLogPath,
          reviewLogPath: logPath,
          archivePath,
          ...reviewModelEffort(opts.config),
          phase: "REVIEW",
        });
      }

      child.on("error", (err: Error) => {
        logStream.end();
        removePidFile(worktreePath);
        reject(new Error(`Failed to start codex review: ${err.message}`));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        logStream.end();
        removePidFile(worktreePath);
        const exitCode = exitCodeFromCloseEvent(code, signal);
        resolve({ worktreeName, branch, exitCode, archivePath });
      });
    });
  }

  const { args, reviewSessionId, prompt } = buildClaudeReviewArgs(opts, worktreeName, archivePath, verification);
  const useStdin = opts.config.headless;

  return new Promise((resolve, reject) => {
    console.log(`\n--- Review session starting ---\n`);

    const child = spawn("claude", args, {
      cwd: opts.projectRoot,
      stdio: useStdin ? ["pipe", "inherit", "inherit"] : "inherit",
      env: { ...process.env },
      detached: useStdin,
    });
    trackEngine(child);

    if (useStdin) {
      child.stdin?.on("error", () => { /* tolerate EPIPE if claude exits before reading */ });
      child.stdin?.end(prompt);
    }

    if (child.pid) {
      writePidFile(worktreePath, child.pid, {
        cliPid: process.pid,
        reviewSessionId,
        workerSessionId,
        projectHash: hash,
        engine: "claude",
        archivePath,
        ...reviewModelEffort(opts.config),
        phase: "REVIEW",
      });
    }

    child.on("error", (err: Error) => {
      removePidFile(worktreePath);
      reject(new Error(`Failed to start claude review: ${err.message}`));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      removePidFile(worktreePath);
      const exitCode = exitCodeFromCloseEvent(code, signal);
      resolve({ worktreeName, branch, exitCode, archivePath });
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
  reviewModel?: string;
  reviewEffort?: string;
}

function buildRunTag(mode: string, opts: CommentOptions): string {
  const parts = [`dangeresque ${mode}`];
  if (opts.engine) parts.push(`engine=${opts.engine}`);
  if (opts.model) parts.push(`model=${opts.model}`);
  if (opts.effort) parts.push(`effort=${opts.effort}`);
  if (opts.reviewModel && opts.reviewModel !== opts.model) {
    parts.push(`review-model=${opts.reviewModel}`);
  }
  if (opts.reviewEffort && opts.reviewEffort !== opts.effort) {
    parts.push(`review-effort=${opts.reviewEffort}`);
  }
  return `**[${parts.join(" · ")}]**`;
}

export function postRunComment(opts: CommentOptions): void {
  const { projectRoot, issueNumber, mode, worktreeName, archivePath, workerExitCode, reviewExitCode } = opts;
  const tag = buildRunTag(mode, opts);
  const archiveRel = relative(projectRoot, archivePath);

  let comment: string;
  if (workerExitCode !== 0) {
    comment =
      `${tag} ❌ FAILED\n\n` +
      `Worker exited with code ${workerExitCode}. No review was run.\n\n` +
      `- Worktree: \`.claude/worktrees/${worktreeName}/\`\n` +
      `- Expected run artifact: \`${archiveRel}\` ` +
      `(${existsSync(archivePath) ? "partial output present" : "not written"})\n\n` +
      `Inspect the worker session log with \`dangeresque logs\`, then \`dangeresque discard worktree-${worktreeName}\` to clean up.`;
  } else if (!existsSync(archivePath)) {
    comment =
      `${tag} ⚠️  Worker exited cleanly but wrote no run artifact.\n\n` +
      `Expected file: \`${archiveRel}\`\n` +
      `Worktree: \`.claude/worktrees/${worktreeName}/\``;
  } else {
    // Post just the SUMMARY block, never the full body. The artifact lives
    // locally (gitignored) and is referenced by path so collaborators can
    // read it via `dangeresque results --issue N` or directly on disk.
    const content = readFileSync(archivePath, "utf-8");
    const summary = parseSummaryBlock(content);
    const summaryBlock = summary
      ? `<!-- SUMMARY -->\n${summary}\n<!-- /SUMMARY -->`
      : `_(no SUMMARY block found in artifact)_`;
    const reviewNote = reviewExitCode !== undefined && reviewExitCode !== 0
      ? `\n\n⚠️  Review process exited with code ${reviewExitCode} — full artifact may be incomplete.`
      : "";
    comment =
      `${tag}\n\n${summaryBlock}\n\n` +
      `Local artifact: \`${archiveRel}\` ` +
      `(\`dangeresque results --issue ${issueNumber}\`)${reviewNote}`;
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
