# Scope

Two complementary mechanisms bound what files a worker is allowed to touch: a **declared scope block** in the issue (operator-side allow/deny globs) and a **scope declaration** the worker writes into its run result (per-file category + rationale). Dangeresque classifies every changed file against both and stamps the result on the artifact for the reviewer.

## Declared scope block (issue side)

Add a fenced ` ```dangeresque-scope ``` ` YAML block to the issue body or any `[staged]` comment. Multiple blocks across body + staged comments are unioned; deny wins on conflict.

````markdown
## Goal

Bump the auth timeout default from 5 minutes to 30.

```dangeresque-scope
allow:
  - src/auth/timeout.ts
  - src/auth/timeout.test.ts
deny:
  - src/auth/secrets.ts
```
````

`allow:` and `deny:` are lists of glob patterns evaluated by Node's `node:path.matchesGlob` (Node 22+). `#` line comments and blank lines inside the block are tolerated; quoted values have their quotes stripped. Empty `allow:` means "no operator-side allow-list" (the worker's `## Scope Declaration` becomes the sole signal); empty `deny:` means no project-level no-fly list at the issue level.

## Scope Declaration (worker side)

For `IMPLEMENT`, `REFACTOR`, and `TEST` modes the worker is required to add a top-level `## Scope Declaration` section to its run result file listing every file it touched, with one of four categories and a rationale. Bullet form and table form are both accepted (mix freely).

```markdown
## Scope Declaration

- `src/auth/timeout.ts` (declared) — implements the Goal's primary entry point
- `src/auth/timeout.test.ts` (declared) — covers the new branch
- `src/auth/util.ts` (extension) — added helper required by timeout.ts
- `yarn.lock` (incidental) — touched by yarn install
```

| Category | Meaning |
| --- | --- |
| `declared` | The issue's allow-list explicitly named or globbed this file. Primary in-scope changes. |
| `extension` | Not in the allow-list, but required to complete the Goal (a helper a new function depends on). Justify why. |
| `opportunistic` | Drive-by edit unrelated to the Goal (typo fix, lint cleanup). Should be rare; bounded by the project budget below. |
| `incidental` | Auto-generated or auto-touched (`yarn.lock`, build outputs, formatter changes). |

## Classifier output

After the worker exits, dangeresque computes a `scope_report` of every changed file (from `git diff` against the worktree base) into one of three buckets:

- `in_scope` — matched an allow-glob, OR was declared `declared` / `incidental` by the worker.
- `extended` — the worker declared it `extension` or `opportunistic` (subject to the budget below).
- `outside` — matched no allow-glob, was not declared, OR was demoted from `extended` by a project denyGlob or the opportunistic budget.

The report lands on the artifact JSON as `scope_report` (alongside the parsed `scope_block` and the `scope_declaration` array) and the reviewer reads it to apply category-specific scrutiny: `declared` reviewed on correctness only, `extension` on necessity AND correctness, `opportunistic` REJECT unless strictly trivial, `outside` REJECT unless justified.

The reviewer is the authority on scope when it ran. When review is skipped (INVESTIGATE/VERIFY/`--no-review`), `outside` entries contribute the `scope_outside` failure category and the run is marked `partial_success` — see [Evaluation in `docs/SCHEMA.md`](SCHEMA.md#evaluation).

## Opportunistic Drive-by Fixes

Most agent orchestrators choose one of two scope postures: **stay strictly in lane** (any change outside the declared files is a violation) or **free-for-all** (the worker decides). Dangeresque sits between them with a **bounded opportunistic budget** — small drive-by fixes are allowed but capped, the worker tags them as such, and the reviewer scrutinizes them harder than declared changes.

Configured per project under `scope.opportunistic` in `.dangeresque/config.json`:

| Key | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | When false, skip the file/line passes (denyGlobs still apply — security policy is unconditional). |
| `maxFiles` | `1` | At most this many `opportunistic` files. Excess demoted to `outside`, trailing-first by declaration order. |
| `maxLines` | `20` | Sum of (added + deleted) lines across remaining `opportunistic` files. Excess demoted largest-first. |
| `denyGlobs` | `["infra/**", ".github/**", "**/*.lock", "**/migrations/**", "**/.env*", "**/secrets/**"]` | Project-level no-fly zones. Demote both `extension` and `opportunistic` matches to `outside`. |

Three enforcement passes run in order: project denyGlobs → `maxFiles` cap → `maxLines` cap. A demoted file moves from `extended` to `outside` in the `scope_report`, where the reviewer adjudicates it.

Example `config.json`:

```json
{
  "scope": {
    "opportunistic": {
      "enabled": true,
      "maxFiles": 1,
      "maxLines": 20,
      "denyGlobs": [
        "infra/**",
        ".github/**",
        "**/*.lock",
        "**/migrations/**",
        "**/.env*",
        "**/secrets/**"
      ]
    }
  }
}
```

To disable budget enforcement entirely while keeping the security denyGlobs, set `enabled: false` and leave `denyGlobs` populated. To allow unlimited drive-bys (not recommended), set `maxFiles` and `maxLines` to large values; the reviewer's per-category scrutiny still applies.
