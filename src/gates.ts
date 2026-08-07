import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR,
  RUNS_DIR,
  DEFAULT_DISPATCH_GATE_MODES,
  DEFAULT_MERGE_GATE_MODES,
  type DispatchGateConfig,
  type MergeGateConfig,
} from "./config.js";
// DEFAULT_DISPATCH_GATE_MODES is imported so allKnownModes() covers every mode
// the CLI ever dispatches — the merge-side fail-closed check must recognize
// every legitimate mode, not just merge-gated ones.
import { listArchivedRuns } from "./worktree.js";
import {
  jsonPathForArchive,
  type RunArtifact,
  type RescueKind,
  type ReviewerVerdict,
  type SentinelCommit,
} from "./artifact.js";
import {
  runSingleCommand,
  buildCommandEnv,
  DEFAULT_VERIFY_LOG_BYTES,
  type VerifyCommand,
  type VerificationResult,
} from "./verify.js";

/**
 * Commit-message sentinel a USER-approved micro-fix carries so `merge --rescue`
 * can recognize it. Same literal string bubble-craps CLAUDE.md's MICRO-FIX LANE
 * mandates and the #633 pre-commit hook keys on — ONE definition, shared.
 */
export const MICRO_FIX_SENTINEL = "[micro-fix: USER-approved]";

/**
 * Result of applying a gate. `ok: false` maps to CLI exit 2 (gate refusal),
 * distinguishing "fix workflow and retry" from a real error (exit 1).
 * `message` is caller-owned — print verbatim to stderr.
 */
export interface GateResult {
  ok: boolean;
  message?: string;
  /**
   * Set only when a `merge --rescue` was approved: the review verdict that was
   * overridden plus the artifact paths the caller must annotate with a RESCUE
   * record. Absent on every non-rescue pass.
   */
  rescue?: MergeRescueDecision;
}

export interface MergeRescueDecision {
  kind: RescueKind;
  overriddenVerdict: ReviewerVerdict;
  sentinelCommits: SentinelCommit[];
  /** Set on the `no_code_delta` lane: the operator's written justification. */
  reason?: string;
  /**
   * Set on the `no_code_delta` lane: the review end time every branch commit
   * was checked against. The caller pairs it with the merged head sha to build
   * the artifact's `code_unchanged` proof.
   */
  reviewEndedAt?: string;
  jsonPath: string;
  mdPath: string;
}

export interface ApplyDispatchGateOptions {
  projectRoot: string;
  issueNumber: number;
  mode: string;
  config: DispatchGateConfig;
  /**
   * `--force` bypasses ONLY the built-in policy check
   * (requireInvestigateBeforeImplement). Project-configured commands always
   * run; their per-command `on_failure` governs whether failures block.
   */
  force?: boolean;
}

/**
 * Pre-worker enforcement gate. Called from `cmdRun` between the git-preflight
 * gate and the actual `runWorker` dispatch. Refusal → exit 2 (fail closed).
 *
 * Order:
 *  1. Built-in policy: IMPLEMENT requires a prior INVESTIGATE artifact under
 *     projectRoot's .dangeresque/runs/issue-<N>/ (mirrored there after any
 *     prior INVESTIGATE merge). `--force` bypasses this check.
 *  2. Project-configured commands: run each sequentially in projectRoot with
 *     DANGERESQUE_ISSUE / DANGERESQUE_MODE env vars. First `on_failure=block`
 *     failure short-circuits with a refusal message. `--force` does NOT
 *     bypass these — an operator wanting to relax them must set `on_failure:
 *     "warn"` in config.
 */
export function applyDispatchGate(opts: ApplyDispatchGateOptions): GateResult {
  const { projectRoot, issueNumber, mode, config, force } = opts;
  if (!config.enabled) return { ok: true };
  if (!config.modes.includes(mode)) return { ok: true };

  if (!force && config.requireInvestigateBeforeImplement && mode === "IMPLEMENT") {
    const prior = listArchivedRuns(projectRoot, issueNumber).filter((f) =>
      f.endsWith("-INVESTIGATE.md"),
    );
    if (prior.length === 0) {
      return {
        ok: false,
        message:
          `ERROR: dispatchGate refuses to dispatch IMPLEMENT for issue #${issueNumber} because -\n` +
          `- no prior INVESTIGATE run exists at ${relativeIssueRunsDir(issueNumber)}\n\n` +
          `Fix one of these:\n` +
          `  dangeresque run --issue ${issueNumber} --mode INVESTIGATE\n\n` +
          `Or, if you really want to continue anyway, re-run with --force.`,
      };
    }
  }

  // No worktree and no run report exist yet at dispatch time, so those keys are
  // absent rather than empty — a command can test for the variable itself.
  const env = buildCommandEnv({ issueNumber, mode });
  const results = runGateCommands(config.commands, projectRoot, env, "dispatchGate");
  const blocked = firstBlockingFailure(results);
  if (blocked) {
    return {
      ok: false,
      message: buildCommandFailureMessage("dispatchGate", blocked, mode, issueNumber),
    };
  }
  return { ok: true };
}

export interface ApplyMergeGateOptions {
  projectRoot: string;
  worktreePath: string;
  issueNumber: number | undefined;
  mode: string;
  config: MergeGateConfig;
  /**
   * `--force` bypasses ONLY the built-in policy (requireAcceptedImplement).
   * Not currently exposed by `dangeresque merge`; reserved for API symmetry.
   */
  force?: boolean;
  /**
   * `--rescue` allows a merge over a reviewed `reject` / `needs_human_review`
   * verdict. Strictly narrower than `force`: it does NOT bypass a missing /
   * skipped / unreadable / unknown review — only a real non-accept verdict from
   * a review that actually ran. Verification commands still run regardless (the
   * round-2 worker round-trip is the only thing waived).
   *
   * Two lanes authorize it, in this order:
   *  1. `sentinelCommits` is non-empty — a USER-approved micro-fix commit sits
   *     on the branch (bubble-craps CLAUDE.md 'MICRO-FIX LANE').
   *  2. `rescueReason` is set AND nothing was committed after the review ended,
   *     so there is no code change to approve (issue #104).
   */
  rescue?: boolean;
  /**
   * Commits on the merged branch carrying MICRO_FIX_SENTINEL, discovered by the
   * caller (which owns git). Empty/absent ⇒ the no-code-delta lane is the only
   * remaining path.
   */
  sentinelCommits?: SentinelCommit[];
  /**
   * The operator's `--reason` text. Required for the no-code-delta lane and
   * ignored by the sentinel lane, whose approval already lives in git history.
   */
  rescueReason?: string;
  /**
   * Commits on the merged branch whose COMMITTER date is later than the given
   * ISO timestamp, supplied by the caller (which owns git). Any hit means the
   * branch moved after the review, so the reviewer did not read the tree being
   * merged and the no-code-delta lane must refuse.
   *
   * Committer date — not author date — because rebase, amend and cherry-pick
   * all reset it, so every way of putting new content on a branch shows up.
   */
  commitsSince?: (sinceIso: string) => BranchCommit[];
}

/** A branch commit plus when it was committed. Used to date-bound the branch. */
export interface BranchCommit extends SentinelCommit {
  /** ISO-8601 committer date. */
  committedAt: string;
}

/**
 * Pre-merge enforcement gate. Called from `mergeWorktree` between the running-
 * worker gate and the actual `git merge`. Refusal → WorktreeOpResult with
 * `gateRefusal: true`, which the CLI maps to exit 2.
 *
 * Order:
 *  1. Built-in policy: require the latest `-${mode}.json` artifact for the
 *     merged branch's own mode M (as resolved by extractMode) to show
 *     review.skipped=false AND reviewer_verdict === "accept". Reads the
 *     worktree first (fresh mode-M run being merged has its artifact there
 *     but not yet at projectRoot), then falls back to projectRoot ONLY when
 *     the worktree has ZERO mode-M artifacts (e.g. a REFACTOR merge on an
 *     issue that also had an earlier REFACTOR run mirrored to projectRoot).
 *     Any check failure on a root's latest artifact is TERMINAL — an older
 *     accepted artifact at projectRoot cannot override a rejected/skipped
 *     latest artifact in the worktree. Missing/unreadable/skipped/rejected
 *     → fail closed. `--force` bypasses.
 *  2. Project-configured commands: run each sequentially in projectRoot with
 *     DANGERESQUE_ISSUE / DANGERESQUE_MODE / DANGERESQUE_MERGE=1 /
 *     DANGERESQUE_WORKTREE (the merge candidate's checkout — see the env
 *     block below for why diff-based checks should point there) env vars.
 */
export function applyMergeGate(opts: ApplyMergeGateOptions): GateResult {
  const { projectRoot, worktreePath, issueNumber, mode, config, force, rescue } = opts;
  const sentinelCommits = opts.sentinelCommits ?? [];
  if (!config.enabled) return { ok: true };
  // Unrecognized mode (e.g. extractMode returned "UNKNOWN" for a malformed
  // branch name) MUST fail closed when the gate is enabled — the modes-in-
  // list early-return would otherwise skip the gate for exactly the branches
  // that need it most. Mirror-image of the extractMode slug fix
  // (worktree.ts): defense in depth, both layers say no.
  if (!DEFAULT_MERGE_GATE_MODES.includes(mode) && !config.modes.includes(mode)) {
    // Only fail when the mode is fully unrecognized. A recognized mode that
    // simply wasn't opted into `config.modes` (e.g. VERIFY with default
    // config.modes) is a legitimate pass-through.
    if (mode === "UNKNOWN" || !allKnownModes().includes(mode)) {
      return {
        ok: false,
        message:
          `ERROR: mergeGate refuses to merge branch with mode="${mode}" because -\n` +
          `- mode is not one of the recognized modes (${allKnownModes().join(", ")}) (fail closed).`,
      };
    }
  }
  if (!config.modes.includes(mode)) return { ok: true };

  let rescueDecision: MergeRescueDecision | undefined;
  if (!force && config.requireAcceptedImplement) {
    if (issueNumber === undefined) {
      return {
        ok: false,
        message:
          `ERROR: mergeGate refuses to merge (${mode}) because -\n` +
          `- cannot determine issue number from branch name (fail closed).`,
      };
    }
    const check = findAcceptedArtifactForMode(worktreePath, projectRoot, issueNumber, mode);
    if (!check.ok) {
      const header =
        `ERROR: mergeGate refuses to merge (${mode}) for issue #${issueNumber} because -\n`;
      if (rescue) {
        // Rescue is strictly narrower than force: it only overrides a review
        // that RAN and returned a non-accept judgment on otherwise-good work.
        const eligible =
          check.verdict === "reject" || check.verdict === "needs_human_review";
        if (!eligible) {
          return {
            ok: false,
            message:
              header +
              `- --rescue applies only to a review that ran and returned reject or ` +
              `needs_human_review; latest ${mode} artifact state is ` +
              `"${check.verdict ?? "no readable artifact"}" (${check.reason}).\n` +
              `  Rescue cannot substitute for a missing, skipped, or unparseable ` +
              `review — run the normal path.`,
          };
        }
        // Lane 1 — a USER-approved micro-fix commit. Its diff is the thing
        // approved, and git history is where that approval lives.
        if (sentinelCommits.length > 0) {
          rescueDecision = {
            kind: "micro_fix",
            overriddenVerdict: check.verdict!,
            sentinelCommits,
            jsonPath: check.jsonPath!,
            mdPath: check.mdPath!,
          };
        } else {
          // Lane 2 — nothing to approve. Reachable only by proving the branch
          // has not moved since the review, which makes the tree being merged
          // the tree the reviewer read. See RescueKind for why this lane exists.
          const laneCheck = assessNoCodeDelta({
            reason: opts.rescueReason,
            reviewEndedAt: check.reviewEndedAt,
            commitsSince: opts.commitsSince,
          });
          if (!laneCheck.ok) {
            return { ok: false, message: header + laneCheck.refusal };
          }
          rescueDecision = {
            kind: "no_code_delta",
            overriddenVerdict: check.verdict!,
            sentinelCommits: [],
            reason: laneCheck.reason,
            reviewEndedAt: check.reviewEndedAt,
            jsonPath: check.jsonPath!,
            mdPath: check.mdPath!,
          };
        }
        // Approved. Fall through to the command gate — verification is NEVER
        // waived by rescue; only the r2 worker round-trip is.
      } else {
        return {
          ok: false,
          message:
            header +
            `- ${check.reason}\n\n` +
            `Fix one of these:\n` +
            `  dangeresque run --issue ${issueNumber} --mode ${mode}\n` +
            `  (ensure the review pass runs and the reviewer returns ACCEPT)\n` +
            `  dangeresque merge --rescue <branch>\n` +
            `  (after a USER-approved micro-fix commit carrying the sentinel)\n` +
            `  dangeresque merge --rescue --reason "<why>" <branch>\n` +
            `  (when the reviewer objected to something other than the code and\n` +
            `   nothing has been committed since it ran)\n` +
            `  Both apply to reject/needs_human_review verdicts, not skipped/missing reviews.`,
        };
      }
    }
  }

  // DANGERESQUE_WORKTREE is the merge candidate's checkout (#102). Commands run
  // BEFORE the git merge, so projectRoot's HEAD does not contain the branch
  // being merged — a diff-based project check pointed at projectRoot evaluates
  // an empty committed range plus unrelated uncommitted WIP. This var lets a
  // project aim such checks at the worker tree, which dirtyWorktreeRefusal has
  // already guaranteed clean, where base..HEAD IS the merge content.
  //
  // DANGERESQUE_ARTIFACT is located independently of the requireAcceptedImplement
  // check above, which a project may have switched off — a command that reads
  // the run report must not lose its path to a policy toggle it has nothing to
  // do with.
  const located =
    issueNumber !== undefined
      ? locateLatestArtifactForMode(worktreePath, projectRoot, issueNumber, mode)
      : undefined;
  const env = buildCommandEnv({
    issueNumber,
    mode,
    merge: true,
    worktreePath,
    archivePath: located?.mdPath,
  });
  const results = runGateCommands(config.commands, projectRoot, env, "mergeGate");
  const blocked = firstBlockingFailure(results);
  if (blocked) {
    return {
      ok: false,
      message: buildCommandFailureMessage("mergeGate", blocked, mode, issueNumber),
    };
  }
  return rescueDecision ? { ok: true, rescue: rescueDecision } : { ok: true };
}

interface NoCodeDeltaCheck {
  ok: boolean;
  /** Operator-facing refusal body, appended to the caller's header. Absent when ok. */
  refusal?: string;
  /** The trimmed reason, once accepted. */
  reason?: string;
}

/**
 * Decide whether the no-code-delta rescue lane applies.
 *
 * Fails closed on every unknown: an artifact that never recorded when its
 * review ended, or a caller that supplied no way to date-bound the branch,
 * cannot prove the code is untouched — and an unprovable claim is exactly what
 * this lane must not accept, or it degenerates into `--force` with a note
 * attached.
 */
function assessNoCodeDelta(opts: {
  reason: string | undefined;
  reviewEndedAt: string | undefined;
  commitsSince: ((sinceIso: string) => BranchCommit[]) | undefined;
}): NoCodeDeltaCheck {
  const reason = opts.reason?.trim();
  if (!reason) {
    return {
      ok: false,
      refusal:
        `- --rescue needs one of two authorizations, and this branch has neither:\n` +
        `    (a) a USER-approved micro-fix commit carrying the sentinel\n` +
        `        "${MICRO_FIX_SENTINEL}" — none was found on the branch; or\n` +
        `    (b) --reason "<why>", allowed only when nothing was committed after\n` +
        `        the review ended (there is then no code change to approve).\n\n` +
        `  If you fixed code, commit it with the sentinel and merge --rescue.\n` +
        `  If the reviewer objected to something other than the code — a stale\n` +
        `  line number in the run report, a claim you judge wrong — re-run with:\n` +
        `    dangeresque merge --rescue --reason "<why this verdict is overridden>"`,
    };
  }

  if (!opts.reviewEndedAt) {
    return {
      ok: false,
      refusal:
        `- --rescue --reason requires proof that no code changed after the review,\n` +
        `  but this run's artifact records no review end time to check against.\n` +
        `  Without it the claim is unverifiable, so the gate fails closed.\n` +
        `  Commit the approved fix with the sentinel "${MICRO_FIX_SENTINEL}"\n` +
        `  and merge --rescue, or re-run the review.`,
    };
  }

  if (!opts.commitsSince) {
    return {
      ok: false,
      refusal:
        `- --rescue --reason requires reading the branch's commit dates, but the\n` +
        `  caller supplied no way to do so (fail closed).`,
    };
  }

  const after = opts.commitsSince(opts.reviewEndedAt);
  if (after.length > 0) {
    const lines = after
      .slice(0, 10)
      .map((c) => `    - \`${c.sha.slice(0, 8)}\` ${c.committedAt} ${c.subject}`)
      .join("\n");
    const more = after.length > 10 ? `\n    …and ${after.length - 10} more` : "";
    return {
      ok: false,
      refusal:
        `- --rescue --reason applies only when the reviewer read the exact tree\n` +
        `  being merged, but ${after.length} commit(s) landed on this branch after\n` +
        `  the review ended at ${opts.reviewEndedAt}:\n${lines}${more}\n\n` +
        `  That code was never reviewed. Either mark it USER-approved by\n` +
        `  committing with the sentinel "${MICRO_FIX_SENTINEL}" and merging\n` +
        `  --rescue, or re-review with: dangeresque review <branch>`,
    };
  }

  return { ok: true, reason };
}

// Union of the two default mode lists so mergeGate's fail-closed check
// recognizes any mode dangeresque legitimately dispatches. Not exported —
// it's a local safety net, not a config concept.
function allKnownModes(): string[] {
  const set = new Set<string>([
    ...DEFAULT_DISPATCH_GATE_MODES,
    ...DEFAULT_MERGE_GATE_MODES,
  ]);
  return [...set];
}

function runGateCommands(
  commands: VerifyCommand[],
  cwd: string,
  env: Record<string, string>,
  label: string,
): VerificationResult[] {
  const results: VerificationResult[] = [];
  for (const command of commands) {
    console.log(`\n• ${label}: ${command.name} — ${command.cmd}`);
    const result = runSingleCommand(command, cwd, DEFAULT_VERIFY_LOG_BYTES, env);
    results.push(result);
    if (result.exit_code === 0) {
      console.log(`  ✓ ${result.name} passed (${formatMs(result.duration_ms)})`);
      continue;
    }
    if (result.on_failure === "block") {
      console.error(
        `  ✗ ${result.name} FAILED (exit=${result.exit_code}, ${formatMs(result.duration_ms)}) — blocking`,
      );
      if (result.stderr_excerpt.trim()) {
        const tail = result.stderr_excerpt.trim().split("\n").slice(-6).join("\n");
        console.error(`    stderr (tail):\n${tail.split("\n").map((l) => `      ${l}`).join("\n")}`);
      }
      break;
    }
    console.warn(
      `  ⚠ ${result.name} failed (exit=${result.exit_code}, ${formatMs(result.duration_ms)}) — warn-only, continuing`,
    );
  }
  return results;
}

function firstBlockingFailure(results: VerificationResult[]): VerificationResult | undefined {
  return results.find((r) => r.exit_code !== 0 && r.on_failure === "block");
}

function buildCommandFailureMessage(
  label: string,
  blocked: VerificationResult,
  mode: string,
  issueNumber: number | undefined,
): string {
  const issueStr = issueNumber !== undefined ? ` for issue #${issueNumber}` : "";
  const tail = blocked.stderr_excerpt.trim().split("\n").slice(-6).join("\n");
  const tailBlock = tail
    ? `\n- stderr (tail):\n${tail.split("\n").map((l) => `    ${l}`).join("\n")}`
    : "";
  return (
    `ERROR: ${label} refuses (${mode})${issueStr} because -\n` +
    `- command "${blocked.name}" (exit=${blocked.exit_code}) failed with on_failure=block` +
    tailBlock
  );
}

interface AcceptedArtifactCheck {
  ok: boolean;
  reason?: string;
  /** The verdict read from the located artifact, when one was found & parsed. */
  verdict?: ReviewerVerdict;
  /** Paths to the located artifact — set whenever an artifact was found & parsed. */
  jsonPath?: string;
  mdPath?: string;
  /**
   * `review.ended_at` from the located artifact, when the review ran and
   * recorded one. The no-code-delta rescue lane date-bounds the branch against
   * it; an empty or absent value makes that lane refuse.
   */
  reviewEndedAt?: string;
}

/**
 * Locate the latest `-${mode}.json` artifact for the merged branch's own mode
 * M (as resolved by extractMode) and check that review ran with an "accept"
 * verdict. Tries the worktree first (fresh mode-M run being merged has its
 * artifact there but not yet at projectRoot), and falls back to projectRoot
 * ONLY when the worktree has ZERO mode-M artifacts (e.g. a repeat REFACTOR
 * merge on an issue whose earlier REFACTOR was mirrored to projectRoot).
 *
 * Fail-closed: any check failure on a root's latest artifact is TERMINAL
 * — an older accepted artifact at projectRoot cannot silently override a
 * rejected/skipped latest artifact in the worktree. This closes the
 * fail-open hole where mirrorIssueRuns had copied round-1 artifacts into
 * a round-2 worktree, letting an old accept mask a new reject.
 */
/**
 * Newest `-<MODE>.md` artifact for an issue, and its sibling JSON path.
 *
 * Worktree first, project root second, first root with any mode-M artifact
 * wins — the same resolution `findAcceptedArtifactForMode` enforces its checks
 * against. Shared so the path handed to project commands and the path the gate
 * judges can never be two different files.
 */
function locateLatestArtifactForMode(
  worktreePath: string,
  projectRoot: string,
  issueNumber: number,
  mode: string,
): { mdPath: string; jsonPath: string; filename: string } | undefined {
  const roots = worktreePath === projectRoot ? [projectRoot] : [worktreePath, projectRoot];
  const suffix = `-${mode}.md`;
  for (const root of roots) {
    const files = listArchivedRuns(root, issueNumber).filter((f) => f.endsWith(suffix));
    if (files.length === 0) continue;
    const filename = files[files.length - 1];
    const mdPath = join(root, CONFIG_DIR, RUNS_DIR, `issue-${issueNumber}`, filename);
    return { mdPath, jsonPath: jsonPathForArchive(mdPath), filename };
  }
  return undefined;
}

function findAcceptedArtifactForMode(
  worktreePath: string,
  projectRoot: string,
  issueNumber: number,
  mode: string,
): AcceptedArtifactCheck {
  const located = locateLatestArtifactForMode(worktreePath, projectRoot, issueNumber, mode);
  if (located) {
    const { mdPath, jsonPath, filename: latest } = located;
    if (!existsSync(jsonPath)) {
      return {
        ok: false,
        reason: `latest ${mode} artifact ${latest} has no sibling JSON at ${jsonPath}`,
      };
    }
    let artifact: Partial<RunArtifact>;
    try {
      artifact = JSON.parse(readFileSync(jsonPath, "utf-8"));
    } catch (err) {
      return {
        ok: false,
        reason: `latest ${mode} artifact JSON unreadable (${jsonPath}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const review = artifact.review;
    if (!review) {
      return {
        ok: false,
        reason: `latest ${mode} artifact has no review phase (${jsonPath})`,
      };
    }
    if (review.skipped) {
      return {
        ok: false,
        reason: `latest ${mode} artifact has review.skipped=true (${jsonPath}) — merge blocked by mergeGate.requireAcceptedImplement`,
        verdict: artifact.reviewer_verdict,
        jsonPath,
        mdPath,
      };
    }
    if (artifact.reviewer_verdict !== "accept") {
      return {
        ok: false,
        reason: `latest ${mode} artifact reviewer_verdict is "${artifact.reviewer_verdict ?? "unknown"}", expected "accept" (${jsonPath})`,
        verdict: artifact.reviewer_verdict,
        jsonPath,
        mdPath,
        ...(review.ended_at ? { reviewEndedAt: review.ended_at } : {}),
      };
    }
    return { ok: true, verdict: "accept", jsonPath, mdPath };
  }
  return {
    ok: false,
    reason: `no ${mode} artifact found for issue #${issueNumber} in worktree or project root`,
  };
}

function relativeIssueRunsDir(issueNumber: number): string {
  return join(CONFIG_DIR, RUNS_DIR, `issue-${issueNumber}`) + "/";
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
