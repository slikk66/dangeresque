import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadIssueFixture,
  computeRunArchivePath,
  formatIssueComments,
} from "#dist/runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..", "..");
const FIXTURES = join(PROJECT_ROOT, "test", "fixtures");
const INVALID_FIXTURES = join(FIXTURES, "issues");

test("loadIssueFixture: valid fixture returns correct shape", () => {
  const data = loadIssueFixture(join(FIXTURES, "example-issue.json"));
  assert.equal(data.number, 999);
  assert.equal(data.title, "Example fixture issue");
  assert.equal(typeof data.body, "string");
  assert.ok(Array.isArray(data.comments));
});

test("loadIssueFixture: non-existent path throws with 'Failed to read'", () => {
  assert.throws(
    () => loadIssueFixture("/tmp/definitely-not-real-xyz-zzzzz.json"),
    /Failed to read fixture file/,
  );
});

test("loadIssueFixture: invalid JSON throws with 'not valid JSON'", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dangeresque-test-"));
  const path = join(tmp, "bad.json");
  try {
    writeFileSync(path, "{ not json");
    assert.throws(() => loadIssueFixture(path), /not valid JSON/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("loadIssueFixture: missing number field throws", () => {
  assert.throws(
    () => loadIssueFixture(join(INVALID_FIXTURES, "missing-number.json")),
    /missing required field "number"/,
  );
});

test("loadIssueFixture: missing title field throws", () => {
  assert.throws(
    () => loadIssueFixture(join(INVALID_FIXTURES, "missing-title.json")),
    /missing required field "title"/,
  );
});

test("loadIssueFixture: comment without author.login throws", () => {
  assert.throws(
    () => loadIssueFixture(join(INVALID_FIXTURES, "bad-author.json")),
    /author\.login/,
  );
});

test("loadIssueFixture: top-level non-object throws", () => {
  assert.throws(
    () => loadIssueFixture(join(INVALID_FIXTURES, "not-an-object.json")),
    /must be a JSON object/,
  );
});

test("computeRunArchivePath: produces expected suffix shape", () => {
  const p = computeRunArchivePath("/tmp/wt", 63, "IMPLEMENT");
  assert.match(
    p,
    /^\/tmp\/wt\/\.dangeresque\/runs\/issue-63\/\d{4}-\d{2}-\d{2}T[\d-]+-IMPLEMENT\.md$/,
  );
});

test("formatIssueComments: empty comments → empty string", () => {
  const result = formatIssueComments({
    number: 1,
    title: "t",
    body: "b",
    comments: [],
  });
  assert.equal(result, "");
});

test("formatIssueComments: keeps staged + last-3 humans, drops dangeresque logs + minimized", () => {
  const result = formatIssueComments({
    number: 1,
    title: "t",
    body: "b",
    comments: [
      { body: "**[staged IMPLEMENT]** guidance text", author: { login: "alice" }, isMinimized: false },
      { body: "**[dangeresque IMPLEMENT]** auto log", author: { login: "bot" }, isMinimized: false },
      { body: "minimized note", author: { login: "alice" }, isMinimized: true },
      { body: "first human", author: { login: "bob" }, isMinimized: false },
      { body: "second human", author: { login: "bob" }, isMinimized: false },
      { body: "third human", author: { login: "bob" }, isMinimized: false },
      { body: "fourth human", author: { login: "bob" }, isMinimized: false },
    ],
  });

  assert.match(result, /## Context Comments/);
  assert.match(result, /staged IMPLEMENT/);
  assert.doesNotMatch(result, /dangeresque IMPLEMENT/);
  assert.doesNotMatch(result, /minimized note/);
  assert.doesNotMatch(result, /first human/);
  assert.match(result, /second human/);
  assert.match(result, /third human/);
  assert.match(result, /fourth human/);
});
