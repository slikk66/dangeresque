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
import { readBuildInfo, detectDrift } from "#dist/build-info.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "dangeresque-build-info-"));
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

test("readBuildInfo: returns parsed object when file present and valid", () => {
  const root = makeRoot();
  try {
    writeBuildInfo(root, {
      commit: "abc123",
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: "5",
    });
    const info = readBuildInfo({ root });
    assert.deepEqual(info, {
      commit: "abc123",
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: "5",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildInfo: returns null when file missing", () => {
  const root = makeRoot();
  try {
    assert.equal(readBuildInfo({ root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildInfo: returns null when JSON malformed", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "build-info.json"), "{not valid json");
    assert.equal(readBuildInfo({ root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readBuildInfo: returns null when shape invalid (missing required fields)", () => {
  const root = makeRoot();
  try {
    writeBuildInfo(root, { commit: "abc" });
    assert.equal(readBuildInfo({ root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectDrift: missing build-info → drift, reason no-build-info", () => {
  const root = makeRoot();
  try {
    const d = detectDrift({ root });
    assert.equal(d.drift, true);
    assert.equal(d.reason, "no-build-info");
    assert.equal(d.buildInfo, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectDrift: no .git → no drift, reason no-git-repo", () => {
  const root = makeRoot();
  try {
    writeBuildInfo(root, {
      commit: "abc123",
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: "5",
    });
    const d = detectDrift({ root });
    assert.equal(d.drift, false);
    assert.equal(d.reason, "no-git-repo");
    assert.ok(d.buildInfo);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectDrift: matching commit → no drift, reason match", () => {
  const root = makeRoot();
  try {
    const head = gitInit(root);
    writeBuildInfo(root, {
      commit: head,
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: "5",
    });
    const d = detectDrift({ root });
    assert.equal(d.drift, false);
    assert.equal(d.reason, "match");
    assert.equal(d.headCommit, head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectDrift: stale commit → drift, reason drift", () => {
  const root = makeRoot();
  try {
    const head = gitInit(root);
    writeBuildInfo(root, {
      commit: "0000000000000000000000000000000000000000",
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: "5",
    });
    const d = detectDrift({ root });
    assert.equal(d.drift, true);
    assert.equal(d.reason, "drift");
    assert.equal(d.headCommit, head);
    assert.equal(d.buildInfo?.commit, "0000000000000000000000000000000000000000");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectDrift: build-info has null commit → no drift, reason no-build-commit", () => {
  const root = makeRoot();
  try {
    gitInit(root);
    writeBuildInfo(root, {
      commit: null,
      built_at: "2026-05-03T00:00:00.000Z",
      schema_version: "5",
    });
    const d = detectDrift({ root });
    assert.equal(d.drift, false);
    assert.equal(d.reason, "no-build-commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectDrift: commit moved but src/ untouched → no drift (the build→commit→run sequence)", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    execSync("git init -q", { cwd: root, stdio: "pipe" });
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -q -m src", {
      cwd: root, stdio: "pipe", shell: "/bin/bash",
    });
    const builtCommit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
    writeBuildInfo(root, {
      commit: builtCommit,
      built_at: "2026-08-05T00:00:00.000Z",
      schema_version: "7",
    });

    // Commit something OUTSIDE src/ — exactly what happens when you build,
    // then commit docs/tests, then dispatch a run.
    writeFileSync(join(root, "README.md"), "# docs\n");
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -q -m docs", {
      cwd: root, stdio: "pipe", shell: "/bin/bash",
    });
    const head = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();

    const d = detectDrift({ root });
    assert.notEqual(builtCommit, head, "precondition: the commit really did move");
    assert.equal(d.drift, false, "dist is byte-identical to the source it was built from");
    assert.equal(d.reason, "src-unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectDrift: commit moved AND src/ changed → still drift", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    execSync("git init -q", { cwd: root, stdio: "pipe" });
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -q -m src", {
      cwd: root, stdio: "pipe", shell: "/bin/bash",
    });
    const builtCommit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
    writeBuildInfo(root, {
      commit: builtCommit,
      built_at: "2026-08-05T00:00:00.000Z",
      schema_version: "7",
    });

    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -q -m edit", {
      cwd: root, stdio: "pipe", shell: "/bin/bash",
    });

    const d = detectDrift({ root });
    assert.equal(d.drift, true, "real staleness must still be caught");
    assert.equal(d.reason, "drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectDrift: unknown build commit (amend/rebase) fails closed to drift", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    execSync("git init -q", { cwd: root, stdio: "pipe" });
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -q -m src", {
      cwd: root, stdio: "pipe", shell: "/bin/bash",
    });
    writeBuildInfo(root, {
      commit: "0000000000000000000000000000000000000000",
      built_at: "2026-08-05T00:00:00.000Z",
      schema_version: "7",
    });
    const d = detectDrift({ root });
    assert.equal(d.drift, true);
    assert.equal(d.reason, "drift");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
