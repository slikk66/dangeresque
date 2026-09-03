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

export const ARTIFACT_SCHEMA_VERSION = "10";

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

export interface SentinelCommit {
  sha: string;
  subject: string;
}

/**
 * Which lane authorized a `merge --rescue`.
 *
 * - `micro_fix`     — a USER-approved commit carrying MICRO_FIX_SENTINEL sits on
 *                     the branch. The approval lives in git history, and what it
 *                     approves is the commit's diff.
 * - `no_code_delta` — nothing was committed to the branch after the review
 *                     ended, so the tree being merged is the same tree the
 *                     reviewer read. There is no diff to approve; the operator's
 *                     `--reason` is the approval, and the recorded proof is that
 *                     the code never moved.
 *
 * The second lane exists because the first cannot express the case it was never
 * designed for: a reviewer that rejects on non-code grounds (issue #104). Run
 * artifacts are gitignored by convention, so a correction to the artifact — or a
 * judgment that the reviewer's objection was simply wrong — can never become a
 * sentinel commit. Manufacturing an empty commit to satisfy the check would
 * teach the gate that a hollow token is enough; proving the code is untouched
 * keeps the guarantee the sentinel actually protects.
 */
export type RescueKind = "micro_fix" | "no_code_delta";

/**
 * Written to the run artifact when `dangeresque merge --rescue` merges over a
 * reviewed reject / needs_human_review verdict. The audit trail lives WITH the
 * run, not just in git log.
 */
export interface RescueRecord {
  kind: RescueKind;
  overridden_verdict: ReviewerVerdict;
  sentinel_commits: SentinelCommit[];
  /** The operator's written justification. Always set for `no_code_delta`. */
  reason?: string;
  /**
   * Evidence backing a `no_code_delta` rescue: the review end time every branch
   * commit was checked against, and the branch head that got merged. Absent on
   * the `micro_fix` lane, whose evidence is `sentinel_commits`.
   */
  code_unchanged?: {
    review_ended_at: string;
    head_sha: string;
  };
  rescued_at: string;
}

export type FailureCategory =
  | "worker_nonzero_exit"
  | "review_nonzero_exit"
  | "no_run_artifact"
  | "rebase_conflict"
  /**
   * Work the branch does not carry: capture failed, or something in the
   * worktree stayed uncommitted through it (issue #93). Distinct from
   * `rebase_conflict`, which this used to be mislabelled as — a dirty tree
   * makes git refuse to START a rebase, which is not a conflict.
   */
  | "uncommitted_worker_changes"
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
  review_engine?: Engine;
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
  /**
   * Set only by `dangeresque resume`: the artifact the DEAD attempt this run
   * continued left behind. A basename, not a path — both files are siblings in
   * the same issue dir, and the absolute worktree path stops existing at merge.
   *
   * A resumed run gets a NEW `run_id`, unlike a review rescue, which keeps the
   * old one. The distinction is real: a review rescue continues the same worker
   * attempt, while a resume is a second billable engine attempt that must show
   * up in `dangeresque stats` as its own run. This field is the lineage link.
   */
  resumed_from?: string;
  /** Set only by a `dangeresque merge --rescue`. Absent on every normal run. */
  rescue?: RescueRecord;
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
  reviewEngine?: Engine;
  reviewModel?: string;
  reviewEffort?: string;
  worktreeName: string;
  branch: string;
  archivePath: string;
  /** Epoch-ms timestamp for when the overall run started. Falls back to construction time. */
  startedAtMs?: number;
  /**
   * Preserve a prior run's identity. Set by a review rescue that found a
   * checkpoint, so the rescued artifact stays the same run rather than
   * appearing in stats as a second one. Falls back to a fresh UUID.
   */
  runId?: string;
  /**
   * Lifecycle events carried over from a prior run's checkpoint, recorded
   * ahead of this builder's own events. Timestamps make the ordering explicit.
   */
  seedEvents?: LifecycleEvent[];
  /**
   * Basename of the artifact left by the dead attempt this run resumed. Set
   * only by `dangeresque resume`; omitted entirely on every other run.
   */
  resumedFrom?: string;
}

export class ArtifactBuilder {
  private readonly runId: string;
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
    this.runId = init.runId ?? randomUUID();
    this.startedAtMs = init.startedAtMs ?? Date.now();
    if (init.seedEvents) this.events.push(...init.seedEvents);
    this.recordEvent("run_started", {
      run_id: this.runId,
      issue_number: init.issueNumber ?? null,
      mode: init.mode,
      engine: init.engine,
      review_engine: init.reviewEngine,
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
      declaration_status: report.declaration_status,
      ...(report.diagnostics && report.diagnostics.length > 0
        ? { diagnostics: [...report.diagnostics] }
        : {}),
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
      uncommittedWorkerChanges: hasUncommittedWorkerChanges(this.events),
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
      ...(reviewRan && this.init.reviewEngine !== undefined
        ? { review_engine: this.init.reviewEngine }
        : {}),
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
      ...(this.init.resumedFrom !== undefined
        ? { resumed_from: this.init.resumedFrom }
        : {}),
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

// Matched against emphasis-stripped text; reviewers decorate the verdict line
// inconsistently (e.g. `**Verdict:** **ACCEPT**` broke the exact-bold match on bc#624).
const VERDICT_REGEX = /\bVerdict\s*:\s*(ACCEPT|REJECT|NEEDS[\s_-]?HUMAN[\s_-]?REVIEW)\b/i;

export function parseVerdictFromMarkdown(md: string): ReviewerVerdict {
  const normalized = md.replace(/[*`]/g, "");
  const match = normalized.match(VERDICT_REGEX);
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
  if (hasUncommittedWorkerChanges(opts.events)) {
    categories.push("uncommitted_worker_changes");
  }
  // `conflict: false` is the honest new signal for a rebase git refused to
  // run. Older artifacts carry no `conflict` key at all, so a bare
  // `rebase_failed` keeps its historical meaning.
  const rebaseFailed = opts.events.find((e) => e.event === "rebase_failed");
  if (rebaseFailed && rebaseFailed.data?.conflict !== false) {
    categories.push("rebase_conflict");
  }
  return categories;
}

/**
 * True when the run left work outside the branch's commits — the state that
 * lets a reviewer ACCEPT a diff `git merge` will not ship (issue #93).
 */
function hasUncommittedWorkerChanges(events: LifecycleEvent[]): boolean {
  return events.some(
    (e) =>
      e.event === "worktree_dirty_after_capture" ||
      e.event === "worker_changes_capture_failed",
  );
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
  uncommittedWorkerChanges: boolean;
}): ResultClassification {
  if (opts.workerExitCode !== 0) return "failure";
  if (!opts.archiveExists) return "failure";
  if (opts.verificationBlocked) return "failure";

  const reviewRan = opts.review !== null && !opts.review.skipped;

  if (reviewRan && opts.review!.exit_code !== 0) {
    return "partial_success";
  }

  // Work that no commit carries cannot be a `success`, whatever the reviewer
  // said about it: the reviewer read the working tree, and `git merge` will
  // ship the commits. bc#530 scored success/verdict=accept on a diff that
  // existed in no commit (issue #93) — this is the line that stops that.
  if (opts.uncommittedWorkerChanges) {
    return opts.reviewerVerdict === "reject" && reviewRan ? "failure" : "partial_success";
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

/**
 * Annotate a run artifact (JSON + MD) with a RESCUE record after a
 * `dangeresque merge --rescue`. Writes the structured record into the JSON and
 * appends a human-readable RESCUE section to the MD, so the "what/who/which
 * commits" audit lives with the run and survives the worktree teardown (the
 * caller runs this BEFORE mirrorAllIssueRuns copies the artifact to the project
 * root). Idempotent overwrite of `.rescue`.
 */
export function appendRescueRecord(
  jsonPath: string,
  mdPath: string,
  record: RescueRecord,
): void {
  const artifact = JSON.parse(readFileSync(jsonPath, "utf-8")) as RunArtifact;
  artifact.rescue = record;
  writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + "\n", "utf-8");

  const section = renderRescueSection(record);
  const existing = existsSync(mdPath) ? readFileSync(mdPath, "utf-8") : "";
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(mdPath, existing + sep + section, "utf-8");
}

/**
 * Human-readable RESCUE section. Each lane states the evidence it actually
 * stands on — a reader must never have to guess whether a diff was approved or
 * whether there was no diff to approve.
 */
function renderRescueSection(record: RescueRecord): string {
  const preamble =
    `Merged over a \`${record.overridden_verdict}\` review verdict via ` +
    `\`dangeresque merge --rescue\`. Verification gates still ran; only the ` +
    `round-2 worker round-trip was waived.\n\n` +
    `- Overridden verdict: \`${record.overridden_verdict}\`\n` +
    `- Rescued at: ${record.rescued_at}\n`;

  if (record.kind === "micro_fix") {
    const commitLines = record.sentinel_commits
      .map((c) => `  - \`${c.sha.slice(0, 8)}\` ${c.subject}`)
      .join("\n");
    return (
      `\n## RESCUE — USER-approved micro-fix merge\n\n` +
      preamble +
      `- Sentinel commits (USER-approved):\n${commitLines}\n`
    );
  }

  const proof = record.code_unchanged;
  return (
    `\n## RESCUE — no-code-delta merge (USER-approved)\n\n` +
    preamble +
    `- Reason (USER): ${record.reason ?? "(none recorded)"}\n` +
    (proof
      ? `- Proof the code is unchanged: no commit landed on this branch after ` +
        `the review ended at ${proof.review_ended_at}; merged head ` +
        `\`${proof.head_sha.slice(0, 8)}\`.\n`
      : `- Proof the code is unchanged: (not recorded)\n`) +
    `\nThe tree merged here is the same tree the reviewer read. No sentinel ` +
    `commit exists because there was no code change to approve.\n`
  );
}
