import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface BuildInfo {
  commit: string | null;
  built_at: string;
  schema_version: string;
}

export type DriftReason =
  | "no-build-info"
  | "no-git-repo"
  | "no-build-commit"
  | "match"
  | "drift"
  | "git-error";

export interface DriftDetails {
  drift: boolean;
  reason: DriftReason;
  buildInfo: BuildInfo | null;
  headCommit?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Duplicates the 4-line getPackageRoot pattern in src/init.ts. Extraction to a
// shared util would widen scope past this issue's allow-list; consolidate when
// a third caller appears.
export function packageRoot(): string {
  return join(__dirname, "..");
}

export function readBuildInfo(opts: { root?: string } = {}): BuildInfo | null {
  const root = opts.root ?? packageRoot();
  const path = join(root, "dist", "build-info.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as BuildInfo;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.built_at !== "string" ||
      typeof parsed.schema_version !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function detectDrift(opts: { root?: string } = {}): DriftDetails {
  const root = opts.root ?? packageRoot();
  const buildInfo = readBuildInfo({ root });
  if (!buildInfo) {
    return { drift: true, reason: "no-build-info", buildInfo: null };
  }
  if (!existsSync(join(root, ".git"))) {
    return { drift: false, reason: "no-git-repo", buildInfo };
  }
  if (!buildInfo.commit) {
    return { drift: false, reason: "no-build-commit", buildInfo };
  }
  let headCommit: string;
  try {
    headCommit = execSync("git rev-parse HEAD", {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return { drift: false, reason: "git-error", buildInfo };
  }
  if (buildInfo.commit !== headCommit) {
    return { drift: true, reason: "drift", buildInfo, headCommit };
  }
  return { drift: false, reason: "match", buildInfo, headCommit };
}
