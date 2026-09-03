import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR, RUNS_DIR, SKIP_REVIEW_MODES } from "./config.js";
import {
  jsonPathForArchive,
  parseVerdictFromMarkdown,
  type ReviewerVerdict,
  type RunArtifact,
} from "./artifact.js";
import { listArchivedRuns, parseSummaryBlock, type PidInfo } from "./worktree.js";

/**
 * A run located on disk for a review rescue: the worker's markdown artifact
 * plus its sibling eval JSON when one survives.
 *
 * The JSON is deliberately optional. The failure this module recovers from is a
 * process killed between worker-exit and the final `writeArtifact` — historically
 * that left NO JSON at all (the builder lived only in memory). Runs made after
 * checkpointing landed leave a partial JSON instead, which gives better fidelity
 * but is never required.
 */
export interface LocatedRun {
  mdPath: string;
  jsonPath: string;
  artifact: Partial<RunArtifact> | null;
}

/**
 * Find the newest `-<MODE>.md` run artifact for an issue under `root`.
 *
 * Newest-wins matters: an issue can take several IMPLEMENT passes, and a rescue
 * must continue the most recent one rather than an earlier merged round. Run
 * filenames are ISO-timestamp-prefixed, so `listArchivedRuns`'s lexical sort is
 * chronological.
 */
export function locateLatestRun(
  root: string,
  issueNumber: number,
  mode: string,
): LocatedRun | null {
  const files = listArchivedRuns(root, issueNumber).filter((f) =>
    f.endsWith(`-${mode}.md`),
  );
  if (files.length === 0) return null;

  const mdPath = join(
    root,
    CONFIG_DIR,
    RUNS_DIR,
    `issue-${issueNumber}`,
    files[files.length - 1],
  );
  const jsonPath = jsonPathForArchive(mdPath);

  let artifact: Partial<RunArtifact> | null = null;
  if (existsSync(jsonPath)) {
    try {
      artifact = JSON.parse(readFileSync(jsonPath, "utf-8")) as Partial<RunArtifact>;
    } catch {
      artifact = null;
    }
  }

  return { mdPath, jsonPath, artifact };
}

export interface ReviewRescueAssessment {
  ok: boolean;
  /** Operator-facing explanation of the refusal. Absent when `ok`. */
  reason?: string;
  /** Verdict already recorded on the run, when the artifact carries a real one. */
  existingVerdict?: ReviewerVerdict;
}

export interface AssessReviewRescueOptions {
  mode: string;
  located: LocatedRun | null;
  /** True when a worker or review process is still live in the worktree. */
  workerRunning: boolean;
  /** Operator override for the "already has a verdict" refusal only. */
  force: boolean;
  /**
   * True when the rescue will re-run the verification commands before the
   * review pass (the default; `--no-verify` clears it). A run whose block-policy
   * verification failed is eligible ONLY in that case — the operator fixed the
   * cause (or the failure was the harness's), and the re-run decides afresh.
   */
  reverify?: boolean;
}

/**
 * Decide whether a run is eligible for a review-only rerun.
 *
 * This is crash recovery, NOT a re-review button: a run that already carries a
 * real verdict is refused unless the operator passes `--force`, so "review until
 * it passes" is never the path of least resistance. Every other refusal is
 * unconditional — they describe runs where re-reviewing would be meaningless
 * (worker never finished, verification blocked, mode never reviews).
 */
export function assessReviewRescue(
  opts: AssessReviewRescueOptions,
): ReviewRescueAssessment {
  const { mode, located, workerRunning, force, reverify = false } = opts;

  if (workerRunning) {
    return {
      ok: false,
      reason: "a process is still running in this worktree — stop it first",
    };
  }

  if (SKIP_REVIEW_MODES.has(mode)) {
    return {
      ok: false,
      reason: `mode ${mode} never dispatches a review pass — nothing to rescue`,
    };
  }

  if (!located) {
    return { ok: false, reason: `no ${mode} run artifact found in this worktree` };
  }

  let md: string;
  try {
    md = readFileSync(located.mdPath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      reason: `run artifact unreadable (${located.mdPath}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The worker writes its own artifact as its last act. A missing SUMMARY block
  // means the worker itself died mid-run, so there is no completed work to review.
  if (parseSummaryBlock(md) === null) {
    return {
      ok: false,
      reason:
        `run artifact has no <!-- SUMMARY --> block (${basename(located.mdPath)}) — ` +
        `the worker never finished, so there is nothing to review`,
    };
  }

  const checkpoint = located.artifact;

  if (checkpoint?.worker && checkpoint.worker.exit_code !== 0) {
    return {
      ok: false,
      reason: `the worker phase failed (exit ${checkpoint.worker.exit_code}) — this needs a real re-run, not a review`,
    };
  }

  const blocked = checkpoint?.verification?.find(
    (v) => v.on_failure === "block" && v.exit_code !== 0,
  );
  if (blocked && !reverify) {
    return {
      ok: false,
      reason:
        `verification command "${blocked.name}" failed (exit ${blocked.exit_code}) — review is skipped by design when a block-policy gate fails; ` +
        `drop --no-verify so the rescue re-runs verification and decides afresh`,
    };
  }

  const existingVerdict = parseVerdictFromMarkdown(md);
  if (existingVerdict !== "unknown" && !force) {
    return {
      ok: false,
      existingVerdict,
      reason:
        `this run already has a reviewer verdict of "${existingVerdict}" — ` +
        `review rescue recovers crashed reviews, it does not re-roll decided ones`,
    };
  }

  return existingVerdict === "unknown" ? { ok: true } : { ok: true, existingVerdict };
}

// --- worker resume (dangeresque resume) ---
//
// The sibling of the review rescue above. `review` recovers a run whose WORKER
// finished and whose REVIEW died; this recovers a run whose worker died before
// it could commit, leaving hours of uncommitted work in a worktree no verb
// could re-enter (issue #110).

/**
 * How the dead attempt's artifact was attributed to this branch, weakest last.
 * Recorded on the resumed run so a reader can tell a run continued on hard
 * evidence from one continued on a legacy inference.
 */
export type ResumeAttribution = "pid_file" | "artifact_identity" | "markdown_only";

/** The artifact a dead worker left in the worktree we are about to re-enter. */
export interface WorkerResumeAttempt {
  /**
   * What the resumed worker is pointed at: the dead attempt's markdown when one
   * survives, otherwise its eval JSON. A worker killed before its first Write
   * leaves only the JSON (the parent finalizes the builder on the failure path),
   * and that JSON still carries the run's identity and timings.
   */
  artifactPath: string;
  /** The markdown, when the dead worker got far enough to write one. */
  mdPath: string | null;
  /** The sibling eval JSON, when one survives. */
  jsonPath: string | null;
  artifact: Partial<RunArtifact> | null;
  attribution: ResumeAttribution;
}

export interface LocateCurrentAttemptOptions {
  /** Main checkout. Used to recognize artifacts MIRRORED in at dispatch. */
  projectRoot: string;
  worktreePath: string;
  issueNumber: number;
  mode: string;
  branch: string;
  worktreeName: string;
  /** The worktree's PID file, when a hard-killed parent left one behind. */
  pidInfo?: PidInfo;
}

/**
 * Find the artifact THIS branch's own dead attempt wrote — never a prior run's.
 *
 * `locateLatestRun` is deliberately not reused here. Dispatch mirrors an issue's
 * prior runs into every new worktree (`mirrorIssueRuns`), and that function picks
 * the newest matching filename with no identity check at all. On a worker that
 * died before writing anything, the newest same-mode file on disk is a COPY of an
 * earlier, already-merged run — resuming "into" it would silently continue the
 * wrong work and defeat the "no run artifact ⇒ refuse" rule outright.
 *
 * Attribution ladder, strongest first:
 *  1. The stale PID file names the archive its own run was writing.
 *  2. An eval JSON in this worktree whose recorded branch/worktree, issue and
 *     mode are this run's. A normal non-zero engine exit always produces one,
 *     because `cmdRun` finalizes the builder on the failure path.
 *  3. Legacy markdown with no eval JSON anywhere that contradicts this branch,
 *     and which is not also present in the project root — a file in BOTH roots
 *     was mirrored in at dispatch, so it belongs to an earlier run by definition.
 *
 * Returns null when no rung can attribute an attempt to this branch. Failing
 * closed is the point: the caller refuses rather than resuming a stranger's run.
 */
export function locateCurrentAttempt(
  opts: LocateCurrentAttemptOptions,
): WorkerResumeAttempt | null {
  const { projectRoot, worktreePath, issueNumber, mode } = opts;
  const dir = join(worktreePath, CONFIG_DIR, RUNS_DIR, `issue-${issueNumber}`);
  if (!existsSync(dir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  // Rung 1 — the PID file the killed parent never got to remove. Its archive
  // path is re-homed onto this worktree's issue dir by basename so a realpath
  // difference (/tmp vs /private/tmp) cannot defeat the match.
  const recorded = opts.pidInfo?.archivePath;
  if (recorded) {
    const name = basename(recorded);
    if (name.endsWith(`-${mode}.md`) && entries.includes(name)) {
      const attempt = readAttempt(join(dir, name), "pid_file");
      if (attempt) return attempt;
    }
  }

  const jsonNames = entries.filter((f) => f.endsWith(".json")).sort();

  // Rung 2 — an eval JSON that names this exact run.
  for (let i = jsonNames.length - 1; i >= 0; i--) {
    if (!jsonNames[i].endsWith(`-${mode}.json`)) continue;
    const artifact = readJson(join(dir, jsonNames[i]));
    if (!artifact || !artifactIsThisRun(artifact, opts)) continue;
    const attempt = readAttempt(
      join(dir, jsonNames[i].replace(/\.json$/, ".md")),
      "artifact_identity",
    );
    if (attempt) return attempt;
  }

  // Rung 3 — legacy markdown-only. Any JSON in the directory that names a
  // DIFFERENT run proves this directory holds mirrored foreign artifacts, so a
  // bare markdown here cannot be trusted to be ours.
  const contradicted = jsonNames.some((f) => {
    const artifact = readJson(join(dir, f));
    return artifact !== null && !artifactIsThisRun(artifact, opts);
  });
  if (contradicted) return null;

  const rootDir = join(projectRoot, CONFIG_DIR, RUNS_DIR, `issue-${issueNumber}`);
  const mdNames = entries.filter((f) => f.endsWith(`-${mode}.md`)).sort();
  for (let i = mdNames.length - 1; i >= 0; i--) {
    const name = mdNames[i];
    if (entries.includes(name.replace(/\.md$/, ".json"))) continue; // rung 2's job
    if (existsSync(join(rootDir, name))) continue; // mirrored in at dispatch
    const attempt = readAttempt(join(dir, name), "markdown_only");
    if (attempt) return attempt;
  }

  return null;
}

function readJson(jsonPath: string): Partial<RunArtifact> | null {
  try {
    return JSON.parse(readFileSync(jsonPath, "utf-8")) as Partial<RunArtifact>;
  } catch {
    return null;
  }
}

/**
 * Whether an eval JSON describes the run we are resuming. Branch OR worktree
 * name is enough on the identity axis — either one is written from the same
 * dispatch and a match on one with a mismatch on the other cannot happen — but
 * the issue and mode must both agree, so a same-worktree run in another mode is
 * never mistaken for this one.
 */
function artifactIsThisRun(
  artifact: Partial<RunArtifact>,
  opts: Pick<LocateCurrentAttemptOptions, "branch" | "worktreeName" | "issueNumber" | "mode">,
): boolean {
  const identityMatches =
    artifact.branch === opts.branch || artifact.worktree_name === opts.worktreeName;
  return (
    identityMatches &&
    artifact.issue_number === opts.issueNumber &&
    artifact.mode === opts.mode
  );
}

function readAttempt(
  mdPath: string,
  attribution: ResumeAttribution,
): WorkerResumeAttempt | null {
  const jsonPath = jsonPathForArchive(mdPath);
  const hasMd = existsSync(mdPath);
  const hasJson = existsSync(jsonPath);
  if (!hasMd && !hasJson) return null;
  return {
    artifactPath: hasMd ? mdPath : jsonPath,
    mdPath: hasMd ? mdPath : null,
    jsonPath: hasJson ? jsonPath : null,
    artifact: hasJson ? readJson(jsonPath) : null,
    attribution,
  };
}

export interface WorkerResumeAssessment {
  ok: boolean;
  /** Operator-facing explanation of the refusal. Absent when `ok`. */
  reason?: string;
  /**
   * True when the refusal is "this worker already finished". The caller uses it
   * to point at the right recovery verb — `review` for a mode that reviews,
   * `merge` for one that does not — instead of at `resume` again.
   */
  workerCompleted?: boolean;
}

export interface AssessWorkerResumeOptions {
  mode: string;
  attempt: WorkerResumeAttempt | null;
  /** True when a worker or review process is still live in the worktree. */
  workerRunning: boolean;
}

/**
 * Decide whether a worktree is eligible for a worker resume.
 *
 * The complement of `assessReviewRescue`, and mutually exclusive with it by
 * construction: that one requires a worker that FINISHED, this one requires one
 * that did NOT. Every refusal here is unconditional — there is no `--force`
 * lane, because each one describes a tree where resuming would either destroy
 * live work or re-run a worker that already cost its engine time.
 */
export function assessWorkerResume(
  opts: AssessWorkerResumeOptions,
): WorkerResumeAssessment {
  const { mode, attempt, workerRunning } = opts;

  if (workerRunning) {
    return {
      ok: false,
      reason: "a process is still running in this worktree — stop it first",
    };
  }

  if (!attempt) {
    return {
      ok: false,
      reason:
        `no ${mode} run artifact written by this branch's own attempt was found in the worktree — ` +
        `resume continues a dead attempt, and nothing here shows one ran`,
    };
  }

  // The eval JSON is authoritative when it survived: the parent writes it from
  // the measured child exit, and zero means the worker did its whole job.
  const worker = attempt.artifact?.worker;
  if (worker && worker.exit_code === 0) {
    return {
      ok: false,
      workerCompleted: true,
      reason: `the worker phase already completed (exit 0) — resume re-runs a worker that DIED, not one that finished`,
    };
  }

  // No measured exit code. The worker writes its own artifact as its last act,
  // so a complete SUMMARY block is the only other evidence it finished.
  if (!worker && attempt.mdPath) {
    let md: string;
    try {
      md = readFileSync(attempt.mdPath, "utf-8");
    } catch (err) {
      return {
        ok: false,
        reason: `run artifact unreadable (${attempt.mdPath}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (parseSummaryBlock(md) !== null) {
      return {
        ok: false,
        workerCompleted: true,
        reason:
          `the run artifact carries a complete <!-- SUMMARY --> block (${basename(attempt.mdPath)}) ` +
          `and no exit code contradicts it — the worker finished, so there is nothing to resume`,
      };
    }
  }

  return { ok: true };
}

export interface RecoveredWorkerPhase {
  startedAtMs: number;
  endedAtMs: number;
  exitCode: number;
  /**
   * True when the timing was reconstructed from the artifact filename and mtime
   * because no checkpoint JSON survived the kill. Recorded in the rescued
   * artifact so the timing is never mistaken for a direct measurement.
   */
  derived: boolean;
}

/**
 * Parse the run-start timestamp encoded in an artifact filename.
 * `computeRunArchivePath` builds it as an ISO-8601 string with `:` and `.`
 * replaced by `-`, e.g. `2026-08-05T06-01-25-IMPLEMENT.md`.
 */
export function parseArchiveTimestampMs(mdPath: string): number | null {
  const match = basename(mdPath).match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/,
  );
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reconstruct the worker phase for a rescued run.
 *
 * Prefers a surviving checkpoint. Otherwise falls back to the two facts that
 * outlive any kill: the run-start timestamp baked into the artifact filename,
 * and the artifact's last-write mtime. `assessReviewRescue` has already
 * established the worker succeeded, hence exit code 0.
 */
export function recoverWorkerPhase(located: LocatedRun): RecoveredWorkerPhase {
  const worker = located.artifact?.worker;
  if (worker) {
    const startedAtMs = Date.parse(worker.started_at);
    const endedAtMs = Date.parse(worker.ended_at);
    if (!Number.isNaN(startedAtMs) && !Number.isNaN(endedAtMs)) {
      return {
        startedAtMs,
        endedAtMs,
        exitCode: worker.exit_code,
        derived: false,
      };
    }
  }

  let mtimeMs: number;
  try {
    mtimeMs = statSync(located.mdPath).mtimeMs;
  } catch {
    mtimeMs = Date.now();
  }
  const startedAtMs = parseArchiveTimestampMs(located.mdPath) ?? mtimeMs;

  return {
    startedAtMs,
    endedAtMs: Math.max(startedAtMs, mtimeMs),
    exitCode: 0,
    derived: true,
  };
}
