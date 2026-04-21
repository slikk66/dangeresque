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
- **Severity**: blocking, degraded, cosmetic

If the conversation already established these, use what you know. Ask at most 1-2 clarifying questions.

### 2. Create the issue

Use `gh issue create` with this template:

```bash
gh issue create \
  --title "<concise title>" \
  --label "dangeresque" \
  --label "<bug|enhancement>" \
  --body "$(cat <<'ISSUE_EOF'
## Mode
<MODE>

## Goal
<what the worker should accomplish>

## Hypothesis
<what we think is happening and why — or "None" for open investigation>

## Likely Files
- `path/to/file.cs` — reason
- `path/to/other.cs` — reason

## Reproduction Steps
<if applicable>

## Verification Criteria
- [ ] criterion 1
- [ ] criterion 2

## Severity
<blocking | degraded | cosmetic>
ISSUE_EOF
)"
```

### 3. Report back

Print:
```
Staged issue #<number>: <title>
Run: dangeresque run --issue <number>
```

## Rules

- Always add the `dangeresque` label
- Add `bug` or `enhancement` label as appropriate
- Keep titles under 70 characters
- Hypothesis can be "None — open investigation" if unknown
- Use **bold** for ubiquitous language terms per UBIQUITOUS_LANGUAGE.md
- Do NOT ask more than 2 clarifying questions — use conversation context
