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

  // Copy config templates (only if file doesn't exist — don't overwrite config)
  let configCopied = 0;
  for (const file of readdirSync(templatesDir)) {
    if (file === "claude-settings.json") continue; // handled separately
    const destPath = join(configDir, file);
    if (!existsSync(destPath)) {
      copyFileSync(join(templatesDir, file), destPath);
      console.log(`  Created ${CONFIG_DIR}/${file}`);
      configCopied++;
    } else {
      console.log(`  Exists  ${CONFIG_DIR}/${file} (skipped)`);
    }
  }

  // 2. Ensure .dangeresque/runs/ is gitignored
  const gitignorePath = join(projectRoot, ".gitignore");
  const runsPattern = ".dangeresque/runs/";
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8");
    if (!gitignore.includes(runsPattern)) {
      writeFileSync(gitignorePath, gitignore.trimEnd() + `\n${runsPattern}\n`);
      console.log(`\nAdded ${runsPattern} to .gitignore`);
    }
  } else {
    writeFileSync(gitignorePath, `${runsPattern}\n`);
    console.log(`\nCreated .gitignore with ${runsPattern}`);
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

  // 3. Copy skills to .claude/skills/
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
  console.log("  1. Review .dangeresque/ config files and customize for your project");
  console.log("  2. Run: dangeresque run --issue <number>");
  console.log("\nRe-run 'dangeresque init' to refresh skills from the latest version.");
}
