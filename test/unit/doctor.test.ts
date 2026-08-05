import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctorChecks, formatDoctorReport } from "#dist/doctor.js";
import { ARTIFACT_SCHEMA_VERSION } from "#dist/artifact.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "dangeresque-doctor-"));
}

function seedValidProject(projectRoot: string): void {
  const configDir = join(projectRoot, ".dangeresque");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "worker-prompt.md"), "worker");
  writeFileSync(join(configDir, "review-prompt.md"), "review");
}

function writeBuildInfo(root: string, body: unknown): void {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "build-info.json"), JSON.stringify(body));
}

function gitInit(root: string): string {
  execSync("git init -q", { cwd: root, stdio: "pipe" });
  execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", {
    cwd: root,
    stdio: "pipe",
  });
  return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
}

function check(report: ReturnType<typeof runDoctorChecks>, name: string) {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`check ${name} not found in report`);
  return c;
}

test("doctor: all-pass synthetic environment", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    const head = gitInit(packageRoot);
    writeBuildInfo(packageRoot, {
      commit: head,
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: ARTIFACT_SCHEMA_VERSION,
    });
    seedValidProject(projectRoot);

    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => true,
    });
    assert.equal(check(report, "build-info-present").status, "pass");
    assert.equal(check(report, "dist-matches-head").status, "pass");
    assert.equal(check(report, "schema-version").status, "pass");
    assert.equal(check(report, "gh-cli-available").status, "pass");
    assert.equal(check(report, "dangeresque-initialized").status, "pass");
    assert.equal(check(report, "dangeresque-config-valid").status, "pass");
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("doctor: missing build-info → build-info-present and dist-matches-head WARN", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    seedValidProject(projectRoot);
    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => true,
    });
    assert.equal(check(report, "build-info-present").status, "warn");
    assert.equal(check(report, "dist-matches-head").status, "warn");
    assert.equal(check(report, "schema-version").status, "warn");
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("doctor: drift scenario → dist-matches-head WARN with built/HEAD detail", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    const head = gitInit(packageRoot);
    writeBuildInfo(packageRoot, {
      commit: "0000000000000000000000000000000000000000",
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: ARTIFACT_SCHEMA_VERSION,
    });
    seedValidProject(projectRoot);

    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => true,
    });
    const c = check(report, "dist-matches-head");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /drift/);
    assert.match(c.detail, /00000000/);
    assert.match(c.detail, new RegExp(head.slice(0, 8)));
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("doctor: missing .dangeresque/ → dangeresque-initialized WARN", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    const head = gitInit(packageRoot);
    writeBuildInfo(packageRoot, {
      commit: head,
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: ARTIFACT_SCHEMA_VERSION,
    });
    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => true,
    });
    assert.equal(check(report, "dangeresque-initialized").status, "warn");
    assert.equal(check(report, "dangeresque-config-valid").status, "warn");
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("doctor: rejected legacy config produces config-valid FAIL", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    const head = gitInit(packageRoot);
    writeBuildInfo(packageRoot, {
      commit: head,
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: ARTIFACT_SCHEMA_VERSION,
    });
    seedValidProject(projectRoot);
    writeFileSync(
      join(projectRoot, ".dangeresque", "config.json"),
      JSON.stringify({ model: "claude-opus", effort: "max" }),
    );

    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => true,
    });
    const c = check(report, "dangeresque-config-valid");
    assert.equal(c.status, "fail");
    assert.match(c.detail, /Legacy flat engine config/);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("doctor: gh missing → gh-cli-available WARN, others unaffected", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    const head = gitInit(packageRoot);
    writeBuildInfo(packageRoot, {
      commit: head,
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: ARTIFACT_SCHEMA_VERSION,
    });
    seedValidProject(projectRoot);
    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => false,
    });
    assert.equal(check(report, "gh-cli-available").status, "warn");
    assert.equal(check(report, "build-info-present").status, "pass");
    assert.equal(check(report, "dist-matches-head").status, "pass");
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("doctor: schema-version mismatch → schema-version WARN", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    const head = gitInit(packageRoot);
    writeBuildInfo(packageRoot, {
      commit: head,
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: "999",
    });
    seedValidProject(projectRoot);
    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => true,
    });
    const c = check(report, "schema-version");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /999/);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("doctor: non-git package root → dist-matches-head PASS (skipped)", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    writeBuildInfo(packageRoot, {
      commit: "abc123",
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: ARTIFACT_SCHEMA_VERSION,
    });
    seedValidProject(projectRoot);
    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => true,
    });
    const c = check(report, "dist-matches-head");
    assert.equal(c.status, "pass");
    assert.match(c.detail, /not a git repo/);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("formatDoctorReport: emits PASS/WARN tokens, summary, exit-code legend", () => {
  const packageRoot = makeRoot();
  const projectRoot = makeRoot();
  try {
    const head = gitInit(packageRoot);
    writeBuildInfo(packageRoot, {
      commit: head,
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: ARTIFACT_SCHEMA_VERSION,
    });
    const report = runDoctorChecks({
      projectRoot,
      root: packageRoot,
      ghProbe: () => true,
    });
    const out = formatDoctorReport(report);
    assert.match(out, /PASS/);
    assert.match(out, /WARN/);
    assert.match(out, /Summary:/);
    assert.match(out, /Exit codes:/);
    assert.match(out, /package root:/);
    assert.match(out, /project root:/);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
