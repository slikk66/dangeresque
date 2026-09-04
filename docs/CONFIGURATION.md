# Configuration

## .dangeresque/ directory

| File                        | Purpose                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `worker-prompt.md`          | Canonical worker system prompt (overwritten by `init`)                                                            |
| `worker-prompt.local.md`    | Project overrides appended to the worker prompt (user-owned)                                                      |
| `review-prompt.md`          | Canonical review system prompt (overwritten by `init`)                                                            |
| `review-prompt.local.md`    | Project overrides appended to the review prompt (user-owned)                                                      |
| `AFK_WORKER_RULES.md`       | Canonical mode table, scope rules, status language (overwritten)                                                  |
| `AFK_WORKER_RULES.local.md` | Project-specific additions read at runtime (user-owned)                                                           |
| `DANGERESQUE.md`            | Workflow primer pointed to from `CLAUDE.md` / `AGENTS.md` (overwritten)                                           |
| `config.json`               | Optional overrides (model, tools, permissions)                                                                    |
| `runs/`                     | Run result files (one per run). **Gitignored** — mirrored across worktrees by the CLI, not carried by `git merge` |

## config.json

| Key               | Type     | Default              | Description                                                                                        |
| ----------------- | -------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `engineDefaults`  | object   | Claude + Codex pins   | Standing `model` and `effort` per engine; used whenever a phase selects or switches engine         |
| `worker`          | object   | Claude Opus / max     | Worker `engine`, `model`, and `effort`                                                              |
| `review`          | object   | worker phase          | Review `engine`, `model`, and `effort`; omitted fields inherit worker when engine matches           |
| `permissionMode`  | string   | `"acceptEdits"`      | Sandbox/permission mode for the selected engine                                                    |
| `headless`        | boolean  | `true`               | Run with `-p` flag (set false for interactive)                                                     |
| `allowedTools`    | string[] | _(see below)_        | Tools auto-approved without prompting                                                              |
| `disallowedTools` | string[] | _(see below)_        | Tools hard-blocked from use                                                                        |
| `workerPrompt`    | string   | `"worker-prompt.md"` | Worker system prompt filename                                                                      |
| `reviewPrompt`    | string   | `"review-prompt.md"` | Review system prompt filename                                                                      |
| `notifications`   | boolean  | `true`               | Enable macOS notification hooks                                                                    |
| `verify`          | object   | _(empty commands)_   | Pre-review verification hook — see the [Verification](#verification-pre-review-hook) section below |
| `scope`           | object   | _(see Opportunistic)_ | Scope subsystem policy. `scope.opportunistic` controls the per-project drive-by budget — see [Opportunistic Drive-by Fixes in `docs/SCOPE.md`](SCOPE.md#opportunistic-drive-by-fixes) |
| `dispatchGate`    | object   | _(absent → off)_     | Pre-worker enforcement gate — see the [Gates](#gates-dispatch--merge) section below |
| `mergeGate`       | object   | _(absent → off)_     | Pre-merge enforcement gate — see the [Gates](#gates-dispatch--merge) section below |

## Engines (claude vs codex)

Dangeresque supports two interchangeable execution engines:

- `claude` (default): uses `claude` CLI with native Claude session tracking.
- `codex`: uses `codex exec --json -s workspace-write -c approval_policy=never` in the same worktree model.

Select per-project in `.dangeresque/config.json`:

```json
{
  "engineDefaults": {
    "claude": { "model": "claude-opus-4-7", "effort": "max" },
    "codex": { "model": "gpt-5.5", "effort": "xhigh" }
  },
  "worker": { "engine": "codex" },
  "review": { "engine": "claude" }
}
```

Or override per-run with `--engine`, `--model`, `--effort`, `--review-engine`, `--review-model`, and `--review-effort`. Environment equivalents are `DANGERESQUE_ENGINE` and `DANGERESQUE_REVIEW_ENGINE`.

Resolution order is CLI phase model/effort, phase config model/effort, then the selected `engineDefaults` pin. Changing only `--engine` or `--review-engine` therefore switches model and effort with the provider instead of carrying an incompatible string across engines. Omitting `review` inherits the resolved worker phase. Legacy flat `engine`, `model`, `codexModel`, and related fields fail loudly; `dangeresque doctor` detects them before dispatch.

Codex uses `-c model_reasoning_effort="<effort>"` for every Codex phase. Before dispatch, dangeresque reads the installed Codex model catalog and fails when any scheduled Codex phase selects an unsupported pair. GPT-5.4 and GPT-5.5 support `low`, `medium`, `high`, and `xhigh`, but not `max`. `ultra` is always rejected because it enables multi-agent delegation rather than only increasing single-agent reasoning. Codex runs use `-s workspace-write -c approval_policy=never` (safe automation mode), not dangerous bypass flags. MCP on **Claude Code** uses your existing Claude setup; MCP on **Codex** is configured in `~/.codex/config.toml` under `[mcp_servers]` — keep entries aligned across both tools for equivalent behavior.

## Permissions

Default `allowedTools` (auto-approved): `Read`, `Edit`, `Write`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, and `Bash(git status|diff|log|add|commit|branch *)`. Default `disallowedTools` (hard-blocked): `Bash(git push *)`, `Bash(git reset --hard *)`, `Bash(rm -rf *)`, `Bash(git branch -D *)`. MCP and arbitrary `Bash(...)` patterns are NOT auto-approved. To grant them, run `dangeresque allow mcp` (reads `.mcp.json`), `dangeresque allow mcp <server>` (user- or plugin-scope), or `dangeresque allow bash "<pattern>"`. See [`docs/PERMISSIONS.md`](PERMISSIONS.md) for the full reference.

## Comment filtering

When building the worker prompt, dangeresque filters issue comments:

- **Included:** issue body + all `[staged]` comments + last 3 untagged human comments
- **Skipped:** prior `[dangeresque]` run-summary comments (the worker reads the local artifacts from `.dangeresque/runs/issue-<N>/` instead — they hold the full body, the comment carries only the SUMMARY block)

Use `dangeresque stage` to add guidance the worker will always see.

## GitHub issue comments

After each run, dangeresque posts a single comment on the issue containing only the artifact's `<!-- SUMMARY -->` block, the local artifact path, and a pointer to `dangeresque results --issue <N>`. The full run-result body never leaves the local machine — it lives at `.dangeresque/runs/issue-<N>/<timestamp>-<MODE>.md` (gitignored) on the host that ran the worker. Pull it onto another machine via `git`-based mirroring of your choice, or run dangeresque on the same host where the artifacts already live.

## Verification (pre-review hook)

Dangeresque can run compile/test/lint commands in the worktree between the worker exit (post-rebase, post-file-count-normalize) and the review pass. This catches drift between worker prose claims ("yarn build passes") and code reality. The reviewer (text-only) treats verification exit codes as ground truth and overrides any contradicting worker claim.

Configure under `verify` in `.dangeresque/config.json`. See [`config-templates/config.example.json`](../config-templates/config.example.json) for the full shape and ecosystem-specific examples (Cargo, Go, TypeScript-only). Minimal example:

```json
{
  "verify": {
    "enabled": true,
    "modes": ["IMPLEMENT", "REFACTOR", "TEST", "VERIFY"],
    "commands": [
      {
        "name": "compile",
        "cmd": "yarn build",
        "on_failure": "block",
        "timeout_ms": 300000
      },
      {
        "name": "test",
        "cmd": "yarn test",
        "on_failure": "block",
        "timeout_ms": 600000
      },
      {
        "name": "lint",
        "cmd": "yarn lint",
        "on_failure": "warn",
        "timeout_ms": 120000
      }
    ]
  }
}
```

Per-command policy:

- `on_failure: "block"` — first failure short-circuits the run, skips the review pass, marks `result: "failure"` with `failure_categories: ["verification_failed"]`.
- `on_failure: "warn"` — failure is recorded but the review still runs.

The CLI runs verification commands directly — `allowedTools` does not constrain them, since the engine never sees them.

Where output lands:

- **Artifact JSON** (`<timestamp>-<MODE>.json`) — `verification: VerificationResult[]` with name, cmd, exit code, duration, stdout/stderr excerpts, `timed_out`, and `truncated` flags.
- **Artifact Markdown** — a `Verify: …` line in the `<!-- SUMMARY -->` block, plus a `## Verification (pre-review, captured automatically)` body section with a one-line PASS/FAIL/TIMEOUT per command and the trailing stderr excerpt for any non-zero exit.
- **Console** — per-command pass/warn/block lines while the hook runs.

Operator escape hatches:

- `dangeresque run --issue <N> --no-verify` — skip for one run.
- `verify.enabled: false` in config — disable globally.
- Drop the offending command from `commands`.

Empty `commands` array (the default) means no-op; opt in by listing commands.

## Gates (dispatch + merge)

Dangeresque exposes two optional fail-closed enforcement points that a consumer project can wire up to physically block pipeline actions when its own checks say no. Unlike `verify` (which advises the reviewer), gates run at the surfaces where dispatch and merge actually execute — they cannot be bypassed by a reviewer verdict or by direct commits.

Both blocks share the `verify`-command shape (`{name, cmd, on_failure: "block"|"warn", timeout_ms}`) and both are absent by default (no behavior change unless configured).

**Fail-closed parsing.** Malformed gate config (missing `cmd`, invalid `on_failure`, non-boolean `enabled`, unknown field name, …) throws at `loadConfig` — every `dangeresque` command refuses to start until the config is fixed. This diverges intentionally from `verify`'s silent-drop behavior: a silently-dropped gate rule is a silently-lost enforcement guarantee.

**Exit codes.** Any blocking gate failure produces exit code `2` (workflow refusal), distinct from `1` (real error). Consumers can distinguish "fix workflow and retry" from "something crashed."

**Env vars for project commands.** Every project-configured command — both gates and `verify` — is spawned with these merged into `process.env`:

| Variable                    | dispatchGate    | verify              | mergeGate            | Meaning                                        |
| --------------------------- | --------------- | ------------------- | -------------------- | ---------------------------------------------- |
| `DANGERESQUE_ISSUE`         | issue number    | issue number (or "") | issue number (or "") | The issue this action is scoped to             |
| `DANGERESQUE_MODE`          | dispatched mode | dispatched mode     | merged branch mode   | e.g. `IMPLEMENT`, `INVESTIGATE`                |
| `DANGERESQUE_MERGE`         | _(unset)_       | _(unset)_           | `1`                  | Marker that this is a mergeGate invocation     |
| `DANGERESQUE_WORKTREE`      | _(unset)_       | the worktree        | the merge candidate  | Checkout to aim diff-based checks at           |
| `DANGERESQUE_ARTIFACT`      | _(unset)_       | the run report `.md` | the run report `.md` | The worker's run report                        |
| `DANGERESQUE_ARTIFACT_JSON` | _(unset)_       | its eval JSON       | its eval JSON        | Sibling `.json` of the above                   |

Variables that have no meaning yet are **absent, not empty** — at dispatch time no worktree and no run report exist, so a command can test `[ -n "$DANGERESQUE_ARTIFACT" ]` rather than compare against `""`.

`DANGERESQUE_WORKTREE` matters on mergeGate because commands run BEFORE the `git merge`: `projectRoot`'s HEAD does not yet contain the branch, so a diff-based check pointed there sees an empty committed range plus unrelated WIP.

`DANGERESQUE_ARTIFACT` is the seam for project-specific checks on the worker's own claims. Dangeresque parses only the `<!-- SUMMARY -->` block and `## Scope Declaration` — any other house convention in the report body (citation format, required sections, claim lint) is the project's to enforce, and this is how a check finds the file without re-deriving the timestamped filename. On mergeGate it is located independently of `requireAcceptedImplement`, so switching that policy off does not take the path away.

The `git merge` command itself also gets `DANGERESQUE_MERGE=1` — a consumer git hook (`pre-merge-commit`, `post-merge`, etc.) can distinguish a dangeresque-orchestrated merge from a direct commit via `[ -n "$DANGERESQUE_MERGE" ]`.

### dispatchGate (pre-worker)

Runs before `runWorker`. Refusal → exit 2, no worktree created, no engine spawned.

```json
{
  "dispatchGate": {
    "enabled": true,
    "modes": ["INVESTIGATE", "IMPLEMENT", "REFACTOR", "TEST", "VERIFY"],
    "requireInvestigateBeforeImplement": true,
    "workOrderPattern": "^##\\s*\\[ACTIVE",
    "commands": [
      {
        "name": "issue-policy",
        "cmd": "./scripts/dangeresque/check-issue.sh",
        "on_failure": "block",
        "timeout_ms": 30000
      }
    ]
  }
}
```

Fields:

- `enabled` (boolean, default `false`) — master switch.
- `modes` (string[], default: all supported modes) — which dispatched modes trigger the gate.
- `requireInvestigateBeforeImplement` (boolean, default `true`) — built-in policy. Refuses a `--mode IMPLEMENT` dispatch when no prior `-INVESTIGATE.md` artifact exists under `projectRoot`'s `.dangeresque/runs/issue-<N>/`. `--force` bypasses.
- `workOrderPattern` (string, optional) — a regex naming the issue comment that carries the spec being dispatched. Sharpens `requireInvestigateBeforeImplement` from *"has this issue ever had an INVESTIGATE?"* to *"did one run after the current spec was written?"* — see [Work-order freshness](#work-order-freshness) below.
- `commands` — project-configured commands, run in `projectRoot`, in order. First `on_failure: "block"` failure refuses; `on_failure: "warn"` records but continues. `--force` does NOT bypass these (an operator wanting to relax them should set `on_failure: "warn"`).

#### Work-order freshness

Existence alone is a weak guarantee. On an issue used as a long-lived lane, the first INVESTIGATE ever archived satisfies an existence check *forever* — including for scope invented weeks after it ran. The check gets less meaningful exactly as an issue accumulates history, which is where it is trusted most.

`workOrderPattern` fixes that by giving dangeresque a way to date the spec. Many projects post a comment on the issue at dispatch time that serves as the worker's self-contained brief; that convention is the project's, not dangeresque's, so the pattern that recognizes it is configuration:

```json
"workOrderPattern": "^##\\s*\\[ACTIVE"
```

Matched with the `m` flag, so `^` anchors to any line in the comment body, not just its first character.

When set, an IMPLEMENT dispatch additionally requires the newest `-INVESTIGATE.md` artifact to have **started after** the newest matching comment was created. A run that began before the spec was written provably never read it, and is not evidence the work was investigated. Age itself is fine — an issue may legitimately sit for weeks between a good investigation and its implementation. Predating the work is the defect.

The rules, in full:

| Situation | Behavior |
| --- | --- |
| `workOrderPattern` absent | Existence-only check, unchanged |
| Pattern is not a valid regex | Throws at config load (fail closed) |
| No comment matches — including an issue with no comments | Allows; existence-only check stands |
| Several comments match | The newest is the current work order; earlier ones were superseded |
| Matching comment is minimized | Ignored — a collapsed comment has been retracted |
| Matching comment has no `createdAt` (fixtures) | Ignored — cannot date it |
| No INVESTIGATE artifact has a parseable timestamp | Refuses — an undatable run cannot prove its own freshness |
| `requireInvestigateBeforeImplement` is `false`, or mode is not IMPLEMENT | Pattern is inert |
| `--force` | Bypasses, as with the rest of this policy |

Not matching any comment is deliberately permissive: a project that has not adopted a work-order convention keeps today's behavior, and opts into strictness only by writing down the convention it already follows.

### mergeGate (pre-merge)

Runs inside `mergeWorktree` between the running-worker check and the `git merge`. Refusal → exit 2, no merge attempted.

```json
{
  "mergeGate": {
    "enabled": true,
    "modes": ["IMPLEMENT", "REFACTOR", "TEST"],
    "requireAcceptedImplement": true,
    "commands": [
      {
        "name": "release-notes-present",
        "cmd": "./scripts/dangeresque/check-release-notes.sh",
        "on_failure": "block",
        "timeout_ms": 30000
      }
    ]
  }
}
```

Fields:

- `enabled` (boolean, default `false`).
- `modes` (string[], default `["IMPLEMENT", "REFACTOR", "TEST"]`) — merged-branch modes that trigger the gate. INVESTIGATE / VERIFY are no-op merges (they mirror artifacts but produce no code changes) and pass through by default. An UNKNOWN mode (e.g. an unparseable branch name) fails closed when the gate is enabled — defense in depth against silent branch-name drift.
- `requireAcceptedImplement` (boolean, default `true`) — built-in policy. Refuses unless the latest `-${MODE}.json` artifact matching the merged branch's own mode M (as resolved by extractMode) shows `review.skipped === false` and `reviewer_verdict === "accept"`. Reads the worktree first (fresh mode-M run being merged has its artifact there), falls back to `projectRoot` ONLY when the worktree has zero mode-M artifacts (e.g. a repeat REFACTOR round on an issue whose earlier REFACTOR was mirrored to projectRoot). Missing / unreadable / skipped / non-accept → refuses (fail closed). Name is retained for config compatibility even though semantics are now mode-agnostic.
- `commands` — project-configured commands, run in `projectRoot`, in order. Same semantics as `dispatchGate.commands`.

### Getting past a gate

`dangeresque run --force` bypasses ONLY the built-in dispatch policy (`requireInvestigateBeforeImplement` and the pre-flight gates), NOT the project-configured commands. This preserves the fail-closed guarantee for project-owned policy while giving operators an escape hatch for the built-in workflow rule. The bypass is recorded in the run artifact as a `dispatch_gate_forced` lifecycle event.

**mergeGate has no blanket bypass, by design.** Every path over it leaves an audit record. `dangeresque merge --rescue` is the only one, it applies only to a review that RAN and returned `reject` / `needs_human_review`, and verification commands still run — only the round-2 worker round-trip is waived. Two authorizations:

| Lane | Authorization | What it proves |
| --- | --- | --- |
| `micro_fix` | A commit on the branch whose message carries `[micro-fix: USER-approved]` | A human approved this specific diff, and the approval lives in git history |
| `no_code_delta` | `--reason "<why>"`, accepted only when **no commit landed on the branch after `review.ended_at`** | There is no diff to approve — the tree being merged is the tree the reviewer read |

The second lane exists because run artifacts are gitignored by dangeresque's own convention, so a reviewer that rejects on non-code grounds (a stale line number in the report, a claim the operator judges wrong) leaves nothing that could become a sentinel commit. It fails closed on every unknown: no recorded review end time, no way to read commit dates, or any commit since the review, and it refuses. Committer date is used, not author date — rebase, amend and cherry-pick all reset it, so every way of putting new content on a branch registers.

Both lanes write a `rescue` record into the artifact JSON, append a `## RESCUE` section to the report, and post a comment on the issue.

A gate that is refusing legitimately is still a config question: temporarily setting `mergeGate.requireAcceptedImplement: false` remains the way to relax the policy itself.

### End-to-end example

A minimal project-side config that requires (1) a prior INVESTIGATE for every IMPLEMENT, (2) a custom pre-dispatch script, and (3) an accepted-review + release-notes check before merge:

```json
{
  "dispatchGate": {
    "enabled": true,
    "commands": [
      { "name": "sanity", "cmd": "./scripts/precheck.sh", "on_failure": "block", "timeout_ms": 15000 }
    ]
  },
  "mergeGate": {
    "enabled": true,
    "commands": [
      { "name": "release-notes", "cmd": "./scripts/require-notes.sh", "on_failure": "block", "timeout_ms": 15000 }
    ]
  }
}
```

The consumer scripts see `DANGERESQUE_ISSUE` and `DANGERESQUE_MODE`; the merge one additionally sees `DANGERESQUE_MERGE=1`, `DANGERESQUE_WORKTREE`, and `DANGERESQUE_ARTIFACT` / `DANGERESQUE_ARTIFACT_JSON`. See the env-var table above for which are set when.
