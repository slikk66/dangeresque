import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG_DIR, RUNS_DIR, RESULT_FILE, PID_FILE } from "./config.js";

export interface PidInfo {
  pid: number;
  startedAt: number; // epoch ms
  workerSessionId?: string;
  reviewSessionId?: string;
  projectHash?: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  commitEpoch: number;
  pidInfo?: PidInfo;
  running: boolean;
}

export function listWorktrees(projectRoot: string): WorktreeInfo[] {
  const output = execSync("git worktree list --porcelain", {
    cwd: projectRoot,
    encoding: "utf-8",
  });

  const worktrees: WorktreeInfo[] = [];
  const blocks = output.trim().split("\n\n");

  for (const block of blocks) {
    const lines = block.split("\n");
    const pathLine = lines.find((l: string) => l.startsWith("worktree "));
    const branchLine = lines.find((l: string) => l.startsWith("branch "));
    const headLine = lines.find((l: string) => l.startsWith("HEAD "));

    if (!pathLine || !branchLine) continue;

    const path = pathLine.replace("worktree ", "");
    const branch = branchLine.replace("branch refs/heads/", "");
    const head = headLine?.replace("HEAD ", "") ?? "";

    // Include all Claude Code worktrees (they live under .claude/worktrees/)
    if (path.includes(".claude/worktrees/")) {
      let commitEpoch = 0;
      try {
        const ts = execSync(`git log -1 --format=%ct ${head}`, {
          cwd: projectRoot, encoding: "utf-8", stdio: "pipe",
        }).trim();
        commitEpoch = parseInt(ts, 10) || 0;
      } catch { /* fallback to 0 */ }

      // Check PID file for running state
      const { pidInfo, running } = readPidState(path);
      worktrees.push({ path, branch, head, commitEpoch, pidInfo, running });
    }
  }

  return worktrees;
}

// --- PID file management ---

function readPidState(worktreePath: string): { pidInfo?: PidInfo; running: boolean } {
  const pidPath = join(worktreePath, PID_FILE);
  if (!existsSync(pidPath)) return { running: false };

  try {
    const pidInfo: PidInfo = JSON.parse(readFileSync(pidPath, "utf-8"));
    // Check if process is alive
    try {
      process.kill(pidInfo.pid, 0);
      return { pidInfo, running: true };
    } catch {
      return { pidInfo, running: false };
    }
  } catch {
    return { running: false };
  }
}

export function writePidFile(worktreePath: string, pid: number, extra?: Partial<PidInfo>): void {
  const pidPath = join(worktreePath, PID_FILE);
  const info: PidInfo = { pid, startedAt: Date.now(), ...extra };
  writeFileSync(pidPath, JSON.stringify(info));
}

export function updatePidFile(worktreePath: string, partial: Partial<PidInfo>): void {
  const pidPath = join(worktreePath, PID_FILE);
  if (!existsSync(pidPath)) return;
  try {
    const existing: PidInfo = JSON.parse(readFileSync(pidPath, "utf-8"));
    writeFileSync(pidPath, JSON.stringify({ ...existing, ...partial }));
  } catch { /* ignore */ }
}

export function readPidFile(worktreePath: string): PidInfo | undefined {
  const pidPath = join(worktreePath, PID_FILE);
  if (!existsSync(pidPath)) return undefined;
  try {
    return JSON.parse(readFileSync(pidPath, "utf-8"));
  } catch { return undefined; }
}

export function removePidFile(worktreePath: string): void {
  const pidPath = join(worktreePath, PID_FILE);
  if (existsSync(pidPath)) rmSync(pidPath);
}

/**
 * Resolve a shorthand branch name to the actual branch.
 * Tries: exact → worktree-dangeresque-<input> → worktree-<input>
 */
export function resolveBranch(projectRoot: string, input: string): string {
  const candidates = [
    input,
    `worktree-dangeresque-${input}`,
    `worktree-${input}`,
  ];

  for (const candidate of candidates) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return candidate;
    } catch {
      // Not found, try next
    }
  }

  throw new Error(
    `Branch not found. Tried: ${candidates.join(", ")}\nRun 'dangeresque status' to see active worktrees.`
  );
}

// --- Archive functions ---

function getRunsDir(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, RUNS_DIR);
}

function getIssueRunsDir(projectRoot: string, issueNumber: number): string {
  return join(getRunsDir(projectRoot), `issue-${issueNumber}`);
}

/**
 * Archive RUN_RESULT.md from a worktree to .dangeresque/runs/issue-<N>/
 * Returns the archive path, or null if no RUN_RESULT.md found.
 */
export function archiveRunResult(
  projectRoot: string,
  worktreePath: string,
  issueNumber: number | undefined,
  mode: string
): string | null {
  const resultPath = join(worktreePath, RESULT_FILE);
  if (!existsSync(resultPath)) return null;
  if (!issueNumber) return null;

  const issueDir = getIssueRunsDir(projectRoot, issueNumber);
  mkdirSync(issueDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archiveName = `${timestamp}-${mode}.md`;
  const archivePath = join(issueDir, archiveName);

  copyFileSync(resultPath, archivePath);
  return archivePath;
}

/**
 * List archived run results for an issue, sorted chronologically.
 */
export function listArchivedRuns(projectRoot: string, issueNumber: number): string[] {
  const issueDir = getIssueRunsDir(projectRoot, issueNumber);
  if (!existsSync(issueDir)) return [];
  return readdirSync(issueDir).filter((f) => f.endsWith(".md")).sort();
}

/**
 * Read an archived run result file.
 */
export function readArchivedRun(projectRoot: string, issueNumber: number, filename: string): string {
  return readFileSync(join(getIssueRunsDir(projectRoot, issueNumber), filename), "utf-8");
}

/**
 * Get the latest archived run result for an issue.
 */
export function getLatestArchivedRun(projectRoot: string, issueNumber: number): string | null {
  const files = listArchivedRuns(projectRoot, issueNumber);
  if (files.length === 0) return null;
  return readArchivedRun(projectRoot, issueNumber, files[files.length - 1]);
}

/**
 * Parse the <!-- SUMMARY --> block from a RUN_RESULT.md content string.
 * Returns the summary lines, or null if no block found.
 */
export function parseSummaryBlock(content: string): string | null {
  const match = content.match(/<!-- SUMMARY -->\n([\s\S]*?)\n<!-- \/SUMMARY -->/);
  return match ? match[1].trim() : null;
}

/**
 * Extract a one-line summary from an archived run filename + content.
 * Format: "Run N (MODE): status — files, verdict"
 */
export function formatRunOneLiner(filename: string, content: string, index: number): string {
  // Extract mode from filename: 2026-04-02T14-30-00-IMPLEMENT.md → IMPLEMENT
  const modeMatch = filename.match(/-([A-Z]+)\.md$/);
  const mode = modeMatch ? modeMatch[1] : "UNKNOWN";

  const summary = parseSummaryBlock(content);
  if (summary) {
    // Parse first line: "Mode: IMPLEMENT | Status: implemented, unverified"
    const statusMatch = summary.match(/Status:\s*(.+)/);
    const status = statusMatch ? statusMatch[1].trim() : "unknown";
    const filesMatch = summary.match(/Files:\s*(.+)/);
    const files = filesMatch ? filesMatch[1].trim() : "";
    return `Run ${index + 1} (${mode}): ${status}${files ? ` — ${files}` : ""}`;
  }

  // Fallback: no summary block (older run)
  return `Run ${index + 1} (${mode}): ${filename}`;
}

/**
 * Delete archived runs for an issue.
 */
export function cleanArchivedRuns(projectRoot: string, issueNumber: number): { success: boolean; message: string } {
  const issueDir = getIssueRunsDir(projectRoot, issueNumber);
  if (!existsSync(issueDir)) {
    return { success: false, message: `No archived runs found for issue #${issueNumber}` };
  }

  const files = listArchivedRuns(projectRoot, issueNumber);
  rmSync(issueDir, { recursive: true });
  return { success: true, message: `Deleted ${files.length} archived run(s) for issue #${issueNumber}` };
}

// --- Worktree operations ---

/**
 * Extract issue number from branch name.
 * worktree-dangeresque-investigate-63 → 63
 */
export function extractIssueNumber(branch: string): number | undefined {
  const match = branch.match(/-(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Extract mode from branch name.
 * worktree-dangeresque-investigate-63 → INVESTIGATE
 */
function extractMode(branch: string): string {
  // Remove worktree- and dangeresque- prefixes, then take the part before the issue number
  const stripped = branch.replace(/^worktree-/, "").replace(/^dangeresque-/, "");
  const modeMatch = stripped.match(/^([a-z]+)-\d+$/);
  return modeMatch ? modeMatch[1].toUpperCase() : "UNKNOWN";
}

export function mergeWorktree(
  projectRoot: string,
  branch: string,
  issueNumber?: number,
  mode?: string
): { success: boolean; message: string } {
  try {
    const worktreePathForClean = join(projectRoot, ".claude", "worktrees", branch.replace("worktree-", ""));
    const resultFile = join(worktreePathForClean, RESULT_FILE);

    // Archive RUN_RESULT.md before removing it
    const effectiveIssue = issueNumber ?? extractIssueNumber(branch);
    const effectiveMode = mode ?? extractMode(branch);
    if (existsSync(resultFile) && effectiveIssue) {
      archiveRunResult(projectRoot, worktreePathForClean, effectiveIssue, effectiveMode);
    }

    // Strip RUN_RESULT.md from worktree branch before merging (it's gitignored on main)
    if (existsSync(resultFile)) {
      try {
        execSync(`git rm -f "${RESULT_FILE}"`, { cwd: worktreePathForClean, encoding: "utf-8", stdio: "pipe" });
        execSync(`git commit -m "remove ${RESULT_FILE} before merge"`, { cwd: worktreePathForClean, encoding: "utf-8", stdio: "pipe" });
      } catch {
        // May not be tracked — fine
      }
    }

    const headBefore = execSync("git rev-parse HEAD", {
      cwd: projectRoot, encoding: "utf-8", stdio: "pipe",
    }).trim();

    const mergeOutput = execSync(`git merge ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });

    const headAfter = execSync("git rev-parse HEAD", {
      cwd: projectRoot, encoding: "utf-8", stdio: "pipe",
    }).trim();

    if (headBefore === headAfter) {
      return {
        success: false,
        message: `Merge had no effect — HEAD unchanged (${headBefore.slice(0, 8)}). git said: "${mergeOutput.trim()}". Worktree NOT cleaned up.`,
      };
    }

    // Clean up worktree and branch
    const worktreePath = join(projectRoot, ".claude", "worktrees", branch.replace("worktree-", ""));
    if (existsSync(worktreePath)) {
      execSync(`git worktree remove "${worktreePath}"`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    }

    try {
      execSync(`git branch -d ${branch}`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      // Branch may already be deleted by worktree remove
    }

    return { success: true, message: `Merged ${branch} and cleaned up` };
  } catch (err) {
    return {
      success: false,
      message: `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function discardWorktree(
  projectRoot: string,
  branch: string,
  issueNumber?: number,
  mode?: string
): { success: boolean; message: string } {
  try {
    const worktreeName = branch.replace("worktree-", "");
    const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);

    // Archive RUN_RESULT.md before discarding
    const effectiveIssue = issueNumber ?? extractIssueNumber(branch);
    const effectiveMode = mode ?? extractMode(branch);
    if (existsSync(worktreePath) && effectiveIssue) {
      archiveRunResult(projectRoot, worktreePath, effectiveIssue, effectiveMode);
    }

    let removedWorktree = false;
    let removedBranch = false;

    if (existsSync(worktreePath)) {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      removedWorktree = true;
    }

    try {
      execSync(`git branch -D ${branch}`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      removedBranch = true;
    } catch {
      // Branch may already be deleted by worktree remove
    }

    if (!removedWorktree && !removedBranch) {
      return { success: false, message: `Nothing to discard: no worktree or branch found for ${branch}` };
    }

    return { success: true, message: `Discarded ${branch} and cleaned up` };
  } catch (err) {
    return {
      success: false,
      message: `Discard failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function getWorktreeResults(
  projectRoot: string,
  branchOrLatest: string | "latest"
): string {
  const worktrees = listWorktrees(projectRoot);

  if (worktrees.length === 0) {
    return `No active dangeresque worktrees found. (cwd=${process.cwd()})`;
  }

  let targetWorktree: WorktreeInfo;

  if (branchOrLatest === "latest") {
    // Latest = most recent commit timestamp
    targetWorktree = worktrees.reduce((a, b) => a.commitEpoch >= b.commitEpoch ? a : b);
  } else {
    const found = worktrees.find(
      (wt) => wt.branch === branchOrLatest || wt.path.includes(branchOrLatest)
    );
    if (!found) {
      return `Worktree not found: ${branchOrLatest}\nActive worktrees: ${worktrees.map((w) => w.branch).join(", ")}`;
    }
    targetWorktree = found;
  }

  const resultPath = join(targetWorktree.path, RESULT_FILE);
  const lines: string[] = [];

  lines.push(`Worktree: ${targetWorktree.path}`);
  lines.push(`Branch:   ${targetWorktree.branch}`);
  lines.push(`HEAD:     ${targetWorktree.head.slice(0, 8)}`);
  lines.push("");

  // Show archived prior runs as one-liners
  const issueNum = extractIssueNumber(targetWorktree.branch);
  if (issueNum) {
    const archived = listArchivedRuns(projectRoot, issueNum);
    if (archived.length > 0) {
      lines.push("--- Previous runs (use --all for full details) ---");
      for (let i = 0; i < archived.length; i++) {
        const content = readArchivedRun(projectRoot, issueNum, archived[i]);
        lines.push(formatRunOneLiner(archived[i], content, i));
      }
      lines.push("");
    }
  }

  // Current RUN_RESULT.md
  if (existsSync(resultPath)) {
    lines.push("--- RUN_RESULT.md ---");
    lines.push(readFileSync(resultPath, "utf-8"));
  } else {
    lines.push("No RUN_RESULT.md found in worktree.");
  }

  // Diff summary
  lines.push("");
  lines.push("--- Diff Summary (vs main) ---");
  try {
    const diff = execSync("git diff main --stat", {
      cwd: targetWorktree.path,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    lines.push(diff.trim() || "No changes.");
  } catch {
    lines.push("Could not generate diff summary.");
  }

  return lines.join("\n");
}

/**
 * Show archived results for a specific issue (used by `results --issue`)
 */
export function getArchivedResults(
  projectRoot: string,
  issueNumber: number,
  showAll: boolean
): string {
  const archived = listArchivedRuns(projectRoot, issueNumber);

  // Check for active worktree with results for this issue
  const worktrees = listWorktrees(projectRoot);
  const activeWorktree = worktrees.find(
    (wt) => extractIssueNumber(wt.branch) === issueNumber
  );
  const activeResultPath = activeWorktree
    ? join(activeWorktree.path, RESULT_FILE)
    : undefined;
  const hasActiveResult = activeResultPath && existsSync(activeResultPath);

  if (archived.length === 0 && !hasActiveResult) {
    return `No archived runs found for issue #${issueNumber}`;
  }

  const lines: string[] = [];

  // Show archived runs
  if (archived.length > 0) {
    lines.push(`Archived runs for issue #${issueNumber} (${archived.length} total)\n`);

    if (showAll && !hasActiveResult) {
      for (let i = 0; i < archived.length; i++) {
        const content = readArchivedRun(projectRoot, issueNumber, archived[i]);
        lines.push(`=== Run ${i + 1}: ${archived[i]} ===`);
        lines.push(content);
        lines.push("");
      }
    } else {
      // One-liners for archived runs (all of them if active worktree has results)
      const showUntil = hasActiveResult ? archived.length : archived.length - 1;
      for (let i = 0; i < showUntil; i++) {
        const content = readArchivedRun(projectRoot, issueNumber, archived[i]);
        lines.push(formatRunOneLiner(archived[i], content, i));
      }

      if (!hasActiveResult) {
        if (archived.length > 1) lines.push("");
        const latestContent = readArchivedRun(projectRoot, issueNumber, archived[archived.length - 1]);
        lines.push(`--- Latest: Run ${archived.length} ---`);
        lines.push(latestContent);
      }
    }
  }

  // Show active worktree results (takes priority as latest)
  if (hasActiveResult && activeWorktree) {
    if (archived.length > 0) lines.push("");
    lines.push(`--- Active worktree: ${activeWorktree.branch} ---`);
    lines.push(`Worktree: ${activeWorktree.path}`);
    lines.push(`Status:   ${activeWorktree.running ? "RUNNING" : "IDLE"}`);
    lines.push("");
    lines.push(readFileSync(activeResultPath!, "utf-8"));

    // Diff summary
    lines.push("");
    lines.push("--- Diff Summary (vs main) ---");
    try {
      const diff = execSync("git diff main --stat", {
        cwd: activeWorktree.path,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      lines.push(diff.trim() || "No changes.");
    } catch {
      lines.push("Could not generate diff summary.");
    }
  }

  return lines.join("\n");
}
