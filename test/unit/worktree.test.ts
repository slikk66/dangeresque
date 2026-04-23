import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractIssueNumber,
  extractMode,
  parseSummaryBlock,
  formatRunOneLiner,
  mergeWorktree,
  discardWorktree,
} from "#dist/worktree.js";

test("extractIssueNumber: dangeresque-prefixed branch → number", () => {
  assert.equal(extractIssueNumber("worktree-dangeresque-investigate-63"), 63);
});

test("extractIssueNumber: no trailing number → undefined", () => {
  assert.equal(extractIssueNumber("worktree-foo-bar"), undefined);
});

test("extractMode: dangeresque-prefixed branch", () => {
  assert.equal(extractMode("worktree-dangeresque-investigate-63"), "INVESTIGATE");
});

test("extractMode: legacy worktree-<mode>-<n> branch", () => {
  assert.equal(extractMode("worktree-implement-7"), "IMPLEMENT");
});

test("extractMode: unparseable branch → UNKNOWN", () => {
  assert.equal(extractMode("random-branch"), "UNKNOWN");
});

test("parseSummaryBlock: valid block extracted", () => {
  const content = [
    "<!-- SUMMARY -->",
    "Mode: IMPLEMENT | Status: verified",
    "Files: 2 changed (a.ts, b.ts)",
    "<!-- /SUMMARY -->",
    "",
    "body body body",
  ].join("\n");
  assert.equal(
    parseSummaryBlock(content),
    "Mode: IMPLEMENT | Status: verified\nFiles: 2 changed (a.ts, b.ts)",
  );
});

test("parseSummaryBlock: missing block → null", () => {
  assert.equal(parseSummaryBlock("just a plain run result"), null);
});

test("formatRunOneLiner: with SUMMARY block shows status + files", () => {
  const content = [
    "<!-- SUMMARY -->",
    "Mode: IMPLEMENT | Status: verified",
    "Files: 1 changed (foo.ts)",
    "<!-- /SUMMARY -->",
  ].join("\n");
  const oneLiner = formatRunOneLiner("2026-01-01T00-00-00-IMPLEMENT.md", content, 0);
  assert.match(oneLiner, /^Run 1 \(IMPLEMENT\):/);
  assert.match(oneLiner, /verified/);
  assert.match(oneLiner, /1 changed \(foo\.ts\)/);
});

test("formatRunOneLiner: no SUMMARY block falls back to filename", () => {
  const oneLiner = formatRunOneLiner(
    "2026-01-01T00-00-00-TEST.md",
    "# raw body, no summary",
    2,
  );
  assert.match(oneLiner, /^Run 3 \(TEST\):/);
  assert.match(oneLiner, /2026-01-01T00-00-00-TEST\.md/);
});

// --- mergeWorktree / discardWorktree phased-error coverage ---

type ExecEnv = { cwd: string; encoding: "utf-8"; stdio: "pipe" };

function env(dir: string): ExecEnv {
  return { cwd: dir, encoding: "utf-8", stdio: "pipe" };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-wt-test-"));
  execSync("git init -b main", env(dir));
  execSync("git config user.email test@dangeresque.local", env(dir));
  execSync("git config user.name test", env(dir));
  execSync("git config commit.gpgsign false", env(dir));
  execSync('git commit --allow-empty -m "initial"', env(dir));
  return dir;
}

function addWorktree(
  repo: string,
  name: string,
  branch: string,
  opts: { advance?: boolean } = { advance: true },
): string {
  const worktreePath = join(repo, ".claude", "worktrees", name);
  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
  execSync(`git worktree add -b ${branch} "${worktreePath}"`, env(repo));
  if (opts.advance !== false) {
    writeFileSync(join(worktreePath, `${name}.txt`), `content-${name}\n`);
    execSync(`git add ${name}.txt`, env(worktreePath));
    execSync('git commit -m "worktree commit"', env(worktreePath));
  }
  return worktreePath;
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify --quiet refs/heads/${branch}`, env(repo));
    return true;
  } catch {
    return false;
  }
}

test("mergeWorktree: clean fast-forward → success, phase=merge, headAdvanced=true", () => {
  const dir = makeRepo();
  try {
    addWorktree(dir, "alpha", "worktree-alpha");
    const result = mergeWorktree(dir, "worktree-alpha");

    assert.equal(result.success, true);
    assert.equal(result.phase, "merge");
    assert.equal(result.headAdvanced, true);
    assert.ok(result.headBefore);
    assert.ok(result.headAfter);
    assert.notEqual(result.headBefore, result.headAfter);
    assert.match(result.message, /worktree-alpha/);
    assert.match(result.message, new RegExp(result.headBefore!.slice(0, 7)));
    assert.match(result.message, new RegExp(result.headAfter!.slice(0, 7)));
    assert.equal(existsSync(join(dir, ".claude", "worktrees", "alpha")), false);
    assert.equal(branchExists(dir, "worktree-alpha"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: no-op merge → phase=noop, headAdvanced=false, worktree preserved", () => {
  const dir = makeRepo();
  try {
    addWorktree(dir, "bravo", "worktree-bravo", { advance: false });
    const result = mergeWorktree(dir, "worktree-bravo");

    assert.equal(result.success, false);
    assert.equal(result.phase, "noop");
    assert.equal(result.headAdvanced, false);
    assert.equal(result.headBefore, result.headAfter);
    assert.match(result.message, /no effect|up to date/i);
    assert.equal(existsSync(join(dir, ".claude", "worktrees", "bravo")), true);
    assert.equal(branchExists(dir, "worktree-bravo"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: merge conflict → phase=merge, headAdvanced=false, main unchanged", () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(dir, "charlie", "worktree-charlie", { advance: false });
    writeFileSync(join(worktreePath, "conflict.txt"), "wt-version\n");
    execSync("git add conflict.txt", env(worktreePath));
    execSync('git commit -m "wt diverge"', env(worktreePath));

    writeFileSync(join(dir, "conflict.txt"), "main-version\n");
    execSync("git add conflict.txt", env(dir));
    execSync('git commit -m "main diverge"', env(dir));

    const headBeforeCall = execSync("git rev-parse HEAD", env(dir)).toString().trim();

    const result = mergeWorktree(dir, "worktree-charlie");
    assert.equal(result.success, false);
    assert.equal(result.phase, "merge");
    assert.equal(result.headAdvanced, false);
    assert.match(result.message, /did not occur|main is unchanged/i);

    const headAfterCall = execSync("git rev-parse HEAD", env(dir)).toString().trim();
    assert.equal(headAfterCall, headBeforeCall);
    assert.equal(existsSync(worktreePath), true);
  } finally {
    try { execSync("git merge --abort", env(dir)); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: cleanup fails (untracked file) → phase=cleanup, headAdvanced=true, recovery in message", () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(dir, "delta", "worktree-delta");
    writeFileSync(join(worktreePath, "untracked.log"), "stray log\n");

    const result = mergeWorktree(dir, "worktree-delta");
    assert.equal(result.success, false);
    assert.equal(result.phase, "cleanup");
    assert.equal(result.headAdvanced, true);
    assert.ok(result.headAfter);
    assert.match(result.message, /Merge succeeded/);
    assert.match(result.message, new RegExp(result.headAfter!.slice(0, 7)));
    assert.match(result.message, /Worktree cleanup failed/i);
    assert.match(result.message, /git worktree remove --force/);
    assert.match(result.message, /worktree-delta/);

    const headAfterCall = execSync("git rev-parse HEAD", env(dir)).toString().trim();
    assert.equal(headAfterCall, result.headAfter);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: stale upstream tracking → -D succeeds (the #44 fix)", () => {
  const dir = makeRepo();
  try {
    execSync("git branch side-branch", env(dir));
    writeFileSync(join(dir, "side.txt"), "side\n");
    execSync("git add side.txt", env(dir));
    execSync('git commit -m "side divergence"', env(dir));
    execSync("git update-ref refs/heads/side-branch HEAD", env(dir));
    execSync("git reset --hard HEAD~1", env(dir));

    const worktreePath = addWorktree(dir, "echo", "worktree-echo");

    execSync("git config branch.worktree-echo.remote .", env(dir));
    execSync("git config branch.worktree-echo.merge refs/heads/side-branch", env(dir));

    const result = mergeWorktree(dir, "worktree-echo");
    assert.equal(result.success, true);
    assert.equal(result.phase, "merge");
    assert.equal(result.headAdvanced, true);
    assert.ok(result.headBefore);
    assert.ok(result.headAfter);
    assert.notEqual(result.headBefore, result.headAfter);
    assert.match(result.message, /Merged worktree-echo into main/);
    assert.match(result.message, new RegExp(result.headBefore!.slice(0, 7)));
    assert.match(result.message, new RegExp(result.headAfter!.slice(0, 7)));

    assert.equal(existsSync(worktreePath), false);
    assert.equal(branchExists(dir, "worktree-echo"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: branch checked out elsewhere → phase=branch-delete, headAdvanced=true", () => {
  const dir = makeRepo();
  const externalHolder = mkdtempSync(join(tmpdir(), "dangeresque-external-"));
  const externalWtPath = join(externalHolder, "external-wt");
  try {
    // Create worktree-kilo only in an external worktree (not at
    // .claude/worktrees/kilo). mergeWorktree's Phase 2 existsSync check
    // then skips cleanup, and Phase 3's `git branch -D` hits the real
    // post-fix failure mode: branch checked out in another worktree.
    execSync(`git worktree add -b worktree-kilo "${externalWtPath}"`, env(dir));
    writeFileSync(join(externalWtPath, "kilo.txt"), "kilo\n");
    execSync("git add kilo.txt", env(externalWtPath));
    execSync('git commit -m "kilo diverge"', env(externalWtPath));

    const result = mergeWorktree(dir, "worktree-kilo");
    assert.equal(result.success, false);
    assert.equal(result.phase, "branch-delete");
    assert.equal(result.headAdvanced, true);
    assert.ok(result.headBefore);
    assert.ok(result.headAfter);
    assert.match(result.message, /Merge succeeded and worktree removed/);
    assert.match(result.message, new RegExp(result.headAfter!.slice(0, 7)));
    assert.match(result.message, /Branch delete failed/i);
    assert.match(result.message, /worktree-kilo/);
    assert.match(result.message, /git worktree list/);

    assert.equal(branchExists(dir, "worktree-kilo"), true);
  } finally {
    try { execSync(`git worktree remove --force "${externalWtPath}"`, env(dir)); } catch { /* ignore */ }
    rmSync(externalHolder, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardWorktree: clean success → success, phase=branch-delete", () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(dir, "foxtrot", "worktree-foxtrot");
    const result = discardWorktree(dir, "worktree-foxtrot");

    assert.equal(result.success, true);
    assert.equal(result.phase, "branch-delete");
    assert.match(result.message, /Discarded worktree-foxtrot/);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(branchExists(dir, "worktree-foxtrot"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardWorktree: worktree-remove fails (path is not a git worktree) → phase=cleanup", () => {
  const dir = makeRepo();
  try {
    execSync("git branch worktree-golf", env(dir));
    const fakePath = join(dir, ".claude", "worktrees", "golf");
    mkdirSync(fakePath, { recursive: true });
    writeFileSync(join(fakePath, "not-a-worktree.txt"), "decoy\n");

    const result = discardWorktree(dir, "worktree-golf");
    assert.equal(result.success, false);
    assert.equal(result.phase, "cleanup");
    assert.match(result.message, /Worktree cleanup failed/i);
    assert.match(result.message, /git worktree remove --force/);
    assert.equal(branchExists(dir, "worktree-golf"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardWorktree: branch-delete fails when branch is checked out elsewhere → phase=branch-delete (no silent swallow)", () => {
  const dir = makeRepo();
  const externalHolder = mkdtempSync(join(tmpdir(), "dangeresque-external-"));
  const externalWtPath = join(externalHolder, "external-wt");
  try {
    execSync(`git worktree add -b worktree-hotel "${externalWtPath}"`, env(dir));

    const result = discardWorktree(dir, "worktree-hotel");
    assert.equal(result.success, false);
    assert.equal(result.phase, "branch-delete");
    assert.match(result.message, /Branch delete failed/i);
    assert.match(result.message, /worktree-hotel/);
    assert.equal(branchExists(dir, "worktree-hotel"), true);
  } finally {
    try { execSync(`git worktree remove --force "${externalWtPath}"`, env(dir)); } catch { /* ignore */ }
    rmSync(externalHolder, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardWorktree: nothing to discard (no worktree, no branch) → existing not-found message preserved", () => {
  const dir = makeRepo();
  try {
    const result = discardWorktree(dir, "worktree-india");
    assert.equal(result.success, false);
    assert.match(result.message, /Nothing to discard/i);
    assert.match(result.message, /worktree-india/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
