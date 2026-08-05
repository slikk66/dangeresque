import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR, RUNS_DIR, SKIP_REVIEW_MODES } from "./config.js";
import {
  jsonPathForArchive,
  parseVerdictFromMarkdown,
  type ReviewerVerdict,
  type RunArtifact,
} from "./artifact.js";
import { listArchivedRuns, parseSummaryBlock } from "./worktree.js";

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

/**
 * Recover the issue number from a worktree's own run directory.
 *
 * Branch-name parsing covers the conventional `<mode>-<issue>[-<suffix>]` shape,
 * including multi-slice names like `implement-123-slice-a`. It cannot cover a
 * fully custom `--name` that carries no issue number. Dispatch mirrors exactly
 * one issue's runs into a worktree, so `.dangeresque/runs/issue-<N>/` is an
 * unambiguous fallback identity.
 */
export function deriveIssueNumberFromWorktree(
  worktreePath: string,
): number | undefined {
  const runsDir = join(worktreePath, CONFIG_DIR, RUNS_DIR);
  if (!existsSync(runsDir)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return undefined;
  }
  const issueDirs = entries
    .map((d) => d.match(/^issue-(\d+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => parseInt(m[1], 10));
  // More than one would be ambiguous; dispatch never creates that, so refuse
  // to guess rather than rescue the wrong issue's run.
  return issueDirs.length === 1 ? issueDirs[0] : undefined;
}

/**
 * Recover the mode from the newest run artifact in a worktree, for branches
 * whose name does not encode one. Filenames end `-<MODE>.md`.
 */
export function deriveModeFromWorktree(
  worktreePath: string,
  issueNumber: number,
): string | undefined {
  const files = listArchivedRuns(worktreePath, issueNumber);
  if (files.length === 0) return undefined;
  const match = files[files.length - 1].match(/-([A-Z]+)\.md$/);
  return match ? match[1] : undefined;
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
  const { mode, located, workerRunning, force } = opts;

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
  if (blocked) {
    return {
      ok: false,
      reason: `verification command "${blocked.name}" failed (exit ${blocked.exit_code}) — review is skipped by design when a block-policy gate fails`,
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
