#!/usr/bin/env node

import {
  loadConfig,
  validateSetup,
  validateEngineRuntime,
  resolveRunPlan,
  resolveProjectRoot,
  SKIP_REVIEW_MODES,
  type DangeresqueConfig,
  type Engine,
  type RunPlan,
  type RunPlanOverrides,
} from "./config.js";
import { runWorker, runReview, fetchIssue, postRunComment, loadIssueFixture, formatIssueComments, killActiveEngines, validateCodexModelEfforts, captureWorkerChanges, type ExecutionReceipt, type IssueData } from "./runner.js";
import {
  locateLatestRun,
  assessReviewRescue,
  recoverWorkerPhase,
  deriveIssueNumberFromWorktree,
  deriveModeFromWorktree,
} from "./rescue.js";
import {
  ArtifactBuilder,
  writeArtifact,
  jsonPathForArchive,
  ARTIFACT_SCHEMA_VERSION,
  type RescueRecord,
} from "./artifact.js";
import { normalizeSummaryFileCount } from "./summary.js";
import { runVerification, shouldRunVerify, type VerificationOutcome } from "./verify.js";
import { applyDispatchGate } from "./gates.js";
import {
  listWorktrees,
  mergeWorktree,
  discardWorktree,
  stopWorktree,
  runPreflightChecks,
  getWorktreeResults,
  getArchivedResults,
  resolveBranch,
  cleanArchivedRuns,
  readPidFile,
  assertInMainCheckout,
  filterWorktrees,
  formatRunHeader,
  formatResultsGuidance,
  formatPidExecution,
  extractIssueNumber,
  extractMode,
  uncommittedPaths,
  formatUncommittedPaths,
  rebaseWorktreeOntoOrigin,
  type WorktreeInfo,
  type WorktreeFilter,
} from "./worktree.js";
import { pickWorktree } from "./picker.js";
import { initProject } from "./init.js";
import { printBrief } from "./brief.js";
import { usageForEngine } from "./usage.js";
import { allowMcp, allowBash, type AllowResult } from "./allow.js";
import { stageComment, postIssueComment } from "./stage.js";
import { resolveSessionPath, selectLogPhase, tailLog } from "./logs.js";
import {
  gatherArtifacts,
  computeStats,
  formatStats,
  type GatherOptions,
} from "./stats.js";
import { migrateAllArtifacts } from "./migrate.js";
import {
  parseScopeBlocks,
  parseScopeDeclarationSection,
  classifyChanges,
  matchesGlob,
  type ScopeReport,
  type ScopeDeclarationParse,
} from "./scope.js";
import type { ScopeOpportunisticConfig } from "./config.js";
import { detectDrift } from "./build-info.js";
import { runDoctorChecks, formatDoctorReport } from "./doctor.js";
import { relative, join } from "node:path";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";

interface FileLineCounts {
  /** Per-file (added + deleted) line counts, keyed by path. */
  totals: Map<string, number>;
}

function parseNumstat(numstat: string): FileLineCounts {
  const totals = new Map<string, number>();
  for (const line of numstat.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const added = m[1] === "-" ? 0 : parseInt(m[1], 10);
    const deleted = m[2] === "-" ? 0 : parseInt(m[2], 10);
    totals.set(m[3], (totals.get(m[3]) ?? 0) + added + deleted);
  }
  return { totals };
}

// Project-level policy engine for opportunistic-fix budget. Operates on a
// classified report from `classifyChanges` and demotes over-budget extended
// entries to `outside`. Three independent passes:
//
//   1. denyGlobs — every `extended` entry whose path matches a project-level
//      denyGlob moves to `outside`. Applies to BOTH `extension` and
//      `opportunistic` so security/infra paths cannot be laundered as
//      "extension".
//   2. maxFiles — count remaining `opportunistic` entries; if > maxFiles,
//      demote the trailing (declaration-order) entries until under.
//   3. maxLines — sum (added + deleted) lines across remaining `opportunistic`
//      entries; if > maxLines, demote largest-first until under.
//
// Disabled-config (`enabled: false`) skips passes 2/3 but keeps pass 1 — denyGlobs
// is security policy and applies regardless. Empty `denyGlobs: []` makes pass 1
// a no-op naturally (no globs to match).
function applyOpportunisticBudget(
  report: ScopeReport,
  cfg: ScopeOpportunisticConfig,
  lineCounts: FileLineCounts,
): ScopeReport {
  const inScope = [...report.in_scope];
  const outside = [...report.outside];
  let extended = report.extended.map((e) => ({ ...e }));

  // Pass 1: project-level denyGlobs (both extension + opportunistic).
  if (cfg.denyGlobs.length > 0) {
    const kept: typeof extended = [];
    for (const e of extended) {
      if (cfg.denyGlobs.some((g) => matchesGlob(e.path, g))) {
        outside.push(e.path);
      } else {
        kept.push(e);
      }
    }
    extended = kept;
  }

  if (!cfg.enabled) {
    return carryScopeMeta(report, inScope, extended, outside);
  }

  // Pass 2: maxFiles cap on opportunistic entries.
  const opportunisticIdx: number[] = [];
  for (let i = 0; i < extended.length; i++) {
    if (extended[i].category === "opportunistic") opportunisticIdx.push(i);
  }
  const overFiles = Math.max(0, opportunisticIdx.length - cfg.maxFiles);
  const demoteSet = new Set<number>();
  for (let i = opportunisticIdx.length - overFiles; i < opportunisticIdx.length; i++) {
    demoteSet.add(opportunisticIdx[i]);
  }

  // Pass 3: maxLines cap. Sum LOC over remaining opportunistic entries
  // (those not already slated for demotion in pass 2). Demote largest-first.
  const remaining = opportunisticIdx
    .filter((i) => !demoteSet.has(i))
    .map((i) => ({ idx: i, lines: lineCounts.totals.get(extended[i].path) ?? 0 }));
  let totalLines = remaining.reduce((s, r) => s + r.lines, 0);
  if (totalLines > cfg.maxLines) {
    remaining.sort((a, b) => b.lines - a.lines);
    for (const r of remaining) {
      if (totalLines <= cfg.maxLines) break;
      demoteSet.add(r.idx);
      totalLines -= r.lines;
    }
  }

  const finalExtended: typeof extended = [];
  for (let i = 0; i < extended.length; i++) {
    if (demoteSet.has(i)) outside.push(extended[i].path);
    else finalExtended.push(extended[i]);
  }

  return carryScopeMeta(report, inScope, finalExtended, outside);
}

// The budget engine re-buckets files; it learns nothing new about the worker's
// declaration, so those fields ride through untouched.
function carryScopeMeta(
  source: ScopeReport,
  inScope: ScopeReport["in_scope"],
  extended: ScopeReport["extended"],
  outside: ScopeReport["outside"],
): ScopeReport {
  return {
    in_scope: inScope,
    extended,
    outside,
    declaration_status: source.declaration_status,
    ...(source.diagnostics ? { diagnostics: source.diagnostics } : {}),
  };
}

function currentHelpEngine(): Engine {
  const envEngine = process.env.DANGERESQUE_ENGINE?.toLowerCase();
  if (envEngine === "claude" || envEngine === "codex") return envEngine;

  try {
    const config = loadConfig(resolveProjectRoot());
    return config.worker.engine;
  } catch {
    return "claude";
  }
}

// Loud, non-blocking warning printed at the top of artifact-writing commands
// (`run`, `migrate`) when the running binary's dist/ does not match HEAD. The
// silent-staleness trap from #66 motivated this — read-only commands skip it
// to avoid drowning the signal in noise.
function driftWarnIfStale(): void {
  let drift;
  try {
    drift = detectDrift();
  } catch {
    return;
  }
  if (!drift.drift) return;
  if (drift.reason === "no-build-info") {
    console.warn(
      `\n⚠️  No dist/build-info.json — binary predates drift detection.\n` +
        `    Run \`yarn build\` to regenerate.\n` +
        `    Run \`dangeresque doctor\` for full diagnosis.\n`,
    );
    return;
  }
  if (drift.reason === "drift") {
    const built = drift.buildInfo?.commit?.slice(0, 8) ?? "null";
    const head = drift.headCommit?.slice(0, 8) ?? "unknown";
    console.warn(
      `\n⚠️  STALE BINARY: dist/ built from ${built} but HEAD is ${head}.\n` +
        `    Run \`yarn build\` and re-invoke. Continuing with stale code may write\n` +
        `    wrong-schema artifacts (see issue #66).\n` +
        `    Run \`dangeresque doctor\` for full diagnosis.\n`,
    );
  }
}

function statsGlossary(): string {
  return `
Run Evaluation Glossary
=======================

Results:
  success
    The worker exited successfully and produced its run artifact. Either the reviewer accepted the run, or review did not run and no scope violations were recorded.
  partial_success
    The worker exited successfully and produced its run artifact, but the run still needs attention. This is used when review errored, review returned needs_human_review or unknown, review was skipped while scope violations were recorded, or the run left uncommitted work behind (see uncommitted_worker_changes).
  failure
    The worker failed, the run artifact was missing, or the reviewer explicitly rejected the run.

Failure categories:
  scope_outside
    Changed files were classified \`outside\` of the issue's declared scope:
    not matched by any allow-glob in a \`dangeresque-scope\` block, not mentioned
    in the worker's \`## Scope Declaration\`, OR demoted from \`extension\`/
    \`opportunistic\` because they hit a project denyGlob or exceeded the
    opportunistic budget. This category is emitted only when those entries
    caused a downgrade because review did not run; when review ran, the
    reviewer verdict controls the result.
  verification_failed
    A pre-review verification command configured with on_failure="block" exited non-zero (or timed out). The review pass is skipped when this happens because reviewing un-compiling or test-failing code wastes effort. Inspect the run artifact's "## Verification" section for the failing command and its captured stderr.
  uncommitted_worker_changes
    The run finished with changes the branch's commits do not carry: dangeresque could not capture the worker's tree, or something stayed uncommitted through the capture. The reviewer reads the working tree but \`git merge\` ships commits, so such a run is never a success no matter what the verdict says. Recover by committing the leftover work on the worker branch, then merging.
  rebase_conflict
    The pre-review rebase onto origin/main hit a real conflict and was aborted; the reviewer saw the pre-rebase diff. A rebase that was skipped (dirty worktree, no reachable origin) is NOT this category — it records a rebase_skipped lifecycle event instead.

Reviewer verdicts:
  accept
    The reviewer accepted the worker's changes.
  reject
    The reviewer rejected the worker's changes; this makes the run a failure.
  needs_human_review
    The reviewer could not accept or reject outright and asked for human judgment; this makes the run a partial_success.
  skipped
    The reviewer did not run. Automatically skipped for INVESTIGATE and VERIFY modes (no code changes to audit), and manually skipped by --no-review.
  unknown
    Dangeresque could not derive a reviewer verdict, usually because the worker failed, the artifact was missing or unreadable, or the markdown verdict was absent or unparseable.

Review execution:
  Review normally runs after a successful worker run for code-changing modes.
  Review is automatically skipped for INVESTIGATE and VERIFY, and manually skipped by --no-review.
`;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(usageForEngine(currentHelpEngine()));
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "run":
      await cmdRun(args.slice(1));
      break;
    case "logs":
      await cmdLogs(args.slice(1));
      break;
    case "review":
      await cmdReview(args.slice(1));
      break;
    case "results":
      await cmdResults(args.slice(1));
      break;
    case "stage":
      cmdStage(args.slice(1));
      break;
    case "status":
      cmdStatus();
      break;
    case "merge":
      await cmdMerge(args.slice(1));
      break;
    case "discard":
      await cmdDiscard(args.slice(1));
      break;
    case "stop":
      await cmdStop(args.slice(1));
      break;
    case "clean":
      cmdClean(args.slice(1));
      break;
    case "stats":
      cmdStats(args.slice(1));
      break;
    case "allow":
      cmdAllow(args.slice(1));
      break;
    case "init":
      cmdInit();
      break;
    case "migrate":
      cmdMigrate();
      break;
    case "doctor":
      cmdDoctor(args.slice(1));
      break;
    case "brief":
      printBrief();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(usageForEngine(currentHelpEngine()));
      process.exit(1);
  }
}

async function cmdRun(args: string[]) {
  driftWarnIfStale();
  const runStartedAtMs = Date.now();
  const projectRoot = resolveProjectRoot();
  const validation = validateSetup(projectRoot);

  if (!validation.valid) {
    console.error("Setup validation failed:");
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const config = loadConfig(projectRoot);

  // Parse CLI overrides
  let name: string | undefined;
  let review = true;
  let verifyEnabled = true;
  let issueNumber: number | undefined;
  let issueFixturePath: string | undefined;
  let mode: string | undefined;
  const runOverrides: RunPlanOverrides = { worker: {}, review: {} };
  const envEngine = process.env.DANGERESQUE_ENGINE?.toLowerCase();
  if (envEngine && envEngine !== "claude" && envEngine !== "codex") {
    console.error("DANGERESQUE_ENGINE must be one of: claude, codex");
    process.exit(1);
  }
  if (envEngine === "claude" || envEngine === "codex") {
    runOverrides.worker!.engine = envEngine;
  }
  const envReviewEngine = process.env.DANGERESQUE_REVIEW_ENGINE?.toLowerCase();
  if (envReviewEngine && envReviewEngine !== "claude" && envReviewEngine !== "codex") {
    console.error("DANGERESQUE_REVIEW_ENGINE must be one of: claude, codex");
    process.exit(1);
  }
  if (envReviewEngine === "claude" || envReviewEngine === "codex") {
    runOverrides.review!.engine = envReviewEngine;
  }
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === "--no-review") {
      review = false;
    } else if (args[i] === "--no-verify") {
      verifyEnabled = false;
    } else if (args[i] === "--interactive" || args[i] === "--no-tmux") {
      config.headless = false;
    } else if (args[i] === "--force") {
      force = true;
    } else if (args[i] === "--model" && args[i + 1]) {
      runOverrides.worker!.model = args[++i];
    } else if (args[i] === "--engine" && args[i + 1]) {
      const engine = args[++i].toLowerCase();
      if (engine !== "claude" && engine !== "codex") {
        console.error("--engine must be one of: claude, codex");
        process.exit(1);
      }
      runOverrides.worker!.engine = engine;
    } else if (args[i] === "--review-engine" && args[i + 1]) {
      const engine = args[++i].toLowerCase();
      if (engine !== "claude" && engine !== "codex") {
        console.error("--review-engine must be one of: claude, codex");
        process.exit(1);
      }
      runOverrides.review!.engine = engine;
    } else if (args[i] === "--effort" && args[i + 1]) {
      runOverrides.worker!.effort = args[++i];
    } else if (args[i] === "--review-model" && args[i + 1]) {
      runOverrides.review!.model = args[++i];
    } else if (args[i] === "--review-effort" && args[i + 1]) {
      runOverrides.review!.effort = args[++i];
    } else if (args[i] === "--issue" && args[i + 1]) {
      issueNumber = parseInt(args[++i], 10);
      if (isNaN(issueNumber)) {
        console.error("--issue requires a numeric issue number");
        process.exit(1);
      }
    } else if (args[i] === "--issue-fixture" && args[i + 1]) {
      issueFixturePath = args[++i];
    } else if (args[i] === "--mode" && args[i + 1]) {
      mode = args[++i].toUpperCase();
    }
  }

  let plan: RunPlan;
  try {
    plan = resolveRunPlan(config, runOverrides);
  } catch (err) {
    console.error(`Run configuration invalid: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const effectiveMode = mode ?? "INVESTIGATE";
  const reviewScheduled = review && !SKIP_REVIEW_MODES.has(effectiveMode);
  const scheduledEngines = new Set<Engine>([
    plan.worker.engine,
    ...(reviewScheduled ? [plan.review.engine] : []),
  ]);
  for (const engine of scheduledEngines) {
    const runtimeValidation = validateEngineRuntime(engine, projectRoot);
    if (!runtimeValidation.valid) {
      console.error("Setup validation failed:");
      for (const err of runtimeValidation.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
  }

  const effortValidation = validateCodexModelEfforts(plan, undefined, reviewScheduled);
  if (!effortValidation.valid) {
    console.error("Codex model/effort validation failed:");
    for (const err of effortValidation.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  if (issueNumber !== undefined && issueFixturePath !== undefined) {
    console.error(
      "--issue and --issue-fixture are mutually exclusive. Pass one, not both.",
    );
    process.exit(1);
  }

  if (issueNumber === undefined && issueFixturePath === undefined) {
    console.error(
      "Usage: dangeresque run --issue <N> [options]\n" +
        "   or: dangeresque run --issue-fixture <path> [options]\n\n" +
        "A task source is required. Pass one of:\n" +
        "  --issue <N>              Read task from GitHub Issue #N\n" +
        "  --issue-fixture <path>   Read task from a local JSON fixture",
    );
    process.exit(1);
  }

  // Load issue content from fixture or gh
  let issueData: IssueData;
  const fixtureUsed = issueFixturePath !== undefined;
  if (issueFixturePath !== undefined) {
    try {
      issueData = loadIssueFixture(issueFixturePath);
      issueNumber = issueData.number;
      console.log(
        `Loaded fixture #${issueData.number}: ${issueData.title} (from ${issueFixturePath})`,
      );
    } catch (err) {
      console.error(
        `Failed to load issue fixture: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  } else {
    try {
      issueData = fetchIssue(projectRoot, issueNumber!);
      console.log(`Fetched issue #${issueNumber}: ${issueData.title}`);
    } catch (err) {
      console.error(
        `Failed to fetch issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        "Is `gh` installed and authenticated? Does the issue exist?",
      );
      process.exit(1);
    }
  }

  // Pre-flight gates: refuse to spawn a new worker when an unmerged worktree
  // for the same issue exists, or when local main is ahead of origin. Both
  // are workflow problems where the orchestrator skipped a step; surfacing
  // them up front avoids the silent-stale-base failure mode in #53.
  if (issueNumber !== undefined) {
    const preflight = runPreflightChecks(projectRoot, issueNumber, effectiveMode, { force });
    if (!preflight.ok) {
      console.error(preflight.message);
      process.exit(2);
    }
  }

  // dispatchGate: project-owned enforcement point between preflight and the
  // actual worker spawn. Refusal exits 2 (fail closed). Only runs when the
  // block is present + enabled; absent = no-op. Consumer scripts see the
  // issue and mode via DANGERESQUE_ISSUE / DANGERESQUE_MODE env vars.
  if (issueNumber !== undefined && config.dispatchGate) {
    const gate = applyDispatchGate({
      projectRoot,
      issueNumber,
      mode: effectiveMode,
      config: config.dispatchGate,
      force,
    });
    if (!gate.ok) {
      console.error(gate.message ?? "dispatchGate refused (no message).");
      process.exit(2);
    }
  }

  // Auto-generate name from mode + issue when not explicitly provided
  if (!name && issueNumber) {
    name = `${effectiveMode.toLowerCase()}-${issueNumber}`;
  }

  const isStopRequested = installStopHandler();

  const effectiveWorker = plan.worker;
  const effectiveReview = plan.review;
  const reviewDiffers =
    effectiveReview.engine !== effectiveWorker.engine ||
    effectiveReview.model !== effectiveWorker.model ||
    effectiveReview.effort !== effectiveWorker.effort;

  console.log("\ndangeresque — starting AFK run");
  console.log(`  Project: ${projectRoot}`);
  console.log(`  Issue: #${issueData.number} — ${issueData.title}`);
  console.log(`  Mode: ${effectiveMode}`);
  console.log(`  Engine: ${effectiveWorker.engine}`);
  console.log(`  Model: ${effectiveWorker.model} (effort: ${effectiveWorker.effort})`);
  if (reviewDiffers) {
    console.log(`  Review: ${effectiveReview.engine} · ${effectiveReview.model} (effort: ${effectiveReview.effort})`);
  }
  console.log(`  Mode: ${config.headless ? "headless (-p)" : "interactive"}`);
  console.log(`  Review pass: ${review ? "yes" : "no"}`);

  // Worker pass
  const workerStartedAtMs = Date.now();
  const workerResult = await runWorker({
    projectRoot,
    config,
    plan,
    name,
    issueData,
    mode: effectiveMode,
  });
  const workerEndedAtMs = Date.now();

  const builder = new ArtifactBuilder({
    projectRoot,
    issueNumber,
    ...(fixtureUsed ? { issueUrl: null } : {}),
    mode: effectiveMode,
    engine: effectiveWorker.engine,
    model: effectiveWorker.model,
    effort: effectiveWorker.effort,
    reviewEngine: effectiveReview.engine,
    reviewModel: effectiveReview.model,
    reviewEffort: effectiveReview.effort,
    worktreeName: workerResult.worktreeName,
    branch: workerResult.branch,
    archivePath: workerResult.archivePath,
    startedAtMs: runStartedAtMs,
  });
  builder.setWorkerTiming(workerStartedAtMs, workerEndedAtMs, workerResult.exitCode);
  builder.recordEvent("worker_completed", { exit_code: workerResult.exitCode });

  console.log(`\nWorker exited with code ${workerResult.exitCode}`);

  // Hard-stop on worker failure: loud banner, FAIL comment, non-zero exit.
  // No scope check, no rebase, no review, no success summary.
  if (workerResult.exitCode !== 0) {
    const banner = "!".repeat(60);
    console.error(`\n${banner}`);
    console.error(`!!  DANGERESQUE RUN ${isStopRequested() ? "STOPPED" : "FAILED"}`);
    console.error(`!!  Worker exit code: ${workerResult.exitCode}`);
    console.error(`!!  Worktree: .claude/worktrees/${workerResult.worktreeName}/`);
    console.error(`!!  Branch:   ${workerResult.branch}`);
    console.error(`!!  Artifact: ${workerResult.archivePath}`);
    console.error(`!!`);
    console.error(`!!  Inspect: dangeresque logs ${workerResult.branch}`);
    console.error(`!!  Results: dangeresque results ${workerResult.branch}`);
    console.error(`!!  Cleanup: dangeresque discard ${workerResult.branch}`);
    console.error(`${banner}\n`);

    // Skip the GitHub failure comment when the operator explicitly stopped
    // the run — a stale "FAILED" comment from an aborted run is noise, not
    // signal. Real failures (engine crash, exit code from worker logic)
    // still get reported.
    if (issueNumber && !fixtureUsed && !isStopRequested()) {
      try {
        postRunComment({
          projectRoot,
          issueNumber,
          mode: effectiveMode,
          worktreeName: workerResult.worktreeName,
          archivePath: workerResult.archivePath,
          workerExitCode: workerResult.exitCode,
          engine: effectiveWorker.engine,
          model: effectiveWorker.model,
          effort: effectiveWorker.effort,
          reviewEngine: effectiveReview.engine,
          reviewModel: effectiveReview.model,
          reviewEffort: effectiveReview.effort,
        });
      } catch (err) {
        console.error(
          `Warning: failed to post failure comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    finalizeArtifact(builder, projectRoot);

    process.exit(workerResult.exitCode);
  }

  const outcome = await runPostWorkerPhases({
    projectRoot,
    config,
    plan,
    issueData,
    issueNumber,
    fixtureUsed,
    mode: effectiveMode,
    reviewEnabled: review,
    verifyEnabled,
    builder,
    worktreeName: workerResult.worktreeName,
    branch: workerResult.branch,
    archivePath: workerResult.archivePath,
    workerReceipt: workerResult.receipt,
    isStopRequested,
  });

  if (outcome.exitCode !== 0) {
    process.exit(outcome.exitCode);
  }
}

interface PostWorkerContext {
  projectRoot: string;
  config: DangeresqueConfig;
  plan: RunPlan;
  issueData: IssueData;
  issueNumber?: number;
  fixtureUsed: boolean;
  mode: string;
  reviewEnabled: boolean;
  verifyEnabled: boolean;
  builder: ArtifactBuilder;
  worktreeName: string;
  branch: string;
  archivePath: string;
  workerReceipt: ExecutionReceipt;
  isStopRequested: () => boolean;
}

/**
 * Everything that happens after a successful worker pass: capture of the
 * worker's tree, scope classification, rebase onto origin/main, canonical
 * file-count normalization, pre-review verification, the review pass, the
 * GitHub summary comment, and the artifact write.
 *
 * Shared verbatim by `dangeresque run` (which just produced the worker output)
 * and `dangeresque review` (which recovers a run whose review was killed).
 * One implementation is the point — a rescued review has to be
 * indistinguishable from an in-line one, gates and artifact included.
 */
async function runPostWorkerPhases(
  ctx: PostWorkerContext,
): Promise<{ exitCode: number }> {
  const {
    projectRoot,
    config,
    plan,
    issueData,
    issueNumber,
    fixtureUsed,
    mode,
    reviewEnabled,
    verifyEnabled,
    builder,
    worktreeName,
    branch,
    archivePath,
  } = ctx;
  const effectiveWorker = plan.worker;
  const effectiveReview = plan.review;
  const worktreePath = `${projectRoot}/.claude/worktrees/${worktreeName}`;

  // Capture FIRST (issue #93). Everything below this line reads the branch's
  // commits — the scope check three-dot diff, the rebase, `git merge` at the
  // end of the workflow — while the reviewer and the file-count normalizer
  // read the working tree. A worker whose own git commands were denied leaves
  // those two views disagreeing: the reviewer accepts a diff that ships
  // nothing. Committing here is what makes them the same tree, and it must
  // precede the rebase, which refuses outright over a dirty tree.
  //
  // Guarded on worker success, matching where this used to live (the codex
  // adapter's afterWorkerSuccess hook): capturing a crashed worker's partial
  // tree is a separate policy question, not this fix.
  let uncommitted: string[] = [];
  if (ctx.workerReceipt.exitCode === 0) {
    // The receipt's engine, not the plan's: on the `review` rescue path the
    // plan describes THIS invocation, while the receipt describes the worker
    // that actually produced the tree being captured.
    const workerEngine = ctx.workerReceipt.engine;
    const capture = captureWorkerChanges(worktreePath, {
      issueNumber: issueData.number,
      mode,
      engine: workerEngine,
    });
    if (capture.error) {
      console.error(`\n⚠️  Could not capture the worker's changes: ${capture.error}`);
      builder.recordEvent("worker_changes_capture_failed", { error: capture.error });
    } else if (capture.committed) {
      console.log(
        `\n📦 Captured ${capture.files.length} uncommitted file(s) from the ${workerEngine} worker into a commit on ${branch}`,
      );
      builder.recordEvent("worker_changes_captured", {
        files_changed: capture.files.length,
        engine: workerEngine,
      });
    }
  }

  // Whatever survived capture is work the branch does not carry. Detect it
  // explicitly instead of letting the rebase discover it and report it as a
  // merge conflict.
  try {
    uncommitted = uncommittedPaths(worktreePath);
  } catch (err) {
    console.warn(
      `\nWarning: could not read worktree status: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (uncommitted.length > 0) {
    console.error(
      `\n⚠️  ${uncommitted.length} change(s) remain uncommitted in the worktree — ` +
        `a merge would ship none of them:\n${formatUncommittedPaths(uncommitted)}`,
    );
    builder.recordEvent("worktree_dirty_after_capture", {
      count: uncommitted.length,
      paths: uncommitted.slice(0, 20),
    });
  }

  // Post-worker scope check: classify changed files via the policy engine
  // (allow/deny globs from issue's `dangeresque-scope` blocks + worker's
  // `## Scope Declaration`), then apply project-level opportunistic budget
  // (denyGlobs + maxFiles + maxLines) to demote over-budget extended entries.
  try {
    const { execSync } = await import("node:child_process");
    const { resolveDiffBase } = await import("./worktree.js");
    const diffBase = resolveDiffBase(projectRoot);
    const changedFiles = execSync(`git diff ${diffBase}...HEAD --name-only`, {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter((f) => f);

    const haystack = issueData.body + formatIssueComments(issueData);
    const scopeBlock = parseScopeBlocks(haystack);
    let declarationParse: ScopeDeclarationParse = {
      status: "missing",
      entries: [],
    };
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      if (existsSync(archivePath)) {
        const md = readFileSync(archivePath, "utf-8");
        declarationParse = parseScopeDeclarationSection(md);
      }
    } catch {
      /* ignore — declaration parse failures are non-fatal */
    }
    const scopeDeclaration = declarationParse.entries;
    let scopeReport = classifyChanges({
      changedFiles,
      block: scopeBlock,
      declaration: scopeDeclaration,
      declarationStatus: declarationParse.status,
    });

    const opportunisticCfg = config.scope?.opportunistic;
    if (opportunisticCfg) {
      const numstat = (() => {
        try {
          return execSync(`git diff ${diffBase}...HEAD --numstat`, {
            cwd: worktreePath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          return "";
        }
      })();
      scopeReport = applyOpportunisticBudget(
        scopeReport,
        opportunisticCfg,
        parseNumstat(numstat),
      );
    }

    builder.setScopeBlock(scopeBlock);
    builder.setScopeDeclaration(scopeDeclaration);
    builder.setScopeReport(scopeReport);
    builder.recordEvent("scope_check_completed", {
      changed_files: changedFiles.length,
      in_scope: scopeReport.in_scope.length,
      extended: scopeReport.extended.length,
      outside: scopeReport.outside.length,
      declaration_status: scopeReport.declaration_status,
    });

    // Demote the operator-facing warning. For code-changing modes the reviewer
    // adjudicates `outside` entries — printing here would double-noise. For
    // INVESTIGATE/VERIFY (review skipped), surface a single structured line
    // so the operator can spot drift at a glance.
    if (SKIP_REVIEW_MODES.has(mode)) {
      console.log(
        `\nScope: in=${scopeReport.in_scope.length} extended=${scopeReport.extended.length} outside=${scopeReport.outside.length}`,
      );
    }
  } catch {
    // Silently ignore — worktree state query failures aren't fatal here
  }

  // First checkpoint: the worker's outcome is final and classified. Everything
  // from here on can be killed by an outside signal (issue #96), and this write
  // is what lets `dangeresque review` recover instead of starting over.
  checkpointArtifact(builder, projectRoot, "post_worker");

  // Rebase worktree onto latest origin/main before review.
  // Prevents false REJECT from reviewer seeing stale-branch diffs.
  // Every failure mode is now named for what it is: this block used to print
  // and record "conflict" for all of them, including a dirty tree (which makes
  // git refuse to start the rebase at all) and a failed fetch (#93).
  if (reviewEnabled) {
    const outcome = rebaseWorktreeOntoOrigin(worktreePath);
    switch (outcome.status) {
      case "rebased":
        console.log(`\nRebased worktree onto latest origin/main`);
        builder.recordEvent("rebase_completed");
        break;
      case "skipped_dirty":
        console.warn(
          `\n⚠️  Rebase skipped — ${outcome.paths.length} uncommitted change(s) in the worktree ` +
            `(git refuses to rebase a dirty tree). This is NOT a merge conflict.`,
        );
        builder.recordEvent("rebase_skipped", {
          reason: "dirty_worktree",
          uncommitted: outcome.paths.length,
        });
        break;
      case "fetch_failed":
        console.warn(
          `\n⚠️  Rebase skipped — could not fetch origin/main: ${outcome.error}`,
        );
        builder.recordEvent("rebase_skipped", { reason: "fetch_failed", error: outcome.error });
        break;
      case "conflict":
        console.warn(
          `\n⚠️  Rebase hit a conflict (aborted) — reviewer will see original diff:\n${outcome.error}`,
        );
        builder.recordEvent("rebase_failed", { conflict: true, error: outcome.error });
        break;
      case "failed":
        console.warn(
          `\n⚠️  Rebase failed (no conflict — git refused to run it):\n${outcome.error}`,
        );
        builder.recordEvent("rebase_failed", { conflict: false, error: outcome.error });
        break;
    }
  }

  // Canonical SUMMARY file count: rewrite the worker's `Files: ...` line in
  // the run-artifact .md from a hand-typed summary to a CLI-derived count.
  // Runs post-rebase so the canonical count is computed from the same tree
  // the reviewer's diff query sees — they cannot mismatch by construction.
  // Warn-and-degrades on any failure; never blocks the run.
  {
    const { resolveDiffBase } = await import("./worktree.js");
    const diffBase = resolveDiffBase(projectRoot);
    normalizeSummaryFileCount({
      worktreePath,
      archivePath,
      diffBase,
      builder,
    });
  }

  // Pre-review verification: run configured compile/test/lint commands in the
  // worktree so the reviewer (text-only) gets a ground-truth signal for "build
  // passes" / "tests pass" claims. Block-style failures skip the review pass
  // entirely — reviewing un-compiling code wastes effort. Warn-style failures
  // record into the artifact and are surfaced to the reviewer's prompt.
  let verificationOutcome: VerificationOutcome | null = null;
  if (verifyEnabled && config.verify && shouldRunVerify(mode, config.verify)) {
    console.log(`\nRunning ${config.verify.commands.length} verification command(s)…`);
    verificationOutcome = runVerification({
      worktreePath,
      archivePath,
      config: config.verify,
      builder,
    });
    builder.setVerification(verificationOutcome.results);
  } else if (!verifyEnabled) {
    console.log(`\nSkipping verification (--no-verify)`);
    builder.recordEvent("verification_skipped", { reason: "--no-verify" });
  } else if (config.verify && config.verify.commands.length === 0) {
    builder.recordEvent("verification_skipped", { reason: "no_commands_configured" });
  } else if (config.verify && !config.verify.enabled) {
    builder.recordEvent("verification_skipped", { reason: "disabled_in_config" });
  } else if (config.verify && !config.verify.modes.includes(mode)) {
    builder.recordEvent("verification_skipped", { reason: `mode_not_in_list:${mode}` });
  }

  // Second checkpoint: immediately before the review dispatch. This is the
  // exact window where an outside SIGTERM stranded bc#679 — a run killed here
  // now leaves a readable artifact with the verification results intact.
  checkpointArtifact(builder, projectRoot, "pre_review");

  // Review pass — skip for modes that don't produce code changes
  let reviewExitCode: number | undefined;
  if (verificationOutcome?.blocked) {
    const blockedBy = verificationOutcome.blockedBy ?? "unknown";
    const banner = "!".repeat(60);
    console.error(`\n${banner}`);
    console.error(`!!  DANGERESQUE RUN FAILED — verification blocked`);
    console.error(`!!  Failing command: ${blockedBy}`);
    console.error(`!!  Worktree: .claude/worktrees/${worktreeName}/`);
    console.error(`!!  Branch:   ${branch}`);
    console.error(`!!  Artifact: ${archivePath}`);
    console.error(`!!`);
    console.error(`!!  Inspect: dangeresque results ${branch}`);
    console.error(`!!  Cleanup: dangeresque discard ${branch}`);
    console.error(`${banner}\n`);
    builder.markReviewSkipped(`verification_failed:${blockedBy}`);
  } else if (reviewEnabled && SKIP_REVIEW_MODES.has(mode)) {
    console.log(`\nSkipping review (no code changes in ${mode} mode)`);
    builder.markReviewSkipped(`mode=${mode}`);
  } else if (reviewEnabled) {
    const reviewStartedAtMs = Date.now();
    const reviewResult = await runReview(
      { projectRoot, config, plan, issueData, mode },
      worktreeName,
      archivePath,
      ctx.workerReceipt,
      verificationOutcome,
    );
    const reviewEndedAtMs = Date.now();
    reviewExitCode = reviewResult.exitCode;
    builder.setReviewTiming(reviewStartedAtMs, reviewEndedAtMs, reviewResult.exitCode);
    builder.recordEvent("review_completed", { exit_code: reviewResult.exitCode });
    console.log(`Review exited with code ${reviewResult.exitCode}`);
  } else {
    builder.markReviewSkipped("--no-review");
  }

  // A review that exits non-zero did not complete normally — killed by a
  // signal (bc#679, exit 143) or dead on a transient engine error (bc#667,
  // exit 1). Both strand the run identically: no reliable verdict, so no merge.
  // Report it as loudly as a worker failure instead of letting a success-shaped
  // summary imply the run finished (issue #96). Note a clean review (exit 0) is
  // never "aborted", even if a stop signal lands while we report it.
  const reviewAborted = reviewExitCode !== undefined && reviewExitCode !== 0;

  if (reviewAborted) {
    builder.recordEvent("review_aborted", {
      exit_code: reviewExitCode,
      stop_requested: ctx.isStopRequested(),
    });
    const banner = "!".repeat(60);
    console.error(`\n${banner}`);
    console.error(`!!  DANGERESQUE REVIEW DID NOT COMPLETE — verdict unreliable`);
    console.error(`!!  Review exit code: ${describeAbnormalExit(reviewExitCode!)}`);
    console.error(`!!  The worker's changes are committed and intact.`);
    console.error(`!!  Worktree: .claude/worktrees/${worktreeName}/`);
    console.error(`!!  Branch:   ${branch}`);
    console.error(`!!  Artifact: ${archivePath}`);
    console.error(`!!`);
    console.error(`!!  Re-run ONLY the review — the worker output is kept:`);
    console.error(`!!    dangeresque review ${branch}`);
    console.error(`${banner}\n`);
  }

  // Post summary comment on issue
  if (issueNumber && !fixtureUsed) {
    try {
      postRunComment({
        projectRoot,
        issueNumber,
        mode,
        worktreeName,
        archivePath,
        workerExitCode: ctx.workerReceipt.exitCode,
        reviewExitCode,
        reviewAborted,
        engine: effectiveWorker.engine,
        model: effectiveWorker.model,
        effort: effectiveWorker.effort,
        reviewEngine: effectiveReview.engine,
        reviewModel: effectiveReview.model,
        reviewEffort: effectiveReview.effort,
      });
    } catch (err) {
      console.error(
        `Warning: failed to post comment on #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const artifact = finalizeArtifact(builder, projectRoot);

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`dangeresque run complete`);
  console.log(`  Worktree: .claude/worktrees/${worktreeName}/`);
  console.log(`  Branch:   ${branch}`);
  console.log(`  Artifact: ${archivePath}`);
  if (artifact) {
    console.log(`  Eval:     ${artifact.artifact_paths.json}`);
    console.log(`  Result:   ${artifact.result} (verdict=${artifact.reviewer_verdict})`);
  }

  const header = formatRunHeader(jsonPathForArchive(archivePath));
  if (header) {
    console.log("");
    console.log(header);
  }

  console.log(`\nNext steps:`);
  if (reviewAborted) {
    console.log(`  Re-review: dangeresque review ${branch}   (keeps the worker's committed output)`);
  }
  console.log(`  Review:  dangeresque results ${branch}`);
  console.log(`  Merge:   dangeresque merge ${branch}     (keeps the run report in .dangeresque/runs/)`);
  console.log(`  Discard: dangeresque discard ${branch}   (deletes the run report along with the worktree)`);
  console.log("=".repeat(60));

  if (verificationOutcome?.blocked || reviewAborted) {
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}

/** Render an exit code, naming the signal when the process died to one. */
function describeAbnormalExit(exitCode: number): string {
  if (exitCode < 128) return String(exitCode);
  const signalNumber = exitCode - 128;
  const name = Object.entries(osConstants.signals).find(
    ([, num]) => num === signalNumber,
  )?.[0];
  return name ? `${exitCode} (killed by ${name})` : `${exitCode} (killed by signal ${signalNumber})`;
}

/**
 * Install the SIGTERM/SIGINT handler that lets an external `dangeresque stop`
 * (or operator Ctrl-C) abort the engine cleanly: we signal the child and let
 * its `close` event resolve the phase with a non-zero exit code, so the caller
 * takes its normal failure path. Returns a predicate for whether a stop was
 * requested — used to distinguish an operator abort from a real failure.
 */
function installStopHandler(): () => boolean {
  let stopRequested = false;
  const onStopSignal = (signal: NodeJS.Signals) => {
    if (stopRequested) return;
    stopRequested = true;
    console.error(`\nReceived ${signal} — stopping engine and aborting run.`);
    killActiveEngines("SIGTERM");
    setTimeout(() => {
      killActiveEngines("SIGKILL");
    }, 5000).unref();
  };
  process.on("SIGTERM", () => onStopSignal("SIGTERM"));
  process.on("SIGINT", () => onStopSignal("SIGINT"));
  return () => stopRequested;
}

/**
 * Write the artifact mid-run so a kill leaves a readable record of how far the
 * run got. Warn-and-degrade: a checkpoint failure must never abort a run that
 * is otherwise progressing (issue #96).
 */
function checkpointArtifact(
  builder: ArtifactBuilder,
  projectRoot: string,
  phase: string,
): void {
  builder.recordEvent("artifact_checkpointed", { phase });
  try {
    writeArtifact(builder.build(), projectRoot);
  } catch (err) {
    console.error(
      `Warning: failed to checkpoint run evaluation artifact at ${phase}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function finalizeArtifact(builder: ArtifactBuilder, projectRoot: string) {
  try {
    const artifact = builder.build();
    writeArtifact(artifact, projectRoot);
    return artifact;
  } catch (err) {
    console.error(
      `Warning: failed to write run evaluation artifact: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function cmdLogs(args: string[]) {
  const projectRoot = resolveProjectRoot();
  const worktrees = listWorktrees(projectRoot);

  const KNOWN_FLAGS = new Set(["--raw", "--review", "-f", "--follow"]);
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  const raw = args.includes("--raw");
  const review = args.includes("--review");
  const followFlag = args.includes("-f") || args.includes("--follow");
  const positional = args.find((a) => !a.startsWith("-"));
  const usedPicker = !positional;

  const chosen = await resolvePositionalOrPick(
    positional,
    worktrees,
    "all",
    "Select a worktree to view logs for",
  );
  if (!chosen) {
    console.error(formatMissingTargetError("logs", "<branch>", worktrees));
    process.exit(1);
  }

  const branch = resolveBranch(projectRoot, chosen);
  const target = worktrees.find((wt) => wt.branch === branch);
  if (!target) {
    console.error(`Worktree not found for branch: ${branch}`);
    process.exit(1);
  }

  // Read PID file for session IDs
  const pidInfo = readPidFile(target.path);
  if (!pidInfo) {
    console.error(
      `No PID file found in ${target.path} — run predates session tracking`,
    );
    process.exit(1);
  }

  const phase = selectLogPhase(pidInfo, {
    forceReview: review,
    running: target.running,
  });
  const sessionPath = resolveSessionPath(pidInfo, phase, target.path);
  if (!sessionPath) {
    console.error(`No ${phase} session ID tracked for this run`);
    process.exit(1);
  }

  console.error(
    `Branch: ${target.branch}  Phase: ${phase}  ${target.running ? "RUNNING" : "IDLE"}`,
  );

  const follow = followFlag || (usedPicker && target.running);
  await tailLog({
    sessionPath,
    follow,
    raw,
    pid: target.running ? pidInfo.pid : undefined,
  });

  if (target.running && !follow) {
    console.error(
      "\nworker is RUNNING — pass -f/--follow to tail live output",
    );
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortBranch(branch: string): string {
  return branch.replace(/^worktree-dangeresque-/, "");
}

async function resolvePositionalOrPick(
  positional: string | undefined,
  worktrees: WorktreeInfo[],
  filter: WorktreeFilter,
  label: string,
): Promise<string | undefined> {
  if (positional) return positional;
  const picked = await pickWorktree(filterWorktrees(worktrees, filter), {
    label,
  });
  return picked?.branch;
}

function formatMissingTargetError(
  cmd: string,
  argName: string,
  worktrees: WorktreeInfo[],
): string {
  let msg = `Usage: dangeresque ${cmd} ${argName} [options]\n\n`;
  if (worktrees.length === 0) {
    msg += "No active dangeresque worktrees.";
    return msg;
  }
  msg += "Active worktrees:\n";
  for (const wt of worktrees) {
    const name = shortBranch(wt.branch);
    let state = "IDLE";
    if (wt.running && wt.pidInfo) {
      const elapsed = formatElapsed(Date.now() - wt.pidInfo.startedAt);
      state = `RUNNING (pid ${wt.pidInfo.pid}, ${elapsed} elapsed)`;
    } else if (wt.pidInfo && !wt.running) {
      state = "IDLE (worker exited)";
    }
    msg += `  ${name.padEnd(20)} ${state}\n`;
  }
  msg += `\nPass one explicitly, e.g.: dangeresque ${cmd} ${shortBranch(worktrees[0].branch)}`;
  return msg;
}

function cmdStatus() {
  const projectRoot = resolveProjectRoot();
  const worktrees = listWorktrees(projectRoot);

  if (worktrees.length === 0) {
    console.log(`No active dangeresque worktrees (cwd=${process.cwd()})`);
    return;
  }

  console.log(`Active dangeresque worktrees (${worktrees.length}):\n`);
  for (const wt of worktrees) {
    let state = "IDLE";
    if (wt.running && wt.pidInfo) {
      const elapsed = formatElapsed(Date.now() - wt.pidInfo.startedAt);
      state = `RUNNING (pid ${wt.pidInfo.pid}, ${elapsed} elapsed)`;
    } else if (wt.pidInfo && !wt.running) {
      state = "IDLE (worker exited)";
    }

    console.log(`  Branch: ${wt.branch}  ${state}`);
    console.log(`  Path:   ${wt.path}`);
    console.log(`  HEAD:   ${wt.head.slice(0, 8)}`);
    if (wt.pidInfo) {
      for (const line of formatPidExecution(wt.pidInfo)) console.log(line);
    }
    if (wt.pidInfo?.phase) {
      console.log(`  Phase:  ${wt.pidInfo.phase}`);
    }
    for (const line of formatResultsGuidance({
      branch: wt.branch,
      issueNumber: extractIssueNumber(wt.branch),
      running: wt.running,
    })) {
      console.log(line);
    }
    console.log();
  }
}

/**
 * Re-run ONLY the review pass against an existing worktree whose worker
 * finished but whose review never produced a verdict — a review killed by an
 * outside signal, a transient engine error, or a crashed session (issues #92,
 * #96). The worker's committed output is left untouched; this replays the same
 * post-worker pipeline `run` uses, so the resulting artifact is identical in
 * shape and the merge gate can read a real verdict from it.
 *
 * Crash recovery only: a run that already carries a verdict is refused unless
 * `--force`, so this can never become a quiet "review until it passes" loop.
 */
async function cmdReview(args: string[]) {
  driftWarnIfStale();
  const projectRoot = resolveProjectRoot();
  const validation = validateSetup(projectRoot);
  if (!validation.valid) {
    console.error("Setup validation failed:");
    for (const err of validation.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  const config = loadConfig(projectRoot);

  let force = false;
  let verifyEnabled = true;
  let dryRun = false;
  let target: string | undefined;
  let issueOverride: number | undefined;
  let modeOverride: string | undefined;
  const runOverrides: RunPlanOverrides = { worker: {}, review: {} };

  const envReviewEngine = process.env.DANGERESQUE_REVIEW_ENGINE?.toLowerCase();
  if (envReviewEngine && envReviewEngine !== "claude" && envReviewEngine !== "codex") {
    console.error("DANGERESQUE_REVIEW_ENGINE must be one of: claude, codex");
    process.exit(1);
  }
  if (envReviewEngine === "claude" || envReviewEngine === "codex") {
    runOverrides.review!.engine = envReviewEngine;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--no-verify") {
      verifyEnabled = false;
    } else if (arg === "--review-engine" && args[i + 1]) {
      const engine = args[++i].toLowerCase();
      if (engine !== "claude" && engine !== "codex") {
        console.error("--review-engine must be one of: claude, codex");
        process.exit(1);
      }
      runOverrides.review!.engine = engine;
    } else if (arg === "--review-model" && args[i + 1]) {
      runOverrides.review!.model = args[++i];
    } else if (arg === "--review-effort" && args[i + 1]) {
      runOverrides.review!.effort = args[++i];
    } else if (arg === "--issue" && args[i + 1]) {
      issueOverride = parseInt(args[++i], 10);
      if (isNaN(issueOverride)) {
        console.error("--issue requires a numeric issue number");
        process.exit(1);
      }
    } else if (arg === "--mode" && args[i + 1]) {
      modeOverride = args[++i].toUpperCase();
    } else if (!arg.startsWith("-") && target === undefined) {
      target = arg;
    }
  }

  const worktrees = listWorktrees(projectRoot);
  const chosen = await resolvePositionalOrPick(
    target,
    worktrees,
    "finished",
    "Select a worktree to re-review",
  );
  if (!chosen) {
    console.error(formatMissingTargetError("review", "<branch>", worktrees));
    process.exit(1);
  }

  let branch: string;
  try {
    assertInMainCheckout(projectRoot, "review");
    branch = resolveBranch(projectRoot, chosen);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const worktreeName = branch.replace("worktree-", "");
  const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);

  // Identity resolution, most-explicit first. Branch parsing handles the
  // conventional shape including multi-slice names (`implement-123-slice-a`);
  // the worktree's own runs dir covers fully custom `--name` values that encode
  // neither; the flags are the escape hatch when both fail.
  const issueNumber =
    issueOverride ?? extractIssueNumber(branch) ?? deriveIssueNumberFromWorktree(worktreePath);
  const parsedMode = extractMode(branch);
  const mode =
    modeOverride ??
    (parsedMode !== "UNKNOWN"
      ? parsedMode
      : (issueNumber !== undefined
          ? deriveModeFromWorktree(worktreePath, issueNumber)
          : undefined) ?? parsedMode);

  const refuse = (reason: string, hints: string[] = []): never => {
    console.error(`ERROR: refusing to re-review ${branch} because -`);
    console.error(`- ${reason}`);
    if (hints.length > 0) {
      console.error("");
      for (const hint of hints) console.error(hint);
    }
    process.exit(2);
  };

  if (!existsSync(worktreePath)) {
    refuse(`its worktree is gone (${worktreePath})`, [
      "A review needs the worker's worktree. Nothing to recover here.",
    ]);
  }
  if (issueNumber === undefined) {
    refuse(`no issue number could be derived from the branch name or its worktree`, [
      "Review rescue re-fetches the issue to rebuild the reviewer's prompt.",
      `Name it explicitly: dangeresque review ${branch} --issue <N>`,
    ]);
  }
  if (mode === "UNKNOWN") {
    refuse(`no mode could be derived from the branch name or its run artifacts`, [
      `Name it explicitly: dangeresque review ${branch} --mode IMPLEMENT`,
    ]);
  }

  const located = locateLatestRun(worktreePath, issueNumber!, mode);
  const info = worktrees.find((w) => w.branch === branch);
  const assessment = assessReviewRescue({
    mode,
    located,
    workerRunning: info?.running ?? false,
    force,
  });
  if (!assessment.ok) {
    const hints =
      assessment.existingVerdict !== undefined
        ? [
            `Inspect it first: dangeresque results ${branch}`,
            `Override only if that verdict came from a review you know was broken:`,
            `  dangeresque review ${branch} --force`,
          ]
        : [`Inspect the run: dangeresque results ${branch}`];
    refuse(assessment.reason!, hints);
  }

  let plan: RunPlan;
  try {
    plan = resolveRunPlan(config, runOverrides);
  } catch (err) {
    console.error(`Run configuration invalid: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const runtimeValidation = validateEngineRuntime(plan.review.engine, projectRoot);
  if (!runtimeValidation.valid) {
    console.error("Setup validation failed:");
    for (const err of runtimeValidation.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  const effortValidation = validateCodexModelEfforts(plan, undefined, true);
  if (!effortValidation.valid) {
    console.error("Codex model/effort validation failed:");
    for (const err of effortValidation.errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  let issueData: IssueData;
  try {
    issueData = fetchIssue(projectRoot, issueNumber!);
  } catch (err) {
    console.error(
      `Failed to fetch issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("Is `gh` installed and authenticated? Does the issue exist?");
    process.exit(1);
  }

  const recovered = recoverWorkerPhase(located!);
  const checkpoint = located!.artifact;
  // Prefer what the original run recorded about its own worker; fall back to
  // the current plan when the kill left no checkpoint behind.
  const workerEngine = (checkpoint?.engine as Engine | undefined) ?? plan.worker.engine;
  const workerModel = checkpoint?.model ?? plan.worker.model;
  const workerEffort = checkpoint?.effort ?? plan.worker.effort;

  console.log(`\ndangeresque — review rescue${dryRun ? " (dry run)" : ""}`);
  console.log(`  Project: ${projectRoot}`);
  console.log(`  Issue: #${issueData.number} — ${issueData.title}`);
  console.log(`  Branch:  ${branch}`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Run artifact: ${relative(projectRoot, located!.mdPath)}`);
  console.log(
    `  Worker phase: ${recovered.derived ? "reconstructed from artifact file (no checkpoint survived)" : "read from checkpoint"}`,
  );
  console.log(`  Review: ${plan.review.engine} · ${plan.review.model} (effort: ${plan.review.effort})`);
  if (assessment.existingVerdict !== undefined) {
    console.log(`  Overriding existing verdict: ${assessment.existingVerdict} (--force)`);
  }

  if (dryRun) {
    console.log(
      `\nEligible for rescue. Nothing was changed and no review was dispatched.\n` +
        `Run it for real with:\n  dangeresque review ${branch}${force ? " --force" : ""}`,
    );
    return;
  }

  const isStopRequested = installStopHandler();

  const builder = new ArtifactBuilder({
    projectRoot,
    issueNumber,
    mode,
    engine: workerEngine,
    model: workerModel,
    effort: workerEffort ?? undefined,
    reviewEngine: plan.review.engine,
    reviewModel: plan.review.model,
    reviewEffort: plan.review.effort,
    worktreeName,
    branch,
    archivePath: located!.mdPath,
    startedAtMs: recovered.startedAtMs,
    ...(checkpoint?.run_id ? { runId: checkpoint.run_id } : {}),
    ...(checkpoint?.lifecycle_events ? { seedEvents: checkpoint.lifecycle_events } : {}),
  });
  builder.setWorkerTiming(recovered.startedAtMs, recovered.endedAtMs, recovered.exitCode);
  builder.recordEvent("review_rescued", {
    checkpoint_found: checkpoint !== null,
    worker_timing: recovered.derived ? "reconstructed" : "checkpoint",
    previous_review_exit_code: checkpoint?.review?.exit_code,
    ...(assessment.existingVerdict !== undefined
      ? { overridden_verdict: assessment.existingVerdict, forced: force }
      : {}),
  });

  const workerReceipt: ExecutionReceipt = {
    engine: workerEngine,
    model: workerModel,
    effort: workerEffort ?? plan.worker.effort,
    exitCode: recovered.exitCode,
  };

  const outcome = await runPostWorkerPhases({
    projectRoot,
    config,
    plan,
    issueData,
    issueNumber,
    fixtureUsed: false,
    mode,
    reviewEnabled: true,
    verifyEnabled,
    builder,
    worktreeName,
    branch,
    archivePath: located!.mdPath,
    workerReceipt,
    isStopRequested,
  });

  if (outcome.exitCode !== 0) {
    process.exit(outcome.exitCode);
  }
}

async function cmdMerge(args: string[]) {
  const projectRoot = resolveProjectRoot();
  const rescue = args.includes("--rescue");
  const reason = readFlagValue(args, "--reason");
  // The branch is the first positional that is not itself a flag's value —
  // `--reason "text"` would otherwise be picked up as the branch name.
  const positional = findPositional(args, ["--reason"]);
  const worktrees = listWorktrees(projectRoot);

  if (reason !== undefined && !rescue) {
    console.error("ERROR: --reason applies only to --rescue.");
    console.error('Usage: dangeresque merge <branch> --rescue --reason "<why>"');
    process.exit(1);
  }
  if (reason !== undefined && reason.trim() === "") {
    console.error("ERROR: --reason needs text explaining why the verdict is overridden.");
    process.exit(1);
  }

  const chosen = await resolvePositionalOrPick(
    positional,
    worktrees,
    "finished",
    "Select a worktree to merge",
  );
  if (!chosen) {
    console.error('Usage: dangeresque merge <branch> [--rescue [--reason "<why>"]]');
    console.error("Run 'dangeresque status' to see active worktrees");
    process.exit(1);
  }

  try {
    assertInMainCheckout(projectRoot, "merge");
    const resolved = resolveBranch(projectRoot, chosen);
    const config = loadConfig(projectRoot);
    const result = mergeWorktree(
      projectRoot,
      resolved,
      config.mergeGate,
      rescue ? { reason } : undefined,
    );

    if (result.success) {
      console.log(result.message);
      if (result.rescue) publishRescue(projectRoot, resolved, result.rescue);
    } else {
      console.error(result.message);
      process.exit(result.gateRefusal ? 2 : 1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Record a rescue on the GitHub issue.
 *
 * The run artifact already carries the audit record, but it lives in a
 * gitignored directory — weaker durability than the sentinel commit the rescue
 * waived. A comment on the issue puts the override somewhere a reader who never
 * touches this checkout can still find it. Best-effort: the merge has already
 * landed, so a failure here warns and names the record on disk rather than
 * pretending the merge did not happen.
 */
function publishRescue(
  projectRoot: string,
  branch: string,
  record: RescueRecord,
): void {
  const issueNumber = extractIssueNumber(branch);
  if (issueNumber === undefined) {
    console.warn(
      `⚠️  Rescue recorded in the run artifact, but the branch name carries no ` +
        `issue number, so nothing was posted to GitHub.`,
    );
    return;
  }

  const evidence =
    record.kind === "micro_fix"
      ? `**Authorized by:** USER-approved micro-fix commit(s) — ` +
        record.sentinel_commits.map((c) => `\`${c.sha.slice(0, 8)}\` ${c.subject}`).join("; ")
      : `**Authorized by:** USER reason, with no code change since the review.\n` +
        `> ${record.reason ?? "(none recorded)"}\n\n` +
        (record.code_unchanged
          ? `**Proof:** no commit landed on \`${branch}\` after the review ended at ` +
            `${record.code_unchanged.review_ended_at}; merged head ` +
            `\`${record.code_unchanged.head_sha.slice(0, 8)}\`.`
          : `**Proof:** not recorded.`);

  const body =
    `**[rescue]** Merged \`${branch}\` over a \`${record.overridden_verdict}\` review verdict.\n\n` +
    `${evidence}\n\n` +
    `Verification gates still ran; only the round-2 worker round-trip was waived. ` +
    `Full audit record is in this run's artifact JSON under \`rescue\`.`;

  const posted = postIssueComment(projectRoot, issueNumber, body);
  if (posted.success) {
    console.log(`Recorded the rescue on issue #${issueNumber}.`);
    return;
  }
  console.warn(
    `⚠️  Rescue is recorded in the run artifact but could NOT be posted to ` +
      `issue #${issueNumber}: ${posted.message}`,
  );
}

/**
 * Value of a `--flag value` / `--flag=value` pair, or undefined when absent.
 * Returns "" for a flag given with no value so callers can reject it.
 */
function readFlagValue(args: string[], flag: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const next = args[at + 1];
  return next === undefined || next.startsWith("-") ? "" : next;
}

/** First positional argument, skipping flags and any value they consume. */
function findPositional(args: string[], valueFlags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      // `--flag=value` carries its own value; `--flag value` eats the next arg.
      if (valueFlags.includes(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

async function cmdDiscard(args: string[]) {
  const projectRoot = resolveProjectRoot();
  const force = args.includes("--force");
  const positional = args.find((a) => !a.startsWith("-"));
  const worktrees = listWorktrees(projectRoot);

  // With --force, the user is explicitly asking to discard running worktrees
  // too, so the picker should surface them. Otherwise keep the long-standing
  // "finished" UX hint (and rely on the in-function PID gate as the real check).
  const chosen = await resolvePositionalOrPick(
    positional,
    worktrees,
    force ? "all" : "finished",
    "Select a worktree to discard",
  );
  if (!chosen) {
    console.error("Usage: dangeresque discard <branch> [--force]");
    console.error("Run 'dangeresque status' to see active worktrees");
    process.exit(1);
  }

  try {
    assertInMainCheckout(projectRoot, "discard");
    const resolved = resolveBranch(projectRoot, chosen);
    const result = await discardWorktree(projectRoot, resolved, { force });

    if (result.success) {
      console.log(result.message);
    } else {
      console.error(result.message);
      process.exit(result.gateRefusal ? 2 : 1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdStop(args: string[]) {
  const projectRoot = resolveProjectRoot();
  const positional = args.find((a) => !a.startsWith("-"));
  const worktrees = listWorktrees(projectRoot);

  const chosen = await resolvePositionalOrPick(
    positional,
    worktrees,
    "running",
    "Select a running worker to stop",
  );
  if (!chosen) {
    console.error("Usage: dangeresque stop <branch>");
    console.error("Run 'dangeresque status' to see running workers");
    process.exit(1);
  }

  try {
    assertInMainCheckout(projectRoot, "stop");
    const resolved = resolveBranch(projectRoot, chosen);
    const result = await stopWorktree(projectRoot, resolved);

    if (result.success) {
      console.log(result.message);
    } else {
      console.error(result.message);
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdResults(args: string[]) {
  const projectRoot = resolveProjectRoot();

  // Check for --issue flag (show archived results)
  const issueIdx = args.indexOf("--issue");
  if (issueIdx !== -1 && args[issueIdx + 1]) {
    const issueNumber = parseInt(args[issueIdx + 1], 10);
    if (isNaN(issueNumber)) {
      console.error("--issue requires a numeric issue number");
      process.exit(1);
    }
    const showAll = args.includes("--all");
    const output = getArchivedResults(projectRoot, issueNumber, showAll);
    console.log(output);
    return;
  }

  const KNOWN_FLAGS = new Set<string>();
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  const positional = args.find((a) => !a.startsWith("-"));
  const worktrees = listWorktrees(projectRoot);
  const chosen = await resolvePositionalOrPick(
    positional,
    worktrees,
    "all",
    "Select a worktree to show results for",
  );
  if (!chosen) {
    console.error(formatMissingTargetError("results", "<branch>", worktrees));
    process.exit(1);
  }

  let branch: string;
  try {
    branch = resolveBranch(projectRoot, chosen);
  } catch {
    branch = chosen; // Fall through to getWorktreeResults which has its own error message
  }

  const output = getWorktreeResults(projectRoot, branch);
  console.log(output);
}

function cmdClean(args: string[]) {
  const issueIdx = args.indexOf("--issue");
  if (issueIdx === -1 || !args[issueIdx + 1]) {
    console.error("Usage: dangeresque clean --issue <N>");
    process.exit(1);
  }

  const issueNumber = parseInt(args[issueIdx + 1], 10);
  if (isNaN(issueNumber)) {
    console.error("--issue requires a numeric issue number");
    process.exit(1);
  }

  const projectRoot = resolveProjectRoot();
  const result = cleanArchivedRuns(projectRoot, issueNumber);

  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function cmdStats(args: string[]) {
  let issueNumber: number | undefined;
  let engine: Engine | undefined;
  let mode: string | undefined;

  if (args.includes("--glossary")) {
    if (args.length > 1) {
      console.error("--glossary cannot be combined with other stats options");
      process.exit(1);
    }
    process.stdout.write(statsGlossary());
    process.exit(0);
  }

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--issue") {
      const next = args[++i];
      if (next === undefined) {
        console.error("--issue requires a numeric issue number");
        process.exit(1);
      }
      const n = parseInt(next, 10);
      if (isNaN(n)) {
        console.error("--issue requires a numeric issue number");
        process.exit(1);
      }
      issueNumber = n;
    } else if (tok === "--engine") {
      const next = args[++i];
      if (next !== "claude" && next !== "codex") {
        console.error("--engine must be one of: claude, codex");
        process.exit(1);
      }
      engine = next;
    } else if (tok === "--mode") {
      const next = args[++i];
      if (next === undefined) {
        console.error("--mode requires a mode name");
        process.exit(1);
      }
      mode = next.toUpperCase();
    } else {
      console.error(`Unknown flag: ${tok}`);
      process.exit(1);
    }
  }

  const projectRoot = resolveProjectRoot();
  const filters: GatherOptions = {};
  if (issueNumber !== undefined) filters.issueNumber = issueNumber;
  if (engine) filters.engine = engine;
  if (mode) filters.mode = mode;

  const result = gatherArtifacts(projectRoot, filters);
  const displayPath = relative(projectRoot, result.runsDir) || result.runsDir;

  if (!result.dirExists || result.filesScanned === 0) {
    console.log(`No run artifacts found at ${displayPath}`);
    process.exit(0);
  }

  if (result.parseErrorPaths.length > 0) {
    console.error(
      `Warning: ${result.parseErrorPaths.length} file(s) failed to parse as JSON:`,
    );
    for (const p of result.parseErrorPaths) {
      console.error(`  ${p}`);
    }
  }

  const summary = computeStats(result.artifacts);
  const text = formatStats(summary, {
    runsDir: displayPath,
    filters,
    schemaVersions: result.schemaVersions,
    parseErrorCount: result.parseErrorPaths.length,
    unsupportedVersions: result.unsupportedVersions,
    filesScanned: result.filesScanned,
  });
  process.stdout.write(text);
}

function cmdStage(args: string[]) {
  if (args.length === 0) {
    console.error(
      'Usage: dangeresque stage <issue-number> --comment "text" [--mode MODE]',
    );
    process.exit(1);
  }

  const issueNumber = parseInt(args[0], 10);
  if (isNaN(issueNumber)) {
    console.error("First argument must be an issue number");
    process.exit(1);
  }

  let comment: string | undefined;
  let mode: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--comment" && args[i + 1]) {
      comment = args[++i];
    } else if (args[i] === "--mode" && args[i + 1]) {
      mode = args[++i].toUpperCase();
    }
  }

  if (!comment) {
    console.error("--comment is required");
    console.error(
      'Usage: dangeresque stage <issue-number> --comment "text" [--mode MODE]',
    );
    process.exit(1);
  }

  const projectRoot = resolveProjectRoot();
  const result = stageComment(projectRoot, issueNumber, comment, mode);

  if (result.success) {
    console.log(result.message);
    if (mode) {
      console.log(`Run: dangeresque run --issue ${issueNumber} --mode ${mode}`);
    }
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function cmdAllow(args: string[]) {
  const sub = args[0];
  if (!sub) {
    console.error(allowUsage());
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const positional = args.slice(1).filter((a) => a !== "--dry-run");

  const projectRoot = resolveProjectRoot();
  let result: AllowResult;

  if (sub === "mcp") {
    const server = positional[0];
    try {
      result = allowMcp(projectRoot, { server, dryRun });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (positional.length > 1) {
      console.error(
        `Server id must be a single argument; got ${positional.length} positionals.\n` +
          `Example: dangeresque allow mcp context7`,
      );
      process.exit(1);
    }
    if (result.added.length === 0 && result.skipped.length === 0) {
      console.log(
        "No mcpServers in .mcp.json. Nothing to add.\n" +
          "For user-scope or plugin-scope servers, pass the id explicitly: dangeresque allow mcp <server>",
      );
      return;
    }
  } else if (sub === "bash") {
    const pattern = positional[0];
    if (!pattern) {
      console.error('Usage: dangeresque allow bash "<pattern>" [--dry-run]');
      console.error('Example: dangeresque allow bash "npm install *"');
      process.exit(1);
    }
    if (positional.length > 1) {
      console.error(
        `Bash pattern must be a single quoted argument; got ${positional.length} positionals.\n` +
          `Did you forget to quote the pattern? e.g. dangeresque allow bash "npm install *"`,
      );
      process.exit(1);
    }
    try {
      result = allowBash(projectRoot, { pattern, dryRun });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    console.error(`Unknown 'allow' subcommand: ${sub}`);
    console.error(allowUsage());
    process.exit(1);
  }

  printAllowResult(result, dryRun);
}

function allowUsage(): string {
  return [
    "Usage:",
    "  dangeresque allow mcp [<server>] [--dry-run]",
    "  dangeresque allow bash \"<pattern>\" [--dry-run]",
    "",
    "Examples:",
    "  dangeresque allow mcp                       # read ./.mcp.json mcpServers keys",
    "  dangeresque allow mcp context7              # add mcp__context7 (user/plugin scope)",
    "  dangeresque allow bash \"npm install *\"      # add Bash(npm install *)",
  ].join("\n");
}

function printAllowResult(result: AllowResult, dryRun: boolean): void {
  const verb = dryRun ? "would add" : "added";
  if (result.added.length > 0) {
    for (const entry of result.added) {
      console.log(`  ${verb}: ${entry}`);
    }
  }
  for (const entry of result.skipped) {
    console.log(`  already allowed: ${entry}`);
  }
  if (dryRun) {
    console.log(
      `\n[dry-run] would add ${result.added.length} entries to ${result.configPath}`,
    );
  } else {
    if (result.configCreated) {
      console.log(`\nCreated ${result.configPath}`);
    }
    console.log(
      `added ${result.added.length} entries to ${result.configPath}; ` +
        `total allowedTools: ${result.totalAllowedTools}`,
    );
  }
}

function cmdInit() {
  const projectRoot = resolveProjectRoot();
  initProject(projectRoot);
}

function cmdDoctor(args: string[]) {
  const strict = args.includes("--strict");
  const KNOWN_FLAGS = new Set(["--strict"]);
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s) for doctor: ${unknown.join(", ")}`);
    console.error("Usage: dangeresque doctor [--strict]");
    process.exit(2);
  }

  let report;
  try {
    report = runDoctorChecks({ projectRoot: resolveProjectRoot() });
  } catch (err) {
    console.error(
      `dangeresque doctor: internal error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  process.stdout.write(formatDoctorReport(report));

  const hasWarn = report.checks.some((c) => c.status === "warn");
  const hasFail = report.checks.some((c) => c.status === "fail");
  if (hasFail) {
    process.exit(1);
  }
  if (strict && hasWarn) {
    process.exit(1);
  }
}

function cmdMigrate() {
  driftWarnIfStale();
  const projectRoot = resolveProjectRoot();
  const result = migrateAllArtifacts(projectRoot);
  console.log(`Migrated: ${result.migrated}`);
  console.log(`Skipped (already at v${ARTIFACT_SCHEMA_VERSION}): ${result.skipped}`);
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.length}`);
    for (const e of result.errors) console.log(`  ${e}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
