import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the dangeresque package root (works with npm link) */
function getPackageRoot(): string {
  // dist/init.js → package root
  return join(__dirname, "..");
}

function copyDirRecursive(src: string, dest: string, warnings: string[]): number {
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

export type CopyAction = "created" | "upgraded" | "initialized-local" | "customized-warn";

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
    console.log(`  Created  ${CONFIG_DIR}/${localName} (empty — add project overrides here)`);
    return "created";
  }

  if (existsSync(localDest)) {
    copyFileSync(canonicalSrc, canonicalDest);
    console.log(`  Upgraded ${CONFIG_DIR}/${baseName} (canonical refreshed; ${localName} preserved)`);
    return "upgraded";
  }

  const existingBytes = readFileSync(canonicalDest, "utf-8");
  const shippedBytes = readFileSync(canonicalSrc, "utf-8");
  if (existingBytes === shippedBytes) {
    copyFileSync(localSrc, localDest);
    console.log(`  Created  ${CONFIG_DIR}/${localName} (empty — add project overrides here)`);
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
  console.log(`  Skipped  ${CONFIG_DIR}/${baseName} (customized — see warning below)`);
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
  const splitLocal = new Set<string>(SPLIT_BASE_NAMES.map((n) => n.replace(/\.md$/, ".local.md")));
  let configCopied = 0;
  for (const file of readdirSync(templatesDir)) {
    if (file === "claude-settings.json" || file === "CLAUDE.md.sample") continue; // handled separately
    if (splitLocal.has(file)) continue; // installed by copyWithLocalOverlay alongside its canonical

    if (splitBase.has(file)) {
      const action = copyWithLocalOverlay(templatesDir, configDir, file, warnings);
      if (action === "created" || action === "initialized-local") configCopied++;
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

  // 2. Run artifacts live in .dangeresque/runs/ and are TRACKED in git
  //    (one file per run). If an older init wrote that dir into .gitignore,
  //    remove the entry so the artifacts flow through the normal git lifecycle.
  const gitignorePath = join(projectRoot, ".gitignore");
  const legacyRunsPatterns = new Set([".dangeresque/runs/", ".dangeresque/runs"]);
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    const lines = gitignore.split("\n");
    const kept = lines.filter((l) => !legacyRunsPatterns.has(l.trim()));
    if (kept.length !== lines.length) {
      writeFileSync(gitignorePath, kept.join("\n"));
      console.log(
        `\nRemoved legacy .dangeresque/runs/ entry from .gitignore — run results are now tracked.`,
      );
    }
  }

  // 3. Merge notification hooks into .claude/settings.json
  const hooksTemplate = join(templatesDir, "claude-settings.json");
  const settingsPath = join(projectRoot, ".claude", "settings.json");

  if (existsSync(hooksTemplate)) {
    const claudeDir = join(projectRoot, ".claude");
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const templateData = JSON.parse(readFileSync(hooksTemplate, "utf-8"));
    const newHooks = templateData.hooks ?? {};

    if (!existsSync(settingsPath)) {
      // No settings.json — create with just our hooks
      writeFileSync(settingsPath, JSON.stringify(templateData, null, 4) + "\n");
      console.log("\nCreated .claude/settings.json with notification hooks");
    } else {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (JSON.stringify(existing).includes("dangeresque")) {
        console.log("\nNotification hooks already in .claude/settings.json (skipped)");
      } else {
        // Merge: add our hook events without touching existing ones
        if (!existing.hooks) existing.hooks = {};
        for (const [event, handlers] of Object.entries(newHooks)) {
          if (!existing.hooks[event]) {
            existing.hooks[event] = handlers;
          } else {
            // Event already has hooks — append ours
            (existing.hooks[event] as unknown[]).push(...(handlers as unknown[]));
          }
        }
        writeFileSync(settingsPath, JSON.stringify(existing, null, 4) + "\n");
        console.log("\nMerged notification hooks into .claude/settings.json");
      }
    }
  }

  // 4. Copy CLAUDE.md.sample to .dangeresque/ for reference
  const claudeMdSample = join(templatesDir, "CLAUDE.md.sample");
  const claudeMdSampleDest = join(configDir, "CLAUDE.md.sample");
  if (existsSync(claudeMdSample)) {
    copyFileSync(claudeMdSample, claudeMdSampleDest);
  }
  const hasClaudeMd = existsSync(join(projectRoot, "CLAUDE.md")) ||
    existsSync(join(projectRoot, ".claude", "CLAUDE.md"));
  if (!hasClaudeMd) {
    console.log(`\nNo CLAUDE.md found — see ${CONFIG_DIR}/CLAUDE.md.sample for a recommended starting point`);
    console.log("  Copy to CLAUDE.md or .claude/CLAUDE.md and customize for your project");
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
  console.log("  1. Customize CLAUDE.md with your project's rules (workers read this first)");
  console.log("     Tip: 'dangeresque brief >> CLAUDE.md' — adds a self-contained workflow primer");
  console.log("  2. Review .dangeresque/ prompts and customize for your project");
  console.log("  3. Allow the tools your workers need — see https://github.com/slikk66/dangeresque/blob/main/docs/PERMISSIONS.md");
  console.log("     Quick start:  dangeresque allow mcp        (auto-discover MCP servers)");
  console.log('                   dangeresque allow bash "npm install *"');
  console.log("  4. Create a GitHub Issue, then: dangeresque run --issue <number>");
  console.log("\nRe-run 'dangeresque init' to refresh skills from the latest version.");
}
