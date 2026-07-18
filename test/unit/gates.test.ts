import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDispatchGate, applyMergeGate } from "#dist/gates.js";
import type {
  DispatchGateConfig,
  MergeGateConfig,
} from "#dist/config.js";

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedRun(
  root: string,
  issueNumber: number,
  filename: string,
  content: string,
): string {
  const dir = join(root, ".dangeresque", "runs", `issue-${issueNumber}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, content, "utf-8");
  return path;
}

function seedRunArtifact(
  root: string,
  issueNumber: number,
  mode: string,
  overrides: {
    reviewer_verdict?: string;
    review?: { skipped: boolean; skip_reason?: string } | null;
    stamp?: string;
    unreadableJson?: boolean;
    missingJson?: boolean;
  } = {},
): void {
  const stamp = overrides.stamp ?? "2026-06-01T00-00-00";
  seedRun(root, issueNumber, `${stamp}-${mode}.md`, `# ${mode.toLowerCase()} body\n`);
  if (overrides.missingJson) return;
  const path = join(
    root,
    ".dangeresque",
    "runs",
    `issue-${issueNumber}`,
    `${stamp}-${mode}.json`,
  );
  if (overrides.unreadableJson) {
    writeFileSync(path, "{not valid", "utf-8");
    return;
  }
  const artifact = {
    schema_version: "6",
    mode,
    review:
      overrides.review === undefined
        ? { skipped: false, started_at: "", ended_at: "", duration_ms: 0, exit_code: 0 }
        : overrides.review,
    reviewer_verdict: overrides.reviewer_verdict ?? "accept",
  };
  writeFileSync(path, JSON.stringify(artifact), "utf-8");
}

function seedImplementArtifact(
  root: string,
  issueNumber: number,
  overrides: Parameters<typeof seedRunArtifact>[3] = {},
): void {
  seedRunArtifact(root, issueNumber, "IMPLEMENT", overrides);
}

function makeDispatchGateConfig(
  overrides: Partial<DispatchGateConfig> = {},
): DispatchGateConfig {
  return {
    enabled: true,
    modes: ["INVESTIGATE", "IMPLEMENT", "REFACTOR", "TEST", "VERIFY"],
    requireInvestigateBeforeImplement: true,
    commands: [],
    ...overrides,
  };
}

function makeMergeGateConfig(
  overrides: Partial<MergeGateConfig> = {},
): MergeGateConfig {
  return {
    enabled: true,
    modes: ["IMPLEMENT", "REFACTOR", "TEST"],
    requireAcceptedImplement: true,
    commands: [],
    ...overrides,
  };
}

// --- applyDispatchGate ---

test("applyDispatchGate: disabled → pass", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 1,
      mode: "IMPLEMENT",
      config: makeDispatchGateConfig({ enabled: false }),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyDispatchGate: mode not in modes → pass without running commands", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 1,
      mode: "IMPLEMENT",
      config: makeDispatchGateConfig({
        modes: ["VERIFY"],
        commands: [{ name: "should-not-run", cmd: "false", on_failure: "block", timeout_ms: 5000 }],
      }),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyDispatchGate: IMPLEMENT with no prior INVESTIGATE → refuses (fail closed)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeDispatchGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /no prior INVESTIGATE run exists/);
    assert.match(result.message!, /issue-42/);
    assert.match(result.message!, /--force/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyDispatchGate: IMPLEMENT with prior INVESTIGATE → passes built-in check", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    seedRun(tmp, 42, "2026-05-01T00-00-00-INVESTIGATE.md", "# investigation\n");
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeDispatchGateConfig(),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyDispatchGate: --force bypasses built-in INVESTIGATE requirement", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeDispatchGateConfig(),
      force: true,
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyDispatchGate: --force does NOT bypass project-configured blocking command", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    seedRun(tmp, 42, "2026-05-01T00-00-00-INVESTIGATE.md", "# investigation\n");
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeDispatchGateConfig({
        commands: [{ name: "policy", cmd: "false", on_failure: "block", timeout_ms: 5000 }],
      }),
      force: true,
    });
    assert.equal(result.ok, false, "--force must not bypass project-configured blocking commands");
    assert.match(result.message!, /command "policy".*failed with on_failure=block/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyDispatchGate: warn-only command failure does not block", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    seedRun(tmp, 42, "2026-05-01T00-00-00-INVESTIGATE.md", "# investigation\n");
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeDispatchGateConfig({
        commands: [{ name: "advisory", cmd: "false", on_failure: "warn", timeout_ms: 5000 }],
      }),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyDispatchGate: env vars DANGERESQUE_ISSUE + DANGERESQUE_MODE reach the command", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    seedRun(tmp, 77, "2026-05-01T00-00-00-INVESTIGATE.md", "# investigation\n");
    const captured = join(tmp, "captured.txt");
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 77,
      mode: "IMPLEMENT",
      config: makeDispatchGateConfig({
        commands: [
          {
            name: "env-check",
            cmd: `printf '%s|%s' "$DANGERESQUE_ISSUE" "$DANGERESQUE_MODE" > "${captured}"`,
            on_failure: "block",
            timeout_ms: 5000,
          },
        ],
      }),
    });
    assert.equal(result.ok, true);
    const contents = readFileSync(captured, "utf-8");
    assert.equal(contents, "77|IMPLEMENT");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("applyDispatchGate: INVESTIGATE mode does not require prior INVESTIGATE (built-in scoped to IMPLEMENT)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  try {
    const result = applyDispatchGate({
      projectRoot: tmp,
      issueNumber: 1,
      mode: "INVESTIGATE",
      config: makeDispatchGateConfig(),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- applyMergeGate ---

test("applyMergeGate: disabled → pass", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 1,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig({ enabled: false }),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: mode not in list (e.g. INVESTIGATE) → pass (no-op merges are not gated)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 1,
      mode: "INVESTIGATE",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: IMPLEMENT with no artifact anywhere → refuses (fail closed)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /no IMPLEMENT artifact found for issue #42/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: IMPLEMENT with review skipped → refuses", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, {
      review: { skipped: true, skip_reason: "--no-review" },
      reviewer_verdict: "skipped",
    });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /review\.skipped=true/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: IMPLEMENT with verdict=reject → refuses", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { reviewer_verdict: "reject" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /reviewer_verdict is "reject"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: IMPLEMENT with verdict=accept in worktree → passes", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { reviewer_verdict: "accept" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: REFACTOR — accepted REFACTOR lives at projectRoot from prior merge → passes", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedRunArtifact(tmp, 42, "REFACTOR", { reviewer_verdict: "accept" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "REFACTOR",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: unreadable JSON → refuses (fail closed on parse error)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { unreadableJson: true });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /unreadable/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: missing JSON sibling → refuses (fail closed)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { missingJson: true });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /no sibling JSON/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: --force bypasses built-in requireAcceptedImplement", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
      force: true,
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: env vars DANGERESQUE_MERGE=1 + issue + mode reach commands", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 55, { reviewer_verdict: "accept" });
    const captured = join(tmp, "capture.txt");
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 55,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig({
        commands: [
          {
            name: "env-check",
            cmd: `printf '%s|%s|%s' "$DANGERESQUE_ISSUE" "$DANGERESQUE_MODE" "$DANGERESQUE_MERGE" > "${captured}"`,
            on_failure: "block",
            timeout_ms: 5000,
          },
        ],
      }),
    });
    assert.equal(result.ok, true);
    const contents = readFileSync(captured, "utf-8");
    assert.equal(contents, "55|IMPLEMENT|1");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: blocking command failure → refuses with tail of stderr", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 55, { reviewer_verdict: "accept" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 55,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig({
        commands: [
          {
            name: "guard",
            cmd: "printf 'bad thing\\n' >&2; exit 3",
            on_failure: "block",
            timeout_ms: 5000,
          },
        ],
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /command "guard" \(exit=3\)/);
    assert.match(result.message!, /bad thing/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: undefined issue number + built-in enabled → refuses (fail closed)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: undefined,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /cannot determine issue number/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

// --- applyMergeGate: UNKNOWN mode fail-closed (defense in depth vs extractMode drift) ---

test("applyMergeGate: mode='UNKNOWN' with gate enabled → refuses (fail closed, defense in depth)", () => {
  // Twin of the extractMode slug-tolerance fix in worktree.ts. If extractMode
  // ever returns UNKNOWN for a branch that mergeWorktree accepts, the gate
  // must refuse rather than silently skip via the modes-not-in-list branch.
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 99,
      mode: "UNKNOWN",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /mode="UNKNOWN"/);
    assert.match(result.message!, /not one of the recognized modes/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: unrecognized mode (typo) with gate enabled → refuses (fail closed)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 99,
      mode: "IMPLMEENT", // typo
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /mode="IMPLMEENT"/);
    assert.match(result.message!, /not one of the recognized modes/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: recognized mode not in config.modes (e.g. VERIFY) still passes through", () => {
  // VERIFY is a legitimate dispatch mode but is not in the default
  // mergeGate.modes list. This must remain a pass-through (unchanged
  // behavior) — the UNKNOWN check must not misfire on recognized modes.
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 99,
      mode: "VERIFY",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

// --- applyMergeGate: fail-open fallback regression (#85 round-2 review reject) ---

test("applyMergeGate: rejected latest in worktree + accepted older at projectRoot → refuses (no fail-open fallback)", () => {
  // Regression guard for the round-2 review finding: a rejected latest
  // IMPLEMENT artifact in the worktree used to silently `continue` through
  // to the projectRoot fallback, letting an older accepted artifact
  // override the reject. Concrete scenario: a same-issue -round2 re-run
  // where mirrorIssueRuns has copied round-1's accepted artifact into the
  // fresh worktree AND projectRoot, and the round-2 IMPLEMENT run then
  // rejected. The gate must refuse based on the LATEST artifact in the
  // worktree, not fall back to the older accepted one.
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    // ProjectRoot has an OLDER accepted IMPLEMENT artifact.
    seedImplementArtifact(tmp, 500, {
      stamp: "2026-05-01T00-00-00",
      reviewer_verdict: "accept",
    });
    // Worktree has a NEWER rejected IMPLEMENT artifact.
    seedImplementArtifact(worktree, 500, {
      stamp: "2026-06-01T00-00-00",
      reviewer_verdict: "reject",
    });

    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 500,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(
      result.ok,
      false,
      "must refuse — reject in worktree cannot be masked by older accept at projectRoot",
    );
    assert.match(result.message!, /reviewer_verdict is "reject"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: skipped latest in worktree + accepted at projectRoot → refuses (fail-open fallback closed)", () => {
  // Companion to the reject-vs-accept test above: same shape, different
  // failure mode. The worktree's latest has review.skipped=true, which
  // used to fall back to the projectRoot's accepted artifact and pass.
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(tmp, 501, {
      stamp: "2026-05-01T00-00-00",
      reviewer_verdict: "accept",
    });
    seedImplementArtifact(worktree, 501, {
      stamp: "2026-06-01T00-00-00",
      review: { skipped: true, skip_reason: "--no-review" },
      reviewer_verdict: "skipped",
    });

    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 501,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /review\.skipped=true/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: missing-JSON latest in worktree + accepted at projectRoot → refuses (fail-open fallback closed)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(tmp, 502, {
      stamp: "2026-05-01T00-00-00",
      reviewer_verdict: "accept",
    });
    seedImplementArtifact(worktree, 502, {
      stamp: "2026-06-01T00-00-00",
      missingJson: true,
    });

    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 502,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /no sibling JSON/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: unreadable-JSON latest in worktree + accepted at projectRoot → refuses (fail-open fallback closed)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(tmp, 503, {
      stamp: "2026-05-01T00-00-00",
      reviewer_verdict: "accept",
    });
    seedImplementArtifact(worktree, 503, {
      stamp: "2026-06-01T00-00-00",
      unreadableJson: true,
    });

    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 503,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /unreadable/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: worktree has zero REFACTOR artifacts → projectRoot fallback still works (unchanged)", () => {
  // Positive test to prove the fallback still functions when it should:
  // a REFACTOR merge from a worktree with no mode-M artifact of its own
  // must still fall back to the projectRoot's accepted REFACTOR from an
  // earlier merge (e.g. a repeat REFACTOR round on the same issue).
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedRunArtifact(tmp, 504, "REFACTOR", { reviewer_verdict: "accept" });
    // worktree intentionally has no REFACTOR artifact.
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 504,
      mode: "REFACTOR",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

// --- applyMergeGate: mode-M semantics — REFACTOR must NOT piggyback on IMPLEMENT ---

test("applyMergeGate: REFACTOR merge with only IMPLEMENT artifact anywhere → refuses (mode-M, no piggyback)", () => {
  // Regression guard for the fix that made mergeGate mode-aware: under the
  // old semantics, a REFACTOR merge would silently satisfy the gate as long
  // as any accepted IMPLEMENT existed on the issue. That masked whether the
  // REFACTOR branch itself was ever reviewed. Under mode-M semantics, the
  // gate must locate a REFACTOR artifact specifically.
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedRunArtifact(tmp, 60, "IMPLEMENT", { reviewer_verdict: "accept" });
    // No REFACTOR artifact seeded anywhere.
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 60,
      mode: "REFACTOR",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /no REFACTOR artifact found for issue #60/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

// --- applyMergeGate: TEST-mode (#86 primary repro + mirrors of the IMPLEMENT suite) ---

test("applyMergeGate: TEST with verdict=accept in worktree → passes (#86 primary repro)", () => {
  // Exact reproduction from issue #86 § Reproduction: on an issue with no
  // IMPLEMENT run, a reviewed-and-accepted TEST branch must be allowed to
  // merge. Before the mode-M fix, the gate looked only for `-IMPLEMENT.md`
  // artifacts and refused.
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedRunArtifact(worktree, 86, "TEST", { reviewer_verdict: "accept" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 86,
      mode: "TEST",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, true, `expected pass, got: ${result.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: TEST with no artifact anywhere → refuses (fail closed, no-artifact wording)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 86,
      mode: "TEST",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /no TEST artifact found for issue #86/);
    // The remediation hint must suggest the merged branch's mode, not IMPLEMENT.
    assert.match(result.message!, /dangeresque run --issue 86 --mode TEST/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: TEST with review skipped → refuses", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedRunArtifact(worktree, 86, "TEST", {
      review: { skipped: true, skip_reason: "--no-review" },
      reviewer_verdict: "skipped",
    });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 86,
      mode: "TEST",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /latest TEST artifact has review\.skipped=true/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: TEST with verdict=reject → refuses", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedRunArtifact(worktree, 86, "TEST", { reviewer_verdict: "reject" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 86,
      mode: "TEST",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /latest TEST artifact reviewer_verdict is "reject"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: TEST — rejected latest in worktree + accepted older TEST at projectRoot → refuses (mode-M fail-open fallback closed)", () => {
  // Direct mirror of the IMPLEMENT round-2 conflict test above, parameterized
  // for TEST. The reject on the latest mode-M artifact in the worktree must be
  // terminal — the older accepted mode-M artifact at projectRoot cannot mask it.
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedRunArtifact(tmp, 600, "TEST", {
      stamp: "2026-05-01T00-00-00",
      reviewer_verdict: "accept",
    });
    seedRunArtifact(worktree, 600, "TEST", {
      stamp: "2026-06-01T00-00-00",
      reviewer_verdict: "reject",
    });

    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 600,
      mode: "TEST",
      config: makeMergeGateConfig(),
    });
    assert.equal(
      result.ok,
      false,
      "must refuse — reject in worktree cannot be masked by older accept at projectRoot",
    );
    assert.match(result.message!, /latest TEST artifact reviewer_verdict is "reject"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

// --- applyMergeGate: --rescue lane (dangeresque#87) ---

const SENTINEL = [
  { sha: "abc1234def", subject: "fix: clamp odds [micro-fix: USER-approved]" },
];

test("applyMergeGate --rescue: verdict=reject + sentinel present → passes, carries rescue record", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { reviewer_verdict: "reject" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
      rescue: true,
      sentinelCommits: SENTINEL,
    });
    assert.equal(result.ok, true);
    assert.ok(result.rescue, "rescue record must be present on an approved rescue");
    assert.equal(result.rescue!.overriddenVerdict, "reject");
    assert.deepEqual(result.rescue!.sentinelCommits, SENTINEL);
    assert.match(result.rescue!.jsonPath, /issue-42\/.*-IMPLEMENT\.json$/);
    assert.match(result.rescue!.mdPath, /issue-42\/.*-IMPLEMENT\.md$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate --rescue: verdict=needs_human_review + sentinel present → passes", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { reviewer_verdict: "needs_human_review" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
      rescue: true,
      sentinelCommits: SENTINEL,
    });
    assert.equal(result.ok, true);
    assert.equal(result.rescue!.overriddenVerdict, "needs_human_review");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate --rescue: verdict=reject but NO sentinel → refuses (fail closed)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { reviewer_verdict: "reject" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
      rescue: true,
      sentinelCommits: [],
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /--rescue requires a USER-approved micro-fix commit/);
    assert.match(result.message!, /\[micro-fix: USER-approved\]/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate --rescue: review skipped (not a reviewed verdict) → refuses even with sentinel", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, {
      reviewer_verdict: "skipped",
      review: { skipped: true, skip_reason: "no-review" },
    });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
      rescue: true,
      sentinelCommits: SENTINEL,
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /--rescue applies only to a review that ran/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate --rescue: no artifact at all → refuses even with sentinel (rescue is not force)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
      rescue: true,
      sentinelCommits: SENTINEL,
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /--rescue applies only to a review that ran/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate --rescue: verification is NEVER waived — blocking command still refuses", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { reviewer_verdict: "reject" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig({
        commands: [
          {
            name: "guard",
            cmd: "printf 'verify failed\\n' >&2; exit 3",
            on_failure: "block",
            timeout_ms: 5000,
          },
        ],
      }),
      rescue: true,
      sentinelCommits: SENTINEL,
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /command "guard" \(exit=3\)/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate --rescue: verdict=accept → passes with NO rescue record (nothing to override)", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { reviewer_verdict: "accept" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
      rescue: true,
      sentinelCommits: SENTINEL,
    });
    assert.equal(result.ok, true);
    assert.equal(result.rescue, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("applyMergeGate: verdict=reject without --rescue → refusal now surfaces the rescue option", () => {
  const tmp = makeTmp("dangeresque-gate-");
  const worktree = makeTmp("dangeresque-gate-wt-");
  try {
    seedImplementArtifact(worktree, 42, { reviewer_verdict: "reject" });
    const result = applyMergeGate({
      projectRoot: tmp,
      worktreePath: worktree,
      issueNumber: 42,
      mode: "IMPLEMENT",
      config: makeMergeGateConfig(),
    });
    assert.equal(result.ok, false);
    assert.match(result.message!, /reviewer_verdict is "reject"/);
    assert.match(result.message!, /dangeresque merge --rescue/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});
