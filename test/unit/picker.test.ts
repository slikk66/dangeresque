import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { pickWorktree } from "#dist/picker.js";
import type { WorktreeInfo } from "#dist/worktree.js";

function wt(branch: string, running = false): WorktreeInfo {
  return {
    path: `/tmp/${branch}`,
    branch,
    head: "abc",
    commitEpoch: 0,
    running,
  };
}

test("pickWorktree: non-TTY returns undefined without prompting", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(c));
  const result = await pickWorktree([wt("worktree-dangeresque-foo")], {
    input,
    output,
    isTTY: false,
  });
  assert.equal(result, undefined);
  assert.equal(Buffer.concat(chunks).length, 0);
});

test("pickWorktree: TTY + valid selection returns worktree", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const promise = pickWorktree(
    [
      wt("worktree-dangeresque-investigate-1"),
      wt("worktree-dangeresque-implement-2"),
    ],
    { input, output, isTTY: true },
  );
  setImmediate(() => input.write("2\n"));
  const result = await promise;
  assert.equal(result?.branch, "worktree-dangeresque-implement-2");
});

test("pickWorktree: TTY + out-of-range number returns undefined", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const promise = pickWorktree([wt("worktree-dangeresque-foo")], {
    input,
    output,
    isTTY: true,
  });
  setImmediate(() => input.write("99\n"));
  assert.equal(await promise, undefined);
});

test("pickWorktree: TTY + non-numeric returns undefined", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const promise = pickWorktree([wt("worktree-dangeresque-foo")], {
    input,
    output,
    isTTY: true,
  });
  setImmediate(() => input.write("abc\n"));
  assert.equal(await promise, undefined);
});

test("pickWorktree: empty list returns undefined without prompting", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(c));
  const result = await pickWorktree([], { input, output, isTTY: true });
  assert.equal(result, undefined);
  assert.equal(Buffer.concat(chunks).length, 0);
});
