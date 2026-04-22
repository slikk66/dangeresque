import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, RUNS_DIR, type Engine } from "./config.js";
import {
  ARTIFACT_SCHEMA_VERSION,
  type RunArtifact,
  type ResultClassification,
  type ReviewerVerdict,
} from "./artifact.js";

const KNOWN_ENGINES: Engine[] = ["claude", "codex"];

const RESULT_ORDER: ResultClassification[] = [
  "success",
  "partial_success",
  "failure",
];

const VERDICT_ORDER: ReviewerVerdict[] = [
  "accept",
  "reject",
  "needs_human_review",
  "skipped",
  "unknown",
];

export interface GatherOptions {
  issueNumber?: number;
  engine?: Engine;
  mode?: string;
}

export interface GatherResult {
  artifacts: RunArtifact[];
  runsDir: string;
  dirExists: boolean;
  filesScanned: number;
  parseErrorPaths: string[];
  unsupportedVersions: Record<string, number>;
  schemaVersions: Record<string, number>;
}

export interface StatsSummary {
  total: number;
  byResult: Record<ResultClassification, number>;
  byVerdict: Record<ReviewerVerdict, number>;
  byEngine: Record<string, number>;
  byMode: Record<string, { total: number; success: number }>;
  byModel: Record<string, number>;
  failureCategories: Record<string, number>;
  workerDurationsMs: { median: number; p95: number };
  totalDurationsMs: { median: number; p95: number };
}

export interface FormatExtras {
  runsDir: string;
  filters: GatherOptions;
  schemaVersions: Record<string, number>;
  parseErrorCount: number;
  unsupportedVersions: Record<string, number>;
  filesScanned: number;
}

export function gatherArtifacts(
  projectRoot: string,
  opts: GatherOptions = {},
): GatherResult {
  const runsDir = join(projectRoot, CONFIG_DIR, RUNS_DIR);
  const empty: GatherResult = {
    artifacts: [],
    runsDir,
    dirExists: false,
    filesScanned: 0,
    parseErrorPaths: [],
    unsupportedVersions: {},
    schemaVersions: {},
  };
  if (!existsSync(runsDir)) return empty;

  const artifacts: RunArtifact[] = [];
  const parseErrorPaths: string[] = [];
  const unsupportedVersions: Record<string, number> = {};
  const schemaVersions: Record<string, number> = {};
  let filesScanned = 0;

  const issueDirs = readdirSync(runsDir).filter((d) => /^issue-\d+$/.test(d));
  for (const dir of issueDirs) {
    const issueDirPath = join(runsDir, dir);
    if (!statSync(issueDirPath).isDirectory()) continue;
    const files = readdirSync(issueDirPath).filter((f) =>
      f.endsWith(".json"),
    );
    for (const f of files) {
      filesScanned++;
      const full = join(issueDirPath, f);
      let parsed: RunArtifact;
      try {
        parsed = JSON.parse(readFileSync(full, "utf-8")) as RunArtifact;
      } catch {
        parseErrorPaths.push(full);
        continue;
      }
      const ver =
        typeof parsed.schema_version === "string"
          ? parsed.schema_version
          : "unknown";
      schemaVersions[ver] = (schemaVersions[ver] ?? 0) + 1;
      if (ver !== ARTIFACT_SCHEMA_VERSION) {
        unsupportedVersions[ver] = (unsupportedVersions[ver] ?? 0) + 1;
        continue;
      }
      if (
        opts.issueNumber !== undefined &&
        parsed.issue_number !== opts.issueNumber
      ) {
        continue;
      }
      if (opts.engine && parsed.engine !== opts.engine) continue;
      if (opts.mode && parsed.mode !== opts.mode) continue;
      artifacts.push(parsed);
    }
  }

  return {
    artifacts,
    runsDir,
    dirExists: true,
    filesScanned,
    parseErrorPaths,
    unsupportedVersions,
    schemaVersions,
  };
}

export function computeStats(artifacts: RunArtifact[]): StatsSummary {
  const byResult: Record<ResultClassification, number> = {
    success: 0,
    partial_success: 0,
    failure: 0,
  };
  const byVerdict: Record<ReviewerVerdict, number> = {
    accept: 0,
    reject: 0,
    needs_human_review: 0,
    skipped: 0,
    unknown: 0,
  };
  const byEngine: Record<string, number> = { claude: 0, codex: 0 };
  const byMode: Record<string, { total: number; success: number }> = {};
  const byModel: Record<string, number> = {};
  const failureCategories: Record<string, number> = {};
  const workerDurations: number[] = [];
  const totalDurations: number[] = [];

  for (const a of artifacts) {
    byResult[a.result] = (byResult[a.result] ?? 0) + 1;
    byVerdict[a.reviewer_verdict] = (byVerdict[a.reviewer_verdict] ?? 0) + 1;
    byEngine[a.engine] = (byEngine[a.engine] ?? 0) + 1;
    const bucket = byMode[a.mode] ?? { total: 0, success: 0 };
    bucket.total += 1;
    if (a.result === "success") bucket.success += 1;
    byMode[a.mode] = bucket;
    byModel[a.model] = (byModel[a.model] ?? 0) + 1;
    for (const cat of a.failure_categories ?? []) {
      failureCategories[cat] = (failureCategories[cat] ?? 0) + 1;
    }
    if (a.worker && typeof a.worker.duration_ms === "number") {
      workerDurations.push(a.worker.duration_ms);
    }
    if (typeof a.duration_ms === "number") {
      totalDurations.push(a.duration_ms);
    }
  }

  return {
    total: artifacts.length,
    byResult,
    byVerdict,
    byEngine,
    byMode,
    byModel,
    failureCategories,
    workerDurationsMs: {
      median: median(workerDurations),
      p95: percentile(workerDurations, 0.95),
    },
    totalDurationsMs: {
      median: median(totalDurations),
      p95: percentile(totalDurations, 0.95),
    },
  };
}

export function formatStats(summary: StatsSummary, extras: FormatExtras): string {
  const lines: string[] = [];
  lines.push("Run Evaluation Stats");
  lines.push("====================");
  lines.push("");
  lines.push(...formatSummary(summary));
  lines.push("");
  lines.push(`Path: ${extras.runsDir}`);
  lines.push(`Total artifacts: ${summary.total}`);
  lines.push(formatSchemaLine(extras.schemaVersions));
  lines.push(formatFiltersLine(extras.filters));
  lines.push(formatSkippedLine(extras.parseErrorCount, extras.unsupportedVersions));
  const zeroNote = formatZeroMatchNote(summary, extras.filters);
  if (zeroNote) lines.push(zeroNote);

  lines.push("");
  lines.push("Results:");
  for (const k of RESULT_ORDER) {
    const count = summary.byResult[k];
    const pct = summary.total > 0 ? (count * 100) / summary.total : 0;
    lines.push(
      `  ${pad(k, 20)}${padLeft(String(count), 6)}${padLeft(formatPct(pct), 8)}`,
    );
  }

  lines.push("");
  lines.push("Reviewer verdicts:");
  for (const k of VERDICT_ORDER) {
    lines.push(`  ${pad(k, 20)}${padLeft(String(summary.byVerdict[k]), 6)}`);
  }

  lines.push("");
  lines.push("By engine:");
  for (const k of KNOWN_ENGINES) {
    const count = summary.byEngine[k] ?? 0;
    lines.push(`  ${pad(k, 20)}${padLeft(String(count), 6)}`);
  }
  const extraEngines = Object.keys(summary.byEngine)
    .filter((k) => !KNOWN_ENGINES.includes(k as Engine))
    .sort();
  for (const k of extraEngines) {
    lines.push(`  ${pad(k, 20)}${padLeft(String(summary.byEngine[k]), 6)}`);
  }

  lines.push("");
  lines.push("By mode (success rate):");
  const modes = Object.entries(summary.byMode).sort(
    (a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]),
  );
  if (modes.length === 0) {
    lines.push("  (no artifacts)");
  } else {
    for (const [m, v] of modes) {
      const rate = v.total > 0 ? (v.success * 100) / v.total : 0;
      lines.push(
        `  ${pad(m, 20)}${padLeft(String(v.total), 6)}${padLeft(formatPct(rate), 8)}  (${v.success}/${v.total})`,
      );
    }
  }

  lines.push("");
  lines.push("By model:");
  const models = Object.entries(summary.byModel).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (models.length === 0) {
    lines.push("  (no artifacts)");
  } else {
    for (const [m, c] of models) {
      lines.push(`  ${pad(m, 28)}${padLeft(String(c), 6)}`);
    }
  }

  lines.push("");
  lines.push("Failure categories:");
  const cats = Object.entries(summary.failureCategories).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (cats.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [c, n] of cats) {
      lines.push(`  ${pad(c, 20)}${padLeft(String(n), 6)}`);
    }
  }

  lines.push("");
  lines.push("Durations (ms):");
  lines.push(`  ${pad("", 20)}${padLeft("median", 12)}${padLeft("p95", 14)}`);
  lines.push(
    `  ${pad("worker", 20)}${padLeft(formatMs(summary.workerDurationsMs.median), 12)}${padLeft(formatMs(summary.workerDurationsMs.p95), 14)}`,
  );
  lines.push(
    `  ${pad("total (run)", 20)}${padLeft(formatMs(summary.totalDurationsMs.median), 12)}${padLeft(formatMs(summary.totalDurationsMs.p95), 14)}`,
  );

  return lines.join("\n") + "\n";
}

function formatSummary(summary: StatsSummary): string[] {
  const successfulRuns = summary.byResult.success;
  const reviewedRuns =
    summary.byVerdict.accept +
    summary.byVerdict.reject +
    summary.byVerdict.needs_human_review;
  const topFailureCategory = Object.entries(summary.failureCategories).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];

  return [
    "Summary",
    "-------",
    `Overall success:     ${formatPctWithCount(successfulRuns, summary.total)}`,
    `Hard failures:       ${summary.byResult.failure}`,
    `Review coverage:     ${formatPctWithCount(
      reviewedRuns,
      summary.total,
    )} runs reviewed`,
    `Reviewer verdicts:   ${summary.byVerdict.accept} accept, ${summary.byVerdict.reject} reject, ${summary.byVerdict.needs_human_review} needs_human_review`,
    `Top failure category: ${
      topFailureCategory
        ? `${topFailureCategory[0]} (${topFailureCategory[1]})`
        : "(none)"
    }`,
  ];
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[(n - 1) / 2];
  return Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p * s.length) - 1;
  return s[Math.max(0, Math.min(s.length - 1, idx))];
}

function pad(s: string, n: number): string {
  return s.length >= n ? s + "  " : s.padEnd(n);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? " " + s : s.padStart(n);
}

function formatPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

function formatPctWithCount(count: number, total: number): string {
  const pct = total > 0 ? (count * 100) / total : 0;
  return `${formatPct(pct)} (${count}/${total})`;
}

function formatMs(n: number): string {
  return n.toLocaleString("en-US");
}

function formatFiltersLine(f: GatherOptions): string {
  const parts: string[] = [];
  if (f.issueNumber !== undefined) parts.push(`--issue ${f.issueNumber}`);
  if (f.engine) parts.push(`--engine ${f.engine}`);
  if (f.mode) parts.push(`--mode ${f.mode}`);
  return `Filters: ${parts.length === 0 ? "none" : parts.join(" ")}`;
}

function formatSchemaLine(versions: Record<string, number>): string {
  const entries = Object.entries(versions).sort((a, b) =>
    b[0].localeCompare(a[0]),
  );
  if (entries.length === 0) return "Schema versions: (none)";
  return `Schema versions: ${entries.map(([v, c]) => `${v}=${c}`).join(", ")}`;
}

function formatSkippedLine(
  parseErrors: number,
  unsupported: Record<string, number>,
): string {
  const entries = Object.entries(unsupported);
  const unsupportedTotal = entries.reduce((a, [, n]) => a + n, 0);
  const detail =
    entries.length === 0
      ? ""
      : ` (${entries
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([v, n]) => `v${v}=${n}`)
          .join(", ")})`;
  return `Skipped: ${parseErrors} parse error${parseErrors === 1 ? "" : "s"}, ${unsupportedTotal} unsupported schema${detail}`;
}

function formatZeroMatchNote(
  summary: StatsSummary,
  filters: GatherOptions,
): string | null {
  if (summary.total !== 0) return null;
  const parts: string[] = [];
  if (filters.issueNumber !== undefined) parts.push(`--issue ${filters.issueNumber}`);
  if (filters.engine) parts.push(`--engine ${filters.engine}`);
  if (filters.mode) parts.push(`--mode ${filters.mode}`);
  if (parts.length === 0) return null;
  return `Note: no artifacts match filters (${parts.join(" ")})`;
}
