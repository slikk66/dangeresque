import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadIssueFixture,
  computeRunArchivePath,
  captureWorkerChanges,
  formatIssueComments,
  bashPatternToPrefixRule,
  buildCodexRulesContent,
  writeCodexRulesFile,
  buildCodexWorkerArgs,
  buildCodexReviewArgs,
  buildClaudeWorkerArgs,
  buildClaudeReviewArgs,
  validateCodexModelEfforts,
  buildRunTag,
  executionReceiptPidFields,
  buildWorkerInvocation,
  buildReviewInvocation,
  readPromptWithLocal,
  exitCodeFromCloseEvent,
  clearStaleEngineState,
  resumeWorker,
  CODEX_RULES_RELPATH,
} from "#dist/runner.js";
import { mirrorIssueRuns } from "#dist/worktree.js";
import type { RunOptions } from "#dist/runner.js";
import type { DangeresqueConfig, PhaseConfig, RunPlan } from "#dist/config.js";

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

test("loadIssueFixture: comment createdAt is optional, preserved when present", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  const path = join(tmp, "issue.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        number: 1,
        title: "t",
        body: "b",
        comments: [
          { body: "dated", author: { login: "a" }, createdAt: "2026-08-07T18:00:00Z" },
          { body: "undated", author: { login: "a" } },
        ],
      }),
    );
    const data = loadIssueFixture(path);
    assert.equal(data.comments[0].createdAt, "2026-08-07T18:00:00Z");
    assert.equal(data.comments[1].createdAt, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadIssueFixture: non-string comment createdAt throws", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  const path = join(tmp, "issue.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        number: 1,
        title: "t",
        body: "b",
        comments: [{ body: "x", author: { login: "a" }, createdAt: 12345 }],
      }),
    );
    assert.throws(() => loadIssueFixture(path), /createdAt must be a string when present/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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

const CAPTURE = { issueNumber: 99, mode: "IMPLEMENT", engine: "codex" as const };

test("captureWorkerChanges: stages + commits worker file changes", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
    const before = commitCount(dir);

    const result = captureWorkerChanges(dir, CAPTURE);

    assert.equal(result.committed, true);
    assert.deepEqual(result.files, ["src.ts"]);
    assert.equal(result.error, undefined);
    assert.equal(commitCount(dir), before + 1);
    assert.equal(
      headMessage(dir),
      "dangeresque: capture codex IMPLEMENT worker output for issue #99",
    );
    assert.deepEqual(headFiles(dir), ["src.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The #93 case: a claude worker whose own `git commit` was denied. Nothing
// codex-specific may be required for capture to work — in particular there is
// no `.codex/` directory in the tree.
test("captureWorkerChanges: claude worker with no .codex dir → still commits", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "feature.ts"), "export const shipped = true;\n");
    const before = commitCount(dir);

    const result = captureWorkerChanges(dir, {
      issueNumber: 93,
      mode: "IMPLEMENT",
      engine: "claude",
    });

    assert.equal(result.committed, true);
    assert.equal(result.error, undefined);
    assert.equal(commitCount(dir), before + 1);
    assert.equal(
      headMessage(dir),
      "dangeresque: capture claude IMPLEMENT worker output for issue #93",
    );
    assert.deepEqual(headFiles(dir), ["feature.ts"]);
    assert.equal(
      execSync("git status --porcelain", { cwd: dir, encoding: "utf-8", stdio: "pipe" }).trim(),
      "",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorkerChanges: claude worker that self-committed → no second commit", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "self.ts"), "export const x = 1;\n");
    execSync("git add self.ts", { cwd: dir, encoding: "utf-8", stdio: "pipe" });
    execSync('git commit -m "worker did its own commit"', {
      cwd: dir, encoding: "utf-8", stdio: "pipe",
    });
    const before = commitCount(dir);

    const result = captureWorkerChanges(dir, {
      issueNumber: 93, mode: "IMPLEMENT", engine: "claude",
    });

    assert.equal(result.committed, false);
    assert.deepEqual(result.files, []);
    assert.equal(commitCount(dir), before);
    assert.equal(headMessage(dir), "worker did its own commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorkerChanges: not a git repo → returns error, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-capture-nogit-"));
  try {
    writeFileSync(join(dir, "loose.ts"), "orphan\n");
    const result = captureWorkerChanges(dir, {
      issueNumber: 93, mode: "IMPLEMENT", engine: "claude",
    });
    assert.equal(result.committed, false);
    assert.ok(result.error, "expected an error string");
    assert.match(result.error!, /failed to capture claude worker changes/);
    assert.match(result.error!, /manual salvage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorkerChanges: a stale PID file never rides the worker's commit", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "work.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, ".dangeresque.pid"), '{"pid":1}\n');

    const result = captureWorkerChanges(dir, {
      issueNumber: 93, mode: "IMPLEMENT", engine: "claude",
    });

    assert.equal(result.committed, true);
    assert.deepEqual(result.files, ["work.ts"]);
    assert.deepEqual(headFiles(dir), ["work.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorkerChanges: no changes → no-op", () => {
  const dir = makeRepo();
  try {
    const before = commitCount(dir);
    const result = captureWorkerChanges(dir, CAPTURE);
    assert.equal(result.committed, false);
    assert.equal(commitCount(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorkerChanges: excludes .dangeresque/runs/ artifacts", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "code.ts"), "export const y = 2;\n");
    mkdirSync(join(dir, ".dangeresque", "runs", "issue-99"), { recursive: true });
    writeFileSync(
      join(dir, ".dangeresque", "runs", "issue-99", "2026-01-01T00-00-00-IMPLEMENT.md"),
      "# artifact\n"
    );

    captureWorkerChanges(dir, CAPTURE);

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

test("captureWorkerChanges: only artifact present → no commit (artifact excluded)", () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, ".dangeresque", "runs", "issue-99"), { recursive: true });
    writeFileSync(
      join(dir, ".dangeresque", "runs", "issue-99", "2026-01-01T00-00-00-IMPLEMENT.md"),
      "# artifact only\n"
    );
    const before = commitCount(dir);

    captureWorkerChanges(dir, CAPTURE);

    assert.equal(commitCount(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captureWorkerChanges: captures deletions + modifications, not only new files", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "keep.ts"), "old\n");
    writeFileSync(join(dir, "gone.ts"), "old\n");
    execSync("git add keep.ts gone.ts", { cwd: dir, encoding: "utf-8", stdio: "pipe" });
    execSync('git commit -m "baseline"', { cwd: dir, encoding: "utf-8", stdio: "pipe" });

    writeFileSync(join(dir, "keep.ts"), "new\n");
    rmSync(join(dir, "gone.ts"));
    const before = commitCount(dir);

    captureWorkerChanges(dir, { issueNumber: 7, mode: "REFACTOR", engine: "codex" });

    assert.equal(commitCount(dir), before + 1);
    assert.equal(
      headMessage(dir),
      "dangeresque: capture codex REFACTOR worker output for issue #7",
    );
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

test("bashPatternToPrefixRule: translates four default disallowedTools entries", () => {
  const push = bashPatternToPrefixRule("Bash(git push *)");
  assert.ok(push);
  assert.match(push!, /pattern=\["git", "push"\]/);
  assert.match(push!, /decision="forbidden"/);
  assert.match(push!, /justification=".*git push.*"/);

  const resetHard = bashPatternToPrefixRule("Bash(git reset --hard *)");
  assert.ok(resetHard);
  assert.match(resetHard!, /pattern=\["git", "reset", "--hard"\]/);
  assert.match(resetHard!, /decision="forbidden"/);

  const rmrf = bashPatternToPrefixRule("Bash(rm -rf *)");
  assert.ok(rmrf);
  assert.match(rmrf!, /pattern=\["rm", "-rf"\]/);
  assert.match(rmrf!, /decision="forbidden"/);

  const branchD = bashPatternToPrefixRule("Bash(git branch -D *)");
  assert.ok(branchD);
  assert.match(branchD!, /pattern=\["git", "branch", "-D"\]/);
  assert.match(branchD!, /decision="forbidden"/);
});

test("bashPatternToPrefixRule: non-Bash() patterns return null", () => {
  assert.equal(bashPatternToPrefixRule("WebSearch"), null);
  assert.equal(bashPatternToPrefixRule("Edit"), null);
  assert.equal(bashPatternToPrefixRule("mcp__foo"), null);
});

test("bashPatternToPrefixRule: empty Bash() body returns null", () => {
  assert.equal(bashPatternToPrefixRule("Bash()"), null);
  assert.equal(bashPatternToPrefixRule("Bash( )"), null);
  assert.equal(bashPatternToPrefixRule("Bash(*)"), null);
});

test("bashPatternToPrefixRule: exact-match (no trailing *) tokenizes whole command", () => {
  const exact = bashPatternToPrefixRule("Bash(git push)");
  assert.ok(exact);
  assert.match(exact!, /pattern=\["git", "push"\]/);
});

test("buildCodexRulesContent: default four-entry list renders all four rules", () => {
  const content = buildCodexRulesContent([
    "Bash(git push *)",
    "Bash(git reset --hard *)",
    "Bash(rm -rf *)",
    "Bash(git branch -D *)",
  ]);
  assert.ok(content);
  assert.match(content!, /Auto-generated by dangeresque/);
  assert.match(content!, /pattern=\["git", "push"\]/);
  assert.match(content!, /pattern=\["git", "reset", "--hard"\]/);
  assert.match(content!, /pattern=\["rm", "-rf"\]/);
  assert.match(content!, /pattern=\["git", "branch", "-D"\]/);
  const forbiddenCount = (content!.match(/decision="forbidden"/g) ?? []).length;
  assert.equal(forbiddenCount, 4);
});

test("buildCodexRulesContent: mixed list drops non-Bash entries and keeps Bash ones", () => {
  const content = buildCodexRulesContent([
    "WebSearch",
    "Bash(git push *)",
    "Edit",
  ]);
  assert.ok(content);
  const ruleLines = content!.split("\n").filter((l) => l.startsWith("prefix_rule"));
  assert.equal(ruleLines.length, 1);
  assert.match(ruleLines[0], /pattern=\["git", "push"\]/);
});

test("buildCodexRulesContent: no Bash entries returns null", () => {
  assert.equal(buildCodexRulesContent([]), null);
  assert.equal(buildCodexRulesContent(["WebSearch", "Edit"]), null);
});

test("writeCodexRulesFile: writes .codex/rules/dangeresque.rules with default entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-codex-rules-"));
  try {
    const result = writeCodexRulesFile(dir, [
      "Bash(git push *)",
      "Bash(rm -rf *)",
    ]);
    assert.ok(result);
    assert.equal(result, join(dir, CODEX_RULES_RELPATH));
    assert.ok(existsSync(result!));
    const content = readFileSync(result!, "utf-8");
    assert.match(content, /pattern=\["git", "push"\]/);
    assert.match(content, /pattern=\["rm", "-rf"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeCodexRulesFile: no Bash entries → no file written, returns null", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-codex-rules-"));
  try {
    const result = writeCodexRulesFile(dir, []);
    assert.equal(result, null);
    assert.equal(existsSync(join(dir, CODEX_RULES_RELPATH)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeCodexArgsFixture(): { projectRoot: string; opts: RunOptions; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "dangeresque-codex-args-"));
  mkdirSync(join(projectRoot, ".dangeresque"), { recursive: true });
  writeFileSync(join(projectRoot, ".dangeresque", "worker-prompt.md"), "WORKER_PROMPT_TEMPLATE_BODY\n");
  writeFileSync(join(projectRoot, ".dangeresque", "review-prompt.md"), "REVIEW_PROMPT_TEMPLATE_BODY\n");

  const config: DangeresqueConfig = {
    engineDefaults: {
      claude: { model: "claude-model-default", effort: "max" },
      codex: { model: "codex-model-worker", effort: "xhigh" },
    },
    worker: { engine: "codex", model: "codex-model-worker", effort: "xhigh" },
    review: { engine: "codex", model: "codex-model-review", effort: "high" },
    permissionMode: "acceptEdits",
    headless: true,
    allowedTools: [],
    disallowedTools: [],
    workerPrompt: "worker-prompt.md",
    reviewPrompt: "review-prompt.md",
    notifications: true,
  };

  const opts: RunOptions = {
    projectRoot,
    config,
    plan: {
      worker: { engine: "codex", model: "codex-model-worker", effort: "xhigh" },
      review: { engine: "codex", model: "codex-model-review", effort: "high" },
    },
    mode: "IMPLEMENT",
    issueData: {
      number: 35,
      title: "codex argv prompt leak title",
      body: "UNIQUE_ISSUE_BODY_MARKER_XYZZY please do the thing",
      comments: [
        { body: "**[staged IMPLEMENT]** STAGED_COMMENT_MARKER_ABCDE", author: { login: "alice" }, isMinimized: false },
      ],
    },
  };

  return { projectRoot, opts, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

test("buildCodexWorkerArgs: returns {args, prompt}; args ends with '-'; prompt carries issue body; argv has no leak", () => {
  const { opts, cleanup } = makeCodexArgsFixture();
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-35/2026-04-23T00-00-00-IMPLEMENT.md";
    const result = buildCodexWorkerArgs(opts, "dangeresque-implement-35", archivePath);

    assert.ok(Array.isArray(result.args));
    assert.equal(result.args[result.args.length - 1], "-");
    assert.ok(result.prompt.length > 0);

    const argv = result.args.join(" ");
    assert.doesNotMatch(argv, /UNIQUE_ISSUE_BODY_MARKER_XYZZY/);
    assert.doesNotMatch(argv, /STAGED_COMMENT_MARKER_ABCDE/);
    assert.doesNotMatch(argv, /WORKER_PROMPT_TEMPLATE_BODY/);
    assert.doesNotMatch(argv, /Effort preference/);

    assert.match(result.prompt, /UNIQUE_ISSUE_BODY_MARKER_XYZZY/);
    assert.match(result.prompt, /STAGED_COMMENT_MARKER_ABCDE/);
    assert.match(result.prompt, /WORKER_PROMPT_TEMPLATE_BODY/);
    assert.doesNotMatch(result.prompt, /Effort preference/);

    assert.ok(result.args.includes("exec"));
    assert.ok(result.args.includes("--json"));
    assert.ok(result.args.includes("-s"));
    assert.equal(result.args[result.args.indexOf("-s") + 1], "workspace-write");
    assert.ok(result.args.includes("approval_policy=never"));
    assert.ok(result.args.includes("codex-model-worker"));
    assert.ok(result.args.includes('model_reasoning_effort="xhigh"'));
  } finally {
    cleanup();
  }
});

test("buildCodexWorkerArgs: args include '-c sandbox_workspace_write.network_access=true' adjacent pair", () => {
  const { opts, cleanup } = makeCodexArgsFixture();
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-35/2026-04-23T00-00-00-IMPLEMENT.md";
    const { args } = buildCodexWorkerArgs(opts, "dangeresque-implement-35", archivePath);

    const flagValue = "sandbox_workspace_write.network_access=true";
    const flagIndex = args.indexOf(flagValue);
    assert.ok(flagIndex > 0, `expected args to contain ${flagValue}`);
    assert.equal(args[flagIndex - 1], "-c", "flag value must be preceded by '-c'");
  } finally {
    cleanup();
  }
});

test("buildCodexReviewArgs: returns {args, prompt}; args ends with '-'; prompt carries issue body; argv has no leak", () => {
  const { opts, cleanup } = makeCodexArgsFixture();
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-35/2026-04-23T00-00-00-IMPLEMENT.md";
    const result = buildCodexReviewArgs(opts, "dangeresque-implement-35", archivePath);

    assert.ok(Array.isArray(result.args));
    assert.equal(result.args[result.args.length - 1], "-");
    assert.ok(result.prompt.length > 0);

    const argv = result.args.join(" ");
    assert.doesNotMatch(argv, /UNIQUE_ISSUE_BODY_MARKER_XYZZY/);
    assert.doesNotMatch(argv, /STAGED_COMMENT_MARKER_ABCDE/);
    assert.doesNotMatch(argv, /REVIEW_PROMPT_TEMPLATE_BODY/);
    assert.doesNotMatch(argv, /Effort preference/);

    assert.match(result.prompt, /UNIQUE_ISSUE_BODY_MARKER_XYZZY/);
    assert.match(result.prompt, /STAGED_COMMENT_MARKER_ABCDE/);
    assert.match(result.prompt, /REVIEW_PROMPT_TEMPLATE_BODY/);
    assert.doesNotMatch(result.prompt, /Effort preference/);

    assert.ok(result.args.includes("exec"));
    assert.ok(result.args.includes("--json"));
    assert.ok(result.args.includes("-s"));
    assert.equal(result.args[result.args.indexOf("-s") + 1], "workspace-write");
    assert.ok(result.args.includes("approval_policy=never"));
    assert.ok(result.args.includes("codex-model-review"));
    assert.ok(result.args.includes('model_reasoning_effort="high"'));
  } finally {
    cleanup();
  }
});

test("buildCodexReviewArgs: args include '-c sandbox_workspace_write.network_access=true' adjacent pair", () => {
  const { opts, cleanup } = makeCodexArgsFixture();
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-35/2026-04-23T00-00-00-IMPLEMENT.md";
    const { args } = buildCodexReviewArgs(opts, "dangeresque-implement-35", archivePath);

    const flagValue = "sandbox_workspace_write.network_access=true";
    const flagIndex = args.indexOf(flagValue);
    assert.ok(flagIndex > 0, `expected args to contain ${flagValue}`);
    assert.equal(args[flagIndex - 1], "-c", "flag value must be preceded by '-c'");
  } finally {
    cleanup();
  }
});

function makeClaudeArgsFixture(headless: boolean): { projectRoot: string; opts: RunOptions; cleanup: () => void } {
  const projectRoot = mkdtempSync(join(tmpdir(), "dangeresque-claude-args-"));
  mkdirSync(join(projectRoot, ".dangeresque"), { recursive: true });
  writeFileSync(join(projectRoot, ".dangeresque", "worker-prompt.md"), "CLAUDE_WORKER_PROMPT_BODY\n");
  writeFileSync(join(projectRoot, ".dangeresque", "review-prompt.md"), "CLAUDE_REVIEW_PROMPT_BODY\n");

  const config: DangeresqueConfig = {
    engineDefaults: {
      claude: { model: "claude-model-default", effort: "max" },
      codex: { model: "codex-model-default", effort: "xhigh" },
    },
    worker: { engine: "claude", model: "claude-model-default", effort: "max" },
    review: { effort: "low" },
    permissionMode: "acceptEdits",
    headless,
    allowedTools: [],
    disallowedTools: ["Bash(git push *)"],
    workerPrompt: "worker-prompt.md",
    reviewPrompt: "review-prompt.md",
    notifications: true,
  };

  const opts: RunOptions = {
    projectRoot,
    config,
    plan: {
      worker: { engine: "claude", model: "claude-model-default", effort: "max" },
      review: { engine: "claude", model: "claude-model-default", effort: "low" },
    },
    mode: "IMPLEMENT",
    issueData: {
      number: 43,
      title: "claude argv prompt leak title",
      body: "CLAUDE_ISSUE_BODY_MARKER_QWXYZ please do the thing",
      comments: [
        { body: "**[staged IMPLEMENT]** CLAUDE_STAGED_COMMENT_MARKER_LMNOP", author: { login: "alice" }, isMinimized: false },
      ],
    },
  };

  return { projectRoot, opts, cleanup: () => rmSync(projectRoot, { recursive: true, force: true }) };
}

test("buildClaudeWorkerArgs(headless=true): prompt returned; argv carries no issue body", () => {
  const { opts, cleanup } = makeClaudeArgsFixture(true);
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-04-23T00-00-00-IMPLEMENT.md";
    const result = buildClaudeWorkerArgs(opts, "dangeresque-implement-43", archivePath);

    assert.ok(Array.isArray(result.args));
    assert.ok(result.prompt.length > 0);
    assert.ok(typeof result.workerSessionId === "string" && result.workerSessionId.length > 0);

    const argv = result.args.join(" ");
    assert.doesNotMatch(argv, /CLAUDE_ISSUE_BODY_MARKER_QWXYZ/);
    assert.doesNotMatch(argv, /CLAUDE_STAGED_COMMENT_MARKER_LMNOP/);
    assert.doesNotMatch(argv, /You are an AFK worker/);

    assert.match(result.prompt, /CLAUDE_ISSUE_BODY_MARKER_QWXYZ/);
    assert.match(result.prompt, /CLAUDE_STAGED_COMMENT_MARKER_LMNOP/);
    assert.match(result.prompt, /You are an AFK worker/);

    assert.ok(result.args.includes("-p"));
    assert.ok(result.args.includes("--session-id"));
    assert.equal(result.args[result.args.length - 1], result.workerSessionId);
  } finally {
    cleanup();
  }
});

test("buildClaudeWorkerArgs(headless=false): prompt returned AND appended positionally (interactive fallback)", () => {
  const { opts, cleanup } = makeClaudeArgsFixture(false);
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-04-23T00-00-00-IMPLEMENT.md";
    const result = buildClaudeWorkerArgs(opts, "dangeresque-implement-43", archivePath);

    assert.ok(result.prompt.length > 0);
    assert.ok(!result.args.includes("-p"));

    assert.equal(result.args[result.args.length - 1], result.prompt);

    const argv = result.args.join(" ");
    assert.match(argv, /CLAUDE_ISSUE_BODY_MARKER_QWXYZ/);
    assert.match(argv, /CLAUDE_STAGED_COMMENT_MARKER_LMNOP/);
  } finally {
    cleanup();
  }
});

test("buildClaudeReviewArgs(headless=true): prompt returned; argv carries no issue body", () => {
  const { opts, cleanup } = makeClaudeArgsFixture(true);
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-04-23T00-00-00-IMPLEMENT.md";
    const result = buildClaudeReviewArgs(opts, "dangeresque-implement-43", archivePath);

    assert.ok(Array.isArray(result.args));
    assert.ok(result.prompt.length > 0);
    assert.ok(typeof result.reviewSessionId === "string" && result.reviewSessionId.length > 0);

    const argv = result.args.join(" ");
    assert.doesNotMatch(argv, /CLAUDE_ISSUE_BODY_MARKER_QWXYZ/);
    assert.doesNotMatch(argv, /CLAUDE_STAGED_COMMENT_MARKER_LMNOP/);
    assert.doesNotMatch(argv, /adversarial reviewer/);

    assert.match(result.prompt, /CLAUDE_ISSUE_BODY_MARKER_QWXYZ/);
    assert.match(result.prompt, /CLAUDE_STAGED_COMMENT_MARKER_LMNOP/);
    assert.match(result.prompt, /adversarial reviewer/);

    assert.ok(result.args.includes("-p"));
    assert.ok(result.args.includes("--session-id"));
    assert.equal(result.args[result.args.length - 1], result.reviewSessionId);
  } finally {
    cleanup();
  }
});

test("buildClaudeReviewArgs(headless=false): prompt returned AND appended positionally (interactive fallback)", () => {
  const { opts, cleanup } = makeClaudeArgsFixture(false);
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-04-23T00-00-00-IMPLEMENT.md";
    const result = buildClaudeReviewArgs(opts, "dangeresque-implement-43", archivePath);

    assert.ok(result.prompt.length > 0);
    assert.ok(!result.args.includes("-p"));

    assert.equal(result.args[result.args.length - 1], result.prompt);

    const argv = result.args.join(" ");
    assert.match(argv, /CLAUDE_ISSUE_BODY_MARKER_QWXYZ/);
    assert.match(argv, /CLAUDE_STAGED_COMMENT_MARKER_LMNOP/);
  } finally {
    cleanup();
  }
});

// --- Scope Declaration prompt stub: mode-gated injection ---

for (const mode of ["IMPLEMENT", "REFACTOR", "TEST"] as const) {
  test(`buildClaudeWorkerArgs: prompt includes '## Scope Declaration' stub for ${mode}`, () => {
    const { opts, cleanup } = makeClaudeArgsFixture(true);
    try {
      const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-04-23T00-00-00-IMPLEMENT.md";
      const result = buildClaudeWorkerArgs({ ...opts, mode }, "dangeresque-implement-43", archivePath);
      assert.match(result.prompt, /## Scope Declaration/);
      assert.match(result.prompt, /declared/);
      assert.match(result.prompt, /extension/);
      assert.match(result.prompt, /opportunistic/);
      assert.match(result.prompt, /incidental/);
    } finally {
      cleanup();
    }
  });
}

for (const mode of ["INVESTIGATE", "VERIFY"] as const) {
  test(`buildClaudeWorkerArgs: prompt does NOT include '## Scope Declaration' stub for ${mode}`, () => {
    const { opts, cleanup } = makeClaudeArgsFixture(true);
    try {
      const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-04-23T00-00-00-IMPLEMENT.md";
      const result = buildClaudeWorkerArgs({ ...opts, mode }, "dangeresque-implement-43", archivePath);
      assert.doesNotMatch(result.prompt, /## Scope Declaration/);
    } finally {
      cleanup();
    }
  });
}

test("buildCodexWorkerArgs: prompt includes '## Scope Declaration' stub for IMPLEMENT (engine parity)", () => {
  const { opts, cleanup } = makeCodexArgsFixture();
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-35/2026-04-23T00-00-00-IMPLEMENT.md";
    const result = buildCodexWorkerArgs(opts, "dangeresque-implement-35", archivePath);
    assert.match(result.prompt, /## Scope Declaration/);
  } finally {
    cleanup();
  }
});

test("buildCodexWorkerArgs: prompt does NOT include '## Scope Declaration' stub for INVESTIGATE", () => {
  const { opts, cleanup } = makeCodexArgsFixture();
  try {
    const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-35/2026-04-23T00-00-00-IMPLEMENT.md";
    const result = buildCodexWorkerArgs({ ...opts, mode: "INVESTIGATE" }, "dangeresque-implement-35", archivePath);
    assert.doesNotMatch(result.prompt, /## Scope Declaration/);
  } finally {
    cleanup();
  }
});

// --- Resume Context prompt block: dispatch-gated injection (issue #110) ---

const PRIOR_ARTIFACT =
  "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-09-03T04-00-00-IMPLEMENT.md";

function assertResumeBlock(prompt: string) {
  assert.equal(
    prompt.match(/## Resume Context/g)?.length,
    1,
    "exactly one Resume Context block — the worker must not get contradicting copies",
  );
  assert.ok(prompt.includes(PRIOR_ARTIFACT), "names the prior attempt's real path");
  assert.match(prompt, /git status/);
  assert.match(prompt, /git diff/);
  assert.match(prompt, /do not restart/i);
  assert.match(prompt, /uncommitted work from a PRIOR attempt/);
  assert.match(prompt, /do not revert or rewrite an existing hunk unless/i);
}

test("buildClaudeWorkerArgs: a resumed run gets exactly one Resume Context block", () => {
  const { opts, cleanup } = makeClaudeArgsFixture(true);
  try {
    const result = buildClaudeWorkerArgs(
      { ...opts, resume: { priorArtifactPath: PRIOR_ARTIFACT } },
      "dangeresque-implement-43",
      "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-09-03T09-00-00-IMPLEMENT.md",
    );
    assertResumeBlock(result.prompt);
  } finally {
    cleanup();
  }
});

test("buildCodexWorkerArgs: engine parity — the same single Resume Context block", () => {
  const { opts, cleanup } = makeCodexArgsFixture();
  try {
    const result = buildCodexWorkerArgs(
      { ...opts, mode: "IMPLEMENT", resume: { priorArtifactPath: PRIOR_ARTIFACT } },
      "dangeresque-implement-35",
      "/tmp/fake-wt/.dangeresque/runs/issue-35/2026-09-03T09-00-00-IMPLEMENT.md",
    );
    assertResumeBlock(result.prompt);
  } finally {
    cleanup();
  }
});

for (const engine of ["claude", "codex"] as const) {
  test(`${engine} worker prompt carries NO Resume Context on a fresh dispatch`, () => {
    const fixture =
      engine === "claude" ? makeClaudeArgsFixture(true) : makeCodexArgsFixture();
    try {
      const archivePath = "/tmp/fake-wt/.dangeresque/runs/issue-1/2026-09-03T09-00-00-IMPLEMENT.md";
      const prompt =
        engine === "claude"
          ? buildClaudeWorkerArgs(fixture.opts, "dangeresque-implement-43", archivePath).prompt
          : buildCodexWorkerArgs(fixture.opts, "dangeresque-implement-35", archivePath).prompt;
      assert.doesNotMatch(prompt, /## Resume Context/);
    } finally {
      fixture.cleanup();
    }
  });
}

test("Resume Context is the LAST instruction, after the Scope Declaration stub", () => {
  // A resumed worker that restarts from scratch throws away exactly the work
  // this verb exists to save, so the instruction not to must not be buried.
  const { opts, cleanup } = makeClaudeArgsFixture(true);
  try {
    const { prompt } = buildClaudeWorkerArgs(
      { ...opts, mode: "IMPLEMENT", resume: { priorArtifactPath: PRIOR_ARTIFACT } },
      "dangeresque-implement-43",
      "/tmp/fake-wt/.dangeresque/runs/issue-43/2026-09-03T09-00-00-IMPLEMENT.md",
    );
    assert.ok(prompt.indexOf("## Resume Context") > prompt.indexOf("## Scope Declaration"));
  } finally {
    cleanup();
  }
});

// --- resume: the worktree is re-entered exactly as the dead worker left it ---

test("clearStaleEngineState: a claude resume drops the dead codex run's injected .codex/", () => {
  // Left in place it stays untracked through captureWorkerChanges (which resets
  // it but only DELETES it for codex), and the run is scored
  // uncommitted_worker_changes over a file dangeresque itself wrote.
  const dir = makeRepo();
  try {
    writeCodexRulesFile(dir, ["Bash(git push *)"]);
    assert.ok(existsSync(join(dir, CODEX_RULES_RELPATH)));

    clearStaleEngineState(dir, "claude");

    assert.equal(existsSync(join(dir, ".codex")), false, "only our file lived there, so the dirs go too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleEngineState: removes ONLY dangeresque's rules file — a populated .codex/ survives", () => {
  // The reviewer's regression: an rm -rf of .codex/ would erase operator config
  // or a dead worker's own hunk under that directory. Resume promises the dirty
  // tree back byte-for-byte except for what dangeresque itself wrote.
  const dir = makeRepo();
  try {
    writeCodexRulesFile(dir, ["Bash(git push *)"]);
    writeFileSync(join(dir, ".codex", "config.toml"), "model = \"operator-chosen\"\n");
    mkdirSync(join(dir, ".codex", "sessions"), { recursive: true });
    writeFileSync(join(dir, ".codex", "sessions", "dead-run.jsonl"), "{}\n");
    writeFileSync(join(dir, ".codex", "rules", "operator.rules"), "prefix_rule(pattern=[\"x\"])\n");

    clearStaleEngineState(dir, "claude");

    assert.equal(existsSync(join(dir, CODEX_RULES_RELPATH)), false, "ours is gone");
    assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf-8"), "model = \"operator-chosen\"\n");
    assert.ok(existsSync(join(dir, ".codex", "sessions", "dead-run.jsonl")));
    assert.ok(existsSync(join(dir, ".codex", "rules", "operator.rules")), "sibling rules file kept, dir not pruned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleEngineState: a codex resume keeps .codex/ (its own engine's state)", () => {
  const dir = makeRepo();
  try {
    writeCodexRulesFile(dir, ["Bash(git push *)"]);
    clearStaleEngineState(dir, "codex");
    assert.ok(existsSync(join(dir, CODEX_RULES_RELPATH)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleEngineState: never touches worker output", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "worker-was-here.ts"), "export const x = 1;\n");
    clearStaleEngineState(dir, "claude");
    assert.ok(existsSync(join(dir, "worker-was-here.ts")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume pre-spawn work leaves the dead worker's dirty tree byte-identical", () => {
  // `resumeWorker` touches the tree in exactly two ways before it spawns:
  // clearStaleEngineState and mirrorIssueRuns. Neither may disturb the diff —
  // no rebase, no stash, no reset, no checkout. The dirty tree IS the payload.
  const projectRoot = makeRepo();
  try {
    const worktreePath = join(projectRoot, ".claude", "worktrees", "dangeresque-implement-866");
    mkdirSync(worktreePath, { recursive: true });
    execSync(`git worktree add -b worktree-dangeresque-implement-866 "${worktreePath}"`, {
      cwd: projectRoot, encoding: "utf-8", stdio: "pipe",
    });
    const wtEnv = { cwd: worktreePath, encoding: "utf-8" as const, stdio: "pipe" as const };

    // The three shapes a dead worker leaves behind: staged, unstaged, untracked.
    writeFileSync(join(worktreePath, "tracked.ts"), "original\n");
    // `dangeresque init` gitignores the runs dir in every consumer repo, which
    // is why mirroring artifacts in never shows up as worker output.
    writeFileSync(join(worktreePath, ".gitignore"), "node_modules/\ndist/\n.dangeresque/runs/\n");
    execSync("git add tracked.ts .gitignore", wtEnv);
    execSync('git commit -m "baseline"', wtEnv);
    writeFileSync(join(worktreePath, "tracked.ts"), "worker edited this\n");
    writeFileSync(join(worktreePath, "staged.ts"), "worker staged this\n");
    execSync("git add staged.ts", wtEnv);
    writeFileSync(join(worktreePath, "untracked.ts"), "worker never staged this\n");
    writeCodexRulesFile(worktreePath, ["Bash(git push *)"]);

    // The issue's merged history, as it sits in the project root at resume time.
    const rootIssueDir = join(projectRoot, ".dangeresque", "runs", "issue-866");
    mkdirSync(rootIssueDir, { recursive: true });
    writeFileSync(join(rootIssueDir, "2026-09-01T00-00-00-INVESTIGATE.md"), "prior\n");

    // The dead attempt's own partial artifact, worktree-only.
    const wtIssueDir = join(worktreePath, ".dangeresque", "runs", "issue-866");
    mkdirSync(wtIssueDir, { recursive: true });
    const ownArtifact = join(wtIssueDir, "2026-09-03T04-00-00-IMPLEMENT.md");
    writeFileSync(ownArtifact, "## Partial notes\n");

    const headBefore = execSync("git rev-parse HEAD", wtEnv).trim();
    const statusBefore = execSync("git status --porcelain --untracked-files=all", wtEnv);
    const diffBefore = execSync("git diff HEAD", wtEnv);
    const reflogBefore = execSync("git reflog --format=%gs", wtEnv);

    clearStaleEngineState(worktreePath, "claude");
    mirrorIssueRuns(projectRoot, worktreePath, 866);

    assert.equal(execSync("git rev-parse HEAD", wtEnv).trim(), headBefore, "HEAD unmoved");
    assert.equal(execSync("git diff HEAD", wtEnv), diffBefore, "staged + unstaged diff intact");
    assert.equal(
      execSync("git reflog --format=%gs", wtEnv),
      reflogBefore,
      "no rebase, reset or checkout ran",
    );
    assert.equal(
      readFileSync(join(worktreePath, "untracked.ts"), "utf-8"),
      "worker never staged this\n",
    );

    // Only the orchestrator-owned .codex/ leaves the porcelain listing.
    const statusAfter = execSync("git status --porcelain --untracked-files=all", wtEnv);
    assert.match(statusBefore, /\.codex\//);
    assert.doesNotMatch(statusAfter, /\.codex\//);
    assert.deepEqual(
      statusAfter.split("\n").filter(Boolean),
      statusBefore.split("\n").filter((l) => l.trim() && !l.includes(".codex/")),
    );

    // Mirroring is additive: prior history arrives, the dead attempt survives.
    assert.equal(readFileSync(ownArtifact, "utf-8"), "## Partial notes\n");
    assert.ok(existsSync(join(wtIssueDir, "2026-09-01T00-00-00-INVESTIGATE.md")));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("resumeWorker: end-to-end against a fake engine — spawns in the dirty worktree, tree intact, PID file cleared", async () => {
  // Everything `resume` promises, exercised through the real `resumeWorker`:
  // the engine is launched with the existing worktree as its cwd, the dead
  // attempt's staged/unstaged/untracked work is byte-identical afterwards, the
  // PID file the run wrote is gone once the engine exits, and the invocation
  // carried the Resume Context (the fake engine records what it received).
  const projectRoot = makeRepo();
  const binDir = mkdtempSync(join(tmpdir(), "dangeresque-fake-claude-"));
  const savedPath = process.env.PATH;
  try {
    const record = join(binDir, "invocation.txt");
    writeFileSync(
      join(binDir, "claude"),
      `#!/bin/sh\nprintf '%s\\n' "$PWD" > "${record}"\nprintf '%s\\n' "$@" >> "${record}"\ncat >> "${record}"\nexit 0\n`,
    );
    chmodSync(join(binDir, "claude"), 0o755);
    process.env.PATH = `${binDir}:${savedPath}`;

    mkdirSync(join(projectRoot, ".dangeresque"), { recursive: true });
    writeFileSync(join(projectRoot, ".dangeresque", "worker-prompt.md"), "WORKER_PROMPT_BODY\n");
    writeFileSync(join(projectRoot, ".dangeresque", "review-prompt.md"), "REVIEW_PROMPT_BODY\n");

    const worktreeName = "dangeresque-implement-866";
    const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);
    mkdirSync(dirname(worktreePath), { recursive: true });
    execSync(`git worktree add -b worktree-${worktreeName} "${worktreePath}"`, {
      cwd: projectRoot, encoding: "utf-8", stdio: "pipe",
    });
    const wtEnv = { cwd: worktreePath, encoding: "utf-8" as const, stdio: "pipe" as const };
    writeFileSync(join(worktreePath, ".gitignore"), "node_modules/\ndist/\n.dangeresque/runs/\n.dangeresque.pid\n");
    writeFileSync(join(worktreePath, "tracked.ts"), "original\n");
    execSync("git add .gitignore tracked.ts", wtEnv);
    execSync('git commit -m "baseline"', wtEnv);
    writeFileSync(join(worktreePath, "tracked.ts"), "worker edited this\n");
    writeFileSync(join(worktreePath, "staged.ts"), "worker staged this\n");
    execSync("git add staged.ts", wtEnv);
    writeFileSync(join(worktreePath, "untracked.ts"), "worker never staged this\n");
    const wtIssueDir = join(worktreePath, ".dangeresque", "runs", "issue-866");
    mkdirSync(wtIssueDir, { recursive: true });
    const prior = join(wtIssueDir, "2026-09-03T04-00-00-IMPLEMENT.md");
    writeFileSync(prior, "## Partial notes\n");

    const headBefore = execSync("git rev-parse HEAD", wtEnv).trim();
    const diffBefore = execSync("git diff HEAD", wtEnv);
    const statusBefore = execSync("git status --porcelain --untracked-files=all", wtEnv);

    const config: DangeresqueConfig = {
      engineDefaults: {
        claude: { model: "claude-model-default", effort: "max" },
        codex: { model: "codex-model-default", effort: "xhigh" },
      },
      worker: { engine: "claude", model: "claude-model-default", effort: "max" },
      review: { effort: "low" },
      permissionMode: "acceptEdits",
      headless: true,
      allowedTools: [],
      disallowedTools: ["Bash(git push *)"],
      workerPrompt: "worker-prompt.md",
      reviewPrompt: "review-prompt.md",
      notifications: false,
    };
    const result = await resumeWorker(
      {
        projectRoot,
        config,
        plan: {
          worker: { engine: "claude", model: "claude-model-default", effort: "max" },
          review: { engine: "claude", model: "claude-model-default", effort: "low" },
        },
        mode: "IMPLEMENT",
        issueData: { number: 866, title: "t", body: "b", comments: [] },
        resume: { priorArtifactPath: prior },
      },
      { worktreeName, branch: `worktree-${worktreeName}` },
    );

    assert.equal(result.exitCode, 0);
    const recorded = readFileSync(record, "utf-8");
    // The claude adapter launches from the project root and attaches to the
    // existing checkout with `--worktree <name>` — that is the one place the
    // dirty-tree question (VERIFY step 1) lives, so pin the shape.
    assert.equal(recorded.split("\n")[0], realpathSync(projectRoot), "launched from the project root");
    assert.match(recorded, new RegExp(`(?:--worktree|-w)\\n${worktreeName}\\n`), "attached to the existing worktree by name");
    assert.match(recorded, /Resume Context/, "the engine received the resume block");
    assert.match(recorded, /2026-09-03T04-00-00-IMPLEMENT\.md/, "…naming the dead attempt's artifact");
    assert.equal(execSync("git rev-parse HEAD", wtEnv).trim(), headBefore, "HEAD unmoved");
    assert.equal(execSync("git diff HEAD", wtEnv), diffBefore, "staged + unstaged diff intact");
    assert.equal(
      execSync("git status --porcelain --untracked-files=all", wtEnv),
      statusBefore,
      "porcelain identical — nothing added, nothing removed",
    );
    assert.equal(readFileSync(prior, "utf-8"), "## Partial notes\n", "dead attempt's artifact survives");
    assert.equal(existsSync(join(worktreePath, ".dangeresque.pid")), false, "PID file cleared on exit");
  } finally {
    process.env.PATH = savedPath;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("resumeWorker: refuses a worktree that no longer exists", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "dangeresque-resume-missing-"));
  try {
    await assert.rejects(
      resumeWorker(
        {
          projectRoot,
          config: {} as DangeresqueConfig,
          plan: {
            worker: { engine: "claude", model: "m", effort: "max" },
            review: { engine: "claude", model: "m", effort: "max" },
          },
          issueData: { number: 1, title: "t", body: "b", comments: [] },
          mode: "IMPLEMENT",
        },
        { worktreeName: "dangeresque-implement-1", branch: "worktree-dangeresque-implement-1" },
      ),
      /Cannot resume: worktree does not exist/,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("readPromptWithLocal: canonical only, .local.md missing → canonical", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-prompt-local-"));
  try {
    writeFileSync(join(dir, "worker-prompt.md"), "CANON\n");
    assert.equal(readPromptWithLocal(dir, "worker-prompt.md"), "CANON\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPromptWithLocal: canonical + .local.md with content → concatenated with double newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-prompt-local-"));
  try {
    writeFileSync(join(dir, "worker-prompt.md"), "CANON\n");
    writeFileSync(join(dir, "worker-prompt.local.md"), "LOCAL ADDITION\n");
    assert.equal(
      readPromptWithLocal(dir, "worker-prompt.md"),
      "CANON\n\n\nLOCAL ADDITION",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPromptWithLocal: canonical + empty .local.md → canonical only", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-prompt-local-"));
  try {
    writeFileSync(join(dir, "worker-prompt.md"), "CANON\n");
    writeFileSync(join(dir, "worker-prompt.local.md"), "");
    assert.equal(readPromptWithLocal(dir, "worker-prompt.md"), "CANON\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPromptWithLocal: canonical + whitespace-only .local.md → canonical only (trim)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-prompt-local-"));
  try {
    writeFileSync(join(dir, "worker-prompt.md"), "CANON\n");
    writeFileSync(join(dir, "worker-prompt.local.md"), "   \n\n  \t\n");
    assert.equal(readPromptWithLocal(dir, "worker-prompt.md"), "CANON\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPromptWithLocal: canonical missing → throws (readFileSync ENOENT)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-prompt-local-"));
  try {
    assert.throws(
      () => readPromptWithLocal(dir, "missing-prompt.md"),
      /ENOENT/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- exitCodeFromCloseEvent: prevent "code ?? 0" signal-kill collapse ---

test("exitCodeFromCloseEvent: passes through non-null exit code", () => {
  assert.equal(exitCodeFromCloseEvent(0, null), 0);
  assert.equal(exitCodeFromCloseEvent(1, null), 1);
  assert.equal(exitCodeFromCloseEvent(42, null), 42);
});

test("exitCodeFromCloseEvent: signal-killed maps to 128 + signal number (POSIX)", () => {
  // SIGTERM is 15 → 143; SIGKILL is 9 → 137; SIGINT is 2 → 130.
  assert.equal(exitCodeFromCloseEvent(null, "SIGTERM"), 143);
  assert.equal(exitCodeFromCloseEvent(null, "SIGKILL"), 137);
  assert.equal(exitCodeFromCloseEvent(null, "SIGINT"), 130);
});

test("exitCodeFromCloseEvent: both null returns 0 (clean exit fallback)", () => {
  assert.equal(exitCodeFromCloseEvent(null, null), 0);
});

test("exitCodeFromCloseEvent: signal takes precedence over a non-null code", () => {
  // Per Node child_process: when killed by signal, code is null. But guard
  // against the inverse — if code is set we trust it; signal alone never
  // beats an explicit code. This locks in the documented contract.
  assert.equal(exitCodeFromCloseEvent(0, null), 0);
  assert.equal(exitCodeFromCloseEvent(0, "SIGTERM"), 0);
});

const plan = (worker: PhaseConfig, review: PhaseConfig = worker): RunPlan => ({ worker, review });

const codexCatalog = {
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
};

test("validateCodexModelEfforts: accepts gpt-5.5 xhigh for worker and review", () => {
  const result = validateCodexModelEfforts(
    plan(
      { engine: "codex", model: "gpt-5.5", effort: "xhigh" },
      { engine: "codex", model: "gpt-5.5", effort: "xhigh" },
    ),
    codexCatalog,
  );
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateCodexModelEfforts: rejects max on gpt-5.5 loudly", () => {
  const result = validateCodexModelEfforts(
    plan({ engine: "codex", model: "gpt-5.5", effort: "max" }),
    codexCatalog,
  );
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /gpt-5\.5/);
  assert.match(result.errors.join("\n"), /max/);
  assert.match(result.errors.join("\n"), /low, medium, high, xhigh/);
});

test("validateCodexModelEfforts: validates review model/effort independently", () => {
  const result = validateCodexModelEfforts(
    plan(
      { engine: "claude", model: "claude-opus", effort: "max" },
      { engine: "codex", model: "gpt-5.5", effort: "max" },
    ),
    codexCatalog,
  );
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Review Codex model 'gpt-5\.5'/);
  assert.match(result.errors.join("\n"), /effort 'max'/);
});

test("validateCodexModelEfforts: rejects ultra even when catalog advertises it", () => {
  const result = validateCodexModelEfforts(
    plan({ engine: "codex", model: "gpt-5.6-sol", effort: "ultra" }),
    codexCatalog,
  );
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /ultra.*delegation/i);
});

test("validateCodexModelEfforts: ignores unscheduled Codex review", () => {
  const result = validateCodexModelEfforts(
    plan(
      { engine: "claude", model: "claude-opus", effort: "max" },
      { engine: "codex", model: "gpt-5.5", effort: "max" },
    ),
    codexCatalog,
    false,
  );
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("buildRunTag: shows mixed review engine", () => {
  const tag = buildRunTag("IMPLEMENT", {
    projectRoot: "/tmp",
    issueNumber: 1,
    mode: "IMPLEMENT",
    worktreeName: "wt",
    archivePath: "/tmp/run.md",
    workerExitCode: 0,
    engine: "codex",
    reviewEngine: "claude",
    model: "gpt-5.5",
    effort: "xhigh",
    reviewModel: "claude-opus-4-7",
    reviewEffort: "max",
  });
  assert.match(tag, /engine=codex/);
  assert.match(tag, /review-engine=claude/);
});

test("executionReceiptPidFields: preserves opposite-engine worker locator", () => {
  const codexWorker = { engine: "codex" as const, model: "gpt-5.5", effort: "xhigh", exitCode: 0, logPath: "/tmp/worker.jsonl" };
  const claudeReview = { engine: "claude" as const, model: "opus", effort: "max", exitCode: 0, sessionId: "review-session" };
  assert.deepEqual(executionReceiptPidFields(codexWorker, claudeReview), {
    workerSessionId: undefined,
    workerLogPath: "/tmp/worker.jsonl",
    reviewSessionId: "review-session",
    reviewLogPath: undefined,
  });

  const claudeWorker = { ...claudeReview, sessionId: "worker-session" };
  const codexReview = { ...codexWorker, logPath: "/tmp/review.jsonl" };
  assert.deepEqual(executionReceiptPidFields(claudeWorker, codexReview), {
    workerSessionId: "worker-session",
    workerLogPath: undefined,
    reviewSessionId: undefined,
    reviewLogPath: "/tmp/review.jsonl",
  });
});

test("engine adapters: all four phase pairings select the correct commands", () => {
  const { opts, cleanup } = makeCodexArgsFixture();
  try {
    for (const workerEngine of ["claude", "codex"] as const) {
      for (const reviewEngine of ["claude", "codex"] as const) {
        opts.plan = {
          worker: { engine: workerEngine, model: workerEngine === "codex" ? "gpt-5.5" : "opus", effort: workerEngine === "codex" ? "xhigh" : "max" },
          review: { engine: reviewEngine, model: reviewEngine === "codex" ? "gpt-5.5" : "opus", effort: reviewEngine === "codex" ? "xhigh" : "max" },
        };
        assert.equal(buildWorkerInvocation(opts, "dangeresque-pairing", "/tmp/run.md").command, workerEngine);
        assert.equal(buildReviewInvocation(opts, "dangeresque-pairing", "/tmp/run.md").command, reviewEngine);
      }
    }
  } finally {
    cleanup();
  }
});
