import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractIssueNumber,
  extractMode,
  parseSummaryBlock,
  formatRunOneLiner,
  formatRunHeader,
  getWorktreeResults,
  mergeWorktree,
  discardWorktree,
  filterWorktrees,
  isPidAlive,
  mirrorIssueRuns,
  mirrorAllIssueRuns,
  stopWorktree,
  runPreflightChecks,
  type WorktreeInfo,
} from "#dist/worktree.js";

test("extractIssueNumber: dangeresque-prefixed branch → number", () => {
  assert.equal(extractIssueNumber("worktree-dangeresque-investigate-63"), 63);
});

test("extractIssueNumber: no trailing number → undefined", () => {
  assert.equal(extractIssueNumber("worktree-foo-bar"), undefined);
});

test("extractIssueNumber: descriptive slug after number → number (bc#546)", () => {
  // The merge artifact-mirror bug: a slug suffix used to return undefined,
  // silently skipping the mirror while reporting success.
  assert.equal(
    extractIssueNumber("worktree-dangeresque-investigate-537-dicecursor"),
    537,
  );
  assert.equal(
    extractIssueNumber("worktree-dangeresque-implement-534-slice1"),
    534,
  );
  assert.equal(
    extractIssueNumber("worktree-dangeresque-implement-537-p1-fix"),
    537,
  );
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

// --- filterWorktrees ---

function mkWt(branch: string, running: boolean): WorktreeInfo {
  return { path: `/tmp/${branch}`, branch, head: "abc", commitEpoch: 0, running };
}

test("filterWorktrees: all returns full list", () => {
  const list = [mkWt("a", true), mkWt("b", false), mkWt("c", true)];
  assert.deepEqual(filterWorktrees(list, "all"), list);
});

test("filterWorktrees: running returns only running entries", () => {
  const list = [mkWt("a", true), mkWt("b", false), mkWt("c", true)];
  const got = filterWorktrees(list, "running");
  assert.deepEqual(got.map((w) => w.branch), ["a", "c"]);
});

test("filterWorktrees: finished returns only non-running entries", () => {
  const list = [mkWt("a", true), mkWt("b", false), mkWt("c", true)];
  const got = filterWorktrees(list, "finished");
  assert.deepEqual(got.map((w) => w.branch), ["b"]);
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

test("mergeWorktree: no-op merge (no commits, no artifacts) → success, phase=noop, worktree torn down", () => {
  const dir = makeRepo();
  try {
    addWorktree(dir, "bravo", "worktree-bravo", { advance: false });
    const result = mergeWorktree(dir, "worktree-bravo");

    assert.equal(result.success, true);
    assert.equal(result.phase, "noop");
    assert.equal(result.headAdvanced, false);
    assert.equal(result.headBefore, result.headAfter);
    assert.match(result.message, /no code changes/i);
    assert.equal(existsSync(join(dir, ".claude", "worktrees", "bravo")), false);
    assert.equal(branchExists(dir, "worktree-bravo"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: no-op merge with gitignored runs/ artifact → mirrors to projectRoot", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, ".gitignore"), ".dangeresque/runs/\n");
    execSync("git add .gitignore", env(dir));
    execSync('git commit -m "ignore runs"', env(dir));

    const worktreePath = addWorktree(dir, "dangeresque-investigate-99", "worktree-dangeresque-investigate-99", { advance: false });
    const wtRunsDir = join(worktreePath, ".dangeresque", "runs", "issue-99");
    mkdirSync(wtRunsDir, { recursive: true });
    writeFileSync(join(wtRunsDir, "2026-05-01T00-00-00-INVESTIGATE.md"), "# investigate body\n");
    writeFileSync(join(wtRunsDir, "2026-05-01T00-00-00-INVESTIGATE.json"), '{"mode":"INVESTIGATE"}\n');

    const result = mergeWorktree(dir, "worktree-dangeresque-investigate-99");

    assert.equal(result.success, true);
    assert.equal(result.phase, "noop");
    assert.equal(result.headAdvanced, false);
    assert.equal(existsSync(join(dir, ".claude", "worktrees", "dangeresque-investigate-99")), false);
    assert.equal(branchExists(dir, "worktree-dangeresque-investigate-99"), false);

    const mirroredMd = join(dir, ".dangeresque", "runs", "issue-99", "2026-05-01T00-00-00-INVESTIGATE.md");
    const mirroredJson = join(dir, ".dangeresque", "runs", "issue-99", "2026-05-01T00-00-00-INVESTIGATE.json");
    assert.equal(existsSync(mirroredMd), true);
    assert.equal(existsSync(mirroredJson), true);
    assert.match(readFileSync(mirroredMd, "utf-8"), /investigate body/);
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
    assert.match(result.message, /Merge succeeded.*worktree removed/);
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

// --- mirrorIssueRuns / mergeWorktree copy-out coverage ---

test("mirrorIssueRuns: src missing → no-op, no error", () => {
  const src = mkdtempSync(join(tmpdir(), "dangeresque-mirror-src-"));
  const dest = mkdtempSync(join(tmpdir(), "dangeresque-mirror-dest-"));
  try {
    mirrorIssueRuns(src, dest, 99);
    assert.equal(
      existsSync(join(dest, ".dangeresque", "runs", "issue-99")),
      false,
      "dest should remain empty when src has no runs",
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("mirrorIssueRuns: copies all files from src/issue-N/ to dest/issue-N/, creating dest dirs", () => {
  const src = mkdtempSync(join(tmpdir(), "dangeresque-mirror-src-"));
  const dest = mkdtempSync(join(tmpdir(), "dangeresque-mirror-dest-"));
  try {
    const srcIssue = join(src, ".dangeresque", "runs", "issue-7");
    mkdirSync(srcIssue, { recursive: true });
    writeFileSync(join(srcIssue, "2026-01-01T00-00-00-INVESTIGATE.md"), "investigate body\n");
    writeFileSync(join(srcIssue, "2026-01-01T00-00-00-INVESTIGATE.json"), "{}\n");
    writeFileSync(join(srcIssue, "2026-01-02T00-00-00-IMPLEMENT.md"), "implement body\n");

    mirrorIssueRuns(src, dest, 7);

    const destIssue = join(dest, ".dangeresque", "runs", "issue-7");
    assert.ok(existsSync(destIssue), "dest issue dir created");
    assert.equal(
      readFileSync(join(destIssue, "2026-01-01T00-00-00-INVESTIGATE.md"), "utf-8"),
      "investigate body\n",
    );
    assert.equal(
      readFileSync(join(destIssue, "2026-01-01T00-00-00-INVESTIGATE.json"), "utf-8"),
      "{}\n",
    );
    assert.equal(
      readFileSync(join(destIssue, "2026-01-02T00-00-00-IMPLEMENT.md"), "utf-8"),
      "implement body\n",
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("mirrorIssueRuns: copies only the requested issue's directory", () => {
  const src = mkdtempSync(join(tmpdir(), "dangeresque-mirror-src-"));
  const dest = mkdtempSync(join(tmpdir(), "dangeresque-mirror-dest-"));
  try {
    mkdirSync(join(src, ".dangeresque", "runs", "issue-7"), { recursive: true });
    writeFileSync(join(src, ".dangeresque", "runs", "issue-7", "a.md"), "7\n");
    mkdirSync(join(src, ".dangeresque", "runs", "issue-8"), { recursive: true });
    writeFileSync(join(src, ".dangeresque", "runs", "issue-8", "b.md"), "8\n");

    mirrorIssueRuns(src, dest, 7);

    assert.ok(existsSync(join(dest, ".dangeresque", "runs", "issue-7", "a.md")));
    assert.equal(
      existsSync(join(dest, ".dangeresque", "runs", "issue-8")),
      false,
      "issue-8 should not be touched",
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("mergeWorktree: copies gitignored runs/issue-N/ from worktree to project root", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, ".gitignore"), ".dangeresque/runs/\n");
    execSync("git add .gitignore", env(dir));
    execSync('git commit -m "gitignore runs"', env(dir));

    const worktreePath = addWorktree(
      dir,
      "dangeresque-implement-42",
      "worktree-dangeresque-implement-42",
    );

    // Worker writes an artifact in the worktree; gitignored, never committed.
    const wtArtifactDir = join(worktreePath, ".dangeresque", "runs", "issue-42");
    mkdirSync(wtArtifactDir, { recursive: true });
    writeFileSync(
      join(wtArtifactDir, "2026-01-01T00-00-00-IMPLEMENT.md"),
      "<!-- SUMMARY -->\nMode: IMPLEMENT | Status: implemented, unverified\n<!-- /SUMMARY -->\n",
    );
    writeFileSync(
      join(wtArtifactDir, "2026-01-01T00-00-00-IMPLEMENT.json"),
      '{"schema_version":"3"}\n',
    );

    const result = mergeWorktree(dir, "worktree-dangeresque-implement-42");
    assert.equal(result.success, true);
    assert.equal(result.phase, "merge");
    assert.equal(result.headAdvanced, true);

    // Worktree is gone …
    assert.equal(existsSync(worktreePath), false);
    // … but the artifact files are now at the project root.
    const projectIssueDir = join(dir, ".dangeresque", "runs", "issue-42");
    assert.ok(existsSync(projectIssueDir), "issue dir mirrored to project root");
    assert.match(
      readFileSync(
        join(projectIssueDir, "2026-01-01T00-00-00-IMPLEMENT.md"),
        "utf-8",
      ),
      /Mode: IMPLEMENT/,
    );
    assert.match(
      readFileSync(
        join(projectIssueDir, "2026-01-01T00-00-00-IMPLEMENT.json"),
        "utf-8",
      ),
      /schema_version/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: branch with no run artifacts → merge succeeds, no false mirror claim", () => {
  const dir = makeRepo();
  try {
    addWorktree(dir, "no-issue", "worktree-no-issue");
    const result = mergeWorktree(dir, "worktree-no-issue");
    assert.equal(result.success, true);
    assert.equal(
      existsSync(join(dir, ".dangeresque", "runs")),
      false,
      "no runs/ dir should be created when there are no artifacts",
    );
    // The success line must not claim a mirror that didn't happen.
    assert.doesNotMatch(result.message, /Mirrored run artifacts/);
    assert.match(result.message, /No run artifacts to mirror/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: slug-suffixed branch with gitignored artifact → still mirrors (bc#546 regression)", () => {
  // The exact shape that broke: branch ends in `-dicecursor`, not `-537`.
  // Old extractIssueNumber returned undefined → mirror skipped → artifacts lost
  // while merge reported success.
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, ".gitignore"), ".dangeresque/runs/\n");
    execSync("git add .gitignore", env(dir));
    execSync('git commit -m "gitignore runs"', env(dir));

    const worktreePath = addWorktree(
      dir,
      "dangeresque-investigate-537-dicecursor",
      "worktree-dangeresque-investigate-537-dicecursor",
      { advance: false },
    );
    const wtArtifactDir = join(worktreePath, ".dangeresque", "runs", "issue-537");
    mkdirSync(wtArtifactDir, { recursive: true });
    writeFileSync(
      join(wtArtifactDir, "2026-06-19T23-04-14-IMPLEMENT.md"),
      "<!-- SUMMARY -->\nMode: IMPLEMENT | Status: implemented\n<!-- /SUMMARY -->\n",
    );
    writeFileSync(
      join(wtArtifactDir, "2026-06-19T23-04-14-IMPLEMENT.json"),
      '{"schema_version":"3"}\n',
    );

    const result = mergeWorktree(
      dir,
      "worktree-dangeresque-investigate-537-dicecursor",
    );
    assert.equal(result.success, true);
    assert.equal(existsSync(worktreePath), false);

    // BOTH the .md and the .json eval sidecar must land at the project root.
    const projectIssueDir = join(dir, ".dangeresque", "runs", "issue-537");
    assert.ok(
      existsSync(join(projectIssueDir, "2026-06-19T23-04-14-IMPLEMENT.md")),
      ".md mirrored despite slug-suffixed branch",
    );
    assert.ok(
      existsSync(join(projectIssueDir, "2026-06-19T23-04-14-IMPLEMENT.json")),
      ".json eval sidecar mirrored despite slug-suffixed branch",
    );
    // And the success line names what it actually mirrored.
    assert.match(result.message, /Mirrored run artifacts \(issue-537\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- mirrorAllIssueRuns: name-independent copy of every issue-* dir ---

test("mirrorAllIssueRuns: src runs dir missing → [] , no error", () => {
  const src = mkdtempSync(join(tmpdir(), "dangeresque-mirror-all-src-"));
  const dest = mkdtempSync(join(tmpdir(), "dangeresque-mirror-all-dest-"));
  try {
    assert.deepEqual(mirrorAllIssueRuns(src, dest), []);
    assert.equal(existsSync(join(dest, ".dangeresque", "runs")), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("mirrorAllIssueRuns: copies every issue-* dir, returns their names", () => {
  const src = mkdtempSync(join(tmpdir(), "dangeresque-mirror-all-src-"));
  const dest = mkdtempSync(join(tmpdir(), "dangeresque-mirror-all-dest-"));
  try {
    const runs = join(src, ".dangeresque", "runs");
    mkdirSync(join(runs, "issue-7"), { recursive: true });
    writeFileSync(join(runs, "issue-7", "a.md"), "7\n");
    mkdirSync(join(runs, "issue-8"), { recursive: true });
    writeFileSync(join(runs, "issue-8", "b.json"), "{}\n");
    // A stray non-issue dir must be ignored.
    mkdirSync(join(runs, "scratch"), { recursive: true });

    const copied = mirrorAllIssueRuns(src, dest).sort();
    assert.deepEqual(copied, ["issue-7", "issue-8"]);

    const destRuns = join(dest, ".dangeresque", "runs");
    assert.ok(existsSync(join(destRuns, "issue-7", "a.md")));
    assert.ok(existsSync(join(destRuns, "issue-8", "b.json")));
    assert.equal(existsSync(join(destRuns, "scratch")), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("discardWorktree: clean success → success, phase=branch-delete", async () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(dir, "foxtrot", "worktree-foxtrot");
    const result = await discardWorktree(dir, "worktree-foxtrot");

    assert.equal(result.success, true);
    assert.equal(result.phase, "branch-delete");
    assert.match(result.message, /Discarded worktree-foxtrot/);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(branchExists(dir, "worktree-foxtrot"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardWorktree: worktree-remove fails (path is not a git worktree) → phase=cleanup", async () => {
  const dir = makeRepo();
  try {
    execSync("git branch worktree-golf", env(dir));
    const fakePath = join(dir, ".claude", "worktrees", "golf");
    mkdirSync(fakePath, { recursive: true });
    writeFileSync(join(fakePath, "not-a-worktree.txt"), "decoy\n");

    const result = await discardWorktree(dir, "worktree-golf");
    assert.equal(result.success, false);
    assert.equal(result.phase, "cleanup");
    assert.match(result.message, /Worktree cleanup failed/i);
    assert.match(result.message, /git worktree remove --force/);
    assert.equal(branchExists(dir, "worktree-golf"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardWorktree: branch-delete fails when branch is checked out elsewhere → phase=branch-delete (no silent swallow)", async () => {
  const dir = makeRepo();
  const externalHolder = mkdtempSync(join(tmpdir(), "dangeresque-external-"));
  const externalWtPath = join(externalHolder, "external-wt");
  try {
    execSync(`git worktree add -b worktree-hotel "${externalWtPath}"`, env(dir));

    const result = await discardWorktree(dir, "worktree-hotel");
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

test("discardWorktree: nothing to discard (no worktree, no branch) → existing not-found message preserved", async () => {
  const dir = makeRepo();
  try {
    const result = await discardWorktree(dir, "worktree-india");
    assert.equal(result.success, false);
    assert.match(result.message, /Nothing to discard/i);
    assert.match(result.message, /worktree-india/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- formatRunHeader ---

function writeJsonArtifact(
  path: string,
  overrides: Record<string, unknown> = {},
): void {
  const base = {
    schema_version: "2",
    summary: "IMPLEMENT success | verdict=accept | file=run.md",
    reviewer_verdict: "accept",
    scope_report: { in_scope: [], extended: [], outside: [] },
    failure_categories: [] as string[],
  };
  writeFileSync(path, JSON.stringify({ ...base, ...overrides }));
}

test("formatRunHeader: returns null when JSON file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-header-"));
  try {
    assert.equal(formatRunHeader(join(dir, "nope.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatRunHeader: returns null when JSON is unparseable", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-header-"));
  try {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    assert.equal(formatRunHeader(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatRunHeader: renders summary, verdict, and zero-counts for empty scope_report", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-header-"));
  try {
    const p = join(dir, "ok.json");
    writeJsonArtifact(p);
    const header = formatRunHeader(p);
    assert.ok(header);
    assert.match(header!, /^=== IMPLEMENT success \| verdict=accept \| file=run\.md ===$/m);
    assert.match(header!, /^Verdict: accept$/m);
    assert.match(header!, /^Scope: in=0 extended=0 outside=0$/m);
    assert.match(header!, /^Failure categories: none$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatRunHeader: surfaces scope counts when populated", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-header-"));
  try {
    const p = join(dir, "scoped.json");
    writeJsonArtifact(p, {
      scope_report: {
        in_scope: ["src/a.ts", "src/b.ts"],
        extended: [
          { path: "tools/helper.ts", category: "extension", rationale: "needed" },
        ],
        outside: ["src/off-scope.ts", "README.md"],
      },
    });
    const header = formatRunHeader(p);
    assert.ok(header);
    assert.match(header!, /Scope: in=2 extended=1 outside=2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatRunHeader: surfaces failure categories when populated", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-header-"));
  try {
    const p = join(dir, "failed.json");
    writeJsonArtifact(p, {
      reviewer_verdict: "reject",
      failure_categories: ["reviewer_rejected", "scope_outside"],
    });
    const header = formatRunHeader(p);
    assert.ok(header);
    assert.match(header!, /Verdict: reject/);
    assert.match(header!, /Failure categories: reviewer_rejected, scope_outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatRunHeader: returns null when required fields are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-header-"));
  try {
    const p = join(dir, "partial.json");
    writeFileSync(p, JSON.stringify({ schema_version: "2" }));
    assert.equal(formatRunHeader(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- getWorktreeResults ---

function writeRunArtifacts(
  worktreePath: string,
  issueNumber: number,
  stamp: string,
  mode: string,
  opts: { jsonOverrides?: Record<string, unknown>; skipJson?: boolean } = {},
): { mdPath: string; jsonPath: string } {
  const issueDir = join(
    worktreePath,
    ".dangeresque",
    "runs",
    `issue-${issueNumber}`,
  );
  mkdirSync(issueDir, { recursive: true });
  const base = `${stamp}-${mode}`;
  const mdPath = join(issueDir, `${base}.md`);
  const jsonPath = join(issueDir, `${base}.json`);
  writeFileSync(
    mdPath,
    [
      "<!-- SUMMARY -->",
      `Mode: ${mode} | Status: verified`,
      "Files: 1 changed (foo.ts)",
      "<!-- /SUMMARY -->",
      "",
      "body",
    ].join("\n"),
  );
  if (!opts.skipJson) {
    const baseJson = {
      schema_version: "2",
      summary: `${mode} success | verdict=accept | file=${base}.md`,
      reviewer_verdict: "accept",
      scope_report: { in_scope: [], extended: [], outside: [] },
      failure_categories: [] as string[],
    };
    writeFileSync(
      jsonPath,
      JSON.stringify({ ...baseJson, ...(opts.jsonOverrides ?? {}) }),
    );
  }
  return { mdPath, jsonPath };
}

test("getWorktreeResults: structured header precedes diff summary when JSON present", () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(
      dir,
      "dangeresque-implement-777",
      "worktree-dangeresque-implement-777",
    );
    writeRunArtifacts(
      worktreePath,
      777,
      "2026-04-24T00-00-00",
      "IMPLEMENT",
    );

    const out = getWorktreeResults(dir, "worktree-dangeresque-implement-777");
    const headerIdx = out.indexOf("=== IMPLEMENT success | verdict=accept");
    const diffIdx = out.indexOf("--- Diff Summary");
    const latestIdx = out.indexOf("--- Latest run:");

    assert.notEqual(headerIdx, -1, "structured header missing");
    assert.notEqual(diffIdx, -1, "diff summary missing");
    assert.notEqual(latestIdx, -1, "latest run block missing");
    assert.ok(headerIdx < diffIdx, "header must appear before diff summary");
    assert.ok(diffIdx < latestIdx, "diff summary must appear before latest run");
    assert.match(out, /Verdict: accept/);
    assert.match(out, /Scope: in=0 extended=0 outside=0/);
    assert.match(out, /Failure categories: none/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getWorktreeResults: header omitted when JSON artifact missing", () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(
      dir,
      "dangeresque-implement-778",
      "worktree-dangeresque-implement-778",
    );
    writeRunArtifacts(
      worktreePath,
      778,
      "2026-04-24T00-00-00",
      "IMPLEMENT",
      { skipJson: true },
    );

    const out = getWorktreeResults(dir, "worktree-dangeresque-implement-778");
    assert.equal(out.includes("Verdict:"), false);
    assert.equal(out.includes("==="), false);
    assert.match(out, /--- Diff Summary/);
    assert.match(out, /--- Latest run:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getWorktreeResults: header surfaces scope_report counts when populated", () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(
      dir,
      "dangeresque-implement-779",
      "worktree-dangeresque-implement-779",
    );
    writeRunArtifacts(
      worktreePath,
      779,
      "2026-04-24T00-00-00",
      "IMPLEMENT",
      {
        jsonOverrides: {
          scope_report: {
            in_scope: [],
            extended: [],
            outside: ["src/unrelated.ts"],
          },
          failure_categories: ["scope_outside"],
        },
      },
    );

    const out = getWorktreeResults(dir, "worktree-dangeresque-implement-779");
    assert.match(out, /Scope: in=0 extended=0 outside=1/);
    assert.match(out, /Failure categories: scope_outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- PID gates: discardWorktree / mergeWorktree / stopWorktree ---

const PID_FILE = ".dangeresque.pid";

function writePidFileFor(
  worktreePath: string,
  info: { pid: number; cliPid?: number; startedAt?: number; engine?: "claude" | "codex" },
): void {
  writeFileSync(
    join(worktreePath, PID_FILE),
    JSON.stringify({
      startedAt: Date.now(),
      engine: "claude",
      ...info,
    }),
  );
}

function spawnLongRunningChild(): ChildProcess {
  return spawn("node", ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: false,
  });
}

async function awaitDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidAlive(pid);
}

test("isPidAlive: process.pid is alive; obviously dead PID 1 (pid 0) is not", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(undefined), false);
});

test("discardWorktree: refuses with gateRefusal when PID is alive", async () => {
  const dir = makeRepo();
  try {
    // Path must match what discardWorktree derives from the branch — it
    // strips "worktree-" off the branch to compute the path.
    const worktreePath = addWorktree(
      dir,
      "dangeresque-investigate-901",
      "worktree-dangeresque-investigate-901",
    );
    // Use process.pid — guaranteed alive while the test runs.
    writePidFileFor(worktreePath, {
      pid: process.pid,
      cliPid: process.pid,
      startedAt: Date.now() - 263_000,
    });

    const result = await discardWorktree(dir, "worktree-dangeresque-investigate-901");
    assert.equal(result.success, false);
    assert.equal(result.gateRefusal, true);
    assert.equal(result.phase, "gate");
    assert.match(result.message, /refusing to discard/);
    assert.match(result.message, /still running/);
    assert.match(result.message, new RegExp(String(process.pid)));
    assert.match(result.message, /dangeresque stop/);
    assert.match(result.message, /--force/);
    // Worktree must still exist — gate refused before destructive ops.
    assert.equal(existsSync(worktreePath), true);
    assert.equal(branchExists(dir, "worktree-dangeresque-investigate-901"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardWorktree: passes through when PID is stale", async () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(dir, "stale-discard", "worktree-stale-discard");
    // Spawn-and-await: capture a PID, wait for it to die, then write that
    // dead PID into the file. process.kill(deadPid, 0) will throw ESRCH.
    const corpse = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((r) => corpse.once("exit", () => r()));
    writePidFileFor(worktreePath, {
      pid: corpse.pid!,
      cliPid: corpse.pid!,
    });

    const result = await discardWorktree(dir, "worktree-stale-discard");
    assert.equal(result.success, true);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(branchExists(dir, "worktree-stale-discard"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discardWorktree: --force kills running worker then discards", async () => {
  const dir = makeRepo();
  let child: ChildProcess | undefined;
  try {
    const worktreePath = addWorktree(dir, "force-discard", "worktree-force-discard");
    child = spawnLongRunningChild();
    writePidFileFor(worktreePath, {
      pid: child.pid!,
      cliPid: child.pid!,
    });
    assert.equal(isPidAlive(child.pid!), true);

    const result = await discardWorktree(dir, "worktree-force-discard", { force: true });
    assert.equal(result.success, true, `expected success, got: ${result.message}`);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(branchExists(dir, "worktree-force-discard"), false);
    assert.equal(await awaitDead(child.pid!), true, "child should be killed by --force discard");
  } finally {
    if (child?.pid && isPidAlive(child.pid)) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeWorktree: refuses with gateRefusal when PID is alive", () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(dir, "live-merge", "worktree-live-merge");
    writePidFileFor(worktreePath, {
      pid: process.pid,
      cliPid: process.pid,
      startedAt: Date.now() - 60_000,
    });

    const result = mergeWorktree(dir, "worktree-live-merge");
    assert.equal(result.success, false);
    assert.equal(result.gateRefusal, true);
    assert.equal(result.phase, "gate");
    assert.match(result.message, /refusing to merge/);
    assert.match(result.message, /still running/);
    assert.match(result.message, /dangeresque stop/);
    // Worktree must still exist — gate refused before merge.
    assert.equal(existsSync(worktreePath), true);
    assert.equal(branchExists(dir, "worktree-live-merge"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopWorktree: kills tracked engine + parent PIDs and clears PID file", async () => {
  const dir = makeRepo();
  let child: ChildProcess | undefined;
  try {
    const worktreePath = addWorktree(dir, "stop-1", "worktree-stop-1");
    child = spawnLongRunningChild();
    writePidFileFor(worktreePath, {
      pid: child.pid!,
      cliPid: child.pid!,
    });
    assert.equal(isPidAlive(child.pid!), true);

    const result = await stopWorktree(dir, "worktree-stop-1");
    assert.equal(result.success, true);
    assert.equal(result.killed, true);
    assert.match(result.message, /Stopped worktree-stop-1/);

    assert.equal(await awaitDead(child.pid!), true, "engine should be dead after stop");
    assert.equal(existsSync(join(worktreePath, PID_FILE)), false);
  } finally {
    if (child?.pid && isPidAlive(child.pid)) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* ignore */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopWorktree: idempotent when PID file is missing", async () => {
  const dir = makeRepo();
  try {
    addWorktree(dir, "stop-2", "worktree-stop-2");
    const result = await stopWorktree(dir, "worktree-stop-2");
    assert.equal(result.success, true);
    assert.equal(result.killed, false);
    assert.match(result.message, /No PID file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopWorktree: clears stale PID file when recorded process is already dead", async () => {
  const dir = makeRepo();
  try {
    const worktreePath = addWorktree(dir, "stop-3", "worktree-stop-3");
    const corpse = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((r) => corpse.once("exit", () => r()));
    writePidFileFor(worktreePath, {
      pid: corpse.pid!,
      cliPid: corpse.pid!,
    });

    const result = await stopWorktree(dir, "worktree-stop-3");
    assert.equal(result.success, true);
    assert.equal(result.killed, false);
    assert.match(result.message, /stale PID file/);
    assert.equal(existsSync(join(worktreePath, PID_FILE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- runPreflightChecks: same-issue worktree + main-ahead-of-origin ---

test("runPreflightChecks: passes when no same-issue worktree and no remote", () => {
  const dir = makeRepo();
  try {
    const result = runPreflightChecks(dir, 99, "IMPLEMENT");
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflightChecks: blocks when same-issue worktree exists", () => {
  const dir = makeRepo();
  try {
    addWorktree(
      dir,
      "dangeresque-investigate-77",
      "worktree-dangeresque-investigate-77",
    );
    const result = runPreflightChecks(dir, 77, "IMPLEMENT");
    assert.equal(result.ok, false);
    assert.match(result.message!, /refusing to run IMPLEMENT/);
    assert.match(result.message!, /already has a worktree/);
    assert.match(result.message!, /worktree-dangeresque-investigate-77/);
    assert.match(result.message!, /dangeresque merge worktree-dangeresque-investigate-77/);
    assert.match(result.message!, /--force/);
    // Discard silently destroys the run report on a no-diff INVESTIGATE,
    // so the choice list must disclose the artifact-loss asymmetry (#64).
    assert.match(result.message!, /keeps the run report/);
    assert.match(result.message!, /deletes the run report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflightChecks: --force bypasses gates", () => {
  const dir = makeRepo();
  try {
    addWorktree(
      dir,
      "dangeresque-investigate-78",
      "worktree-dangeresque-investigate-78",
    );
    const result = runPreflightChecks(dir, 78, "IMPLEMENT", { force: true });
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepoWithRemote(): { local: string; remote: string } {
  const remote = mkdtempSync(join(tmpdir(), "dangeresque-remote-"));
  execSync("git init --bare -b main", env(remote));

  const local = mkdtempSync(join(tmpdir(), "dangeresque-local-"));
  execSync("git init -b main", env(local));
  execSync("git config user.email test@dangeresque.local", env(local));
  execSync("git config user.name test", env(local));
  execSync("git config commit.gpgsign false", env(local));
  execSync('git commit --allow-empty -m "initial"', env(local));
  execSync(`git remote add origin "${remote}"`, env(local));
  execSync("git push -u origin main", env(local));
  // Pin origin/HEAD so resolveDiffBase / preflight gate 2 can resolve it.
  execSync(
    "git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main",
    env(local),
  );
  return { local, remote };
}

test("runPreflightChecks: blocks when local main is ahead of origin", () => {
  const { local, remote } = makeRepoWithRemote();
  try {
    writeFileSync(join(local, "ahead.txt"), "ahead\n");
    execSync("git add ahead.txt", env(local));
    execSync('git commit -m "local ahead of origin"', env(local));

    const result = runPreflightChecks(local, 99, "IMPLEMENT");
    assert.equal(result.ok, false);
    assert.match(result.message!, /local main is 1 commit ahead of origin/);
    assert.match(result.message!, /git push origin main/);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("runPreflightChecks: passes when local main is in sync with origin", () => {
  const { local, remote } = makeRepoWithRemote();
  try {
    const result = runPreflightChecks(local, 99, "IMPLEMENT");
    assert.equal(result.ok, true);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("runPreflightChecks: lists every failing gate in one refusal message", () => {
  const { local, remote } = makeRepoWithRemote();
  try {
    addWorktree(local, "dangeresque-investigate-88", "worktree-dangeresque-investigate-88");
    writeFileSync(join(local, "ahead.txt"), "ahead\n");
    execSync("git add ahead.txt", env(local));
    execSync('git commit -m "ahead"', env(local));

    const result = runPreflightChecks(local, 88, "IMPLEMENT");
    assert.equal(result.ok, false);
    assert.match(result.message!, /already has a worktree/);
    assert.match(result.message!, /local main is 1 commit ahead/);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
