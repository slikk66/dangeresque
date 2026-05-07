---
name: dangeresque-create-issue
description: Create a structured GitHub Issue for dangeresque AFK workers from conversation context. Use when user wants to create a dangeresque issue, dispatch work to an AFK worker, or says "create issue for dangeresque" after discussing a bug or feature.
---

# dangeresque-create-issue

Create a well-structured GitHub Issue that dangeresque workers can consume effectively. This skill leverages the conversation context you've built with the user — hypothesis, likely files, reproduction steps — to produce a richer issue than a bare CLI command could.

## When to Use

- User reports a bug and you've discussed it enough to have a hypothesis
- User says "/dangeresque-create-issue" or "create an issue for dangeresque"
- User wants to dispatch work to an AFK worker run

## Process

### 1. Gather context (from conversation — don't re-ask what you already know)

Only ask what's missing:
- **Mode**: INVESTIGATE, IMPLEMENT, VERIFY, REFACTOR, TEST, or PLAYTEST
- **Goal**: What should the worker accomplish?
- **Hypothesis**: What do you think the root cause is? (INVESTIGATE/IMPLEMENT)
- **Likely files**: Which files should the worker look at first?
- **Priority**: see Label Vocabulary below — pick exactly one of `P1-now`, `P2-soon`, `P3-later`, `P4-someday`

If the conversation already established these, use what you know. Ask at most 1-2 clarifying questions.

### 2. Verify labels exist BEFORE creating the issue

`gh issue create` fails the whole call if ANY label is missing. Always verify first:

```bash
gh label list --limit 100 --json name -q '.[].name'
```

Cross-check every label you intend to pass (`dangeresque`, `bug`/`enhancement`, one priority label, any others). If a label is missing:

1. **Priority labels** — if the missing label is one of the four priority names (`P1-now`, `P2-soon`, `P3-later`, `P4-someday`), create it with the canonical color/description from the Label Vocabulary below:
   ```bash
   gh label create "P2-soon" --color "fbca04" --description "Do soon (this week); planned"
   ```
2. **Other labels** — ask the user whether to create it or drop it before proceeding.

Do NOT invent priority names like `P3-blocked`, `P3-eventually`, `P2-medium`, etc. — only the four canonical labels exist.

### 3. Create the issue

Use `gh issue create` with this template:

````bash
gh issue create \
  --title "<concise title>" \
  --label "dangeresque" \
  --label "<bug|enhancement>" \
  --label "<P1-now|P2-soon|P3-later|P4-someday>" \
  --body "$(cat <<'ISSUE_EOF'
## Mode
<MODE>

## Goal
<what the worker should accomplish>

## Hypothesis
<what we think is happening and why — or "None" for open investigation>

## Likely Files
- `path/to/file.ts` — reason
- `path/to/other.ts` — reason

## Scope (optional — add when the issue touches multiple files or has clear deny-list candidates)

```dangeresque-scope
allow:
  - path/to/file.ts
  - path/to/file.test.ts
deny:
  - path/to/secrets.ts
```

## Reproduction Steps
<if applicable>

## Verification Criteria
- [ ] criterion 1
- [ ] criterion 2

## Severity
<P1-now | P2-soon | P3-later | P4-someday> — <one-line justification>
ISSUE_EOF
)"
````

### 4. Report back

Print:
```
Staged issue #<number>: <title>
Run: dangeresque run --issue <number>
```

## Label Vocabulary

Canonical priority labels — pure ladder, no state-mixing (do NOT invent new ones):

| Label | Meaning | Color |
|---|---|---|
| `P1-now` | Drop everything; urgent | `B60205` (red) |
| `P2-soon` | This week; planned | `FBCA04` (amber) |
| `P3-later` | Backlog with intent; this cycle | `FBE9A6` (light yellow) |
| `P4-someday` | No intent to do soon; nice-to-have | `C5DEF5` (light blue) |

**No `blocked` label.** Blocked status is volatile and reason-rich — track it in issue comments or by referencing the blocking issue number. A label means duplicate state to manage; comments capture the WHY of the block, which a label cannot.

Type labels (always one):
- `bug` — something broken
- `enhancement` — new feature or improvement
- `documentation` — docs-only change

Scope label (always present):
- `dangeresque` — marks the issue as feedable to an AFK worker

## Rules

- **Verify labels exist first** (step 2) — `gh issue create` fails the whole call on any missing label.
- Always add the `dangeresque` label.
- Add exactly one type label (`bug` / `enhancement` / `documentation`).
- Add exactly one priority label from the four canonical names above.
- Keep titles under 70 characters.
- Hypothesis can be "None — open investigation" if unknown.
- Use **bold** for ubiquitous language terms per UBIQUITOUS_LANGUAGE.md.
- Do NOT ask more than 2 clarifying questions — use conversation context.
- Do NOT invent priority label names (no `P3-blocked`, `P3-eventually`, `P2-medium`, etc.).
- Do NOT add a `blocked` label — track blockage in comments.
- **Scope block is OPTIONAL** — populate the `## Scope` section's `dangeresque-scope` block only when the issue touches multiple files or has clear deny-list candidates (config, secrets, lockfiles, infra). Skip for simple INVESTIGATE-only issues; the worker reads everything anyway. When unsure, drop the section — an empty allow-list defers to the worker's `## Scope Declaration`.
