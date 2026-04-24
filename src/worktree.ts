import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, RUNS_DIR, PID_FILE } from "./config.js";

/**
 * Resolve the ref reviewers should diff against. Worktrees branch from
 * origin/HEAD (see createWorktree), and are rebased onto origin/main before
 * review. Diffing against local `main` would bleed local-only commits into the
 * review as phantom deletions when local is ahead of origin. Falls back to
 * `main` when origin is absent (e.g. offline repos, fresh clones without a
 * remote).
 */
export function resolveDiffBase(projectRoot: string): string {
  try {
    const ref = execSync(
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD",
      {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    return ref || "main";
  } catch {
    return "main";
  }
}

export interface PidInfo {
  pid: number;
  startedAt: number; // epoch ms
  workerSessionId?: string;
  reviewSessionId?: string;
  projectHash?: string;
  engine?: "claude" | "codex";
  workerLogPath?: string;
  reviewLogPath?: string;
  /** Absolute path to the run's archive file inside the worktree */
  archivePath?: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  commitEpoch: number;
  pidInfo?: PidInfo;
  running: boolean;
}

export type WorktreeFilter = "all" | "running" | "finished";

export function filterWorktrees(
  worktrees: WorktreeInfo[],
  filter: WorktreeFilter,
): WorktreeInfo[] {
  if (filter === "all") return worktrees;
  if (filter === "running") return worktrees.filter((w) => w.running);
  return worktrees.filter((w) => !w.running);
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

    // Include all dangeresque worktrees (they live under .claude/worktrees/)
    if (path.includes(".claude/worktrees/")) {
      let commitEpoch = 0;
      try {
        const ts = execSync(`git log -1 --format=%ct ${head}`, {
          cwd: projectRoot,
          encoding: "utf-8",
          stdio: "pipe",
        }).trim();
        commitEpoch = parseInt(ts, 10) || 0;
      } catch {
        /* fallback to 0 */
      }

      // Check PID file for running state
      const { pidInfo, running } = readPidState(path);
      worktrees.push({ path, branch, head, commitEpoch, pidInfo, running });
    }
  }

  return worktrees;
}

/**
 * Refuse to proceed if cwd is inside a linked worktree rather than the main checkout.
 * Detects via `git rev-parse --git-dir` vs `--git-common-dir` — they differ inside a
 * linked worktree, match in the main checkout. Throws with a clear remediation message.
 */
export function assertInMainCheckout(
  projectRoot: string,
  command: string,
): void {
  const gitDir = execSync("git rev-parse --path-format=absolute --git-dir", {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const commonDir = execSync(
    "git rev-parse --path-format=absolute --git-common-dir",
    {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    },
  ).trim();

  if (gitDir !== commonDir) {
    const mainCheckout = commonDir.replace(/\/\.git\/?$/, "");
    throw new Error(
      `dangeresque ${command} must run from the main project checkout, not from inside a worktree.\n` +
        `Currently in: ${projectRoot}\n` +
        `cd ${mainCheckout} and retry.`,
    );
  }
}

// --- PID file management ---

function readPidState(worktreePath: string): {
  pidInfo?: PidInfo;
  running: boolean;
} {
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

export function writePidFile(
  worktreePath: string,
  pid: number,
  extra?: Partial<PidInfo>,
): void {
  const pidPath = join(worktreePath, PID_FILE);
  const info: PidInfo = { pid, startedAt: Date.now(), ...extra };
  writeFileSync(pidPath, JSON.stringify(info));
}

export function updatePidFile(
  worktreePath: string,
  partial: Partial<PidInfo>,
): void {
  const pidPath = join(worktreePath, PID_FILE);
  if (!existsSync(pidPath)) return;
  try {
    const existing: PidInfo = JSON.parse(readFileSync(pidPath, "utf-8"));
    writeFileSync(pidPath, JSON.stringify({ ...existing, ...partial }));
  } catch {
    /* ignore */
  }
}

export function readPidFile(worktreePath: string): PidInfo | undefined {
  const pidPath = join(worktreePath, PID_FILE);
  if (!existsSync(pidPath)) return undefined;
  try {
    return JSON.parse(readFileSync(pidPath, "utf-8"));
  } catch {
    return undefined;
  }
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
    `Branch not found. Tried: ${candidates.join(", ")}\nRun 'dangeresque status' to see active worktrees.`,
  );
}

// --- Run archive readers ---
// Workers write their run result inside the worktree at
// <worktree>/.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md and commit it on
// the worktree branch. It only lands at <projectRoot>/.dangeresque/runs/…
// after `dangeresque merge`. Callers pass whichever root matches the lookup
// they want: worktree path for pre-merge, project root for post-merge.

function getRunsDir(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, RUNS_DIR);
}

function getIssueRunsDir(projectRoot: string, issueNumber: number): string {
  return join(getRunsDir(projectRoot), `issue-${issueNumber}`);
}

/**
 * List run result files for an issue, sorted chronologically (oldest first).
 */
export function listArchivedRuns(
  projectRoot: string,
  issueNumber: number,
): string[] {
  const issueDir = getIssueRunsDir(projectRoot, issueNumber);
  if (!existsSync(issueDir)) return [];
  return readdirSync(issueDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/**
 * Read a specific run result file for an issue.
 */
export function readArchivedRun(
  projectRoot: string,
  issueNumber: number,
  filename: string,
): string {
  return readFileSync(
    join(getIssueRunsDir(projectRoot, issueNumber), filename),
    "utf-8",
  );
}

/**
 * Parse the <!-- SUMMARY --> block from a run result file's content.
 * Returns the summary lines, or null if no block found.
 */
export function parseSummaryBlock(content: string): string | null {
  const match = content.match(
    /<!-- SUMMARY -->\n([\s\S]*?)\n<!-- \/SUMMARY -->/,
  );
  return match ? match[1].trim() : null;
}

/**
 * Extract a one-line summary from an archived run filename + content.
 * Format: "Run N (MODE): status — files, verdict"
 */
export function formatRunOneLiner(
  filename: string,
  content: string,
  index: number,
): string {
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
export function cleanArchivedRuns(
  projectRoot: string,
  issueNumber: number,
): { success: boolean; message: string } {
  const issueDir = getIssueRunsDir(projectRoot, issueNumber);
  if (!existsSync(issueDir)) {
    return {
      success: false,
      message: `No archived runs found for issue #${issueNumber}`,
    };
  }

  const files = listArchivedRuns(projectRoot, issueNumber);
  rmSync(issueDir, { recursive: true });
  return {
    success: true,
    message: `Deleted ${files.length} archived run(s) for issue #${issueNumber}`,
  };
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
export function extractMode(branch: string): string {
  // Remove worktree- and dangeresque- prefixes, then take the part before the issue number
  const stripped = branch
    .replace(/^worktree-/, "")
    .replace(/^dangeresque-/, "");
  const modeMatch = stripped.match(/^([a-z]+)-\d+$/);
  return modeMatch ? modeMatch[1].toUpperCase() : "UNKNOWN";
}

export type WorktreePhase = "merge" | "cleanup" | "branch-delete" | "noop";

export interface WorktreeOpResult {
  success: boolean;
  message: string;
  phase?: WorktreePhase;
  /** True iff main's HEAD advanced as a result of this call. */
  headAdvanced?: boolean;
  headBefore?: string;
  headAfter?: string;
}

export function mergeWorktree(
  projectRoot: string,
  branch: string,
): WorktreeOpResult {
  let headBefore: string;
  try {
    headBefore = execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (err) {
    return {
      success: false,
      phase: "merge",
      headAdvanced: false,
      message: `Could not read HEAD before merge: ${err instanceof Error ? err.message : String(err)}. Main is unchanged.`,
    };
  }

  // Phase 1: merge
  let mergeOutput: string;
  try {
    mergeOutput = execSync(`git merge ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    return {
      success: false,
      phase: "merge",
      headAdvanced: false,
      headBefore,
      message: `Merge did not occur: ${err instanceof Error ? err.message : String(err)}. Main is unchanged at ${headBefore.slice(0, 8)}.`,
    };
  }

  let headAfter: string;
  try {
    headAfter = execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (err) {
    return {
      success: false,
      phase: "merge",
      headBefore,
      message: `Could not read HEAD after merge: ${err instanceof Error ? err.message : String(err)}. Main state unknown — inspect 'git log' before retrying.`,
    };
  }

  if (headBefore === headAfter) {
    return {
      success: false,
      phase: "noop",
      headAdvanced: false,
      headBefore,
      headAfter,
      message: `Merge had no effect — HEAD unchanged (${headBefore.slice(0, 8)}). git said: "${mergeOutput.trim()}". Worktree NOT cleaned up.`,
    };
  }

  const worktreePath = join(
    projectRoot,
    ".claude",
    "worktrees",
    branch.replace("worktree-", ""),
  );

  // Phase 2: worktree cleanup
  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove "${worktreePath}"`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err) {
      return {
        success: false,
        phase: "cleanup",
        headAdvanced: true,
        headBefore,
        headAfter,
        message:
          `Merge succeeded — main is now at ${headAfter.slice(0, 8)} (was ${headBefore.slice(0, 8)}). ` +
          `Worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Recovery: (1) inspect ${worktreePath} for uncommitted work, ` +
          `(2) 'git worktree remove --force "${worktreePath}"' if safe, ` +
          `(3) 'git branch -D ${branch}'.`,
      };
    }
  }

  // Phase 3: branch delete. Use -D because the dangeresque workflow merges
  // locally before the human pushes — so -d's upstream-tracking safety check
  // refuses even though the branch is merged to HEAD. Phase 1's
  // headBefore !== headAfter guard already enforces the real invariant (merge
  // landed on local HEAD), which is the check we actually care about.
  try {
    execSync(`git branch -D ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    return {
      success: false,
      phase: "branch-delete",
      headAdvanced: true,
      headBefore,
      headAfter,
      message:
        `Merge succeeded and worktree removed — main is now at ${headAfter.slice(0, 8)} (was ${headBefore.slice(0, 8)}). ` +
        `Branch delete failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Recovery: check 'git branch --list ${branch}' and 'git worktree list'; if the branch is checked out in another worktree, remove that worktree first, then 'git branch -D ${branch}'.`,
    };
  }

  return {
    success: true,
    phase: "merge",
    headAdvanced: true,
    headBefore,
    headAfter,
    message: `Merged ${branch} into main. Main: ${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}.`,
  };
}

export function discardWorktree(
  projectRoot: string,
  branch: string,
): WorktreeOpResult {
  const worktreeName = branch.replace("worktree-", "");
  const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);

  let removedWorktree = false;

  // Phase 1: worktree cleanup
  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      removedWorktree = true;
    } catch (err) {
      return {
        success: false,
        phase: "cleanup",
        message:
          `Worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Recovery: (1) inspect ${worktreePath}, ` +
          `(2) 'git worktree remove --force "${worktreePath}"', ` +
          `(3) 'git branch -D ${branch}'.`,
      };
    }
  }

  // Phase 2: branch delete
  let branchExists = true;
  try {
    execSync(`git rev-parse --verify --quiet ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    branchExists = false;
  }

  if (!branchExists) {
    if (!removedWorktree) {
      return {
        success: false,
        phase: "cleanup",
        message: `Nothing to discard: no worktree or branch found for ${branch}`,
      };
    }
    return {
      success: true,
      phase: "cleanup",
      message: `Discarded ${branch} and cleaned up (branch was already gone)`,
    };
  }

  try {
    execSync(`git branch -D ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    const prefix = removedWorktree ? "Worktree removed. " : "";
    return {
      success: false,
      phase: "branch-delete",
      message:
        `${prefix}Branch delete failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Recovery: 'git branch -D ${branch}'.`,
    };
  }

  return {
    success: true,
    phase: "branch-delete",
    message: `Discarded ${branch} and cleaned up`,
  };
}

export function getWorktreeResults(
  projectRoot: string,
  branch: string,
): string {
  const worktrees = listWorktrees(projectRoot);

  if (worktrees.length === 0) {
    return `No active dangeresque worktrees found. (cwd=${process.cwd()})`;
  }

  const targetWorktree = worktrees.find(
    (wt) => wt.branch === branch || wt.path.includes(branch),
  );
  if (!targetWorktree) {
    return `Worktree not found: ${branch}\nActive worktrees: ${worktrees.map((w) => w.branch).join(", ")}`;
  }

  const lines: string[] = [];
  lines.push(`Worktree: ${targetWorktree.path}`);
  lines.push(`Branch:   ${targetWorktree.branch}`);
  lines.push(`HEAD:     ${targetWorktree.head.slice(0, 8)}`);
  lines.push("");

  const issueNum = extractIssueNumber(targetWorktree.branch);
  if (issueNum) {
    // Read artifacts from the worktree, not the project root — they only land
    // at the project root after `dangeresque merge`.
    const archived = listArchivedRuns(targetWorktree.path, issueNum);
    if (archived.length > 0) {
      if (archived.length > 1) {
        lines.push("--- Previous runs ---");
        for (let i = 0; i < archived.length - 1; i++) {
          const content = readArchivedRun(
            targetWorktree.path,
            issueNum,
            archived[i],
          );
          lines.push(formatRunOneLiner(archived[i], content, i));
        }
        lines.push("");
      }
      const latestName = archived[archived.length - 1];
      const latest = readArchivedRun(targetWorktree.path, issueNum, latestName);
      lines.push(`--- Latest run: ${latestName} ---`);
      lines.push(latest);
    } else {
      lines.push(
        `No run artifacts in ${targetWorktree.path}/.dangeresque/runs/issue-${issueNum}/`,
      );
    }
  } else {
    lines.push("Worktree has no associated issue — no run artifacts tracked.");
  }

  lines.push("");
  const diffBase = resolveDiffBase(projectRoot);
  lines.push(`--- Diff Summary (vs ${diffBase}) ---`);
  try {
    const diff = execSync(`git diff ${diffBase} --stat`, {
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
  showAll: boolean,
): string {
  const archived = listArchivedRuns(projectRoot, issueNumber);
  if (archived.length === 0) {
    return `No runs found for issue #${issueNumber}`;
  }

  const lines: string[] = [];
  lines.push(`Runs for issue #${issueNumber} (${archived.length} total)\n`);

  if (showAll) {
    for (let i = 0; i < archived.length; i++) {
      const content = readArchivedRun(projectRoot, issueNumber, archived[i]);
      lines.push(`=== Run ${i + 1}: ${archived[i]} ===`);
      lines.push(content);
      lines.push("");
    }
  } else {
    for (let i = 0; i < archived.length - 1; i++) {
      const content = readArchivedRun(projectRoot, issueNumber, archived[i]);
      lines.push(formatRunOneLiner(archived[i], content, i));
    }
    if (archived.length > 1) lines.push("");
    const latestName = archived[archived.length - 1];
    const latest = readArchivedRun(projectRoot, issueNumber, latestName);
    lines.push(`--- Latest: Run ${archived.length} (${latestName}) ---`);
    lines.push(latest);
  }

  return lines.join("\n");
}
