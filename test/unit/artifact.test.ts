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

test("parseVerdictFromMarkdown: a re-review's ACCEPT after a superseded REJECT wins", () => {
  // `review --force` appends a second ## Review section; the first verdict is history.
  const md = "## Review\n- **Verdict:** REJECT — foo\n\n## Review\n- **Verdict:** ACCEPT\n";
  assert.equal(parseVerdictFromMarkdown(md), "accept");
  const flipped = "## Review\n- **Verdict:** ACCEPT\n\n## Review\n- **Verdict:** REJECT — regressed\n";
  assert.equal(parseVerdictFromMarkdown(flipped), "reject");
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

test("parseVerdictFromMarkdown: bold verdict word (bc#624 receipt)", () => {
  assert.equal(
    parseVerdictFromMarkdown("- **Verdict:** **ACCEPT** — every gate passes"),
    "accept",
  );
});

test("parseVerdictFromMarkdown: plain unformatted label", () => {
  assert.equal(parseVerdictFromMarkdown("Verdict: REJECT"), "reject");
});

test("parseVerdictFromMarkdown: colon outside bold", () => {
  assert.equal(parseVerdictFromMarkdown("**Verdict**: ACCEPT"), "accept");
});

test("parseVerdictFromMarkdown: backticked verdict word", () => {
  assert.equal(parseVerdictFromMarkdown("**Verdict:** `NEEDS_HUMAN_REVIEW`"), "needs_human_review");
});

test("parseVerdictFromMarkdown: prose 'accept' without Verdict label → unknown", () => {
  assert.equal(
    parseVerdictFromMarkdown("the reviewer chose to accept the change"),
    "unknown",
  );
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

// --- resumed_from lineage (issue #110) ---

function resumeBuilderFixture(resumedFrom?: string) {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-resume-artifact-"));
  const archivePath = join(tmp, "2026-09-03T09-00-00-IMPLEMENT.md");
  writeFileSync(archivePath, "# Results\n");
  const builder = new ArtifactBuilder({
    projectRoot: tmp,
    issueNumber: 110,
    issueUrl: null,
    mode: "IMPLEMENT",
    engine: "claude",
    model: "m",
    worktreeName: "dangeresque-implement-110",
    branch: "worktree-dangeresque-implement-110",
    archivePath,
    ...(resumedFrom !== undefined ? { resumedFrom } : {}),
  });
  builder.setWorkerTiming(100, 200, 0);
  return { tmp, builder };
}

test("ArtifactBuilder: a resumed run records resumed_from", () => {
  const { tmp, builder } = resumeBuilderFixture("2026-09-03T04-00-00-IMPLEMENT.md");
  try {
    assert.equal(builder.build().resumed_from, "2026-09-03T04-00-00-IMPLEMENT.md");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: an ordinary run omits resumed_from entirely", () => {
  const { tmp, builder } = resumeBuilderFixture();
  try {
    const artifact = builder.build();
    assert.equal(artifact.resumed_from, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(artifact, "resumed_from"),
      false,
      "absent, not undefined — absence is what says 'this run resumed nothing'",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: a resumed run gets its OWN run_id, not the dead attempt's", () => {
  // A resume is a second billable engine attempt and must count as its own run
  // in stats. `resumed_from` is the lineage link. (A review rescue is the
  // opposite case: it preserves run_id because it continues the same attempt.)
  const a = resumeBuilderFixture("prior.md");
  const b = resumeBuilderFixture("prior.md");
  try {
    assert.notEqual(a.builder.build().run_id, b.builder.build().run_id);
  } finally {
    rmSync(a.tmp, { recursive: true, force: true });
    rmSync(b.tmp, { recursive: true, force: true });
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
      reviewEngine: "codex",
      reviewModel: "gpt-5.5",
      reviewEffort: "xhigh",
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
    assert.equal(artifact.review_engine, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: scope outside + reviewer accept → success (scope is telemetry)", () => {
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
      reviewEngine: "codex",
      reviewModel: "gpt-5.5",
      reviewEffort: "xhigh",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    });
    builder.setWorkerTiming(100, 200, 0);
    builder.setReviewTiming(200, 300, 0);
    builder.setScopeReport({
      in_scope: [],
      extended: [],
      outside: ["unrelated.ts"],
      declaration_status: "parsed",
    });
    const artifact = builder.build();
    assert.equal(artifact.result, "success");
    assert.equal(artifact.review_engine, "codex");
    assert.equal(artifact.review_model, "gpt-5.5");
    assert.ok(!artifact.failure_categories.includes("scope_outside"));
    assert.deepEqual(artifact.failure_categories, []);
    assert.deepEqual(artifact.scope_report?.outside, ["unrelated.ts"]);
    assert.equal(
      (artifact as unknown as Record<string, unknown>).scope_violations,
      undefined,
      "scope_violations field must be absent on v6 artifacts",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: scope outside + review skipped → partial_success + scope_outside", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "# INVESTIGATE\n");
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
    builder.markReviewSkipped("no-review flag");
    builder.setScopeReport({
      in_scope: [],
      extended: [],
      outside: ["unrelated.ts"],
      declaration_status: "parsed",
    });
    const artifact = builder.build();
    assert.equal(artifact.result, "partial_success");
    assert.deepEqual(artifact.failure_categories, ["scope_outside"]);
    assert.deepEqual(artifact.scope_report?.outside, ["unrelated.ts"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: review skipped + no scope outside → success", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "# INVESTIGATE\n");
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
    builder.markReviewSkipped("no-review flag");
    const artifact = builder.build();
    assert.equal(artifact.result, "success");
    assert.deepEqual(artifact.failure_categories, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- issue #93: work the branch does not carry ---

function acceptedImplementBuilder(tmp: string): ArtifactBuilder {
  const archivePath = join(tmp, "run.md");
  writeFileSync(archivePath, "**Verdict:** ACCEPT\n");
  const builder = new ArtifactBuilder({
    projectRoot: tmp,
    issueNumber: 93,
    issueUrl: null,
    mode: "IMPLEMENT",
    engine: "claude",
    model: "m",
    worktreeName: "wt",
    branch: "worktree-dangeresque-implement-93",
    archivePath,
  });
  builder.setWorkerTiming(100, 200, 0);
  builder.setReviewTiming(200, 300, 0);
  return builder;
}

test("ArtifactBuilder: accepted run with a dirty worktree → partial_success + uncommitted_worker_changes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const builder = acceptedImplementBuilder(tmp);
    builder.recordEvent("worktree_dirty_after_capture", { count: 3 });
    const artifact = builder.build();

    assert.equal(artifact.reviewer_verdict, "accept");
    // The bc#530 shape: reviewer accepted a diff that lives in no commit.
    assert.notEqual(artifact.result, "success");
    assert.equal(artifact.result, "partial_success");
    assert.ok(artifact.failure_categories.includes("uncommitted_worker_changes"));
    assert.ok(!artifact.failure_categories.includes("rebase_conflict"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: capture failure → uncommitted_worker_changes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const builder = acceptedImplementBuilder(tmp);
    builder.recordEvent("worker_changes_capture_failed", { error: "index.lock" });
    const artifact = builder.build();

    assert.equal(artifact.result, "partial_success");
    assert.ok(artifact.failure_categories.includes("uncommitted_worker_changes"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: capture that committed cleanly leaves the run a plain success", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const builder = acceptedImplementBuilder(tmp);
    builder.recordEvent("worker_changes_captured", { files_changed: 4, engine: "claude" });
    builder.recordEvent("rebase_completed");
    const artifact = builder.build();

    assert.equal(artifact.result, "success");
    assert.deepEqual(artifact.failure_categories, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: rebase git refused to run (conflict:false) is NOT a rebase_conflict", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const builder = acceptedImplementBuilder(tmp);
    builder.recordEvent("rebase_failed", { conflict: false, error: "cannot rebase" });
    const artifact = builder.build();

    assert.ok(!artifact.failure_categories.includes("rebase_conflict"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: real rebase conflict → rebase_conflict, and bare legacy events still map", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const builder = acceptedImplementBuilder(tmp);
    builder.recordEvent("rebase_failed", { conflict: true, error: "CONFLICT (content)" });
    assert.ok(builder.build().failure_categories.includes("rebase_conflict"));

    const legacy = acceptedImplementBuilder(tmp);
    legacy.recordEvent("rebase_failed");
    assert.ok(legacy.build().failure_categories.includes("rebase_conflict"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: rebase skipped over a dirty tree is never a rebase_conflict", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const builder = acceptedImplementBuilder(tmp);
    builder.recordEvent("rebase_skipped", { reason: "dirty_worktree", uncommitted: 2 });
    const artifact = builder.build();

    assert.ok(!artifact.failure_categories.includes("rebase_conflict"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: reviewer reject → failure + reviewer_rejected (scope irrelevant)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "**Verdict:** REJECT\n");
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
    builder.setScopeReport({
      in_scope: [],
      extended: [],
      outside: ["unrelated.ts"],
      declaration_status: "parsed",
    });
    const artifact = builder.build();
    assert.equal(artifact.result, "failure");
    assert.ok(artifact.failure_categories.includes("reviewer_rejected"));
    assert.ok(!artifact.failure_categories.includes("scope_outside"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: reviewer needs_human_review → partial_success (no scope_outside)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "**Verdict:** NEEDS HUMAN REVIEW\n");
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
    builder.setScopeReport({
      in_scope: [],
      extended: [],
      outside: ["unrelated.ts"],
      declaration_status: "parsed",
    });
    const artifact = builder.build();
    assert.equal(artifact.result, "partial_success");
    assert.equal(artifact.reviewer_verdict, "needs_human_review");
    assert.ok(!artifact.failure_categories.includes("scope_outside"));
    assert.deepEqual(artifact.failure_categories, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: reviewer verdict unknown (no verdict line) → partial_success (no scope_outside)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "# Review\nNo verdict line here.\n");
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
    builder.setScopeReport({
      in_scope: [],
      extended: [],
      outside: ["unrelated.ts"],
      declaration_status: "parsed",
    });
    const artifact = builder.build();
    assert.equal(artifact.result, "partial_success");
    assert.equal(artifact.reviewer_verdict, "unknown");
    assert.ok(!artifact.failure_categories.includes("scope_outside"));
    assert.deepEqual(artifact.failure_categories, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: review nonzero exit → partial_success + review_nonzero_exit (scope irrelevant)", () => {
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
    builder.setReviewTiming(200, 300, 1);
    builder.setScopeReport({
      in_scope: [],
      extended: [],
      outside: ["unrelated.ts"],
      declaration_status: "parsed",
    });
    const artifact = builder.build();
    assert.equal(artifact.result, "partial_success");
    assert.ok(artifact.failure_categories.includes("review_nonzero_exit"));
    assert.ok(!artifact.failure_categories.includes("scope_outside"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: reviewer accept + no scope → success", () => {
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
    const artifact = builder.build();
    assert.equal(artifact.result, "success");
    assert.deepEqual(artifact.failure_categories, []);
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
  const captured: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  let artifact;
  try {
    artifact = builder.build();
  } finally {
    console.warn = origWarn;
  }
  assert.equal(artifact.schema_version, ARTIFACT_SCHEMA_VERSION);
  assert.match(artifact.run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const events = artifact.lifecycle_events.map((e) => e.event);
  assert.ok(events.includes("run_started"));
  assert.ok(events.includes("run_completed"));
});

// --- Scope Declaration warn-only emission (Phase 2) ---

function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = origWarn;
  }
}

for (const mode of ["IMPLEMENT", "REFACTOR", "TEST"] as const) {
  test(`ArtifactBuilder: missing scope_declaration warns for ${mode} (warn-only, run still classifies)`, () => {
    const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
    try {
      const archivePath = join(tmp, "run.md");
      writeFileSync(archivePath, "**Verdict:** ACCEPT\n");
      const builder = new ArtifactBuilder({
        projectRoot: tmp,
        issueNumber: 1,
        issueUrl: null,
        mode,
        engine: "claude",
        model: "m",
        worktreeName: "wt",
        branch: "br",
        archivePath,
      });
      builder.setWorkerTiming(100, 200, 0);
      builder.setReviewTiming(200, 300, 0);
      const { result: artifact, warnings } = captureWarn(() => builder.build());
      assert.equal(warnings.length, 1, "expected exactly one warn");
      assert.match(warnings[0], /Scope Declaration/);
      assert.match(warnings[0], new RegExp(`mode=${mode}`));
      assert.equal(artifact.result, "success");
      assert.deepEqual(artifact.failure_categories, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("ArtifactBuilder: empty scope_declaration array warns for IMPLEMENT", () => {
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
    builder.setScopeDeclaration([]);
    const { warnings } = captureWarn(() => builder.build());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Scope Declaration/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

for (const mode of ["INVESTIGATE", "VERIFY"] as const) {
  test(`ArtifactBuilder: missing scope_declaration does NOT warn for ${mode}`, () => {
    const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
    try {
      const archivePath = join(tmp, "run.md");
      writeFileSync(archivePath, "# run\n");
      const builder = new ArtifactBuilder({
        projectRoot: tmp,
        issueNumber: 1,
        issueUrl: null,
        mode,
        engine: "claude",
        model: "m",
        worktreeName: "wt",
        branch: "br",
        archivePath,
      });
      builder.setWorkerTiming(100, 200, 0);
      builder.markReviewSkipped("no-review for non-code modes");
      const { warnings } = captureWarn(() => builder.build());
      assert.equal(warnings.length, 0, "expected no warn for non-code-changing mode");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("ArtifactBuilder: populated scope_declaration suppresses warn for IMPLEMENT", () => {
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
    builder.setScopeDeclaration([
      { path: "src/foo.ts", category: "declared", rationale: "primary change" },
    ]);
    const { result: artifact, warnings } = captureWarn(() => builder.build());
    assert.equal(warnings.length, 0, "expected no warn when declaration present");
    assert.deepEqual(artifact.scope_declaration, [
      { path: "src/foo.ts", category: "declared", rationale: "primary change" },
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: a review rescue preserves the original run's identity and history", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "# Results\n**Verdict:** ACCEPT\n");
    const builder = new ArtifactBuilder({
      projectRoot: tmp,
      issueNumber: 679,
      issueUrl: null,
      mode: "IMPLEMENT",
      engine: "claude",
      model: "claude-opus-5",
      worktreeName: "dangeresque-implement-679",
      branch: "worktree-dangeresque-implement-679",
      archivePath,
      runId: "original-run-id",
      seedEvents: [
        { ts: "2026-08-05T06:01:25.000Z", event: "run_started" },
        { ts: "2026-08-05T06:40:02.000Z", event: "worker_completed" },
      ],
    });
    builder.setWorkerTiming(100, 200, 0);
    builder.setReviewTiming(300, 400, 0);
    const artifact = builder.build();

    assert.equal(
      artifact.run_id,
      "original-run-id",
      "a rescued review continues the same run rather than appearing as a second one",
    );
    const events = artifact.lifecycle_events.map((e) => e.event);
    assert.equal(events[0], "run_started");
    assert.equal(events[1], "worker_completed");
    assert.ok(
      events.indexOf("worker_completed") < events.lastIndexOf("run_started"),
      "carried-over events precede the rescue's own run_started",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ArtifactBuilder: without runId each build is a distinct run", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  try {
    const archivePath = join(tmp, "run.md");
    writeFileSync(archivePath, "# Results\n");
    const init = {
      projectRoot: tmp,
      issueNumber: 1,
      issueUrl: null,
      mode: "IMPLEMENT" as const,
      engine: "claude" as const,
      model: "m",
      worktreeName: "wt",
      branch: "br",
      archivePath,
    };
    const first = new ArtifactBuilder(init).build();
    const second = new ArtifactBuilder(init).build();
    assert.notEqual(first.run_id, second.run_id);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
