// One-off migration: bump schema_version 2 → 3 and add files_changed_count.
// The new field defaults to 0 for historical artifacts (no canonical count was
// computed at the time). Future runs populate it from src/summary.ts.
//
// Usage: node scripts/migrate-artifacts-v3.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUNS_DIR = ".dangeresque/runs";

let migrated = 0;
let skipped = 0;

for (const issueDir of readdirSync(RUNS_DIR)) {
  const fullDir = join(RUNS_DIR, issueDir);
  if (!statSync(fullDir).isDirectory()) continue;
  for (const file of readdirSync(fullDir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(fullDir, file);
    const original = readFileSync(path, "utf-8");
    const artifact = JSON.parse(original);
    if (artifact.schema_version !== "2") {
      skipped++;
      continue;
    }
    const updated = {
      ...artifact,
      schema_version: "3",
    };
    if (updated.files_changed_count === undefined) {
      updated.files_changed_count = 0;
    }
    writeFileSync(path, JSON.stringify(updated, null, 2) + "\n", "utf-8");
    migrated++;
  }
}

console.log(`Migrated ${migrated} artifact(s); skipped ${skipped}.`);
