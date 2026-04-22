import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowBash,
  allowMcp,
  parseMcpListOutput,
} from "#dist/allow.js";
import { CONFIG_DIR } from "#dist/config.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "dangeresque-allow-test-"));
}

function writeConfig(projectRoot: string, body: object): string {
  mkdirSync(join(projectRoot, CONFIG_DIR), { recursive: true });
  const path = join(projectRoot, CONFIG_DIR, "config.json");
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
  return path;
}

test("allowBash: adds Bash(...) wrapper once and is idempotent", () => {
  const tmp = makeTmp();
  try {
    const configPath = writeConfig(tmp, { allowedTools: ["Read", "Edit"] });

    const first = allowBash(tmp, { pattern: "npm install *" });
    assert.deepEqual(first.added, ["Bash(npm install *)"]);
    assert.deepEqual(first.skipped, []);
    assert.equal(first.totalAllowedTools, 3);
    assert.equal(first.configCreated, false);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(written.allowedTools, ["Read", "Edit", "Bash(npm install *)"]);

    const second = allowBash(tmp, { pattern: "npm install *" });
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.skipped, ["Bash(npm install *)"]);
    assert.equal(second.totalAllowedTools, 3);

    const writtenAgain = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(writtenAgain.allowedTools, ["Read", "Edit", "Bash(npm install *)"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("allowBash: empty pattern throws", () => {
  const tmp = makeTmp();
  try {
    assert.throws(() => allowBash(tmp, { pattern: "   " }), /cannot be empty/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("allowBash: --dry-run does not write the file", () => {
  const tmp = makeTmp();
  try {
    const configPath = writeConfig(tmp, { allowedTools: ["Read"] });
    const result = allowBash(tmp, { pattern: "yarn build", dryRun: true });
    assert.deepEqual(result.added, ["Bash(yarn build)"]);
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(onDisk.allowedTools, ["Read"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("allowMcp: with explicit server adds mcp__<server> once", () => {
  const tmp = makeTmp();
  try {
    const configPath = writeConfig(tmp, { allowedTools: [] });
    const first = allowMcp(tmp, { server: "context7" });
    assert.deepEqual(first.added, ["mcp__context7"]);

    const second = allowMcp(tmp, { server: "context7" });
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.skipped, ["mcp__context7"]);

    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(onDisk.allowedTools, ["mcp__context7"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("allow: creates config.json when absent and not in dry-run", () => {
  const tmp = makeTmp();
  try {
    const configPath = join(tmp, CONFIG_DIR, "config.json");
    assert.equal(existsSync(configPath), false);
    const result = allowBash(tmp, { pattern: "yarn test" });
    assert.equal(result.configCreated, true);
    assert.equal(existsSync(configPath), true);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(written.allowedTools, ["Bash(yarn test)"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("allow: dry-run does not create config.json", () => {
  const tmp = makeTmp();
  try {
    const configPath = join(tmp, CONFIG_DIR, "config.json");
    const result = allowBash(tmp, { pattern: "yarn test", dryRun: true });
    assert.equal(result.configCreated, false);
    assert.equal(existsSync(configPath), false);
    assert.deepEqual(result.added, ["Bash(yarn test)"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("allow: preserves indent and trailing newline of existing config", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, CONFIG_DIR), { recursive: true });
    const configPath = join(tmp, CONFIG_DIR, "config.json");
    const original = '{\n    "allowedTools": [\n        "Read"\n    ]\n}\n';
    writeFileSync(configPath, original);
    allowBash(tmp, { pattern: "ls" });
    const written = readFileSync(configPath, "utf-8");
    assert.ok(written.endsWith("\n"), "trailing newline preserved");
    assert.ok(/\n {4}"allowedTools"/.test(written), "4-space indent preserved");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseMcpListOutput: JSON array of strings", () => {
  assert.deepEqual(parseMcpListOutput('["context7", "linear"]'), ["context7", "linear"]);
});

test("parseMcpListOutput: JSON array of {name} objects", () => {
  const json = JSON.stringify([{ name: "context7" }, { name: "linear", url: "x" }]);
  assert.deepEqual(parseMcpListOutput(json), ["context7", "linear"]);
});

test("parseMcpListOutput: JSON object map (server name → meta)", () => {
  const json = JSON.stringify({ context7: { url: "x" }, linear: { url: "y" } });
  assert.deepEqual(parseMcpListOutput(json), ["context7", "linear"]);
});

test("parseMcpListOutput: {servers: [...]} envelope", () => {
  const json = JSON.stringify({ servers: [{ name: "context7" }, "linear"] });
  assert.deepEqual(parseMcpListOutput(json), ["context7", "linear"]);
});

test("parseMcpListOutput: text format 'name: url'", () => {
  const text = "context7: https://api.example.com\nlinear: https://api.linear.app\n";
  assert.deepEqual(parseMcpListOutput(text), ["context7", "linear"]);
});

test("parseMcpListOutput: text 'No MCP servers configured' returns empty", () => {
  assert.deepEqual(parseMcpListOutput("No MCP servers configured.\n"), []);
});

test("parseMcpListOutput: empty input returns empty", () => {
  assert.deepEqual(parseMcpListOutput(""), []);
  assert.deepEqual(parseMcpListOutput("   \n"), []);
});

test("parseMcpListOutput: skips 'Checking...' header", () => {
  const text = "Checking MCP server health...\ncontext7: ok\n";
  assert.deepEqual(parseMcpListOutput(text), ["context7"]);
});
