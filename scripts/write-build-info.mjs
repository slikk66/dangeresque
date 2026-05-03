// Compile-time build-info generator. Runs after tsc as part of `yarn build`.
// Writes dist/build-info.json so the running binary can self-describe its
// commit/built_at/schema_version and detect drift from a freshly-pulled src/.
//
// Usage: node scripts/write-build-info.mjs
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const artifactUrl = pathToFileURL(join(repoRoot, "dist", "artifact.js")).href;
const { ARTIFACT_SCHEMA_VERSION } = await import(artifactUrl);

let commit = null;
try {
  commit = execSync("git rev-parse HEAD", {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {
  // Not a git repo (e.g. npm install -g) — fine, leave commit null.
}

const info = {
  commit,
  built_at: new Date().toISOString(),
  schema_version: ARTIFACT_SCHEMA_VERSION,
};
writeFileSync(
  join(repoRoot, "dist", "build-info.json"),
  JSON.stringify(info, null, 2) + "\n",
);
console.log(
  `Wrote dist/build-info.json (commit=${(commit ?? "null").slice(0, 8)}, schema=${ARTIFACT_SCHEMA_VERSION})`,
);
