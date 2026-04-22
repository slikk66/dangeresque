import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  gatherArtifacts,
  computeStats,
  formatStats,
} from "#dist/stats.js";
import { ARTIFACT_SCHEMA_VERSION, type RunArtifact } from "#dist/artifact.js";

function mkArtifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
  const base: RunArtifact = {
    schema_version: ARTIFACT_SCHEMA_VERSION,
    run_id: "00000000-0000-0000-0000-000000000000",
    issue_number: 42,
    issue_url: null,
    mode: "IMPLEMENT",
    engine: "claude",
    model: "claude-opus-4-7",
    effort: "max",
    worktree_name: "dangeresque-implement-42",
    branch: "worktree-dangeresque-implement-42",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:10:00.000Z",
    duration_ms: 600000,
    worker: {
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:05:00.000Z",
      duration_ms: 300000,
      exit_code: 0,
    },
    review: null,
    result: "success",
    reviewer_verdict: "accept",
    failure_categories: [],
    scope_violations: [],
    summary: "",
    artifact_paths: { md: "", json: "" },
    lifecycle_events: [],
  };
  return { ...base, ...overrides };
}

test("computeStats: empty input → zeroed counters", () => {
  const s = computeStats([]);
  assert.equal(s.total, 0);
  assert.deepEqual(s.byResult, { success: 0, partial_success: 0, failure: 0 });
  assert.deepEqual(s.byVerdict, {
    accept: 0,
    reject: 0,
    needs_human_review: 0,
    skipped: 0,
    unknown: 0,
  });
  assert.deepEqual(s.byEngine, { claude: 0, codex: 0 });
  assert.deepEqual(s.byMode, {});
  assert.equal(s.workerDurationsMs.median, 0);
  assert.equal(s.totalDurationsMs.p95, 0);
});

test("computeStats: aggregates results, verdicts, engines, modes, models, failures", () => {
  const artifacts: RunArtifact[] = [
    mkArtifact({ result: "success", reviewer_verdict: "accept", mode: "IMPLEMENT" }),
    mkArtifact({
      result: "partial_success",
      reviewer_verdict: "skipped",
      mode: "IMPLEMENT",
      failure_categories: ["scope_violation"],
    }),
    mkArtifact({
      result: "failure",
      reviewer_verdict: "reject",
      mode: "IMPLEMENT",
      engine: "codex",
      model: "gpt-5.4",
      failure_categories: ["reviewer_rejected"],
    }),
    mkArtifact({ result: "success", reviewer_verdict: "skipped", mode: "INVESTIGATE" }),
  ];
  const s = computeStats(artifacts);
  assert.equal(s.total, 4);
  assert.deepEqual(s.byResult, { success: 2, partial_success: 1, failure: 1 });
  assert.equal(s.byVerdict.accept, 1);
  assert.equal(s.byVerdict.reject, 1);
  assert.equal(s.byVerdict.skipped, 2);
  assert.equal(s.byEngine.claude, 3);
  assert.equal(s.byEngine.codex, 1);
  assert.deepEqual(s.byMode.IMPLEMENT, { total: 3, success: 1 });
  assert.deepEqual(s.byMode.INVESTIGATE, { total: 1, success: 1 });
  assert.equal(s.byModel["claude-opus-4-7"], 3);
  assert.equal(s.byModel["gpt-5.4"], 1);
  assert.equal(s.failureCategories.scope_violation, 1);
  assert.equal(s.failureCategories.reviewer_rejected, 1);
});

test("computeStats: median + p95 durations", () => {
  const artifacts = [100, 200, 300, 400, 500].map((ms) =>
    mkArtifact({
      duration_ms: ms,
      worker: {
        started_at: "",
        ended_at: "",
        duration_ms: ms * 2,
        exit_code: 0,
      },
    }),
  );
  const s = computeStats(artifacts);
  assert.equal(s.totalDurationsMs.median, 300);
  assert.equal(s.totalDurationsMs.p95, 500);
  assert.equal(s.workerDurationsMs.median, 600);
  assert.equal(s.workerDurationsMs.p95, 1000);
});

test("formatStats: output contains all required sections, no ANSI, fits 80 cols", () => {
  const s = computeStats([
    mkArtifact({ result: "success", reviewer_verdict: "accept" }),
  ]);
  const text = formatStats(s, {
    runsDir: "/tmp/runs",
    filters: {},
    schemaVersions: { "2": 1 },
    parseErrorCount: 0,
    unsupportedVersions: {},
    filesScanned: 1,
  });
  const sections = [
    "Run Evaluation Stats",
    "Summary",
    "Total artifacts:",
    "Schema versions:",
    "Filters:",
    "Skipped:",
    "Results:",
    "Reviewer verdicts:",
    "By engine:",
    "By mode (success rate):",
    "By model:",
    "Failure categories:",
    "Durations (ms):",
  ];
  for (const s of sections) {
    assert.ok(text.includes(s), `missing section: ${s}`);
  }
  assert.ok(
    text.indexOf("Summary\n-------") < text.indexOf("Results:"),
    "Summary must appear before Results",
  );
  assert.equal(/\[/.test(text), false, "must not contain ANSI escape (ESC sequence)");
  for (const line of text.split("\n")) {
    assert.ok(line.length <= 80, `line over 80 cols: "${line}" (${line.length})`);
  }
});

test("formatStats: Summary shows derived top-level facts first", () => {
  const s = computeStats([
    mkArtifact({
      result: "success",
      reviewer_verdict: "accept",
      failure_categories: [],
    }),
    mkArtifact({
      result: "success",
      reviewer_verdict: "needs_human_review",
      failure_categories: [],
    }),
    mkArtifact({
      result: "partial_success",
      reviewer_verdict: "skipped",
      failure_categories: ["scope_violation"],
    }),
    mkArtifact({
      result: "failure",
      reviewer_verdict: "reject",
      failure_categories: ["scope_violation", "reviewer_rejected"],
    }),
  ]);
  const text = formatStats(s, {
    runsDir: "/tmp/runs",
    filters: {},
    schemaVersions: { "2": 4 },
    parseErrorCount: 0,
    unsupportedVersions: {},
    filesScanned: 4,
  });
  const lines = text.split("\n");

  assert.deepEqual(lines.slice(0, 10), [
    "Run Evaluation Stats",
    "====================",
    "",
    "Summary",
    "-------",
    "Overall success:     50.0% (2/4)",
    "Hard failures:       1",
    "Review coverage:     75.0% (3/4) runs reviewed",
    "Reviewer verdicts:   1 accept, 1 reject, 1 needs_human_review",
    "Top failure category: scope_violation (2)",
  ]);
});

test("formatStats: Summary reports empty data without invented categories", () => {
  const text = formatStats(computeStats([]), {
    runsDir: "/tmp/runs",
    filters: {},
    schemaVersions: {},
    parseErrorCount: 0,
    unsupportedVersions: {},
    filesScanned: 0,
  });

  assert.match(text, /Overall success:\s+0\.0% \(0\/0\)/);
  assert.match(text, /Review coverage:\s+0\.0% \(0\/0\) runs reviewed/);
  assert.match(text, /Top failure category: \(none\)/);
});

test("formatStats: zero-match with filters emits Note line", () => {
  const s = computeStats([]);
  const text = formatStats(s, {
    runsDir: "/tmp/runs",
    filters: { issueNumber: 999 },
    schemaVersions: { "2": 10 },
    parseErrorCount: 0,
    unsupportedVersions: {},
    filesScanned: 10,
  });
  assert.match(text, /Note: no artifacts match filters \(--issue 999\)/);
  assert.ok(text.includes("By engine:"), "stable shape — sections still present");
});

test("formatStats: unsupported schema versions surfaced in Skipped line", () => {
  const s = computeStats([]);
  const text = formatStats(s, {
    runsDir: "/tmp/runs",
    filters: {},
    schemaVersions: { "9": 2, "2": 0 },
    parseErrorCount: 1,
    unsupportedVersions: { "9": 2 },
    filesScanned: 3,
  });
  assert.match(text, /Skipped: 1 parse error, 2 unsupported schema \(v9=2\)/);
});

test("gatherArtifacts: non-existent runs dir → dirExists=false, empty", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-stats-"));
  try {
    const r = gatherArtifacts(tmp);
    assert.equal(r.dirExists, false);
    assert.equal(r.artifacts.length, 0);
    assert.equal(r.filesScanned, 0);
    assert.ok(r.runsDir.endsWith(join(".dangeresque", "runs")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gatherArtifacts: parses valid json, skips bad, rejects unsupported versions", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-stats-"));
  try {
    const issueDir = join(tmp, ".dangeresque", "runs", "issue-7");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(
      join(issueDir, "a.json"),
      JSON.stringify(mkArtifact({ issue_number: 7 })),
    );
    writeFileSync(
      join(issueDir, "b.json"),
      JSON.stringify(mkArtifact({ issue_number: 7, schema_version: "99" })),
    );
    writeFileSync(join(issueDir, "c.json"), "{not json");
    // A stray non-issue directory should be ignored
    mkdirSync(join(tmp, ".dangeresque", "runs", "junk"), { recursive: true });
    writeFileSync(
      join(tmp, ".dangeresque", "runs", "junk", "x.json"),
      JSON.stringify(mkArtifact({ issue_number: 999 })),
    );
    const r = gatherArtifacts(tmp);
    assert.equal(r.dirExists, true);
    assert.equal(r.filesScanned, 3);
    assert.equal(r.artifacts.length, 1);
    assert.equal(r.parseErrorPaths.length, 1);
    assert.equal(r.unsupportedVersions["99"], 1);
    assert.equal(r.schemaVersions["2"], 1);
    assert.equal(r.schemaVersions["99"], 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gatherArtifacts: filters compose (issue + engine + mode)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-stats-"));
  try {
    const dir12 = join(tmp, ".dangeresque", "runs", "issue-12");
    mkdirSync(dir12, { recursive: true });
    writeFileSync(
      join(dir12, "a.json"),
      JSON.stringify(
        mkArtifact({ issue_number: 12, engine: "claude", mode: "IMPLEMENT" }),
      ),
    );
    writeFileSync(
      join(dir12, "b.json"),
      JSON.stringify(
        mkArtifact({ issue_number: 12, engine: "claude", mode: "INVESTIGATE" }),
      ),
    );
    writeFileSync(
      join(dir12, "c.json"),
      JSON.stringify(
        mkArtifact({ issue_number: 12, engine: "codex", mode: "IMPLEMENT" }),
      ),
    );
    const dir13 = join(tmp, ".dangeresque", "runs", "issue-13");
    mkdirSync(dir13, { recursive: true });
    writeFileSync(
      join(dir13, "d.json"),
      JSON.stringify(
        mkArtifact({ issue_number: 13, engine: "claude", mode: "IMPLEMENT" }),
      ),
    );
    const r = gatherArtifacts(tmp, {
      issueNumber: 12,
      engine: "claude",
      mode: "IMPLEMENT",
    });
    assert.equal(r.artifacts.length, 1);
    assert.equal(r.artifacts[0].issue_number, 12);
    assert.equal(r.artifacts[0].engine, "claude");
    assert.equal(r.artifacts[0].mode, "IMPLEMENT");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("formatStats: Summary reflects filtered artifact scope", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-stats-"));
  try {
    const dir12 = join(tmp, ".dangeresque", "runs", "issue-12");
    mkdirSync(dir12, { recursive: true });
    writeFileSync(
      join(dir12, "a.json"),
      JSON.stringify(
        mkArtifact({
          issue_number: 12,
          engine: "claude",
          mode: "IMPLEMENT",
          result: "success",
          reviewer_verdict: "accept",
        }),
      ),
    );
    writeFileSync(
      join(dir12, "b.json"),
      JSON.stringify(
        mkArtifact({
          issue_number: 12,
          engine: "codex",
          mode: "IMPLEMENT",
          result: "failure",
          reviewer_verdict: "reject",
          failure_categories: ["reviewer_rejected"],
        }),
      ),
    );
    const dir13 = join(tmp, ".dangeresque", "runs", "issue-13");
    mkdirSync(dir13, { recursive: true });
    writeFileSync(
      join(dir13, "c.json"),
      JSON.stringify(
        mkArtifact({
          issue_number: 13,
          engine: "claude",
          mode: "VERIFY",
          result: "partial_success",
          reviewer_verdict: "skipped",
          failure_categories: ["scope_violation"],
        }),
      ),
    );

    const gathered = gatherArtifacts(tmp, {
      issueNumber: 12,
      engine: "claude",
      mode: "IMPLEMENT",
    });
    const text = formatStats(computeStats(gathered.artifacts), {
      runsDir: gathered.runsDir,
      filters: { issueNumber: 12, engine: "claude", mode: "IMPLEMENT" },
      schemaVersions: gathered.schemaVersions,
      parseErrorCount: gathered.parseErrorPaths.length,
      unsupportedVersions: gathered.unsupportedVersions,
      filesScanned: gathered.filesScanned,
    });

    assert.match(text, /Filters: --issue 12 --engine claude --mode IMPLEMENT/);
    assert.match(text, /Total artifacts: 1/);
    assert.match(text, /Overall success:\s+100\.0% \(1\/1\)/);
    assert.match(text, /Hard failures:\s+0/);
    assert.match(text, /Reviewer verdicts:\s+1 accept, 0 reject, 0 needs_human_review/);
    assert.match(text, /Top failure category: \(none\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli stats: unknown flag → non-zero exit, message on stderr", () => {
  const cliPath = resolve("dist", "cli.js");
  try {
    execFileSync(process.execPath, [cliPath, "stats", "--foo"], {
      stdio: "pipe",
    });
    assert.fail("expected non-zero exit");
  } catch (err: any) {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /Unknown flag: --foo/);
  }
});

test("cli stats: --glossary prints evaluation vocabulary", () => {
  const cliPath = resolve("dist", "cli.js");
  const out = execFileSync(process.execPath, [cliPath, "stats", "--glossary"], {
    encoding: "utf-8",
  });
  assert.match(out, /Run Evaluation Glossary/);
  assert.match(out, /success/);
  assert.match(out, /partial_success/);
  assert.match(out, /failure/);
  assert.match(out, /scope_violation/);
  assert.match(out, /accept/);
  assert.match(out, /reject/);
  assert.match(out, /needs_human_review/);
  assert.match(out, /skipped/);
  assert.match(out, /unknown/);
  assert.match(out, /INVESTIGATE and VERIFY/);
  assert.match(out, /--no-review/);
});

test("cli stats: empty runs dir → 'No run artifacts found', exit 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-stats-"));
  try {
    const cliPath = resolve("dist", "cli.js");
    const out = execFileSync(process.execPath, [cliPath, "stats"], {
      cwd: tmp,
      encoding: "utf-8",
    });
    assert.match(out, /No run artifacts found at /);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cli stats: real repo prints non-zero counts and all sections", () => {
  const cliPath = resolve("dist", "cli.js");
  const out = execFileSync(process.execPath, [cliPath, "stats"], {
    encoding: "utf-8",
  });
  assert.match(out, /Run Evaluation Stats/);
  assert.match(out, /Results:/);
  assert.match(out, /Reviewer verdicts:/);
  assert.match(out, /By engine:/);
  assert.match(out, /By mode \(success rate\):/);
  assert.match(out, /By model:/);
  assert.match(out, /Failure categories:/);
  assert.match(out, /Durations \(ms\):/);
  const totalMatch = out.match(/Total artifacts: (\d+)/);
  assert.ok(totalMatch, "missing Total artifacts line");
  assert.ok(parseInt(totalMatch![1], 10) > 0, "expected non-zero artifact count");
  for (const line of out.split("\n")) {
    assert.ok(line.length <= 80, `line over 80 cols: "${line}" (${line.length})`);
  }
});

test("cli stats: --engine codex filter is accepted and renders all sections", () => {
  const cliPath = resolve("dist", "cli.js");
  const out = execFileSync(
    process.execPath,
    [cliPath, "stats", "--engine", "codex"],
    { encoding: "utf-8" },
  );
  assert.match(out, /Filters: --engine codex/);
  assert.match(out, /By engine:/);
  assert.match(out, /By mode \(success rate\):/);
});

test("cli stats: --issue + --mode compose and shrink the result set", () => {
  const cliPath = resolve("dist", "cli.js");
  const full = execFileSync(process.execPath, [cliPath, "stats"], {
    encoding: "utf-8",
  });
  const filtered = execFileSync(
    process.execPath,
    [cliPath, "stats", "--mode", "INVESTIGATE"],
    { encoding: "utf-8" },
  );
  assert.match(filtered, /Filters: --mode INVESTIGATE/);
  const fullTotal = parseInt(full.match(/Total artifacts: (\d+)/)![1], 10);
  const filtTotal = parseInt(filtered.match(/Total artifacts: (\d+)/)![1], 10);
  assert.ok(filtTotal > 0, "expected at least one INVESTIGATE artifact");
  assert.ok(filtTotal < fullTotal, "expected filtered total < unfiltered");
});

test("cli stats: --issue with no match shows zero-counter shape + note", () => {
  const cliPath = resolve("dist", "cli.js");
  const out = execFileSync(
    process.execPath,
    [cliPath, "stats", "--issue", "999999"],
    { encoding: "utf-8" },
  );
  assert.match(out, /Filters: --issue 999999/);
  assert.match(out, /Total artifacts: 0/);
  assert.match(out, /Note: no artifacts match filters \(--issue 999999\)/);
  assert.match(out, /By engine:/);
});

test("cli stats: --issue requires numeric value", () => {
  const cliPath = resolve("dist", "cli.js");
  try {
    execFileSync(process.execPath, [cliPath, "stats", "--issue", "abc"], {
      stdio: "pipe",
    });
    assert.fail("expected non-zero exit");
  } catch (err: any) {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /--issue requires a numeric issue number/);
  }
});

test("cli stats: --engine must be claude or codex", () => {
  const cliPath = resolve("dist", "cli.js");
  try {
    execFileSync(process.execPath, [cliPath, "stats", "--engine", "bogus"], {
      stdio: "pipe",
    });
    assert.fail("expected non-zero exit");
  } catch (err: any) {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /--engine must be one of: claude, codex/);
  }
});
