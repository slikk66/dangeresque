import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR,
  POINTER_BLOCK,
  agentMdCandidates,
  ensurePointer,
  loadConfig,
  resolveRunPlan,
} from "./config.js";
import { BRIEF_MARKDOWN } from "./brief.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the dangeresque package root (works with npm link) */
function getPackageRoot(): string {
  // dist/init.js → package root
  return join(__dirname, "..");
}

function copyDirRecursive(
  src: string,
  dest: string,
  warnings: string[],
): number {
  let copied = 0;
  if (!existsSync(dest)) {
    mkdirSync(dest, { recursive: true });
  }

  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copied += copyDirRecursive(srcPath, destPath, warnings);
    } else {
      if (existsSync(destPath)) {
        const srcContent = readFileSync(srcPath, "utf-8");
        const destContent = readFileSync(destPath, "utf-8");
        if (srcContent !== destContent) {
          warnings.push(`  Updated (local was modified): ${destPath}`);
        } else {
          continue; // identical, skip
        }
      }
      copyFileSync(srcPath, destPath);
      copied++;
    }
  }
  return copied;
}

/** Files that ship as a canonical/.local.md pair. */
export const SPLIT_BASE_NAMES = [
  "worker-prompt.md",
  "review-prompt.md",
  "AFK_WORKER_RULES.md",
] as const;

interface HookEntry {
  type: string;
  command: string;
}

interface HookHandler {
  matcher?: string;
  hooks?: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookHandler[]>;
  [key: string]: unknown;
}

/** A handler is dangeresque-managed if any of its hook commands mention "dangeresque". */
function isDangeresqueManagedHandler(handler: HookHandler): boolean {
  if (!handler?.hooks || !Array.isArray(handler.hooks)) return false;
  return handler.hooks.some(
    (h) => typeof h?.command === "string" && h.command.includes("dangeresque"),
  );
}

/**
 * Merge template hook events into existing settings, replacing dangeresque-managed
 * handlers per-event and preserving everything else. Idempotent: re-running with the
 * same template yields a byte-identical result.
 */
export function mergeClaudeHookSettings(
  existing: ClaudeSettings,
  template: ClaudeSettings,
): ClaudeSettings {
  const result: ClaudeSettings = { ...existing };
  result.hooks = { ...(existing.hooks ?? {}) };

  for (const [event, templateHandlers] of Object.entries(template.hooks ?? {})) {
    const existingHandlers = result.hooks[event] ?? [];
    const userHandlers = existingHandlers.filter(
      (h) => !isDangeresqueManagedHandler(h),
    );
    result.hooks[event] = [...userHandlers, ...templateHandlers];
  }

  return result;
}

export type CopyAction =
  | "created"
  | "upgraded"
  | "initialized-local"
  | "customized-warn";

/**
 * Install or upgrade a canonical/`.local.md` pair under `configDir`.
 *
 * Four cases:
 *  - canonical missing                          → copy both from templates              ("created")
 *  - canonical present, local present           → overwrite canonical, leave local      ("upgraded")
 *  - canonical present matches shipped, no local → copy local stub, no-op canonical     ("initialized-local")
 *  - canonical diverges from shipped, no local  → push warning, do NOT touch either    ("customized-warn")
 */
export function copyWithLocalOverlay(
  templatesDir: string,
  configDir: string,
  baseName: string,
  warnings: string[],
): CopyAction {
  const canonicalSrc = join(templatesDir, baseName);
  const canonicalDest = join(configDir, baseName);
  const localName = baseName.replace(/\.md$/, ".local.md");
  const localSrc = join(templatesDir, localName);
  const localDest = join(configDir, localName);

  if (!existsSync(canonicalDest)) {
    copyFileSync(canonicalSrc, canonicalDest);
    copyFileSync(localSrc, localDest);
    console.log(`  Created  ${CONFIG_DIR}/${baseName}`);
    console.log(
      `  Created  ${CONFIG_DIR}/${localName} (empty — add project overrides here)`,
    );
    return "created";
  }

  if (existsSync(localDest)) {
    copyFileSync(canonicalSrc, canonicalDest);
    console.log(
      `  Upgraded ${CONFIG_DIR}/${baseName} (canonical refreshed; ${localName} preserved)`,
    );
    return "upgraded";
  }

  const existingBytes = readFileSync(canonicalDest, "utf-8");
  const shippedBytes = readFileSync(canonicalSrc, "utf-8");
  if (existingBytes === shippedBytes) {
    copyFileSync(localSrc, localDest);
    console.log(
      `  Created  ${CONFIG_DIR}/${localName} (empty — add project overrides here)`,
    );
    return "initialized-local";
  }

  warnings.push(
    `⚠️  ${CONFIG_DIR}/${baseName} has been customized and does not match the shipped canonical.\n` +
      `    Your changes will not be lost — they're preserved in-place.\n` +
      `    To pick up upstream improvements:\n` +
      `      1. Move your customizations out of ${baseName} into ${localName}\n` +
      `      2. Re-run dangeresque init to install fresh canonical ${baseName}\n` +
      `    Or keep the current file as-is; upgrades will continue to skip it.\n\n` +
      `    Shipped canonical: ${canonicalSrc}\n` +
      `    Your file:         ${canonicalDest}`,
  );
  console.log(
    `  Skipped  ${CONFIG_DIR}/${baseName} (customized — see warning below)`,
  );
  return "customized-warn";
}

export function initProject(projectRoot: string): void {
  const packageRoot = getPackageRoot();
  const warnings: string[] = [];

  // 1. Scaffold .dangeresque/ config
  const configDir = join(projectRoot, CONFIG_DIR);
  const templatesDir = join(packageRoot, "config-templates");

  if (!existsSync(templatesDir)) {
    console.error(`Config templates not found at ${templatesDir}`);
    console.error("Is dangeresque installed correctly?");
    process.exit(1);
  }

  console.log("dangeresque init\n");

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
    console.log(`Created ${CONFIG_DIR}/`);
  }

  // Copy config templates. The three SPLIT_BASE_NAMES files use the canonical/.local.md
  // overlay for upgrades; everything else stays on the legacy skip-if-exists path.
  // .local.md sources are consumed by their canonical pair, never copied directly.
  const splitBase = new Set<string>(SPLIT_BASE_NAMES);
  const splitLocal = new Set<string>(
    SPLIT_BASE_NAMES.map((n) => n.replace(/\.md$/, ".local.md")),
  );
  let configCopied = 0;
  for (const file of readdirSync(templatesDir)) {
    if (file === "claude-settings.json") continue; // handled separately
    if (splitLocal.has(file)) continue; // installed by copyWithLocalOverlay alongside its canonical

    if (file === "config.example.json") {
      const destPath = join(configDir, file);
      copyFileSync(join(templatesDir, file), destPath);
      console.log(`  Wrote    ${CONFIG_DIR}/${file}`);
      configCopied++;
      continue;
    }

    if (splitBase.has(file)) {
      const action = copyWithLocalOverlay(
        templatesDir,
        configDir,
        file,
        warnings,
      );
      if (action === "created" || action === "initialized-local")
        configCopied++;
      continue;
    }

    const destPath = join(configDir, file);
    if (!existsSync(destPath)) {
      copyFileSync(join(templatesDir, file), destPath);
      console.log(`  Created  ${CONFIG_DIR}/${file}`);
      configCopied++;
    } else {
      console.log(`  Exists   ${CONFIG_DIR}/${file} (skipped)`);
    }
  }

  // 2. Local-only dangeresque state lives outside git history:
  //    - runs/     : structured run artifacts (mirrored across worktree boundaries)
  //    - sessions/ : engine JSONL transcripts (written by runner.ts:679)
  const gitignorePath = join(projectRoot, ".gitignore");
  const gitignoreEntries: { canonical: string; variants: string[] }[] = [
    {
      canonical: ".dangeresque/runs/",
      variants: [".dangeresque/runs/", ".dangeresque/runs"],
    },
    {
      canonical: ".dangeresque/sessions/",
      variants: [".dangeresque/sessions/", ".dangeresque/sessions"],
    },
  ];
  let gitignore = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf-8")
    : "";
  const added: string[] = [];
  for (const entry of gitignoreEntries) {
    const variantSet = new Set(entry.variants);
    const present = gitignore
      .split("\n")
      .some((l) => variantSet.has(l.trim()));
    if (present) continue;
    if (gitignore.length > 0 && !gitignore.endsWith("\n")) gitignore += "\n";
    gitignore += `${entry.canonical}\n`;
    added.push(entry.canonical);
  }
  if (added.length > 0) {
    writeFileSync(gitignorePath, gitignore);
    console.log(
      `\nAdded ${added.join(", ")} to .gitignore — local dangeresque state, not committed.`,
    );
  }

  // 3. Merge dangeresque hooks into .claude/settings.json (upgrade-aware:
  //    prior dangeresque-managed entries are replaced wholesale on each init,
  //    user-added entries in the same event are preserved).
  const hooksTemplate = join(templatesDir, "claude-settings.json");
  const settingsPath = join(projectRoot, ".claude", "settings.json");

  if (existsSync(hooksTemplate)) {
    const claudeDir = join(projectRoot, ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const templateData = JSON.parse(readFileSync(hooksTemplate, "utf-8"));

    if (!existsSync(settingsPath)) {
      writeFileSync(settingsPath, JSON.stringify(templateData, null, 4) + "\n");
      console.log("\nCreated .claude/settings.json with dangeresque hooks");
    } else {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const before = JSON.stringify(existing);
      const merged = mergeClaudeHookSettings(existing, templateData);
      const after = JSON.stringify(merged);
      if (before === after) {
        console.log("\nDangeresque hooks already current in .claude/settings.json");
      } else {
        writeFileSync(settingsPath, JSON.stringify(merged, null, 4) + "\n");
        console.log("\nUpgraded dangeresque hooks in .claude/settings.json");
      }
    }
  }

  // 4. Write canonical DANGERESQUE.md (dangeresque-owned, overwrite every run).
  //    Then ensure the pointer block is present and current in every existing
  //    agent-rules file (CLAUDE.md, AGENTS.md, .claude/CLAUDE.md). If none
  //    exists, bootstrap the engine-correct one (CLAUDE.md for claude,
  //    AGENTS.md for codex). Existing pointer blocks are refreshed via regex
  //    on re-run so brief text drift is corrected automatically.
  const dangeresqueMdPath = join(configDir, "DANGERESQUE.md");
  writeFileSync(dangeresqueMdPath, BRIEF_MARKDOWN);
  console.log(`  Wrote    ${CONFIG_DIR}/DANGERESQUE.md`);

  const pointerActions: { path: string; action: string }[] = [];

  const plan = resolveRunPlan(loadConfig(projectRoot));
  for (const engine of new Set([plan.worker.engine, plan.review.engine])) {
    const candidates = agentMdCandidates(projectRoot, engine);
    const existing = candidates.filter((p) => existsSync(p));
    if (existing.length === 0) {
      const target = candidates[0];
      writeFileSync(
        target,
        `${POINTER_BLOCK}\n# Project Rules\n\n<!-- Add your project's build/test/architecture notes here. -->\n`,
      );
      pointerActions.push({ path: target, action: "created" });
      console.log(`\nCreated ${target} with dangeresque pointer.`);
      continue;
    }
    for (const path of existing) {
      const before = readFileSync(path, "utf-8");
      const { content: after, action } = ensurePointer(before);
      if (action === "noop") {
        console.log(`  Verified dangeresque pointer in ${path}`);
      } else {
        writeFileSync(path, after);
        const verb = action === "prepended" ? "Prepended" : "Refreshed";
        console.log(`  ${verb} dangeresque pointer in ${path}`);
      }
      pointerActions.push({ path, action });
    }
  }

  // 5. Copy skills to .claude/skills/
  const skillsSource = join(packageRoot, "skills");
  const skillsDest = join(projectRoot, ".claude", "skills");

  if (existsSync(skillsSource)) {
    const skillsCopied = copyDirRecursive(skillsSource, skillsDest, warnings);
    if (skillsCopied > 0) {
      console.log(`\nCopied ${skillsCopied} skill file(s) to .claude/skills/`);
    } else {
      console.log("\nSkills already up to date");
    }
  }

  // 3. Print warnings
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of warnings) {
      console.log(w);
    }
  }

  console.log("\nDone. Next steps:");
  const created = pointerActions.find((a) => a.action === "created");
  const prepended = pointerActions.find((a) => a.action === "prepended");
  const refreshed = pointerActions.find((a) => a.action === "replaced");
  if (created) {
    console.log(
      `  1. Flesh out ${created.path} with your project's build/test/architecture rules`,
    );
  } else if (prepended) {
    console.log(
      `  1. Pointer prepended to ${prepended.path} — review the top of the file`,
    );
  } else if (refreshed) {
    console.log(
      `  1. Pointer refreshed in ${refreshed.path} — no action needed`,
    );
  } else {
    const verified = pointerActions[0]?.path ?? "your agent rules file";
    console.log(`  1. Pointer already present in ${verified} — no action needed`);
  }
  console.log(
    "  2. Review .dangeresque/ prompts (*.local.md files are yours to customize)",
  );
  console.log(
    "  3. Allow the tools your workers need — see https://github.com/slikk66/dangeresque/blob/main/docs/PERMISSIONS.md",
  );
  console.log(
    "     Quick start:  dangeresque allow mcp        (auto-discover MCP servers)",
  );
  console.log('                   dangeresque allow bash "npm install *"');
  console.log(
    "  4. Create a GitHub Issue, then: dangeresque run --issue <number>",
  );
  console.log(
    "\nRe-run 'dangeresque init' to refresh skills and canonical prompts from the latest version.",
  );
}
