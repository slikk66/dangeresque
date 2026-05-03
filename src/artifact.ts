import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { relative, basename, join } from "node:path";
import { execSync } from "node:child_process";
import type { Engine } from "./config.js";
import type { VerificationResult } from "./verify.js";
import type {
  ScopeBlock,
  ScopeDeclarationEntry,
  ScopeReport,
} from "./scope.js";

export const ARTIFACT_SCHEMA_VERSION = "6";

// Modes whose worker output produces a code diff and must therefore carry a
// `## Scope Declaration` section. Kept in sync with `src/runner.ts` (prompt
// injection). Two literal sets rather than a shared export so each consumer
// can drift independently if future modes change semantics.
const CODE_CHANGING_MODES = new Set(["IMPLEMENT", "REFACTOR", "TEST"]);

export type ResultClassification = "success" | "partial_success" | "failure";

export type ReviewerVerdict =
  | "accept"
  | "reject"
  | "needs_human_review"
  | "skipped"
  | "unknown";

export type FailureCategory =
  | "worker_nonzero_exit"
  | "review_nonzero_exit"
  | "no_run_artifact"
  | "rebase_conflict"
  | "scope_outside"
  | "reviewer_rejected"
  | "verification_failed"
  | "unknown";

export interface LifecycleEvent {
  ts: string;
  event: string;
  data?: Record<string, unknown>;
}

export interface PhaseTiming {
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_code: number;
}

export interface ReviewPhase extends PhaseTiming {
  skipped: boolean;
  skip_reason?: string;
}

export interface RunArtifact {
  schema_version: string;
  run_id: string;
  issue_number: number | null;
  issue_url: string | null;
  mode: string;
  engine: Engine;
  model: string;
  effort: string | null;
  review_model?: string;
  review_effort?: string;
  worktree_name: string;
  branch: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  worker: PhaseTiming;
  review: ReviewPhase | null;
  result: ResultClassification;
  reviewer_verdict: ReviewerVerdict;
  failure_categories: FailureCategory[];
  files_changed_count: number;
  verification: VerificationResult[] | null;
  summary: string;
  artifact_paths: {
    md: string;
    json: string;
  };
  lifecycle_events: LifecycleEvent[];
  scope_block?: ScopeBlock;
  scope_declaration?: ScopeDeclarationEntry[];
  scope_report?: ScopeReport;
  migrated_from_version?: number;
}

export interface BuilderInit {
  projectRoot: string;
  issueNumber?: number;
  /** Override for issue_url. When set (including null), used verbatim instead of deriving from remote + issueNumber. */
  issueUrl?: string | null;
  mode: string;
  engine: Engine;
  model: string;
  effort?: string;
  reviewModel?: string;
  reviewEffort?: string;
  worktreeName: string;
  branch: string;
  archivePath: string;
  /** Epoch-ms timestamp for when the overall run started. Falls back to construction time. */
  startedAtMs?: number;
}

export class ArtifactBuilder {
  private readonly runId = randomUUID();
  private readonly startedAtMs: number;
  private readonly init: BuilderInit;
  private readonly events: LifecycleEvent[] = [];
  private worker?: PhaseTiming;
  private review?: ReviewPhase;
  private filesChangedCount = 0;
  private reviewSkipped = false;
  private reviewSkipReason?: string;
  private verification: VerificationResult[] | null = null;
  private scopeBlock?: ScopeBlock;
  private scopeDeclaration?: ScopeDeclarationEntry[];
  private scopeReport?: ScopeReport;

  constructor(init: BuilderInit) {
    this.init = init;
    this.startedAtMs = init.startedAtMs ?? Date.now();
    this.recordEvent("run_started", {
      run_id: this.runId,
      issue_number: init.issueNumber ?? null,
      mode: init.mode,
      engine: init.engine,
    });
  }

  recordEvent(event: string, data?: Record<string, unknown>): void {
    this.events.push({ ts: new Date().toISOString(), event, data });
  }

  setWorkerTiming(startedAtMs: number, endedAtMs: number, exitCode: number): void {
    this.worker = phaseTimingFromMs(startedAtMs, endedAtMs, exitCode);
  }

  setReviewTiming(startedAtMs: number, endedAtMs: number, exitCode: number): void {
    this.review = {
      ...phaseTimingFromMs(startedAtMs, endedAtMs, exitCode),
      skipped: false,
    };
  }

  markReviewSkipped(reason: string): void {
    this.reviewSkipped = true;
    this.reviewSkipReason = reason;
  }

  setFilesChangedCount(n: number): void {
    this.filesChangedCount = n;
  }

  setVerification(results: VerificationResult[] | null): void {
    this.verification = results === null ? null : [...results];
  }

  setScopeBlock(block: ScopeBlock): void {
    this.scopeBlock = {
      allow: [...block.allow],
      deny: [...block.deny],
      diagnostics: [...block.diagnostics],
    };
  }

  setScopeDeclaration(decl: ScopeDeclarationEntry[]): void {
    this.scopeDeclaration = decl.map((d) => ({ ...d }));
  }

  setScopeReport(report: ScopeReport): void {
    this.scopeReport = {
      in_scope: [...report.in_scope],
      extended: report.extended.map((e) => ({ ...e })),
      outside: [...report.outside],
    };
  }

  build(): RunArtifact {
    const endedAtMs = Date.now();
    const archivePath = this.init.archivePath;
    const jsonPath = archivePath.replace(/\.md$/, ".json");

    const worker: PhaseTiming = this.worker ?? {
      started_at: new Date(this.startedAtMs).toISOString(),
      ended_at: new Date(endedAtMs).toISOString(),
      duration_ms: 0,
      exit_code: -1,
    };

    let review: ReviewPhase | null = null;
    if (this.review) {
      review = this.review;
    } else if (this.reviewSkipped) {
      review = {
        started_at: worker.ended_at,
        ended_at: worker.ended_at,
        duration_ms: 0,
        exit_code: 0,
        skipped: true,
        skip_reason: this.reviewSkipReason,
      };
    }

    const reviewerVerdict = deriveReviewerVerdict({
      archivePath,
      review,
      workerExitCode: worker.exit_code,
    });

    const verificationBlocked = isVerificationBlocked(this.verification);
    const outsideCount = this.scopeReport?.outside.length ?? 0;

    const failureCategories = deriveFailureCategories({
      workerExitCode: worker.exit_code,
      reviewExitCode: review && !review.skipped ? review.exit_code : undefined,
      archiveExists: existsSync(archivePath),
      outsideCount,
      reviewerVerdict,
      events: this.events,
      verificationBlocked,
    });

    const result = deriveResult({
      workerExitCode: worker.exit_code,
      review,
      archiveExists: existsSync(archivePath),
      reviewerVerdict,
      outsideCount,
      verificationBlocked,
    });

    const summary = buildSummaryLine({
      result,
      reviewerVerdict,
      failureCategories,
      mode: this.init.mode,
      archivePath,
    });

    this.recordEvent("run_completed", {
      result,
      reviewer_verdict: reviewerVerdict,
    });

    if (
      CODE_CHANGING_MODES.has(this.init.mode) &&
      (this.scopeDeclaration === undefined || this.scopeDeclaration.length === 0)
    ) {
      console.warn(
        `⚠️  Run artifact missing '## Scope Declaration' section ` +
          `(mode=${this.init.mode}). Phase 2 is warn-only — Phase 3 will hard-fail. ` +
          `See worker-prompt.md for the format.`,
      );
    }

    const reviewRan = review !== null && !review.skipped;

    return {
      schema_version: ARTIFACT_SCHEMA_VERSION,
      run_id: this.runId,
      issue_number: this.init.issueNumber ?? null,
      issue_url:
        this.init.issueUrl !== undefined
          ? this.init.issueUrl
          : buildIssueUrl(this.init.projectRoot, this.init.issueNumber),
      mode: this.init.mode,
      engine: this.init.engine,
      model: this.init.model,
      effort: this.init.effort ?? null,
      ...(reviewRan && this.init.reviewModel !== undefined
        ? { review_model: this.init.reviewModel }
        : {}),
      ...(reviewRan && this.init.reviewEffort !== undefined
        ? { review_effort: this.init.reviewEffort }
        : {}),
      worktree_name: this.init.worktreeName,
      branch: this.init.branch,
      started_at: new Date(this.startedAtMs).toISOString(),
      ended_at: new Date(endedAtMs).toISOString(),
      duration_ms: endedAtMs - this.startedAtMs,
      worker,
      review,
      result,
      reviewer_verdict: reviewerVerdict,
      failure_categories: failureCategories,
      files_changed_count: this.filesChangedCount,
      verification: this.verification === null ? null : [...this.verification],
      summary,
      artifact_paths: {
        md: relative(this.init.projectRoot, archivePath),
        json: relative(this.init.projectRoot, jsonPath),
      },
      lifecycle_events: [...this.events],
      ...(this.scopeBlock ? { scope_block: this.scopeBlock } : {}),
      ...(this.scopeDeclaration
        ? { scope_declaration: this.scopeDeclaration }
        : {}),
      ...(this.scopeReport ? { scope_report: this.scopeReport } : {}),
    };
  }
}

function phaseTimingFromMs(
  startedAtMs: number,
  endedAtMs: number,
  exitCode: number,
): PhaseTiming {
  return {
    started_at: new Date(startedAtMs).toISOString(),
    ended_at: new Date(endedAtMs).toISOString(),
    duration_ms: endedAtMs - startedAtMs,
    exit_code: exitCode,
  };
}

const VERDICT_REGEX = /\*\*Verdict:\*\*\s*(ACCEPT|REJECT|NEEDS[\s_-]?HUMAN[\s_-]?REVIEW)/i;

export function parseVerdictFromMarkdown(md: string): ReviewerVerdict {
  const match = md.match(VERDICT_REGEX);
  if (!match) return "unknown";
  const raw = match[1].toUpperCase().replace(/[\s_-]/g, "");
  if (raw === "ACCEPT") return "accept";
  if (raw === "REJECT") return "reject";
  if (raw === "NEEDSHUMANREVIEW") return "needs_human_review";
  return "unknown";
}

function deriveReviewerVerdict(opts: {
  archivePath: string;
  review: ReviewPhase | null;
  workerExitCode: number;
}): ReviewerVerdict {
  if (opts.workerExitCode !== 0) return "unknown";
  if (!opts.review) return "skipped";
  if (opts.review.skipped) return "skipped";
  if (!existsSync(opts.archivePath)) return "unknown";
  try {
    const md = readFileSync(opts.archivePath, "utf-8");
    return parseVerdictFromMarkdown(md);
  } catch {
    return "unknown";
  }
}

function deriveFailureCategories(opts: {
  workerExitCode: number;
  reviewExitCode: number | undefined;
  archiveExists: boolean;
  outsideCount: number;
  reviewerVerdict: ReviewerVerdict;
  events: LifecycleEvent[];
  verificationBlocked: boolean;
}): FailureCategory[] {
  const categories: FailureCategory[] = [];
  if (opts.workerExitCode !== 0) categories.push("worker_nonzero_exit");
  if (opts.reviewExitCode !== undefined && opts.reviewExitCode !== 0) {
    categories.push("review_nonzero_exit");
  }
  if (!opts.archiveExists) categories.push("no_run_artifact");
  if (opts.verificationBlocked) categories.push("verification_failed");
  // scope_outside only contributes when outside-scope changes actually caused
  // a downgrade: worker succeeded, archive exists, reviewer did NOT run, and
  // scope_report.outside was non-empty. When the reviewer ran, its verdict is
  // the authority on scope (issue #27).
  const scopeContributedToDowngrade =
    opts.workerExitCode === 0 &&
    opts.archiveExists &&
    opts.reviewExitCode === undefined &&
    opts.outsideCount > 0;
  if (scopeContributedToDowngrade) categories.push("scope_outside");
  if (opts.reviewerVerdict === "reject") categories.push("reviewer_rejected");
  if (opts.events.some((e) => e.event === "rebase_failed")) {
    categories.push("rebase_conflict");
  }
  return categories;
}

function isVerificationBlocked(results: VerificationResult[] | null): boolean {
  if (results === null) return false;
  return results.some((r) => r.exit_code !== 0 && r.on_failure === "block");
}

function deriveResult(opts: {
  workerExitCode: number;
  review: ReviewPhase | null;
  archiveExists: boolean;
  reviewerVerdict: ReviewerVerdict;
  outsideCount: number;
  verificationBlocked: boolean;
}): ResultClassification {
  if (opts.workerExitCode !== 0) return "failure";
  if (!opts.archiveExists) return "failure";
  if (opts.verificationBlocked) return "failure";

  const reviewRan = opts.review !== null && !opts.review.skipped;

  if (reviewRan && opts.review!.exit_code !== 0) {
    return "partial_success";
  }

  if (reviewRan) {
    if (opts.reviewerVerdict === "reject") return "failure";
    if (opts.reviewerVerdict === "accept") return "success";
    return "partial_success";
  }

  return opts.outsideCount > 0 ? "partial_success" : "success";
}

function buildSummaryLine(opts: {
  result: ResultClassification;
  reviewerVerdict: ReviewerVerdict;
  failureCategories: FailureCategory[];
  mode: string;
  archivePath: string;
}): string {
  const parts = [
    `${opts.mode} ${opts.result}`,
    `verdict=${opts.reviewerVerdict}`,
  ];
  if (opts.failureCategories.length > 0) {
    parts.push(`issues=${opts.failureCategories.join(",")}`);
  }
  parts.push(`file=${basename(opts.archivePath)}`);
  return parts.join(" | ");
}

function buildIssueUrl(projectRoot: string, issueNumber: number | undefined): string | null {
  if (!issueNumber) return null;
  try {
    const remote = execSync("git config --get remote.origin.url", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const slug = parseGitRemoteSlug(remote);
    if (!slug) return null;
    return `https://github.com/${slug}/issues/${issueNumber}`;
  } catch {
    return null;
  }
}

export function parseGitRemoteSlug(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const sshMatch = trimmed.match(/^git@[^:]+:([^/]+)\/(.+)$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;
  const httpsMatch = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+)$/);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;
  return null;
}

export function writeArtifact(artifact: RunArtifact, projectRoot: string): string {
  const absJsonPath = join(projectRoot, artifact.artifact_paths.json);
  writeFileSync(absJsonPath, JSON.stringify(artifact, null, 2) + "\n", "utf-8");
  return absJsonPath;
}

export function jsonPathForArchive(archivePath: string): string {
  return archivePath.replace(/\.md$/, ".json");
}
