import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseScopeBlocks,
  parseScopeDeclaration,
  parseScopeDeclarationSection,
  buildDeclarationResolver,
  classifyChanges,
  matchesGlob,
} from "#dist/scope.js";

const NO_BLOCK = { allow: [], deny: [], diagnostics: [] };

function declared(...paths: string[]) {
  return paths.map((path) => ({
    path,
    rationale: "declared by the worker",
    category: "declared" as const,
  }));
}

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

// ---------------------------------------------------------------------------
// Issue #90 — declaration matcher. This repo's own artifacts all score
// outside=0, so every shape below is modelled on a real bubble-craps run.
// ---------------------------------------------------------------------------

test("resolver: multi-root — sub-project-relative rows match repo-root git paths (bc#536)", () => {
  const changed = [
    "realbubblecraps.com-astro/infra/modules/appsync/index.ts",
    "realbubblecraps.com-astro/infra/modules/lambda-ssr/index.ts",
  ];
  const report = classifyChanges({
    changedFiles: changed,
    block: NO_BLOCK,
    declaration: declared(
      "infra/modules/appsync/index.ts",
      "infra/modules/lambda-ssr/index.ts",
    ),
  });
  assert.deepEqual(report.outside, []);
  assert.deepEqual(report.in_scope, changed);
});

test("resolver: two-prefix run — one worker spanning two sub-projects (bc#610)", () => {
  const changed = [
    "Bubble Craps/Assets/UI/PayoutAnnouncer.cs",
    "Bubble Craps/Assets/UI/BreakdownRowBinder.cs",
    "realbubblecraps.com-astro/src/pages/index.astro",
    "realbubblecraps.com-astro/src/lib/format.ts",
  ];
  const report = classifyChanges({
    changedFiles: changed,
    block: NO_BLOCK,
    declaration: declared(
      "UI/PayoutAnnouncer.cs",
      "UI/BreakdownRowBinder.cs",
      "src/pages/index.astro",
      "src/lib/format.ts",
    ),
  });
  assert.deepEqual(report.outside, [], "both sub-project prefixes must resolve");
  assert.equal(report.in_scope.length, 4);
});

test("resolver: a lone row may NOT cross a directory boundary on its own say-so", () => {
  const resolver = buildDeclarationResolver(
    ["sub/src/config.ts"],
    declared("src/config.ts"),
  );
  assert.equal(
    resolver.resolve("sub/src/config.ts"),
    undefined,
    "self-attestation must not license a prefix",
  );
});

test("resolver: two mutually-attesting rows DO license the shared prefix", () => {
  const resolver = buildDeclarationResolver(
    ["sub/src/config.ts", "sub/src/other.ts"],
    declared("src/config.ts", "src/other.ts"),
  );
  assert.equal(resolver.resolve("sub/src/config.ts")?.path, "src/config.ts");
  assert.equal(resolver.resolve("sub/src/other.ts")?.path, "src/other.ts");
});

test("resolver: prefix concatenation is exact, not fuzzy suffix", () => {
  const resolver = buildDeclarationResolver(
    ["vendor/notsrc/config.ts", "vendor/src/other.ts", "vendor/src/third.ts"],
    declared("src/config.ts", "src/other.ts", "src/third.ts"),
  );
  // `vendor/` is attested twice over, so every row may use it — but
  // `vendor/` + `src/config.ts` is still not `vendor/notsrc/config.ts`.
  assert.equal(resolver.resolve("vendor/notsrc/config.ts"), undefined);
  assert.equal(resolver.resolve("vendor/src/other.ts")?.path, "src/other.ts");
  assert.equal(resolver.resolve("vendor/src/third.ts")?.path, "src/third.ts");
});

test("resolver: leading ellipsis (bc#676)", () => {
  const file =
    "realbubblecraps.com-astro/infra/modules/lambda-match-orchestrator/src/config.ts";
  const resolver = buildDeclarationResolver(
    [file],
    declared(".../lambda-match-orchestrator/src/config.ts"),
  );
  assert.equal(resolver.resolve(file)?.category, "declared");
});

test("resolver: mid-string ellipsis (bc#539)", () => {
  const resolver = buildDeclarationResolver(
    ["docs/adr/0055-match-session-render-state.md"],
    declared("docs/adr/0055-...md"),
  );
  assert.equal(
    resolver.resolve("docs/adr/0055-match-session-render-state.md")?.path,
    "docs/adr/0055-...md",
  );
});

test("resolver: ellipsis stays anchored at the end the row did not elide", () => {
  const tailMiss = buildDeclarationResolver(
    ["docs/adr/0055-notes.mdx"],
    declared("docs/adr/0055-...md"),
  );
  assert.equal(tailMiss.resolve("docs/adr/0055-notes.mdx"), undefined);

  const headMiss = buildDeclarationResolver(
    ["sub/docs/adr/x.md"],
    declared("docs/...md"),
  );
  assert.equal(headMiss.resolve("sub/docs/adr/x.md"), undefined);

  const extMiss = buildDeclarationResolver(
    ["pkg/src/config.tsx"],
    declared(".../src/config.ts"),
  );
  assert.equal(extMiss.resolve("pkg/src/config.tsx"), undefined);
});

test("resolver: normalizes leading ./ and / on both sides", () => {
  const resolver = buildDeclarationResolver(
    ["./src/a.ts", "src/b.ts"],
    declared("src/a.ts", "/src/b.ts"),
  );
  assert.equal(resolver.resolve("./src/a.ts")?.path, "src/a.ts");
  assert.equal(resolver.resolve("src/b.ts")?.path, "/src/b.ts");
});

test("resolver: reverse ambiguity (the bc#534 Makefile) resolves toward in_scope", () => {
  const changed = [
    "Makefile",
    "realbubblecraps.com-astro/Makefile",
    "realbubblecraps.com-astro/src/a.ts",
  ];
  const resolver = buildDeclarationResolver(
    changed,
    declared("Makefile", "src/a.ts"),
  );
  assert.equal(resolver.resolve("Makefile")?.path, "Makefile");
  assert.equal(
    resolver.resolve("realbubblecraps.com-astro/Makefile")?.path,
    "Makefile",
  );
  assert.ok(
    resolver.diagnostics.some(
      (d) => d.includes("Makefile") && d.includes("absorbed 2"),
    ),
    `expected a reverse-collision diagnostic, got ${JSON.stringify(resolver.diagnostics)}`,
  );

  const report = classifyChanges({
    changedFiles: changed,
    block: NO_BLOCK,
    declaration: declared("Makefile", "src/a.ts"),
  });
  assert.deepEqual(report.outside, []);
  assert.ok(report.diagnostics && report.diagnostics.length > 0);
});

test("resolver: forward ambiguity takes the first row and records a diagnostic", () => {
  const declaration = [
    { path: "sub/a.ts", rationale: "primary", category: "declared" as const },
    { path: "a.ts", rationale: "drive-by", category: "opportunistic" as const },
    { path: "b.ts", rationale: "drive-by", category: "opportunistic" as const },
  ];
  const resolver = buildDeclarationResolver(["sub/a.ts", "sub/b.ts"], declaration);
  assert.equal(resolver.resolve("sub/a.ts")?.category, "declared");
  assert.ok(
    resolver.diagnostics.some((d) => d.includes("matched 2 declaration rows")),
    `expected a forward-collision diagnostic, got ${JSON.stringify(resolver.diagnostics)}`,
  );
});

test("resolver: empty declaration is inert, no diagnostics", () => {
  const resolver = buildDeclarationResolver(["src/a.ts"], []);
  assert.equal(resolver.resolve("src/a.ts"), undefined);
  assert.deepEqual(resolver.diagnostics, []);
});

// ---------------------------------------------------------------------------
// Issue #90 — parser tolerance.
// ---------------------------------------------------------------------------

test("parseScopeDeclaration: backticked category cell in a table (bc#703)", () => {
  const md = [
    "## Scope Declaration",
    "",
    "| `tools/gate-lib.ts` | `declared` | shared gate helper |",
    "| **src/x.ts** | **extension** | forced by the helper |",
  ].join("\n");
  assert.deepEqual(parseScopeDeclaration(md), [
    {
      path: "tools/gate-lib.ts",
      rationale: "shared gate helper",
      category: "declared",
    },
    {
      path: "src/x.ts",
      rationale: "forced by the helper",
      category: "extension",
    },
  ]);
});

test("parseScopeDeclaration: bold group heading carries a category forward (bc#744)", () => {
  const md = [
    "## Scope Declaration",
    "",
    "**New files (declared):**",
    "- `src/config/site.ts` — single project identity owner",
    "- `public/brand/web-icon.png`, `public/brand/compact-logo.png`, `public/brand/og-image.png` — promoted from `public/prototype/*-white.png`",
    "",
    "**Deleted (extension — beyond the issue's literal remnant list):**",
    "- `public/favicon.svg` — orphaned once favicon was repointed",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.deepEqual(
    decl.map((d) => d.path),
    [
      "src/config/site.ts",
      "public/brand/web-icon.png",
      "public/brand/compact-logo.png",
      "public/brand/og-image.png",
      "public/favicon.svg",
    ],
  );
  assert.deepEqual(
    decl.map((d) => d.category),
    ["declared", "declared", "declared", "declared", "extension"],
  );
});

test("parseScopeDeclaration: a bullet with no category anywhere is skipped", () => {
  const md = [
    "## Scope Declaration",
    "",
    "- `src/a.ts` — no inline category, no group heading",
  ].join("\n");
  assert.deepEqual(parseScopeDeclaration(md), []);
});

test("parseScopeDeclaration: a group heading does not rescue an explicit bad category", () => {
  const md = [
    "## Scope Declaration",
    "",
    "**New files (declared):**",
    "- `src/a.ts` (bogus) — wrong category",
    "- `src/b.ts` — fine",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.deepEqual(
    decl.map((d) => d.path),
    ["src/b.ts"],
  );
});

test("parseScopeDeclaration: a group heading does not leak into a later section", () => {
  const md = [
    "## Scope Declaration",
    "",
    "**New files (declared):**",
    "- `src/a.ts` — real",
    "",
    "## Notes",
    "",
    "prose",
    "",
    "## Scope Declaration",
    "",
    "- `src/b.ts` — bare bullet, no heading in this section",
  ].join("\n");
  assert.deepEqual(
    parseScopeDeclaration(md).map((d) => d.path),
    ["src/a.ts"],
  );
});

test("parseScopeDeclaration: prose bullet under a group heading yields NO row", () => {
  // Round 1's loose bullet manufactured a `declared` row out of this line, which
  // would silently push a real changed file to in_scope — the mirror image of
  // the bug issue #90 exists to fix.
  const md = [
    "## Scope Declaration",
    "",
    "**Modified (declared):**",
    "- `src/a.ts` — real",
    "- Also confirmed `src/zzz.ts` behaviour: unchanged",
    "- Note: `src/qqq.ts` was read but not edited",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.deepEqual(
    decl.map((d) => d.path),
    ["src/a.ts"],
  );
});

test("parseScopeDeclaration: trailing-parenthetical annotations still declare (bc#604/#750)", () => {
  const md = [
    "## Scope Declaration",
    "",
    "**New files (declared):**",
    "- `Bubble Craps/Assets/UI/PayoutAnnouncer.cs` (declared, new) — the shared payout composer",
    "- `Bubble Craps/Assets/UI/Tests/AchievementsScreenBinderTests.cs` (declared, new file) — coverage",
    "- `realbubblecraps.com-astro/infra/modules/lambda-ssr/index.ts` (declared, deleted) — retired",
    "- `realbubblecraps.com-astro/scripts/prebuild.js` (declared, deleted) — retired",
    "- `.meta` files for the new `BreakdownRowBinder.cs` — Unity regenerates these",
    "- `src/assets/**` (18 files — DocKit demo art, orphaned once the above were removed)",
  ].join("\n");
  const decl = parseScopeDeclaration(md);
  assert.deepEqual(
    decl.map((d) => d.path),
    [
      "Bubble Craps/Assets/UI/PayoutAnnouncer.cs",
      "Bubble Craps/Assets/UI/Tests/AchievementsScreenBinderTests.cs",
      "realbubblecraps.com-astro/infra/modules/lambda-ssr/index.ts",
      "realbubblecraps.com-astro/scripts/prebuild.js",
      ".meta",
      "BreakdownRowBinder.cs",
      "src/assets/**",
    ],
  );
  assert.ok(decl.every((d) => d.category === "declared"));
});

test("parseScopeDeclaration: glob and bold path cells survive decoration stripping", () => {
  const md = [
    "## Scope Declaration",
    "",
    "| `test/unit/**` | `declared` | new cases |",
    "| `**/*.ts` | `incidental` | formatter pass |",
  ].join("\n");
  assert.deepEqual(
    parseScopeDeclaration(md).map((d) => d.path),
    ["test/unit/**", "**/*.ts"],
  );
});

// ---------------------------------------------------------------------------
// Issue #90 — declaration_status.
// ---------------------------------------------------------------------------

test("parseScopeDeclarationSection: no section at all → missing", () => {
  const parse = parseScopeDeclarationSection("# Run\n\n## Status\n\ndone\n");
  assert.equal(parse.status, "missing");
  assert.deepEqual(parse.entries, []);
});

test("parseScopeDeclarationSection: section present but unreadable → unreadable", () => {
  const parse = parseScopeDeclarationSection(
    ["## Scope Declaration", "", "I changed some files. Trust me."].join("\n"),
  );
  assert.equal(parse.status, "unreadable");
  assert.deepEqual(parse.entries, []);
});

test("parseScopeDeclarationSection: rows extracted → parsed", () => {
  const parse = parseScopeDeclarationSection(
    ["## Scope Declaration", "", "- `src/a.ts` (declared) — the goal"].join("\n"),
  );
  assert.equal(parse.status, "parsed");
  assert.equal(parse.entries.length, 1);
});

test("classifyChanges: carries the caller's declaration status onto the report", () => {
  const report = classifyChanges({
    changedFiles: ["src/a.ts"],
    block: NO_BLOCK,
    declaration: [],
    declarationStatus: "unreadable",
  });
  assert.equal(report.declaration_status, "unreadable");
  assert.deepEqual(report.outside, ["src/a.ts"]);
});

test("classifyChanges: derives a status when the caller omits one", () => {
  assert.equal(
    classifyChanges({
      changedFiles: ["src/a.ts"],
      block: NO_BLOCK,
      declaration: declared("src/a.ts"),
    }).declaration_status,
    "parsed",
  );
  assert.equal(
    classifyChanges({
      changedFiles: ["src/a.ts"],
      block: NO_BLOCK,
      declaration: [],
    }).declaration_status,
    "missing",
  );
});

test("classifyChanges: omits diagnostics entirely when nothing was ambiguous", () => {
  const report = classifyChanges({
    changedFiles: ["src/a.ts"],
    block: NO_BLOCK,
    declaration: declared("src/a.ts"),
  });
  assert.equal(report.diagnostics, undefined);
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
