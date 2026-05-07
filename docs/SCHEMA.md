# Schema, Health Checks, and Evaluation

This page covers the operator-facing surface of dangeresque's artifact and binary versioning: the doctor health check, the migrate command, the break-and-migrate schema posture, and the evaluation terms emitted in each run's JSON artifact.

## Health Checks (`dangeresque doctor`)

`dangeresque doctor` runs five quick checks against the installed binary, the project, and the host environment. It exists because a globally-linked `dangeresque` is easy to forget about: a stale `dist/` writes wrong-schema artifacts, a missing `gh` makes `--issue` runs fail mid-flight, and a project that was never `init`-ed has no `.dangeresque/` for the worker to read.

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

Summary: 5 pass · 0 warn · 0 fail

Exit codes: 0 normal · 1 if --strict and any WARN · 2 on internal error
```

| Check | What it verifies |
| --- | --- |
| `build-info-present` | `dist/build-info.json` was emitted by `yarn build`. Without it, drift detection cannot run. |
| `dist-matches-head` | The compiled `dist/` was built from the current git `HEAD` of the package. WARN on drift. |
| `schema-version` | The build-info `schema_version` matches the loaded module's `ARTIFACT_SCHEMA_VERSION`. Catches mixed-build state. |
| `gh-cli-available` | `gh --version` succeeds. The `--issue <N>` flow requires it. |
| `dangeresque-initialized` | `.dangeresque/` exists in the project root. Catches "linked the binary but never ran `dangeresque init`". |

`--strict` flips WARN into an exit-code-1 condition for CI use. By default only FAIL produces non-zero exit. Internal errors (uncaught exceptions in the doctor checks themselves) exit 2.

`dangeresque run` and `dangeresque migrate` also auto-print a stale-binary banner at the top of stdout when `dist/build-info.json` does not match HEAD — read-only commands skip the banner to keep their output pipe-friendly. The banner points at `dangeresque doctor` for full diagnosis.

## Schema Migration (`dangeresque migrate`)

`dangeresque migrate` walks `.dangeresque/runs/issue-*/` and rewrites every `*.json` artifact in place to the current `ARTIFACT_SCHEMA_VERSION`. Idempotent — files already at the current version are skipped, not rewritten.

```
$ dangeresque migrate
Migrated: 0
Skipped (already at v6): 1
```

Currently supported source versions: `v4` and `v5`. Older versions throw with a "unsupported source schema_version" error and require manual handling.

| Step | Effect |
| --- | --- |
| `v4 → v5` | Adds empty defaults for `scope_block`, `scope_declaration`, `scope_report` (the scope subsystem fields). |
| `v5 → v6` | Drops the deprecated `scope_violations` field; renames the `scope_violation` enum value in `failure_categories` to `scope_outside`. |

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

For full definitions, run `dangeresque stats --glossary`. For design rationale, see [`docs/DESIGN.md` §4 Observability & Evaluation](DESIGN.md#4-observability--evaluation).
