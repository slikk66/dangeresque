import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ArtifactBuilder } from "./artifact.js";

export interface NormalizeOptions {
  worktreePath: string;
  archivePath: string;
  diffBase: string;
  builder?: ArtifactBuilder;
}

export interface FileBuckets {
  added: number;
  modified: number;
  deleted: number;
}

/**
 * Parse `git diff --name-status` output into bucketed counts.
 *
 * Status letter mapping:
 *  - A → added
 *  - M, T → modified (T = type changed, e.g. file → symlink)
 *  - D → deleted
 *  - R, C → modified (renames and copies — the destination is what the worker
 *    delivered; counting them as M matches the body's "Files Changed" intent)
 *  - U (unmerged) → modified (defensive; should not occur post-rebase)
 *
 * `git diff --name-status` lines are tab-separated:
 *   `M\tsrc/foo.ts`
 *   `R100\told.ts\tnew.ts`
 *   `C75\tsrc/a.ts\tsrc/b.ts`
 */
export function bucketNameStatus(output: string): FileBuckets {
  const buckets: FileBuckets = { added: 0, modified: 0, deleted: 0 };
  const lines = output.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0];
    const code = status[0];
    if (code === "A") buckets.added += 1;
    else if (code === "D") buckets.deleted += 1;
    else if (code === "M" || code === "T" || code === "R" || code === "C" || code === "U") {
      buckets.modified += 1;
    }
  }
  return buckets;
}

/**
 * Build the canonical `Files: ...` line from bucketed counts.
 *
 * Formats:
 *   - 0 changed       → "Files: 0 changed"
 *   - some changed    → "Files: N changed (X added, Y modified, Z deleted)"
 *
 * Drops zero buckets entirely. The breakdown order is fixed (added → modified
 * → deleted) so cosmetic changes never reorder.
 */
export function buildCanonicalLine(buckets: FileBuckets): string {
  const total = buckets.added + buckets.modified + buckets.deleted;
  if (total === 0) return "Files: 0 changed";

  const parts: string[] = [];
  if (buckets.added > 0) parts.push(`${buckets.added} added`);
  if (buckets.modified > 0) parts.push(`${buckets.modified} modified`);
  if (buckets.deleted > 0) parts.push(`${buckets.deleted} deleted`);

  return `Files: ${total} changed (${parts.join(", ")})`;
}

/**
 * Replace the `Files:` line inside the `<!-- SUMMARY -->` block with the
 * canonical line. Returns the rewritten content. Returns null when the
 * SUMMARY block is missing or contains no `Files:` line — caller treats this
 * as a degrade-and-skip signal.
 *
 * The replacement is scoped to the SUMMARY block so we do not accidentally
 * rewrite a `Files:` line a worker might have included in the body's
 * "Files Changed" prose section.
 */
export function rewriteSummaryFilesLine(
  content: string,
  canonicalLine: string,
): string | null {
  const summaryRegex = /(<!-- SUMMARY -->\n)([\s\S]*?)(\n<!-- \/SUMMARY -->)/;
  const match = content.match(summaryRegex);
  if (!match) return null;

  const block = match[2];
  const filesLineRegex = /^Files:.*$/m;
  if (!filesLineRegex.test(block)) return null;

  const rewrittenBlock = block.replace(filesLineRegex, canonicalLine);
  return content.replace(summaryRegex, `${match[1]}${rewrittenBlock}${match[3]}`);
}

/**
 * Compute the canonical file count via `git diff <base> --name-status` and
 * rewrite the worker's `Files:` line in the run-artifact .md SUMMARY block to
 * the canonical form. Records the canonical count on the optional
 * ArtifactBuilder so the JSON `files_changed_count` field stays in sync.
 * The artifact .md is gitignored, so the rewrite is in-place — no commit.
 *
 * Warn-and-degrade contract: every failure path logs a console.warn,
 * optionally records a `summary_normalize_failed` lifecycle event, and
 * returns null. Never throws to the caller. The worker's hand-typed line
 * passes through unchanged on any failure — the reviewer sees today's
 * behavior (potential false-REJECT) but the run is never blocked.
 *
 * Returns the canonical N on success, null on any failure.
 */
export function normalizeSummaryFileCount(
  opts: NormalizeOptions,
): number | null {
  const { worktreePath, archivePath, diffBase, builder } = opts;

  let nameStatus: string;
  try {
    nameStatus = execSync(`git diff ${diffBase} --name-status`, {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return degrade(builder, "git_diff_failed", err);
  }

  const buckets = bucketNameStatus(nameStatus);
  const total = buckets.added + buckets.modified + buckets.deleted;
  const canonicalLine = buildCanonicalLine(buckets);

  if (!existsSync(archivePath)) {
    return degrade(builder, "archive_missing", new Error(archivePath));
  }

  let original: string;
  try {
    original = readFileSync(archivePath, "utf-8");
  } catch (err) {
    return degrade(builder, "archive_read_failed", err);
  }

  const rewritten = rewriteSummaryFilesLine(original, canonicalLine);
  if (rewritten === null) {
    return degrade(
      builder,
      "summary_block_missing_or_malformed",
      new Error("no SUMMARY block or no Files: line"),
    );
  }

  if (rewritten === original) {
    builder?.setFilesChangedCount(total);
    return total;
  }

  try {
    writeFileSync(archivePath, rewritten, "utf-8");
  } catch (err) {
    return degrade(builder, "archive_write_failed", err);
  }

  builder?.setFilesChangedCount(total);
  return total;
}

function degrade(
  builder: ArtifactBuilder | undefined,
  reason: string,
  err: unknown,
): null {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(
    `⚠️  Could not normalize SUMMARY Files: line (${reason}: ${detail}). Reviewer will see worker's self-report.`,
  );
  builder?.recordEvent("summary_normalize_failed", { reason, detail });
  return null;
}
