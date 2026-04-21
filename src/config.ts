import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR = ".dangeresque";
export const RUNS_DIR = "runs";
export const ADHOC_DIR = "adhoc";
export const TASK_FILE = "NEXT_TASK.md";
export const PID_FILE = ".dangeresque.pid";
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export type Engine = "claude" | "codex";

/** Convert absolute path to claude project hash (e.g. /Users/foo/.bar → -Users-foo--bar) */
export function projectHash(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export interface DangeresqueConfig {
  /** Execution engine (default: claude) */
  engine: Engine;
  /** Model to use */
  model: string;
  /** Permission mode (engine-specific) */
  permissionMode: string;
  /** Effort level (engine-specific) */
  effort: string;
  /** Run headless (default: true). Set false for interactive mode where supported. */
  headless: boolean;
  /** Allowed tools patterns */
  allowedTools: string[];
  /** Disallowed tools patterns */
  disallowedTools: string[];
  /** Worker prompt file path (relative to config dir) */
  workerPrompt: string;
  /** Review prompt file path (relative to config dir) */
  reviewPrompt: string;
  /** Enable macOS notifications via hooks (default: true) */
  notifications: boolean;
}

const DEFAULT_CONFIG: DangeresqueConfig = {
  engine: "claude",
  model: "claude-opus-4-7",
  permissionMode: "acceptEdits",
  effort: "max",
  headless: true,
  allowedTools: [
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
    "mcp__*",
    "Bash(git status *)",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git add *)",
    "Bash(git commit *)",
    "Bash(git branch *)",
  ],
  disallowedTools: [
    "Bash(git push *)",
    "Bash(git reset --hard *)",
    "Bash(rm -rf *)",
    "Bash(git branch -D *)",
  ],
  workerPrompt: "worker-prompt.md",
  reviewPrompt: "review-prompt.md",
  notifications: true,
};

export function loadConfig(projectRoot: string): DangeresqueConfig {
  const configPath = join(projectRoot, CONFIG_DIR, "config.json");
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return { ...DEFAULT_CONFIG, ...raw };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSetup(projectRoot: string): ValidationResult {
  const errors: string[] = [];
  const configDir = join(projectRoot, CONFIG_DIR);

  if (!existsSync(configDir)) {
    errors.push(`Missing ${CONFIG_DIR}/ directory`);
    return { valid: false, errors };
  }

  const config = loadConfig(projectRoot);

  if (!["claude", "codex"].includes(config.engine)) {
    errors.push(
      `Invalid engine '${config.engine}' (expected 'claude' or 'codex')`,
    );
  }

  const workerPromptPath = join(configDir, config.workerPrompt);
  if (!existsSync(workerPromptPath)) {
    errors.push(`Missing worker prompt: ${workerPromptPath}`);
  }

  const reviewPromptPath = join(configDir, config.reviewPrompt);
  if (!existsSync(reviewPromptPath)) {
    errors.push(`Missing review prompt: ${reviewPromptPath}`);
  }

  return { valid: errors.length === 0, errors };
}

export function resolveProjectRoot(): string {
  return resolve(process.cwd());
}
