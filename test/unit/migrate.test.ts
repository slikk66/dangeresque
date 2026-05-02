import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateArtifact, migrateAllArtifacts } from "#dist/migrate.js";
import { ARTIFACT_SCHEMA_VERSION } from "#dist/artifact.js";

function v4Fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "4",
    run_id: "00000000-0000-0000-0000-000000000000",
    issue_number: 7,
    issue_url: null,
    mode: "IMPLEMENT",
    engine: "claude",
    model: "claude-opus-4-7",
    effort: "max",
    worktree_name: "dangeresque-implement-7",
    branch: "worktree-dangeresque-implement-7",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:10:00.000Z",
    duration_ms: 600000,
    worker: {
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:05:00.000Z",
      duration_ms: 300000,
      exit_code: 0,
    },
    review: null,
    result: "success",
    reviewer_verdict: "skipped",
    failure_categories: [],
    scope_violations: [],
    files_changed_count: 0,
    verification: null,
    summary: "",
    artifact_paths: { md: "", json: "" },
    lifecycle_events: [],
    ...overrides,
  };
}

test("migrateArtifact: v4 → v5 adds empty scope_* fields and audit field", () => {
  const v4 = v4Fixture();
  const { migrated, result } = migrateArtifact(v4);
  assert.equal(migrated, true);
  assert.equal(result.schema_version, ARTIFACT_SCHEMA_VERSION);
  assert.equal(result.schema_version, "5");
  assert.equal(result.migrated_from_version, 4);
  assert.deepEqual(result.scope_block, {
    allow: [],
    deny: [],
    diagnostics: [],
  });
  assert.deepEqual(result.scope_declaration, []);
  assert.deepEqual(result.scope_report, {
    in_scope: [],
    extended: [],
    outside: [],
  });
});

test("migrateArtifact: v5 input is a no-op", () => {
  const v5 = v4Fixture({ schema_version: "5" });
  const { migrated, result } = migrateArtifact(v5);
  assert.equal(migrated, false);
  assert.equal(result.schema_version, "5");
  assert.equal(result.migrated_from_version, undefined);
});

test("migrateArtifact: preserves all v4 fields verbatim", () => {
  const v4 = v4Fixture({
    issue_number: 42,
    mode: "TEST",
    failure_categories: ["scope_violation"],
    scope_violations: ["unrelated.ts"],
  });
  const { result } = migrateArtifact(v4);
  assert.equal(result.issue_number, 42);
  assert.equal(result.mode, "TEST");
  assert.deepEqual(result.failure_categories, ["scope_violation"]);
  assert.deepEqual(result.scope_violations, ["unrelated.ts"]);
});

test("migrateArtifact: unsupported source version throws", () => {
  assert.throws(
    () => migrateArtifact(v4Fixture({ schema_version: "2" })),
    /unsupported source schema_version: 2/,
  );
});

test("migrateArtifact: rejects non-object input", () => {
  assert.throws(() => migrateArtifact(null), /not a JSON object/);
  assert.throws(() => migrateArtifact("string"), /not a JSON object/);
  assert.throws(() => migrateArtifact([]), /not a JSON object/);
});

test("migrateAllArtifacts: walks issue dirs, migrates only v4", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-migrate-"));
  try {
    const issueDir = join(tmp, ".dangeresque", "runs", "issue-1");
    mkdirSync(issueDir, { recursive: true });

    writeFileSync(
      join(issueDir, "v4.json"),
      JSON.stringify(v4Fixture({ issue_number: 1 })),
    );
    writeFileSync(
      join(issueDir, "v5.json"),
      JSON.stringify(v4Fixture({ issue_number: 1, schema_version: "5" })),
    );

    const result = migrateAllArtifacts(tmp);
    assert.equal(result.migrated, 1);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.errors, []);

    const migratedRaw = readFileSync(join(issueDir, "v4.json"), "utf-8");
    const migrated = JSON.parse(migratedRaw);
    assert.equal(migrated.schema_version, "5");
    assert.equal(migrated.migrated_from_version, 4);
    assert.deepEqual(migrated.scope_block, {
      allow: [],
      deny: [],
      diagnostics: [],
    });
    assert.deepEqual(migrated.scope_declaration, []);
    assert.deepEqual(migrated.scope_report, {
      in_scope: [],
      extended: [],
      outside: [],
    });

    const v5File = JSON.parse(readFileSync(join(issueDir, "v5.json"), "utf-8"));
    assert.equal(v5File.schema_version, "5");
    assert.equal(v5File.migrated_from_version, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("migrateAllArtifacts: idempotent — second run reports 0 migrated", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-migrate-"));
  try {
    const issueDir = join(tmp, ".dangeresque", "runs", "issue-1");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(
      join(issueDir, "v4.json"),
      JSON.stringify(v4Fixture({ issue_number: 1 })),
    );

    const first = migrateAllArtifacts(tmp);
    assert.equal(first.migrated, 1);
    assert.equal(first.skipped, 0);

    const second = migrateAllArtifacts(tmp);
    assert.equal(second.migrated, 0);
    assert.equal(second.skipped, 1);
    assert.deepEqual(second.errors, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("migrateAllArtifacts: malformed JSON files captured as errors, do not abort", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-migrate-"));
  try {
    const issueDir = join(tmp, ".dangeresque", "runs", "issue-9");
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, "good.json"), JSON.stringify(v4Fixture()));
    writeFileSync(join(issueDir, "bad.json"), "{not json");

    const result = migrateAllArtifacts(tmp);
    assert.equal(result.migrated, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /bad\.json/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("migrateAllArtifacts: missing runs dir → empty result, no errors", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-migrate-"));
  try {
    const result = migrateAllArtifacts(tmp);
    assert.equal(result.migrated, 0);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("migrateAllArtifacts: ignores non-issue subdirs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-migrate-"));
  try {
    const stray = join(tmp, ".dangeresque", "runs", "junk");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "x.json"), JSON.stringify(v4Fixture()));

    const result = migrateAllArtifacts(tmp);
    assert.equal(result.migrated, 0);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.errors, []);

    const untouched = JSON.parse(readFileSync(join(stray, "x.json"), "utf-8"));
    assert.equal(untouched.schema_version, "4");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
