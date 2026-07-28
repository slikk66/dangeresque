import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, RUNS_DIR, PID_FILE, type MergeGateConfig } from "./config.js";
import {
  jsonPathForArchive,
  appendRescueRecord,
  type RunArtifact,
  type SentinelCommit,
} from "./artifact.js";
import { applyMergeGate, MICRO_FIX_SENTINEL, type MergeRescueDecision } from "./gates.js";

/**
 * Resolve the ref reviewers should diff against. Worktrees branch from
 * origin/HEAD (see createWorktree), and are rebased onto origin/main before
 * review. Diffing against local `main` would bleed local-only commits into the
 * review as phantom deletions when local is ahead of origin. Falls back to
 * `main` when origin is absent (e.g. offline repos, fresh clones without a
 * remote).
 */
export function resolveDiffBase(projectRoot: string): string {
  try {
    const ref = execSync(
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD",
      {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    return ref || "main";
  } catch {
    return "main";
  }
}

export interface PidInfo {
  /** Engine child PID (claude / codex). */
  pid: number;
  /**
   * Dangeresque CLI parent PID. Tracked separately so `dangeresque stop` can
   * SIGTERM the parent (which propagates to the engine and skips the review
   * pass) instead of only killing the engine and leaking review-pass spawns.
   */
  cliPid?: number;
  startedAt: number; // epoch ms
  workerSessionId?: string;
  reviewSessionId?: string;
  projectHash?: string;
  engine?: "claude" | "codex";
  workerLogPath?: string;
  reviewLogPath?: string;
  /** Absolute path to the run's archive file inside the worktree */
  archivePath?: string;
  /** Model driving the current phase (worker or review). */
  model?: string;
  /** Effort level driving the current phase. */
  effort?: string;
  /**
   * Current run phase: the mode (INVESTIGATE/IMPLEMENT/TEST/REFACTOR) while the
   * worker runs, "REVIEW" during the review pass. Reflects what is executing now.
   */
  phase?: string;
}

export function formatPidModelEffort(pidInfo: Pick<PidInfo, "model" | "effort">): string[] {
  const lines: string[] = [];
  if (pidInfo.model) lines.push(`  Model:  ${pidInfo.model}`);
  if (pidInfo.effort) lines.push(`  Effort: ${pidInfo.effort}`);
  return lines;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  commitEpoch: number;
  pidInfo?: PidInfo;
  running: boolean;
  /**
   * Lock reason when the worktree is locked, "" when locked without one,
   * undefined when unlocked. Engines lock the worktrees they open (see
   * unlockIfStale).
   */
  lockReason?: string;
}

export type WorktreeFilter = "all" | "running" | "finished";

export function filterWorktrees(
  worktrees: WorktreeInfo[],
  filter: WorktreeFilter,
): WorktreeInfo[] {
  if (filter === "all") return worktrees;
  if (filter === "running") return worktrees.filter((w) => w.running);
  return worktrees.filter((w) => !w.running);
}

interface WorktreePorcelainEntry {
  path: string;
  branch?: string;
  head?: string;
  /** Lock reason; "" when locked with no reason; undefined when unlocked. */
  lockReason?: string;
}

function parseWorktreePorcelain(output: string): WorktreePorcelainEntry[] {
  const entries: WorktreePorcelainEntry[] = [];

  for (const block of output.trim().split("\n\n")) {
    const lines = block.split("\n");
    const pathLine = lines.find((l: string) => l.startsWith("worktree "));
    if (!pathLine) continue;
    const branchLine = lines.find((l: string) => l.startsWith("branch "));
    const headLine = lines.find((l: string) => l.startsWith("HEAD "));
    const lockLine = lines.find(
      (l: string) => l === "locked" || l.startsWith("locked "),
    );

    entries.push({
      path: pathLine.replace("worktree ", ""),
      branch: branchLine?.replace("branch refs/heads/", ""),
      head: headLine?.replace("HEAD ", ""),
      lockReason: lockLine === undefined ? undefined : lockLine.slice("locked".length).trim(),
    });
  }

  return entries;
}

export function listWorktrees(projectRoot: string): WorktreeInfo[] {
  const output = execSync("git worktree list --porcelain", {
    cwd: projectRoot,
    encoding: "utf-8",
  });

  const worktrees: WorktreeInfo[] = [];

  for (const entry of parseWorktreePorcelain(output)) {
    if (!entry.branch) continue;

    const path = entry.path;
    const branch = entry.branch;
    const head = entry.head ?? "";

    // Include all dangeresque worktrees (they live under .claude/worktrees/)
    if (path.includes(".claude/worktrees/")) {
      let commitEpoch = 0;
      try {
        const ts = execSync(`git log -1 --format=%ct ${head}`, {
          cwd: projectRoot,
          encoding: "utf-8",
          stdio: "pipe",
        }).trim();
        commitEpoch = parseInt(ts, 10) || 0;
      } catch {
        /* fallback to 0 */
      }

      // Check PID file for running state
      const { pidInfo, running } = readPidState(path);
      worktrees.push({
        path,
        branch,
        head,
        commitEpoch,
        pidInfo,
        running,
        lockReason: entry.lockReason,
      });
    }
  }

  return worktrees;
}

/**
 * Refuse to proceed if cwd is inside a linked worktree rather than the main checkout.
 * Detects via `git rev-parse --git-dir` vs `--git-common-dir` — they differ inside a
 * linked worktree, match in the main checkout. Throws with a clear remediation message.
 */
export function assertInMainCheckout(
  projectRoot: string,
  command: string,
): void {
  const gitDir = execSync("git rev-parse --path-format=absolute --git-dir", {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
  const commonDir = execSync(
    "git rev-parse --path-format=absolute --git-common-dir",
    {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    },
  ).trim();

  if (gitDir !== commonDir) {
    const mainCheckout = commonDir.replace(/\/\.git\/?$/, "");
    throw new Error(
      `dangeresque ${command} must run from the main project checkout, not from inside a worktree.\n` +
        `Currently in: ${projectRoot}\n` +
        `cd ${mainCheckout} and retry.`,
    );
  }
}

// --- PID file management ---

/**
 * Liveness probe for a recorded PID. `process.kill(pid, 0)` is a no-op signal
 * that throws ESRCH when the PID does not exist (treated as not-running) and
 * EPERM when it exists but is owned by another user (treated as not-running
 * here — single-user CLI invariant).
 */
export function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Git prints resolved paths in `worktree list --porcelain`, while dangeresque
 * builds worktree paths by joining projectRoot — on macOS those differ (/tmp
 * vs /private/tmp). Compare both through realpath so the lock lookup matches.
 */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readWorktreeLock(
  projectRoot: string,
  worktreePath: string,
): string | undefined {
  const target = realpathOrSelf(worktreePath);
  const output = execSync("git worktree list --porcelain", {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
  for (const entry of parseWorktreePorcelain(output)) {
    if (realpathOrSelf(entry.path) === target) return entry.lockReason;
  }
  return undefined;
}

/**
 * Claude Code locks every worktree a session opens, with reason
 * `claude session <name> (pid <N> start <T>)`, and does not release it on
 * headless exit — so a *successful* run reliably leaves a lock whose pid is
 * dead. Git then refuses `worktree remove` (even with a single --force; it
 * wants `-f -f`), which turned landed merges into exit-1 failures (#84).
 *
 * Clear a lock whose owning process is gone. Refuse loudly otherwise: a live
 * pid means a real session is working in there, and a lock we cannot attribute
 * to a process was put there deliberately by someone else.
 */
export function unlockIfStale(projectRoot: string, worktreePath: string): void {
  const reason = readWorktreeLock(projectRoot, worktreePath);
  if (reason === undefined) return;

  const pid = Number(reason.match(/\(pid (\d+)\b/)?.[1]);

  if (!pid) {
    throw new Error(
      `worktree is locked with a reason dangeresque cannot attribute to a process ` +
        `("${reason || "no reason given"}"). Refusing to unlock it. If the lock is stale and safe ` +
        `to drop: git worktree unlock "${worktreePath}"`,
    );
  }
  if (isPidAlive(pid)) {
    throw new Error(
      `worktree is locked by a live process ("${reason}"). Refusing to unlock it — ` +
        `a session is still working in ${worktreePath}. Stop it first, then retry.`,
    );
  }

  execSync(`git worktree unlock "${worktreePath}"`, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function formatElapsedMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortBranchForRemediation(branch: string): string {
  return branch.replace(/^worktree-dangeresque-/, "").replace(/^worktree-/, "");
}

function readPidState(worktreePath: string): {
  pidInfo?: PidInfo;
  running: boolean;
} {
  const pidPath = join(worktreePath, PID_FILE);
  if (!existsSync(pidPath)) return { running: false };

  try {
    const pidInfo: PidInfo = JSON.parse(readFileSync(pidPath, "utf-8"));
    // A run is considered live if EITHER the engine child OR the dangeresque
    // CLI parent is still alive. The engine may be between worker→review
    // transitions (engine briefly absent, parent still running) or vice-versa.
    const engineAlive = isPidAlive(pidInfo.pid);
    const parentAlive = isPidAlive(pidInfo.cliPid);
    return { pidInfo, running: engineAlive || parentAlive };
  } catch {
    return { running: false };
  }
}

export function writePidFile(
  worktreePath: string,
  pid: number,
  extra?: Partial<PidInfo>,
): void {
  const pidPath = join(worktreePath, PID_FILE);
  const info: PidInfo = { pid, startedAt: Date.now(), ...extra };
  writeFileSync(pidPath, JSON.stringify(info));
}

export function updatePidFile(
  worktreePath: string,
  partial: Partial<PidInfo>,
): void {
  const pidPath = join(worktreePath, PID_FILE);
  if (!existsSync(pidPath)) return;
  try {
    const existing: PidInfo = JSON.parse(readFileSync(pidPath, "utf-8"));
    writeFileSync(pidPath, JSON.stringify({ ...existing, ...partial }));
  } catch {
    /* ignore */
  }
}

export function readPidFile(worktreePath: string): PidInfo | undefined {
  const pidPath = join(worktreePath, PID_FILE);
  if (!existsSync(pidPath)) return undefined;
  try {
    return JSON.parse(readFileSync(pidPath, "utf-8"));
  } catch {
    return undefined;
  }
}

export function removePidFile(worktreePath: string): void {
  const pidPath = join(worktreePath, PID_FILE);
  if (existsSync(pidPath)) rmSync(pidPath);
}

/**
 * Resolve a shorthand branch name to the actual branch.
 * Tries: exact → worktree-dangeresque-<input> → worktree-<input>
 */
export function resolveBranch(projectRoot: string, input: string): string {
  const candidates = [
    input,
    `worktree-dangeresque-${input}`,
    `worktree-${input}`,
  ];

  for (const candidate of candidates) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return candidate;
    } catch {
      // Not found, try next
    }
  }

  throw new Error(
    `Branch not found. Tried: ${candidates.join(", ")}\nRun 'dangeresque status' to see active worktrees.`,
  );
}

// --- Run archive readers ---
// Workers write their run result inside the worktree at
// <worktree>/.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md and commit it on
// the worktree branch. It only lands at <projectRoot>/.dangeresque/runs/…
// after `dangeresque merge`. Callers pass whichever root matches the lookup
// they want: worktree path for pre-merge, project root for post-merge.

function getRunsDir(projectRoot: string): string {
  return join(projectRoot, CONFIG_DIR, RUNS_DIR);
}

function getIssueRunsDir(projectRoot: string, issueNumber: number): string {
  return join(getRunsDir(projectRoot), `issue-${issueNumber}`);
}

/**
 * Copy an issue's run-artifact directory between two roots (worktree ↔ main
 * checkout). The runs dir is gitignored, so dangeresque carries it across
 * the worktree boundary by file copy: project-root → new worktree at run
 * start so workers see prior runs, worktree → project-root on merge so
 * merged history persists. No-op when the source dir is missing.
 */
export function mirrorIssueRuns(
  srcRoot: string,
  destRoot: string,
  issueNumber: number,
): void {
  const srcDir = getIssueRunsDir(srcRoot, issueNumber);
  if (!existsSync(srcDir)) return;
  const destDir = getIssueRunsDir(destRoot, issueNumber);
  mkdirSync(destDir, { recursive: true });
  cpSync(srcDir, destDir, { recursive: true, force: true });
}

/**
 * Copy EVERY `issue-*` run directory found under srcRoot's runs dir to destRoot.
 * Used on merge to carry a worktree's gitignored run artifacts back to the
 * project root. Unlike mirrorIssueRuns this takes no issue number: the runs are
 * keyed by the real issue number at write time, independent of the branch name,
 * so the dirs on disk are the source of truth. Parsing the number out of the
 * branch name instead silently lost artifacts whenever the name carried a slug
 * suffix (e.g. `-dicecursor`) — see the merge call site. Returns the issue
 * directory names copied (e.g. ["issue-537"]); empty when there's nothing to
 * mirror.
 */
export function mirrorAllIssueRuns(
  srcRoot: string,
  destRoot: string,
): string[] {
  const srcRunsDir = getRunsDir(srcRoot);
  if (!existsSync(srcRunsDir)) return [];
  const issueDirs = readdirSync(srcRunsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("issue-"))
    .map((e) => e.name);
  if (issueDirs.length === 0) return [];
  const destRunsDir = getRunsDir(destRoot);
  mkdirSync(destRunsDir, { recursive: true });
  for (const name of issueDirs) {
    cpSync(join(srcRunsDir, name), join(destRunsDir, name), {
      recursive: true,
      force: true,
    });
  }
  return issueDirs;
}

/**
 * List run result files for an issue, sorted chronologically (oldest first).
 */
export function listArchivedRuns(
  projectRoot: string,
  issueNumber: number,
): string[] {
  const issueDir = getIssueRunsDir(projectRoot, issueNumber);
  if (!existsSync(issueDir)) return [];
  return readdirSync(issueDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/**
 * Read a specific run result file for an issue.
 */
export function readArchivedRun(
  projectRoot: string,
  issueNumber: number,
  filename: string,
): string {
  return readFileSync(
    join(getIssueRunsDir(projectRoot, issueNumber), filename),
    "utf-8",
  );
}

/**
 * Parse the <!-- SUMMARY --> block from a run result file's content.
 * Returns the summary lines, or null if no block found.
 */
export function parseSummaryBlock(content: string): string | null {
  const match = content.match(
    /<!-- SUMMARY -->\n([\s\S]*?)\n<!-- \/SUMMARY -->/,
  );
  return match ? match[1].trim() : null;
}

/**
 * Extract a one-line summary from an archived run filename + content.
 * Format: "Run N (MODE): status — files, verdict"
 */
export function formatRunOneLiner(
  filename: string,
  content: string,
  index: number,
): string {
  // Extract mode from filename: 2026-04-02T14-30-00-IMPLEMENT.md → IMPLEMENT
  const modeMatch = filename.match(/-([A-Z]+)\.md$/);
  const mode = modeMatch ? modeMatch[1] : "UNKNOWN";

  const summary = parseSummaryBlock(content);
  if (summary) {
    // Parse first line: "Mode: IMPLEMENT | Status: implemented, unverified"
    const statusMatch = summary.match(/Status:\s*(.+)/);
    const status = statusMatch ? statusMatch[1].trim() : "unknown";
    const filesMatch = summary.match(/Files:\s*(.+)/);
    const files = filesMatch ? filesMatch[1].trim() : "";
    return `Run ${index + 1} (${mode}): ${status}${files ? ` — ${files}` : ""}`;
  }

  // Fallback: no summary block (older run)
  return `Run ${index + 1} (${mode}): ${filename}`;
}

/**
 * Render a skim-friendly header block from a run's JSON artifact: summary line,
 * verdict, scope counts (in/extended/outside), failure categories. Returns null
 * when the JSON is missing or unparseable so callers can fall back to the
 * pre-header layout.
 */
export function formatRunHeader(jsonPath: string): string | null {
  if (!existsSync(jsonPath)) return null;
  let artifact: Partial<RunArtifact>;
  try {
    artifact = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } catch {
    return null;
  }

  const summary = typeof artifact.summary === "string" ? artifact.summary : null;
  const verdict =
    typeof artifact.reviewer_verdict === "string"
      ? artifact.reviewer_verdict
      : null;
  if (!summary || !verdict) return null;

  const report = artifact.scope_report;
  const inCount = Array.isArray(report?.in_scope) ? report.in_scope.length : 0;
  const extCount = Array.isArray(report?.extended) ? report.extended.length : 0;
  const outCount = Array.isArray(report?.outside) ? report.outside.length : 0;
  const fails = Array.isArray(artifact.failure_categories)
    ? artifact.failure_categories
    : [];

  return [
    `=== ${summary} ===`,
    `Verdict: ${verdict}`,
    `Scope: in=${inCount} extended=${extCount} outside=${outCount}`,
    `Failure categories: ${fails.length > 0 ? fails.join(", ") : "none"}`,
  ].join("\n");
}

/**
 * Delete archived runs for an issue.
 */
export function cleanArchivedRuns(
  projectRoot: string,
  issueNumber: number,
): { success: boolean; message: string } {
  const issueDir = getIssueRunsDir(projectRoot, issueNumber);
  if (!existsSync(issueDir)) {
    return {
      success: false,
      message: `No archived runs found for issue #${issueNumber}`,
    };
  }

  const files = listArchivedRuns(projectRoot, issueNumber);
  rmSync(issueDir, { recursive: true });
  return {
    success: true,
    message: `Deleted ${files.length} archived run(s) for issue #${issueNumber}`,
  };
}

// --- Worktree operations ---

/**
 * Extract issue number from branch name.
 * worktree-dangeresque-investigate-63 → 63
 * Tolerates a descriptive slug after the number (used to disambiguate
 * multiple runs on one issue): worktree-dangeresque-investigate-63-dicecursor → 63.
 * The number is the segment immediately after the mode word, so it's matched
 * there rather than anchored to the end of the string.
 */
export function extractIssueNumber(branch: string): number | undefined {
  const stripped = branch
    .replace(/^worktree-/, "")
    .replace(/^dangeresque-/, "");
  const match = stripped.match(/^[a-z]+-(\d+)(?:-.*)?$/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Extract mode from branch name.
 * worktree-dangeresque-investigate-63 → INVESTIGATE
 * Tolerates a descriptive slug after the issue number (used to disambiguate
 * multiple runs on one issue): worktree-dangeresque-implement-42-round2 →
 * IMPLEMENT. Mirrors extractIssueNumber's slug tolerance (commit 185f488):
 * without this, gates keyed on the mode fail open on any slug-suffixed
 * branch, silently letting merges through.
 */
export function extractMode(branch: string): string {
  // Remove worktree- and dangeresque- prefixes, then take the part before the issue number
  const stripped = branch
    .replace(/^worktree-/, "")
    .replace(/^dangeresque-/, "");
  const modeMatch = stripped.match(/^([a-z]+)-\d+(?:-.*)?$/);
  return modeMatch ? modeMatch[1].toUpperCase() : "UNKNOWN";
}

/**
 * Commits on `branch` not reachable from HEAD (the main checkout) whose message
 * carries MICRO_FIX_SENTINEL — the USER-approved micro-fixes that authorize a
 * `merge --rescue`. Message-content match in JS (not `git log --grep`) so the
 * bracketed sentinel needs no shell/regex escaping. Best-effort: a git failure
 * yields [] (⇒ rescue refuses, fail closed).
 */
export function findSentinelCommits(projectRoot: string, branch: string): SentinelCommit[] {
  let raw: string;
  try {
    raw = execSync(
      `git log --no-color --format=%H%x1f%s%x1f%b%x1e HEAD..${branch}`,
      { cwd: projectRoot, encoding: "utf-8", stdio: "pipe", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  const commits: SentinelCommit[] = [];
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const [sha = "", subject = "", body = ""] = record.replace(/^\n/, "").split("\x1f");
    if (`${subject}\n${body}`.includes(MICRO_FIX_SENTINEL)) {
      commits.push({ sha: sha.trim(), subject: subject.trim() });
    }
  }
  return commits;
}

export type WorktreePhase = "merge" | "cleanup" | "branch-delete" | "noop" | "gate";

export interface WorktreeOpResult {
  success: boolean;
  message: string;
  phase?: WorktreePhase;
  /** True iff main's HEAD advanced as a result of this call. */
  headAdvanced?: boolean;
  headBefore?: string;
  headAfter?: string;
  /**
   * True when the operation refused because of a workflow gate (e.g. worker
   * still running). CLI commands map this to exit code 2 so the orchestrator
   * can distinguish "fix workflow and retry" from a real error (exit 1).
   */
  gateRefusal?: boolean;
}

export function mergeWorktree(
  projectRoot: string,
  branch: string,
  mergeGate?: MergeGateConfig,
  rescue = false,
): WorktreeOpResult {
  // Gate: refuse if worker (engine or parent CLI) is still running. Without
  // this check git happily merges a branch whose worktree is mid-edit, then
  // Phase 2 yanks the directory out from under the live process.
  const worktreeName = branch.replace("worktree-", "");
  const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);
  if (existsSync(worktreePath)) {
    const { pidInfo, running } = readPidState(worktreePath);
    if (running && pidInfo) {
      const elapsed = formatElapsedMs(Date.now() - pidInfo.startedAt);
      const short = shortBranchForRemediation(branch);
      return {
        success: false,
        phase: "gate",
        gateRefusal: true,
        message:
          `ERROR: refusing to merge ${branch} because -\n` +
          `- worker is still running (pid ${pidInfo.pid}, started ${elapsed} ago)\n\n` +
          `Stop it first:\n` +
          `  dangeresque stop ${short}`,
      };
    }
  }

  // mergeGate: project-owned pre-merge enforcement. Runs after the running-
  // worker gate and before the git merge. Refusal → gateRefusal exit 2.
  // Absent config = no-op. See src/gates.ts for the check semantics.
  let rescueDecision: MergeRescueDecision | undefined;
  if (mergeGate) {
    const gate = applyMergeGate({
      projectRoot,
      worktreePath,
      issueNumber: extractIssueNumber(branch),
      mode: extractMode(branch),
      config: mergeGate,
      rescue,
      sentinelCommits: rescue ? findSentinelCommits(projectRoot, branch) : undefined,
    });
    if (!gate.ok) {
      return {
        success: false,
        phase: "gate",
        gateRefusal: true,
        message: gate.message ?? "mergeGate refused (no message).",
      };
    }
    rescueDecision = gate.rescue;
  }

  let headBefore: string;
  try {
    headBefore = execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (err) {
    return {
      success: false,
      phase: "merge",
      headAdvanced: false,
      message: `Could not read HEAD before merge: ${err instanceof Error ? err.message : String(err)}. Main is unchanged.`,
    };
  }

  // Phase 1: merge. DANGERESQUE_MERGE=1 is exported so consumer git hooks
  // can distinguish a dangeresque-orchestrated merge from a direct commit.
  try {
    execSync(`git merge ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, DANGERESQUE_MERGE: "1" },
    });
  } catch (err) {
    const mergeErr = err instanceof Error ? err.message : String(err);

    // A conflicting merge leaves MERGE_HEAD + conflict markers in the main
    // checkout even though the ref never moved — every later merge then dies
    // with "unresolved conflict" until someone aborts (#88). Abort here so
    // "Main is unchanged" is true of the working tree, not just the ref.
    let midMerge = false;
    try {
      execSync("git rev-parse -q --verify MERGE_HEAD", {
        cwd: projectRoot,
        stdio: "pipe",
      });
      midMerge = true;
    } catch {
      // no MERGE_HEAD — merge never started, tree untouched
    }

    if (!midMerge) {
      return {
        success: false,
        phase: "merge",
        headAdvanced: false,
        headBefore,
        message: `Merge did not occur: ${mergeErr}. Main is unchanged at ${headBefore.slice(0, 8)}.`,
      };
    }

    // List conflicts before aborting — the abort clears them.
    let conflictNote = "";
    try {
      const conflicted = execSync("git diff --name-only --diff-filter=U", {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      if (conflicted) {
        conflictNote = `\nConflicting files:\n${conflicted
          .split("\n")
          .map((f) => `  ${f}`)
          .join("\n")}`;
      }
    } catch {
      // conflict listing is best-effort
    }

    try {
      execSync("git merge --abort", {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch (abortErr) {
      return {
        success: false,
        phase: "merge",
        headAdvanced: false,
        headBefore,
        message:
          `Merge failed: ${mergeErr}\n` +
          `Automatic 'git merge --abort' ALSO failed: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}\n` +
          `Main working tree is mid-merge. Recover manually:\n` +
          `  git merge --abort` +
          conflictNote,
      };
    }

    return {
      success: false,
      phase: "merge",
      headAdvanced: false,
      headBefore,
      message:
        `Merge did not occur: ${mergeErr}\n` +
        `In-progress merge aborted — working tree restored. Main is unchanged at ${headBefore.slice(0, 8)}.` +
        conflictNote,
    };
  }

  let headAfter: string;
  try {
    headAfter = execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch (err) {
    return {
      success: false,
      phase: "merge",
      headBefore,
      message: `Could not read HEAD after merge: ${err instanceof Error ? err.message : String(err)}. Main state unknown — inspect 'git log' before retrying.`,
    };
  }

  // After #57, INVESTIGATE/VERIFY worktrees end here with no commits ahead of
  // origin/main (artifacts are gitignored and flow via mirrorIssueRuns, not
  // git merge). A no-op `git merge` is therefore the expected success path
  // for no-code modes — fall through to Phase 2 so the mirror step still
  // runs and the worktree gets torn down. The final success message
  // disambiguates the noop case from a real fast-forward.
  const noopMerge = headBefore === headAfter;
  const mergeOutcome = noopMerge
    ? `No commits merged (HEAD unchanged at ${headBefore.slice(0, 8)})`
    : `Merge succeeded — main is now at ${headAfter.slice(0, 8)} (was ${headBefore.slice(0, 8)})`;

  // Rescue audit: the merge landed over a reviewed non-accept verdict on a
  // USER-approved micro-fix. Annotate the run artifact with a RESCUE record
  // BEFORE mirroring so the copy at projectRoot carries the audit trail. Best-
  // effort: the merge already succeeded, so an annotation failure warns rather
  // than fails the operation.
  let rescueNote = "";
  if (rescueDecision) {
    try {
      appendRescueRecord(rescueDecision.jsonPath, rescueDecision.mdPath, {
        overridden_verdict: rescueDecision.overriddenVerdict,
        sentinel_commits: rescueDecision.sentinelCommits,
        rescued_at: new Date().toISOString(),
      });
      const shas = rescueDecision.sentinelCommits.map((c) => c.sha.slice(0, 7)).join(", ");
      rescueNote = ` RESCUE: merged over "${rescueDecision.overriddenVerdict}" verdict on USER-approved micro-fix (${shas}); verification gates still ran.`;
    } catch (err) {
      rescueNote = ` RESCUE: merged over "${rescueDecision.overriddenVerdict}" verdict, but writing the RESCUE audit record to ${rescueDecision.jsonPath} FAILED: ${err instanceof Error ? err.message : String(err)} — record it manually.`;
    }
  }

  // Phase 2: worktree cleanup (worktreePath already resolved at top of function).
  // Mirror gitignored run artifacts out of the worktree before removing it, so
  // per-run history persists at the project root after merge. Driven by the
  // issue-* dirs actually present in the worktree (the source of truth) rather
  // than a number parsed from the branch name — a descriptive branch slug like
  // `-dicecursor` used to make extractIssueNumber return undefined, which
  // silently skipped this whole step while still reporting success. Verified
  // after copy and failed loud if anything didn't land — the success line must
  // never claim a mirror that didn't happen.
  let mirrorNote = "";
  if (existsSync(worktreePath)) {
    let mirrored: string[];
    try {
      mirrored = mirrorAllIssueRuns(worktreePath, projectRoot);
    } catch (err) {
      return {
        success: false,
        phase: "cleanup",
        headAdvanced: !noopMerge,
        headBefore,
        headAfter,
        message:
          `${mergeOutcome}. ` +
          `Mirroring run artifacts to project root failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Worktree NOT removed at ${worktreePath} — copy ${worktreePath}/.dangeresque/runs/ ` +
          `to ${projectRoot}/.dangeresque/runs/, then 'dangeresque discard ${branch}' to clean up.`,
      };
    }
    const missing = mirrored.filter(
      (dir) => !existsSync(join(getRunsDir(projectRoot), dir)),
    );
    if (missing.length > 0) {
      return {
        success: false,
        phase: "cleanup",
        headAdvanced: !noopMerge,
        headBefore,
        headAfter,
        message:
          `${mergeOutcome}. ` +
          `Run artifacts failed to land at project root (${missing.join(", ")}). ` +
          `Worktree NOT removed at ${worktreePath} — copy ${worktreePath}/.dangeresque/runs/ ` +
          `to ${projectRoot}/.dangeresque/runs/, then 'dangeresque discard ${branch}' to clean up.`,
      };
    }
    mirrorNote =
      mirrored.length > 0
        ? `Mirrored run artifacts (${mirrored.join(", ")}) to project root and removed worktree.`
        : `No run artifacts to mirror; removed worktree.`;
    try {
      unlockIfStale(projectRoot, worktreePath);
      execSync(`git worktree remove "${worktreePath}"`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err) {
      return {
        success: false,
        phase: "cleanup",
        headAdvanced: !noopMerge,
        headBefore,
        headAfter,
        message:
          `${mergeOutcome}. ` +
          `Worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Recovery: (1) inspect ${worktreePath} for uncommitted work, ` +
          `(2) 'git worktree unlock "${worktreePath}"' if it is still locked, then ` +
          `'git worktree remove --force "${worktreePath}"' if safe, ` +
          `(3) 'git branch -D ${branch}'.`,
      };
    }
  }

  // Phase 3: branch delete. Use -D because the dangeresque workflow merges
  // locally before the human pushes — so -d's upstream-tracking safety check
  // refuses even though the branch is merged to HEAD. Phase 1's
  // headBefore !== headAfter guard already enforces the real invariant (merge
  // landed on local HEAD), which is the check we actually care about.
  try {
    execSync(`git branch -D ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    return {
      success: false,
      phase: "branch-delete",
      headAdvanced: !noopMerge,
      headBefore,
      headAfter,
      message:
        `${mergeOutcome}; worktree removed. ` +
        `Branch delete failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Recovery: check 'git branch --list ${branch}' and 'git worktree list'; if the branch is checked out in another worktree, remove that worktree first, then 'git branch -D ${branch}'.`,
    };
  }

  return {
    success: true,
    phase: noopMerge ? "noop" : "merge",
    headAdvanced: !noopMerge,
    headBefore,
    headAfter,
    message: noopMerge
      ? `Merged ${branch}: no code changes (HEAD unchanged at ${headBefore.slice(0, 7)}). ${mirrorNote}${rescueNote}`.trim()
      : `Merged ${branch} into main. Main: ${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}. ${mirrorNote}${rescueNote}`.trim(),
  };
}

export interface DiscardOptions {
  /**
   * If true, kill any running worker (parent CLI + engine child) before
   * discarding. Without --force, a running worker causes refusal.
   */
  force?: boolean;
}

export async function discardWorktree(
  projectRoot: string,
  branch: string,
  opts: DiscardOptions = {},
): Promise<WorktreeOpResult> {
  const worktreeName = branch.replace("worktree-", "");
  const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);

  // Gate: refuse if worker is still running, unless --force.
  if (existsSync(worktreePath)) {
    const { pidInfo, running } = readPidState(worktreePath);
    if (running && pidInfo) {
      if (opts.force) {
        const stopResult = await stopWorktree(projectRoot, branch);
        if (!stopResult.success) {
          return {
            success: false,
            phase: "gate",
            gateRefusal: false,
            message: `Failed to stop running worker before discarding ${branch}: ${stopResult.message}`,
          };
        }
      } else {
        const elapsed = formatElapsedMs(Date.now() - pidInfo.startedAt);
        const short = shortBranchForRemediation(branch);
        return {
          success: false,
          phase: "gate",
          gateRefusal: true,
          message:
            `ERROR: refusing to discard ${branch} because -\n` +
            `- worker is still running (pid ${pidInfo.pid}, started ${elapsed} ago)\n\n` +
            `Stop it first:\n` +
            `  dangeresque stop ${short}\n\n` +
            `Or, if you really want to discard anyway (this will kill the worker), re-run with --force.`,
        };
      }
    }
  }

  let removedWorktree = false;

  // Phase 1: worktree cleanup
  if (existsSync(worktreePath)) {
    try {
      unlockIfStale(projectRoot, worktreePath);
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      removedWorktree = true;
    } catch (err) {
      return {
        success: false,
        phase: "cleanup",
        message:
          `Worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Recovery: (1) inspect ${worktreePath}, ` +
          `(2) 'git worktree unlock "${worktreePath}"' if it is still locked, then ` +
          `'git worktree remove --force "${worktreePath}"', ` +
          `(3) 'git branch -D ${branch}'.`,
      };
    }
  }

  // Phase 2: branch delete
  let branchExists = true;
  try {
    execSync(`git rev-parse --verify --quiet ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    branchExists = false;
  }

  if (!branchExists) {
    if (!removedWorktree) {
      return {
        success: false,
        phase: "cleanup",
        message: `Nothing to discard: no worktree or branch found for ${branch}`,
      };
    }
    return {
      success: true,
      phase: "cleanup",
      message: `Discarded ${branch} and cleaned up (branch was already gone)`,
    };
  }

  try {
    execSync(`git branch -D ${branch}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    const prefix = removedWorktree ? "Worktree removed. " : "";
    return {
      success: false,
      phase: "branch-delete",
      message:
        `${prefix}Branch delete failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Recovery: 'git branch -D ${branch}'.`,
    };
  }

  return {
    success: true,
    phase: "branch-delete",
    message: `Discarded ${branch} and cleaned up`,
  };
}

export function getWorktreeResults(
  projectRoot: string,
  branch: string,
): string {
  const worktrees = listWorktrees(projectRoot);

  if (worktrees.length === 0) {
    return `No active dangeresque worktrees found. (cwd=${process.cwd()})`;
  }

  const targetWorktree = worktrees.find(
    (wt) => wt.branch === branch || wt.path.includes(branch),
  );
  if (!targetWorktree) {
    return `Worktree not found: ${branch}\nActive worktrees: ${worktrees.map((w) => w.branch).join(", ")}`;
  }

  const lines: string[] = [];
  lines.push(`Worktree: ${targetWorktree.path}`);
  lines.push(`Branch:   ${targetWorktree.branch}`);
  lines.push(`HEAD:     ${targetWorktree.head.slice(0, 8)}`);
  lines.push("");

  const issueNum = extractIssueNumber(targetWorktree.branch);
  // Read artifacts from the worktree, not the project root — they only land
  // at the project root after `dangeresque merge`.
  const archived = issueNum
    ? listArchivedRuns(targetWorktree.path, issueNum)
    : [];
  const latestName =
    archived.length > 0 ? archived[archived.length - 1] : null;

  if (latestName && issueNum) {
    const latestMdPath = join(
      targetWorktree.path,
      CONFIG_DIR,
      RUNS_DIR,
      `issue-${issueNum}`,
      latestName,
    );
    const header = formatRunHeader(jsonPathForArchive(latestMdPath));
    if (header) {
      lines.push(header);
      lines.push("");
    }
  }

  const diffBase = resolveDiffBase(projectRoot);
  lines.push(`--- Diff Summary (vs ${diffBase}) ---`);
  try {
    const diff = execSync(`git diff ${diffBase} --stat`, {
      cwd: targetWorktree.path,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    lines.push(diff.trim() || "No changes.");
  } catch {
    lines.push("Could not generate diff summary.");
  }
  lines.push("");

  if (issueNum) {
    if (archived.length > 0) {
      if (archived.length > 1) {
        lines.push("--- Previous runs ---");
        for (let i = 0; i < archived.length - 1; i++) {
          const content = readArchivedRun(
            targetWorktree.path,
            issueNum,
            archived[i],
          );
          lines.push(formatRunOneLiner(archived[i], content, i));
        }
        lines.push("");
      }
      const latest = readArchivedRun(
        targetWorktree.path,
        issueNum,
        latestName!,
      );
      lines.push(`--- Latest run: ${latestName} ---`);
      lines.push(latest);
    } else {
      lines.push(
        `No run artifacts in ${targetWorktree.path}/.dangeresque/runs/issue-${issueNum}/`,
      );
    }
  } else {
    lines.push("Worktree has no associated issue — no run artifacts tracked.");
  }

  return lines.join("\n");
}

/**
 * Show archived results for a specific issue (used by `results --issue`)
 */
export function getArchivedResults(
  projectRoot: string,
  issueNumber: number,
  showAll: boolean,
): string {
  const archived = listArchivedRuns(projectRoot, issueNumber);
  if (archived.length === 0) {
    return `No runs found for issue #${issueNumber}`;
  }

  const lines: string[] = [];
  lines.push(`Runs for issue #${issueNumber} (${archived.length} total)\n`);

  if (showAll) {
    for (let i = 0; i < archived.length; i++) {
      const content = readArchivedRun(projectRoot, issueNumber, archived[i]);
      lines.push(`=== Run ${i + 1}: ${archived[i]} ===`);
      lines.push(content);
      lines.push("");
    }
  } else {
    for (let i = 0; i < archived.length - 1; i++) {
      const content = readArchivedRun(projectRoot, issueNumber, archived[i]);
      lines.push(formatRunOneLiner(archived[i], content, i));
    }
    if (archived.length > 1) lines.push("");
    const latestName = archived[archived.length - 1];

    const latestMdPath = join(
      getIssueRunsDir(projectRoot, issueNumber),
      latestName,
    );
    const header = formatRunHeader(jsonPathForArchive(latestMdPath));
    if (header) {
      lines.push(header);
      lines.push("");
    }

    const latest = readArchivedRun(projectRoot, issueNumber, latestName);
    lines.push(`--- Latest: Run ${archived.length} (${latestName}) ---`);
    lines.push(latest);
  }

  return lines.join("\n");
}

// --- stop ---

export interface StopResult {
  success: boolean;
  /** True if at least one tracked process was alive and signalled. */
  killed: boolean;
  message: string;
}

const STOP_GRACE_MS = 5000;

async function waitForExit(pids: number[], deadlineMs: number): Promise<void> {
  while (Date.now() < deadlineMs) {
    if (pids.every((p) => !isPidAlive(p))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Stop a running worker. Sends SIGTERM to the dangeresque CLI parent and the
 * engine child (both tracked in the PID file), waits up to 5s, then SIGKILLs
 * any survivors. Worktree is left intact for inspection. PID file is cleared.
 *
 * Idempotent: if no PID file exists or the recorded processes are already
 * dead, returns success with `killed: false` and clears any stale PID file.
 */
export async function stopWorktree(
  projectRoot: string,
  branch: string,
): Promise<StopResult> {
  const worktreeName = branch.replace("worktree-", "");
  const worktreePath = join(projectRoot, ".claude", "worktrees", worktreeName);

  if (!existsSync(worktreePath)) {
    return {
      success: false,
      killed: false,
      message: `Worktree not found: ${worktreePath}`,
    };
  }

  const pidInfo = readPidFile(worktreePath);
  if (!pidInfo) {
    return {
      success: true,
      killed: false,
      message: `No PID file found in ${worktreePath} — nothing to stop.`,
    };
  }

  // Kill order: parent CLI first so its SIGTERM handler propagates to the
  // engine and skips the review pass cleanly. Engine PID is included as a
  // backstop in case the parent's handler is unresponsive.
  const candidates: number[] = [];
  if (pidInfo.cliPid !== undefined) candidates.push(pidInfo.cliPid);
  if (pidInfo.pid !== pidInfo.cliPid) candidates.push(pidInfo.pid);
  const live = candidates.filter((p) => isPidAlive(p));

  if (live.length === 0) {
    removePidFile(worktreePath);
    return {
      success: true,
      killed: false,
      message: `No live process for ${branch}; cleared stale PID file.`,
    };
  }

  for (const p of live) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  await waitForExit(live, Date.now() + STOP_GRACE_MS);

  const survivors = live.filter((p) => isPidAlive(p));
  for (const p of survivors) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  }

  // Engine pgid backstop: if the engine was spawned with detached:true it is
  // a process-group leader and -pid cascades SIGKILL to any tool grandchildren
  // (e.g. a stuck `Bash(...)` invocation). Harmless when not detached.
  try {
    process.kill(-pidInfo.pid, "SIGKILL");
  } catch {
    /* not a pgid leader, or already gone */
  }

  removePidFile(worktreePath);

  return {
    success: true,
    killed: true,
    message: `Stopped ${branch} (signalled ${live.length} process${live.length > 1 ? "es" : ""}).`,
  };
}

// --- run preflight gates ---

export interface PreflightOptions {
  /** Bypass all gates. */
  force?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  /** Refusal message when ok=false. CLI maps this to exit code 2. */
  message?: string;
}

/**
 * Pre-run gates for `dangeresque run`. Refuses to dispatch a new worker when:
 *  - any existing worktree references the same issue (any mode, running or
 *    finished — the prior run must be merged or discarded first);
 *  - the local default branch is ahead of origin (the new worktree branches
 *    from origin/HEAD, so a stale local head produces phantom diff drift).
 *
 * Repos without an `origin` remote silently skip the second gate. `--force`
 * bypasses both gates and runs unchecked.
 */
export function runPreflightChecks(
  projectRoot: string,
  issueNumber: number,
  mode: string,
  opts: PreflightOptions = {},
): PreflightResult {
  if (opts.force) return { ok: true };

  const failures: string[] = [];
  const remediations: string[] = [];

  // Gate 1: same-issue worktree exists (any mode, any state).
  const sameIssue = listWorktrees(projectRoot).filter(
    (wt) => extractIssueNumber(wt.branch) === issueNumber,
  );
  for (const wt of sameIssue) {
    failures.push(`issue ${issueNumber} already has a worktree: ${wt.branch}`);
    remediations.push(
      `  dangeresque merge ${wt.branch}     (keeps the run report in .dangeresque/runs/)`,
    );
    remediations.push(
      `  dangeresque discard ${wt.branch}   (deletes the run report along with the worktree)`,
    );
  }

  // Gate 2: local default branch ahead of origin/HEAD. Mirrors the
  // checkRemoteBehind warn in src/runner.ts; here it blocks instead of warns.
  try {
    const ahead = execSync("git rev-list --count origin/HEAD..HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const count = parseInt(ahead, 10);
    if (count > 0) {
      failures.push(
        `local main is ${count} commit${count > 1 ? "s" : ""} ahead of origin (you probably forgot to push)`,
      );
      remediations.push("  git push origin main");
    }
  } catch {
    // No remote / no origin/HEAD → silent noop. Local-only repos are valid.
  }

  if (failures.length === 0) return { ok: true };

  const lines: string[] = [`ERROR: refusing to run ${mode} because -`];
  for (const f of failures) lines.push(`- ${f}`);
  lines.push("");
  lines.push("Fix one of these:");
  lines.push(...remediations);
  lines.push("");
  lines.push("Or, if you really want to continue anyway, re-run with --force.");

  return { ok: false, message: lines.join("\n") };
}
