import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  locateLatestRun,
  assessReviewRescue,
  recoverWorkerPhase,
  parseArchiveTimestampMs,
  deriveIssueNumberFromWorktree,
  deriveModeFromWorktree,
  type LocatedRun,
} from "#dist/rescue.js";

const SUMMARY_MD =
  "<!-- SUMMARY -->\nMode: IMPLEMENT | Status: implemented\nFiles: 18 changed\n<!-- /SUMMARY -->\n\n## Observations\n";

function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), "dangeresque-rescue-"));
}

function writeRun(
  root: string,
  issueNumber: number,
  filename: string,
  md: string,
  json?: unknown,
): string {
  const dir = join(root, ".dangeresque", "runs", `issue-${issueNumber}`);
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, filename);
  writeFileSync(mdPath, md, "utf-8");
  if (json !== undefined) {
    writeFileSync(
      mdPath.replace(/\.md$/, ".json"),
      JSON.stringify(json, null, 2),
      "utf-8",
    );
  }
  return mdPath;
}

function located(mdPath: string, artifact: unknown = null): LocatedRun {
  return {
    mdPath,
    jsonPath: mdPath.replace(/\.md$/, ".json"),
    artifact: artifact as LocatedRun["artifact"],
  };
}

test("locateLatestRun: picks the newest artifact for the mode across multiple passes", () => {
  const root = scratchRoot();
  writeRun(root, 679, "2026-08-05T04-53-03-INVESTIGATE.md", SUMMARY_MD);
  writeRun(root, 679, "2026-08-05T05-00-00-IMPLEMENT.md", SUMMARY_MD);
  const newest = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);

  const result = locateLatestRun(root, 679, "IMPLEMENT");
  assert.equal(result?.mdPath, newest);
  assert.equal(result?.artifact, null, "no sibling JSON → artifact is null, not an error");
});

test("locateLatestRun: reads a surviving checkpoint JSON", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD, {
    run_id: "abc-123",
    worker: { exit_code: 0 },
  });

  const result = locateLatestRun(root, 679, "IMPLEMENT");
  assert.equal(result?.mdPath, mdPath);
  assert.equal(result?.artifact?.run_id, "abc-123");
});

test("locateLatestRun: unparseable JSON degrades to null rather than throwing", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);
  writeFileSync(mdPath.replace(/\.md$/, ".json"), "{ truncated", "utf-8");

  assert.equal(locateLatestRun(root, 679, "IMPLEMENT")?.artifact, null);
});

test("locateLatestRun: no artifact for the mode → null", () => {
  const root = scratchRoot();
  writeRun(root, 679, "2026-08-05T04-53-03-INVESTIGATE.md", SUMMARY_MD);
  assert.equal(locateLatestRun(root, 679, "IMPLEMENT"), null);
});

test("assessReviewRescue: the bc#679 shape — worker done, no JSON, no verdict → eligible", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath),
    workerRunning: false,
    force: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.existingVerdict, undefined);
});

test("assessReviewRescue: refuses while a process is still live in the worktree", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath),
    workerRunning: true,
    force: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /still running/);
});

test("assessReviewRescue: refuses a mode that never dispatches a review", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T04-53-03-INVESTIGATE.md", SUMMARY_MD);

  const result = assessReviewRescue({
    mode: "INVESTIGATE",
    located: located(mdPath),
    workerRunning: false,
    force: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /never dispatches a review/);
});

test("assessReviewRescue: refuses when no run artifact exists", () => {
  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: null,
    workerRunning: false,
    force: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /no IMPLEMENT run artifact/);
});

test("assessReviewRescue: refuses an artifact with no SUMMARY block (worker died mid-run)", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", "## Partial notes\n");

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath),
    workerRunning: false,
    force: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /never finished/);
});

test("assessReviewRescue: refuses when the checkpoint shows the worker itself failed", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath, { worker: { exit_code: 1 } }),
    workerRunning: false,
    force: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /worker phase failed/);
});

test("assessReviewRescue: refuses when a block-policy verification gate failed", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath, {
      worker: { exit_code: 0 },
      verification: [
        { name: "compile", on_failure: "block", exit_code: 0 },
        { name: "test", on_failure: "block", exit_code: 1 },
      ],
    }),
    workerRunning: false,
    force: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /"test" failed/);
});

test("assessReviewRescue: a warn-policy verification failure does not block a rescue", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath, {
      worker: { exit_code: 0 },
      verification: [{ name: "lint", on_failure: "warn", exit_code: 1 }],
    }),
    workerRunning: false,
    force: false,
  });
  assert.equal(result.ok, true);
});

test("assessReviewRescue: refuses a run that already has a verdict — this is not a re-review button", () => {
  const root = scratchRoot();
  const mdPath = writeRun(
    root,
    679,
    "2026-08-05T06-01-25-IMPLEMENT.md",
    SUMMARY_MD + "\n## Review\n\nVerdict: REJECT\n",
  );

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath),
    workerRunning: false,
    force: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.existingVerdict, "reject");
  assert.match(result.reason!, /already has a reviewer verdict/);
});

test("assessReviewRescue: --force overrides an existing verdict and reports what it overrode", () => {
  const root = scratchRoot();
  const mdPath = writeRun(
    root,
    679,
    "2026-08-05T06-01-25-IMPLEMENT.md",
    SUMMARY_MD + "\n## Review\n\nVerdict: **ACCEPT**\n",
  );

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath),
    workerRunning: false,
    force: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.existingVerdict, "accept");
});

test("assessReviewRescue: --force does NOT override a failed worker", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);

  const result = assessReviewRescue({
    mode: "IMPLEMENT",
    located: located(mdPath, { worker: { exit_code: 137 } }),
    workerRunning: false,
    force: true,
  });
  assert.equal(result.ok, false, "--force is scoped to the verdict refusal only");
});

test("parseArchiveTimestampMs: decodes the run-start time from the artifact filename", () => {
  assert.equal(
    parseArchiveTimestampMs("/x/2026-08-05T06-01-25-IMPLEMENT.md"),
    Date.parse("2026-08-05T06:01:25Z"),
  );
});

test("parseArchiveTimestampMs: unrecognised filename → null", () => {
  assert.equal(parseArchiveTimestampMs("/x/notes.md"), null);
});

test("recoverWorkerPhase: prefers a surviving checkpoint's measured timing", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);

  const result = recoverWorkerPhase(
    located(mdPath, {
      worker: {
        started_at: "2026-08-05T06:01:25.000Z",
        ended_at: "2026-08-05T06:40:02.000Z",
        exit_code: 0,
      },
    }),
  );
  assert.equal(result.derived, false);
  assert.equal(result.startedAtMs, Date.parse("2026-08-05T06:01:25.000Z"));
  assert.equal(result.endedAtMs, Date.parse("2026-08-05T06:40:02.000Z"));
});

test("recoverWorkerPhase: with no checkpoint, reconstructs from filename + mtime", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);
  const mtimeSeconds = Date.parse("2026-08-05T06:40:02.000Z") / 1000;
  utimesSync(mdPath, mtimeSeconds, mtimeSeconds);

  const result = recoverWorkerPhase(located(mdPath));
  assert.equal(result.derived, true, "flagged so the timing is never read as measured");
  assert.equal(result.startedAtMs, Date.parse("2026-08-05T06:01:25Z"));
  assert.equal(result.endedAtMs, Date.parse("2026-08-05T06:40:02Z"));
  assert.equal(result.exitCode, 0);
});

test("recoverWorkerPhase: never reports an end before its start", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, 679, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);
  const mtimeSeconds = Date.parse("2020-01-01T00:00:00.000Z") / 1000;
  utimesSync(mdPath, mtimeSeconds, mtimeSeconds);

  const result = recoverWorkerPhase(located(mdPath));
  assert.equal(result.endedAtMs, result.startedAtMs);
});

test("deriveIssueNumberFromWorktree: recovers identity a custom --name never encoded", () => {
  const root = scratchRoot();
  writeRun(root, 123, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);
  assert.equal(deriveIssueNumberFromWorktree(root), 123);
});

test("deriveIssueNumberFromWorktree: no runs dir → undefined", () => {
  assert.equal(deriveIssueNumberFromWorktree(scratchRoot()), undefined);
});

test("deriveIssueNumberFromWorktree: ambiguous (two issue dirs) → refuses to guess", () => {
  const root = scratchRoot();
  writeRun(root, 123, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);
  writeRun(root, 456, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);
  assert.equal(deriveIssueNumberFromWorktree(root), undefined);
});

test("deriveModeFromWorktree: takes the mode of the newest run", () => {
  const root = scratchRoot();
  writeRun(root, 123, "2026-08-05T04-00-00-INVESTIGATE.md", SUMMARY_MD);
  writeRun(root, 123, "2026-08-05T06-01-25-IMPLEMENT.md", SUMMARY_MD);
  assert.equal(deriveModeFromWorktree(root, 123), "IMPLEMENT");
});

test("multi-slice: each slice's worktree resolves to its OWN newest run", () => {
  // The `--name implement-123-slice-a` / `-slice-b` pattern puts two runs on one
  // issue. Dispatch mirrors older runs into the new worktree, so a slice's own
  // run must still win — it is always the most recent one present.
  const sliceB = scratchRoot();
  writeRun(sliceB, 123, "2026-08-05T04-00-00-IMPLEMENT.md", SUMMARY_MD); // mirrored slice-a
  const own = writeRun(sliceB, 123, "2026-08-05T09-00-00-IMPLEMENT.md", SUMMARY_MD);
  assert.equal(locateLatestRun(sliceB, 123, "IMPLEMENT")?.mdPath, own);
});
