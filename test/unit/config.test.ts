import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  normalizeScopeOpportunisticConfig,
  normalizeDispatchGateConfig,
  normalizeMergeGateConfig,
  validateSetup,
  validateEngineRuntime,
  resolveRunPlan,
  agentMdHasPointer,
  ensurePointer,
  projectHash,
  CONFIG_DIR,
  POINTER_BLOCK,
  DEFAULT_DISPATCH_GATE_MODES,
  DEFAULT_MERGE_GATE_MODES,
} from "#dist/config.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "dangeresque-test-"));
}

function seedPointer(projectRoot: string, engine: "claude" | "codex" = "claude"): void {
  const file = engine === "codex" ? "AGENTS.md" : "CLAUDE.md";
  writeFileSync(join(projectRoot, file), POINTER_BLOCK);
}

test("loadConfig: no config file → full defaults", () => {
  const tmp = makeTmp();
  try {
    const cfg = loadConfig(tmp);
    assert.deepEqual(cfg.worker, {
      engine: "claude",
      model: "claude-opus-4-7",
      effort: "max",
    });
    assert.deepEqual(cfg.engineDefaults, {
      claude: { model: "claude-opus-4-7", effort: "max" },
      codex: { model: "gpt-5.5", effort: "xhigh" },
    });
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
      JSON.stringify({ worker: { engine: "codex", model: "custom-model", effort: "high" } }),
    );
    const cfg = loadConfig(tmp);
    assert.deepEqual(cfg.worker, { engine: "codex", model: "custom-model", effort: "high" });
    assert.equal(cfg.permissionMode, "acceptEdits");
    assert.equal(cfg.workerPrompt, "worker-prompt.md");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: loads explicit mixed-engine phases", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        engineDefaults: {
          claude: { model: "claude-opus-4-7", effort: "max" },
          codex: { model: "gpt-5.5", effort: "xhigh" },
        },
        worker: { engine: "codex" },
        review: { engine: "claude" },
      }),
    );
    const cfg = loadConfig(tmp);
    assert.deepEqual(resolveRunPlan(cfg), {
      worker: { engine: "codex", model: "gpt-5.5", effort: "xhigh" },
      review: { engine: "claude", model: "claude-opus-4-7", effort: "max" },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRunPlan: applies worker and review overrides immutably", () => {
  const cfg = loadConfig(makeTmp());
  const plan = resolveRunPlan(cfg, {
    worker: { engine: "codex", model: "gpt-5.5", effort: "xhigh" },
    review: { engine: "claude", model: "claude-opus", effort: "max" },
  });
  assert.deepEqual(plan.worker, { engine: "codex", model: "gpt-5.5", effort: "xhigh" });
  assert.deepEqual(plan.review, { engine: "claude", model: "claude-opus", effort: "max" });
  assert.equal(cfg.worker.engine, "claude");
});

test("resolveRunPlan: omitted review inherits resolved worker", () => {
  const cfg = loadConfig(makeTmp());
  const plan = resolveRunPlan(cfg, {
    worker: { model: "claude-sonnet", effort: "high" },
  });
  assert.deepEqual(plan.review, plan.worker);
});

test("resolveRunPlan: engine-only worker override uses target engine defaults", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        engineDefaults: {
          claude: { model: "claude-opus", effort: "max" },
          codex: { model: "gpt-5.6-sol", effort: "xhigh" },
        },
        worker: { engine: "claude", model: "claude-worker", effort: "high" },
      }),
    );
    const plan = resolveRunPlan(loadConfig(tmp), {
      worker: { engine: "codex" },
    });
    assert.deepEqual(plan.worker, {
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
    assert.deepEqual(plan.review, plan.worker);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRunPlan: engine-only review override uses target engine defaults", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        engineDefaults: {
          claude: { model: "claude-opus", effort: "max" },
          codex: { model: "gpt-5.6-sol", effort: "xhigh" },
        },
        worker: { engine: "claude", model: "claude-worker", effort: "high" },
      }),
    );
    const plan = resolveRunPlan(loadConfig(tmp), {
      review: { engine: "codex" },
    });
    assert.deepEqual(plan.review, {
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRunPlan: explicit model and effort override target engine defaults", () => {
  const cfg = loadConfig(makeTmp());
  const plan = resolveRunPlan(cfg, {
    worker: { engine: "codex", model: "gpt-custom", effort: "medium" },
  });
  assert.deepEqual(plan.worker, {
    engine: "codex",
    model: "gpt-custom",
    effort: "medium",
  });
});

test("resolveRunPlan: cross-engine review uses target engine defaults", () => {
  const cfg = loadConfig(makeTmp());
  assert.deepEqual(resolveRunPlan(cfg, { review: { engine: "codex" } }).review, {
    engine: "codex",
    model: "gpt-5.5",
    effort: "xhigh",
  });
});

test("loadConfig: worker can select a standing engine default without repeating model", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        engineDefaults: {
          codex: { model: "gpt-5.6-sol", effort: "high" },
        },
        worker: { engine: "codex" },
      }),
    );
    assert.deepEqual(loadConfig(tmp).worker, {
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: invalid engine default fails loudly", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        engineDefaults: { codex: { model: "gpt-5.6-sol", effort: "" } },
      }),
    );
    assert.throws(
      () => loadConfig(tmp),
      /engineDefaults\.codex\.effort must be a non-empty string/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveRunPlan: supports all four worker/review engine pairings", () => {
  const cfg = loadConfig(makeTmp());
  for (const workerEngine of ["claude", "codex"] as const) {
    for (const reviewEngine of ["claude", "codex"] as const) {
      const plan = resolveRunPlan(cfg, {
        worker: { engine: workerEngine, model: `${workerEngine}-model`, effort: "high" },
        review: { engine: reviewEngine, model: `${reviewEngine}-review`, effort: "high" },
      });
      assert.equal(plan.worker.engine, workerEngine);
      assert.equal(plan.review.engine, reviewEngine);
    }
  }
});

test("loadConfig: legacy flat engine fields fail loudly", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
  writeFileSync(join(tmp, CONFIG_DIR, "config.json"), JSON.stringify({ engine: "codex" }));
  assert.throws(() => loadConfig(tmp), /Legacy flat engine config.*engine/);
  rmSync(tmp, { recursive: true, force: true });
});

test("loadConfig: shipped config example is valid when copied verbatim", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    const example = readFileSync(
      join(process.cwd(), "config-templates", "config.example.json"),
      "utf-8",
    );
    writeFileSync(join(tmp, CONFIG_DIR, "config.json"), example);
    assert.doesNotThrow(() => loadConfig(tmp));
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

test("loadConfig: worker model override still last-wins", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({ worker: { model: "claude-sonnet-4-6" } }),
    );
    const cfg = loadConfig(tmp);
    const baseline = loadConfig(makeTmp());
    assert.equal(cfg.worker.model, "claude-sonnet-4-6");
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

test("loadConfig: non-object JSON fails loudly", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
  writeFileSync(join(tmp, CONFIG_DIR, "config.json"), "null");
  assert.throws(() => loadConfig(tmp), /must contain a JSON object/);
  rmSync(tmp, { recursive: true, force: true });
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
      JSON.stringify({ worker: { engine: "banana" } }),
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
    seedPointer(projectRoot, "codex");
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
    seedPointer(projectRoot, "codex");
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

test("agentMdHasPointer claude: returns 2 CLAUDE.md candidates, ignores AGENTS.md", () => {
  const projectRoot = makeTmp();
  try {
    const result = agentMdHasPointer(projectRoot, "claude");
    assert.equal(result.found, false);
    assert.equal(result.matchedPath, null);
    assert.equal(result.checkedPaths.length, 2);
    assert.ok(result.checkedPaths[0].endsWith("CLAUDE.md"));
    assert.ok(result.checkedPaths[1].endsWith(join(".claude", "CLAUDE.md")));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("agentMdHasPointer codex: returns AGENTS.md as the sole candidate", () => {
  const projectRoot = makeTmp();
  try {
    const result = agentMdHasPointer(projectRoot, "codex");
    assert.equal(result.found, false);
    assert.equal(result.checkedPaths.length, 1);
    assert.ok(result.checkedPaths[0].endsWith("AGENTS.md"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("agentMdHasPointer claude: AGENTS.md with pointer does NOT count for claude engine", () => {
  const projectRoot = makeTmp();
  try {
    writeFileSync(join(projectRoot, "AGENTS.md"), POINTER_BLOCK);
    const result = agentMdHasPointer(projectRoot, "claude");
    assert.equal(result.found, false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("agentMdHasPointer codex: finds pointer in AGENTS.md", () => {
  const projectRoot = makeTmp();
  try {
    writeFileSync(join(projectRoot, "AGENTS.md"), POINTER_BLOCK);
    const result = agentMdHasPointer(projectRoot, "codex");
    assert.equal(result.found, true);
    assert.ok(result.matchedPath?.endsWith("AGENTS.md"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("ensurePointer: prepends when file lacks anchored block", () => {
  const before = "# Project Rules\n\nbody\n";
  const { content, action } = ensurePointer(before);
  assert.equal(action, "prepended");
  assert.ok(content.startsWith("<!-- DANGERESQUE-START -->"));
  assert.ok(content.endsWith("# Project Rules\n\nbody\n"));
});

test("ensurePointer: replaces drifted anchored block", () => {
  const before =
    "<!-- DANGERESQUE-START -->\nstale text\n<!-- DANGERESQUE-END -->\n# Rules\n";
  const { content, action } = ensurePointer(before);
  assert.equal(action, "replaced");
  assert.ok(!content.includes("stale text"));
  assert.ok(content.includes("dangeresque brief"));
  assert.ok(content.endsWith("# Rules\n"));
});

test("ensurePointer: noop when block already current", () => {
  const before = POINTER_BLOCK + "\n# Rules\n";
  const { content, action } = ensurePointer(before);
  assert.equal(action, "noop");
  assert.equal(content, before);
});

test("POINTER_BLOCK names primer, command surface, and worker constraints files", () => {
  // Drift guard: the redrafted pointer routes new readers to three named
  // files. Removing any of these silently steers them back to scrolling
  // through the long brief or guessing where rules live.
  assert.ok(
    POINTER_BLOCK.includes(".dangeresque/DANGERESQUE.md"),
    "POINTER_BLOCK must name the workflow primer (DANGERESQUE.md)",
  );
  assert.ok(
    POINTER_BLOCK.includes("dangeresque --help"),
    "POINTER_BLOCK must point at the canonical command surface (--help)",
  );
  assert.ok(
    POINTER_BLOCK.includes(".dangeresque/AFK_WORKER_RULES.md"),
    "POINTER_BLOCK must name the AFK worker constraints file",
  );
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
    writeFileSync(join(tmp, CONFIG_DIR, "config.json"), JSON.stringify({ worker: { engine: "claude" } }));
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

// --- dispatchGate / mergeGate config parsing (fail-closed) ---

test("normalizeDispatchGateConfig: absent (undefined/null) → undefined (gate off)", () => {
  assert.equal(normalizeDispatchGateConfig(undefined), undefined);
  assert.equal(normalizeDispatchGateConfig(null), undefined);
});

test("normalizeDispatchGateConfig: empty object → defaults (enabled=false, all modes, requireInvestigate=true, no commands)", () => {
  const cfg = normalizeDispatchGateConfig({})!;
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.modes, DEFAULT_DISPATCH_GATE_MODES);
  assert.equal(cfg.requireInvestigateBeforeImplement, true);
  assert.deepEqual(cfg.commands, []);
});

test("normalizeDispatchGateConfig: full valid block round-trips", () => {
  const cfg = normalizeDispatchGateConfig({
    enabled: true,
    modes: ["implement", "REFACTOR"],
    requireInvestigateBeforeImplement: false,
    commands: [
      { name: "policy", cmd: "true", on_failure: "block", timeout_ms: 5000 },
      { name: "advisory", cmd: "false", on_failure: "warn" },
    ],
  })!;
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.modes, ["IMPLEMENT", "REFACTOR"]);
  assert.equal(cfg.requireInvestigateBeforeImplement, false);
  assert.equal(cfg.commands.length, 2);
  assert.equal(cfg.commands[0].on_failure, "block");
  assert.equal(cfg.commands[0].timeout_ms, 5000);
  assert.equal(cfg.commands[1].on_failure, "warn");
  assert.ok(cfg.commands[1].timeout_ms > 0, "timeout_ms defaults to positive");
});

test("normalizeDispatchGateConfig: absent workOrderPattern stays absent", () => {
  const cfg = normalizeDispatchGateConfig({ enabled: true })!;
  assert.equal(cfg.workOrderPattern, undefined);
});

test("normalizeDispatchGateConfig: valid workOrderPattern round-trips", () => {
  const cfg = normalizeDispatchGateConfig({
    enabled: true,
    workOrderPattern: "^##\\s*\\[ACTIVE",
  })!;
  assert.equal(cfg.workOrderPattern, "^##\\s*\\[ACTIVE");
});

test("normalizeDispatchGateConfig: workOrderPattern non-string → throws", () => {
  assert.throws(
    () => normalizeDispatchGateConfig({ workOrderPattern: 42 }),
    /dispatchGate\.workOrderPattern must be a string/,
  );
});

test("normalizeDispatchGateConfig: uncompilable workOrderPattern → throws at load", () => {
  assert.throws(
    () => normalizeDispatchGateConfig({ workOrderPattern: "^##\\s*[ACTIVE" }),
    /dispatchGate\.workOrderPattern is not a valid regex/,
  );
});

test("normalizeDispatchGateConfig: non-object → throws", () => {
  assert.throws(() => normalizeDispatchGateConfig("hi"), /must be an object/);
  assert.throws(() => normalizeDispatchGateConfig([]), /must be an object.*array/);
});

test("normalizeDispatchGateConfig: enabled non-boolean → throws", () => {
  assert.throws(
    () => normalizeDispatchGateConfig({ enabled: "yes" }),
    /dispatchGate\.enabled must be a boolean/,
  );
});

test("normalizeDispatchGateConfig: modes not string[] → throws", () => {
  assert.throws(
    () => normalizeDispatchGateConfig({ modes: [1, 2] }),
    /dispatchGate\.modes must be an array of strings/,
  );
});

test("normalizeDispatchGateConfig: command missing name → throws with index", () => {
  assert.throws(
    () =>
      normalizeDispatchGateConfig({
        commands: [{ cmd: "true", on_failure: "block" }],
      }),
    /dispatchGate\.commands\[0\] is missing required non-empty string field 'name'/,
  );
});

test("normalizeDispatchGateConfig: command missing cmd → throws referencing name", () => {
  assert.throws(
    () =>
      normalizeDispatchGateConfig({
        commands: [{ name: "policy", on_failure: "block" }],
      }),
    /dispatchGate\.commands\[0\] \(policy\) is missing required non-empty string field 'cmd'/,
  );
});

test("normalizeDispatchGateConfig: invalid on_failure → throws", () => {
  assert.throws(
    () =>
      normalizeDispatchGateConfig({
        commands: [{ name: "x", cmd: "y", on_failure: "explode" }],
      }),
    /has invalid on_failure "explode"/,
  );
});

test("normalizeDispatchGateConfig: invalid timeout_ms → throws", () => {
  assert.throws(
    () =>
      normalizeDispatchGateConfig({
        commands: [{ name: "x", cmd: "y", timeout_ms: 0 }],
      }),
    /has invalid timeout_ms 0/,
  );
  assert.throws(
    () =>
      normalizeDispatchGateConfig({
        commands: [{ name: "x", cmd: "y", timeout_ms: "5s" }],
      }),
    /has invalid timeout_ms 5s/,
  );
});

test("normalizeDispatchGateConfig: unknown top-level field → throws (strict-key check)", () => {
  assert.throws(
    () => normalizeDispatchGateConfig({ enabled: true, typo: "oops" }),
    /dispatchGate has unknown field 'typo'/,
  );
});

test("normalizeDispatchGateConfig: unknown command field → throws (strict-key check)", () => {
  assert.throws(
    () =>
      normalizeDispatchGateConfig({
        commands: [{ name: "x", cmd: "y", retries: 3 }],
      }),
    /dispatchGate\.commands\[0\] \(x\) has unknown field 'retries'/,
  );
});

test("normalizeMergeGateConfig: absent → undefined", () => {
  assert.equal(normalizeMergeGateConfig(undefined), undefined);
  assert.equal(normalizeMergeGateConfig(null), undefined);
});

test("normalizeMergeGateConfig: empty object → defaults (mergeGate modes = IMPLEMENT/REFACTOR/TEST)", () => {
  const cfg = normalizeMergeGateConfig({})!;
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.modes, DEFAULT_MERGE_GATE_MODES);
  assert.equal(cfg.requireAcceptedImplement, true);
  assert.deepEqual(cfg.commands, []);
});

test("normalizeMergeGateConfig: enabled non-boolean → throws", () => {
  assert.throws(
    () => normalizeMergeGateConfig({ enabled: 1 }),
    /mergeGate\.enabled must be a boolean/,
  );
});

test("normalizeMergeGateConfig: requireAcceptedImplement non-boolean → throws", () => {
  assert.throws(
    () => normalizeMergeGateConfig({ requireAcceptedImplement: "no" }),
    /mergeGate\.requireAcceptedImplement must be a boolean/,
  );
});

test("normalizeMergeGateConfig: valid block round-trips", () => {
  const cfg = normalizeMergeGateConfig({
    enabled: true,
    modes: ["IMPLEMENT"],
    requireAcceptedImplement: false,
    commands: [{ name: "guard", cmd: "true", on_failure: "block", timeout_ms: 10000 }],
  })!;
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.modes, ["IMPLEMENT"]);
  assert.equal(cfg.requireAcceptedImplement, false);
  assert.equal(cfg.commands.length, 1);
});

test("normalizeMergeGateConfig: unknown top-level field → throws (strict-key check)", () => {
  assert.throws(
    () => normalizeMergeGateConfig({ enabled: true, ttl: 60 }),
    /mergeGate has unknown field 'ttl'/,
  );
});

test("normalizeMergeGateConfig: unknown command field → throws (strict-key check)", () => {
  assert.throws(
    () =>
      normalizeMergeGateConfig({
        commands: [{ name: "guard", cmd: "true", extra: "?" }],
      }),
    /mergeGate\.commands\[0\] \(guard\) has unknown field 'extra'/,
  );
});

test("loadConfig: dispatchGate + mergeGate blocks merged from JSON", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        dispatchGate: {
          enabled: true,
          commands: [{ name: "policy", cmd: "true" }],
        },
        mergeGate: {
          enabled: true,
          modes: ["IMPLEMENT"],
        },
      }),
    );
    const cfg = loadConfig(tmp);
    assert.equal(cfg.dispatchGate?.enabled, true);
    assert.equal(cfg.dispatchGate?.commands.length, 1);
    assert.equal(cfg.dispatchGate?.commands[0].on_failure, "block", "on_failure defaults to block when omitted");
    assert.equal(cfg.mergeGate?.enabled, true);
    assert.deepEqual(cfg.mergeGate?.modes, ["IMPLEMENT"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: absent gate blocks → both undefined (backwards-compat, gates off)", () => {
  const tmp = makeTmp();
  try {
    const cfg = loadConfig(tmp);
    assert.equal(cfg.dispatchGate, undefined);
    assert.equal(cfg.mergeGate, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadConfig: malformed dispatchGate → throws at load time (fail closed)", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    writeFileSync(
      join(tmp, CONFIG_DIR, "config.json"),
      JSON.stringify({
        dispatchGate: {
          commands: [{ name: "no-cmd" }],
        },
      }),
    );
    assert.throws(() => loadConfig(tmp), /dispatchGate\.commands\[0\] \(no-cmd\) is missing required non-empty string field 'cmd'/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
