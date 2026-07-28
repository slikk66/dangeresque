# Codex reasoning effort

Date: 2026-07-28

## Finding

Before this implementation, dangeresque did not set Codex's native reasoning
effort. It only appended an `Effort preference` instruction to worker and review
prompts. The native Codex CLI control is:

```sh
codex exec -c 'model_reasoning_effort="xhigh"' ...
```

For Node `spawn`, pass these as separate arguments:

```ts
"-c", `model_reasoning_effort="${effort}"`
```

## Prior dangeresque behavior

- `--effort` updates `config.effort`, then warns it is ignored in Codex mode.
- Codex worker/review prompts contain the configured effort as prose.
- Codex worker/review argv omit `model_reasoning_effort`.
- Tests explicitly require Codex model resolution to omit effort.
- Logs/artifacts can show `effort: max` despite no native Codex effort being set.

## Compatibility

Installed Codex CLI: `0.145.0`.

Bundled model catalog:

| Model | Supported effort |
| --- | --- |
| `gpt-5.4` | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.5` | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh`, `max` |

`ultra` includes automatic delegation, so it is not merely a larger single-agent
reasoning budget. Supported values are model-dependent. Dangeresque's generic
Claude effort defaults to `max`; a Codex configuration must select a compatible
`codexEffort` or explicitly set a compatible generic `effort`.

## Live verification

This completed successfully and returned `OK`:

```sh
codex exec --ephemeral --ignore-user-config --skip-git-repo-check \
  --sandbox read-only --strict-config --json --model gpt-5.4 \
  -c 'model_reasoning_effort="xhigh"' --cd /private/tmp \
  'Reply exactly: OK. Do not use tools.'
```

The completed turn reported 32 reasoning output tokens. This verifies CLI config
parsing and API/model acceptance, not comparative quality.

## Implemented

Dangeresque now passes `model_reasoning_effort` natively for both Codex worker
and review runs. It validates against the installed Codex model catalog and
fails before dispatch when incompatible. It does not silently map effort values.
`ultra` is rejected because it enables delegation.

Displayed, status, comment, PID, and artifact model/effort values resolve from
the same effective values used to build engine argv.

## Local observation

`codex exec --strict-config` currently rejects the user's global config because
`features.rmcp_client` is unknown in CLI 0.145.0. Normal runs ignore the stale key.
The isolated verification used `--ignore-user-config`.

[[PROJECT-RULES-LOADED]]
