import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  locateLatestRun,
  locateCurrentAttempt,
  assessReviewRescue,
  assessWorkerResume,
  recoverWorkerPhase,
  parseArchiveTimestampMs,
  type LocatedRun,
  type WorkerResumeAttempt,
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

test("assessReviewRescue: refuses a block-policy verification failure when verification will NOT re-run", () => {
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
    reverify: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /"test" failed/);
  assert.match(result.reason!, /--no-verify/);
});

test("assessReviewRescue: a block-policy verification failure is eligible when verification re-runs", () => {
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
    reverify: true,
  });
  assert.equal(result.ok, true);
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

// --- worker resume (dangeresque resume, issue #110) ---

const ISSUE = 866;
const BRANCH = "worktree-dangeresque-implement-866";
const WORKTREE_NAME = "dangeresque-implement-866";

/**
 * A worktree + its project root, wired the way dispatch leaves them: the root
 * holds the issue's merged prior runs, and `mirrorIssueRuns` has copied them in.
 */
function resumeFixture(): { projectRoot: string; worktreePath: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "dangeresque-resume-root-"));
  const worktreePath = join(projectRoot, ".claude", "worktrees", WORKTREE_NAME);
  mkdirSync(worktreePath, { recursive: true });
  return { projectRoot, worktreePath };
}

/** The eval JSON a run writes about itself. */
function evalJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "prior-run-id",
    issue_number: ISSUE,
    mode: "IMPLEMENT",
    branch: BRANCH,
    worktree_name: WORKTREE_NAME,
    worker: { exit_code: 1 },
    ...over,
  };
}

function locate(
  projectRoot: string,
  worktreePath: string,
  over: Record<string, unknown> = {},
): WorkerResumeAttempt | null {
  return locateCurrentAttempt({
    projectRoot,
    worktreePath,
    issueNumber: ISSUE,
    mode: "IMPLEMENT",
    branch: BRANCH,
    worktreeName: WORKTREE_NAME,
    ...over,
  });
}

test("locateCurrentAttempt: the bubble-craps shape — dead worker's eval JSON names this branch", () => {
  const { projectRoot, worktreePath } = resumeFixture();
  const mdPath = writeRun(
    worktreePath,
    ISSUE,
    "2026-09-03T04-00-00-IMPLEMENT.md",
    "## Partial notes\n",
    evalJson(),
  );

  const attempt = locate(projectRoot, worktreePath);
  assert.equal(attempt?.artifactPath, mdPath);
  assert.equal(attempt?.attribution, "artifact_identity");
  assert.equal(attempt?.artifact?.run_id, "prior-run-id");
});

test("locateCurrentAttempt: worker died before its first Write → the JSON alone is the attempt", () => {
  const { projectRoot, worktreePath } = resumeFixture();
  const mdPath = writeRun(
    worktreePath,
    ISSUE,
    "2026-09-03T04-00-00-IMPLEMENT.md",
    "",
    evalJson(),
  );
  rmSync(mdPath);

  const attempt = locate(projectRoot, worktreePath);
  assert.equal(attempt?.mdPath, null, "no markdown survived");
  assert.equal(
    attempt?.artifactPath,
    mdPath.replace(/\.md$/, ".json"),
    "the resumed worker is pointed at the JSON instead",
  );
});

test("locateCurrentAttempt: a mirrored PRIOR run is never mistaken for this attempt", () => {
  // The CHALLENGE-IN-WRITING case. Dispatch mirrors the issue's merged runs into
  // every worktree, so the newest same-mode file on disk belongs to an earlier
  // run. Selecting it would resume the wrong work AND defeat the refusal.
  const { projectRoot, worktreePath } = resumeFixture();
  const prior = "2026-09-01T00-00-00-IMPLEMENT.md";
  const priorJson = evalJson({
    run_id: "an-earlier-merged-run",
    branch: "worktree-dangeresque-implement-866-round1",
    worktree_name: "dangeresque-implement-866-round1",
  });
  writeRun(projectRoot, ISSUE, prior, SUMMARY_MD, priorJson);
  writeRun(worktreePath, ISSUE, prior, SUMMARY_MD, priorJson); // the mirror

  assert.equal(
    locate(projectRoot, worktreePath),
    null,
    "fails closed — this branch wrote nothing of its own",
  );
});

test("locateCurrentAttempt: a mirrored prior with the SAME identity (reused default name) is never this attempt", () => {
  // Default worktree names are reusable: `implement-866` merged once, then a
  // second `implement-866` was dispatched, died, and wrote nothing. Its dir
  // holds the first run's JSON — same branch, same worktree_name, same issue,
  // same mode — mirrored in at dispatch. Identity cannot tell them apart;
  // presence in the project root can.
  const { projectRoot, worktreePath } = resumeFixture();
  const prior = "2026-09-01T00-00-00-IMPLEMENT.md";
  const priorJson = evalJson({ run_id: "the-merged-first-round", worker: { exit_code: 0 } });
  writeRun(projectRoot, ISSUE, prior, SUMMARY_MD, priorJson);
  writeRun(worktreePath, ISSUE, prior, SUMMARY_MD, priorJson); // the mirror

  assert.equal(locate(projectRoot, worktreePath), null, "fails closed");
});

test("locateCurrentAttempt: same-identity mirrored prior beside the dead attempt's OWN artifact → own wins", () => {
  const { projectRoot, worktreePath } = resumeFixture();
  const prior = "2026-09-01T00-00-00-IMPLEMENT.md";
  const priorJson = evalJson({ run_id: "the-merged-first-round", worker: { exit_code: 0 } });
  writeRun(projectRoot, ISSUE, prior, SUMMARY_MD, priorJson);
  writeRun(worktreePath, ISSUE, prior, SUMMARY_MD, priorJson);
  const own = writeRun(
    worktreePath,
    ISSUE,
    "2026-09-03T04-00-00-IMPLEMENT.md",
    "## Partial\n",
    evalJson({ run_id: "the-dead-second-round" }),
  );

  const attempt = locate(projectRoot, worktreePath);
  assert.equal(attempt?.artifactPath, own);
  assert.equal(attempt?.artifact?.run_id, "the-dead-second-round");
});

test("locateCurrentAttempt: a stale PID naming a VANISHED archive fails closed instead of falling through", () => {
  // The reviewer's reproduction: the PID file is the only witness to this
  // attempt and its archive is gone, yet a same-identity mirrored prior sits in
  // the directory. Falling through to rung 2 would resume the wrong run.
  const { projectRoot, worktreePath } = resumeFixture();
  const prior = "2026-09-01T00-00-00-IMPLEMENT.md";
  const priorJson = evalJson({ run_id: "old-merged", worker: { exit_code: 0 } });
  writeRun(projectRoot, ISSUE, prior, SUMMARY_MD, priorJson);
  writeRun(worktreePath, ISSUE, prior, SUMMARY_MD, priorJson);
  // …and, to make the trap complete, wipe the root copy so the mirror check alone cannot save us.
  rmSync(join(projectRoot, ".dangeresque", "runs", `issue-${ISSUE}`), { recursive: true, force: true });

  const vanished = join(worktreePath, ".dangeresque", "runs", `issue-${ISSUE}`, "2026-09-03T05-00-00-IMPLEMENT.md");
  const attempt = locate(projectRoot, worktreePath, {
    pidInfo: { pid: 1, startedAt: 0, archivePath: vanished },
  });
  assert.equal(attempt, null);
});

test("locateCurrentAttempt: a stale PID whose archive is JSON-only still resolves through rung 1", () => {
  const { projectRoot, worktreePath } = resumeFixture();
  const own = writeRun(worktreePath, ISSUE, "2026-09-03T04-00-00-IMPLEMENT.md", "", evalJson());
  rmSync(own);

  const attempt = locate(projectRoot, worktreePath, {
    pidInfo: { pid: 1, startedAt: 0, archivePath: own },
  });
  assert.equal(attempt?.attribution, "pid_file");
  assert.equal(attempt?.mdPath, null);
  assert.equal(attempt?.artifactPath, own.replace(/\.md$/, ".json"));
});

test("locateCurrentAttempt: a mirrored prior with NO eval JSON still fails closed", () => {
  // Legacy shape: no JSON to contradict the branch, so rung 3 is the only one
  // left. Presence in BOTH roots proves the file was mirrored in at dispatch.
  const { projectRoot, worktreePath } = resumeFixture();
  const prior = "2026-09-01T00-00-00-IMPLEMENT.md";
  writeRun(projectRoot, ISSUE, prior, SUMMARY_MD);
  writeRun(worktreePath, ISSUE, prior, SUMMARY_MD);

  assert.equal(locate(projectRoot, worktreePath), null);
});

test("locateCurrentAttempt: legacy markdown written by THIS branch is accepted", () => {
  const { projectRoot, worktreePath } = resumeFixture();
  const own = writeRun(
    worktreePath,
    ISSUE,
    "2026-09-03T04-00-00-IMPLEMENT.md",
    "## Partial notes\n",
  );

  const attempt = locate(projectRoot, worktreePath);
  assert.equal(attempt?.artifactPath, own);
  assert.equal(attempt?.attribution, "markdown_only");
});

test("locateCurrentAttempt: the stale PID file's archive outranks every filename heuristic", () => {
  const { projectRoot, worktreePath } = resumeFixture();
  // A LATER-named mirrored prior would win a lexical sort; the PID file does not care.
  const laterPrior = "2026-09-04T00-00-00-IMPLEMENT.md";
  writeRun(projectRoot, ISSUE, laterPrior, SUMMARY_MD);
  writeRun(worktreePath, ISSUE, laterPrior, SUMMARY_MD);
  const own = writeRun(worktreePath, ISSUE, "2026-09-03T04-00-00-IMPLEMENT.md", "## Partial\n");

  const attempt = locate(projectRoot, worktreePath, {
    pidInfo: { pid: 1, startedAt: 0, archivePath: own },
  });
  assert.equal(attempt?.artifactPath, own);
  assert.equal(attempt?.attribution, "pid_file");
});

test("locateCurrentAttempt: a same-worktree run in ANOTHER mode is not this attempt", () => {
  const { projectRoot, worktreePath } = resumeFixture();
  writeRun(
    worktreePath,
    ISSUE,
    "2026-09-03T04-00-00-INVESTIGATE.md",
    SUMMARY_MD,
    evalJson({ mode: "INVESTIGATE" }),
  );

  assert.equal(locate(projectRoot, worktreePath), null);
});

test("locateCurrentAttempt: no runs directory at all → null", () => {
  const { projectRoot, worktreePath } = resumeFixture();
  assert.equal(locate(projectRoot, worktreePath), null);
});

function attempt(over: Partial<WorkerResumeAttempt> = {}): WorkerResumeAttempt {
  return {
    artifactPath: "/x/2026-09-03T04-00-00-IMPLEMENT.md",
    mdPath: null,
    jsonPath: "/x/2026-09-03T04-00-00-IMPLEMENT.json",
    artifact: { worker: { exit_code: 1 } } as WorkerResumeAttempt["artifact"],
    attribution: "artifact_identity",
    ...over,
  };
}

test("assessWorkerResume: a failed worker (exit 1) is eligible", () => {
  const result = assessWorkerResume({
    mode: "IMPLEMENT",
    attempt: attempt(),
    workerRunning: false,
  });
  assert.equal(result.ok, true);
});

test("assessWorkerResume: partial markdown with no SUMMARY is eligible", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, ISSUE, "2026-09-03T04-00-00-IMPLEMENT.md", "## Partial notes\n");
  const result = assessWorkerResume({
    mode: "IMPLEMENT",
    attempt: attempt({ artifactPath: mdPath, mdPath, jsonPath: null, artifact: null }),
    workerRunning: false,
  });
  assert.equal(result.ok, true);
});

test("assessWorkerResume: refuses while a process is still live in the worktree", () => {
  const result = assessWorkerResume({
    mode: "IMPLEMENT",
    attempt: attempt(),
    workerRunning: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /still running/);
});

test("assessWorkerResume: refuses when no attempt could be attributed to this branch", () => {
  const result = assessWorkerResume({
    mode: "IMPLEMENT",
    attempt: null,
    workerRunning: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /this branch's own attempt/);
});

test("assessWorkerResume: refuses a worker that finished (exit 0) — that is review's job", () => {
  const result = assessWorkerResume({
    mode: "IMPLEMENT",
    attempt: attempt({
      artifact: { worker: { exit_code: 0 } } as WorkerResumeAttempt["artifact"],
    }),
    workerRunning: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.workerCompleted, true);
  assert.match(result.reason!, /already completed/);
});

test("assessWorkerResume: refuses a complete SUMMARY block when no exit code contradicts it", () => {
  const root = scratchRoot();
  const mdPath = writeRun(root, ISSUE, "2026-09-03T04-00-00-IMPLEMENT.md", SUMMARY_MD);
  const result = assessWorkerResume({
    mode: "IMPLEMENT",
    attempt: attempt({ artifactPath: mdPath, mdPath, jsonPath: null, artifact: null }),
    workerRunning: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.workerCompleted, true);
  assert.match(result.reason!, /the worker finished/);
});

test("assessWorkerResume: a recorded non-zero exit outranks a SUMMARY block", () => {
  // The worker wrote its summary, then the engine died during shutdown. The
  // measured exit code is the authority; a resume can still finish the job.
  const root = scratchRoot();
  const mdPath = writeRun(root, ISSUE, "2026-09-03T04-00-00-IMPLEMENT.md", SUMMARY_MD);
  const result = assessWorkerResume({
    mode: "IMPLEMENT",
    attempt: attempt({
      artifactPath: mdPath,
      mdPath,
      artifact: { worker: { exit_code: 137 } } as WorkerResumeAttempt["artifact"],
    }),
    workerRunning: false,
  });
  assert.equal(result.ok, true);
});

test("assessWorkerResume: an unreadable markdown fails closed", () => {
  const result = assessWorkerResume({
    mode: "IMPLEMENT",
    attempt: attempt({ mdPath: "/definitely/not/real-xyz.md", artifact: null }),
    workerRunning: false,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /unreadable/);
});

test("review rescue and worker resume are mutually exclusive on the same run", () => {
  // The two verbs partition the failure space: whatever `review` accepts,
  // `resume` must refuse, and vice versa. Prove it on both sides of the split.
  const root = scratchRoot();
  const finishedMd = writeRun(root, ISSUE, "2026-09-03T04-00-00-IMPLEMENT.md", SUMMARY_MD);
  const finished = { worker: { exit_code: 0 } };

  assert.equal(
    assessReviewRescue({
      mode: "IMPLEMENT",
      located: located(finishedMd, finished),
      workerRunning: false,
      force: false,
    }).ok,
    true,
  );
  assert.equal(
    assessWorkerResume({
      mode: "IMPLEMENT",
      attempt: attempt({
        artifactPath: finishedMd,
        mdPath: finishedMd,
        artifact: finished as WorkerResumeAttempt["artifact"],
      }),
      workerRunning: false,
    }).ok,
    false,
  );

  const deadMd = writeRun(root, 867, "2026-09-03T04-00-00-IMPLEMENT.md", "## Partial\n");
  const dead = { worker: { exit_code: 1 } };

  assert.equal(
    assessReviewRescue({
      mode: "IMPLEMENT",
      located: located(deadMd, dead),
      workerRunning: false,
      force: false,
    }).ok,
    false,
  );
  assert.equal(
    assessWorkerResume({
      mode: "IMPLEMENT",
      attempt: attempt({
        artifactPath: deadMd,
        mdPath: deadMd,
        artifact: dead as WorkerResumeAttempt["artifact"],
      }),
      workerRunning: false,
    }).ok,
    true,
  );
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
