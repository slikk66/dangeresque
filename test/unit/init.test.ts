import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyWithLocalOverlay,
  initProject,
  mergeClaudeHookSettings,
  SPLIT_BASE_NAMES,
} from "#dist/init.js";
import { POINTER_ANCHOR, POINTER_BLOCK } from "#dist/config.js";
import { BRIEF_MARKDOWN } from "#dist/brief.js";

const SHIPPED_CANONICAL = "CANONICAL CONTENT v2\n";
const SHIPPED_LOCAL_STUB =
  "<!-- Project-specific additions to worker-prompt.md — dangeresque will never overwrite this file. -->\n";

function setupFixture(): {
  templatesDir: string;
  configDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "dangeresque-init-"));
  const templatesDir = join(root, "templates");
  const configDir = join(root, ".dangeresque");
  mkdirSync(templatesDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(templatesDir, "worker-prompt.md"), SHIPPED_CANONICAL);
  writeFileSync(join(templatesDir, "worker-prompt.local.md"), SHIPPED_LOCAL_STUB);
  return {
    templatesDir,
    configDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("copyWithLocalOverlay: fresh project — installs canonical + local stub (action: created)", () => {
  const { templatesDir, configDir, cleanup } = setupFixture();
  const warnings: string[] = [];
  try {
    const action = copyWithLocalOverlay(templatesDir, configDir, "worker-prompt.md", warnings);
    assert.equal(action, "created");
    assert.equal(warnings.length, 0);
    assert.equal(readFileSync(join(configDir, "worker-prompt.md"), "utf-8"), SHIPPED_CANONICAL);
    assert.equal(readFileSync(join(configDir, "worker-prompt.local.md"), "utf-8"), SHIPPED_LOCAL_STUB);
  } finally {
    cleanup();
  }
});

test("copyWithLocalOverlay: canonical matches shipped, no local — initializes local stub (action: initialized-local)", () => {
  const { templatesDir, configDir, cleanup } = setupFixture();
  const warnings: string[] = [];
  try {
    writeFileSync(join(configDir, "worker-prompt.md"), SHIPPED_CANONICAL);
    const action = copyWithLocalOverlay(templatesDir, configDir, "worker-prompt.md", warnings);
    assert.equal(action, "initialized-local");
    assert.equal(warnings.length, 0);
    assert.equal(readFileSync(join(configDir, "worker-prompt.md"), "utf-8"), SHIPPED_CANONICAL);
    assert.equal(readFileSync(join(configDir, "worker-prompt.local.md"), "utf-8"), SHIPPED_LOCAL_STUB);
  } finally {
    cleanup();
  }
});

test("copyWithLocalOverlay: canonical + local both present — refreshes canonical, leaves local untouched (action: upgraded)", () => {
  const { templatesDir, configDir, cleanup } = setupFixture();
  const warnings: string[] = [];
  try {
    writeFileSync(join(configDir, "worker-prompt.md"), "OLD CANONICAL v1\n");
    writeFileSync(join(configDir, "worker-prompt.local.md"), "MY CUSTOM LOCAL ADDITION\n");
    const action = copyWithLocalOverlay(templatesDir, configDir, "worker-prompt.md", warnings);
    assert.equal(action, "upgraded");
    assert.equal(warnings.length, 0);
    assert.equal(readFileSync(join(configDir, "worker-prompt.md"), "utf-8"), SHIPPED_CANONICAL);
    assert.equal(readFileSync(join(configDir, "worker-prompt.local.md"), "utf-8"), "MY CUSTOM LOCAL ADDITION\n");
  } finally {
    cleanup();
  }
});

test("copyWithLocalOverlay: customized canonical, no local — pushes warning, touches nothing (action: customized-warn)", () => {
  const { templatesDir, configDir, cleanup } = setupFixture();
  const warnings: string[] = [];
  try {
    const customized = "CUSTOMIZED CANONICAL — user edits in place\n";
    writeFileSync(join(configDir, "worker-prompt.md"), customized);
    const action = copyWithLocalOverlay(templatesDir, configDir, "worker-prompt.md", warnings);
    assert.equal(action, "customized-warn");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /has been customized/);
    assert.match(warnings[0], /worker-prompt\.local\.md/);
    assert.match(warnings[0], /Re-run dangeresque init/);
    assert.equal(readFileSync(join(configDir, "worker-prompt.md"), "utf-8"), customized);
    assert.equal(existsSync(join(configDir, "worker-prompt.local.md")), false);
  } finally {
    cleanup();
  }
});

test("copyWithLocalOverlay: upgrade preserves arbitrary local content byte-for-byte", () => {
  const { templatesDir, configDir, cleanup } = setupFixture();
  const warnings: string[] = [];
  try {
    writeFileSync(join(configDir, "worker-prompt.md"), "CANONICAL v1\n");
    const userLocal = "## My team's overrides\n- Always use yarn\n- TypeScript strict mode\n\n<!-- trailing comment -->\n";
    writeFileSync(join(configDir, "worker-prompt.local.md"), userLocal);

    const action = copyWithLocalOverlay(templatesDir, configDir, "worker-prompt.md", warnings);
    assert.equal(action, "upgraded");
    assert.equal(readFileSync(join(configDir, "worker-prompt.md"), "utf-8"), SHIPPED_CANONICAL);
    assert.equal(readFileSync(join(configDir, "worker-prompt.local.md"), "utf-8"), userLocal);
  } finally {
    cleanup();
  }
});

test("SPLIT_BASE_NAMES: contains exactly the three prompt files (regression guard)", () => {
  assert.deepEqual(
    [...SPLIT_BASE_NAMES],
    ["worker-prompt.md", "review-prompt.md", "AFK_WORKER_RULES.md"],
  );
});

// Integration smoke: end-to-end initProject in a fresh scratch project root.
// Exercises the actual templates shipped under config-templates/, the splitBase
// routing, and idempotency of a second invocation.
test("initProject: fresh project — installs all 6 split files (canonical + .local.md for each)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {}; // silence init's stdout chatter for test output
  try {
    initProject(scratch);
    for (const base of SPLIT_BASE_NAMES) {
      const local = base.replace(/\.md$/, ".local.md");
      assert.ok(
        existsSync(join(scratch, ".dangeresque", base)),
        `expected canonical .dangeresque/${base}`,
      );
      assert.ok(
        existsSync(join(scratch, ".dangeresque", local)),
        `expected local stub .dangeresque/${local}`,
      );
    }
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: second invocation is idempotent (canonical refreshed, local preserved, no warnings)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    initProject(scratch);
    // User edits worker-prompt.local.md
    const userLocalPath = join(scratch, ".dangeresque", "worker-prompt.local.md");
    const userLocalContent = "# my project additions\n- always run with --strict\n";
    writeFileSync(userLocalPath, userLocalContent);

    // Second init — should refresh canonical (no-op since identical) and leave local alone
    initProject(scratch);

    assert.equal(
      readFileSync(userLocalPath, "utf-8"),
      userLocalContent,
      "user-edited local must survive a second init",
    );
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: writes DANGERESQUE.md byte-identical to BRIEF_MARKDOWN on every run", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    initProject(scratch);
    const danger = join(scratch, ".dangeresque", "DANGERESQUE.md");
    assert.ok(existsSync(danger), "DANGERESQUE.md must be written");
    assert.equal(readFileSync(danger, "utf-8"), BRIEF_MARKDOWN);

    // Second init — overwrites byte-identical.
    writeFileSync(danger, "TAMPERED\n");
    initProject(scratch);
    assert.equal(
      readFileSync(danger, "utf-8"),
      BRIEF_MARKDOWN,
      "second init must overwrite tampered DANGERESQUE.md back to BRIEF_MARKDOWN",
    );
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: no CLAUDE.md anywhere — creates minimal project-root CLAUDE.md with pointer block", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    initProject(scratch);
    const rootClaude = join(scratch, "CLAUDE.md");
    assert.ok(existsSync(rootClaude), "CLAUDE.md must be auto-created at project root");
    const content = readFileSync(rootClaude, "utf-8");
    assert.ok(content.includes(POINTER_ANCHOR), "CLAUDE.md must contain POINTER_ANCHOR");
    assert.ok(content.includes("# Project Rules"), "CLAUDE.md must contain placeholder heading");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: root CLAUDE.md with pointer — silent pass, file untouched", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    const rootClaude = join(scratch, "CLAUDE.md");
    const existing = `${POINTER_BLOCK}\n# My Project\n\nCustom content.\n`;
    writeFileSync(rootClaude, existing);
    initProject(scratch);
    assert.equal(
      readFileSync(rootClaude, "utf-8"),
      existing,
      "existing CLAUDE.md with pointer must not be modified",
    );
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: pointer in .claude/CLAUDE.md satisfies the check (no root CLAUDE.md created)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    const claudeDir = join(scratch, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const nestedClaude = join(claudeDir, "CLAUDE.md");
    writeFileSync(nestedClaude, POINTER_BLOCK);

    initProject(scratch);

    assert.equal(
      existsSync(join(scratch, "CLAUDE.md")),
      false,
      "root CLAUDE.md must NOT be auto-created when pointer is in .claude/CLAUDE.md",
    );
    assert.ok(readFileSync(nestedClaude, "utf-8").includes(POINTER_ANCHOR));
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: CLAUDE.md exists but missing pointer — prepends pointer block, preserves body", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  const rootClaude = join(scratch, "CLAUDE.md");
  const existing = "# My project\n\nNo pointer here.\n";
  writeFileSync(rootClaude, existing);
  try {
    initProject(scratch);
    const after = readFileSync(rootClaude, "utf-8");
    assert.ok(
      after.startsWith("<!-- DANGERESQUE-START -->"),
      "pointer must be prepended to top of file",
    );
    assert.ok(after.includes(existing), "original body must be preserved verbatim");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: stale pointer block in CLAUDE.md is refreshed via regex on re-run", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  const rootClaude = join(scratch, "CLAUDE.md");
  const stale =
    "<!-- DANGERESQUE-START -->\nold stale brief text\n<!-- DANGERESQUE-END -->\n# My project\n";
  writeFileSync(rootClaude, stale);
  try {
    initProject(scratch);
    const after = readFileSync(rootClaude, "utf-8");
    assert.ok(!after.includes("old stale brief text"), "stale text must be replaced");
    assert.ok(after.includes("dangeresque brief"), "current pointer text must be present");
    assert.ok(after.includes("# My project"), "body after pointer must be preserved");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: engine=claude does NOT touch pre-existing AGENTS.md", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  const agents = join(scratch, "AGENTS.md");
  const agentsBefore = "# Codex agent rules\n\nNo pointer here.\n";
  writeFileSync(agents, agentsBefore);
  try {
    initProject(scratch);
    assert.equal(
      readFileSync(agents, "utf-8"),
      agentsBefore,
      "AGENTS.md must be left untouched when engine is claude",
    );
    const claude = readFileSync(join(scratch, "CLAUDE.md"), "utf-8");
    assert.ok(
      claude.startsWith("<!-- DANGERESQUE-START -->"),
      "claude engine must bootstrap CLAUDE.md when no claude file existed",
    );
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: bootstraps AGENTS.md when engine=codex and no agent rules file exists", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  // Pre-seed config.json with engine=codex so init's pointer step picks AGENTS.md.
  const configDir = join(scratch, ".dangeresque");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ engine: "codex" }, null, 2),
  );
  try {
    initProject(scratch);
    const agents = join(scratch, "AGENTS.md");
    assert.ok(existsSync(agents), "AGENTS.md must be bootstrapped for codex engine");
    assert.ok(
      readFileSync(agents, "utf-8").startsWith("<!-- DANGERESQUE-START -->"),
      "AGENTS.md must lead with pointer",
    );
    assert.ok(
      !existsSync(join(scratch, "CLAUDE.md")),
      "CLAUDE.md must NOT be created when engine=codex",
    );
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: adds .dangeresque/sessions/ to .gitignore alongside runs/", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    initProject(scratch);
    const lines = readFileSync(join(scratch, ".gitignore"), "utf-8")
      .split("\n")
      .map((l) => l.trim());
    assert.ok(lines.includes(".dangeresque/runs/"), "runs/ entry expected");
    assert.ok(lines.includes(".dangeresque/sessions/"), "sessions/ entry expected");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: adds .dangeresque/runs/ to .gitignore on a fresh project", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    initProject(scratch);
    const gitignorePath = join(scratch, ".gitignore");
    assert.ok(existsSync(gitignorePath), ".gitignore must be created");
    const lines = readFileSync(gitignorePath, "utf-8").split("\n").map((l) => l.trim());
    assert.ok(
      lines.includes(".dangeresque/runs/"),
      "expected .dangeresque/runs/ in .gitignore",
    );
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: appends runs/ entry to existing .gitignore without losing prior entries", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    const gitignorePath = join(scratch, ".gitignore");
    writeFileSync(gitignorePath, "node_modules/\n# my comment\nbuild/\n");
    initProject(scratch);
    const lines = readFileSync(gitignorePath, "utf-8").split("\n").map((l) => l.trim());
    assert.ok(lines.includes("node_modules/"), "pre-existing entry preserved");
    assert.ok(lines.includes("build/"), "pre-existing entry preserved");
    assert.ok(lines.includes("# my comment"), "pre-existing comment preserved");
    assert.ok(lines.includes(".dangeresque/runs/"), "runs/ entry appended");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: idempotent — second run does not duplicate runs/ entry", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    initProject(scratch);
    initProject(scratch);
    const lines = readFileSync(join(scratch, ".gitignore"), "utf-8")
      .split("\n")
      .map((l) => l.trim());
    const occurrences = lines.filter((l) => l === ".dangeresque/runs/").length;
    assert.equal(occurrences, 1, "runs/ entry must appear exactly once");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: recognizes equivalent runs entry (.dangeresque/runs without trailing slash)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    writeFileSync(join(scratch, ".gitignore"), ".dangeresque/runs\n");
    initProject(scratch);
    const lines = readFileSync(join(scratch, ".gitignore"), "utf-8")
      .split("\n")
      .map((l) => l.trim());
    // Should not append a duplicate variant.
    assert.equal(
      lines.filter((l) => l === ".dangeresque/runs/").length,
      0,
      "trailing-slash variant not added when bare entry already present",
    );
    assert.ok(
      lines.includes(".dangeresque/runs"),
      "pre-existing bare entry preserved",
    );
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: second invocation does not duplicate pointer blocks in CLAUDE.md", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-smoke-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    initProject(scratch);
    const rootClaude = join(scratch, "CLAUDE.md");
    const firstContent = readFileSync(rootClaude, "utf-8");
    initProject(scratch);
    const secondContent = readFileSync(rootClaude, "utf-8");
    assert.equal(firstContent, secondContent, "second init must leave CLAUDE.md untouched");
    const occurrences = secondContent.split(POINTER_ANCHOR).length - 1;
    assert.equal(occurrences, 1, "pointer anchor must appear exactly once");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- mergeClaudeHookSettings: pure function tests ----------------------------

const TEMPLATE_HOOKS = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Write|Edit|NotebookEdit",
        hooks: [{ type: "command", command: "echo dangeresque preToolUse" }],
      },
    ],
    Notification: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "echo dangeresque notify" }],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [{ type: "command", command: "echo dangeresque end" }],
      },
    ],
  },
};

test("mergeClaudeHookSettings: empty existing — installs all template events", () => {
  const merged = mergeClaudeHookSettings({}, TEMPLATE_HOOKS);
  assert.deepEqual(
    Object.keys(merged.hooks!).sort(),
    ["Notification", "PreToolUse", "SessionEnd"],
  );
  assert.equal(merged.hooks!.PreToolUse.length, 1);
  assert.equal(merged.hooks!.PreToolUse[0].matcher, "Write|Edit|NotebookEdit");
});

test("mergeClaudeHookSettings: idempotent — re-applying the template yields a stable result", () => {
  const once = mergeClaudeHookSettings({}, TEMPLATE_HOOKS);
  const twice = mergeClaudeHookSettings(once, TEMPLATE_HOOKS);
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test("mergeClaudeHookSettings: replaces stale dangeresque-managed handlers per-event", () => {
  const stale = {
    hooks: {
      Notification: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "echo dangeresque OLD VERSION" }],
        },
      ],
    },
  };
  const merged = mergeClaudeHookSettings(stale, TEMPLATE_HOOKS);
  assert.equal(merged.hooks!.Notification.length, 1, "stale dangeresque handler replaced");
  assert.equal(
    merged.hooks!.Notification[0].hooks![0].command,
    "echo dangeresque notify",
  );
  assert.ok(merged.hooks!.PreToolUse, "new template event added");
  assert.ok(merged.hooks!.SessionEnd, "new template event added");
});

test("mergeClaudeHookSettings: preserves user-added handlers in same event", () => {
  const userAdded = {
    hooks: {
      Notification: [
        {
          matcher: "MyTool",
          hooks: [{ type: "command", command: "echo my-custom-hook" }],
        },
        {
          matcher: "",
          hooks: [{ type: "command", command: "echo dangeresque old-notify" }],
        },
      ],
    },
  };
  const merged = mergeClaudeHookSettings(userAdded, TEMPLATE_HOOKS);
  assert.equal(merged.hooks!.Notification.length, 2);
  const userHandler = merged.hooks!.Notification.find(
    (h) => h.hooks?.[0]?.command === "echo my-custom-hook",
  );
  const dangeresqueHandler = merged.hooks!.Notification.find(
    (h) => h.hooks?.[0]?.command === "echo dangeresque notify",
  );
  assert.ok(userHandler, "user handler preserved");
  assert.ok(dangeresqueHandler, "dangeresque handler refreshed to current template");
});

test("mergeClaudeHookSettings: preserves non-hook keys in existing settings", () => {
  const existing = {
    permissions: { allow: ["Bash(ls)"] },
    hooks: {},
  };
  const merged = mergeClaudeHookSettings(existing, TEMPLATE_HOOKS);
  assert.deepEqual(merged.permissions, { allow: ["Bash(ls)"] });
});

// --- initProject: settings.json upgrade path --------------------------------

test("initProject: existing settings.json with notification hooks gets PreToolUse on re-init", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-upgrade-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    const claudeDir = join(scratch, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const oldSettings = {
      hooks: {
        Notification: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "echo dangeresque old-notify" },
            ],
          },
        ],
        SessionEnd: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "echo dangeresque old-end" },
            ],
          },
        ],
      },
    };
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(oldSettings, null, 4) + "\n",
    );

    initProject(scratch);

    const after = JSON.parse(
      readFileSync(join(claudeDir, "settings.json"), "utf-8"),
    );
    assert.ok(after.hooks?.PreToolUse, "PreToolUse must be added on re-init");
    assert.equal(after.hooks.PreToolUse[0].matcher, "Write|Edit|NotebookEdit");
    assert.ok(after.hooks.Notification, "Notification must remain");
    assert.ok(after.hooks.SessionEnd, "SessionEnd must remain");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("initProject: preserves user-added handlers alongside dangeresque hooks", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-init-userhook-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    const claudeDir = join(scratch, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const userSettings = {
      hooks: {
        Notification: [
          {
            matcher: "MyTool",
            hooks: [{ type: "command", command: "echo my-custom-hook" }],
          },
        ],
      },
    };
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify(userSettings, null, 4) + "\n",
    );

    initProject(scratch);

    const after = JSON.parse(
      readFileSync(join(claudeDir, "settings.json"), "utf-8"),
    );
    const userPreserved = after.hooks.Notification.some(
      (h: { hooks?: { command?: string }[] }) =>
        h.hooks?.[0]?.command === "echo my-custom-hook",
    );
    assert.ok(userPreserved, "user-added Notification handler must survive init");
    assert.ok(after.hooks.PreToolUse, "PreToolUse fence must be installed");
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
});

// --- PreToolUse hook command: shell-level integration ----------------------

function getPreToolUseHookCommand(): string {
  const scratch = mkdtempSync(join(tmpdir(), "dangeresque-hook-extract-"));
  const origLog = console.log;
  console.log = () => {};
  try {
    initProject(scratch);
    const settings = JSON.parse(
      readFileSync(join(scratch, ".claude", "settings.json"), "utf-8"),
    );
    return settings.hooks.PreToolUse[0].hooks[0].command;
  } finally {
    console.log = origLog;
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runPreToolUseHook(input: object): {
  status: number;
  stderr: string;
} {
  const cmd = getPreToolUseHookCommand();
  const result = spawnSync("bash", ["-c", cmd], {
    input: JSON.stringify(input),
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

test("PreToolUse hook: rejects Write to path outside dangeresque worktree (exit 2)", () => {
  const cwd = "/tmp/dangeresque-fake-worktree-001";
  const fp = "/etc/poisoned.test.ts";
  const result = runPreToolUseHook({
    cwd,
    tool_name: "Write",
    tool_input: { file_path: fp },
  });
  assert.equal(result.status, 2, "must exit 2 to block tool call");
  assert.match(result.stderr, /refusing Write/, "stderr names the tool");
  assert.match(result.stderr, /\/etc\/poisoned\.test\.ts/, "stderr names the offending path");
  assert.match(result.stderr, /dangeresque-fake-worktree-001/, "stderr names the worktree");
});

test("PreToolUse hook: allows Write to path inside worktree (exit 0)", () => {
  const cwd = "/tmp/dangeresque-fake-worktree-002";
  const result = runPreToolUseHook({
    cwd,
    tool_name: "Write",
    tool_input: { file_path: `${cwd}/src/feature.ts` },
  });
  assert.equal(result.status, 0, "must exit 0 to allow");
  assert.equal(result.stderr, "");
});

test("PreToolUse hook: allows Write to .dangeresque/runs/ artifact path inside worktree", () => {
  const cwd = "/tmp/dangeresque-fake-worktree-003";
  const result = runPreToolUseHook({
    cwd,
    tool_name: "Write",
    tool_input: {
      file_path: `${cwd}/.dangeresque/runs/issue-78/2026-05-09T22-IMPLEMENT.md`,
    },
  });
  assert.equal(result.status, 0);
});

test("PreToolUse hook: no-op for non-dangeresque cwd basename", () => {
  // Interactive operator session at the project root — basename does NOT start
  // with dangeresque-. Hook must be a complete no-op for them.
  const cwd = "/Users/dev/myproject";
  const result = runPreToolUseHook({
    cwd,
    tool_name: "Write",
    tool_input: { file_path: "/anywhere/else.ts" },
  });
  assert.equal(result.status, 0, "non-dangeresque cwd must be unfenced");
  assert.equal(result.stderr, "");
});

test("PreToolUse hook: rejects NotebookEdit to notebook_path outside worktree", () => {
  const cwd = "/tmp/dangeresque-fake-worktree-004";
  const result = runPreToolUseHook({
    cwd,
    tool_name: "NotebookEdit",
    tool_input: {
      notebook_path: "/etc/poisoned.ipynb",
      cell_id: "x",
      new_source: "print('hi')",
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing NotebookEdit/);
  assert.match(result.stderr, /poisoned\.ipynb/);
});

test("PreToolUse hook: rejects Edit to file_path outside worktree", () => {
  const cwd = "/tmp/dangeresque-fake-worktree-005";
  const result = runPreToolUseHook({
    cwd,
    tool_name: "Edit",
    tool_input: { file_path: "/etc/passwd", old_string: "x", new_string: "y" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing Edit/);
});

test("PreToolUse hook: allows tool call with no file_path (malformed input passes through)", () => {
  const cwd = "/tmp/dangeresque-fake-worktree-006";
  const result = runPreToolUseHook({
    cwd,
    tool_name: "Write",
    tool_input: {}, // neither file_path nor notebook_path
  });
  assert.equal(result.status, 0);
});
