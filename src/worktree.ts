import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RESULT_FILE } from "./config.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
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
      worktrees.push({ path, branch, head });
    }
  }

  return worktrees;
}

export function mergeWorktree(
  projectRoot: string,
  branch: string
): { success: boolean; message: string } {
  try {
    // Strip RUN_RESULT.md from worktree branch before merging (it's gitignored on main)
    const worktreePathForClean = join(projectRoot, ".claude", "worktrees", branch.replace("worktree-", ""));
    const resultFile = join(worktreePathForClean, RESULT_FILE);
    if (existsSync(resultFile)) {
      try {
        execSync(`git rm -f "${RESULT_FILE}"`, { cwd: worktreePathForClean, encoding: "utf-8", stdio: "pipe" });
        execSync(`git commit -m "remove ${RESULT_FILE} before merge"`, { cwd: worktreePathForClean, encoding: "utf-8", stdio: "pipe" });
      } catch {
        // May not be tracked — fine
      }
    }

    execSync(`git merge ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });

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
  branch: string
): { success: boolean; message: string } {
  try {
    const worktreeName = branch.replace("worktree-", "");
    const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);

    if (existsSync(worktreePath)) {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    }

    try {
      execSync(`git branch -D ${branch}`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      // Branch may not exist
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
    return "No active dangeresque worktrees found.";
  }

  let targetWorktree: WorktreeInfo;

  if (branchOrLatest === "latest") {
    // Latest = last in list (most recently created)
    targetWorktree = worktrees[worktrees.length - 1];
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

  // RUN_RESULT.md
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
