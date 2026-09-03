import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, RUNS_DIR } from "./config.js";
import { ARTIFACT_SCHEMA_VERSION, type RunArtifact } from "./artifact.js";

export interface MigrateOneResult {
  migrated: boolean;
  result: RunArtifact;
}

export interface MigrateAllResult {
  migrated: number;
  skipped: number;
  errors: string[];
}

export function migrateArtifact(json: unknown): MigrateOneResult {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("artifact is not a JSON object");
  }
  const obj = json as Record<string, unknown>;
  const version =
    typeof obj.schema_version === "string" ? obj.schema_version : "unknown";

  if (version === ARTIFACT_SCHEMA_VERSION) {
    return { migrated: false, result: obj as unknown as RunArtifact };
  }

  if (!SUPPORTED_SOURCE_VERSIONS.has(version)) {
    throw new Error(
      `unsupported source schema_version: ${version} (only v4/v5/v6/v7/v8/v9 → v${ARTIFACT_SCHEMA_VERSION} migration is implemented)`,
    );
  }

  const fromVersion = parseInt(version, 10);
  let next: Record<string, unknown> = { ...obj };

  if (fromVersion <= 4) next = stepV4toV5(next);
  if (fromVersion <= 5) next = stepV5toV6(next);
  if (fromVersion <= 6) next = stepV6toV7(next);
  if (fromVersion <= 7) next = stepV7toV8(next);
  if (fromVersion <= 8) next = stepV8toV9(next);
  next = stepV9toV10(next);
  next.schema_version = ARTIFACT_SCHEMA_VERSION;
  next.migrated_from_version = fromVersion;

  return { migrated: true, result: next as unknown as RunArtifact };
}

const SUPPORTED_SOURCE_VERSIONS = new Set(["4", "5", "6", "7", "8", "9"]);

/**
 * Adds the optional `resumed_from` lineage field (issue #110). Intentionally a
 * no-op on data: the field exists only on a run dispatched by
 * `dangeresque resume`, a verb that did not exist when any v9 artifact was
 * written. Backfilling one would be inventing a lineage, not recording it —
 * absent is the honest answer, and the field is optional precisely so absence
 * reads as "this run resumed nothing".
 */
function stepV9toV10(obj: Record<string, unknown>): Record<string, unknown> {
  return { ...obj };
}

/**
 * Adds `rescue.kind` (issue #104). Every rescue record that predates the
 * no-code-delta lane was authorized by a sentinel commit, so `micro_fix` is a
 * fact about these artifacts rather than a guess. Artifacts with no rescue
 * record are untouched — the field only exists on rescued runs.
 */
function stepV8toV9(obj: Record<string, unknown>): Record<string, unknown> {
  const next = { ...obj };
  const rescue = next.rescue;
  if (!rescue || typeof rescue !== "object" || Array.isArray(rescue)) return next;
  const asRecord = rescue as Record<string, unknown>;
  if (asRecord.kind !== undefined) return next;
  next.rescue = { ...asRecord, kind: "micro_fix" };
  return next;
}

/**
 * Adds `scope_report.declaration_status` (issue #90). A v7 artifact carrying
 * declaration rows proves `parsed`; one carrying none cannot be told apart from
 * a section we failed to read, so it records `unknown` rather than manufacturing
 * a `missing` the artifact does not support.
 */
function stepV7toV8(obj: Record<string, unknown>): Record<string, unknown> {
  const next = { ...obj };
  const report = next.scope_report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return next;
  const asRecord = report as Record<string, unknown>;
  if (asRecord.declaration_status !== undefined) return next;
  const declaration = next.scope_declaration;
  next.scope_report = {
    ...asRecord,
    declaration_status:
      Array.isArray(declaration) && declaration.length > 0 ? "parsed" : "unknown",
  };
  return next;
}

function stepV6toV7(obj: Record<string, unknown>): Record<string, unknown> {
  const next = { ...obj };
  const review = next.review as Record<string, unknown> | null | undefined;
  if (review && review.skipped === false && next.review_engine === undefined) {
    next.review_engine = next.engine;
  }
  return next;
}

function stepV4toV5(obj: Record<string, unknown>): Record<string, unknown> {
  const next = { ...obj };
  if (next.scope_block === undefined) {
    next.scope_block = { allow: [], deny: [], diagnostics: [] };
  }
  if (next.scope_declaration === undefined) {
    next.scope_declaration = [];
  }
  if (next.scope_report === undefined) {
    next.scope_report = { in_scope: [], extended: [], outside: [] };
  }
  return next;
}

function stepV5toV6(obj: Record<string, unknown>): Record<string, unknown> {
  const next = { ...obj };
  delete next.scope_violations;
  if (Array.isArray(next.failure_categories)) {
    next.failure_categories = next.failure_categories.map((c) =>
      c === "scope_violation" ? "scope_outside" : c,
    );
  }
  return next;
}

export function migrateAllArtifacts(projectRoot: string): MigrateAllResult {
  const runsDir = join(projectRoot, CONFIG_DIR, RUNS_DIR);
  const result: MigrateAllResult = { migrated: 0, skipped: 0, errors: [] };
  if (!existsSync(runsDir)) return result;

  const issueDirs = readdirSync(runsDir).filter((d) => /^issue-\d+$/.test(d));
  for (const dir of issueDirs) {
    const issueDirPath = join(runsDir, dir);
    if (!statSync(issueDirPath).isDirectory()) continue;
    const files = readdirSync(issueDirPath).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const fullPath = join(issueDirPath, f);
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw);
        const { migrated, result: migratedArtifact } = migrateArtifact(parsed);
        if (migrated) {
          writeFileSync(
            fullPath,
            JSON.stringify(migratedArtifact, null, 2) + "\n",
            "utf-8",
          );
          result.migrated += 1;
        } else {
          result.skipped += 1;
        }
      } catch (err) {
        result.errors.push(
          `${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return result;
}
