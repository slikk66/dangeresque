import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { detectDrift, packageRoot, type DriftDetails } from "./build-info.js";
import { ARTIFACT_SCHEMA_VERSION } from "./artifact.js";
import { CONFIG_DIR, validateSetup } from "./config.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  packageRoot: string;
  projectRoot: string;
}

export interface DoctorOptions {
  projectRoot: string;
  root?: string;
  ghProbe?: () => boolean;
}

function defaultGhProbe(): boolean {
  const probe = spawnSync("gh", ["--version"], { stdio: "pipe", encoding: "utf-8" });
  return !probe.error && probe.status === 0;
}

function checkBuildInfo(drift: DriftDetails): DoctorCheck {
  if (drift.reason === "no-build-info") {
    return {
      name: "build-info-present",
      status: "warn",
      detail:
        "dist/build-info.json missing — binary predates drift detection. Run `yarn build`.",
    };
  }
  const bi = drift.buildInfo!;
  const commitTag = bi.commit ? bi.commit.slice(0, 8) : "null";
  return {
    name: "build-info-present",
    status: "pass",
    detail: `commit=${commitTag} built_at=${bi.built_at} schema=${bi.schema_version}`,
  };
}

function checkDistMatchesHead(drift: DriftDetails): DoctorCheck {
  if (drift.reason === "no-build-info") {
    return {
      name: "dist-matches-head",
      status: "warn",
      detail: "no build-info to compare against (see build-info-present)",
    };
  }
  if (drift.reason === "no-git-repo") {
    return {
      name: "dist-matches-head",
      status: "pass",
      detail: "package root is not a git repo (npm install -g) — drift check skipped",
    };
  }
  if (drift.reason === "no-build-commit") {
    return {
      name: "dist-matches-head",
      status: "pass",
      detail: "build-info has no commit (built outside a git repo) — drift check skipped",
    };
  }
  if (drift.reason === "git-error") {
    return {
      name: "dist-matches-head",
      status: "warn",
      detail: "git rev-parse HEAD failed — cannot verify drift",
    };
  }
  if (drift.reason === "drift") {
    const built = drift.buildInfo?.commit?.slice(0, 8) ?? "null";
    const head = drift.headCommit?.slice(0, 8) ?? "unknown";
    return {
      name: "dist-matches-head",
      status: "warn",
      detail: `drift: dist built from ${built} but HEAD is ${head}. Run \`yarn build\`.`,
    };
  }
  const head = drift.headCommit?.slice(0, 8) ?? "unknown";
  if (drift.reason === "src-unchanged") {
    const built = drift.buildInfo?.commit?.slice(0, 8) ?? "null";
    return {
      name: "dist-matches-head",
      status: "pass",
      detail: `dist built from ${built}, HEAD is ${head} — no src/ changes between them`,
    };
  }
  // match
  return {
    name: "dist-matches-head",
    status: "pass",
    detail: `dist matches HEAD (${head})`,
  };
}

function checkSchemaVersion(drift: DriftDetails): DoctorCheck {
  if (!drift.buildInfo) {
    return {
      name: "schema-version",
      status: "warn",
      detail: "no build-info to read schema_version from",
    };
  }
  if (drift.buildInfo.schema_version !== ARTIFACT_SCHEMA_VERSION) {
    return {
      name: "schema-version",
      status: "warn",
      detail:
        `build-info schema=${drift.buildInfo.schema_version} but loaded module is ${ARTIFACT_SCHEMA_VERSION} ` +
        `— mixed build state. Run \`yarn build\`.`,
    };
  }
  return {
    name: "schema-version",
    status: "pass",
    detail: `schema_version=${ARTIFACT_SCHEMA_VERSION}`,
  };
}

function checkGhCli(probe: () => boolean): DoctorCheck {
  if (probe()) {
    return { name: "gh-cli-available", status: "pass", detail: "gh --version OK" };
  }
  return {
    name: "gh-cli-available",
    status: "warn",
    detail: "gh CLI not on PATH — `dangeresque run --issue` will fail until installed",
  };
}

function checkDangeresqueInitialized(projectRoot: string): DoctorCheck {
  const path = join(projectRoot, CONFIG_DIR);
  if (existsSync(path)) {
    return {
      name: "dangeresque-initialized",
      status: "pass",
      detail: `${CONFIG_DIR}/ exists at ${projectRoot}`,
    };
  }
  return {
    name: "dangeresque-initialized",
    status: "warn",
    detail: `${CONFIG_DIR}/ missing — run \`dangeresque init\` from your project root`,
  };
}

function checkDangeresqueConfig(projectRoot: string): DoctorCheck {
  const configDir = join(projectRoot, CONFIG_DIR);
  if (!existsSync(configDir)) {
    return {
      name: "dangeresque-config-valid",
      status: "warn",
      detail: "not checked because .dangeresque/ is missing",
    };
  }
  const validation = validateSetup(projectRoot);
  if (!validation.valid) {
    return {
      name: "dangeresque-config-valid",
      status: "fail",
      detail: validation.errors.join("; "),
    };
  }
  return {
    name: "dangeresque-config-valid",
    status: "pass",
    detail: "config and prompt files pass run preflight validation",
  };
}

export function runDoctorChecks(opts: DoctorOptions): DoctorReport {
  const root = opts.root ?? packageRoot();
  const drift = detectDrift({ root });
  const ghProbe = opts.ghProbe ?? defaultGhProbe;

  const checks: DoctorCheck[] = [
    checkBuildInfo(drift),
    checkDistMatchesHead(drift),
    checkSchemaVersion(drift),
    checkGhCli(ghProbe),
    checkDangeresqueInitialized(opts.projectRoot),
    checkDangeresqueConfig(opts.projectRoot),
  ];

  return { checks, packageRoot: root, projectRoot: opts.projectRoot };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("dangeresque doctor");
  lines.push(`  package root: ${report.packageRoot}`);
  lines.push(`  project root: ${report.projectRoot}`);
  lines.push("");
  lines.push("Checks:");
  for (const c of report.checks) {
    const tag = c.status.toUpperCase().padEnd(4);
    lines.push(`  [${tag}] ${c.name}`);
    lines.push(`         ${c.detail}`);
  }
  const counts = report.checks.reduce(
    (acc, c) => {
      acc[c.status]++;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 } as Record<CheckStatus, number>,
  );
  lines.push("");
  lines.push(
    `Summary: ${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail`,
  );
  lines.push("");
  lines.push("Exit codes: 0 normal · 1 on FAIL or --strict WARN · 2 on internal error");
  return lines.join("\n") + "\n";
}
