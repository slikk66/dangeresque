import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  validateSetup,
  validateEngineRuntime,
  claudeMdHasPointer,
  projectHash,
  CONFIG_DIR,
  POINTER_BLOCK,
} from "#dist/config.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "dangeresque-test-"));
}

function seedPointer(projectRoot: string): void {
  writeFileSync(join(projectRoot, "CLAUDE.md"), POINTER_BLOCK);
}

test("loadConfig: no config file → full defaults", () => {
  const tmp = makeTmp();
  try {
    const cfg = loadConfig(tmp);
    assert.equal(cfg.engine, "claude");
    assert.equal(cfg.permissionMode, "acceptEdits");
    assert.equal(cfg.workerPrompt, "worker-prompt.md");
    assert.equal(cfg.reviewPrompt, "review-prompt.md");
    assert.ok(cfg.allowedTools.length > 0);
    assert.ok(cfg.disallowedTools.length > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: partial config merges with defaults", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({ engine: "codex", model: "custom-model" }),
    );
    const cfg = loadConfig(tmp);
    assert.equal(cfg.engine, "codex");
    assert.equal(cfg.model, "custom-model");
    assert.equal(cfg.permissionMode, "acceptEdits");
    assert.equal(cfg.workerPrompt, "worker-prompt.md");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: malformed JSON throws", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(join(tmp, CONFIG_DIR, "config.json"), "{ not json");
    assert.throws(() => loadConfig(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateSetup: missing .dangeresque/ directory → invalid", () => {
  const tmp = makeTmp();
  try {
    const result = validateSetup(tmp);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes(CONFIG_DIR)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateSetup: invalid engine value reported", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({ engine: "banana" }),
    );
    writeFileSync(join(tmp, CONFIG_DIR, "worker-prompt.md"), "worker");
    writeFileSync(join(tmp, CONFIG_DIR, "review-prompt.md"), "review");
    const result = validateSetup(tmp);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("banana")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateSetup: missing worker-prompt.md reported", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(join(tmp, CONFIG_DIR, "review-prompt.md"), "review");
    const result = validateSetup(tmp);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("worker-prompt.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateSetup: fully valid fixture returns { valid: true, errors: [] }", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(join(tmp, CONFIG_DIR, "worker-prompt.md"), "worker");
    writeFileSync(join(tmp, CONFIG_DIR, "review-prompt.md"), "review");
    const result = validateSetup(tmp);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("projectHash: rewrites slashes and dots to dashes", () => {
  assert.equal(projectHash("/Users/foo/.bar"), "-Users-foo--bar");
});

test("validateEngineRuntime: binary missing on PATH returns error, skips auth + pointer checks", () => {
  const fakeHome = makeTmp();
  const projectRoot = makeTmp();
  try {
    const result = validateEngineRuntime("codex", projectRoot, {
      homedirFn: () => fakeHome,
      probeMissing: () => true,
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Engine 'codex' not found on PATH/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("validateEngineRuntime: codex missing auth.json returns error", () => {
  const fakeHome = makeTmp();
  const projectRoot = makeTmp();
  try {
    seedPointer(projectRoot);
    const result = validateEngineRuntime("codex", projectRoot, {
      homedirFn: () => fakeHome,
      probeMissing: () => false,
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.match(
      result.errors[0],
      /Engine 'codex' is on PATH but not authenticated/,
    );
    assert.match(result.errors[0], /Run: codex login/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("validateEngineRuntime: codex with auth.json + pointer returns valid", () => {
  const fakeHome = makeTmp();
  const projectRoot = makeTmp();
  try {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(join(fakeHome, ".codex", "auth.json"), "{}");
    seedPointer(projectRoot);
    const result = validateEngineRuntime("codex", projectRoot, {
      homedirFn: () => fakeHome,
      probeMissing: () => false,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("validateEngineRuntime: claude with pointer present returns valid", () => {
  const fakeHome = makeTmp();
  const projectRoot = makeTmp();
  try {
    seedPointer(projectRoot);
    const result = validateEngineRuntime("claude", projectRoot, {
      homedirFn: () => fakeHome,
      probeMissing: () => false,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("validateEngineRuntime: pointer missing from both CLAUDE.md locations returns error", () => {
  const fakeHome = makeTmp();
  const projectRoot = makeTmp();
  try {
    const result = validateEngineRuntime("claude", projectRoot, {
      homedirFn: () => fakeHome,
      probeMissing: () => false,
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.match(
      result.errors[0],
      /dangeresque pointer missing from CLAUDE\.md and \.claude\/CLAUDE\.md/,
    );
    assert.match(result.errors[0], /<!-- DANGERESQUE-START -->/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("validateEngineRuntime: CLAUDE.md exists but missing pointer returns error", () => {
  const fakeHome = makeTmp();
  const projectRoot = makeTmp();
  try {
    writeFileSync(join(projectRoot, "CLAUDE.md"), "# Project\n\nNo pointer here.\n");
    const result = validateEngineRuntime("claude", projectRoot, {
      homedirFn: () => fakeHome,
      probeMissing: () => false,
    });
    assert.equal(result.valid, false);
    assert.match(
      result.errors[0],
      /dangeresque pointer missing from CLAUDE\.md and \.claude\/CLAUDE\.md/,
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("validateEngineRuntime: pointer in .claude/CLAUDE.md (not root) is accepted", () => {
  const fakeHome = makeTmp();
  const projectRoot = makeTmp();
  try {
    mkdirSync(join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(join(projectRoot, ".claude", "CLAUDE.md"), POINTER_BLOCK);
    const result = validateEngineRuntime("claude", projectRoot, {
      homedirFn: () => fakeHome,
      probeMissing: () => false,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("claudeMdHasPointer: returns found=false with both candidate paths when neither file exists", () => {
  const projectRoot = makeTmp();
  try {
    const result = claudeMdHasPointer(projectRoot);
    assert.equal(result.found, false);
    assert.equal(result.matchedPath, null);
    assert.equal(result.checkedPaths.length, 2);
    assert.ok(result.checkedPaths[0].endsWith("CLAUDE.md"));
    assert.ok(result.checkedPaths[1].endsWith(join(".claude", "CLAUDE.md")));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
