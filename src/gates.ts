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
  type ReviewerVerdict,
  type SentinelCommit,
} from "./artifact.js";
import {
  runSingleCommand,
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
  overriddenVerdict: ReviewerVerdict;
  sentinelCommits: SentinelCommit[];
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

  const env: Record<string, string> = {
    DANGERESQUE_ISSUE: String(issueNumber),
    DANGERESQUE_MODE: mode,
  };
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
   * verdict IFF `sentinelCommits` is non-empty. Strictly narrower than `force`:
   * it does NOT bypass a missing / skipped / unreadable / unknown review — only
   * a real non-accept verdict from a review that actually ran. Verification
   * commands still run regardless (the round-2 worker round-trip is the only
   * thing waived). Encodes bubble-craps CLAUDE.md 'MICRO-FIX LANE'.
   */
  rescue?: boolean;
  /**
   * Commits on the merged branch carrying MICRO_FIX_SENTINEL, discovered by the
   * caller (which owns git). Empty/absent ⇒ no sentinel ⇒ rescue refused.
   */
  sentinelCommits?: SentinelCommit[];
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
 *     DANGERESQUE_ISSUE / DANGERESQUE_MODE / DANGERESQUE_MERGE=1 env vars.
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
        if (sentinelCommits.length === 0) {
          return {
            ok: false,
            message:
              header +
              `- --rescue requires a USER-approved micro-fix commit carrying the ` +
              `sentinel "${MICRO_FIX_SENTINEL}" on the branch, but none was found.\n` +
              `  Commit the approved fix with that sentinel in its message, then ` +
              `merge --rescue.`,
          };
        }
        // Approved. Fall through to the command gate — verification is NEVER
        // waived by rescue; only the r2 worker round-trip is.
        rescueDecision = {
          overriddenVerdict: check.verdict!,
          sentinelCommits,
          jsonPath: check.jsonPath!,
          mdPath: check.mdPath!,
        };
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
            `  (only after a USER-approved micro-fix commit on the branch;\n` +
            `   applies to reject/needs_human_review verdicts, not skipped/missing reviews)`,
        };
      }
    }
  }

  const env: Record<string, string> = {
    DANGERESQUE_ISSUE: issueNumber !== undefined ? String(issueNumber) : "",
    DANGERESQUE_MODE: mode,
    DANGERESQUE_MERGE: "1",
  };
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
function findAcceptedArtifactForMode(
  worktreePath: string,
  projectRoot: string,
  issueNumber: number,
  mode: string,
): AcceptedArtifactCheck {
  const roots = worktreePath === projectRoot ? [projectRoot] : [worktreePath, projectRoot];
  const suffix = `-${mode}.md`;
  for (const root of roots) {
    const files = listArchivedRuns(root, issueNumber).filter((f) => f.endsWith(suffix));
    if (files.length === 0) continue;
    const latest = files[files.length - 1];
    const mdPath = join(root, CONFIG_DIR, RUNS_DIR, `issue-${issueNumber}`, latest);
    const jsonPath = jsonPathForArchive(mdPath);
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
