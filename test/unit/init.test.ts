import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyWithLocalOverlay, initProject, SPLIT_BASE_NAMES } from "#dist/init.js";

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
