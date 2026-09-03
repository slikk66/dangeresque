import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { usageForEngine } from "#dist/usage.js";

const projectRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const cliSourcePath = join(projectRoot, "src", "cli.ts");

function dispatchCases(): string[] {
  const source = readFileSync(cliSourcePath, "utf-8");
  // Extract every `case "<verb>":` from the dispatch switch in main() — and
  // ONLY that switch. cli.ts has other switches (e.g. rebase-outcome
  // classification), whose cases are not CLI verbs and must not be required
  // to appear in --help.
  const start = source.indexOf("switch (command) {");
  assert.notEqual(start, -1, "could not find the dispatch switch in src/cli.ts");
  const end = source.indexOf("\n  }", start);
  assert.notEqual(end, -1, "could not find the end of the dispatch switch");
  const dispatchBlock = source.slice(start, end);
  // The switch values are short alphanumeric verb names (no quotes or escapes inside).
  const matches = [...dispatchBlock.matchAll(/case "([a-z][a-z0-9_-]*)":/g)];
  return matches.map((m) => m[1]);
}

test("dispatchCases extracts every verb from the cli.ts switch", () => {
  const cases = dispatchCases();
  assert.ok(cases.length > 0, "expected at least one case in src/cli.ts");
  for (const required of ["run", "merge", "discard", "stop"]) {
    assert.ok(
      cases.includes(required),
      `sanity check: dispatch should contain "${required}"`,
    );
  }
});

for (const engine of ["claude", "codex"] as const) {
  test(`every CLI dispatch case appears in usageForEngine("${engine}") output`, () => {
    const help = usageForEngine(engine);
    const missing = dispatchCases().filter((verb) => !help.includes(verb));
    assert.deepEqual(
      missing,
      [],
      `dispatch verbs missing from --help (${engine}): ${missing.join(", ")}`,
    );
  });
}

test("help distinguishes the two crash-recovery verbs by which phase died", () => {
  // `review` and `resume` are mutually exclusive and an operator staring at a
  // dead run has to pick correctly from --help alone (issue #110).
  const help = usageForEngine("claude");
  assert.match(help, /resume <branch> \[options\]/);
  assert.match(help, /keeps the uncommitted diff and continues it/);
  assert.match(help, /refuses a worker that finished \(that is 'review'\)/);

  const resumeOptions = help.slice(help.indexOf("Resume options"));
  assert.match(resumeOptions, /--dry-run/);
  assert.match(resumeOptions, /--force/);
  assert.match(resumeOptions, /--engine <name>/);
  assert.match(resumeOptions, /--review-engine <name>/);
  assert.match(resumeOptions, /--issue <N> \/ --mode <MODE>/);
  assert.match(resumeOptions, /no rebase, no\s+stash, no reset/);
  assert.match(resumeOptions, /Never waives resume eligibility itself/);
  assert.match(help, /dangeresque resume worktree-dangeresque-implement-63/);
});

test("Codex help documents native worker/review effort and GPT-5.5 limits", () => {
  const help = usageForEngine("codex");
  assert.match(help, /--effort <level>/);
  assert.match(help, /--review-effort <level>/);
  assert.match(help, /--review-engine <name>/);
  assert.match(help, /DANGERESQUE_REVIEW_ENGINE/);
  assert.match(help, /engineDefaults/);
  assert.match(help, /gpt-5\.5/);
  assert.match(help, /xhigh/);
  assert.match(help, /max.*unsupported|does not support.*max/i);
});
