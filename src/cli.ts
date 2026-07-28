#!/usr/bin/env node

import {
  loadConfig,
  validateSetup,
  validateEngineRuntime,
  applyEngineRunOverrides,
  resolveProjectRoot,
  type Engine,
  type EngineRunOverrides,
} from "./config.js";
import { runWorker, runReview, fetchIssue, postRunComment, loadIssueFixture, formatIssueComments, killActiveEngines, workerModelEffort, reviewModelEffort, validateCodexModelEfforts, type IssueData } from "./runner.js";
import {
  ArtifactBuilder,
  writeArtifact,
  jsonPathForArchive,
  ARTIFACT_SCHEMA_VERSION,
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
  formatPidModelEffort,
  type WorktreeInfo,
  type WorktreeFilter,
} from "./worktree.js";
import { pickWorktree } from "./picker.js";
import { initProject } from "./init.js";
import { printBrief } from "./brief.js";
import { usageForEngine } from "./usage.js";
import { allowMcp, allowBash, type AllowResult } from "./allow.js";
import { stageComment } from "./stage.js";
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
  parseScopeDeclaration,
  classifyChanges,
  matchesGlob,
  type ScopeReport,
} from "./scope.js";
import type { ScopeOpportunisticConfig } from "./config.js";
import { detectDrift } from "./build-info.js";
import { runDoctorChecks, formatDoctorReport } from "./doctor.js";
import { relative } from "node:path";

const SKIP_REVIEW_MODES = new Set(["INVESTIGATE", "VERIFY"]);

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
    return { in_scope: inScope, extended, outside };
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

  return { in_scope: inScope, extended: finalExtended, outside };
}

function currentHelpEngine(): Engine {
  const envEngine = process.env.DANGERESQUE_ENGINE?.toLowerCase();
  if (envEngine === "claude" || envEngine === "codex") return envEngine;

  try {
    const config = loadConfig(resolveProjectRoot());
    return config.engine;
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
    The worker exited successfully and produced its run artifact, but the run still needs attention. This is used when review errored, review returned needs_human_review or unknown, or review was skipped while scope violations were recorded.
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
  const envEngine = process.env.DANGERESQUE_ENGINE?.toLowerCase();
  if (envEngine === "claude" || envEngine === "codex") {
    config.engine = envEngine;
  }

  // Parse CLI overrides
  let name: string | undefined;
  let review = true;
  let verifyEnabled = true;
  let issueNumber: number | undefined;
  let issueFixturePath: string | undefined;
  let mode: string | undefined;
  const runOverrides: EngineRunOverrides = {};
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
      runOverrides.model = args[++i];
      // Hidden advanced override flag (kept for power users)
    } else if (args[i] === "--engine" && args[i + 1]) {
      const engine = args[++i].toLowerCase();
      if (engine !== "claude" && engine !== "codex") {
        console.error("--engine must be one of: claude, codex");
        process.exit(1);
      }
      config.engine = engine;
    } else if (args[i] === "--effort" && args[i + 1]) {
      runOverrides.effort = args[++i];
    } else if (args[i] === "--review-model" && args[i + 1]) {
      runOverrides.reviewModel = args[++i];
    } else if (args[i] === "--review-effort" && args[i + 1]) {
      runOverrides.reviewEffort = args[++i];
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

  applyEngineRunOverrides(config, runOverrides);

  const runtimeValidation = validateEngineRuntime(config.engine, projectRoot);
  if (!runtimeValidation.valid) {
    console.error("Setup validation failed:");
    for (const err of runtimeValidation.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const effortValidation = validateCodexModelEfforts(config);
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

  const effectiveMode = mode ?? "INVESTIGATE";

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

  // Install SIGTERM/SIGINT handler so an external `dangeresque stop` (or
  // operator Ctrl-C) cleanly aborts the worker. We signal the engine and
  // let its child.on("close") resolve runWorker with a non-zero exit code
  // — cmdRun then takes the FAIL-banner path naturally, but the
  // stopRequested flag suppresses the GitHub failure comment so an
  // aborted run does not leave a stale "FAILED" notice on the issue.
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

  const effectiveWorker = workerModelEffort(config);
  const effectiveReview = reviewModelEffort(config);
  const reviewDiffers =
    effectiveReview.model !== effectiveWorker.model ||
    effectiveReview.effort !== effectiveWorker.effort;

  console.log("\ndangeresque — starting AFK run");
  console.log(`  Project: ${projectRoot}`);
  console.log(`  Issue: #${issueData.number} — ${issueData.title}`);
  console.log(`  Mode: ${effectiveMode}`);
  console.log(`  Engine: ${config.engine}`);
  console.log(`  Model: ${effectiveWorker.model} (effort: ${effectiveWorker.effort})`);
  if (reviewDiffers) {
    console.log(`  Review: ${effectiveReview.model} (effort: ${effectiveReview.effort})`);
  }
  console.log(`  Mode: ${config.headless ? "headless (-p)" : "interactive"}`);
  console.log(`  Review pass: ${review ? "yes" : "no"}`);

  // Worker pass
  const workerStartedAtMs = Date.now();
  const workerResult = await runWorker({
    projectRoot,
    config,
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
    engine: config.engine,
    model: effectiveWorker.model,
    effort: effectiveWorker.effort,
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
    console.error(`!!  DANGERESQUE RUN ${stopRequested ? "STOPPED" : "FAILED"}`);
    console.error(`!!  Worker exit code: ${workerResult.exitCode}`);
    console.error(`!!  Worktree: .claude/worktrees/${workerResult.worktreeName}/`);
    console.error(`!!  Branch:   ${workerResult.branch}`);
    console.error(`!!  Artifact: ${workerResult.archivePath}`);
    console.error(`!!`);
    console.error(`!!  Inspect: dangeresque logs`);
    console.error(`!!  Cleanup: dangeresque discard ${workerResult.branch}`);
    console.error(`${banner}\n`);

    // Skip the GitHub failure comment when the operator explicitly stopped
    // the run — a stale "FAILED" comment from an aborted run is noise, not
    // signal. Real failures (engine crash, exit code from worker logic)
    // still get reported.
    if (issueNumber && !fixtureUsed && !stopRequested) {
      try {
        postRunComment({
          projectRoot,
          issueNumber,
          mode: effectiveMode,
          worktreeName: workerResult.worktreeName,
          archivePath: workerResult.archivePath,
          workerExitCode: workerResult.exitCode,
          engine: config.engine,
          model: effectiveWorker.model,
          effort: effectiveWorker.effort,
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

  // Post-worker scope check: classify changed files via the policy engine
  // (allow/deny globs from issue's `dangeresque-scope` blocks + worker's
  // `## Scope Declaration`), then apply project-level opportunistic budget
  // (denyGlobs + maxFiles + maxLines) to demote over-budget extended entries.
  try {
    const { execSync } = await import("node:child_process");
    const { resolveDiffBase } = await import("./worktree.js");
    const worktreePath = `${projectRoot}/.claude/worktrees/${workerResult.worktreeName}`;
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
    let scopeDeclaration: ReturnType<typeof parseScopeDeclaration> = [];
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      if (existsSync(workerResult.archivePath)) {
        const md = readFileSync(workerResult.archivePath, "utf-8");
        scopeDeclaration = parseScopeDeclaration(md);
      }
    } catch {
      /* ignore — declaration parse failures are non-fatal */
    }
    let scopeReport = classifyChanges({
      changedFiles,
      block: scopeBlock,
      declaration: scopeDeclaration,
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
    });

    // Demote the operator-facing warning. For code-changing modes the reviewer
    // adjudicates `outside` entries — printing here would double-noise. For
    // INVESTIGATE/VERIFY (review skipped), surface a single structured line
    // so the operator can spot drift at a glance.
    if (SKIP_REVIEW_MODES.has(effectiveMode)) {
      console.log(
        `\nScope: in=${scopeReport.in_scope.length} extended=${scopeReport.extended.length} outside=${scopeReport.outside.length}`,
      );
    }
  } catch {
    // Silently ignore — worktree state query failures aren't fatal here
  }

  // Rebase worktree onto latest origin/main before review
  // Prevents false REJECT from reviewer seeing stale-branch diffs
  if (review) {
    try {
      const { execSync } = await import("node:child_process");
      const worktreePath = `${projectRoot}/.claude/worktrees/${workerResult.worktreeName}`;
      execSync("git fetch origin main", { cwd: worktreePath, stdio: "pipe" });
      execSync("git rebase origin/main", { cwd: worktreePath, stdio: "pipe" });
      console.log(`\nRebased worktree onto latest origin/main`);
      builder.recordEvent("rebase_completed");
    } catch (e: any) {
      try {
        const { execSync } = await import("node:child_process");
        const worktreePath = `${projectRoot}/.claude/worktrees/${workerResult.worktreeName}`;
        execSync("git rebase --abort", { cwd: worktreePath, stdio: "pipe" });
      } catch {
        /* ignore */
      }
      console.warn(
        `\n⚠️  Rebase failed (conflict) — reviewer will see original diff`,
      );
      builder.recordEvent("rebase_failed");
    }
  }

  // Canonical SUMMARY file count: rewrite the worker's `Files: ...` line in
  // the run-artifact .md from a hand-typed summary to a CLI-derived count.
  // Runs post-rebase so the canonical count is computed from the same tree
  // the reviewer's diff query sees — they cannot mismatch by construction.
  // Warn-and-degrades on any failure; never blocks the run.
  {
    const { resolveDiffBase } = await import("./worktree.js");
    const worktreePath = `${projectRoot}/.claude/worktrees/${workerResult.worktreeName}`;
    const diffBase = resolveDiffBase(projectRoot);
    normalizeSummaryFileCount({
      worktreePath,
      archivePath: workerResult.archivePath,
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
  if (verifyEnabled && config.verify && shouldRunVerify(effectiveMode, config.verify)) {
    const worktreePath = `${projectRoot}/.claude/worktrees/${workerResult.worktreeName}`;
    console.log(`\nRunning ${config.verify.commands.length} verification command(s)…`);
    verificationOutcome = runVerification({
      worktreePath,
      archivePath: workerResult.archivePath,
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
  } else if (config.verify && !config.verify.modes.includes(effectiveMode)) {
    builder.recordEvent("verification_skipped", { reason: `mode_not_in_list:${effectiveMode}` });
  }

  // Review pass — skip for modes that don't produce code changes
  let reviewExitCode: number | undefined;
  if (verificationOutcome?.blocked) {
    const blockedBy = verificationOutcome.blockedBy ?? "unknown";
    const banner = "!".repeat(60);
    console.error(`\n${banner}`);
    console.error(`!!  DANGERESQUE RUN FAILED — verification blocked`);
    console.error(`!!  Failing command: ${blockedBy}`);
    console.error(`!!  Worktree: .claude/worktrees/${workerResult.worktreeName}/`);
    console.error(`!!  Branch:   ${workerResult.branch}`);
    console.error(`!!  Artifact: ${workerResult.archivePath}`);
    console.error(`!!`);
    console.error(`!!  Inspect: dangeresque results ${workerResult.branch}`);
    console.error(`!!  Cleanup: dangeresque discard ${workerResult.branch}`);
    console.error(`${banner}\n`);
    builder.markReviewSkipped(`verification_failed:${blockedBy}`);
  } else if (review && SKIP_REVIEW_MODES.has(effectiveMode)) {
    console.log(`\nSkipping review (no code changes in ${effectiveMode} mode)`);
    builder.markReviewSkipped(`mode=${effectiveMode}`);
  } else if (review) {
    const reviewStartedAtMs = Date.now();
    const reviewResult = await runReview(
      { projectRoot, config, issueData, mode: effectiveMode },
      workerResult.worktreeName,
      workerResult.archivePath,
      workerResult.workerSessionId,
      workerResult.workerLogPath,
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

  // Post summary comment on issue (success path)
  if (issueNumber && !fixtureUsed) {
    try {
      postRunComment({
        projectRoot,
        issueNumber,
        mode: effectiveMode,
        worktreeName: workerResult.worktreeName,
        archivePath: workerResult.archivePath,
        workerExitCode: workerResult.exitCode,
        reviewExitCode,
        engine: config.engine,
        model: effectiveWorker.model,
        effort: effectiveWorker.effort,
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
  console.log(`  Worktree: .claude/worktrees/${workerResult.worktreeName}/`);
  console.log(`  Branch:   ${workerResult.branch}`);
  console.log(`  Artifact: ${workerResult.archivePath}`);
  if (artifact) {
    console.log(`  Eval:     ${artifact.artifact_paths.json}`);
    console.log(`  Result:   ${artifact.result} (verdict=${artifact.reviewer_verdict})`);
  }

  const header = formatRunHeader(jsonPathForArchive(workerResult.archivePath));
  if (header) {
    console.log("");
    console.log(header);
  }

  console.log(`\nNext steps:`);
  console.log(`  Review:  dangeresque results ${workerResult.branch}`);
  console.log(`  Merge:   dangeresque merge ${workerResult.branch}     (keeps the run report in .dangeresque/runs/)`);
  console.log(`  Discard: dangeresque discard ${workerResult.branch}   (deletes the run report along with the worktree)`);
  console.log("=".repeat(60));

  if (verificationOutcome?.blocked) {
    process.exit(1);
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
      for (const line of formatPidModelEffort(wt.pidInfo)) console.log(line);
    }
    if (wt.pidInfo?.phase) {
      console.log(`  Phase:  ${wt.pidInfo.phase}`);
    }
    console.log();
  }
}

async function cmdMerge(args: string[]) {
  const projectRoot = resolveProjectRoot();
  const rescue = args.includes("--rescue");
  const positional = args.find((a) => !a.startsWith("-"));
  const worktrees = listWorktrees(projectRoot);

  const chosen = await resolvePositionalOrPick(
    positional,
    worktrees,
    "finished",
    "Select a worktree to merge",
  );
  if (!chosen) {
    console.error("Usage: dangeresque merge <branch> [--rescue]");
    console.error("Run 'dangeresque status' to see active worktrees");
    process.exit(1);
  }

  try {
    assertInMainCheckout(projectRoot, "merge");
    const resolved = resolveBranch(projectRoot, chosen);
    const config = loadConfig(projectRoot);
    const result = mergeWorktree(projectRoot, resolved, config.mergeGate, rescue);

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
