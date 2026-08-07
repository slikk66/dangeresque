import { spawnSync } from "node:child_process";

export function stageComment(
  projectRoot: string,
  issueNumber: number,
  comment: string,
  mode?: string
): { success: boolean; message: string } {
  const modePrefix = mode ? `**[staged ${mode}]** ` : "";
  return postIssueComment(projectRoot, issueNumber, `${modePrefix}${comment}`);
}

/**
 * Post a comment verbatim to a GitHub issue. The one `gh issue comment` call
 * site — `stageComment` is this plus a `[staged]` prefix.
 */
export function postIssueComment(
  projectRoot: string,
  issueNumber: number,
  body: string,
): { success: boolean; message: string } {
  const result = spawnSync(
    "gh",
    ["issue", "comment", String(issueNumber), "-F", "-"],
    {
      cwd: projectRoot,
      input: body,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  if (result.status === 0) {
    return {
      success: true,
      message: `Posted comment on issue #${issueNumber}`,
    };
  }
  return {
    success: false,
    message: `Failed to post comment: ${result.stderr}`,
  };
}
