import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { WorktreeInfo } from "./worktree.js";

export interface PickerOptions {
  input?: Readable;
  output?: Writable;
  isTTY?: boolean;
  label?: string;
}

export async function pickWorktree(
  worktrees: WorktreeInfo[],
  opts: PickerOptions = {},
): Promise<WorktreeInfo | undefined> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const isTTY =
    opts.isTTY ?? (input as NodeJS.ReadStream).isTTY === true;

  if (!isTTY || worktrees.length === 0) return undefined;

  output.write(`${opts.label ?? "Select a worktree"}:\n`);
  for (let i = 0; i < worktrees.length; i++) {
    const wt = worktrees[i];
    const short = wt.branch.replace(/^worktree-dangeresque-/, "");
    const state = wt.running ? "RUNNING" : "IDLE";
    output.write(
      `  ${String(i + 1).padStart(2)}. ${short.padEnd(20)} ${state}\n`,
    );
  }

  const rl = createInterface({ input, output, terminal: false });
  try {
    const answer: string = await new Promise((resolve) => {
      rl.question(`Selection [1-${worktrees.length}]: `, resolve);
    });
    const n = parseInt(answer.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > worktrees.length) return undefined;
    return worktrees[n - 1];
  } finally {
    rl.close();
  }
}
