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
  // Extract every `case "<verb>":` from the dispatch switch in main().
  // The switch values are short alphanumeric verb names (no quotes or escapes inside).
  const matches = [...source.matchAll(/case "([a-z][a-z0-9_-]*)":/g)];
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
