import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export const CONFIG_DIR = ".dangeresque";
export const RUNS_DIR = "runs";
export const PID_FILE = ".dangeresque.pid";
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

export const POINTER_ANCHOR = "<!-- DANGERESQUE-START -->";
export const POINTER_BLOCK = `<!-- DANGERESQUE-START -->
**The user needs you to read \`.dangeresque/DANGERESQUE.md\` before doing anything else.** It defines this project's workflow rules. Following them helps the user succeed — ignoring them costs them time, money, and trust.
<!-- DANGERESQUE-END -->
`;

export function claudeMdCandidates(projectRoot: string): string[] {
  return [join(projectRoot, "CLAUDE.md"), join(projectRoot, ".claude", "CLAUDE.md")];
}

export function claudeMdHasPointer(
  projectRoot: string,
): { found: boolean; matchedPath: string | null; checkedPaths: string[] } {
  const checkedPaths = claudeMdCandidates(projectRoot);
  for (const p of checkedPaths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf-8");
    if (content.includes(POINTER_ANCHOR)) {
      return { found: true, matchedPath: p, checkedPaths };
    }
  }
  return { found: false, matchedPath: null, checkedPaths };
}

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
  /** Model for review pass (falls back to `model` when unset) */
  reviewModel?: string;
  /** Effort level for review pass (falls back to `effort` when unset) */
  reviewEffort?: string;
  /** Model when engine is codex (falls back to `model` when unset) */
  codexModel?: string;
  /** Review-pass model when engine is codex (falls back to `codexModel`, then `reviewModel`, then `model`) */
  codexReviewModel?: string;
}

const DEFAULT_CONFIG: DangeresqueConfig = {
  engine: "claude",
  model: "claude-opus-4-7",
  permissionMode: "acceptEdits",
  effort: "max",
  headless: true,
  // MCP allow rules must name the server (mcp__<server> or mcp__<server>__*);
  // bare `mcp__*` is not honored by claude-code. Run `dangeresque allow mcp`
  // to add per-server entries — see docs/PERMISSIONS.md.
  allowedTools: [
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
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

export function validateEngineRuntime(
  engine: Engine,
  projectRoot: string,
  opts: {
    homedirFn?: () => string;
    probeMissing?: (engine: Engine) => boolean;
  } = {},
): ValidationResult {
  const errors: string[] = [];
  const homedirFn = opts.homedirFn ?? homedir;
  const probeMissing = opts.probeMissing ?? defaultProbeMissing;

  if (probeMissing(engine)) {
    errors.push(
      `Engine '${engine}' not found on PATH.\n` +
        `    Install it and re-run, or switch engine in .dangeresque/config.json.`,
    );
    return { valid: false, errors };
  }

  if (engine === "codex") {
    const authPath = join(homedirFn(), ".codex", "auth.json");
    if (!existsSync(authPath)) {
      errors.push(
        `Engine 'codex' is on PATH but not authenticated.\n` +
          `    Run: codex login\n` +
          `    Then retry.`,
      );
    }
  }
  // Claude stores creds in macOS Keychain on darwin and ~/.claude/.credentials.json on Linux;
  // no reliable cross-platform file signal, so rely on post-spawn failure for auth issues.

  const pointer = claudeMdHasPointer(projectRoot);
  if (!pointer.found) {
    errors.push(
      `dangeresque pointer missing from CLAUDE.md and .claude/CLAUDE.md.\n` +
        `    Run 'dangeresque init' to create one, or add this block at the top of your CLAUDE.md:\n\n` +
        POINTER_BLOCK,
    );
  }

  return { valid: errors.length === 0, errors };
}

function defaultProbeMissing(engine: Engine): boolean {
  const probe = spawnSync(engine, ["--version"], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  return Boolean(
    probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

export function resolveProjectRoot(): string {
  return resolve(process.cwd());
}
