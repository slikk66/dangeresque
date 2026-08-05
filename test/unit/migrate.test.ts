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

test("migrateArtifact: v4 → v7 adds scope fields and drops legacy values", () => {
  const v4 = v4Fixture();
  const { migrated, result } = migrateArtifact(v4);
  assert.equal(migrated, true);
  assert.equal(result.schema_version, ARTIFACT_SCHEMA_VERSION);
  assert.equal(result.schema_version, "7");
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
  assert.equal(
    (result as unknown as Record<string, unknown>).scope_violations,
    undefined,
    "scope_violations field must be dropped on v6",
  );
});

test("migrateArtifact: v5 → v7 drops scope_violations + renames scope_violation enum", () => {
  const v5 = v4Fixture({
    schema_version: "5",
    failure_categories: ["scope_violation", "reviewer_rejected"],
    scope_violations: ["unrelated.ts"],
    scope_block: { allow: [], deny: [], diagnostics: [] },
    scope_declaration: [],
    scope_report: { in_scope: [], extended: [], outside: ["unrelated.ts"] },
  });
  const { migrated, result } = migrateArtifact(v5);
  assert.equal(migrated, true);
  assert.equal(result.schema_version, "7");
  assert.equal(result.migrated_from_version, 5);
  assert.deepEqual(result.failure_categories, ["scope_outside", "reviewer_rejected"]);
  assert.equal(
    (result as unknown as Record<string, unknown>).scope_violations,
    undefined,
    "scope_violations field must be dropped on v6",
  );
  assert.deepEqual(result.scope_report, {
    in_scope: [],
    extended: [],
    outside: ["unrelated.ts"],
  });
});

test("migrateArtifact: v6 → v7 adds review_engine for historical reviewed runs", () => {
  const v6 = v4Fixture({
    schema_version: "6",
    review: { skipped: false, started_at: "x", ended_at: "x", duration_ms: 1, exit_code: 0 },
    failure_categories: ["scope_outside"],
    scope_block: { allow: [], deny: [], diagnostics: [] },
    scope_declaration: [],
    scope_report: { in_scope: [], extended: [], outside: ["x.ts"] },
  });
  delete (v6 as Record<string, unknown>).scope_violations;
  const { migrated, result } = migrateArtifact(v6);
  assert.equal(migrated, true);
  assert.equal(result.schema_version, "7");
  assert.equal(result.migrated_from_version, 6);
  assert.equal(result.review_engine, "claude");
  assert.deepEqual(result.failure_categories, ["scope_outside"]);
});

test("migrateArtifact: v7 input is a no-op", () => {
  const v7 = v4Fixture({ schema_version: "7" });
  const { migrated, result } = migrateArtifact(v7);
  assert.equal(migrated, false);
  assert.equal(result.schema_version, "7");
});

test("migrateArtifact: v4 → v7 chain renames scope_violation in failure_categories", () => {
  const v4 = v4Fixture({
    issue_number: 42,
    mode: "TEST",
    failure_categories: ["scope_violation"],
    scope_violations: ["unrelated.ts"],
  });
  const { result } = migrateArtifact(v4);
  assert.equal(result.issue_number, 42);
  assert.equal(result.mode, "TEST");
  assert.deepEqual(result.failure_categories, ["scope_outside"]);
  assert.equal(
    (result as unknown as Record<string, unknown>).scope_violations,
    undefined,
  );
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

test("migrateAllArtifacts: walks issue dirs, migrates v4/v5/v6, leaves v7 alone", () => {
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
      JSON.stringify(
        v4Fixture({
          issue_number: 1,
          schema_version: "5",
          failure_categories: ["scope_violation"],
          scope_violations: ["unrelated.ts"],
        }),
      ),
    );
    const v6Source = v4Fixture({
      issue_number: 1,
      schema_version: "6",
      failure_categories: ["scope_outside"],
    });
    delete (v6Source as Record<string, unknown>).scope_violations;
    writeFileSync(join(issueDir, "v6.json"), JSON.stringify(v6Source));
    writeFileSync(join(issueDir, "v7.json"), JSON.stringify(v4Fixture({ schema_version: "7" })));

    const result = migrateAllArtifacts(tmp);
    assert.equal(result.migrated, 3);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.errors, []);

    const migratedV4 = JSON.parse(readFileSync(join(issueDir, "v4.json"), "utf-8"));
    assert.equal(migratedV4.schema_version, "7");
    assert.equal(migratedV4.migrated_from_version, 4);
    assert.deepEqual(migratedV4.scope_block, {
      allow: [],
      deny: [],
      diagnostics: [],
    });
    assert.deepEqual(migratedV4.scope_declaration, []);
    assert.deepEqual(migratedV4.scope_report, {
      in_scope: [],
      extended: [],
      outside: [],
    });
    assert.equal(migratedV4.scope_violations, undefined);

    const migratedV5 = JSON.parse(readFileSync(join(issueDir, "v5.json"), "utf-8"));
    assert.equal(migratedV5.schema_version, "7");
    assert.equal(migratedV5.migrated_from_version, 5);
    assert.deepEqual(migratedV5.failure_categories, ["scope_outside"]);
    assert.equal(migratedV5.scope_violations, undefined);

    const v6File = JSON.parse(readFileSync(join(issueDir, "v6.json"), "utf-8"));
    assert.equal(v6File.schema_version, "7");
    assert.equal(v6File.migrated_from_version, 6);
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
