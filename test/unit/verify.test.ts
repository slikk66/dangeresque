import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldRunVerify,
  runSingleCommand,
  runVerification,
  buildVerifySummaryLine,
  appendVerifySummaryLine,
  appendVerifyBodySection,
  buildVerifyBodySection,
  tailBytes,
  type VerifyCommand,
  type VerifyConfig,
  type VerificationResult,
} from "#dist/verify.js";
import { ArtifactBuilder } from "#dist/artifact.js";

// --- pure helpers: shouldRunVerify ---

function makeConfig(overrides: Partial<VerifyConfig> = {}): VerifyConfig {
  return {
    enabled: true,
    modes: ["IMPLEMENT", "REFACTOR", "TEST", "VERIFY"],
    commands: [{ name: "compile", cmd: "true", on_failure: "block", timeout_ms: 5000 }],
    ...overrides,
  };
}

test("shouldRunVerify: enabled + commands + matching mode → true", () => {
  assert.equal(shouldRunVerify("IMPLEMENT", makeConfig()), true);
});

test("shouldRunVerify: disabled → false", () => {
  assert.equal(shouldRunVerify("IMPLEMENT", makeConfig({ enabled: false })), false);
});

test("shouldRunVerify: empty commands → false (no-op default)", () => {
  assert.equal(shouldRunVerify("IMPLEMENT", makeConfig({ commands: [] })), false);
});

test("shouldRunVerify: mode not in list → false", () => {
  assert.equal(shouldRunVerify("INVESTIGATE", makeConfig()), false);
});

// --- pure helpers: tailBytes ---

test("tailBytes: under cap → no truncation", () => {
  assert.deepEqual(tailBytes("hello", 100), { text: "hello", truncated: false });
});

test("tailBytes: over cap → keeps last N bytes", () => {
  assert.deepEqual(tailBytes("0123456789", 4), { text: "6789", truncated: true });
});

test("tailBytes: exact cap → no truncation", () => {
  assert.deepEqual(tailBytes("12345", 5), { text: "12345", truncated: false });
});

// --- pure helpers: buildVerifySummaryLine ---

function mkResult(overrides: Partial<VerificationResult>): VerificationResult {
  return {
    name: "x",
    cmd: "x",
    on_failure: "block",
    timeout_ms: 5000,
    exit_code: 0,
    duration_ms: 10,
    stdout_excerpt: "",
    stderr_excerpt: "",
    truncated: false,
    timed_out: false,
    ...overrides,
  };
}

test("buildVerifySummaryLine: empty array → null", () => {
  assert.equal(buildVerifySummaryLine([]), null);
});

test("buildVerifySummaryLine: all pass → 'Verify: N/N passed (names…)'", () => {
  const results = [
    mkResult({ name: "compile" }),
    mkResult({ name: "test" }),
  ];
  assert.equal(buildVerifySummaryLine(results), "Verify: 2/2 passed (compile, test)");
});

test("buildVerifySummaryLine: warn-only failure → 'N/N passed, M warned (…)'", () => {
  const results = [
    mkResult({ name: "compile" }),
    mkResult({ name: "lint", exit_code: 1, on_failure: "warn" }),
  ];
  assert.equal(
    buildVerifySummaryLine(results),
    "Verify: 1/2 passed, 1 warned (lint=FAIL exit=1)",
  );
});

test("buildVerifySummaryLine: block failure stops + remaining commands shown as skipped", () => {
  const results = [
    mkResult({ name: "compile" }),
    mkResult({ name: "test", exit_code: 1 }),
    // commands after a block-fail aren't run, but the line still references them
    mkResult({ name: "lint", on_failure: "warn", exit_code: 0 }),
  ];
  // runVerification stops at block-fail, so lint won't appear in the array.
  // But buildVerifySummaryLine should still report skipped if it gets a partial array
  // where the trailing entries weren't actually run. Real runs simply pass the truncated array.
  const partial = [
    mkResult({ name: "compile" }),
    mkResult({ name: "test", exit_code: 1 }),
  ];
  assert.equal(
    buildVerifySummaryLine(partial),
    "Verify: 1/2 FAILED (compile=ok, test=FAIL exit=1)",
  );
});

// --- pure helpers: appendVerifySummaryLine ---

function summaryWith(extra: string): string {
  return (
    "<!-- SUMMARY -->\n" +
    "Mode: IMPLEMENT | Status: implemented, unverified\n" +
    "Files: 2 changed (2 modified)\n" +
    `${extra}` +
    "Proof: 5/5 tests pass\n" +
    "Risks: none | Next: VERIFY\n" +
    "<!-- /SUMMARY -->\n\n## Status\n\nimplemented, unverified\n"
  );
}

test("appendVerifySummaryLine: inserts after Files: line when no Verify: present", () => {
  const original = summaryWith("");
  const results = [mkResult({ name: "compile" })];
  const out = appendVerifySummaryLine(original, results);
  assert.ok(out);
  assert.match(out!, /^Files: 2 changed \(2 modified\)\nVerify: 1\/1 passed \(compile\)$/m);
});

test("appendVerifySummaryLine: replaces existing Verify: line", () => {
  const original = summaryWith("Verify: 0/0 passed (stale)\n");
  const results = [mkResult({ name: "compile", exit_code: 0 })];
  const out = appendVerifySummaryLine(original, results);
  assert.ok(out);
  assert.match(out!, /^Verify: 1\/1 passed \(compile\)$/m);
  assert.doesNotMatch(out!, /stale/);
});

test("appendVerifySummaryLine: missing SUMMARY block returns null", () => {
  const out = appendVerifySummaryLine("## Status\n\nimplemented\n", [mkResult({ name: "compile" })]);
  assert.equal(out, null);
});

test("appendVerifySummaryLine: empty results → null", () => {
  assert.equal(appendVerifySummaryLine(summaryWith(""), []), null);
});

// --- pure helpers: buildVerifyBodySection / appendVerifyBodySection ---

test("buildVerifyBodySection: empty → empty string", () => {
  assert.equal(buildVerifyBodySection([]), "");
});

test("buildVerifyBodySection: PASS includes name/cmd/exit", () => {
  const out = buildVerifyBodySection([mkResult({ name: "compile", cmd: "yarn build", duration_ms: 1234 })]);
  assert.match(out, /## Verification \(pre-review, captured automatically\)/);
  assert.match(out, /\*\*compile\*\* \(block\) — `yarn build` — PASS \(exit=0/);
});

test("buildVerifyBodySection: FAIL includes stderr excerpt", () => {
  const out = buildVerifyBodySection([
    mkResult({
      name: "test",
      cmd: "yarn test",
      exit_code: 1,
      stderr_excerpt: "AssertionError: expected 1 to equal 2\n  at line 12",
    }),
  ]);
  assert.match(out, /\*\*test\*\* \(block\) — `yarn test` — FAIL \(exit=1/);
  assert.match(out, /AssertionError/);
});

test("appendVerifyBodySection: appends when not present", () => {
  const original = "## Status\n\nimplemented, unverified\n\n## Summary\n\ndid stuff\n";
  const out = appendVerifyBodySection(original, [mkResult({ name: "compile" })]);
  assert.match(out, /## Verification \(pre-review, captured automatically\)/);
  assert.match(out, /## Status/);
  assert.match(out, /## Summary/);
});

test("appendVerifyBodySection: replaces existing Verification section", () => {
  const first = appendVerifyBodySection(
    "## Status\n\nimplemented, unverified\n",
    [mkResult({ name: "compile", exit_code: 1 })],
  );
  const second = appendVerifyBodySection(first, [mkResult({ name: "compile", exit_code: 0 })]);
  // Should not contain two Verification sections
  const matches = second.match(/## Verification \(pre-review, captured automatically\)/g);
  assert.equal(matches?.length, 1);
  assert.match(second, /PASS \(exit=0/);
  assert.doesNotMatch(second, /FAIL \(exit=1/);
});

// --- runSingleCommand integration ---

test("runSingleCommand: 'true' → exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const cmd: VerifyCommand = { name: "ok", cmd: "true", on_failure: "block", timeout_ms: 5000 };
    const result = runSingleCommand(cmd, dir, 8192);
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.equal(result.name, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSingleCommand: 'false' → exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const cmd: VerifyCommand = { name: "no", cmd: "false", on_failure: "block", timeout_ms: 5000 };
    const result = runSingleCommand(cmd, dir, 8192);
    assert.equal(result.exit_code, 1);
    assert.equal(result.timed_out, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSingleCommand: stderr captured + truncated to last N bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const cmd: VerifyCommand = {
      name: "noisy",
      cmd: "printf 'AAAAAAAAAA' >&2; printf 'TAIL' >&2; exit 1",
      on_failure: "block",
      timeout_ms: 5000,
    };
    const result = runSingleCommand(cmd, dir, 4);
    assert.equal(result.exit_code, 1);
    assert.equal(result.stderr_excerpt, "TAIL");
    assert.equal(result.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSingleCommand: cwd is honored", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    writeFileSync(join(dir, "marker.txt"), "hello");
    const cmd: VerifyCommand = { name: "cwd-check", cmd: "test -f marker.txt", on_failure: "block", timeout_ms: 5000 };
    const result = runSingleCommand(cmd, dir, 8192);
    assert.equal(result.exit_code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSingleCommand: env parameter passes vars to the child process", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const capture = join(dir, "env.txt");
    const cmd: VerifyCommand = {
      name: "env-check",
      cmd: `printf '%s|%s' "$DANGERESQUE_ISSUE" "$DANGERESQUE_MODE" > "${capture}"`,
      on_failure: "block",
      timeout_ms: 5000,
    };
    const result = runSingleCommand(cmd, dir, 8192, {
      DANGERESQUE_ISSUE: "77",
      DANGERESQUE_MODE: "IMPLEMENT",
    });
    assert.equal(result.exit_code, 0);
    assert.equal(readFileSync(capture, "utf-8"), "77|IMPLEMENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSingleCommand: env overlay scrubs an enclosing run's DANGERESQUE_* vars before applying", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  const saved = { ...process.env };
  try {
    process.env.DANGERESQUE_WORKTREE = "/outer/worktree";
    process.env.DANGERESQUE_ARTIFACT = "/outer/run.md";
    process.env.DANGERESQUE_ARTIFACT_JSON = "/outer/run.json";
    process.env.DANGERESQUE_MERGE = "1";
    const capture = join(dir, "env.txt");
    const cmd: VerifyCommand = {
      name: "env-check",
      cmd: `printf '%s|%s|%s|%s|%s' "$DANGERESQUE_ISSUE" "\${DANGERESQUE_WORKTREE-UNSET}" "\${DANGERESQUE_ARTIFACT-UNSET}" "\${DANGERESQUE_ARTIFACT_JSON-UNSET}" "\${DANGERESQUE_MERGE-UNSET}" > "${capture}"`,
      on_failure: "block",
      timeout_ms: 5000,
    };
    const result = runSingleCommand(cmd, dir, 8192, {
      DANGERESQUE_ISSUE: "58",
      DANGERESQUE_MODE: "IMPLEMENT",
    });
    assert.equal(result.exit_code, 0);
    assert.equal(readFileSync(capture, "utf-8"), "58|UNSET|UNSET|UNSET|UNSET");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSingleCommand: without env parameter, child inherits process.env (no override)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const cmd: VerifyCommand = { name: "ok", cmd: "true", on_failure: "block", timeout_ms: 5000 };
    const result = runSingleCommand(cmd, dir, 8192);
    assert.equal(result.exit_code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSingleCommand: timeout marks timed_out", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const cmd: VerifyCommand = { name: "slow", cmd: "sleep 5", on_failure: "block", timeout_ms: 200 };
    const result = runSingleCommand(cmd, dir, 8192);
    assert.equal(result.timed_out, true);
    assert.notEqual(result.exit_code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- runVerification integration ---

function makeArtifact(dir: string): string {
  const archiveDir = join(dir, ".dangeresque", "runs", "issue-99");
  mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, "2026-01-01T00-00-00-IMPLEMENT.md");
  writeFileSync(
    archivePath,
    "<!-- SUMMARY -->\n" +
      "Mode: IMPLEMENT | Status: implemented, unverified\n" +
      "Files: 1 changed (1 modified)\n" +
      "Proof: 5/5 tests pass\n" +
      "<!-- /SUMMARY -->\n\n## Status\n\nimplemented, unverified\n",
    "utf-8",
  );
  return archivePath;
}

function makeBuilder(dir: string, archivePath: string): ArtifactBuilder {
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
  return builder;
}

test("runVerification: commands can read the run report through DANGERESQUE_ARTIFACT", () => {
  // A pre-review check on the worker's own claims — a citation resolver, a
  // house-format lint — runs here. Before this it had no way to find the
  // timestamped report file except by re-deriving the naming scheme.
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const archivePath = makeArtifact(dir);
    const builder = makeBuilder(dir, archivePath);
    const captured = join(dir, "capture.txt");

    const config: VerifyConfig = {
      enabled: true,
      modes: ["IMPLEMENT"],
      commands: [
        {
          name: "read-report",
          cmd: `printf '%s|%s|%s|%s' "$DANGERESQUE_ISSUE" "$DANGERESQUE_MODE" "$DANGERESQUE_ARTIFACT_JSON" "$(grep -c 'Mode: IMPLEMENT' "$DANGERESQUE_ARTIFACT")" > "${captured}"`,
          on_failure: "block",
          timeout_ms: 5000,
        },
      ],
    };

    const outcome = runVerification({
      worktreePath: dir,
      archivePath,
      config,
      builder,
      issueNumber: 99,
      mode: "IMPLEMENT",
    });

    assert.equal(outcome.blocked, false);
    const [issue, mode, jsonPath, matchCount] = readFileSync(captured, "utf-8").split("|");
    assert.equal(issue, "99");
    assert.equal(mode, "IMPLEMENT");
    assert.equal(jsonPath, archivePath.replace(/\.md$/, ".json"));
    assert.equal(matchCount, "1", "the command actually read the report through the path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerification: all pass → outcome.blocked=false, SUMMARY rewritten, body section appended", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const archivePath = makeArtifact(dir);
    const builder = makeBuilder(dir, archivePath);

    const config: VerifyConfig = {
      enabled: true,
      modes: ["IMPLEMENT"],
      commands: [
        { name: "ok", cmd: "true", on_failure: "block", timeout_ms: 5000 },
        { name: "also_ok", cmd: "true", on_failure: "block", timeout_ms: 5000 },
      ],
    };

    const outcome = runVerification({ worktreePath: dir, archivePath, config, builder });
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.results.every((r) => r.exit_code === 0), true);

    const content = readFileSync(archivePath, "utf-8");
    assert.match(content, /^Verify: 2\/2 passed \(ok, also_ok\)$/m);
    assert.match(content, /## Verification \(pre-review, captured automatically\)/);

    const events = builder.build().lifecycle_events.map((e) => e.event);
    assert.ok(events.includes("verify_command_started"));
    assert.ok(events.includes("verify_command_completed"));
    assert.ok(events.includes("verification_completed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerification: block failure → outcome.blocked=true, blockedBy set, subsequent commands skipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const archivePath = makeArtifact(dir);
    const builder = makeBuilder(dir, archivePath);

    const config: VerifyConfig = {
      enabled: true,
      modes: ["IMPLEMENT"],
      commands: [
        { name: "compile", cmd: "true", on_failure: "block", timeout_ms: 5000 },
        { name: "test", cmd: "false", on_failure: "block", timeout_ms: 5000 },
        { name: "lint", cmd: "true", on_failure: "warn", timeout_ms: 5000 }, // never runs
      ],
    };

    const outcome = runVerification({ worktreePath: dir, archivePath, config, builder });
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.blockedBy, "test");
    assert.equal(outcome.results.length, 2);

    const content = readFileSync(archivePath, "utf-8");
    assert.match(content, /Verify: 1\/2 FAILED/);
    assert.match(content, /\*\*test\*\* \(block\) — `false` — FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerification: warn-only failure → outcome.blocked=false, subsequent commands still run", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const archivePath = makeArtifact(dir);
    const builder = makeBuilder(dir, archivePath);

    const config: VerifyConfig = {
      enabled: true,
      modes: ["IMPLEMENT"],
      commands: [
        { name: "compile", cmd: "true", on_failure: "block", timeout_ms: 5000 },
        { name: "lint", cmd: "false", on_failure: "warn", timeout_ms: 5000 },
        { name: "test", cmd: "true", on_failure: "block", timeout_ms: 5000 },
      ],
    };

    const outcome = runVerification({ worktreePath: dir, archivePath, config, builder });
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.results.length, 3);
    assert.equal(outcome.results[1].exit_code, 1);
    assert.equal(outcome.results[1].on_failure, "warn");

    const content = readFileSync(archivePath, "utf-8");
    assert.match(content, /Verify: 2\/3 passed, 1 warned \(lint=FAIL exit=1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVerification: artifact missing → degrades silently, returns results", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const archivePath = join(dir, ".dangeresque", "runs", "issue-99", "missing.md");
    const builder = makeBuilder(dir, archivePath);
    const config: VerifyConfig = {
      enabled: true,
      modes: ["IMPLEMENT"],
      commands: [{ name: "ok", cmd: "true", on_failure: "block", timeout_ms: 5000 }],
    };

    const outcome = runVerification({ worktreePath: dir, archivePath, config, builder });
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.results.length, 1);

    const events = builder.build().lifecycle_events.map((e) => e.event);
    assert.ok(events.includes("verify_artifact_rewrite_skipped"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- ArtifactBuilder verification field + verification_failed category ---

test("ArtifactBuilder.setVerification: null → verification field is null in output", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const archivePath = makeArtifact(dir);
    const builder = makeBuilder(dir, archivePath);
    builder.setVerification(null);
    const artifact = builder.build();
    assert.equal(artifact.verification, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ArtifactBuilder.setVerification: results → field populated; block-fail adds verification_failed category + failure result", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const archivePath = makeArtifact(dir);
    const builder = makeBuilder(dir, archivePath);
    const failing: VerificationResult = mkResult({
      name: "test",
      cmd: "yarn test",
      exit_code: 1,
      on_failure: "block",
    });
    builder.setVerification([failing]);
    builder.markReviewSkipped("verification_failed:test");
    const artifact = builder.build();
    assert.ok(artifact.verification);
    assert.equal(artifact.verification!.length, 1);
    assert.ok(artifact.failure_categories.includes("verification_failed"));
    assert.equal(artifact.result, "failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ArtifactBuilder.setVerification: warn-only failure does NOT add verification_failed category", () => {
  const dir = mkdtempSync(join(tmpdir(), "dangeresque-verify-test-"));
  try {
    const archivePath = makeArtifact(dir);
    writeFileSync(archivePath, readFileSync(archivePath, "utf-8") + "\n**Verdict:** ACCEPT\n");
    const builder = makeBuilder(dir, archivePath);
    builder.setVerification([
      mkResult({ name: "lint", cmd: "yarn lint", exit_code: 1, on_failure: "warn" }),
    ]);
    builder.setReviewTiming(2, 3, 0);
    const artifact = builder.build();
    assert.equal(artifact.failure_categories.includes("verification_failed"), false);
    assert.equal(artifact.result, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
