# Permissions

When a worker is blocked with `Claude requested permissions to use <tool>, but you haven't granted it yet`, the tool is missing from your `allowedTools` list. This file is the in-tree reference for fixing that.

## Where the config lives

`.dangeresque/config.json` in your project root. Created on first run if absent. Only the keys you set override the dangeresque defaults — `loadConfig` merges your overrides over `DEFAULT_CONFIG` from `src/config.ts`.

```json
{
  "allowedTools": [
    "Read",
    "Edit",
    "Write",
    "Bash(git status *)",
    "mcp__context7"
  ]
}
```

## Matcher rule shapes (per Anthropic docs)

From <https://code.claude.com/docs/en/permissions> — the only forms claude-code honors:

| Form                                       | Matches                                              |
| ------------------------------------------ | ---------------------------------------------------- |
| `Read` / `Edit` / `Write` / `Grep` / `Glob` | The named built-in tool                              |
| `Bash(<pattern>)`                          | A specific bash command pattern (glob-style)         |
| `mcp__<server>`                            | Any tool from the named MCP server                   |
| `mcp__<server>__*`                         | Any tool from the named MCP server (wildcard form)   |
| `mcp__<server>__<tool>`                    | One specific MCP tool                                |

**Bare `mcp__*` does NOT work.** The wildcard at the server-name slot is not supported (see anthropics/claude-code#3107). Dangeresque used to default `mcp__*` and silently leaked block-and-prompt failures in headless `-p` mode; it has been removed.

Server ids are the exact top-level keys under `mcpServers` in your project's `.mcp.json`. Plugin-installed servers carry a `plugin_*` prefix (e.g. `mcp__plugin_context7_context7`) — those live in user-scope (`~/.claude.json`) and need to be granted by id: `dangeresque allow mcp <server>`.

## `acceptEdits` ≠ "auto-approve everything"

The default `permissionMode: "acceptEdits"` only auto-approves file edits and a small set of common filesystem commands. It does NOT auto-approve MCP tool calls, arbitrary `Bash(...)` patterns, `WebFetch`, or `WebSearch`. Each of those still has to appear in `allowedTools`.

## Self-serve with `dangeresque allow`

```bash
# Add every MCP server listed in ./.mcp.json (project scope)
dangeresque allow mcp

# Add one server by id (for user-scope or plugin-scope servers not in .mcp.json)
dangeresque allow mcp context7

# Preview what would change without writing the file
dangeresque allow mcp --dry-run

# Allow a bash command pattern. Quote the pattern; the parens are added for you.
dangeresque allow bash "npm install *"
dangeresque allow bash "yarn build"
```

`allow` is idempotent — re-running prints `already allowed` for entries that exist and exits zero. It writes only the keys you change; existing config formatting (2-space indent, trailing newline) is preserved.

## Common additions

```jsonc
{
  "allowedTools": [
    // Package management
    "Bash(npm install *)",
    "Bash(yarn install --immutable)",
    "Bash(yarn build)",
    "Bash(yarn test)",

    // GitHub CLI
    "Bash(gh issue view *)",
    "Bash(gh issue list *)",
    "Bash(gh issue create *)",

    // MCP servers — ids match top-level keys in ./.mcp.json mcpServers
    "mcp__context7",
    "mcp__linear"
  ]
}
```

## When something is still blocked

1. Run `dangeresque logs <branch>` and look for `[error]` lines that say `requested permissions to use ...`. The text after `use` is the literal tool name claude needed.
2. For an MCP tool, the name has the form `mcp__<server>__<tool>` — copy the `mcp__<server>` prefix into `allowedTools` (or run `dangeresque allow mcp <server>`).
3. For a bash command, append the underlying pattern via `dangeresque allow bash "<pattern>"`.
4. Re-run the worker. The blocked tool should now resolve immediately.

## Hard-blocked tools

Some patterns are in `disallowedTools` by default and cannot be allow-listed without editing `config.json` directly:

- `Bash(git push *)` — workers never push; merging is a human action via `dangeresque merge`.
- `Bash(git reset --hard *)` — destructive.
- `Bash(rm -rf *)` — destructive.
- `Bash(git branch -D *)` — destructive.
