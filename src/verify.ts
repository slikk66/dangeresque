import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ArtifactBuilder } from "./artifact.js";

export type VerifyFailurePolicy = "block" | "warn";

export interface VerifyCommand {
  name: string;
  cmd: string;
  on_failure: VerifyFailurePolicy;
  timeout_ms: number;
}

export interface VerifyConfig {
  enabled: boolean;
  modes: string[];
  commands: VerifyCommand[];
}

export interface VerificationResult {
  name: string;
  cmd: string;
  on_failure: VerifyFailurePolicy;
  timeout_ms: number;
  exit_code: number;
  duration_ms: number;
  stdout_excerpt: string;
  stderr_excerpt: string;
  truncated: boolean;
  timed_out: boolean;
}

export interface VerificationOutcome {
  results: VerificationResult[];
  blocked: boolean;
  blockedBy?: string;
}

export interface RunVerificationOptions {
  worktreePath: string;
  archivePath: string;
  config: VerifyConfig;
  builder?: ArtifactBuilder;
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;
export const DEFAULT_VERIFY_LOG_BYTES = 8 * 1024;
export const DEFAULT_VERIFY_MODES = ["IMPLEMENT", "REFACTOR", "TEST", "VERIFY"];

/** Truncate a captured stream to the last `maxBytes` bytes, marking `truncated` when applied. */
export function tailBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (s.length <= maxBytes) return { text: s, truncated: false };
  return { text: s.slice(s.length - maxBytes), truncated: true };
}

function logBytesEnv(): number {
  const raw = process.env.DANGERESQUE_VERIFY_LOG_BYTES;
  if (!raw) return DEFAULT_VERIFY_LOG_BYTES;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return DEFAULT_VERIFY_LOG_BYTES;
  return n;
}

/**
 * Decide whether verification should run for a given mode + config combination.
 * INVESTIGATE-style modes that do not produce code changes are skipped by default
 * (caller passes the mode via `verify.modes`). Empty `commands` is also a skip
 * — projects without configured verification get pure no-op.
 */
export function shouldRunVerify(mode: string, config: VerifyConfig): boolean {
  if (!config.enabled) return false;
  if (config.commands.length === 0) return false;
  return config.modes.includes(mode);
}

/**
 * Run a single verification command synchronously in `worktreePath`.
 * Captures stdout/stderr (last `maxLogBytes` bytes), exit code, duration,
 * and a `timed_out` flag. Never throws; failures are recorded in the result.
 * Optional `env` is merged on top of `process.env` (gates use it to inject
 * DANGERESQUE_ISSUE / DANGERESQUE_MODE / DANGERESQUE_MERGE for consumer scripts).
 */
export function runSingleCommand(
  command: VerifyCommand,
  worktreePath: string,
  maxLogBytes: number,
  env?: Record<string, string>,
): VerificationResult {
  const startedAt = Date.now();
  const proc = spawnSync(command.cmd, {
    cwd: worktreePath,
    shell: true,
    encoding: "utf-8",
    timeout: command.timeout_ms,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const endedAt = Date.now();

  const stdoutRaw = proc.stdout ?? "";
  const stderrRaw = proc.stderr ?? "";
  const stdoutTail = tailBytes(stdoutRaw, maxLogBytes);
  const stderrTail = tailBytes(stderrRaw, maxLogBytes);

  const timedOut = proc.error !== undefined && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  let exitCode: number;
  if (proc.status !== null) {
    exitCode = proc.status;
  } else if (proc.signal !== null) {
    const signalNum = osConstants.signals[proc.signal] ?? 0;
    exitCode = 128 + signalNum;
  } else if (proc.error) {
    exitCode = 127;
  } else {
    exitCode = 0;
  }

  return {
    name: command.name,
    cmd: command.cmd,
    on_failure: command.on_failure,
    timeout_ms: command.timeout_ms,
    exit_code: exitCode,
    duration_ms: endedAt - startedAt,
    stdout_excerpt: stdoutTail.text,
    stderr_excerpt: stderrTail.text,
    truncated: stdoutTail.truncated || stderrTail.truncated,
    timed_out: timedOut,
  };
}

/**
 * Build the canonical SUMMARY-block one-liner reflecting verification results.
 * Examples:
 *   - all pass:     "Verify: 4/4 passed (install, compile, test, lint)"
 *   - block-fail:   "Verify: 2/4 FAILED (install=ok, compile=ok, test=FAIL exit=1, lint=skipped)"
 *   - warn-fail:    "Verify: 3/4 passed, 1 warned (lint=FAIL exit=1)"
 * Returns null when results array is empty.
 */
export function buildVerifySummaryLine(results: VerificationResult[]): string | null {
  if (results.length === 0) return null;
  const total = results.length;
  const passed = results.filter((r) => r.exit_code === 0).length;
  const failedHard = results.filter((r) => r.exit_code !== 0 && r.on_failure === "block");
  const failedWarn = results.filter((r) => r.exit_code !== 0 && r.on_failure === "warn");

  if (failedHard.length > 0) {
    const blockingIdx = results.findIndex((r) => r.exit_code !== 0 && r.on_failure === "block");
    const reportable = results.slice(0, blockingIdx + 1);
    const skippedAfter = results.slice(blockingIdx + 1);
    const parts = reportable.map((r) =>
      r.exit_code === 0 ? `${r.name}=ok` : `${r.name}=FAIL exit=${r.exit_code}`,
    );
    for (const r of skippedAfter) parts.push(`${r.name}=skipped`);
    return `Verify: ${reportable.filter((r) => r.exit_code !== 0).length}/${total} FAILED (${parts.join(", ")})`;
  }

  if (failedWarn.length > 0) {
    const warnDetails = failedWarn.map((r) => `${r.name}=FAIL exit=${r.exit_code}`).join(", ");
    return `Verify: ${passed}/${total} passed, ${failedWarn.length} warned (${warnDetails})`;
  }

  const names = results.map((r) => r.name).join(", ");
  return `Verify: ${passed}/${total} passed (${names})`;
}

/**
 * Insert/replace a `Verify: ...` line inside the `<!-- SUMMARY -->` block.
 * Mirrors `rewriteSummaryFilesLine` from src/summary.ts but for the verify
 * one-liner. Returns the rewritten content, or null when the SUMMARY block
 * is missing. When no Verify: line exists yet, inserts directly after the
 * `Files:` line (its natural sibling) or at the end of the block.
 */
export function appendVerifySummaryLine(content: string, results: VerificationResult[]): string | null {
  const line = buildVerifySummaryLine(results);
  if (line === null) return null;

  const summaryRegex = /(<!-- SUMMARY -->\n)([\s\S]*?)(\n<!-- \/SUMMARY -->)/;
  const match = content.match(summaryRegex);
  if (!match) return null;

  const block = match[2];
  const verifyLineRegex = /^Verify:.*$/m;
  let rewrittenBlock: string;
  if (verifyLineRegex.test(block)) {
    rewrittenBlock = block.replace(verifyLineRegex, line);
  } else {
    const filesLineRegex = /^(Files:.*)$/m;
    if (filesLineRegex.test(block)) {
      rewrittenBlock = block.replace(filesLineRegex, `$1\n${line}`);
    } else {
      rewrittenBlock = block.endsWith("\n") ? `${block}${line}` : `${block}\n${line}`;
    }
  }
  return content.replace(summaryRegex, `${match[1]}${rewrittenBlock}${match[3]}`);
}

/**
 * Render a `## Verification` body section. One block per command with status,
 * duration, and the trailing stderr excerpt for any non-zero exit. Always
 * appended at the end of the artifact .md so it is visible to the reviewer.
 */
export function buildVerifyBodySection(results: VerificationResult[]): string {
  if (results.length === 0) return "";
  const lines: string[] = ["", "## Verification (pre-review, captured automatically)", ""];
  for (const r of results) {
    const status = r.exit_code === 0 ? "PASS" : r.timed_out ? "TIMEOUT" : "FAIL";
    const policy = r.on_failure === "block" ? "(block)" : "(warn)";
    lines.push(
      `- **${r.name}** ${policy} — \`${r.cmd}\` — ${status} (exit=${r.exit_code}, ${formatMs(r.duration_ms)})`,
    );
    if (r.exit_code !== 0) {
      const excerpt = r.stderr_excerpt.trim() || r.stdout_excerpt.trim();
      if (excerpt) {
        lines.push("");
        lines.push("  ```");
        for (const ln of excerpt.split("\n").slice(-40)) {
          lines.push(`  ${ln}`);
        }
        lines.push("  ```");
      }
      if (r.truncated) lines.push(`  _(output truncated to last ${formatBytes(r.stdout_excerpt.length + r.stderr_excerpt.length)})_`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Append the `## Verification` body section to `content`. If the section
 * already exists (re-run case), replace it. Otherwise append at the end.
 */
export function appendVerifyBodySection(content: string, results: VerificationResult[]): string {
  const section = buildVerifyBodySection(results);
  if (!section) return content;
  const sectionRegex = /\n## Verification \(pre-review, captured automatically\)[\s\S]*?(?=\n## |\n?$)/;
  if (sectionRegex.test(content)) {
    return content.replace(sectionRegex, `\n${section.trimEnd()}`);
  }
  const sep = content.endsWith("\n") ? "" : "\n";
  return `${content}${sep}${section}`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Run all configured verification commands sequentially in the worktree.
 * Stops at the first `on_failure: "block"` failure (subsequent commands are
 * not executed; their absence is reflected in the SUMMARY one-liner).
 *
 * Side effects:
 *  - Records `verify_command_started`, `verify_command_completed`, and
 *    `verification_completed` lifecycle events on `builder` if provided.
 *  - Rewrites the artifact .md SUMMARY block to include a `Verify:` line and
 *    appends a `## Verification` body section. Warn-and-degrade on rewrite
 *    failure — the run is never blocked by an artifact write error.
 *
 * Never throws. Returns `{ results, blocked, blockedBy? }`.
 */
export function runVerification(opts: RunVerificationOptions): VerificationOutcome {
  const { worktreePath, archivePath, config, builder } = opts;
  const maxLogBytes = logBytesEnv();
  const results: VerificationResult[] = [];
  let blocked = false;
  let blockedBy: string | undefined;

  for (const command of config.commands) {
    builder?.recordEvent("verify_command_started", { name: command.name, cmd: command.cmd });
    console.log(`\n• verify: ${command.name} — ${command.cmd}`);
    const result = runSingleCommand(command, worktreePath, maxLogBytes);
    results.push(result);
    builder?.recordEvent("verify_command_completed", {
      name: result.name,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
      on_failure: result.on_failure,
    });

    if (result.exit_code === 0) {
      console.log(`  ✓ ${result.name} passed (${formatMs(result.duration_ms)})`);
    } else if (result.on_failure === "block") {
      console.error(
        `  ✗ ${result.name} FAILED (exit=${result.exit_code}, ${formatMs(result.duration_ms)}) — blocking`,
      );
      if (result.stderr_excerpt.trim()) {
        const tail = result.stderr_excerpt.trim().split("\n").slice(-6).join("\n");
        console.error(`    stderr (tail):\n${tail.split("\n").map((l) => `      ${l}`).join("\n")}`);
      }
      blocked = true;
      blockedBy = result.name;
      break;
    } else {
      console.warn(
        `  ⚠ ${result.name} failed (exit=${result.exit_code}, ${formatMs(result.duration_ms)}) — warn-only, continuing`,
      );
    }
  }

  builder?.recordEvent("verification_completed", {
    pass_count: results.filter((r) => r.exit_code === 0).length,
    fail_count: results.filter((r) => r.exit_code !== 0).length,
    blocked,
    ...(blockedBy ? { blocked_by: blockedBy } : {}),
  });

  rewriteArtifactWithVerification(archivePath, results, builder);

  return blocked ? { results, blocked, blockedBy } : { results, blocked };
}

function rewriteArtifactWithVerification(
  archivePath: string,
  results: VerificationResult[],
  builder: ArtifactBuilder | undefined,
): void {
  if (!existsSync(archivePath)) {
    builder?.recordEvent("verify_artifact_rewrite_skipped", { reason: "archive_missing" });
    return;
  }
  let content: string;
  try {
    content = readFileSync(archivePath, "utf-8");
  } catch (err) {
    builder?.recordEvent("verify_artifact_rewrite_skipped", {
      reason: "archive_read_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let next = content;
  const summaryUpdated = appendVerifySummaryLine(next, results);
  if (summaryUpdated !== null) next = summaryUpdated;
  next = appendVerifyBodySection(next, results);

  if (next === content) return;

  try {
    writeFileSync(archivePath, next, "utf-8");
  } catch (err) {
    builder?.recordEvent("verify_artifact_rewrite_skipped", {
      reason: "archive_write_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
