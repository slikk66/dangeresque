import { test } from "node:test";
import assert from "node:assert/strict";
import { selectLogPhase } from "#dist/logs.js";
import type { PidInfo } from "#dist/worktree.js";

const pid = (partial: Partial<PidInfo>): PidInfo =>
  ({ pid: 1, startedAt: 0, ...partial }) as PidInfo;

test("selectLogPhase: --review forces review even when idle", () => {
  assert.equal(
    selectLogPhase(pid({}), { forceReview: true, running: false }),
    "review",
  );
});

test("selectLogPhase: claude review running (reviewSessionId) auto-selects review", () => {
  assert.equal(
    selectLogPhase(pid({ reviewSessionId: "abc" }), { forceReview: false, running: true }),
    "review",
  );
});

test("selectLogPhase: codex review running (reviewLogPath) auto-selects review", () => {
  // Regression: codex tracks the review pass via reviewLogPath, not a session id.
  // Before the fix this returned "worker" and logs errored with no worker session.
  assert.equal(
    selectLogPhase(pid({ reviewLogPath: "/tmp/review.jsonl" }), { forceReview: false, running: true }),
    "review",
  );
});

test("selectLogPhase: worker phase (no review markers) stays worker", () => {
  assert.equal(
    selectLogPhase(pid({ workerLogPath: "/tmp/worker.jsonl" }), { forceReview: false, running: true }),
    "worker",
  );
});

test("selectLogPhase: review marker present but not running stays worker", () => {
  assert.equal(
    selectLogPhase(pid({ reviewLogPath: "/tmp/review.jsonl" }), { forceReview: false, running: false }),
    "worker",
  );
});
