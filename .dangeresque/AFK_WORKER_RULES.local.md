<!-- Project-specific additions to AFK_WORKER_RULES.md — dangeresque will never overwrite this file. -->

## Tooling

- Build/test: `yarn build`, `yarn test`. Never `npm`, never `node --test` directly.
- Run a single test: `yarn test --test-name-pattern="<pat>"`. Don't shell out to `node --test '<file>'`.
- Inspect/run the CLI: use the global `dangeresque` symlink (e.g. `dangeresque brief`, `dangeresque status`). Don't invoke `node dist/cli.js ...`.

## This repo dogfoods dangeresque on itself

`.dangeresque/` here is the **install artifact** that `dangeresque init` writes — not source of truth. When updating dangeresque-shipped content, edit the upstream sources so changes flow through `dangeresque init` to all consumers:

| Don't edit (in `.dangeresque/`) | Edit instead |
|---|---|
| `DANGERESQUE.md` | `src/brief.ts` (`BRIEF_MARKDOWN` constant) |
| `AFK_WORKER_RULES.md`, `worker-prompt.md`, `review-prompt.md` | `config-templates/<same-name>.md` |
| `AFK_WORKER_RULES.local.md`, `worker-prompt.local.md`, `review-prompt.local.md` | this file (and siblings) — these are project-local, **not** template sources |
| `config.example.json` | `config-templates/config.example.json` |

`config-templates/*.md` and `.dangeresque/*.md` are byte-equality checked by init/tests. Don't hand-edit the installed copies — re-run `dangeresque init` after editing the templates.
