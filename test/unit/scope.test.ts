import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseScopeBlocks,
  parseScopeDeclaration,
  classifyChanges,
  matchesGlob,
} from "#dist/scope.js";

test("parseScopeBlocks: single block, allow + deny", () => {
  const text = [
    "Some prose before",
    "",
    "```dangeresque-scope",
    "allow:",
    "  - src/scope.ts",
    "  - test/unit/scope.test.ts",
    "deny:",
    "  - .github/**",
    "```",
    "trailer",
  ].join("\n");
  const block = parseScopeBlocks(text);
  assert.deepEqual(block.allow, ["src/scope.ts", "test/unit/scope.test.ts"]);
  assert.deepEqual(block.deny, [".github/**"]);
  assert.deepEqual(block.diagnostics, []);
});

test("parseScopeBlocks: no block → empty allow + deny + diagnostics", () => {
  const block = parseScopeBlocks("just markdown, no fenced block");
  assert.deepEqual(block.allow, []);
  assert.deepEqual(block.deny, []);
  assert.deepEqual(block.diagnostics, []);
});

test("parseScopeBlocks: multi-block union", () => {
  const text = [
    "```dangeresque-scope",
    "allow:",
    "  - src/a.ts",
    "```",
    "",
    "Then a staged comment with another block:",
    "",
    "```dangeresque-scope",
    "allow:",
    "  - src/b.ts",
    "deny:",
    "  - infra/**",
    "```",
  ].join("\n");
  const block = parseScopeBlocks(text);
  assert.deepEqual(block.allow.sort(), ["src/a.ts", "src/b.ts"].sort());
  assert.deepEqual(block.deny, ["infra/**"]);
});

test("parseScopeBlocks: deny wins on conflict between blocks", () => {
  const text = [
    "```dangeresque-scope",
    "allow:",
    "  - src/danger.ts",
    "```",
    "",
    "```dangeresque-scope",
    "deny:",
    "  - src/danger.ts",
    "```",
  ].join("\n");
  const block = parseScopeBlocks(text);
  assert.deepEqual(block.allow, []);
  assert.deepEqual(block.deny, ["src/danger.ts"]);
});

test("parseScopeBlocks: comments + blank lines tolerated", () => {
  const text = [
    "```dangeresque-scope",
    "# top-level comment",
    "allow:",
    "",
    "  - src/a.ts",
    "  # inline-style comment line",
    "  - src/b.ts",
    "",
    "deny:",
    "  - .github/**",
    "```",
  ].join("\n");
  const block = parseScopeBlocks(text);
  assert.deepEqual(block.allow, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(block.deny, [".github/**"]);
  assert.deepEqual(block.diagnostics, []);
});

test("parseScopeBlocks: malformed block returns diagnostics, does not throw", () => {
  const text = [
    "```dangeresque-scope",
    "  - src/orphan.ts",
    "garbage line",
    "allow:",
    "  - src/ok.ts",
    "```",
  ].join("\n");
  const block = parseScopeBlocks(text);
  assert.deepEqual(block.allow, ["src/ok.ts"]);
  assert.equal(block.deny.length, 0);
  assert.ok(block.diagnostics.length >= 2, "expected at least 2 diagnostics");
  assert.ok(
    block.diagnostics.some((d) => d.includes("list item before allow:/deny:")),
    "orphan list item should produce a diagnostic",
  );
  assert.ok(
    block.diagnostics.some((d) => d.includes("unrecognized line")),
    "garbage line should produce a diagnostic",
  );
});

test("parseScopeBlocks: dedupes within a list", () => {
  const text = [
    "```dangeresque-scope",
    "allow:",
    "  - src/a.ts",
    "  - src/a.ts",
    "  - src/b.ts",
    "```",
  ].join("\n");
  const block = parseScopeBlocks(text);
  assert.deepEqual(block.allow, ["src/a.ts", "src/b.ts"]);
});

test("parseScopeBlocks: strips optional surrounding quotes", () => {
  const text = [
    "```dangeresque-scope",
    "allow:",
    '  - "src/with space.ts"',
    "  - 'src/quoted.ts'",
    "```",
  ].join("\n");
  const block = parseScopeBlocks(text);
  assert.deepEqual(block.allow, ["src/with space.ts", "src/quoted.ts"]);
});

test("parseScopeDeclaration: empty input → []", () => {
  assert.deepEqual(parseScopeDeclaration(""), []);
});

test("parseScopeDeclaration: missing section → []", () => {
  assert.deepEqual(
    parseScopeDeclaration("# Run\n\n## Status\n\ndone\n"),
    [],
  );
});

test("parseScopeDeclaration: parses bullet list with category + rationale", () => {
  const md = [
    "# Run",
    "",
    "## Scope Declaration",
    "",
    "- `src/scope.ts` (declared) — implements parser",
    "- `src/cli.ts` (extension) — wire the new helper",
    "- `yarn.lock` (incidental) — auto-touched",
    "- `tools/extra.ts` (opportunistic) — drive-by typo fix",
    "",
    "## Next",
    "",
    "- `src/elsewhere.ts` (declared) — should be ignored, outside section",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.deepEqual(decl, [
    {
      path: "src/scope.ts",
      rationale: "implements parser",
      category: "declared",
    },
    {
      path: "src/cli.ts",
      rationale: "wire the new helper",
      category: "extension",
    },
    { path: "yarn.lock", rationale: "auto-touched", category: "incidental" },
    {
      path: "tools/extra.ts",
      rationale: "drive-by typo fix",
      category: "opportunistic",
    },
  ]);
});

test("parseScopeDeclaration: skips lines with unknown category", () => {
  const md = [
    "## Scope Declaration",
    "",
    "- `src/a.ts` (bogus) — wrong category",
    "- `src/b.ts` (declared) — fine",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.equal(decl.length, 1);
  assert.equal(decl[0].path, "src/b.ts");
});

test("parseScopeDeclaration: parses markdown table form", () => {
  const md = [
    "## Scope Declaration",
    "",
    "| Path | Category | Rationale |",
    "|---|---|---|",
    "| `src/scope.ts` | declared | implements parser |",
    "| `src/cli.ts` | extension | wire the new helper |",
    "| yarn.lock | incidental | auto-touched |",
    "| `tools/extra.ts` | opportunistic | drive-by typo fix |",
    "",
    "## Next",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.deepEqual(decl, [
    {
      path: "src/scope.ts",
      rationale: "implements parser",
      category: "declared",
    },
    {
      path: "src/cli.ts",
      rationale: "wire the new helper",
      category: "extension",
    },
    { path: "yarn.lock", rationale: "auto-touched", category: "incidental" },
    {
      path: "tools/extra.ts",
      rationale: "drive-by typo fix",
      category: "opportunistic",
    },
  ]);
});

test("parseScopeDeclaration: table header + separator rows are skipped", () => {
  const md = [
    "## Scope Declaration",
    "",
    "| Path | Category | Rationale |",
    "|---|---|---|",
    "| `src/a.ts` | declared | only real entry |",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.equal(decl.length, 1);
  assert.equal(decl[0].path, "src/a.ts");
});

test("parseScopeDeclaration: mixed bullet + table form within same section", () => {
  const md = [
    "## Scope Declaration",
    "",
    "- `src/bullet.ts` (declared) — bullet entry",
    "",
    "| Path | Category | Rationale |",
    "|---|---|---|",
    "| `src/table.ts` | extension | table entry |",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.deepEqual(decl, [
    {
      path: "src/bullet.ts",
      rationale: "bullet entry",
      category: "declared",
    },
    {
      path: "src/table.ts",
      rationale: "table entry",
      category: "extension",
    },
  ]);
});

test("parseScopeDeclaration: table row with unknown category is skipped", () => {
  const md = [
    "## Scope Declaration",
    "",
    "| `src/a.ts` | bogus | wrong category |",
    "| `src/b.ts` | declared | fine |",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.equal(decl.length, 1);
  assert.equal(decl[0].path, "src/b.ts");
});

test("classifyChanges: allow-only block", () => {
  const block = parseScopeBlocks(
    [
      "```dangeresque-scope",
      "allow:",
      "  - src/**",
      "  - test/**",
      "```",
    ].join("\n"),
  );
  const report = classifyChanges({
    changedFiles: ["src/a.ts", "test/foo.test.ts", "infra/cf.yaml"],
    block,
    declaration: [],
  });
  assert.deepEqual(report.in_scope.sort(), ["src/a.ts", "test/foo.test.ts"]);
  assert.deepEqual(report.outside, ["infra/cf.yaml"]);
  assert.deepEqual(report.extended, []);
});

test("classifyChanges: deny overrides allow", () => {
  const block = parseScopeBlocks(
    [
      "```dangeresque-scope",
      "allow:",
      "  - src/**",
      "deny:",
      "  - src/secrets.ts",
      "```",
    ].join("\n"),
  );
  const report = classifyChanges({
    changedFiles: ["src/secrets.ts", "src/ok.ts"],
    block,
    declaration: [],
  });
  assert.deepEqual(report.in_scope, ["src/ok.ts"]);
  assert.deepEqual(report.outside, ["src/secrets.ts"]);
});

test("classifyChanges: declaration promotes file to extended", () => {
  const block = parseScopeBlocks(
    ["```dangeresque-scope", "allow:", "  - src/**", "```"].join("\n"),
  );
  const report = classifyChanges({
    changedFiles: ["src/a.ts", "tools/helper.ts"],
    block,
    declaration: [
      {
        path: "tools/helper.ts",
        rationale: "needed for primary task",
        category: "extension",
      },
    ],
  });
  assert.deepEqual(report.in_scope, ["src/a.ts"]);
  assert.deepEqual(report.outside, []);
  assert.deepEqual(report.extended, [
    {
      path: "tools/helper.ts",
      rationale: "needed for primary task",
      category: "extension",
    },
  ]);
});

test("classifyChanges: opportunistic declaration goes to extended", () => {
  const report = classifyChanges({
    changedFiles: ["docs/typo-fix.md"],
    block: { allow: [], deny: [], diagnostics: [] },
    declaration: [
      {
        path: "docs/typo-fix.md",
        rationale: "drive-by typo",
        category: "opportunistic",
      },
    ],
  });
  assert.deepEqual(report.extended, [
    {
      path: "docs/typo-fix.md",
      rationale: "drive-by typo",
      category: "opportunistic",
    },
  ]);
  assert.deepEqual(report.outside, []);
});

test("classifyChanges: incidental + declared declarations land in_scope", () => {
  const report = classifyChanges({
    changedFiles: ["yarn.lock", "src/inferred.ts"],
    block: { allow: [], deny: [], diagnostics: [] },
    declaration: [
      { path: "yarn.lock", rationale: "auto", category: "incidental" },
      { path: "src/inferred.ts", rationale: "inferred", category: "declared" },
    ],
  });
  assert.deepEqual(report.in_scope.sort(), [
    "src/inferred.ts",
    "yarn.lock",
  ]);
  assert.deepEqual(report.extended, []);
  assert.deepEqual(report.outside, []);
});

test("classifyChanges: file with no glob match and no declaration → outside", () => {
  const report = classifyChanges({
    changedFiles: ["random/file.ts"],
    block: { allow: [], deny: [], diagnostics: [] },
    declaration: [],
  });
  assert.deepEqual(report.outside, ["random/file.ts"]);
});

test("classifyChanges: rename src + dest classified independently", () => {
  const block = parseScopeBlocks(
    [
      "```dangeresque-scope",
      "allow:",
      "  - src/new/**",
      "```",
    ].join("\n"),
  );
  const report = classifyChanges({
    changedFiles: ["src/old/Mod.ts", "src/new/Mod.ts"],
    block,
    declaration: [],
  });
  assert.deepEqual(report.in_scope, ["src/new/Mod.ts"]);
  assert.deepEqual(report.outside, ["src/old/Mod.ts"]);
});

test("matchesGlob: ** wildcard handles deep paths", () => {
  assert.equal(matchesGlob("src/foo/bar/baz.ts", "src/**"), true);
  assert.equal(matchesGlob("src/foo.ts", "src/**"), true);
  assert.equal(matchesGlob("test/foo.ts", "src/**"), false);
});

test("matchesGlob: * single segment", () => {
  assert.equal(matchesGlob("src/foo.ts", "src/*.ts"), true);
  assert.equal(matchesGlob("src/foo/bar.ts", "src/*.ts"), false);
});

test("matchesGlob: **/*.lock matches anywhere", () => {
  assert.equal(matchesGlob("yarn.lock", "**/*.lock"), true);
  assert.equal(matchesGlob("a/b/yarn.lock", "**/*.lock"), true);
  assert.equal(matchesGlob("yarn.lockfile", "**/*.lock"), false);
});

test("matchesGlob: literal path", () => {
  assert.equal(matchesGlob("src/scope.ts", "src/scope.ts"), true);
  assert.equal(matchesGlob("src/scope.tsx", "src/scope.ts"), false);
});
