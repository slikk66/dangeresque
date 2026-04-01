import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONFIG_DIR = ".dangeresque";
export const TASK_FILE = "NEXT_TASK.md";
export const RESULT_FILE = "RUN_RESULT.md";

export interface DangeresqueConfig {
  /** Model to use (default: claude-sonnet-4-6) */
  model: string;
  /** Permission mode (default: acceptEdits) */
  permissionMode: string;
  /** Effort level (default: max) */
  effort: string;
  /** Use tmux (default: true) */
  tmux: boolean;
  /** tmux style: "classic" or "native" (default: classic) */
  tmuxStyle: string;
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
  model: "claude-opus-4-6",
  permissionMode: "acceptEdits",
  effort: "high",
  tmux: true,
  tmuxStyle: "classic",
  allowedTools: [
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
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
