import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  validateSetup,
  projectHash,
  CONFIG_DIR,
} from "#dist/config.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "dangeresque-test-"));
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
