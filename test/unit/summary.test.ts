import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bucketNameStatus,
  buildCanonicalLine,
  rewriteSummaryFilesLine,
  normalizeSummaryFileCount,
} from "#dist/summary.js";
import { ArtifactBuilder } from "#dist/artifact.js";

// --- pure helpers: bucketing ---

test("bucketNameStatus: A → added, M → modified, D → deleted", () => {
  const out = "A\tnew.ts\nM\tmod.ts\nD\told.ts\n";
  assert.deepEqual(bucketNameStatus(out), {
    added: 1,
    modified: 1,
    deleted: 1,
  });
});

test("bucketNameStatus: R/C/T treated as modified", () => {
  const out = "R100\told.ts\tnew.ts\nC75\tsrc/a.ts\tsrc/b.ts\nT\tlink.ts\n";
  assert.deepEqual(bucketNameStatus(out), {
    added: 0,
    modified: 3,
    deleted: 0,
  });
});

test("bucketNameStatus: excludes .dangeresque/runs/ paths", () => {
  const out =
    "A\tsrc/code.ts\n" +
    "M\t.dangeresque/runs/issue-1/2026-01-01T00-00-00-IMPLEMENT.md\n" +
    "M\tsrc/other.ts\n";
  assert.deepEqual(bucketNameStatus(out), {
    added: 1,
    modified: 1,
    deleted: 0,
  });
});

test("bucketNameStatus: rename destination evaluated for runs/ exclusion", () => {
  // rename TO a runs/ path is excluded (defensive — should not happen in practice)
  const out = "R100\tsrc/a.ts\t.dangeresque/runs/issue-1/foo.md\n";
  assert.deepEqual(bucketNameStatus(out), {
    added: 0,
    modified: 0,
    deleted: 0,
  });
});

test("bucketNameStatus: empty input returns zero buckets", () => {
  assert.deepEqual(bucketNameStatus(""), {
    added: 0,
    modified: 0,
    deleted: 0,
  });
});

test("bucketNameStatus: malformed lines without tabs are skipped", () => {
  const out = "garbage line\nA\tnew.ts\nM\tmod.ts\n";
  assert.deepEqual(bucketNameStatus(out), {
    added: 1,
    modified: 1,
    deleted: 0,
  });
});

// --- pure helpers: canonical line ---

test("buildCanonicalLine: zero changes → bare line, no parenthetical", () => {
  assert.equal(
    buildCanonicalLine({ added: 0, modified: 0, deleted: 0 }),
    "Files: 0 changed",
  );
});

test("buildCanonicalLine: only added", () => {
  assert.equal(
    buildCanonicalLine({ added: 3, modified: 0, deleted: 0 }),
    "Files: 3 changed (3 added)",
  );
});

test("buildCanonicalLine: only modified", () => {
  assert.equal(
    buildCanonicalLine({ added: 0, modified: 5, deleted: 0 }),
    "Files: 5 changed (5 modified)",
  );
});

test("buildCanonicalLine: only deleted", () => {
  assert.equal(
    buildCanonicalLine({ added: 0, modified: 0, deleted: 2 }),
    "Files: 2 changed (2 deleted)",
  );
});

test("buildCanonicalLine: added + modified + deleted", () => {
  assert.equal(
    buildCanonicalLine({ added: 7, modified: 16, deleted: 3 }),
    "Files: 26 changed (7 added, 16 modified, 3 deleted)",
  );
});

test("buildCanonicalLine: drops zero buckets", () => {
  assert.equal(
    buildCanonicalLine({ added: 0, modified: 5, deleted: 2 }),
    "Files: 7 changed (5 modified, 2 deleted)",
  );
  assert.equal(
    buildCanonicalLine({ added: 4, modified: 0, deleted: 1 }),
    "Files: 5 changed (4 added, 1 deleted)",
  );
});

// --- pure helpers: SUMMARY rewrite — covers all 10 catalogued shapes ---

function summaryWith(filesLine: string): string {
  return (
    "<!-- SUMMARY -->\n" +
    "Mode: IMPLEMENT | Status: implemented, unverified\n" +
    `${filesLine}\n` +
    "Proof: 5/5 tests pass\n" +
    "Risks: none | Next: VERIFY\n" +
    "<!-- /SUMMARY -->\n\n" +
    "## Status\n\nimplemented, unverified\n"
  );
}

test("rewriteSummaryFilesLine: plain enumeration", () => {
  const original = summaryWith(
    "Files: 2 changed (src/runner.ts, test/unit/runner.test.ts)",
  );
  const result = rewriteSummaryFilesLine(original, "Files: 23 changed (7 added, 16 modified)");
  assert.ok(result);
  assert.match(result!, /^Files: 23 changed \(7 added, 16 modified\)$/m);
  assert.doesNotMatch(result!, /src\/runner\.ts/);
});

test("rewriteSummaryFilesLine: NEW annotations", () => {
  const original = summaryWith(
    "Files: 4 changed (src/stats.ts NEW, src/cli.ts, src/index.ts, test/unit/stats.test.ts NEW)",
  );
  const result = rewriteSummaryFilesLine(original, "Files: 4 changed (2 added, 2 modified)");
  assert.ok(result);
  assert.match(result!, /^Files: 4 changed \(2 added, 2 modified\)$/m);
  assert.doesNotMatch(result!, /NEW/);
});

test("rewriteSummaryFilesLine: DELETED annotation + commit info trailer", () => {
  const original = summaryWith(
    "Files: 9 changed (src/foo.ts, config-templates/CLAUDE.md.sample DELETED); 1 commit (dc763e5)",
  );
  const result = rewriteSummaryFilesLine(original, "Files: 9 changed (8 modified, 1 deleted)");
  assert.ok(result);
  assert.match(result!, /^Files: 9 changed \(8 modified, 1 deleted\)$/m);
  assert.doesNotMatch(result!, /DELETED/);
  assert.doesNotMatch(result!, /dc763e5/);
});

test("rewriteSummaryFilesLine: insertions/deletions stat trailer", () => {
  const original = summaryWith(
    "Files: 4 changed (src/a.ts, src/b.ts, src/c.ts, src/d.ts) — 248 insertions / 372 deletions",
  );
  const result = rewriteSummaryFilesLine(original, "Files: 4 changed (4 modified)");
  assert.ok(result);
  assert.match(result!, /^Files: 4 changed \(4 modified\)$/m);
  assert.doesNotMatch(result!, /insertions/);
});

test("rewriteSummaryFilesLine: trailing commit info", () => {
  const original = summaryWith("Files: 2 changed (src/a.ts, src/b.ts); 1 commit (86c4c2e)");
  const result = rewriteSummaryFilesLine(original, "Files: 2 changed (2 modified)");
  assert.ok(result);
  assert.match(result!, /^Files: 2 changed \(2 modified\)$/m);
  assert.doesNotMatch(result!, /86c4c2e/);
});

test("rewriteSummaryFilesLine: uncommitted qualifier", () => {
  const original = summaryWith("Files: 4 changed, uncommitted (src/a.ts, src/b.ts, src/c.ts, src/d.ts)");
  const result = rewriteSummaryFilesLine(original, "Files: 4 changed (4 added)");
  assert.ok(result);
  assert.match(result!, /^Files: 4 changed \(4 added\)$/m);
  assert.doesNotMatch(result!, /uncommitted/);
});

test("rewriteSummaryFilesLine: compact prose summary including runs/", () => {
  const original = summaryWith(
    "Files: 23 changed (src/artifact.ts, src/cli.ts, 21 migrated JSONs under .dangeresque/runs/)",
  );
  const result = rewriteSummaryFilesLine(original, "Files: 2 changed (2 modified)");
  assert.ok(result);
  assert.match(result!, /^Files: 2 changed \(2 modified\)$/m);
  assert.doesNotMatch(result!, /migrated JSONs/);
});

test("rewriteSummaryFilesLine: alternate aggregate phrasing (no 'N changed')", () => {
  const original = summaryWith("Files: 10 new + 2 edited (test/unit/x.test.ts)");
  const result = rewriteSummaryFilesLine(original, "Files: 12 changed (10 added, 2 modified)");
  assert.ok(result);
  assert.match(result!, /^Files: 12 changed \(10 added, 2 modified\)$/m);
  assert.doesNotMatch(result!, /\bnew \+ \b/);
});

test("rewriteSummaryFilesLine: +lines stat trailer", () => {
  const original = summaryWith("Files: 1 changed (docs/DESIGN.md, +334 lines)");
  const result = rewriteSummaryFilesLine(original, "Files: 1 changed (1 added)");
  assert.ok(result);
  assert.match(result!, /^Files: 1 changed \(1 added\)$/m);
  assert.doesNotMatch(result!, /\+334 lines/);
});

test("rewriteSummaryFilesLine: read-only INVESTIGATE shape with descriptor", () => {
  const original = summaryWith("Files: 0 changed (read-only investigation)");
  const result = rewriteSummaryFilesLine(original, "Files: 0 changed");
  assert.ok(result);
  assert.match(result!, /^Files: 0 changed$/m);
  assert.doesNotMatch(result!, /read-only/);
});

test("rewriteSummaryFilesLine: missing SUMMARY block returns null", () => {
  const result = rewriteSummaryFilesLine(
    "## Status\n\nimplemented\n\nFiles: 1 changed (foo)\n",
    "Files: 0 changed",
  );
  assert.equal(result, null);
});

test("rewriteSummaryFilesLine: SUMMARY block without Files: line returns null", () => {
  const original =
    "<!-- SUMMARY -->\n" +
    "Mode: IMPLEMENT | Status: implemented\n" +
    "Proof: 5/5 tests pass\n" +
    "<!-- /SUMMARY -->\n";
  assert.equal(rewriteSummaryFilesLine(original, "Files: 1 changed"), null);
});

test("rewriteSummaryFilesLine: leaves body 'Files Changed' enumeration alone", () => {
  // The replacement must be scoped to the SUMMARY block; if the body coincidentally
  // starts a line with `Files: ...` that should NOT be rewritten.
  const original =
    summaryWith("Files: 2 changed (a, b)") +
    "\n## Files Changed\n\nFiles: shadow line in body that should remain\n";
  const result = rewriteSummaryFilesLine(original, "Files: 2 changed (2 modified)");
  assert.ok(result);
  assert.match(result!, /^Files: 2 changed \(2 modified\)$/m);
  assert.match(result!, /^Files: shadow line in body that should remain$/m);
});

// --- integration: real git repo round-trip ---

interface TestRepo {
  dir: string;
  base: string;
}

function makeRepoWithBaseline(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-summary-test-"));
  const env = { cwd: dir, encoding: "utf-8" as const, stdio: "pipe" as const };
  execSync("git init -b test-main", env);
  execSync("git config user.email test@dangeresque.local", env);
  execSync("git config user.name test", env);
  execSync("git config commit.gpgsign false", env);

  writeFileSync(join(dir, "keep.ts"), "old\n");
  writeFileSync(join(dir, "modify.ts"), "old\n");
  writeFileSync(join(dir, "delete.ts"), "old\n");
  execSync("git add keep.ts modify.ts delete.ts", env);
  execSync('git commit -m "baseline"', env);

  const base = execSync("git rev-parse HEAD", env).trim();
  return { dir, base };
}

function writeArtifactFile(dir: string, filesLine: string): string {
  const archiveDir = join(dir, ".dangeresque", "runs", "issue-99");
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, "2026-01-01T00-00-00-IMPLEMENT.md");
  const content =
    "<!-- SUMMARY -->\n" +
    "Mode: IMPLEMENT | Status: implemented, unverified\n" +
    `${filesLine}\n` +
    "Proof: 5/5 tests pass\n" +
    "<!-- /SUMMARY -->\n\n## Status\n\nimplemented, unverified\n";
  writeFileSync(archivePath, content, "utf-8");
  // Commit the artifact to mimic the worker's commitArchiveFile step.
  execSync(`git add "${archivePath}"`, {
    cwd: dir,
    encoding: "utf-8",
    stdio: "pipe",
  });
  execSync('git commit -m "dangeresque run artifact"', {
    cwd: dir,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return archivePath;
}

function commitCount(dir: string): number {
  return parseInt(
    execSync("git rev-list --count HEAD", {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim(),
    10,
  );
}

function headMessage(dir: string): string {
  return execSync("git log -1 --pretty=%s", {
    cwd: dir,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

test("normalizeSummaryFileCount: rewrites Files: line, commits, returns canonical N", () => {
  const { dir, base } = makeRepoWithBaseline();
  try {
    // Worker stage: add, modify, delete actual code files (not under runs/).
    writeFileSync(join(dir, "added.ts"), "new\n");
    writeFileSync(join(dir, "modify.ts"), "modified\n");
    rmSync(join(dir, "delete.ts"));
    execSync("git add -A -- ':(exclude).dangeresque/runs'", {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    execSync('git commit -m "worker code"', {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Worker artifact (with a wrong self-reported count, on top of code commit).
    const archivePath = writeArtifactFile(dir,"Files: 99 changed (lies, all lies)");

    const before = commitCount(dir);

    const result = normalizeSummaryFileCount({
      worktreePath: dir,
      archivePath,
      diffBase: base,
    });

    // 1 added + 1 modified + 1 deleted = 3 (artifact .md excluded).
    assert.equal(result, 3);

    // .md was rewritten with the canonical line.
    const newContent = readFileSync(archivePath, "utf-8");
    assert.match(
      newContent,
      /^Files: 3 changed \(1 added, 1 modified, 1 deleted\)$/m,
    );
    assert.doesNotMatch(newContent, /lies, all lies/);

    // A new commit was created with the dangeresque message.
    assert.equal(commitCount(dir), before + 1);
    assert.equal(headMessage(dir), "dangeresque normalize summary count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeSummaryFileCount: zero changes (only artifact under runs/) → Files: 0 changed", () => {
  const { dir, base } = makeRepoWithBaseline();
  try {
    // Only an artifact .md committed — no code changes.
    const archivePath = writeArtifactFile(dir,"Files: 1 changed (.dangeresque/runs/issue-99/foo.md)");

    const result = normalizeSummaryFileCount({
      worktreePath: dir,
      archivePath,
      diffBase: base,
    });

    assert.equal(result, 0);
    const newContent = readFileSync(archivePath, "utf-8");
    assert.match(newContent, /^Files: 0 changed$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeSummaryFileCount: populates ArtifactBuilder.files_changed_count on success", () => {
  const { dir, base } = makeRepoWithBaseline();
  try {
    writeFileSync(join(dir, "added.ts"), "new\n");
    execSync("git add added.ts", { cwd: dir, encoding: "utf-8", stdio: "pipe" });
    execSync('git commit -m "worker code"', {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    const archivePath = writeArtifactFile(dir,"Files: 0 changed (oops)");

    const builder = new ArtifactBuilder({
      projectRoot: dir,
      issueNumber: 99,
      issueUrl: null,
      mode: "IMPLEMENT",
      engine: "claude",
      model: "m",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    });
    builder.setWorkerTiming(0, 1, 0);

    const result = normalizeSummaryFileCount({
      worktreePath: dir,
      archivePath,
      diffBase: base,
      builder,
    });
    assert.equal(result, 1);

    const artifact = builder.build();
    assert.equal(artifact.files_changed_count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeSummaryFileCount: missing SUMMARY block → warn-and-degrade, no commit", () => {
  const { dir, base } = makeRepoWithBaseline();
  try {
    // Write an artifact WITHOUT a SUMMARY block.
    const archiveDir = join(dir, ".dangeresque", "runs", "issue-99");
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, "2026-01-01T00-00-00-IMPLEMENT.md");
    writeFileSync(archivePath, "## Status\n\nimplemented\n");
    execSync(`git add "${archivePath}"`, {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    execSync('git commit -m "no summary block"', {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
    });

    const before = commitCount(dir);

    const builder = new ArtifactBuilder({
      projectRoot: dir,
      issueNumber: 99,
      issueUrl: null,
      mode: "IMPLEMENT",
      engine: "claude",
      model: "m",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    });
    builder.setWorkerTiming(0, 1, 0);

    const result = normalizeSummaryFileCount({
      worktreePath: dir,
      archivePath,
      diffBase: base,
      builder,
    });

    assert.equal(result, null);
    assert.equal(commitCount(dir), before);

    const artifact = builder.build();
    const events = artifact.lifecycle_events.map((e) => e.event);
    assert.ok(events.includes("summary_normalize_failed"));
    assert.equal(artifact.files_changed_count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeSummaryFileCount: archive file missing → warn-and-degrade, no commit", () => {
  const { dir, base } = makeRepoWithBaseline();
  try {
    const archivePath = join(dir, ".dangeresque", "runs", "issue-99", "missing.md");
    const before = commitCount(dir);

    const builder = new ArtifactBuilder({
      projectRoot: dir,
      issueNumber: 99,
      issueUrl: null,
      mode: "IMPLEMENT",
      engine: "claude",
      model: "m",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    });
    builder.setWorkerTiming(0, 1, 0);

    const result = normalizeSummaryFileCount({
      worktreePath: dir,
      archivePath,
      diffBase: base,
      builder,
    });

    assert.equal(result, null);
    assert.equal(commitCount(dir), before);

    const events = builder.build().lifecycle_events.map((e) => e.event);
    assert.ok(events.includes("summary_normalize_failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeSummaryFileCount: bad diffBase ref → warn-and-degrade, no commit", () => {
  const { dir } = makeRepoWithBaseline();
  try {
    const archivePath = writeArtifactFile(dir,"Files: 1 changed (a)");
    const before = commitCount(dir);

    const builder = new ArtifactBuilder({
      projectRoot: dir,
      issueNumber: 99,
      issueUrl: null,
      mode: "IMPLEMENT",
      engine: "claude",
      model: "m",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    });
    builder.setWorkerTiming(0, 1, 0);

    const result = normalizeSummaryFileCount({
      worktreePath: dir,
      archivePath,
      diffBase: "definitely-not-a-real-ref-zzzz",
      builder,
    });

    assert.equal(result, null);
    assert.equal(commitCount(dir), before);
    const events = builder.build().lifecycle_events.map((e) => e.event);
    assert.ok(events.includes("summary_normalize_failed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeSummaryFileCount: no-op rewrite (canonical already correct) → still updates builder, no commit", () => {
  const { dir, base } = makeRepoWithBaseline();
  try {
    writeFileSync(join(dir, "added.ts"), "new\n");
    execSync("git add added.ts", { cwd: dir, encoding: "utf-8", stdio: "pipe" });
    execSync('git commit -m "worker code"', {
      cwd: dir,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Worker self-reported the canonical line correctly already.
    const archivePath = writeArtifactFile(dir,"Files: 1 changed (1 added)");
    const before = commitCount(dir);

    const builder = new ArtifactBuilder({
      projectRoot: dir,
      issueNumber: 99,
      issueUrl: null,
      mode: "IMPLEMENT",
      engine: "claude",
      model: "m",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    });
    builder.setWorkerTiming(0, 1, 0);

    const result = normalizeSummaryFileCount({
      worktreePath: dir,
      archivePath,
      diffBase: base,
      builder,
    });

    assert.equal(result, 1);
    // No new commit because the file content is already correct.
    assert.equal(commitCount(dir), before);
    assert.equal(builder.build().files_changed_count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
