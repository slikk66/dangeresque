import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadIssueFixture,
  computeRunArchivePath,
  commitWorkerChanges,
  formatIssueComments,
} from "#dist/runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURES = join(PROJECT_ROOT, "test", "fixtures");
const INVALID_FIXTURES = join(FIXTURES, "issues");

test("loadIssueFixture: valid fixture returns correct shape", () => {
  const data = loadIssueFixture(join(FIXTURES, "example-issue.json"));
  assert.equal(data.number, 999);
  assert.equal(data.title, "Example fixture issue");
  assert.equal(typeof data.body, "string");
  assert.ok(Array.isArray(data.comments));
});

test("loadIssueFixture: non-existent path throws with 'Failed to read'", () => {
  assert.throws(
    () => loadIssueFixture("/tmp/definitely-not-real-xyz-zzzzz.json"),
    /Failed to read fixture file/,
  );
});

test("loadIssueFixture: invalid JSON throws with 'not valid JSON'", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  const path = join(tmp, "bad.json");
  try {
    writeFileSync(path, "{ not json");
    assert.throws(() => loadIssueFixture(path), /not valid JSON/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadIssueFixture: missing number field throws", () => {
  assert.throws(
    () => loadIssueFixture(join(INVALID_FIXTURES, "missing-number.json")),
    /missing required field "number"/,
  );
});

test("loadIssueFixture: missing title field throws", () => {
  assert.throws(
    () => loadIssueFixture(join(INVALID_FIXTURES, "missing-title.json")),
    /missing required field "title"/,
  );
});

test("loadIssueFixture: comment without author.login throws", () => {
  assert.throws(
    () => loadIssueFixture(join(INVALID_FIXTURES, "bad-author.json")),
    /author\.login/,
  );
});

test("loadIssueFixture: top-level non-object throws", () => {
  assert.throws(
    () => loadIssueFixture(join(INVALID_FIXTURES, "not-an-object.json")),
    /must be a JSON object/,
  );
});

test("computeRunArchivePath: produces expected suffix shape", () => {
  const p = computeRunArchivePath("/tmp/wt", 63, "IMPLEMENT");
  assert.match(
    p,
    /^\/tmp\/wt\/\.dangeresque\/runs\/issue-63\/\d{4}-\d{2}-\d{2}T[\d-]+-IMPLEMENT\.md$/,
  );
});

test("formatIssueComments: empty comments → empty string", () => {
  const result = formatIssueComments({
    number: 1,
    title: "t",
    body: "b",
    comments: [],
  });
  assert.equal(result, "");
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-commit-test-"));
  const env = { cwd: dir, encoding: "utf-8" as const, stdio: "pipe" as const };
  execSync("git init -b test-main", env);
  execSync("git config user.email test@dangeresque.local", env);
  execSync("git config user.name test", env);
  execSync("git config commit.gpgsign false", env);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
  execSync("git add .gitignore", env);
  execSync('git commit -m "init"', env);
  return dir;
}

function commitCount(dir: string): number {
  const out = execSync("git rev-list --count HEAD", {
    cwd: dir, encoding: "utf-8", stdio: "pipe",
  }).trim();
  return parseInt(out, 10);
}

function headMessage(dir: string): string {
  return execSync("git log -1 --pretty=%s", {
    cwd: dir, encoding: "utf-8", stdio: "pipe",
  }).trim();
}

function headFiles(dir: string): string[] {
  return execSync("git show --name-only --pretty=format: HEAD", {
    cwd: dir, encoding: "utf-8", stdio: "pipe",
  }).trim().split("\n").filter(Boolean);
}

test("commitWorkerChanges: stages + commits worker file changes", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
    const before = commitCount(dir);

    commitWorkerChanges(dir, 99, "IMPLEMENT");

    assert.equal(commitCount(dir), before + 1);
    assert.equal(headMessage(dir), "codex IMPLEMENT worker: issue #99");
    assert.deepEqual(headFiles(dir), ["src.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitWorkerChanges: no changes → no-op", () => {
  const dir = makeRepo();
  try {
    const before = commitCount(dir);
    commitWorkerChanges(dir, 99, "IMPLEMENT");
    assert.equal(commitCount(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitWorkerChanges: excludes .dangeresque/runs/ artifacts", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "code.ts"), "export const y = 2;\n");
    mkdirSync(join(dir, ".dangeresque", "runs", "issue-99"), { recursive: true });
    writeFileSync(
      join(dir, ".dangeresque", "runs", "issue-99", "2026-01-01T00-00-00-IMPLEMENT.md"),
      "# artifact\n"
    );

    commitWorkerChanges(dir, 99, "IMPLEMENT");

    const files = headFiles(dir);
    assert.deepEqual(files, ["code.ts"]);
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: dir, encoding: "utf-8", stdio: "pipe",
    }).trim();
    assert.match(untracked, /\.dangeresque\/runs\/issue-99\/2026-01-01T00-00-00-IMPLEMENT\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitWorkerChanges: only artifact present → no commit (artifact excluded)", () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, ".dangeresque", "runs", "issue-99"), { recursive: true });
    writeFileSync(
      join(dir, ".dangeresque", "runs", "issue-99", "2026-01-01T00-00-00-IMPLEMENT.md"),
      "# artifact only\n"
    );
    const before = commitCount(dir);

    commitWorkerChanges(dir, 99, "IMPLEMENT");

    assert.equal(commitCount(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitWorkerChanges: captures deletions + modifications, not only new files", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "keep.ts"), "old\n");
    writeFileSync(join(dir, "gone.ts"), "old\n");
    execSync("git add keep.ts gone.ts", { cwd: dir, encoding: "utf-8", stdio: "pipe" });
    execSync('git commit -m "baseline"', { cwd: dir, encoding: "utf-8", stdio: "pipe" });

    writeFileSync(join(dir, "keep.ts"), "new\n");
    rmSync(join(dir, "gone.ts"));
    const before = commitCount(dir);

    commitWorkerChanges(dir, 7, "REFACTOR");

    assert.equal(commitCount(dir), before + 1);
    assert.equal(headMessage(dir), "codex REFACTOR worker: issue #7");
    const files = headFiles(dir).sort();
    assert.deepEqual(files, ["gone.ts", "keep.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatIssueComments: keeps staged + last-3 humans, drops dangeresque logs + minimized", () => {
  const result = formatIssueComments({
    number: 1,
    title: "t",
    body: "b",
    comments: [
      { body: "**[staged IMPLEMENT]** guidance text", author: { login: "alice" }, isMinimized: false },
      { body: "**[dangeresque IMPLEMENT]** auto log", author: { login: "bot" }, isMinimized: false },
      { body: "minimized note", author: { login: "alice" }, isMinimized: true },
      { body: "first human", author: { login: "bob" }, isMinimized: false },
      { body: "second human", author: { login: "bob" }, isMinimized: false },
      { body: "third human", author: { login: "bob" }, isMinimized: false },
      { body: "fourth human", author: { login: "bob" }, isMinimized: false },
    ],
  });

  assert.match(result, /## Context Comments/);
  assert.match(result, /staged IMPLEMENT/);
  assert.doesNotMatch(result, /dangeresque IMPLEMENT/);
  assert.doesNotMatch(result, /minimized note/);
  assert.doesNotMatch(result, /first human/);
  assert.match(result, /second human/);
  assert.match(result, /third human/);
  assert.match(result, /fourth human/);
});
