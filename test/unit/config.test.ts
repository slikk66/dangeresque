import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  normalizeScopeOpportunisticConfig,
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

test("loadConfig: allowedTools extends defaults preserving order", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({ allowedTools: ["Bash(aws *)"] }),
    );
    const cfg = loadConfig(tmp);
    const baseline = loadConfig(makeTmp());
    assert.equal(cfg.allowedTools.length, baseline.allowedTools.length + 1);
    assert.deepEqual(
      cfg.allowedTools.slice(0, baseline.allowedTools.length),
      baseline.allowedTools,
    );
    assert.equal(cfg.allowedTools.at(-1), "Bash(aws *)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: allowedTools dedupes overlap with defaults", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({ allowedTools: ["Read", "Bash(aws *)"] }),
    );
    const cfg = loadConfig(tmp);
    const baseline = loadConfig(makeTmp());
    assert.equal(cfg.allowedTools.length, baseline.allowedTools.length + 1);
    assert.equal(
      cfg.allowedTools.filter((t) => t === "Read").length,
      1,
      "Read must not be duplicated",
    );
    assert.ok(cfg.allowedTools.includes("Bash(aws *)"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: disallowedTools extends + dedupes the same way", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        disallowedTools: ["Bash(git push *)", "Bash(curl evil.com *)"],
      }),
    );
    const cfg = loadConfig(tmp);
    const baseline = loadConfig(makeTmp());
    assert.equal(cfg.disallowedTools.length, baseline.disallowedTools.length + 1);
    assert.equal(
      cfg.disallowedTools.filter((t) => t === "Bash(git push *)").length,
      1,
    );
    assert.ok(cfg.disallowedTools.includes("Bash(curl evil.com *)"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: scalar override (model) still last-wins", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({ model: "claude-sonnet-4-6" }),
    );
    const cfg = loadConfig(tmp);
    const baseline = loadConfig(makeTmp());
    assert.equal(cfg.model, "claude-sonnet-4-6");
    assert.deepEqual(cfg.allowedTools, baseline.allowedTools);
    assert.deepEqual(cfg.disallowedTools, baseline.disallowedTools);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: empty arrays in user config leave defaults intact", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({ allowedTools: [], disallowedTools: [] }),
    );
    const cfg = loadConfig(tmp);
    const baseline = loadConfig(makeTmp());
    assert.deepEqual(cfg.allowedTools, baseline.allowedTools);
    assert.deepEqual(cfg.disallowedTools, baseline.disallowedTools);
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

// --- scope.opportunistic config ---

test("loadConfig: scope.opportunistic defaults present when no config file", () => {
  const tmp = makeTmp();
  try {
    const cfg = loadConfig(tmp);
    assert.equal(cfg.scope?.opportunistic.enabled, true);
    assert.equal(cfg.scope?.opportunistic.maxFiles, 1);
    assert.equal(cfg.scope?.opportunistic.maxLines, 20);
    assert.deepEqual(cfg.scope?.opportunistic.denyGlobs, [
      "infra/**",
      ".github/**",
      "**/*.lock",
      "**/migrations/**",
      "**/.env*",
      "**/secrets/**",
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: scope.opportunistic missing in config.json → defaults", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(join(tmp, CONFIG_DIR, "config.json"), JSON.stringify({ engine: "claude" }));
    const cfg = loadConfig(tmp);
    assert.equal(cfg.scope?.opportunistic.enabled, true);
    assert.equal(cfg.scope?.opportunistic.maxFiles, 1);
    assert.equal(cfg.scope?.opportunistic.maxLines, 20);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: scope.opportunistic custom denyGlobs replace defaults", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        scope: {
          opportunistic: {
            denyGlobs: ["custom/**"],
          },
        },
      }),
    );
    const cfg = loadConfig(tmp);
    assert.deepEqual(cfg.scope?.opportunistic.denyGlobs, ["custom/**"]);
    assert.equal(cfg.scope?.opportunistic.enabled, true, "missing fields fall to defaults");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: scope.opportunistic empty denyGlobs is honored as override", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({ scope: { opportunistic: { denyGlobs: [] } } }),
    );
    const cfg = loadConfig(tmp);
    assert.deepEqual(cfg.scope?.opportunistic.denyGlobs, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("normalizeScopeOpportunisticConfig: malformed input falls back silently", () => {
  const cfg = normalizeScopeOpportunisticConfig({
    enabled: "yes",
    maxFiles: -3,
    maxLines: "lots",
    denyGlobs: ["ok", 42, null, "also/**"],
  });
  // enabled non-boolean → default
  assert.equal(cfg.enabled, true);
  // negative numbers rejected → default
  assert.equal(cfg.maxFiles, 1);
  // string rejected → default
  assert.equal(cfg.maxLines, 20);
  // non-string entries dropped silently
  assert.deepEqual(cfg.denyGlobs, ["ok", "also/**"]);
});

test("normalizeScopeOpportunisticConfig: null/undefined → defaults", () => {
  const a = normalizeScopeOpportunisticConfig(null);
  const b = normalizeScopeOpportunisticConfig(undefined);
  assert.equal(a.enabled, true);
  assert.equal(b.enabled, true);
  assert.equal(a.maxFiles, 1);
  assert.equal(b.maxFiles, 1);
  assert.equal(a.maxLines, 20);
  assert.ok(a.denyGlobs.length > 0);
});
