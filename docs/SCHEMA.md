# Schema, Health Checks, and Evaluation

This page covers the operator-facing surface of dangeresque's artifact and binary versioning: the doctor health check, the migrate command, the break-and-migrate schema posture, and the evaluation terms emitted in each run's JSON artifact.

## Health Checks (`dangeresque doctor`)

`dangeresque doctor` runs six quick checks against the installed binary, the project, and the host environment. It exists because a globally-linked `dangeresque` is easy to forget about: a stale `dist/` writes wrong-schema artifacts, a missing `gh` makes `--issue` runs fail mid-flight, and invalid project config otherwise fails only at dispatch.

```
$ dangeresque doctor
dangeresque doctor
  package root: /path/to/dangeresque
  project root: /path/to/your-project

Checks:
  [PASS] build-info-present
         commit=e30165fb built_at=2026-05-03T05:54:59.021Z schema=6
  [PASS] dist-matches-head
         dist matches HEAD (e30165fb)
  [PASS] schema-version
         schema_version=6
  [PASS] gh-cli-available
         gh --version OK
  [PASS] dangeresque-initialized
         .dangeresque/ exists at /path/to/your-project
  [PASS] dangeresque-config-valid
         config and prompt files pass run preflight validation

Summary: 6 pass · 0 warn · 0 fail

Exit codes: 0 normal · 1 on FAIL or --strict WARN · 2 on internal error
```

| Check | What it verifies |
| --- | --- |
| `build-info-present` | `dist/build-info.json` was emitted by `yarn build`. Without it, drift detection cannot run. |
| `dist-matches-head` | The compiled `dist/` was built from the current git `HEAD` of the package. WARN on drift. |
| `schema-version` | The build-info `schema_version` matches the loaded module's `ARTIFACT_SCHEMA_VERSION`. Catches mixed-build state. |
| `gh-cli-available` | `gh --version` succeeds. The `--issue <N>` flow requires it. |
| `dangeresque-initialized` | `.dangeresque/` exists in the project root. Catches "linked the binary but never ran `dangeresque init`". |
| `dangeresque-config-valid` | Uses the same setup/config validator as `dangeresque run`; catches rejected keys, malformed phase/default profiles, and missing prompt files. |

`--strict` flips WARN into an exit-code-1 condition for CI use. By default only FAIL produces non-zero exit. Internal errors (uncaught exceptions in the doctor checks themselves) exit 2.

`dangeresque run` and `dangeresque migrate` also auto-print a stale-binary banner at the top of stdout when `dist/build-info.json` does not match HEAD — read-only commands skip the banner to keep their output pipe-friendly. The banner points at `dangeresque doctor` for full diagnosis.

## Schema Migration (`dangeresque migrate`)

`dangeresque migrate` walks `.dangeresque/runs/issue-*/` and rewrites every `*.json` artifact in place to the current `ARTIFACT_SCHEMA_VERSION`. Idempotent — files already at the current version are skipped, not rewritten.

```
$ dangeresque migrate
Migrated: 0
Skipped (already at v9): 1
```

Currently supported source versions: `v4`, `v5`, `v6`, `v7`, and `v8`. Older versions throw with an "unsupported source schema_version" error and require manual handling.

| Step | Effect |
| --- | --- |
| `v4 → v5` | Adds empty defaults for `scope_block`, `scope_declaration`, `scope_report` (the scope subsystem fields). |
| `v5 → v6` | Drops the deprecated `scope_violations` field; renames the `scope_violation` enum value in `failure_categories` to `scope_outside`. |
| `v6 → v7` | Adds `review_engine` to reviewed artifacts, defaulting to the worker `engine` for historical same-engine runs. |
| `v7 → v8` | Adds `scope_report.declaration_status`. Backfilled as `parsed` when the artifact recorded declaration rows, `unknown` when it did not — a v7 artifact cannot say whether an empty declaration means the worker wrote no section or we failed to read the one it wrote. |
| `v8 → v9` | Adds `rescue.kind` (`micro_fix` \| `no_code_delta`) on artifacts that carry a rescue record. Stamped `micro_fix` — the second lane did not exist when these were written, so this is a fact about them rather than a guess. Runs that were never rescued are untouched; the field only exists on rescued runs. |

Migrations write a `migrated_from_version` field on each touched artifact so downstream consumers can tell a freshly-migrated file from one originally written at the current version. Run-result `.md` files are untouched — they are operator narrative, not derived data.

Why this exists: schema-version bumps happen in service of the artifact format evolving (new fields, renamed enums, dropped legacy shapes). Old artifacts on disk should not block adopting a newer binary, and the human reading `.dangeresque/runs/` should not have to mentally diff two schemas. See [Schema Versioning Model](#schema-versioning-model) below.

## Schema Versioning Model

Dangeresque is pre-1.0 and runs a **break-and-migrate** posture on its artifact schema: when the artifact format needs to change, `ARTIFACT_SCHEMA_VERSION` bumps, the `dist/build-info.json` records the new version, and `dangeresque migrate` rewrites old artifacts on disk. Downstream consumers branch on `schema_version`.

The same posture applies to the CLI surface and prompt templates — `dangeresque init` overwrites canonical templates on every run; project-specific overrides live in the `.local.md` siblings and survive. There is no in-place upgrade ceremony or version negotiation; the design favors a clean current shape over a backwards-compatible accumulation.

Operator playbook for stale binary state:

```bash
# Inside the dangeresque package checkout
yarn build
dangeresque doctor   # confirms dist matches HEAD and schema is current
```

Operator playbook for old artifacts after upgrading:

```bash
# Inside any project that uses dangeresque
dangeresque migrate
```

`dist/build-info.json` records `{commit, built_at, schema_version}` on every `yarn build`. The `dist-matches-head` and `schema-version` doctor checks read it; `dangeresque run` and `dangeresque migrate` read it via `detectDrift()` and emit a stale-binary banner when needed. The system is self-describing — a worker that crashes mid-run leaves an artifact stamped with the schema version it understood, so a later `dangeresque migrate` can decide what to do with it.

## Evaluation

Every run writes a markdown run result file plus a structured JSON evaluation artifact. Terms derived from worker exit code, review phase, run artifact presence, scope classification (`scope_report.outside`), verification outcomes, and parsed reviewer verdicts: `success`, `partial_success`, `failure`, `scope_outside`, `verification_failed`, and `reviewer_verdict` ∈ {`accept`, `reject`, `needs_human_review`, `skipped`, `unknown`}. Review is automatically skipped for `INVESTIGATE`/`VERIFY`, when verification blocks (a `block`-policy command failed), and manually skipped by `--no-review`. The `scope_outside` failure category is emitted only when review was skipped — when review ran, the reviewer verdict controls the result (see [`docs/SCOPE.md`](SCOPE.md)).

`scope_report.declaration_status` ∈ {`parsed`, `unreadable`, `missing`, `unknown`}
says what we know about the worker's `## Scope Declaration` section, so an eval
query can tell "flagged but never declared" (`missing` — a worker-behaviour
problem) from "flagged because we could not read the declaration"
(`unreadable` — our problem). `unknown` appears only on artifacts migrated up
from v7, which predate the field.

One failure category is not derived from any of those inputs:
`uncommitted_worker_changes` marks a run that finished with work the branch's
commits do not carry — capture failed, or something stayed uncommitted through
it (issue #93). Such a run can never be classified `success`, whatever the
reviewer said, because the reviewer read the working tree and `git merge` ships
commits. Adding this value did **not** bump `ARTIFACT_SCHEMA_VERSION`: no field
was added, renamed or dropped, so every v7 artifact on disk is still a valid v7
artifact and has nothing to migrate.

For full definitions, run `dangeresque stats --glossary`. For design rationale, see [`docs/DESIGN.md` §4 Observability & Evaluation](DESIGN.md#4-observability--evaluation).
