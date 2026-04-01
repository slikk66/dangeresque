import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
