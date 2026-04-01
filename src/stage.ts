import { spawnSync } from "node:child_process";

export function stageComment(
  projectRoot: string,
  issueNumber: number,
  comment: string,
  mode?: string
): { success: boolean; message: string } {
  const modePrefix = mode ? `**[staged ${mode}]** ` : "";
  const body = `${modePrefix}${comment}`;

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
