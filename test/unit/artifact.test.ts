import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVerdictFromMarkdown,
  parseGitRemoteSlug,
  ArtifactBuilder,
  ARTIFACT_SCHEMA_VERSION,
} from "#dist/artifact.js";

test("parseVerdictFromMarkdown: ACCEPT", () => {
  assert.equal(parseVerdictFromMarkdown("prelude\n**Verdict:** ACCEPT\ntrailer"), "accept");
});

test("parseVerdictFromMarkdown: REJECT", () => {
  assert.equal(parseVerdictFromMarkdown("**Verdict:** REJECT"), "reject");
});

test("parseVerdictFromMarkdown: NEEDS_HUMAN_REVIEW with underscores", () => {
  assert.equal(
    parseVerdictFromMarkdown("**Verdict:** NEEDS_HUMAN_REVIEW"),
    "needs_human_review",
  );
});

test("parseVerdictFromMarkdown: NEEDS HUMAN REVIEW with spaces", () => {
  assert.equal(
    parseVerdictFromMarkdown("**Verdict:** NEEDS HUMAN REVIEW"),
    "needs_human_review",
  );
});

test("parseVerdictFromMarkdown: missing verdict line → unknown", () => {
  assert.equal(parseVerdictFromMarkdown("no verdict anywhere"), "unknown");
});

test("parseGitRemoteSlug: ssh remote", () => {
  assert.equal(parseGitRemoteSlug("git@github.com:acme/widgets.git"), "acme/widgets");
});

test("parseGitRemoteSlug: https remote with .git suffix", () => {
  assert.equal(parseGitRemoteSlug("https://github.com/acme/widgets.git"), "acme/widgets");
});

test("parseGitRemoteSlug: unrecognized format → null", () => {
  assert.equal(parseGitRemoteSlug("not-a-remote"), null);
});

test("ArtifactBuilder: missing archive → failure + no_run_artifact", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const builder = new ArtifactBuilder({
      projectRoot: tmp,
      issueNumber: 42,
      issueUrl: null,
      mode: "IMPLEMENT",
      engine: "claude",
      model: "claude-opus-4-7",
      worktreeName: "dangeresque-implement-42",
      branch: "worktree-dangeresque-implement-42",
      archivePath: join(tmp, "does-not-exist.md"),
    });
    builder.setWorkerTiming(1000, 2000, 0);
    const artifact = builder.build();
    assert.equal(artifact.result, "failure");
    assert.ok(artifact.failure_categories.includes("no_run_artifact"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: review skipped → verdict=skipped", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "# Results\n**Verdict:** ACCEPT\n");
    const builder = new ArtifactBuilder({
      projectRoot: tmp,
      issueNumber: 1,
      issueUrl: null,
      mode: "INVESTIGATE",
      engine: "claude",
      model: "m",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    });
    builder.setWorkerTiming(100, 200, 0);
    builder.markReviewSkipped("caller opted out");
    const artifact = builder.build();
    assert.equal(artifact.reviewer_verdict, "skipped");
    assert.equal(artifact.review?.skipped, true);
    assert.equal(artifact.review?.skip_reason, "caller opted out");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: scope violations → partial_success + scope_violation category", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "**Verdict:** ACCEPT\n");
    const builder = new ArtifactBuilder({
      projectRoot: tmp,
      issueNumber: 1,
      issueUrl: null,
      mode: "IMPLEMENT",
      engine: "claude",
      model: "m",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    });
    builder.setWorkerTiming(100, 200, 0);
    builder.setReviewTiming(200, 300, 0);
    builder.setScopeViolations(["unrelated.ts"]);
    const artifact = builder.build();
    assert.equal(artifact.result, "partial_success");
    assert.ok(artifact.failure_categories.includes("scope_violation"));
    assert.deepEqual(artifact.scope_violations, ["unrelated.ts"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: schema_version + run_id + lifecycle events populated", () => {
  const builder = new ArtifactBuilder({
    projectRoot: "/tmp",
    issueNumber: 1,
    issueUrl: null,
    mode: "TEST",
    engine: "claude",
    model: "m",
    worktreeName: "wt",
    branch: "br",
    archivePath: "/tmp/nope.md",
  });
  builder.setWorkerTiming(0, 1, 0);
  const artifact = builder.build();
  assert.equal(artifact.schema_version, ARTIFACT_SCHEMA_VERSION);
  assert.match(artifact.run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const events = artifact.lifecycle_events.map((e) => e.event);
  assert.ok(events.includes("run_started"));
  assert.ok(events.includes("run_completed"));
});
